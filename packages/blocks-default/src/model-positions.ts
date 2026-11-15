// SPDX-License-Identifier: CPAL-1.0
// 持仓与盈亏块的纯逻辑：把内核的查询 / 事件载荷规整成视图数据。无 DOM，vitest 直接测。
// TODO(protocol): 契约没有定义这些查询 / 主题的载荷形状（只有实体类型）。这里按实体类型宽松读取（数组或 {key:数组} 都认），
// account.summary 若带 dayStartEquity（风控当日基线，与日亏上限同口径）或 dayPnl，今日盈亏就是精确值，否则退到今日已实现并标 approx。
import type { LedgerEntry, Origin, Position } from '@gitrader/protocol/types'
import { accountLabel } from './display'
import { isRec, listOf, str, symbolOf, toNum, utcDayStart, type Rec } from './util'
import { t as tr } from '@gitrader/workbench/i18n'

export interface AccountLite { accountId: string; alias: string; mode: string; venue: string; environment: string }
export interface SummaryLite { equity: number | null; available: number | null; dayStartEquity: number | null; dayPnl: number | null }
export interface FillLite { accountId: string; instrumentId: string; ts: number; realizedPnl: number; fillId: string }
export interface OrderLite { accountId: string; instrumentId: string; side: string; reduceOnly: boolean; createdAt: number; origin: Origin | null; orderId: string; type: string; status: string; triggerPrice: number | null }

export function normalizeAccounts(raw: unknown): AccountLite[] {
  return listOf(raw, 'accounts').filter(isRec).flatMap((a) => {
    const accountId = str(a.accountId)
    if (!accountId) return []
    return [{ accountId, alias: accountLabel(accountId, str(a.alias)), mode: str(a.mode) ?? 'live', venue: str(a.venue) ?? '', environment: str(a.environment) ?? '' }]
  })
}

export function normalizePositions(raw: unknown): Position[] {
  return listOf(raw, 'positions').filter(isRec).filter((p) => typeof p.instrumentId === 'string' && toNum(p.size) !== null) as unknown as Position[]
}

export function normalizeSummary(raw: unknown): SummaryLite | null {
  if (!isRec(raw)) return null
  return { equity: toNum(raw.equity), available: toNum(raw.available), dayStartEquity: toNum(raw.dayStartEquity), dayPnl: toNum(raw.dayPnl) }
}

export function normalizeFills(raw: unknown): FillLite[] {
  return listOf(raw, 'fills').filter(isRec).flatMap((f) => {
    const ts = toNum(f.ts)
    const accountId = str(f.accountId)
    if (ts === null || !accountId) return []
    return [{ accountId, instrumentId: str(f.instrumentId) ?? '', ts, realizedPnl: toNum(f.realizedPnl) ?? 0, fillId: str(f.fillId) ?? `${accountId}:${ts}` }]
  })
}

export function normalizeOrders(raw: unknown): OrderLite[] {
  return listOf(raw, 'orders').filter(isRec).flatMap((o) => {
    const accountId = str(o.accountId)
    const instrumentId = str(o.instrumentId)
    if (!accountId || !instrumentId) return []
    return [{ accountId, instrumentId, side: str(o.side) ?? '', reduceOnly: o.reduceOnly === true, createdAt: toNum(o.createdAt) ?? 0, origin: isRec(o.origin) ? (o.origin as unknown as Origin) : null, orderId: str(o.orderId) ?? '', type: str(o.type) ?? '', status: str(o.status) ?? '', triggerPrice: toNum(o.triggerPrice) }]
  })
}

/** 事件 account.positions 的载荷：{accountId, positions}。 */
export function positionsEvent(data: unknown): { accountId: string; positions: Position[] } | null {
  if (!isRec(data)) return null
  const accountId = str(data.accountId)
  // 只有整表（{accountId, positions[]}）才是替换；内核推的是单标的增量（见 positionDelta），不能当整表用，否则一次成交就把持仓表清空。
  return accountId && Array.isArray(data.positions) ? { accountId, positions: normalizePositions(data.positions) } : null
}

/** 内核 `account.positions` 事件的增量形状：{accountId, instrumentId, position | null}（null / 数量 0 = 该标的已平）。集成修补（H）。 */
export function positionDelta(data: unknown): { accountId: string; instrumentId: string; position: Position | null } | null {
  if (!isRec(data) || Array.isArray(data.positions)) return null
  const accountId = str(data.accountId)
  const instrumentId = str(data.instrumentId)
  if (!accountId || !instrumentId) return null
  const p = isRec(data.position) ? normalizePositions([data.position])[0] ?? null : null
  return { accountId, instrumentId, position: p && toNum(p.size) !== 0 ? p : null }
}

