// SPDX-License-Identifier: CPAL-1.0
// 风险状态块与状态条的纯逻辑：风控三态、限额使用率、保护器、触发记录、场所健康。
// TODO(protocol): risk.state 的返回形状协议没有定义。这里读内核现有形状 {tradingState, reasons, limits, policy:{protectors, denyLlmLiveEntries}, usage?}；
// usage（单笔 / 日亏 / 总敞口 / 杠杆 / 日笔数的当前值）内核还没给，缺了就用账户快照现算（deriveUsage），仍缺的行只显示上限不画条。
import type { LedgerEntry, Protector, TakeoverLevel, TradingState, VenueStatus } from '@gitrader/protocol/types'
import { PROTECTOR_LABEL, STATE_LABEL, TAKEOVER_DONE, VENUE_NAME } from './labels'
import { ruleText } from './model-activity'
import type { PositionRow, SummaryLite } from './model-positions'
import { arr, isRec, listOf, str, toNum, type Rec } from './util'
import { t } from '@gitrader/workbench/i18n'

const STATES: readonly string[] = ['ACTIVE', 'REDUCING', 'HALTED']

/** Only the editable upper bounds are known here; other changes must retain the PIN flow. */
export function isTighteningLimits(patch: Record<string, unknown>, current: Record<string, unknown>): boolean {
  const r = compareLimits(patch, current)
  return r.ok && r.changed
}

/** 新值不比基线宽（等于也算）：可走 risk.tighten。认不出的键 / 值一律不算。 */
export function isAtOrBelowBase(patch: Record<string, unknown>, base: Record<string, unknown>): boolean {
  return compareLimits(patch, base).ok
}

function compareLimits(patch: Record<string, unknown>, current: Record<string, unknown>): { ok: boolean; changed: boolean } {
  const no = { ok: false, changed: false }
  const allowed = new Set(['maxOrderNotional', 'maxDailyLossRatio', 'maxTotalNotionalRatio', 'maxLeverage', 'maxDailyOrders'])
  const decimal = (value: unknown): [string, string] | null => {
    if (typeof value !== 'string' && typeof value !== 'number') return null
    const text = String(value)
    if (!/^\d+(\.\d+)?$/.test(text) || !/[1-9]/.test(text)) return null
    const [whole = '', fraction = ''] = text.split('.')
    return [whole.replace(/^0+(?=\d)/, ''), fraction.replace(/0+$/, '')]
  }
  let changed = false
  for (const [key, value] of Object.entries(patch)) {
    if (!allowed.has(key)) return no
    const next = decimal(value)
    if (!next) return no
    if ((key === 'maxLeverage' || key === 'maxDailyOrders') && (typeof value !== 'number' || !Number.isSafeInteger(value))) return no
    if (current[key] === undefined) { changed = true; continue } // Adding a bound to an unlimited field tightens it.
    const old = decimal(current[key])
    if (!old) return no
    const size = Math.max(next[1].length, old[1].length)
    const a = next[0] + next[1].padEnd(size, '0')
    const b = old[0] + old[1].padEnd(size, '0')
    const cmp = next[0].length === old[0].length ? (a === b ? 0 : a < b ? -1 : 1) : next[0].length < old[0].length ? -1 : 1
    if (cmp > 0) return no
    if (cmp < 0) changed = true
  }
  return { ok: true, changed }
}
const asState = (v: unknown): TradingState | null => (typeof v === 'string' && STATES.includes(v) ? (v as TradingState) : null)

/** 仅翻译内核自己生成的状态前缀；上游原文与人的原因保持不变。 */
export function stateReasonText(reason: string): string {
  const labels: Record<string, string> = { halt_new: t('停止新开仓'), cancel_all: t('撤销挂单'), flatten_all: t('全部平仓') }
  return reason.replace(/^takeover (halt_new|cancel_all|flatten_all): /, (_all, level: string) => t('{0}：', labels[level]))
    .replace(/^flatten_all completed: /, t('全部平仓完成：')).replace(/^kill switch: /, t('杀开关已锁存：')).replace(/^resume: /, t('恢复交易：'))
}

