// SPDX-License-Identifier: CPAL-1.0
// 纸面状态完整性（ADR-16）：paper-state.json 的摘要记在内核库 meta 里；启动时对不上（被删 / 截断 / 改值 / 拿旧备份顶替）就拒绝使用，
// 绝不新建空账户、绝不覆盖原文件。落盘顺序：pending 摘要 → 备份 .prev → 原子写 → current 摘要；崩在任意两步之间都不会误判。
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Db } from './db'
import { metaGet, metaSet, sqlitePath } from './db'
import { makeProblem } from './proto'
import { KernelError } from './util/errors'
import { sha256Hex } from './util/hash'
import { writeFileAtomic } from './util/fsperm'

export interface PaperStateMeta { sha256: string; savedAt: number; ledgerSeq: number }
export type PaperStateKind = 'ok' | 'fresh' | 'missing' | 'corrupt' | 'none'
export interface PaperStateHealth { state: PaperStateKind; reason?: string; reasonEn?: string; dirty: boolean; unverifiedFirstUse?: true }

const META_CURRENT = 'paper_state'
const META_PENDING = 'paper_state_pending'

export function readPaperMeta(db: Db): { current?: PaperStateMeta; pending?: string } {
  let current: PaperStateMeta | undefined
  const raw = metaGet(db, META_CURRENT)
  if (raw) { try { current = JSON.parse(raw) as PaperStateMeta } catch { current = undefined } }
  const pending = metaGet(db, META_PENDING) || undefined
  return { ...(current ? { current } : {}), ...(pending ? { pending } : {}) }
}

/** 账本里这些账户有没有经济事件（成交 / 下单意图）。有 = 不是新账户，状态文件不见了不能静默重建。 */
export function paperLedgerHasHistory(db: Db, accountIds: readonly string[]): boolean {
  if (accountIds.length === 0) return false
  const row = db.prepare(`SELECT 1 FROM ledger WHERE type IN ('fill','order.intent') AND account_id IN (${accountIds.map(() => '?').join(',')}) LIMIT 1`).get(...accountIds)
  return !!row
}

/** 内核订单表 / 成交表里出现过的最大纸面单号与成交号（`sim-000123` / `simf-000045`）。状态文件的序号不得比它们小。 */
export function maxPaperSeqs(db: Db, accountIds: readonly string[]): { orderSeq: number; fillSeq: number } {
  if (accountIds.length === 0) return { orderSeq: 0, fillSeq: 0 }
  const ph = accountIds.map(() => '?').join(',')
  const num = (v: unknown, prefix: string): number => {
    const m = typeof v === 'string' ? new RegExp(`^${prefix}-(\\d+)$`).exec(v) : null
    return m ? Number(m[1]) : 0
  }
  let orderSeq = 0, fillSeq = 0
  for (const r of db.prepare(`SELECT venue_order_id v FROM orders WHERE account_id IN (${ph}) AND venue_order_id LIKE 'sim-%'`).all(...accountIds) as { v: string }[]) orderSeq = Math.max(orderSeq, num(r.v, 'sim'))
  for (const r of db.prepare(`SELECT venue_fill_id v FROM fills WHERE account_id IN (${ph}) AND venue_fill_id LIKE 'simf-%'`).all(...accountIds) as { v: string }[]) fillSeq = Math.max(fillSeq, num(r.v, 'simf'))
  return { orderSeq, fillSeq }
}

export interface PaperLoadVerdict { health: PaperStateHealth; raw?: string }

/**
 * 启动时判定 paper-state.json 能不能用（不导入，只判定）。
 *   文件在：读得出、JSON 合法、摘要 ∈ {current, pending}（老 home 没有记录 → 首次信任）、序号不小于内核表里出现过的 → ok
 *   文件不在：库里记过摘要，或账本已有这些账户的经济事件 → missing（拒绝）；否则 fresh（按配置新建）
 */
