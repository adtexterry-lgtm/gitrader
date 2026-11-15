// SPDX-License-Identifier: CPAL-1.0
// 记录页的纯逻辑：records.query 回包 → 行、按账户分组（实盘在上）、组内小计、执行方 / 来源、事件链、筛选参数。无 DOM，vitest 直接测。
// 对账级数值一律十进制字符串：求和 / 乘法 / 取整走 BigInt，不经浮点。
import type { InstrumentPriceRule, LedgerEntry, Origin } from '@gitrader/protocol/types'
import { formatPrice } from '../../blocks-default/src/display'
import { normalizeAccounts, type AccountLite } from '../../blocks-default/src/model-positions'
import { entryToActivity, normalizeLedger } from '../../blocks-default/src/model-activity'
import { isRec, listOf, str, symbolOf } from '../../blocks-default/src/util'
import { t } from '@gitrader/workbench/i18n'

export type { AccountLite }
export { normalizeAccounts }

export type RecordTab = 'fills' | 'orders' | 'funding' | 'blocked'
export type RecordKind = 'fill' | 'order' | 'funding' | 'blocked'
/** 记录页显式路由（总览 / 持仓 / 本标的的「进记录」出口）：#/records/<标的>，冒号保留可读。 */
export const recordsHash = (instrumentId: string): string => '#/records/' + encodeURIComponent(instrumentId).replace(/%3A/gi, ':')
export const TABS: ReadonlyArray<{ id: RecordTab; kind: RecordKind; label: string }> = [
  { id: 'fills', kind: 'fill', label: t('成交') },
  { id: 'orders', kind: 'order', label: t('委托') },
  { id: 'funding', kind: 'funding', label: t('资金费') },
  { id: 'blocked', kind: 'blocked', label: t('被拦') },
]

// ---- 十进制字符串（BigInt 定点）----------------------------------------------------------

interface Dec { n: bigint; s: number }
const DEC = /^([+-]?)(\d+)(?:\.(\d+))?$/
function parseDec(v: unknown): Dec | null {
  const m = typeof v === 'string' ? DEC.exec(v.trim()) : null
  if (!m) return null
  const frac = m[3] ?? ''
  const n = BigInt(`${m[2]}${frac}`)
  return { n: m[1] === '-' ? -n : n, s: frac.length }
}
const pow10 = (k: number): bigint => 10n ** BigInt(k)
const scaleTo = (d: Dec, s: number): bigint => d.n * pow10(s - d.s)

const decString = (d: Dec): string => {
  const abs = (d.n < 0n ? -d.n : d.n).toString().padStart(d.s + 1, '0')
  const int = abs.slice(0, abs.length - d.s)
  return `${d.n < 0n ? '-' : ''}${d.s ? `${int}.${abs.slice(abs.length - d.s)}` : int}`
}
/** 十进制字符串求和（精确）；认不出的项跳过；全空返回 null。 */
export function sumStr(values: ReadonlyArray<unknown>): string | null {
  const ds = values.map(parseDec).filter((d): d is Dec => d !== null)
  if (!ds.length) return null
  const s = Math.max(...ds.map((d) => d.s))
  return decString({ n: ds.reduce((a, d) => a + scaleTo(d, s), 0n), s })
}
export function mulStr(a: unknown, b: unknown): string | null {
  const x = parseDec(a)
  const y = parseDec(b)
  return x && y ? decString({ n: x.n * y.n, s: x.s + y.s }) : null
}

const group3 = (digits: string): string => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')