export interface Usage {
  /** 最近一笔 / 当日最大单笔名义额。 */
  orderNotional?: number | null
  /** 当日亏损占当日起点权益的比例（盈利为 0）。 */
  dailyLossRatio?: number | null
  /** 全部持仓名义 / 权益。 */
  totalNotionalRatio?: number | null
  /** 当前使用的最高杠杆。 */
  leverage?: number | null
  ordersToday?: number | null
}

export interface LimitRow {
  id: 'order' | 'dailyLoss' | 'exposure' | 'leverage' | 'orders'
  label: string
  /** 已用 / 上限（0–1+）；缺使用量或缺上限为 null（只显示数字不画条）。 */
  ratio: number | null
  used: string
  limit: string
  tone: 'flat' | 'warn' | 'down'
}

export interface ProtectorRow { id: string; kind: string; label: string; text: string }
export interface TriggerRow { id: string; ts: number; label: string; text: string; scope?: string }

export interface RiskView {
  state: TradingState
  reasons: string[]
  /** 内核没给状态（没连上 / 还没回）。 */
  known: boolean
  limits: Record<string, unknown>
  protectors: ProtectorRow[]
  denyLlmLiveEntries: boolean
  integrityOk: boolean
  policyVersion: number | null
  usage: Usage
  /** 基线限额（policy.limits，不含临时放宽）；内核没给时退回生效值。收紧 / 放宽按它判断。 */
  baseLimits: Record<string, unknown>
  /** 临时放宽（policy.temporaryRelax，until > now 才算）：到期时刻 + 被放宽的限额字段与放宽后的值；没有 = null。 */
  relax: { until: number; fields: string[]; values: Record<string, unknown> } | null
}

/** 限额行 id → 内核限额字段（临时放宽标记用）。 */
export const LIMIT_FIELD: Record<LimitRow['id'], string> = { order: 'maxOrderNotional', dailyLoss: 'maxDailyLossRatio', exposure: 'maxTotalNotionalRatio', leverage: 'maxLeverage', orders: 'maxOrdersPerDay' }

/** 临时放宽剩余时间文案：「剩 3 小时 20 分」「剩 12 分」「剩不到 1 分」。 */
export function relaxLeftText(until: number, now: number): string {
  const min = Math.floor((until - now) / 60000)
  if (min < 1) return t('剩不到 1 分')
  return min < 60 ? t('剩 {0} 分', min) : t('剩 {0} 小时 {1} 分', Math.floor(min / 60), min % 60)
}

/** 钥匙原始表 → 授权书 id → 钥匙名（吊销的带「（已撤销）」）；风险行 / 状态行用名字，不露授权书编号。 */
export function mandateNames(keysRaw: unknown): Record<string, string> {
  return Object.fromEntries(listOf(keysRaw, 'keys').filter(isRec).flatMap((k) => {
    const id = str(k.mandateId)
    const name = str(k.name)
    return id && name ? [[id, k.status === 'revoked' ? t('{0}（已撤销）', name) : name]] : []
  }))
}

const pct = (v: unknown, d = 0) => { const n = toNum(v); return n === null ? '—' : `${(n * 100).toFixed(d).replace(/\.0+$/, '')}%` }

export function protectorRow(p: Protector, i: number): ProtectorRow {
  const kind = String((p as unknown as Rec).kind)
  const x = p as unknown as Rec
  const text: string = (() => {
    switch (kind) {
      case 'cooldown': return t('开仓后冷却 {0} 秒', x.afterOpenSec)
      case 'stoploss_guard': return t('{0} 分钟内止损 {1} 次，暂停 {2} 分钟', x.windowMin, x.maxStoplosses, x.pauseMin)
      case 'drawdown_pause': return t('{0} 小时回撤达 {1}，暂停 {2} 分钟', x.windowHours, pct(x.maxDrawdownRatio), x.pauseMin)
      case 'low_profit_lock': return t('{0} 小时收益低于 {1}，锁定 {2} 分钟', x.windowHours, pct(x.minProfitRatio), x.lockMin)
      case 'max_consecutive_failures': return t('连续失败 {0} 次，暂停 {1} 分钟', x.count, x.pauseMin)
      case 'plugin': return String(x.pluginId ?? '')
      default: return ''
    }
  })()
  return { id: `${kind}-${i}`, kind, label: PROTECTOR_LABEL[kind] ?? kind, text }
}