/** 把增量合进某账户的持仓表。 */
export function applyPositionDelta(list: readonly Position[], d: { instrumentId: string; position: Position | null }): Position[] {
  const rest = list.filter((p) => p.instrumentId !== d.instrumentId)
  return d.position ? [...rest, d.position] : rest
}

export function summaryEvent(data: unknown): { accountId: string; summary: SummaryLite } | null {
  if (!isRec(data)) return null
  const accountId = str(data.accountId)
  const summary = normalizeSummary(data)
  return accountId && summary ? { accountId, summary } : null
}

export interface PositionRow {
  key: string
  accountId: string
  accountAlias: string
  mode: string
  instrumentId: string
  symbol: string
  side: 'long' | 'short'
  size: number
  entryPrice: number | null
  markPrice: number | null
  notional: number
  unrealizedPnl: number
  liquidationPrice: number | null
  /** 纸面账户的强平价是近似值。 */
  estimated: boolean
  executor: Origin | null
  openedAt: number | null
  position: Position
  /** r4：杠杆（「多 4×」、ROE、保证金）与开仓以来资金费；缺失为 null。 */
  leverage: number | null
  funding: number | null
  /** r4：现有止损单（currentStop）；没有为 null。 */
  stop: OrderLite | null
}

/** 谁开的仓：同账户同标的、方向一致的开仓单里最近一笔的来源（内核盖章）。 */
export function executorOf(p: Position, orders: readonly OrderLite[]): Origin | null {
  const want = p.side === 'long' ? 'buy' : 'sell'
  let best: OrderLite | null = null
  for (const o of orders) {
    if (o.accountId !== p.accountId || o.instrumentId !== p.instrumentId || o.reduceOnly || o.side !== want || !o.origin) continue
    if (!best || o.createdAt > best.createdAt) best = o
  }
  return best?.origin ?? null
}

export function buildRows(accounts: readonly AccountLite[], positions: Record<string, readonly Position[]>, orders: Record<string, readonly OrderLite[]>): PositionRow[] {
  const alias = new Map(accounts.map((a) => [a.accountId, a]))
  const rows: PositionRow[] = []
  for (const [accountId, list] of Object.entries(positions)) {
    const acct = alias.get(accountId)
    for (const p of list) {
      const size = toNum(p.size) ?? 0
      if (size === 0) continue
      rows.push({
        key: `${accountId}|${p.instrumentId}|${p.side}`,
        accountId, accountAlias: acct?.alias ?? accountId, mode: acct?.mode ?? 'live',
        instrumentId: p.instrumentId, symbol: symbolOf(p.instrumentId), side: p.side, size,
        entryPrice: toNum(p.entryPrice), markPrice: toNum(p.markPrice), notional: Math.abs(toNum(p.notional) ?? 0),
        unrealizedPnl: toNum(p.unrealizedPnl) ?? 0, liquidationPrice: toNum(p.liquidationPrice),
        estimated: p.estimated === true || acct?.mode !== 'live',
        executor: executorOf({ ...p, accountId } as Position, orders[accountId] ?? []),
        openedAt: toNum(p.openedAt), position: p,
        leverage: toNum(p.leverage), funding: toNum(p.fundingSinceOpen), stop: currentStop({ accountId, instrumentId: p.instrumentId }, orders[accountId] ?? []),
      })
    }
  }
  return rows.sort((a, b) => b.notional - a.notional || a.key.localeCompare(b.key))
}

export interface Totals {
  equity: number | null
  todayPnl: number | null
  /** 今日盈亏占当日起点权益的百分数；起点未知为 null。 */
  todayPct: number | null
  unrealized: number
  /** true = 今日盈亏退化成「今日已实现」（内核没给当日基线），不含持仓浮盈浮亏。 */
  approx: boolean
}

export function computeTotals(input: { accounts: readonly AccountLite[]; summaries: Record<string, SummaryLite | null>; fills: Record<string, readonly FillLite[]>; rows: readonly PositionRow[] }, now: number): Totals {
  const dayStart = utcDayStart(now)
  let equity: number | null = null
  let pnl: number | null = null
  let base: number | null = null
  let approx = false
  for (const a of input.accounts) {
    const s = input.summaries[a.accountId] ?? null
    if (s?.equity != null) equity = (equity ?? 0) + s.equity
    let p: number | null = null
    if (s?.dayPnl != null) p = s.dayPnl
    else if (s?.equity != null && s.dayStartEquity != null) p = s.equity - s.dayStartEquity
    else {
      const fills = input.fills[a.accountId]
      if (fills) { p = fills.filter((f) => f.ts >= dayStart).reduce((x, f) => x + f.realizedPnl, 0); approx = true }
    }
    if (p !== null) pnl = (pnl ?? 0) + p
    if (s?.equity != null && p !== null && !approx) base = (base ?? 0) + (s.equity - p)
  }
  const pct = pnl !== null && base !== null && base > 0 ? (pnl / base) * 100 : null
  return { equity, todayPnl: pnl, todayPct: pct, unrealized: input.rows.reduce((x, r) => x + r.unrealizedPnl, 0), approx }
}

