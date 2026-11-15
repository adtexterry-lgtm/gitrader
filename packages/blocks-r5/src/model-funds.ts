// SPDX-License-Identifier: CPAL-1.0
// 资金页的纯逻辑：把内核的查询结果规整成视图数据。无 DOM、无桥，vitest 直接测。
// 对账级数值（金额、数量、费用、余额）一律保持十进制字符串：求和 / 格式化复用 model-records 的 BigInt 定点函数，按内核给的精度显示，不经浮点。
// 只有比例（保证金率、条宽、费率、坐标轴）和画曲线用的像素坐标用数字，它们不是对账数值。
import { isRec, listOf, str, toNum, type Rec } from '../../blocks-default/src/util'
import { fmtMoney, fmtQty, mulStr, sumStr } from './model-records'
import { t as tr } from '@gitrader/workbench/i18n'

export const MINUS = '−'
const DASH = '—'

// ---- 显示 --------------------------------------------------------------------------------

/** 十进制字符串（或有限数字）→ 规整后的十进制字符串；认不出为 null。精度原样，不取整。 */
export function dec(v: unknown): string | null {
  if (typeof v === 'number') return Number.isFinite(v) ? sumStr([String(v)]) : null
  return typeof v === 'string' ? sumStr([v]) : null
}
/** 取反（只翻符号，不碰数字）。 */
export function negStr(v: string | null): string | null {
  if (v === null) return null
  const t = v.trim()
  return dec(t.startsWith('-') ? t.slice(1) : t.startsWith('+') ? '-' + t.slice(1) : '-' + t)
}
const isZero = (v: string): boolean => !/[1-9]/.test(v)

/** 千分位、按内核给的精度（至少两位、至多八位）；负数用 U+2212。 */
export function fmtAmt(v: string | null): string {
  return v === null ? DASH : fmtQty(v)
}

/** 带符号：正 +，负 U+2212，数值为零不带符号。 */
export function fmtSigned(v: string | null): string {
  if (v === null) return DASH
  const text = fmtQty(v)
  return isZero(v) || text.startsWith(MINUS) || text === DASH ? text : '+' + text
}

/** 涨跌方向；零、缺失、认不出都是中性（不着色）。 */
export function toneOf(v: string | null): 'up' | 'down' | 'neutral' {
  if (v === null || dec(v) === null || isZero(v)) return 'neutral'
  return v.trim().startsWith('-') ? 'down' : 'up'
}

/** 比率（0.0241）→ 百分数文本 2.41%。 */
export function fmtPct(ratio: number | null, digits = 2): string {
  return ratio === null ? DASH : `${(ratio * 100).toFixed(digits)}%`
}