export function judgePaperState(db: Db, file: string, accountIds: readonly string[]): PaperLoadVerdict {
  const meta = readPaperMeta(db)
  const corrupt = (reasonEn: string, reason: string): PaperLoadVerdict => ({ health: { state: 'corrupt', reason, reasonEn, dirty: false } })
  if (!existsSync(file)) {
    if (meta.current || paperLedgerHasHistory(db, accountIds)) {
      return { health: { state: 'missing', reason: '纸面状态文件不见了（账本里已有这些纸面账户的成交或下单记录）', reasonEn: 'paper state file is missing although the ledger already has paper activity', dirty: false } }
    }
    return { health: { state: 'fresh', dirty: false } }
  }
  let raw: string
  try { raw = readFileSync(file, 'utf8') } catch (e) { return corrupt(`paper state file cannot be read (${e instanceof Error ? e.message : String(e)})`, `纸面状态文件读不出来（${e instanceof Error ? e.message : String(e)}）`) }
  let parsed: { orderSeq?: unknown; fillSeq?: unknown }
  try { parsed = JSON.parse(raw) as typeof parsed } catch { return corrupt('paper state file is truncated or not valid JSON', '纸面状态文件被截断或不是合法的 JSON') }
  const sha = sha256Hex(raw)
  if (meta.current && sha !== meta.current.sha256 && sha !== meta.pending) {
    return corrupt('paper state file digest does not match the last saved state (edited or replaced)', '纸面状态文件的内容和内核最后一次保存的不一致（被改过或被别的文件顶替）')
  }
  // 序号只对带 orderSeq / fillSeq 的内置纸面场所格式核对；别的纸面连接器的状态格式不认识就不猜
  const seqs = maxPaperSeqs(db, accountIds)
  const orderSeq = typeof parsed?.orderSeq === 'number' ? parsed.orderSeq : Number.MAX_SAFE_INTEGER
  const fillSeq = typeof parsed?.fillSeq === 'number' ? parsed.fillSeq : Number.MAX_SAFE_INTEGER
  if (orderSeq < seqs.orderSeq || fillSeq < seqs.fillSeq) {
    return corrupt(`paper state file is older than the ledger (orderSeq ${orderSeq} < ${seqs.orderSeq} or fillSeq ${fillSeq} < ${seqs.fillSeq})`, '纸面状态文件比账本旧（像是拿旧备份顶替的）')
  }
  return { health: { state: 'ok', dirty: false, ...(meta.current ? {} : { unverifiedFirstUse: true as const }) }, raw }
}

/**
 * R2-REL-11：paper-state.json 里有没有“新账本里没有来历”的内容——任一账户有持仓、有未结订单、cash 不等于 initial，
 * 或 orderSeq / fillSeq 大于 0。读不出 / 不是合法 JSON / 格式不认识一律按非空算（偏严：宁可多问一句）。
 */
export function paperStateContent(raw: string): { nonEmpty: boolean; reasons: string[] } {
  let state: unknown
  try { state = JSON.parse(raw) } catch { return { nonEmpty: true, reasons: ['文件读不出来或不是合法 JSON'] } }
  const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {})
  const top = rec(state)
  if (!Array.isArray(top.accounts)) return { nonEmpty: true, reasons: ['文件格式不认识'] }
  const reasons: string[] = []
  if ((typeof top.orderSeq === 'number' && top.orderSeq > 0) || (typeof top.fillSeq === 'number' && top.fillSeq > 0)) reasons.push(`orderSeq=${String(top.orderSeq)} fillSeq=${String(top.fillSeq)}`)
  for (const raw of top.accounts) {
    const a = rec(raw)
    const id = typeof a.id === 'string' ? a.id : '?'
    const positions = rec(a.positions).$m
    if (Array.isArray(positions) && positions.length > 0) reasons.push(`${id} 有 ${positions.length} 个持仓`)
    if (Array.isArray(a.orders) && a.orders.some(o => ['open', 'untriggered', 'partially_filled'].includes(String(rec(o).status)))) reasons.push(`${id} 有未结订单`)
    if (JSON.stringify(a.cash) !== JSON.stringify(a.initial)) reasons.push(`${id} 现金不等于初始资金`)
  }
  return { nonEmpty: reasons.length > 0, reasons }
}

/**
 * R2-REL-11：账本库不在、带 --accept-new-ledger、而 paper-state.json 非空 → 默认拒绝启动（新账本里没有这些持仓和现金的来历）。
 * 只有显式 --reset-paper-state 才放行：旧文件（连同 .prev）移进 backups/paper-state-<时间>/，纸面账户按配置的初始资金重来。
 * 拒绝时一个字节都不动（也不会新建空账本）。返回备份目录（没动文件则 undefined）。
 */
