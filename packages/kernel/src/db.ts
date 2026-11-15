// SPDX-License-Identifier: CPAL-1.0
// SQLite（node:sqlite，随包 Node 自带）。账本表带触发器禁止 UPDATE / DELETE；其余对象存成 JSON 文档。
import { DatabaseSync } from 'node:sqlite'
import { accessSync, closeSync, constants, existsSync, mkdirSync, openSync, readSync } from 'node:fs'
import { dirname, resolve, toNamespacedPath } from 'node:path'

export type Db = DatabaseSync

const MIGRATIONS: string[] = [
  `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
  CREATE TABLE ledger (
    seq INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    ts INTEGER NOT NULL,
    recorded_at INTEGER NOT NULL,
    type TEXT NOT NULL,
    actor TEXT NOT NULL,
    account_id TEXT, instrument_id TEXT, order_id TEXT, proposal_id TEXT, mandate_id TEXT, ticket TEXT, takeover_id TEXT,
    entry TEXT NOT NULL,
    hash TEXT NOT NULL
  ) STRICT;
  CREATE INDEX ledger_type ON ledger(type, seq);
  CREATE INDEX ledger_account ON ledger(account_id, seq);
  CREATE INDEX ledger_order ON ledger(order_id);
  CREATE INDEX ledger_proposal ON ledger(proposal_id);
  CREATE INDEX ledger_actor ON ledger(actor, seq);
  CREATE TRIGGER ledger_no_update BEFORE UPDATE ON ledger BEGIN SELECT RAISE(ABORT, 'ledger is append-only'); END;
  CREATE TRIGGER ledger_no_delete BEFORE DELETE ON ledger BEGIN SELECT RAISE(ABORT, 'ledger is append-only'); END;
  CREATE TABLE docs (
    coll TEXT NOT NULL, id TEXT NOT NULL, ver INTEGER NOT NULL DEFAULT 0,
    doc TEXT NOT NULL, updated_at INTEGER NOT NULL,
    PRIMARY KEY (coll, id, ver)
  ) STRICT;
  CREATE INDEX docs_updated ON docs(coll, updated_at);
  CREATE TABLE ticket_seq (day TEXT PRIMARY KEY, n INTEGER NOT NULL) STRICT;
  `,
  `
  CREATE TABLE orders (
    order_id TEXT PRIMARY KEY, client_order_id TEXT NOT NULL UNIQUE, venue_order_id TEXT, account_id TEXT NOT NULL, mandate_id TEXT, proposal_id TEXT,
    instrument_id TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    notional TEXT NOT NULL, opening INTEGER NOT NULL, doc TEXT NOT NULL
  ) STRICT;
  CREATE INDEX orders_account ON orders(account_id, created_at);
  CREATE INDEX orders_mandate ON orders(mandate_id, created_at);
  CREATE INDEX orders_status ON orders(status);
  CREATE INDEX orders_venue ON orders(account_id, venue_order_id);
  CREATE TABLE fills (
    fill_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, venue_fill_id TEXT NOT NULL, order_id TEXT NOT NULL, instrument_id TEXT NOT NULL,
    ts INTEGER NOT NULL, doc TEXT NOT NULL, UNIQUE (account_id, venue_fill_id)
  ) STRICT;
  CREATE INDEX fills_account ON fills(account_id, ts);
  `,
  `CREATE INDEX IF NOT EXISTS ledger_account_ts ON ledger(account_id, ts); CREATE INDEX IF NOT EXISTS ledger_mandate_ts ON ledger(mandate_id, ts);`,
]

/** Windows：库路径长到接近 MAX_PATH 时，SQLite 自己拼 -journal / -wal 会超限而打不开；换成 \\?\\ 前缀即可（实测 421 字符可开）。
 *  阈值取 200 而不是 250：留足余量，且 200 以下路径完全不变（零行为变化）。其它平台与 :memory: 原样返回。 */
export function sqlitePath(path: string): string {
  if (process.platform !== 'win32' || path === ':memory:' || path.length < 200) return path
  return toNamespacedPath(resolve(path))
}

/** 打不开且路径又很长时附一句真话（不再只说权限 / 备份）。 */
export function longPathHint(path: string): string {
  return process.platform === 'win32' && path.length >= 240
    ? ` 数据目录路径有 ${path.length} 个字符，接近 Windows 的 260 上限：把 GITRADER_HOME 换到更短的目录再试（the path is close to the Windows 260-character limit）。`
    : ''
}

/** SQLite 文件头：'ok' 头部正常（或空文件），'bad' 不是 SQLite 文件，'unreadable' 读不了（多半被别的进程独占）。 */
function headerState(path: string): 'ok' | 'bad' | 'unreadable' {
  let fd: number | undefined
  try {
    fd = openSync(path, 'r')
    const head = Buffer.alloc(16)
    const n = readSync(fd, head, 0, 16, 0)
    if (n === 0) return 'ok'
    return n === 16 && head.subarray(0, 15).toString('latin1') === 'SQLite format 3' && head[15] === 0 ? 'ok' : 'bad'
  } catch { return 'unreadable' } finally {
    if (fd !== undefined) { try { closeSync(fd) } catch { /* ignore */ } }
  }
}