export function normalizeRisk(raw: unknown, now: number = Date.now()): RiskView {
  const r = isRec(raw) ? raw : ({} as Rec)
  const state = asState(r.tradingState) ?? asState(r.state)
  const policy = isRec(r.policy) ? r.policy : ({} as Rec)
  const integrity = isRec(r.integrity) ? r.integrity : undefined
  const u = isRec(r.usage) ? r.usage : ({} as Rec)
  const scopes = stateRows(r)
  const mostSevere = scopes.some((x) => x.state === 'HALTED') ? 'HALTED' : scopes.length ? 'REDUCING' : null
  return {
    state: state === 'HALTED' || mostSevere === 'HALTED' ? 'HALTED' : state === 'REDUCING' || mostSevere === 'REDUCING' ? 'REDUCING' : 'ACTIVE',
    known: state !== null || scopes.length > 0,
    reasons: arr(r.reasons).map((x) => (isRec(x) ? str(x.reason) ?? str(x.message) ?? '' : String(x))).filter(Boolean),
    limits: isRec(r.limits) ? r.limits : isRec(policy.limits) ? policy.limits : {},
    baseLimits: isRec(policy.limits) ? policy.limits : isRec(r.limits) ? r.limits : {},
    protectors: arr(policy.protectors).filter(isRec).map((p, i) => protectorRow(p as unknown as Protector, i)),
    // 缺省 = 开启（协议 denyLlmLiveEntries 默认 true）。
    denyLlmLiveEntries: (typeof r.denyLlmLiveEntries === 'boolean' ? r.denyLlmLiveEntries : policy.denyLlmLiveEntries) !== false,
    integrityOk: integrity ? integrity.ok !== false : true,
    policyVersion: toNum(policy.version),
    usage: { orderNotional: toNum(u.orderNotional), dailyLossRatio: toNum(u.dailyLossRatio), totalNotionalRatio: toNum(u.totalNotionalRatio), leverage: toNum(u.leverage), ordersToday: toNum(u.ordersToday) },
    relax: relaxOf(policy.temporaryRelax, now),
  }
}

function relaxOf(v: unknown, now: number): RiskView['relax'] {
  if (!isRec(v)) return null
  const until = toNum(v.until)
  const values = isRec(v.fields) ? v.fields : {}
  return until !== null && until > now ? { until, fields: Object.keys(values), values } : null
}

/** 事件 risk.state 只是"变了"的通知，形状不一，调用方收到后重新查询；这里只取其中的新状态做即时显示。 */
export function stateOfEvent(data: unknown): TradingState | null {
  if (!isRec(data)) return null
  return asState(data.to) ?? asState(data.state) ?? asState(data.tradingState)
}

const ROW_STATE_SEVERITY: Record<'REDUCING' | 'HALTED', number> = { REDUCING: 1, HALTED: 2 }
const rowStateOf = (v: unknown): 'REDUCING' | 'HALTED' | null => (v === 'REDUCING' || v === 'HALTED' ? v : null)
const reasonTextOf = (v: unknown): string => (isRec(v) ? str(v.reason) ?? str(v.message) ?? '' : str(v) ?? '')

/** risk.state / risk.get 里的每个非 ACTIVE 作用域一行（org + 各账户）；同一个作用域有多条原因时取最严的一条。 */
/** 停机行的作用域：全局，或某个账户 / Agent 授权书（Agent 自停默认落在授权书作用域）等带 id 的作用域。 */
export type RowScope = { type: 'org' } | { type: 'account' | 'mandate' | 'group' | 'instrument'; id: string }