const p2 = (n: number): string => String(n).padStart(2, '0')
/** 本地时间 MM-DD HH:mm。 */
export function fmtStamp(ms: number): string {
  const d = new Date(ms)
  return `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`
}
/** mm:ss（离线「已暂停更新」用）。 */
export function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${p2(Math.floor(s / 60))}:${p2(s % 60)}`
}

// ---- 错误 --------------------------------------------------------------------------------

export interface FailInfo { message: string; code: number | null; name: string | null }

/** 内核错误（KernelError）或 {ok:false, error} 形状的结果 → 原文 + 错误码 / 名。文案原样，不改写。 */
export function failOf(e: unknown): FailInfo {
  const src: Rec = isRec(e) && isRec(e.error) ? e.error : isRec(e) ? e : {}
  const data = isRec(src.data) ? src.data : {}
  const code = toNum(src.code)
  // Problem 名：KernelError 的 problemName / problem.name，或原始 Problem 的 data.name / name；JS Error 自带的 name（"Error"）不是
  const name = str(src.problemName) ?? (isRec(src.problem) ? str(src.problem.name) : undefined) ?? str(data.name) ?? (e instanceof Error ? undefined : str(src.name)) ?? null
  const message = str(src.message) ?? (e instanceof Error ? e.message : String(e))
  return { message, code, name }
}

/** 查询「成功」返回、但载荷是 {ok:false, error}（视图契约允许）：取出错误；否则 null。 */
export function okFalse(raw: unknown): FailInfo | null {
  return isRec(raw) && raw.ok === false ? failOf(raw) : null
}

// ---- 账户 --------------------------------------------------------------------------------

export type Mode = 'live' | 'paper' | 'shadow'
export interface FundAccount {
  accountId: string; alias: string; mode: Mode; venue: string; environment: string
  /** 纸面账户的初始资金（重置后回到这个数）。 */
  initial: string | null; ccy: string
}

export function normalizeAccounts(raw: unknown): FundAccount[] {
  return listOf(raw, 'accounts').filter(isRec).flatMap((a) => {
    const accountId = str(a.accountId)
    if (!accountId) return []
    const mode: Mode = a.mode === 'paper' || a.mode === 'shadow' ? a.mode : 'live'
    const paper = isRec(a.paper) ? a.paper : {}
    return [{ accountId, alias: str(a.alias) ?? accountId, mode, venue: str(a.venue) ?? '', environment: str(a.environment) ?? '', initial: dec(paper.initialBalance), ccy: str(paper.ccy) ?? '' }]
  })
}

export interface Summary { equity: string | null; available: string | null; today: string | null }

/** 今日 = 权益 − 日初权益；没有日初就用内核给的 dayPnl；都没有就缺失。 */
export function summaryOf(raw: unknown): Summary | null {
  if (!isRec(raw)) return null
  const equity = dec(raw.equity)
  const dayStart = dec(raw.dayStartEquity)
  const today = equity !== null && dayStart !== null ? sumStr([equity, negStr(dayStart)]) : dec(raw.dayPnl)
  return { equity, available: dec(raw.available), today }
}

export type Health = Record<string, { down: boolean; unverified: boolean }>
/** 场所状态：{venue: {down, unverified}}。 */
export function venueHealth(raw: unknown): Health {
  const out: Health = {}
  for (const v of listOf(raw, 'venues').filter(isRec)) {
    const id = str(v.venue) ?? str(v.id)
    if (id) out[id] = { down: v.wsState === 'disconnected', unverified: v.unverified === true }
  }
  return out
}

export interface RowState {
  summary: Summary | null
  /** 维持保证金 / 权益（0.0241）；读不到为 null。 */
  ratio: number | null
  unreachable: boolean
  unverified: boolean
  error: string | null
}
export const EMPTY_ROW: RowState = { summary: null, ratio: null, unreachable: false, unverified: false, error: null }

export interface Totals { equity: string | null; available: string | null; today: string | null }
export interface Group { mode: 'live' | 'paper'; rows: { account: FundAccount; state: RowState }[]; subtotal: Totals }

/** 实盘 / 纸面两组；影子账户不进任何一组。组小计只在组内加，任何一行缺这一列就整格留空（不拿残缺的和冒充合计）。 */
export function groupAccounts(accounts: readonly FundAccount[], states: Readonly<Record<string, RowState>>): Group[] {
  const groups: Group[] = []
  for (const mode of ['live', 'paper'] as const) {
    const rows = accounts.filter((a) => a.mode === mode).map((account) => ({ account, state: states[account.accountId] ?? EMPTY_ROW }))
    if (!rows.length) continue
    const sum = (pick: (s: Summary) => string | null): string | null => {
      const vs: string[] = []
      for (const r of rows) {
        const v = r.state.unreachable || !r.state.summary ? null : pick(r.state.summary)
        if (v === null) return null
        vs.push(v)
      }
      return sumStr(vs)
    }
    groups.push({ mode, rows, subtotal: { equity: sum((s) => s.equity), available: sum((s) => s.available), today: sum((s) => s.today) } })
  }
  return groups
}

/** 保证金率 ≥ 85% 转琥珀。 */
export const MARGIN_WARN = 0.85
export const marginWarn = (ratio: number | null): boolean => ratio !== null && ratio >= MARGIN_WARN
/** 条宽百分数（0–100，保留两位）。 */
export const barPct = (ratio: number | null): number => (ratio === null ? 0 : Math.round(Math.min(1, Math.max(0, ratio)) * 10000) / 100)

export const NETWORK_TEXT: Record<string, string> = { mainnet: tr('主网'), testnet: tr('测试网') }
export const networkText = (a: FundAccount): string => (a.mode === 'live' ? NETWORK_TEXT[a.environment] ?? a.environment : tr('纸面'))

/** 行状态：场所不可达只落在这一行（场所断开，或这个账户的权益查询回「场所不可达」）。 */
export function rowState(account: FundAccount, p: { summary: unknown; summaryFail: FailInfo | null; assets: unknown; health: Health }): RowState {
  const h = p.health[account.venue]
  const unreachable = account.mode === 'live' && (h?.down === true || p.summaryFail?.name === 'VENUE_UNAVAILABLE')
  const margin = isRec(p.assets) && isRec(p.assets.margin) ? p.assets.margin : null
  return {
    summary: unreachable || p.summaryFail ? null : summaryOf(p.summary),
    ratio: unreachable || !margin ? null : toNum(margin.marginRatio),
    unreachable,
    unverified: account.mode === 'live' && h?.unverified === true,
    error: p.summaryFail && !unreachable ? p.summaryFail.message : null,
  }
}

/** 纸面重置的确认文案（G2：写出后果）。 */
export function resetText(account: FundAccount, positions: number, orders: number): string {
  const back = account.initial !== null ? tr('，余额回到 {0}', fmtAmt(account.initial)) : ''
  return tr('清空 {0}：持仓 {1}、挂单 {2}{3}', account.alias, positions, orders, back)
}
const OPEN_ORDER = new Set(['new', 'submitted', 'open', 'untriggered', 'partially_filled'])
export const countOpenOrders = (raw: unknown): number => listOf(raw, 'orders').filter(isRec).filter((o) => OPEN_ORDER.has(String(o.status))).length
export const countPositions = (raw: unknown): number => listOf(raw, 'positions').filter(isRec).filter((p) => (toNum(p.size) ?? 0) !== 0).length

// ---- 权益曲线 ----------------------------------------------------------------------------

export type Tab = '1D' | '7D' | '30D' | 'ALL'
export const TABS: readonly Tab[] = ['1D', '7D', '30D', 'ALL']
export const TAB_TEXT: Record<Tab, string> = { '1D': '1D', '7D': '7D', '30D': '30D', ALL: tr('全部') }
const DAY = 86_400_000

/** 区间 → 查询参数；采样越长步长越粗（内核可按更粗粒度降采样，缺失区间不插值）。 */
export function rangeOf(tab: Tab, now: number): { from: number; to: number; step: '1m' | '1h' | '1d' } {
  if (tab === '1D') return { from: now - DAY, to: now, step: '1m' }
  if (tab === '7D') return { from: now - 7 * DAY, to: now, step: '1h' }
  if (tab === '30D') return { from: now - 30 * DAY, to: now, step: '1h' }
  return { from: 0, to: now, step: '1d' }
}

/** t 观察时刻；s 内核给的十进制字符串（显示用）；v 画线用的坐标数值。 */
export interface Pt { t: number; v: number; s: string }
export interface Curve { segments: Pt[][]; first: Pt | null; last: Pt | null }

/**
 * 缺采样段断开不补：落在 gaps 里的点丢掉，gap 两侧的点分属不同的段（各画各的线）。
 * 只取 [from, to) 内的点；t 是观察时刻，按时间排序。
 */
export function curveOf(raw: unknown, from = 0, to = Number.POSITIVE_INFINITY): Curve {
  const view = isRec(raw) ? raw : {}
  const gaps = listOf(view, 'gaps').filter(isRec).flatMap((g) => { const a = toNum(g.from); const b = toNum(g.to); return a !== null && b !== null && b > a ? [{ from: a, to: b }] : [] })
  const inGap = (t: number): boolean => gaps.some((g) => t >= g.from && t < g.to)
  const pts = listOf(view, 'points').filter(isRec).flatMap((p) => { const t = toNum(p.t); const s = dec(p.equity); return t !== null && s !== null && t >= from && t < to && !inGap(t) ? [{ t, v: Number(s), s }] : [] }).sort((a, b) => a.t - b.t)
  const segments: Pt[][] = []
  let key = -1
  for (const p of pts) {
    const k = gaps.filter((g) => g.to <= p.t).length
    if (k !== key || !segments.length) { segments.push([]); key = k }
    segments[segments.length - 1]!.push(p)
  }
  return { segments, first: pts[0] ?? null, last: pts[pts.length - 1] ?? null }
}

/** 坐标轴刻度标签（不是对账数值）：千分位；同一组刻度共用小数位数，整数刻度不带 .00（最多八位）。 */
export function fmtTicks(vs: readonly number[]): (v: number) => string {
  const dp = Math.min(8, Math.max(0, ...vs.map((v) => (String(Number(Math.abs(v).toFixed(8))).split('.')[1] ?? '').length)))
  const nf = new Intl.NumberFormat('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp })
  return (v) => (v < 0 ? MINUS : '') + nf.format(Math.abs(v))
}

/** 约 want 条网格线的「好看」刻度（步长取 1 / 2 / 2.5 / 5 × 10^n）。 */
export function niceTicks(lo: number, hi: number, want = 6): number[] {
  if (!(hi > lo)) return [lo]
  const raw = (hi - lo) / want
  const mag = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag
  const out: number[] = []
  for (let i = Math.ceil(lo / step - 1e-9); i * step <= hi + step * 1e-9; i += 1) out.push(Math.round(i * step * 1e6) / 1e6)
  return out
}

/** x 轴标签：跨度 > 2 天按本地 0 点标「DD日」，否则每 4 小时标 HH:00。 */
export function timeTicks(from: number, to: number): { t: number; label: string }[] {
  const out: { t: number; label: string }[] = []
  const d = new Date(from)
  if (to - from > 2 * DAY) {
    d.setHours(0, 0, 0, 0)
    const stride = Math.max(1, Math.ceil((to - from) / DAY / 8))
    for (let t = new Date(d).setDate(d.getDate() + 1); t <= to; t = new Date(t).setDate(new Date(t).getDate() + stride)) out.push({ t, label: tr('{0}日', p2(new Date(t).getDate())) })
  } else {
    d.setMinutes(0, 0, 0)
    d.setHours(d.getHours() - (d.getHours() % 4) + 4)
    for (let t = d.getTime(); t <= to; t += 4 * 3_600_000) out.push({ t, label: `${p2(new Date(t).getHours())}:00` })
  }
  return out
}

// ---- 资产 / 保证金 -----------------------------------------------------------------------

export interface AssetRow { asset: string; total: string | null; available: string | null; frozen: string | null; borrowed: string }
export function assetsOf(raw: unknown): AssetRow[] {
  return listOf(raw, 'balances').filter(isRec).flatMap((b) => {
    const asset = str(b.asset)
    return asset ? [{ asset, total: dec(b.total), available: dec(b.available), frozen: dec(b.hold), borrowed: dec(b.borrowed) ?? '0' }] : []
  })
}

export interface MarginView { equity: string; initial: string; maintenance: string; available: string | null; ratio: number | null; leverage: number | null; initialPct: number; maintPct: number }
/** 保证金卡：初始 / 维持两条（占权益的比例）+ 可用 / 杠杆 / 保证金率；没有保证金快照返回 null。金额保持字符串，比例才用数字。 */
export function marginOf(raw: unknown): MarginView | null {
  const m = isRec(raw) && isRec(raw.margin) ? raw.margin : null
  if (!m) return null
  const equity = dec(m.equity)
  const initial = dec(m.initialMargin)
  const maintenance = dec(m.maintenanceMargin)
  if (equity === null || initial === null || maintenance === null) return null
  const eq = Number(equity)
  const pct = (x: string): number => (eq > 0 ? barPct(Number(x) / eq) : 0)
  return { equity, initial, maintenance, available: dec(m.available), ratio: toNum(m.marginRatio), leverage: toNum(m.leverage), initialPct: pct(initial), maintPct: pct(maintenance) }
}

// ---- 权益变动 ----------------------------------------------------------------------------

export interface ChangeRow { key: 'start' | 'realized' | 'fee' | 'funding' | 'unrealized' | 'end'; label: string; value: string; tone: 'up' | 'down' | 'neutral'; detail: string }

const symbolOf = (instrumentId: string): string => { const i = instrumentId.indexOf(':'); return i >= 0 ? instrumentId.slice(i + 1) : instrumentId }
const fundingSymbol = (e: Rec): string => {
  const fromSubject = isRec(e.subject) ? str(e.subject.instrumentId) : undefined
  const fromPayload = isRec(e.payload) ? str(e.payload.instrumentId) : undefined
  return symbolOf(fromSubject ?? fromPayload ?? '?')
}

/**
 * 期初 → 已实现 → 手续费 → 资金费 → 未实现 → 期末。数字都由内核给的记录推出：
 * 期初 / 期末取曲线的头尾点，已实现与手续费来自成交，资金费来自资金费记录（现金流符号：负 = 付出），未实现来自当前持仓。
 * 没有曲线、或整段什么都没发生（无成交无资金费无持仓且权益没动）返回 null。
 */
export function changesOf(p: { first: Pt | null; last: Pt | null; fills: unknown; funding: unknown; positions: unknown }): ChangeRow[] | null {
  if (!p.first || !p.last) return null
  const fills = listOf(p.fills, 'items').filter(isRec)
  const funding = listOf(p.funding, 'items').filter(isRec)
  const positions = listOf(p.positions, 'positions').filter(isRec)
  const moved = sumStr([p.first.s, negStr(p.last.s)])
  if (!fills.length && !funding.length && !positions.length && moved !== null && isZero(moved)) return null
  const realized = sumStr(fills.map((f) => dec(f.realizedPnl))) ?? '0'
  const fee = sumStr(fills.map((f) => dec(f.fee))) ?? '0'
  const notional = sumStr(fills.map((f) => mulStr(dec(f.price), dec(f.size)))) ?? '0'
  const perSymbol = new Map<string, string[]>()
  for (const e of funding) perSymbol.set(fundingSymbol(e), [...(perSymbol.get(fundingSymbol(e)) ?? []), dec(isRec(e.payload) ? e.payload.amount : undefined) ?? '0'])
  const bySymbol = new Map([...perSymbol].map(([k, vs]) => [k, sumStr(vs) ?? '0'] as const))
  const fundingTotal = sumStr([...bySymbol.values()]) ?? '0'
  const unrealized = sumStr(positions.map((x) => dec(x.unrealizedPnl))) ?? '0'
  const sym = [...bySymbol.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k} ${fmtSigned(v)}`).join(tr('　'))
  const abs = (key: ChangeRow['key'], label: string, value: string, detail: string): ChangeRow => ({ key, label, value, tone: 'neutral', detail })
  const flow = (key: ChangeRow['key'], label: string, value: string, detail: string): ChangeRow => ({ key, label, value, tone: toneOf(value), detail })
  return [
    abs('start', tr('期初'), p.first.s, fmtStamp(p.first.t)),
    flow('realized', tr('已实现'), realized, tr('成交 {0} 笔', fills.length)),
    // 手续费是支出，显示为负；颜色中性（费用不是盈亏）
    { key: 'fee', label: tr('手续费'), value: negStr(fee) ?? '0', tone: 'neutral', detail: Number(notional) > 0 ? tr('费率 {0}%', ((Number(fee) / Number(notional)) * 100).toFixed(2)) : tr('成交 {0} 笔', fills.length) },
    { key: 'funding', label: tr('资金费'), value: fundingTotal, tone: 'neutral', detail: sym || tr('无记录') },
    flow('unrealized', tr('未实现'), unrealized, tr('持仓 {0}', positions.length)),
    abs('end', tr('期末'), p.last.s, fmtStamp(p.last.t)),
  ]
}

