// SPDX-License-Identifier: CPAL-1.0
// 账本完整性（ADR-17）：启动 / 后台验哈希链（全量或从最近检查点起的尾部）+ 成交投影与账本逐条比对；离线入口给 doctor 用。
// 只读：不写库、不改哈希格式。验链算法与 `ledger verify` 同一个（ledger-verify.ts）。
import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import type { Db } from './db'
import { metaGet, sqlitePath } from './db'
import { verifyEntries } from './ledger-verify'
import type { LedgerEntry } from './proto'
import * as d from './util/dec'

export interface LedgerVerifyFailure { seq: number; reason: string }
export interface LedgerVerifyStatus {
  ok: boolean
  mode: 'full' | 'tail'
  checkedFrom: number
  checkedTo: number | null
  count: number
  at: number
  durationMs: number
  failure?: LedgerVerifyFailure
  /** 成交投影（fills 表）与账本 fill 条目的比对；不一致时 ok=false 且 failure.reason 以 `fill projection` 开头。 */
  projection?: { checked: number; ok: boolean }
}

/** 条目数不超过这个就启动全量验链；更多时从最近检查点起验尾部，全量交给后台。 */
export const FULL_VERIFY_MAX_ENTRIES = 50_000
export const PROJECTION_SAMPLE = 200

function* entries(db: Db, fromSeq: number): Generator<LedgerEntry> {
  const stmt = db.prepare('SELECT entry FROM ledger WHERE seq>=? ORDER BY seq')
  for (const r of stmt.iterate(fromSeq) as Iterable<{ entry: string }>) yield JSON.parse(r.entry) as LedgerEntry
}

function publicKeys(db: Db): Record<string, string> | undefined {
  const keyId = metaGet(db, 'install_key_id')
  const pub = metaGet(db, 'install_key_pub')
  return keyId && pub ? { [keyId]: pub } : undefined
}

/** 尾部起点：最近一条（非创世）检查点所签的 upToSeq；没有就从 0 起（等于全量）。 */
function tailStart(db: Db): number {
  const row = db.prepare("SELECT entry FROM ledger WHERE type='checkpoint' AND seq>0 ORDER BY seq DESC LIMIT 1").get() as { entry: string } | undefined
  if (!row) return 0
  const p = (JSON.parse(row.entry) as LedgerEntry).payload as { upToSeq?: unknown } | undefined
  return typeof p?.upToSeq === 'number' && Number.isSafeInteger(p.upToSeq) && p.upToSeq >= 0 ? p.upToSeq : 0
}

/** 最近 N 条 fill 账本条目逐条对 fills 表：同 fillId 的行必须存在且价格、数量、场所成交号一致。 */
export function checkFillProjection(db: Db, limit = PROJECTION_SAMPLE): { checked: number; ok: boolean; failure?: LedgerVerifyFailure } {
  const rows = db.prepare("SELECT seq, entry FROM ledger WHERE type='fill' ORDER BY seq DESC LIMIT ?").all(limit) as { seq: number; entry: string }[]
  const byId = db.prepare('SELECT doc FROM fills WHERE fill_id=?')
  let checked = 0
  for (const row of rows) {
    const e = JSON.parse(row.entry) as LedgerEntry
    const fillId = (e.subject as { fillId?: string }).fillId
    const p = e.payload as { price?: string; size?: string } | undefined
    if (!fillId || !p?.price || !p.size) continue
    checked++
    const r = byId.get(fillId) as { doc: string } | undefined
    if (!r) return { checked, ok: false, failure: { seq: row.seq, reason: `fill projection does not match the ledger: ${fillId} is missing from the fills table` } }
    const f = JSON.parse(r.doc) as { price: string; size: string; venueFillId: string; accountId: string }
    const native = e.venueRef?.nativeFillId
    let same = false
    try { same = d.eq(d.D(f.price), d.D(p.price)) && d.eq(d.D(f.size), d.D(p.size)) && (native === undefined || f.venueFillId === native) && f.accountId === e.subject.accountId } catch { same = false }
    if (!same) return { checked, ok: false, failure: { seq: row.seq, reason: `fill projection does not match the ledger: ${fillId} differs (price / size / venue fill id)` } }
  }
  return { checked, ok: true }
}

/** 验链 + 投影。mode 'auto'：条目数 ≤ FULL_VERIFY_MAX_ENTRIES 全量，否则尾部。 */
export function verifyLedgerDb(db: Db, opts: { mode?: 'auto' | 'full' | 'tail'; now: number; projection?: boolean }): LedgerVerifyStatus {
  const t0 = performance.now()
  const count = (db.prepare('SELECT COUNT(*) c FROM ledger').get() as { c: number }).c
  const mode: 'full' | 'tail' = opts.mode === 'full' || opts.mode === 'tail' ? opts.mode : count <= FULL_VERIFY_MAX_ENTRIES ? 'full' : 'tail'
  const from = mode === 'full' ? 0 : tailStart(db)
  const r = verifyEntries(entries(db, from), { ...(publicKeys(db) ? { publicKeys: publicKeys(db)! } : {}), fromSeq: from })
  const out: LedgerVerifyStatus = { ok: r.ok, mode, checkedFrom: from, checkedTo: r.lastSeq, count: r.count, at: opts.now, durationMs: 0, ...(r.failure ? { failure: r.failure } : {}) }
  if (r.ok && opts.projection !== false) {
    const p = checkFillProjection(db)
    out.projection = { checked: p.checked, ok: p.ok }
    if (!p.ok) { out.ok = false; out.failure = p.failure! }
  }
  out.durationMs = Math.round((performance.now() - t0) * 10) / 10
  return out
}

/** 中文原因（交易状态 / doctor 用）。 */
export function ledgerFailureZh(s: Pick<LedgerVerifyStatus, 'failure'>): string {
  const f = s.failure
  if (!f) return ''
  if (f.reason.startsWith('fill projection')) return `成交投影与账本不一致（seq ${f.seq}）：${f.reason}`
  return `账本哈希链在 seq ${f.seq} 断开：${f.reason}`
}

/** doctor 离线用：服务没跑时只读打开账本库验链。打不开如实返回 error（原文）。 */
export function verifyLedgerOffline(home: string, now = Date.now()): LedgerVerifyStatus | { ok: false; error: string; missing?: true } {
  const path = join(home, 'data', 'gitrader.sqlite')
  if (!existsSync(path)) return { ok: false, error: 'ledger database is missing', missing: true }
  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(sqlitePath(path), { readOnly: true })
    return verifyLedgerDb(db, { mode: 'auto', now })
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  } finally {
    try { db?.close() } catch { /* ignore */ }
  }
}