export function stateRows(raw: unknown): Array<{ scope: RowScope; label: string; state: 'REDUCING' | 'HALTED'; reason: string }> {
  const r = isRec(raw) ? raw : ({} as Rec)
  // 全局 ACTIVE 不代表账户或授权书 ACTIVE；作用域原因与 sticky 才是各行的依据。
  const aliases = new Map<string, string>()
  for (const a of arr(r.accounts)) {
    if (!isRec(a)) continue
    const id = str(a.accountId) ?? str(a.id)
    const alias = str(a.alias) ?? str(a.name) ?? str(a.label)
    if (id && alias) aliases.set(id, alias)
  }
  const names = isRec(r.mandateNames) ? r.mandateNames : ({} as Rec)
  const rows = new Map<string, { scope: RowScope; label: string; state: 'REDUCING' | 'HALTED'; reason: string }>()
  const add = (scopeRaw: unknown, stateRaw: unknown, reasonRaw: unknown): void => {
    const state = rowStateOf(stateRaw)
    if (!isRec(scopeRaw) || !state) return
    const type = str(scopeRaw.type)
    const id = str(scopeRaw.id)
    let scope: RowScope
    if (type === 'org') scope = { type: 'org' }
    else if ((type === 'account' || type === 'mandate' || type === 'group' || type === 'instrument') && id) scope = { type, id }
    else return
    const scopeAlias = str(scopeRaw.alias) ?? str(scopeRaw.name) ?? str(scopeRaw.label)
    if (scope.type === 'account' && scopeAlias && !aliases.has(scope.id)) aliases.set(scope.id, scopeAlias)
    const key = scope.type === 'org' ? 'org' : `${scope.type}:${scope.id}`
    const label = scope.type === 'org' ? t('全局') : scope.type === 'account' ? t('账户 {0}', aliases.get(scope.id) ?? scope.id.slice(-6)) : scope.type === 'mandate' ? (str(names[scope.id]) ? t('Agent「{0}」', str(names[scope.id])) : t('Agent 授权')) : `${scope.type === 'group' ? t('账户组') : t('标的')} ${scopeAlias ?? scope.id}`
    const reason = reasonTextOf(reasonRaw)
    const prev = rows.get(key)
    if (!prev || ROW_STATE_SEVERITY[state] > ROW_STATE_SEVERITY[prev.state] || (!prev.reason && reason)) rows.set(key, { scope, label, state, reason })
  }
  for (const x of arr(r.reasons)) if (isRec(x)) add(x.scope, x.state, x.reason ?? x.message)
  // 粘性状态（如 Agent 用默认授权书作用域自停）可能不在 reasons 里：一并列出，同作用域按更严重者合并
  for (const x of arr(r.sticky)) if (isRec(x)) add(x.scope, x.state, x.reason)
  if (!rows.size) for (const x of arr(r.pauses)) if (isRec(x)) add(x.scope, 'REDUCING', x.reason)
  return [...rows.values()]
}

/** 内核没给 usage 时，用账户快照现算（按估值币种相加，多币种账户的口径以后由内核给）。 */
export function deriveUsage(input: { summaries: Record<string, SummaryLite | null>; rows: readonly PositionRow[]; orderNotionalMax?: number | null; ordersToday?: number | null }): Usage {
  let equity: number | null = null
  let dayStart: number | null = null
  for (const s of Object.values(input.summaries)) {
    if (!s || s.equity === null) continue
    equity = (equity ?? 0) + s.equity
    if (s.dayStartEquity !== null) dayStart = (dayStart ?? 0) + s.dayStartEquity
  }
  const total = input.rows.reduce((x, r) => x + r.notional, 0)
  const lev = input.rows.reduce((m, r) => Math.max(m, toNum(r.position.leverage) ?? 0), 0)
  return {
    orderNotional: input.orderNotionalMax ?? null,
    dailyLossRatio: equity !== null && dayStart !== null && dayStart > 0 ? Math.max(0, (dayStart - equity) / dayStart) : null,
    totalNotionalRatio: equity !== null && equity > 0 ? total / equity : null,
    leverage: input.rows.length ? lev : null,
    ordersToday: input.ordersToday ?? null,
  }
}