export function guardNewLedgerPaperState(home: string, reset: boolean, now: number): string | undefined {
  const file = join(home, 'paper-state.json')
  if (!existsSync(file)) return undefined
  let raw = ''
  try { raw = readFileSync(file, 'utf8') } catch { /* 读不出来按非空算 */ }
  const content = raw ? paperStateContent(raw) : { nonEmpty: true, reasons: ['文件读不出来'] }
  if (!content.nonEmpty) return undefined
  if (!reset) {
    throw new KernelError(makeProblem('STATE_FILE_CORRUPT',
      `refusing to start a new empty ledger on top of a non-empty paper-state.json (${content.reasons.join('; ')}); nothing was changed. `
      + `账本库不在，但 paper-state.json 里还有账本没有来历的纸面持仓 / 订单 / 资金变动（${content.reasons.join('；')}），--accept-new-ledger 不放行，什么都没动。二选一：`
      + `(1) 加 --reset-paper-state：旧纸面状态（连同 .prev）移进 backups/paper-state-<时间>/，纸面账户按配置的初始资金从头来；`
      + `(2) 保留原状：先把账本还原回 data/gitrader.sqlite（从备份还原），不加这两个参数重启。`))
  }
  const stamp = new Date(now).toISOString().slice(0, 19).split('-').join('').split(':').join('')
  const dir = join(home, 'backups', `paper-state-${stamp}`)
  mkdirSync(dir, { recursive: true })
  for (const name of ['paper-state.json', 'paper-state.json.prev']) if (existsSync(join(home, name))) renameSync(join(home, name), join(dir, name))
  return dir
}

/** 新账本没建成（guardNewLedgerPaperState 已搬走旧文件）：把旧纸面状态原样搬回去，目标位置已有文件的不覆盖；备份目录空了就删。 */
export function restorePaperState(home: string, dir: string): void {
  for (const name of ['paper-state.json', 'paper-state.json.prev']) if (existsSync(join(dir, name)) && !existsSync(join(home, name))) renameSync(join(dir, name), join(home, name))
  for (const d of [dir, dirname(dir)]) { try { rmdirSync(d) } catch { /* 非空就留着 */ } }
}

/** 落盘：pending 摘要 → 备份 .prev → 原子写 → current 摘要。任何一步抛错都向上抛（调用方置 dirty 并重试）。 */
export function writePaperState(db: Db, file: string, state: string, at: number, ledgerSeq: number): void {
  const sha = sha256Hex(state)
  metaSet(db, META_PENDING, sha)
  // ponytail: 每次保存整文件复制一份 .prev（纸面状态只有几百 KB）；变大再改成按次数轮转。
  if (existsSync(file)) copyFileSync(file, `${file}.prev`)
  writeFileAtomic(file, state)
  metaSet(db, META_CURRENT, JSON.stringify({ sha256: sha, savedAt: at, ledgerSeq } satisfies PaperStateMeta))
  metaSet(db, META_PENDING, '')
}

/** 重建（rebuild-from-ledger）写入新文件后登记摘要，下次启动按它校验。 */
export function recordPaperState(db: Db, state: string, at: number, ledgerSeq: number): void {
  metaSet(db, META_CURRENT, JSON.stringify({ sha256: sha256Hex(state), savedAt: at, ledgerSeq } satisfies PaperStateMeta))
  metaSet(db, META_PENDING, '')
}

/** doctor 离线用：服务没跑时只读打开账本库，按启动时同一套规则判定纸面状态文件（不导入、不写）。 */
export function judgePaperStateOffline(home: string, accountIds: readonly string[]): PaperStateHealth {
  const dbPath = join(home, 'data', 'gitrader.sqlite')
  const file = join(home, 'paper-state.json')
  if (!existsSync(dbPath)) return existsSync(file) ? { state: 'ok', dirty: false, unverifiedFirstUse: true } : { state: 'fresh', dirty: false }
  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(sqlitePath(dbPath), { readOnly: true })
    return judgePaperState(db as unknown as Db, file, accountIds).health
  } finally { try { db?.close() } catch { /* ignore */ } }
}