// ---- 事件链：持仓 → 成交 → 提案 → 来源 ---------------------------------------------------

export type ChainKind = 'position' | 'fill' | 'proposal' | 'origin'
export interface ChainStep { id: string; kind: ChainKind; title: string; detail?: string; ts?: number; origin?: Origin; tone?: 'up' | 'down' | 'warn' }

const PROPOSAL_WORD: Record<string, string> = {
  'proposal.created': tr('待批'), 'proposal.executed': tr('已执行'), 'proposal.failed': tr('执行失败'), 'proposal.expired': tr('已过期'), 'proposal.withdrawn': tr('已撤回'),
}

function decidedWord(e: LedgerEntry): string {
  const d = isRec(e.payload) ? e.payload.decision : undefined
  return d === 'approved' ? tr('已批准') : d === 'rejected' ? tr('已拒绝') : tr('已决定')
}

const sideWord = (s: unknown) => (s === 'buy' ? tr('买入') : s === 'sell' ? tr('卖出') : '')
const nfq = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 8 })
const q = (v: unknown) => { const n = toNum(v); return n === null ? '—' : nfq.format(n) }

const VIA_WORD: Record<string, string> = { mcp: tr('经 MCP'), ui: tr('在界面里'), gep: tr('引擎接口'), gsp: tr('插件'), cli: tr('命令行'), api: tr('本地接口'), internal: tr('内核') }
const PROPOSAL_STATUS_WORD: Record<string, string> = {
  pending: tr('待批'), approved: tr('已批准'), executing: tr('执行中'), executed: tr('已执行'), failed: tr('执行失败'), rejected: tr('已拒绝'), expired: tr('已过期'), withdrawn: tr('已撤回'), denied: tr('被拦截'),
}
/** 这张提案是不是该持仓的来路：同账户、腿里有这个标的、已批准 / 执行中 / 已执行，且不早于开仓前 15 分钟。 */
export function proposalsOfPosition(row: Pick<PositionRow, 'accountId' | 'instrumentId' | 'openedAt'>, proposals: readonly Rec[]): Rec[] {
  return proposals.filter((p) => {
    if (p.accountId !== row.accountId || !['approved', 'executing', 'executed'].includes(String(p.status))) return false
    const legs = Array.isArray(p.intents) ? p.intents.filter(isRec) : []
    if (!legs.some((l) => l.instrumentId === row.instrumentId)) return false
    const t = toNum(isRec(p.execution) ? p.execution.at : undefined) ?? toNum(isRec(p.decision) ? p.decision.at : undefined) ?? toNum(p.expiresAt)
    return row.openedAt === null || t === null || t >= row.openedAt - 15 * 60_000
  })
}

/**
 * 一个持仓的因果链。entries 是该账户该标的的账本条目（升序或降序都行）；proposals 是该账户的提案（账本里的提案条目不带标的，
 * 所以以提案本身的腿为准，账本里同一张票的条目只用来补来源）。
 */