/** 限额语气（视觉轮 r4，工单裁决 4）：≥ 85% 临界（warn）、≥ 100% 超限（down）——数字与细条同源（C5）。 */
export const toneOf = (ratio: number | null): LimitRow['tone'] => (ratio === null ? 'flat' : ratio >= 1 ? 'down' : ratio >= 0.85 ? 'warn' : 'flat')
const nfi = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 })
const money = (n: number) => nfi.format(n)

/** 五条限额使用率：单笔 / 日亏 / 总敞口 / 杠杆 / 日笔数。上限缺（没设）的行不出。 */
export function limitRows(limits: Rec, usage: Usage): LimitRow[] {
  const rows: LimitRow[] = []
  const row = (id: LimitRow['id'], label: string, used: number | null | undefined, limit: number | null, fmtUsed: (n: number) => string, fmtLimit: (n: number) => string, scale = 1): void => {
    if (limit === null) return
    const ratio = used == null || limit <= 0 ? null : (used * scale) / limit
    rows.push({ id, label, ratio, used: used == null ? '—' : fmtUsed(used), limit: fmtLimit(limit), tone: toneOf(ratio) })
  }
  row('order', t('单笔'), usage.orderNotional, toNum(limits.maxOrderNotional), money, money)
  row('dailyLoss', t('日亏'), usage.dailyLossRatio, toNum(limits.maxDailyLossRatio), (n) => pct(n, 1), (n) => pct(n, 1))
  row('exposure', t('总敞口'), usage.totalNotionalRatio, toNum(limits.maxTotalNotionalRatio), (n) => `${n.toFixed(2)}×`, (n) => `${n.toFixed(2)}×`)
  row('leverage', t('杠杆'), usage.leverage, toNum(limits.maxLeverage), (n) => `${n}×`, (n) => `${n}×`)
  // TODO(protocol)：RiskLimits 没有"日笔数"上限（只有每分钟笔数与日成交额）。内核补 maxOrdersPerDay 后这一行才会出现。
  row('orders', t('日笔数'), usage.ordersToday, toNum(limits.maxOrdersPerDay), (n) => String(n), (n) => String(n))
  return rows
}

// ---- 接管结果（IXD F3-1 · G3：读 TakeoverRecord.ok / remaining / stateAfter，不以「没抛错」当成功）----------------

export interface Leftover { instrumentId: string; size: string; accountId?: string }
export type TakeoverOutcome = { ok: true; text: string } | { ok: false; remaining: Leftover[] }

/** 内核的 TakeoverRecord → 成功回声（带数字）或「没平完」（剩余标的）。认不出的形状按成功处理：内核没说失败，界面不替它编。 */
export function takeoverOutcome(level: TakeoverLevel, record: unknown): TakeoverOutcome {
  const r = isRec(record) ? record : ({} as Rec)
  const remaining = arr(r.remaining).filter(isRec).flatMap((x) => (str(x.instrumentId) ? [{ instrumentId: str(x.instrumentId) as string, size: String(x.size ?? ''), ...(str(x.accountId) ? { accountId: str(x.accountId) as string } : {}) }] : []))
  if (r.ok === false) return { ok: false, remaining }
  const n = toNum(r.cancelled)
  const kept = toNum(r.keptProtective)
  const keptText = level === 'cancel_all' && n !== null && r.keptProtective !== undefined ? (kept !== null && kept > 0 ? t('已撤 {0} 张，保留止损 {1} 张', n, kept) : t('已撤 {0} 张', n)) : null
  const text = keptText ?? (level === 'cancel_all' && n !== null ? t('已撤销 {0} 笔挂单 · 保留止盈止损', n) : level === 'flatten_all' && r.stateAfter !== undefined && r.stateAfter !== 'HALTED' ? t('已全部平仓') : TAKEOVER_DONE[level])
  return { ok: true, text }
}