// ---- 组合（portfolio.analysis）-------------------------------------------------------------

/** 一行：左边名字，右边金额 / 份额（十进制字符串直接格式化，前端不再算比例；「其余」行的合计用 BigInt 求和）。 */
export interface PortfolioRow { key: string; label: string; amount: string | null; share: string | null; tone?: 'up' | 'down' | 'neutral' }
export type PortfolioModel =
  | { kind: 'ready'; scope: 'live' | 'paper'; scopes: Array<'live' | 'paper'>; ccy: string; venues: PortfolioRow[]; strategies: PortfolioRow[]; instruments: PortfolioRow[]; missing: string[] }
  | { kind: 'empty'; scope: 'live' | 'paper'; scopes: Array<'live' | 'paper'> }
  | { kind: 'unavailable'; details: string[] }

/** 回包形状不对：与 model-config 同一约定（{ok:false, missing}），界面显示「未接通」，不猜。 */
const shapeError = (field: string): Error => Object.assign(new Error(tr('portfolio.analysis 回包缺少 {0}', field)), { ok: false, missing: field })
/** 份额（0–1 的十进制字符串）→ 百分数文本，BigInt 定点乘 100 再取两位。 */
export const sharePct = (w: string | null): string => (w === null ? DASH : `${fmtMoney(mulStr(w, '100'))}%`)
/** a > b（十进制字符串，BigInt 比较）。 */
const gt = (a: string | null, b: string | null): boolean => toneOf(sumStr([a ?? '0', negStr(b ?? '0') ?? '0'])) === 'up'
/** 每节最多 6 行（前 5 + 「其余 N」合计）：卡在固定高度的列里，不撑高。 */
const TOP = 5
const capRows = (rows: PortfolioRow[], sumShare: boolean, top = TOP): PortfolioRow[] => {
  if (rows.length <= top + 1) return rows
  const rest = rows.slice(top)
  return [...rows.slice(0, top), { key: '__rest', label: tr('其余 {0}', rest.length), amount: sumStr(rest.map((r) => r.amount)), share: sumShare ? sumStr(rest.map((r) => r.share)) : null, ...(sumShare ? {} : { tone: toneOf(sumStr(rest.map((r) => r.amount))) }) }]
}