/** 取整到 places 位（四舍五入，远离零），再按千分位写成字符串；minPlaces 以内保留原有小数位。 */
function fmtDec(d: Dec | null, places: number, opts: { sign?: boolean; minPlaces?: number } = {}): string {
  if (!d) return '—'
  const keep = opts.minPlaces !== undefined ? Math.max(Math.min(d.s, places), opts.minPlaces) : places
  let n = d.n
  if (d.s > keep) {
    const div = pow10(d.s - keep)
    const abs = n < 0n ? -n : n
    const q = (abs + div / 2n) / div
    n = n < 0n ? -q : q
  } else if (d.s < keep) n *= pow10(keep - d.s)
  const neg = n < 0n
  const abs = (neg ? -n : n).toString().padStart(keep + 1, '0')
  const int = group3(abs.slice(0, abs.length - keep))
  const body = keep > 0 ? `${int}.${abs.slice(abs.length - keep)}` : int
  const zero = /^[0.,]*$/.test(body)
  return `${neg && !zero ? '−' : opts.sign && !zero ? '+' : ''}${body}`
}
/** 价格：按原精度、至少 1 位小数；数量：至少 2 位；金额：2 位。负号一律 U+2212。 */
/** 取不到标的精度时：去掉小数部分多余的尾零（「12345.67800000」→「12345.678」），再按至少 1 位小数写。只改展示。 */
const trimZeros = (v: unknown): unknown => (typeof v === 'string' && /^-?\d+\.\d*0$/.test(v) ? v.replace(/0+$/, '').replace(/\.$/, '') : v)
export const fmtPrice = (v: unknown): string => fmtDec(parseDec(trimZeros(v)), 8, { minPlaces: 1 })
/** 有标的价格规则（market.instruments 的 price：tick / maxDecimals / sigFigs）就按它截（共享展示 display.formatPrice），没有就退回 fmtPrice。 */
export const fmtPriceBy = (v: unknown, rule?: InstrumentPriceRule): string => (rule ? formatPrice(v, rule) : fmtPrice(v))
export const fmtQty = (v: unknown): string => fmtDec(parseDec(v), 8, { minPlaces: 2 })
export const fmtMoney = (v: unknown, sign = false): string => fmtDec(parseDec(v), 2, { sign })
export const fmtRate = (v: unknown): string => { const d = parseDec(v); return d ? `${fmtDec({ n: d.n * 100n, s: d.s }, 4)}%` : '—' }
/** 数值正负：up / down / zero（决定着色；0.00 不着色）。 */
export function tone(v: unknown): 'up' | 'down' | 'zero' {
  const d = parseDec(v)
  if (!d || /^[0.,]*$/.test(fmtDec(d, 2).replace('−', ''))) return 'zero'
  return d.n < 0n ? 'down' : 'up'
}

// ---- 时间 ---------------------------------------------------------------------------------