/** 账本里的接管条目 → 常驻「没平完」条的增减（别的入口——命令面板、Agent——发起的接管也要落到风险块）。null = 与此无关。 */
export function leftoverOfEntry(e: { type?: unknown; payload?: unknown }): Leftover[] | 'clear' | null {
  const p = isRec(e.payload) ? e.payload : ({} as Rec)
  if (e.type === 'takeover.failed') { const l = takeoverOutcome('flatten_all', { ok: false, remaining: p.remaining }); return !l.ok && l.remaining.length ? l.remaining : null }
  if (e.type === 'takeover.completed' && p.level === 'flatten_all') return 'clear'
  return null
}

/** 保护器触发记录（账本 protector.triggered）。 */
export function triggerRows(entries: readonly LedgerEntry[]): TriggerRow[] {
  return entries.filter((e) => e.type === 'protector.triggered').sort((a, b) => b.seq - a.seq).map((e) => {
    const p = isRec(e.payload) ? e.payload : ({} as Rec)
    const kind = str(p.protector) ?? ''
    const scope = isRec(p.scope) ? str(p.scope.id) ?? str(p.scope.type) : undefined
    const hit = arr(e.ruleHits).filter(isRec)[0]
    return { id: e.id, ts: e.ts, label: PROTECTOR_LABEL[kind] ?? (kind || t('保护器')), text: hit ? ruleText(hit as never) : '', ...(scope ? { scope } : {}) }
  })
}

// ---- 总览条：实盘 / 纸面分开（IA §2.1：真钱与模拟钱不相加）--------------------------------------

export interface ModeTotal { equity: number | null; /** 今日 = 权益 − 日初权益（缺日初时用 dayPnl）。 */ today: number | null; /** 今日百分比，以日初为底（+1.04 = +1.04%）。 */ pct: number | null; accounts: number }
export interface ModeTotals { live: ModeTotal | null; paper: ModeTotal | null; /** 主数：有实盘账户 = live，只有纸面 = paper，一个账户都没有 = null。 */ main: 'live' | 'paper' | null }

/**
 * 按账户 mode 分别求权益与今日盈亏：实盘只认 mode === 'live'，纸面只认 'paper'；shadow（及其他认不出的）两栏都不进——模拟的钱不能混进实盘权益（审稿 B-1，红线 8）。
 * 没有该类账户时为 null。
 */
export function totalsByMode(accounts: ReadonlyArray<{ accountId: string; mode: string }>, summaries: Record<string, SummaryLite | null>): ModeTotals {
  const sum = (mode: 'live' | 'paper'): ModeTotal | null => {
    const list = accounts.filter((a) => a.mode === mode)
    if (!list.length) return null
    let equity: number | null = null
    let today: number | null = null
    let base: number | null = null
    for (const a of list) {
      const s = summaries[a.accountId]
      if (!s || s.equity === null) continue
      equity = (equity ?? 0) + s.equity
      const day = s.dayStartEquity !== null ? s.equity - s.dayStartEquity : s.dayPnl
      if (day !== null) { today = (today ?? 0) + day; base = (base ?? 0) + (s.equity - day) }
    }
    return { equity, today, pct: today !== null && base !== null && base > 0 ? (today / base) * 100 : null, accounts: list.length }
  }
  const live = sum('live')
  const paper = sum('paper')
  return { live, paper, main: live ? 'live' : paper ? 'paper' : null }
}

// ---- 状态条 ---------------------------------------------------------------------------

export type WsTone = 'ok' | 'pending' | 'err' | 'unknown'
export interface VenueHealth {
  id: string
  name: string
  environment: 'mainnet' | 'testnet' | null
  ws: WsTone
  wsText: string
  p50: number | null
  p95: number | null
  used: number | null
  limit: number | null
  windowMs: number | null
  /** 剩余预算 0–100；缺预算为 null。 */
  leftPct: number | null
  isSim: boolean
  unverified: boolean
}