/** R2-REL-05：库打不开的真实原因。只有 SQLite 自己确认损坏（或文件头不是 SQLite）才算 corrupt——只有这种情况才可以建议从备份还原。 */
export function classifyLedgerOpenFailure(path: string, e: unknown): 'corrupt' | 'readonly' | 'in_use' | 'unknown' {
  const why = e instanceof Error ? e.message : String(e)
  const errcode = (e as { errcode?: unknown } | null)?.errcode
  const primary = typeof errcode === 'number' ? errcode & 0xff : undefined
  if (primary === 11 || primary === 26 || /malformed|not a database|corrupt/i.test(why)) return 'corrupt'
  if (primary === 8 || /read-?only/i.test(why)) return 'readonly'
  if (primary === 5 || primary === 6 || primary === 14 || /locked|busy|unable to open database file/i.test(why)) return headerState(path) === 'bad' ? 'corrupt' : 'in_use'
  return 'unknown'
}

/** 库文件或它所在目录不可写时返回出问题的那个路径（SQLite 对只读文件有时先成功、写的时候才报错，所以启动前先查）。 */
export function ledgerNotWritable(path: string): string | undefined {
  if (path === ':memory:') return undefined
  try { if (existsSync(path)) accessSync(path, constants.W_OK) } catch { return path }
  try { accessSync(dirname(path), constants.W_OK) } catch { return dirname(path) }
  return undefined
}

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(sqlitePath(path))
  try {
    if (path !== ':memory:') {
      db.exec('PRAGMA journal_mode = WAL')
      db.exec('PRAGMA synchronous = FULL') // 账本和提案不能因断电丢最后几条
    }
    db.exec('PRAGMA busy_timeout = 5000')
    const row = db.prepare('PRAGMA user_version').get() as { user_version: number }
    for (let v = row.user_version; v < MIGRATIONS.length; v++) {
      db.exec('BEGIN')
      try {
        db.exec(MIGRATIONS[v] as string)
        db.exec(`PRAGMA user_version = ${v + 1}`)
        db.exec('COMMIT')
      } catch (e) {
        db.exec('ROLLBACK')
        throw e
      }
    }
  } catch (e) {
    try { db.close() } catch { /* ignore */ } // fix-r2 S2：打不开（截断 / 只读）时别留着文件句柄
    throw e
  }
  return db
}

const depth = new WeakMap<Db, number>()

/**
 * 事务（可重入）：最外层 BEGIN IMMEDIATE / COMMIT，里层直接并入外层——账本追加自带事务，包进更大的事务时只在最外层提交一次。
 * synchronous=FULL 下每次提交一次 fsync：把"意图 + 订单状态 + 账本"并成一个事务就是 N 次降到 1 次，耐久性不降（提交时仍落盘）。
 */
export function tx<T>(db: Db, fn: () => T): T {
  const d = depth.get(db) ?? 0
  if (d > 0) { depth.set(db, d + 1); try { return fn() } finally { depth.set(db, d) } }
  db.exec('BEGIN IMMEDIATE')
  depth.set(db, 1)
  try {
    const r = fn()
    db.exec('COMMIT')
    return r
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* 已回滚 */ }
    throw e
  } finally {
    depth.set(db, 0)
  }
}

/** JSON 文档表：coll 集合名；ver 仅授权书、风控策略等有版本的对象使用（取最大版本为当前）。 */
export class Docs {
  constructor(private db: Db, private now: () => number) {}

  put<T>(coll: string, id: string, doc: T, ver = 0): void {
    this.db.prepare('INSERT INTO docs(coll,id,ver,doc,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(coll,id,ver) DO UPDATE SET doc=excluded.doc, updated_at=excluded.updated_at')
      .run(coll, id, ver, JSON.stringify(doc), this.now())
  }
  get<T>(coll: string, id: string, ver?: number): T | undefined {
    const r = ver === undefined
      ? this.db.prepare('SELECT doc FROM docs WHERE coll=? AND id=? ORDER BY ver DESC LIMIT 1').get(coll, id)
      : this.db.prepare('SELECT doc FROM docs WHERE coll=? AND id=? AND ver=?').get(coll, id, ver)
    return r ? (JSON.parse((r as { doc: string }).doc) as T) : undefined
  }
  /** 每个 id 取最新版本。 */
  list<T>(coll: string, opts: { limit?: number } = {}): T[] {
    const rows = this.db.prepare(
      `SELECT d.doc FROM docs d JOIN (SELECT id, MAX(ver) mv FROM docs WHERE coll=? GROUP BY id) m ON d.coll=? AND d.id=m.id AND d.ver=m.mv
       ORDER BY d.updated_at DESC LIMIT ?`).all(coll, coll, opts.limit ?? 1000) as { doc: string }[]
    return rows.map((r) => JSON.parse(r.doc) as T)
  }
  versions<T>(coll: string, id: string): T[] {
    return (this.db.prepare('SELECT doc FROM docs WHERE coll=? AND id=? ORDER BY ver').all(coll, id) as { doc: string }[]).map((r) => JSON.parse(r.doc) as T)
  }
  delete(coll: string, id: string): void { this.db.prepare('DELETE FROM docs WHERE coll=? AND id=?').run(coll, id) }
}

export function metaGet(db: Db, key: string): string | undefined {
  const r = db.prepare('SELECT value FROM meta WHERE key=?').get(key) as { value: string } | undefined
  return r?.value
}
export function metaSet(db: Db, key: string, value: string): void {
  db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value)
}