const p2 = (n: number): string => String(n).padStart(2, '0')
export const fmtDay = (ts: number): string => { const d = new Date(ts); return `${p2(d.getMonth() + 1)}-${p2(d.getDate())}` }
export const fmtHms = (ts: number): string => { const d = new Date(ts); return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}` }

export type RangeId = '1d' | '7d' | '30d' | 'all'
export const RANGES: ReadonlyArray<{ id: RangeId; label: string; ms: number | null }> = [
  { id: '1d', label: t('1 天'), ms: 86_400_000 },
  { id: '7d', label: t('7 天'), ms: 7 * 86_400_000 },
  { id: '30d', label: t('30 天'), ms: 30 * 86_400_000 },
  { id: 'all', label: t('全部'), ms: null },
]

// ---- 执行方 / 来源 ----------------------------------------------------------------------

export interface ActorView { kind: 'human' | 'engine' | 'system' | 'agent' | 'unknown'; name: string }

/** 谁做的：origin 内核盖章；origin 为空（无法关联原订单）写「未知」，绝不归为人（协议 views.ts 注释）。 */
export function actorView(origin: Origin | null | undefined, names: Record<string, string> = {}): ActorView {
  if (!origin || !isRec(origin)) return { kind: 'unknown', name: t('未知') }
  const actor = String(origin.actor ?? '')
  const id = actor.slice(actor.indexOf(':') + 1)
  switch (origin.actorType) {
    case 'human': return { kind: 'human', name: t('你') }
    case 'engine': return { kind: 'engine', name: id && id !== actor ? id : t('引擎') }
    case 'system': return { kind: 'system', name: t('系统') }
    case 'llm-agent': return { kind: 'agent', name: names[actor] ?? 'Agent' }
    default: return { kind: 'unknown', name: t('未知') }
  }
}

/** 来源列：有票号写票号；否则按行为人大类写「手动 / 策略 / 保护器 / 系统」，Agent 没走提案写「无」，未知写 —。 */
export function sourceOf(origin: Origin | null | undefined, ticket?: string): string {
  if (ticket) return ticket
  const k = actorView(origin).kind
  if (k === 'human') return t('手动')
  if (k === 'engine') return t('策略')
  if (k === 'system') return String(origin?.tool ?? '').startsWith('protector') ? t('保护器') : t('系统')
  if (k === 'agent') return t('无')
  return '—'
}

export const agentNames = (raw: unknown): Record<string, string> =>
  Object.fromEntries(listOf(raw, 'keys').filter(isRec).flatMap((k) => (typeof k.keyId === 'string' && typeof k.name === 'string' ? [[`agent:${k.keyId}`, k.name]] : [])))

/** 执行方下拉里的 Agent 项：每把钥匙一项，按 actor `agent:<keyId>` 精确筛；已吊销的钥匙名后缀「（已撤销）」。 */
export function agentActorOptions(raw: unknown): Array<{ id: string; label: string }> {
  const names = agentNames(raw)
  return listOf(raw, 'keys').filter(isRec).flatMap((k) => {
    const keyId = typeof k.keyId === 'string' ? k.keyId : ''
    const actor = `agent:${keyId}`
    const name = names[actor]
    if (!keyId || !name) return []
    return [{ id: actor, label: k.status === 'revoked' ? t('{0}（已撤销）', name) : name }]
  })
}

/** proposalId → 票号（委托没有票号字段，经提案列表补）。 */
export const ticketMap = (raw: unknown): Record<string, string> =>
  Object.fromEntries(listOf(raw, 'proposals').filter(isRec).flatMap((p) => (typeof p.proposalId === 'string' && typeof p.ticket === 'string' ? [[p.proposalId, p.ticket]] : [])))

// ---- 行 --------------------------------------------------------------------------------

interface RowBase { id: string; accountId: string; instrumentId: string; symbol: string; ts: number }
export interface FillRow extends RowBase {
  kind: 'fill'; orderId: string; side: 'buy' | 'sell'; price: string; size: string; notional: string; fee: string; realizedPnl: string; liquidity: string
  actor: ActorView; source: string; origin: Origin | null
}
export interface OrderRow extends RowBase {
  kind: 'order'; side: 'buy' | 'sell'; type: string; reduceOnly: boolean; price: string | null; triggerPrice: string | null; size: string; filledSize: string
  status: string; problem: string | null; actor: ActorView; source: string; origin: Origin | null
}
export interface FundingRow extends RowBase { kind: 'funding'; payment: string; rate: string | null; notional: string | null; ccy: string }
/** 被风控拦下的单（账本 risk.denied，经 risk.denials 读）：摘要与规则文案用总览活动流同一个格式化器。 */
export interface BlockedRow extends RowBase { kind: 'blocked'; what: string; rules: string[]; actor: ActorView; origin: Origin | null }
export type RecRow = FillRow | OrderRow | FundingRow | BlockedRow

const dec = (v: unknown): string | null => (typeof v === 'string' && DEC.test(v.trim()) ? v.trim() : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const sideOf = (v: unknown): 'buy' | 'sell' | null => (v === 'buy' || v === 'sell' ? v : null)
const originOf = (v: unknown): Origin | null => (isRec(v) && typeof v.actorType === 'string' ? (v as unknown as Origin) : null)

export function toFill(raw: unknown, names: Record<string, string> = {}): FillRow | null {
  if (!isRec(raw)) return null
  const id = str(raw.fillId)
  const accountId = str(raw.accountId)
  const instrumentId = str(raw.instrumentId)
  const side = sideOf(raw.side)
  const ts = num(raw.ts)
  const price = dec(raw.price)
  const size = dec(raw.size)
  if (!id || !accountId || !instrumentId || !side || ts === null || !price || !size) return null
  const origin = originOf(raw.origin)
  const ticket = str(raw.ticket)
  const n = mulStr(price, size)
  return {
    kind: 'fill', id, accountId, instrumentId, symbol: symbolOf(instrumentId), ts, orderId: str(raw.orderId) ?? '', side, price, size,
    notional: n ?? '', fee: dec(raw.fee) ?? '', realizedPnl: dec(raw.realizedPnl) ?? '0', liquidity: str(raw.liquidity) ?? '',
    actor: actorView(origin, names), source: sourceOf(origin, ticket), origin,
  }
}

export function toOrder(raw: unknown, names: Record<string, string> = {}, tickets: Record<string, string> = {}): OrderRow | null {
  if (!isRec(raw)) return null
  const id = str(raw.orderId)
  const accountId = str(raw.accountId)
  const instrumentId = str(raw.instrumentId)
  const side = sideOf(raw.side)
  const ts = num(raw.createdAt)
  const size = dec(raw.size)
  if (!id || !accountId || !instrumentId || !side || ts === null || !size) return null
  const origin = originOf(raw.origin)
  const proposalId = str(raw.proposalId)
  const problem = isRec(raw.problem) && typeof raw.problem.message === 'string' ? raw.problem.message : null
  return {
    kind: 'order', id, accountId, instrumentId, symbol: symbolOf(instrumentId), ts, side, type: str(raw.type) ?? '', reduceOnly: raw.reduceOnly === true,
    price: dec(raw.price), triggerPrice: dec(raw.triggerPrice), size, filledSize: dec(raw.filledSize) ?? '0', status: str(raw.status) ?? '', problem,
    actor: actorView(origin, names), source: sourceOf(origin, proposalId ? tickets[proposalId] : undefined), origin,
  }
}

/**
 * 资金费是账本条目原样：payload.payment 是现金流（负 = 付出）；内核实际写的是 payload.amount，符号含义与 payment 一样
 * （收到为正、付出为负），两者都认（payment 优先）。rate 认 rate / fundingRate。notional 内核未保证带，缺了写 null
 * （界面标未接通字段）；不回退到 positionSize × 标记价去猜。
 */
export function toFunding(raw: unknown): FundingRow | null {
  if (!isRec(raw) || raw.type !== 'funding') return null
  const id = str(raw.id)
  const subject = isRec(raw.subject) ? raw.subject : {}
  const accountId = str(subject.accountId)
  const instrumentId = str(subject.instrumentId)
  const ts = num(raw.ts)
  const p = isRec(raw.payload) ? raw.payload : {}
  const payment = dec(p.payment ?? p.amount)
  if (!id || !accountId || !instrumentId || ts === null || payment === null) return null
  return { kind: 'funding', id, accountId, instrumentId, symbol: symbolOf(instrumentId), ts, payment, rate: dec(p.rate ?? p.fundingRate), notional: dec(p.notional), ccy: str(p.ccy) ?? '' }
}

export interface Page { rows: RecRow[]; next: string | undefined; total: number | null; error: string | null }

/** records.query 回包 → 一页行。回 {ok:false,error} 的当失败，错误原文照留；items 里认不出的行丢弃。total 只有第一页回包才带。 */
export function pageOf(tab: RecordTab, raw: unknown, ctx: { names?: Record<string, string>; tickets?: Record<string, string> } = {}): Page {
  if (isRec(raw) && raw.ok === false) return { rows: [], next: undefined, total: null, error: isRec(raw.error) && typeof raw.error.message === 'string' ? raw.error.message : 'ok: false' }
  const items = isRec(raw) && Array.isArray(raw.items) ? raw.items : null
  if (!items) return { rows: [], next: undefined, total: null, error: 'records.query: items missing' }
  const rows = items.flatMap((it): RecRow[] => {
    const r = tab === 'fills' ? toFill(it, ctx.names) : tab === 'orders' ? toOrder(it, ctx.names, ctx.tickets) : toFunding(it)
    return r ? [r] : []
  })
  return { rows, next: isRec(raw) ? str(raw.next) : undefined, total: isRec(raw) ? num(raw.total) : null, error: null }
}

/** risk.denials 回包（账本条目数组）→ 被拦行。{ok:false} / 不是数组 = 失败原文（界面显示未接通 / 读取失败），不猜；非 risk.denied 条目丢弃。无游标。 */
export function pageOfBlocked(raw: unknown, ctx: { names?: Record<string, string> } = {}): Page {
  if (isRec(raw) && raw.ok === false) return { rows: [], next: undefined, total: null, error: isRec(raw.error) && typeof raw.error.message === 'string' ? raw.error.message : 'ok: false' }
  if (!Array.isArray(raw) && !(isRec(raw) && Array.isArray(raw.entries))) return { rows: [], next: undefined, total: null, error: 'risk.denials: entries missing' }
  const rows = normalizeLedger(raw).filter((e) => e.type === 'risk.denied').flatMap((e): BlockedRow[] => {
    const a = entryToActivity(e)
    if (!a) return []
    const instrumentId = a.instrumentId ?? ''
    return [{ kind: 'blocked', id: e.id, accountId: str(e.subject.accountId) ?? '', instrumentId, symbol: instrumentId ? symbolOf(instrumentId) : '—', ts: e.ts, what: a.what, rules: a.rules, actor: actorView(e.origin, ctx.names), origin: originOf(e.origin) }]
  })
  return { rows, next: undefined, total: null, error: null }
}

/** 合计提示：分页未尽时说明只含已加载部分；第一页回包带 total 时补上总条数，缺 total 保持原句。 */
export function loadedNote(loaded: number, total: number | null | undefined, hasMore: boolean): string | undefined {
  if (!hasMore) return undefined
  return total === null || total === undefined ? t('已加载 {0} 条，合计只含已加载部分', loaded) : t('已加载 {0} / 共 {1} 条，合计只含已加载部分', loaded, total)
}

/** 续读合并：按 id 去重，保持既有顺序（游标续读到底不重复、不丢行）。 */
export function mergeRows<T extends { id: string }>(prev: readonly T[], more: readonly T[]): T[] {
  const seen = new Set(prev.map((r) => r.id))
  return [...prev, ...more.filter((r) => !seen.has(r.id) && seen.add(r.id))]
}

// ---- 标的筛选 ---------------------------------------------------------------------------

/** 全部记录里出现过的标的（instrumentId，去重 + 排序）。下拉选项只由这份全量行生成，不随后续筛选收窄。 */
export function recordSymbols<T extends { instrumentId: string }>(rows: readonly T[]): string[] {
  return [...new Set(rows.map((r) => r.instrumentId))].sort()
}

/** 按标的筛选；null / 空串 = 全部。参数收 instrumentId（hyperliquid:BTC）或显示名（BTC），行上的两个字段都认。 */
export function applySymbolFilter<T extends { instrumentId: string; symbol: string }>(rows: readonly T[], symbol: string | null): T[] {
  if (!symbol) return [...rows]
  return rows.filter((r) => r.instrumentId === symbol || r.symbol === symbol)
}

// ---- 分组 ------------------------------------------------------------------------------

export interface RecGroup<T extends RecRow = RecRow> {
  accountId: string; alias: string; mode: string; venue: string; rows: T[]
  /** 本组合计（只加本组）：成交 = 已实现；资金费 = 金额；委托没有。 */
  total: string | null
  /** 本组手续费合计（成交）。 */
  fee: string | null
}

const amountOf = (r: RecRow): string | null => (r.kind === 'fill' ? r.realizedPnl : r.kind === 'funding' ? r.payment : null)

/** 按账户分组：实盘组在上、纸面组在下、账户表里没有的最后；组内保持传入顺序（时间倒序）。小计只在组内加，实盘与纸面绝不相加。 */
export function groupRecords<T extends RecRow>(rows: readonly T[], accounts: readonly AccountLite[]): RecGroup<T>[] {
  const info = new Map(accounts.map((a) => [a.accountId, a]))
  const by = new Map<string, RecGroup<T>>()
  for (const r of rows) {
    let g = by.get(r.accountId)
    if (!g) {
      const a = info.get(r.accountId)
      g = { accountId: r.accountId, alias: a?.alias ?? r.accountId, mode: a?.mode ?? '', venue: a?.venue ?? '', rows: [], total: null, fee: null }
      by.set(r.accountId, g)
    }
    g.rows.push(r)
  }
  const rank = (g: RecGroup<T>) => (g.mode === 'live' ? 0 : g.mode === 'paper' ? 1 : 2)
  const order = [...by.values()].sort((a, b) => rank(a) - rank(b))
  for (const g of order) {
    g.total = sumStr(g.rows.map(amountOf))
    g.fee = sumStr(g.rows.map((r) => (r.kind === 'fill' ? r.fee : null)))
  }
  return order
}

/** 卡头读数：实盘合计 / 纸面合计各自只加本组，两者不相加。 */
export function headTotals(groups: readonly RecGroup[], field: 'fee' | 'total'): { live: string | null; paper: string | null } {
  const sum = (mode: string) => sumStr(groups.filter((g) => g.mode === mode).map((g) => g[field]))
  return { live: sum('live'), paper: sum('paper') }
}

export const groupLabel = (g: Pick<RecGroup, 'mode' | 'rows'>): string => `${g.mode === 'paper' ? t('纸面') : g.mode === 'live' ? t('实盘') : t('账户')} ${g.rows.length}`

// ---- 委托文案 -----------------------------------------------------------------------------

const TYPE_WORD: Record<string, string> = { limit: t('限价'), market: t('市价'), stop_market: t('止损'), stop_limit: t('止损限价'), take_profit_market: t('止盈'), take_profit_limit: t('止盈限价'), trailing_stop: t('移动止损') }
export const typeWord = (o: Pick<OrderRow, 'type' | 'reduceOnly'>): string => `${TYPE_WORD[o.type] ?? o.type}${o.reduceOnly ? t('　只减仓') : ''}`

/** 状态字 + 色调：denied / rejected 用危险色，已成交 / 已撤销三级灰，挂单中正文色。 */
const STATUS_WORD: Record<string, [string, 'danger' | 'dim' | 'body']> = {
  new: [t('已提交'), 'body'], submitted: [t('已提交'), 'body'], open: [t('挂单中'), 'body'], untriggered: [t('待触发'), 'body'], partially_filled: [t('部分成交'), 'body'],
  filled: [t('已成交'), 'dim'], cancelled: [t('已撤销'), 'dim'], expired: [t('已过期'), 'dim'], rejected: [t('场所拒绝'), 'danger'], denied: [t('已拦截'), 'danger'],
}
export const statusWord = (status: string): { word: string; tone: 'danger' | 'dim' | 'body' } => { const w = STATUS_WORD[status]; return w ? { word: w[0], tone: w[1] } : { word: status || '—', tone: 'body' } }
/** 委托价格列：市价 / 止损看触发价，其余看限价。 */
export const orderPrice = (o: OrderRow, rule?: InstrumentPriceRule): { text: string; market: boolean } =>
  o.type === 'market' ? { text: t('市价'), market: true } : { text: fmtPriceBy(o.triggerPrice ?? o.price, rule), market: false }

// ---- 事件链（ledger.trace → 节点）--------------------------------------------------------

export interface ChainNode { id: string; label: string; ts?: number; actor?: ActorView; tone?: 'danger' }

const VERDICT_WORD: Record<string, string> = { allow: t('通过'), review: t('需批准'), deny: t('拒绝') }

/** 一笔订单的全链条目（升序）→ 事件链节点：意图 → 预检 → 待批 → 批准 → 提交 → 成交。多笔成交合成一个「成交」节点（取最后一笔时刻）。 */
export function buildRecordChain(entries: readonly LedgerEntry[], names: Record<string, string> = {}): ChainNode[] {
  const out: ChainNode[] = []
  const fills = entries.filter((e) => e.type === 'fill')
  for (const e of [...entries].sort((a, b) => a.seq - b.seq)) {
    const p = isRec(e.payload) ? e.payload : {}
    const actor = actorView(e.origin, names)
    switch (e.type) {
      case 'order.intent': out.push({ id: e.id, label: t('意图'), ts: e.ts, actor }); break
      case 'risk.precheck': out.push({ id: e.id, label: t('预检 {0}', VERDICT_WORD[String(e.precheck?.verdict ?? '')] ?? '').trim() }); break
      case 'risk.denied': out.push({ id: e.id, label: t('预检 拒绝'), ts: e.ts, tone: 'danger' }); break
      case 'proposal.created': out.push({ id: e.id, label: t('待批 {0}', e.subject.ticket ?? '').trim() }); break
      case 'proposal.decided': out.push({ id: e.id, label: p.decision === 'rejected' ? t('拒绝') : t('批准'), ts: e.ts, actor, ...(p.decision === 'rejected' ? { tone: 'danger' as const } : {}) }); break
      case 'order.submitted': out.push({ id: e.id, label: t('提交'), ts: e.ts }); break
      case 'order.rejected': out.push({ id: e.id, label: t('场所拒绝'), ts: e.ts, tone: 'danger' }); break
      case 'order.cancelled': out.push({ id: e.id, label: t('撤销'), ts: e.ts }); break
      case 'order.expired': out.push({ id: e.id, label: t('过期'), ts: e.ts }); break
      default: break
    }
  }
  const last = fills.reduce<LedgerEntry | null>((a, e) => (!a || e.ts > a.ts ? e : a), null)
  if (last) out.push({ id: last.id, label: fills.length > 1 ? t('成交 ×{0}', fills.length) : t('成交'), ts: last.ts })
  return out
}

// ---- 查询参数 ---------------------------------------------------------------------------

export interface Filters {
  accountId?: string; instrumentId?: string; actorType?: 'human' | 'engine' | 'llm-agent' | 'system'
  /** 单把 Agent 钥匙（`agent:<keyId>`），与 actorType 互斥；内核按 origin.actor 精确匹配。 */
  actor?: string
  range: RangeId; custom?: { from: number; to: number }
}
export const DEFAULT_FILTERS: Filters = { range: '7d' }
export const ACTOR_OPTIONS: ReadonlyArray<{ id: NonNullable<Filters['actorType']>; label: string }> = [
  { id: 'human', label: t('你') }, { id: 'engine', label: t('引擎') }, { id: 'llm-agent', label: 'Agent' }, { id: 'system', label: t('系统') },
]

/** 执行方下拉的选中值 → 筛选字段：角色 id 落到 actorType，`agent:<keyId>` 落到 actor（两者互斥）。 */
export function actorFilters(id: string | undefined | null): Pick<Filters, 'actorType' | 'actor'> {
  if (!id) return {}
  return ACTOR_OPTIONS.some((o) => o.id === id) ? { actorType: id as NonNullable<Filters['actorType']> } : { actor: id }
}

/** 时间筛选 → [sinceTs, untilTs]。预设取「现在 − N 天」起、不设上限；来自联动的自定义区间两端都带。 */
export function timeBounds(f: Pick<Filters, 'range' | 'custom'>, now: number): { sinceTs?: number; untilTs?: number } {
  if (f.custom) return { sinceTs: f.custom.from, untilTs: f.custom.to }
  const ms = RANGES.find((r) => r.id === f.range)?.ms
  return ms ? { sinceTs: Math.max(0, now - ms) } : {}
}

export function queryParams(kind: RecordKind, f: Filters, now: number, cursor?: string, limit = 100): Record<string, unknown> {
  return {
    kind, limit, ...timeBounds(f, now),
    ...(f.accountId ? { accountId: f.accountId } : {}), ...(f.instrumentId ? { instrumentId: f.instrumentId } : {}),
    ...(f.actorType ? { actorType: f.actorType } : {}), ...(f.actor ? { actor: f.actor } : {}), ...(cursor ? { cursor } : {}),
  }
}

/** 导出范围 = 当前时间筛选：ledger.export 只认 seq，所以先用时间界查出首 / 末条的 seq。 */
export function exportParams(first: { seq: number } | undefined, last?: { seq: number } | undefined): Record<string, unknown> | null {
  if (!first) return null
  return { fromSeq: first.seq, ...(last ? { toSeq: last.seq } : {}) }
}

/** 联动时间区间 → 预设（取最接近的整天数）；对不上返回 null（界面写「自定义」）。 */
export function rangeOfLink(v: unknown): Pick<Filters, 'range' | 'custom'> | null {
  if (!isRec(v) || typeof v.from !== 'number' || typeof v.to !== 'number' || !(v.from < v.to)) return null
  return { range: '7d', custom: { from: v.from, to: v.to } }
}