const WS_TEXT: Record<string, [WsTone, string]> = { connected: ['ok', t('已连接')], connecting: ['pending', t('连接中')], disconnected: ['err', t('已断开')] }

type Conn = 'connected' | 'connecting' | 'disconnected'
const CONN_RANK: Record<Conn, number> = { disconnected: 0, connecting: 1, connected: 2 }
/**
 * UX-10（ux-fix2 补全）：连接态取 connection 与 wsState 里更差的那个。内核的 connection 在没有后台连接登记时缺省成 connected，
 * 连接器的 wsState 却已断开；顶栏另有 venue.status 事件（只带 wsState），设置页只读快照——两边各取一个字段就会一红一绿。
 */
export function connOf(v: Rec): Conn | null {
  const xs = [v.connection, v.wsState].filter((s): s is Conn => typeof s === 'string' && s in CONN_RANK)
  return xs.length ? xs.reduce((m, s) => (CONN_RANK[s] < CONN_RANK[m] ? s : m)) : null
}

export function normalizeVenues(raw: unknown): VenueHealth[] {
  return listOf(raw, 'venues').filter(isRec).flatMap((v) => {
    const id = str(v.venue) ?? str(v.id)
    if (!id) return []
    const s = v as unknown as Partial<VenueStatus> & Rec
    // UX-10：与设置 · 交易所的表格同一个取值规则（connOf：connection 与 wsState 取更差的）；都没有才「未知」
    const c = connOf(v)
    const [ws, wsText]: [WsTone, string] = c ? WS_TEXT[c]! : ['unknown', t('未知')]
    const bud = isRec(s.rateBudget) ? s.rateBudget : undefined
    const used = toNum(bud?.used)
    const limit = toNum(bud?.limit)
    const lat = isRec(s.latencyMs) ? s.latencyMs : undefined
    const env = s.environment === 'mainnet' || s.environment === 'testnet' ? s.environment : null
    return [{
      id, name: VENUE_NAME[id] ?? id, environment: env, ws, wsText,
      p50: toNum(lat?.p50), p95: toNum(lat?.p95), used, limit, windowMs: toNum(bud?.windowMs),
      leftPct: used !== null && limit !== null && limit > 0 ? Math.max(0, Math.min(100, (1 - used / limit) * 100)) : null,
      isSim: id === 'kernel-sim',
      unverified: v.unverified === true,
    }]
  })
}

export interface StatusView {
  /** 主场所（第一个非模拟场所；只有模拟场所时为它）。 */
  primary: VenueHealth | null
  /** 网络：主网 / 测试网；只连了模拟场所时为"纸面"。 */
  network: string
  networkTone: WsTone
  latency: number | null
  budgetLeft: number | null
  state: TradingState | null
  stateLabel: string
  online: boolean
}

/** 速率预算告警档：< 10% low（红 + ⊘ 形状）、< 25% warn。 */
export function budgetLevel(leftPct: number | null): 'low' | 'warn' | null {
  return leftPct === null ? null : leftPct < 10 ? 'low' : leftPct < 25 ? 'warn' : null
}

export function buildStatus(venues: readonly VenueHealth[], state: TradingState | null, online: boolean): StatusView {
  const primary = venues.find((v) => !v.isSim) ?? venues[0] ?? null
  // 内核在、没有场所 = 「场所未连接」；内核断开另由状态条写「内核未连接」（IXD F8-1：两件事分开说）
  const network = !primary ? t('场所未连接') : primary.isSim ? t('纸面') : primary.environment === 'mainnet' ? t('主网') : primary.environment === 'testnet' ? t('测试网') : primary.name
  return {
    primary, network, networkTone: !online ? 'err' : primary?.ws ?? 'unknown',
    latency: primary?.p50 ?? null, budgetLeft: primary?.leftPct ?? null,
    state, stateLabel: state ? STATE_LABEL[state] : '—', online,
  }
}