export function portfolioView(raw: unknown): PortfolioModel {
  if (!isRec(raw)) throw shapeError('scope')
  if (raw.unavailable === true) return { kind: 'unavailable', details: Array.isArray(raw.details) ? raw.details.filter((d): d is string => typeof d === 'string') : [] }
  const scope = raw.scope === 'live' || raw.scope === 'paper' ? raw.scope : null
  if (!scope) throw shapeError('scope')
  for (const f of ['byVenue', 'byStrategy', 'byInstrument']) if (!Array.isArray(raw[f])) throw shapeError(f)
  const scopes = (Array.isArray(raw.scopes) ? raw.scopes : [scope]).filter((x): x is 'live' | 'paper' => x === 'live' || x === 'paper')
  const share = (list: unknown[]): PortfolioRow[] => list.filter(isRec).flatMap((b) => (str(b.key) ? [{ key: str(b.key)!, label: str(b.key)!, amount: dec(b.exposure), share: dec(b.weight) }] : []))
  const byShare = (a: PortfolioRow, b: PortfolioRow) => (gt(a.share, b.share) ? -1 : gt(b.share, a.share) ? 1 : 0)
  const venues = capRows(share(raw.byVenue as unknown[]).sort(byShare), true)
  const instruments = capRows(share(raw.byInstrument as unknown[]).sort(byShare), true)
  const pnl = (raw.byStrategy as unknown[]).filter(isRec).flatMap((b): PortfolioRow[] => {
    const key = str(b.key)
    if (!key) return []
    const total = dec(b.total)
    return [{ key, label: key === 'unassigned' ? tr('未归属') : key, amount: total, share: null, tone: toneOf(total) }]
  })
  // 按盈亏降序，「未归属」置底（超过 6 行时其余合并在「未归属」之前）
  const named = pnl.filter((r) => r.key !== 'unassigned').sort((a, b) => (gt(a.amount, b.amount) ? -1 : gt(b.amount, a.amount) ? 1 : 0))
  const unassigned = pnl.filter((r) => r.key === 'unassigned')
  const strategies = [...capRows(named, false, unassigned.length ? TOP - 1 : TOP), ...unassigned]
  if (!venues.length && !instruments.length && !strategies.length) return { kind: 'empty', scope, scopes }
  return { kind: 'ready', scope, scopes, ccy: str(raw.valuationCcy) ?? '', venues, strategies, instruments, missing: Array.isArray(raw.missing) ? raw.missing.filter((d): d is string => typeof d === 'string') : [] }
}