export function buildPositionChain(row: Pick<PositionRow, 'symbol' | 'side' | 'size' | 'entryPrice' | 'openedAt' | 'executor'> & Partial<Pick<PositionRow, 'accountId' | 'instrumentId'>>, entries: readonly LedgerEntry[], proposals: readonly Rec[] = []): ChainStep[] {
  const sorted = [...entries].sort((a, b) => a.seq - b.seq)
  const steps: ChainStep[] = [{
    id: 'position', kind: 'position', title: `${row.side === 'long' ? tr('多') : tr('空')} ${q(row.size)} ${row.symbol}`,
    ...(row.entryPrice != null ? { detail: tr('开仓价 {0}', q(row.entryPrice)) } : {}), ...(row.openedAt != null ? { ts: row.openedAt } : {}),
  }]
  const fills = sorted.filter((e) => e.type === 'fill')
  for (const f of fills.slice(-4)) {
    const p = isRec(f.payload) ? f.payload : ({} as Rec)
    steps.push({ id: f.id, kind: 'fill', title: tr('成交 {0} {1} @ {2}', sideWord(p.side), q(p.size), q(p.price)), ts: f.ts, origin: f.origin })
  }
  if (fills.length > 4) steps.splice(1, 0, { id: 'fills-more', kind: 'fill', title: tr('更早 {0} 笔成交', fills.length - 4) })
  // 提案：同一张票只留最终状态
  const byTicket = new Map<string, LedgerEntry>()
  for (const e of sorted) {
    if (!e.type.startsWith('proposal.')) continue
    const key = e.subject.ticket ?? e.subject.proposalId ?? e.id
    const prev = byTicket.get(key)
    if (!prev || e.type !== 'proposal.decided' || prev.type === 'proposal.created') byTicket.set(key, e)
  }
  for (const [ticket, e] of byTicket) {
    const word = e.type === 'proposal.decided' ? decidedWord(e) : (PROPOSAL_WORD[e.type] ?? '')
    steps.push({ id: `p-${ticket}`, kind: 'proposal', title: tr('提案 {0} {1}', ticket, word).trim(), ts: e.ts, origin: e.origin, ...(e.type === 'proposal.failed' ? { tone: 'down' as const } : {}) })
  }
  const known = new Set(steps.filter((s) => s.kind === 'proposal').map((s) => s.id))
  for (const p of row.accountId && row.instrumentId ? proposalsOfPosition({ accountId: row.accountId, instrumentId: row.instrumentId, openedAt: row.openedAt }, proposals) : []) {
    const ticket = String(p.ticket)
    if (known.has(`p-${ticket}`)) continue
    const ts = toNum(isRec(p.execution) ? p.execution.at : undefined) ?? toNum(isRec(p.decision) ? p.decision.at : undefined) ?? undefined
    steps.push({ id: `p-${ticket}`, kind: 'proposal', title: tr('提案 {0} {1}', ticket, PROPOSAL_STATUS_WORD[String(p.status)] ?? '').trim(), ...(ts !== undefined ? { ts } : {}), ...(isRec(p.origin) ? { origin: p.origin as unknown as Origin } : {}) })
  }
  const first = sorted.find((e) => e.type === 'order.intent' || e.type === 'proposal.created') ?? sorted[0]
  const origin = row.executor ?? first?.origin
  if (origin) {
    // 不露内部 id 与工具名：只说经哪个入口来的。
    const via = VIA_WORD[String(origin.via)]
    steps.push({ id: 'origin', kind: 'origin', title: tr('来源'), origin, ...(via ? { detail: via } : {}) })
  }
  return steps
}


// ---- r4 持仓卡：行内数字、分组、标记、止损与部分平仓（纯函数，显示与下单参数；下单数量 / 价格一律用十进制字符串）----

/** ROE% = 未实现 ÷（数量 × 标记价 ÷ 杠杆）× 100；缺标记价或杠杆返回 null。 */
export function roePct(row: Pick<PositionRow, 'unrealizedPnl' | 'size' | 'markPrice' | 'leverage'>): number | null {
  if (row.markPrice === null || !row.leverage) return null
  const margin = (Math.abs(row.size) * row.markPrice) / row.leverage
  return margin > 0 ? (row.unrealizedPnl / margin) * 100 : null
}

/** 距强平 % = |标记价 − 强平价| ÷ 标记价 × 100；缺任一返回 null。 */
export function liqDistancePct(row: Pick<PositionRow, 'markPrice' | 'liquidationPrice'>): number | null {
  if (row.markPrice === null || row.liquidationPrice === null || row.markPrice <= 0) return null
  return (Math.abs(row.markPrice - row.liquidationPrice) / row.markPrice) * 100
}

export interface RowGroup { accountId: string; alias: string; mode: string; rows: PositionRow[]; subtotal: number }

/** 按账户分组：实盘组在上、纸面组在下（同类保持出现顺序）；组内按开仓时间稳定排序（同时刻按 key），新仓落在组末（G7）；小计只在组内相加。 */
export function groupRows(rows: readonly PositionRow[]): RowGroup[] {
  const by = new Map<string, RowGroup>()
  for (const r of rows) {
    const g = by.get(r.accountId) ?? { accountId: r.accountId, alias: r.accountAlias, mode: r.mode, rows: [], subtotal: 0 }
    g.rows.push(r)
    g.subtotal += r.unrealizedPnl
    by.set(r.accountId, g)
  }
  const t = (r: PositionRow) => r.openedAt ?? Number.MAX_SAFE_INTEGER
  const out = [...by.values()]
  for (const g of out) g.rows.sort((a, b) => t(a) - t(b) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  return [...out.filter((g) => g.mode === 'live'), ...out.filter((g) => g.mode !== 'live')]
}

export const NEW_MS = 10 * 60_000
export const isNew = (row: Pick<PositionRow, 'openedAt'>, now: number): boolean => row.openedAt !== null && now - row.openedAt < NEW_MS
export const nearLiq = (row: Pick<PositionRow, 'markPrice' | 'liquidationPrice'>): boolean => { const d = liqDistancePct(row); return d !== null && d <= 5 }

const OPEN_STATUS = new Set(['open', 'untriggered', 'partially_filled'])
/** 现有止损：同账户同标的、未完成、reduceOnly 的 stop_market 单，多张取最近一张。 */
export function currentStop(row: Pick<PositionRow, 'accountId' | 'instrumentId'>, orders: readonly OrderLite[]): OrderLite | null {
  let best: OrderLite | null = null
  for (const o of orders) {
    if (o.accountId !== row.accountId || o.instrumentId !== row.instrumentId || !o.reduceOnly || o.type !== 'stop_market' || !OPEN_STATUS.has(o.status)) continue
    if (!best || o.createdAt > best.createdAt) best = o
  }
  return best
}

const DEC = /^\d+(\.\d+)?$/
/** 止损触发价本地先挡（不发命令）：非数字 / ≤ 0；多头须低于标记价、空头须高于。通过时 price 是规整后的十进制字符串。 */
export function checkStopPrice(row: Pick<PositionRow, 'side' | 'markPrice'>, input: string): { ok: true; price: string } | { ok: false; message: string } {
  const t = input.replace(/,/g, '').trim()
  if (!DEC.test(t) || Number(t) <= 0) return { ok: false, message: tr('触发价要是大于 0 的数字') }
  const p = Number(t)
  if (row.markPrice !== null && row.side === 'long' && p >= row.markPrice) return { ok: false, message: tr('多头止损价要低于标记价') }
  if (row.markPrice !== null && row.side === 'short' && p <= row.markPrice) return { ok: false, message: tr('空头止损价要高于标记价') }
  return { ok: true, price: t }
}

/** 止损单意图：方向与持仓相反、stop_market、reduceOnly、数量 = 持仓数量（原十进制字符串）。 */
export function stopIntent(row: Pick<PositionRow, 'accountId' | 'instrumentId' | 'side' | 'size' | 'position'>, triggerPrice: string): Record<string, unknown> {
  return {
    accountId: row.accountId, instrumentId: row.instrumentId, side: row.side === 'long' ? 'sell' : 'buy', type: 'stop_market',
    size: String(row.position.size ?? row.size), triggerPrice, reduceOnly: true, reason: tr('人在持仓卡设止损'),
  }
}

/**
 * 部分平仓数量：持仓的 pct%，向下截断到数量步进，不超过持仓；截断后为 0 返回 null（界面置灰并写「无法按比例平仓」）。100% = 原数量字符串。
 * 步进：契约的 Position 与夹具都没有 sizeStep / szDecimals，取「持仓数量的小数位」与 4 位中较细的那个（1 BTC 的 25% = 0.25，30 SOL 的 25% = 7.5）。
 * ponytail: 步进是推断的；品种信息带 szDecimals 后改读它（场所会按真步进再规整或拒单，原文照常回显）。
 */
export function partialSize(row: Pick<PositionRow, 'size' | 'position'>, pct: number): string | null {
  const full = String(row.position.size ?? row.size)
  if (pct >= 100) return full
  const d = Math.max((full.split('.')[1] ?? '').length, 4)
  const f = 10 ** d
  const n = Math.floor(Math.round(Math.abs(Number(full)) * f * pct) / 100) / f
  return n > 0 ? String(Number(n.toFixed(d))) : null
}

/** 该持仓的待批提案（同账户、腿里有这个标的），按到期最早排；返回最急那张的 id。 */
export function pendingOf(row: Pick<PositionRow, 'accountId' | 'instrumentId'>, proposals: readonly Rec[]): string | null {
  let best: { id: string; at: number } | null = null
  for (const p of proposals) {
    if (p.status !== 'pending' || p.accountId !== row.accountId) continue
    const legs = Array.isArray(p.intents) ? p.intents.filter(isRec) : []
    const id = str(p.proposalId)
    if (!id || !legs.some((l) => l.instrumentId === row.instrumentId)) continue
    const at = toNum(p.expiresAt) ?? Number.MAX_SAFE_INTEGER
    if (!best || at < best.at) best = { id, at }
  }
  return best?.id ?? null
}
