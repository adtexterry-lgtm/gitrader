// SPDX-License-Identifier: CPAL-1.0
// 策略页（P6）的纯逻辑：把 engine.strategies / engine.list / lab.list / ledger.query 的回包规整成视图数据。无 DOM，vitest 直接测。
// 内核不可用的引擎只落在它自己那一行，不伪造策略或账户身份；回包缺字段 = 对应格子标「未接通」，不猜。
import { arr, fmtLoose, isRec, listOf, str, toNum, type Rec } from '../../blocks-default/src/util'
import { VENUE_NAME } from '../../blocks-default/src/labels'
import { normalizeAccounts, type AccountLite } from '../../blocks-default/src/model-positions'
import { getLang, t as tr, tk } from '@gitrader/workbench/i18n'

export { normalizeAccounts, type AccountLite }

export const STATE_TEXT = { running: tr('运行'), stopped: tr('已停'), error: tr('出错'), starting: tr('启动中') } as const
export type StrategyState = keyof typeof STATE_TEXT
export type FilterId = 'all' | 'running' | 'stopped' | 'error' | 'catalog'
/** 前四个按实例状态筛；「可用」是引擎已加载的策略目录（engine.catalog），计数由视图单独算。 */
export const FILTERS: ReadonlyArray<{ id: FilterId; label: string }> = [
  { id: 'all', label: tr('全部') }, { id: 'running', label: tr('运行') }, { id: 'stopped', label: tr('已停') }, { id: 'error', label: tr('出错') }, { id: 'catalog', label: tr('可用') },
]

/** 实验阶段名（协议 EXPERIMENT_STAGE_ORDER；draft / paper 是旧别名）。认不出的阶段原样显示。 */
const STAGE_TEXT: Record<string, string> = {
  hypothesis: tr('假设'), backtest: tr('回测'), holdout: tr('保留期'), shadow: tr('影子'), live_small: tr('小额实盘'), live: tr('实盘'), draft: tr('假设'), paper: tr('影子'),
}
export const stageLabel = (stage: string): string => STAGE_TEXT[stage] ?? stage

/** 场所显示名：先查默认块的表，再退到首字母大写。 */
export const venueLabel = (venue: string): string => VENUE_NAME[venue] ?? (venue ? venue.charAt(0).toUpperCase() + venue.slice(1) : '')

export type ParamValue = number | boolean | string
export interface AccountView { accountId: string; alias: string; mode: 'live' | 'paper' | 'other'; modeText: string; venue: string; venueLabel: string }
export interface StrategyRow {
  key: string
  engineId: string
  instanceId: string
  strategyId: string
  version: string
  accountId: string
  state: StrategyState
  params: Record<string, ParamValue>
  problem: { name: string | null; message: string } | null
  lastFillTs: number | null
  experimentId: string | null
  /** 实验阶段名；lab.list 读不到或没有这个实验时为 null。 */
  stage: string | null
  /** 账户别名 / 模式；account.list 里找不到 = null（不伪造）。 */
  account: AccountView | null
  /** 内核日后在 engine.strategies 里补上 instruments / interval 就有值；没有时「启动」表单让用户填。 */
  instruments: string[]
  interval: string | null
}
export interface FailureRow { key: string; engineId: string; name: string | null; message: string }
export interface StrategiesModel { rows: StrategyRow[]; failures: FailureRow[]; fail: string | null }

const isState = (v: unknown): v is StrategyState => v === 'running' || v === 'stopped' || v === 'error' || v === 'starting'
const paramsOf = (v: unknown): Record<string, ParamValue> => {
  const out: Record<string, ParamValue> = {}
  if (!isRec(v)) return out
  for (const [k, x] of Object.entries(v)) if (typeof x === 'number' || typeof x === 'boolean' || typeof x === 'string') out[k] = x
  return out
}
const problemOf = (v: unknown): { name: string | null; message: string } | null => {
  if (!isRec(v)) return null
  const message = str(v.message)
  return message ? { name: str(v.name) ?? null, message } : null
}

export function accountView(a: AccountLite | undefined): AccountView | null {
  if (!a) return null
  const mode = a.mode === 'live' ? 'live' : a.mode === 'paper' ? 'paper' : 'other'
  return { accountId: a.accountId, alias: a.alias, mode, modeText: mode === 'live' ? tr('实盘') : mode === 'paper' ? tr('纸面') : a.mode === 'shadow' ? tr('影子') : a.mode, venue: a.venue, venueLabel: venueLabel(a.venue) }
}

/** lab.list → 实验号 → 阶段。 */
export function normalizeExperiments(raw: unknown): Map<string, string> {
  const out = new Map<string, string>()
  for (const e of listOf(raw, 'items').filter(isRec)) {
    const id = str(e.experimentId)
    const stage = str(e.stage)
    if (id && stage) out.set(id, stage)
  }
  return out
}

/** 回包是 {ok:false, error} 时取内核原文（没有 message 就给 name / 方法名占位，不改写）；正常回包返回 null。 */
export function readFail(raw: unknown): string | null {
  if (!isRec(raw) || raw.ok !== false) return null
  const err = isRec(raw.error) ? raw.error : raw
  return str(err.message) ?? str(err.name) ?? 'ok:false'
}

/** engine.strategies → 行。整个查询回 {ok:false,error} 时 fail 带内核原文；不可用的引擎进 failures，各占一行。 */
export function normalizeStrategies(raw: unknown, accounts: readonly AccountLite[] = [], stages: ReadonlyMap<string, string> = new Map()): StrategiesModel {
  const byAccount = new Map(accounts.map((a) => [a.accountId, a]))
  const rows: StrategyRow[] = []
  const failures: FailureRow[] = []
  const fail = readFail(raw)
  if (fail) return { rows, failures, fail }
  if (!Array.isArray(raw)) return { rows, failures, fail: raw == null ? null : 'engine.strategies' }
  for (const item of raw) {
    if (!isRec(item)) continue
    const engineId = str(item.engineId)
    if (!engineId) continue
    if (item.unavailable === true) {
      const p = problemOf(item.problem)
      failures.push({ key: `${engineId}:unavailable`, engineId, name: p?.name ?? null, message: p?.message ?? '' })
      continue
    }
    const instanceId = str(item.instanceId)
    const strategyId = str(item.strategyId)
    const accountId = str(item.accountId)
    if (!instanceId || !strategyId || !accountId || !isState(item.state)) continue
    const experimentId = str(item.experimentId) ?? null
    rows.push({
      key: `${engineId}:${instanceId}`, engineId, instanceId, strategyId, version: str(item.version) ?? '', accountId, state: item.state,
      params: paramsOf(item.params), problem: problemOf(item.problem), lastFillTs: toNum(item.lastFillTs),
      experimentId, stage: experimentId ? (stages.get(experimentId) ?? null) : null, account: accountView(byAccount.get(accountId)),
      instruments: arr(item.instruments).filter((x): x is string => typeof x === 'string'), interval: str(item.interval) ?? null,
    })
  }
  return { rows, failures, fail: null }
}

export const filterRows = (rows: readonly StrategyRow[], f: FilterId): StrategyRow[] => (f === 'all' || f === 'catalog' ? [...rows] : rows.filter((r) => r.state === f))
export function filterCounts(rows: readonly StrategyRow[]): Record<Exclude<FilterId, 'catalog'>, number> {
  return { all: rows.length, running: rows.filter((r) => r.state === 'running').length, stopped: rows.filter((r) => r.state === 'stopped').length, error: rows.filter((r) => r.state === 'error').length }
}

// ---- 可用策略目录（engine.catalog）--------------------------------------------------------

/** engine.catalog 每个参数（内核已把 JSON Schema 映射好；x-hidden 的已丢掉）。 */
export interface ParamField { key: string; label: string; type: 'number' | 'integer' | 'boolean' | 'select' | 'text'; default: number | boolean | string | null; min?: number; max?: number; step?: number; options?: string[]; help?: string }
export interface CatalogEntry { key: string; engineId: string; id: string; name: string; version: string; desc: string; params: ParamField[] }
const PARAM_TYPES = new Set(['number', 'integer', 'boolean', 'select', 'text'])
function fieldOf(v: unknown): ParamField | null {
  if (!isRec(v) || !str(v.key) || !PARAM_TYPES.has(String(v.type))) return null
  const def = v.default
  const out: ParamField = { key: str(v.key)!, label: tk(str(v.label) ?? str(v.key)!), type: v.type as ParamField['type'], default: typeof def === 'number' || typeof def === 'boolean' || typeof def === 'string' ? def : null }
  for (const k of ['min', 'max', 'step'] as const) if (typeof v[k] === 'number' && Number.isFinite(v[k])) out[k] = v[k] as number
  if (Array.isArray(v.options)) out.options = v.options.filter((o): o is string => typeof o === 'string')
  if (str(v.help)) out.help = tk(str(v.help)!)
  return out
}

/** engine.catalog → 目录行。整体 {ok:false} 或形状不对 = fail（视图显示原文 / 未接通），不猜；不可用的引擎各占一行失败。 */
export function normalizeCatalog(raw: unknown): { entries: CatalogEntry[]; failures: FailureRow[]; fail: string | null } {
  const entries: CatalogEntry[] = []
  const failures: FailureRow[] = []
  const fail = readFail(raw)
  if (fail) return { entries, failures, fail }
  if (!Array.isArray(raw)) return { entries, failures, fail: raw == null ? null : 'engine.catalog' }
  for (const item of raw) {
    if (!isRec(item) || !str(item.engineId)) continue
    const engineId = str(item.engineId)!
    if (item.unavailable === true) {
      const p = problemOf(item.problem)
      failures.push({ key: `${engineId}:unavailable`, engineId, name: p?.name ?? null, message: p?.message ?? '' })
      continue
    }
    for (const s of arr(item.strategies).filter(isRec)) {
      const id = str(s.id)
      if (!id) continue
      // UX-37：英文界面先取英文名（示例策略同时带 name / nameZh）；简介经词表翻译
      entries.push({
        key: `${engineId}:${id}`, engineId, id, name: tk((getLang() === 'en' ? str(s.name) ?? str(s.nameZh) : str(s.nameZh) ?? str(s.name)) ?? id), version: str(s.version) ?? '', desc: tk(str(s.desc) ?? ''),
        params: arr(s.params).map(fieldOf).filter((f): f is ParamField => f !== null),
      })
    }
  }
  return { entries, failures, fail: null }
}

/** 表单初值：默认值转文本（布尔 → 'true' / 'false'，没有默认 = 空）。 */
export const paramSeed = (fields: readonly ParamField[]): Record<string, string> =>
  Object.fromEntries(fields.map((f) => [f.key, f.default === null ? '' : String(f.default)]))

/** 跨字段规则（显式列出，不按名字猜）：两者都 > 0 时 hi 必须大于 lo。 */
export const CROSS_RULES: ReadonlyArray<{ lo: string; hi: string }> = [{ lo: 'lowerPrice', hi: 'upperPrice' }]
const DECIMAL_TEXT = /^(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$/
const rangeText = (f: ParamField): string => (f.min !== undefined && f.max !== undefined ? tr('在 {0}–{1} 之间', f.min, f.max) : f.min !== undefined ? tr('不小于 {0}', f.min) : tr('不大于 {0}', f.max))

/** 启动前校验：报错一律点名字段；返回的 params 只含 schema 里有的键（text 空串 = 不传）。 */
export function readParams(fields: readonly ParamField[], texts: Record<string, string>): { ok: true; params: Record<string, ParamValue> } | { ok: false; key: string; message: string } {
  const params: Record<string, ParamValue> = {}
  for (const f of fields) {
    const t = (texts[f.key] ?? '').trim()
    if (f.type === 'number' || f.type === 'integer') {
      const n = t === '' ? Number.NaN : Number(t)
      if (!Number.isFinite(n)) return { ok: false, key: f.key, message: tr('{0} 需要数字', f.key) }
      if (f.type === 'integer' && !Number.isInteger(n)) return { ok: false, key: f.key, message: tr('{0} 需要整数', f.key) }
      if ((f.min !== undefined && n < f.min) || (f.max !== undefined && n > f.max)) return { ok: false, key: f.key, message: tr('{0} 必须{1}', f.key, rangeText(f)) }
      params[f.key] = n
    } else if (f.type === 'boolean') {
      if (t !== 'true' && t !== 'false') return { ok: false, key: f.key, message: tr('{0} 只能填 true 或 false', f.key) }
      params[f.key] = t === 'true'
    } else if (f.type === 'select') {
      if (!(f.options ?? []).includes(t)) return { ok: false, key: f.key, message: tr('{0} 只能是 {1}', f.key, (f.options ?? []).join(' / ')) }
      params[f.key] = t
    } else if (t !== '') {
      if (!DECIMAL_TEXT.test(t) || Number(t) <= 0) return { ok: false, key: f.key, message: tr('{0} 需要正数', f.key) }
      params[f.key] = t
    }
  }
  for (const r of CROSS_RULES) {
    const lo = params[r.lo]
    const hi = params[r.hi]
    if (typeof lo === 'number' && typeof hi === 'number' && lo > 0 && hi > 0 && !(hi > lo)) return { ok: false, key: r.hi, message: tr('{0} 必须大于 {1}', r.hi, r.lo) }
  }
  return { ok: true, params }
}

/** 从目录起一个新实例：不带 instanceId（引擎自己生成），授权书由内核按绑定补。 */
export const startNewCmd = (e: Pick<CatalogEntry, 'engineId' | 'id'>, pick: { accountId: string; instruments: readonly string[]; interval: string }, params: Record<string, ParamValue>): Cmd => ({
  action: 'engine.call',
  params: { id: e.engineId, method: 'strategy.start', params: { strategyId: e.id, accountId: pick.accountId, instruments: [...pick.instruments], interval: pick.interval, params } },
})

/** 启动表单「账户」菜单：已绑定到该引擎的纸面账户（实盘起策略走提案，不在这里）。 */
export function startAccounts(engine: Pick<EngineRow, 'boundIds' | 'bindings'> | undefined, accounts: readonly AccountLite[]): AccountLite[] {
  if (!engine) return []
  const bound = new Set(engine.bindings ? engine.bindings.map((b) => b.accountId) : engine.boundIds)
  return accounts.filter((a) => a.mode === 'paper' && bound.has(a.accountId))
}

// ---- 时间 -----------------------------------------------------------------------------

const pad = (n: number) => String(n).padStart(2, '0')
const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
/** 「3 分钟前 / 2 小时前 / 5 天前」；一周以上给 MM-DD。 */
export function relTime(ts: number, now: number): string {
  const d = now - ts
  if (!(d > 45_000)) return tr('刚刚')
  const m = Math.floor(d / 60_000)
  if (m < 60) return tr('{0} 分钟前', Math.max(m, 1))
  const h = Math.floor(d / 3_600_000)
  if (h < 24) return tr('{0} 小时前', h)
  const days = Math.floor(d / 86_400_000)
  if (days < 7) return tr('{0} 天前', days)
  const t = new Date(ts)
  return `${pad(t.getMonth() + 1)}-${pad(t.getDate())}`
}
/** 事件时间：当天 HH:MM:SS，其余 MM-DD HH:mm。 */
export function clockText(ts: number, now: number): string {
  const t = new Date(ts)
  return sameDay(t, new Date(now)) ? `${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}` : `${pad(t.getMonth() + 1)}-${pad(t.getDate())} ${pad(t.getHours())}:${pad(t.getMinutes())}`
}

/** 「近况」两行：第一行最近成交（相对时间）或错误名，第二行（红）错误原文。 */
export function recentOf(r: StrategyRow, now: number): { l1: string; bad: string | null } {
  const fill = r.lastFillTs === null ? tr('暂无成交') : tr('最近成交 {0}', relTime(r.lastFillTs, now))
  if (r.state === 'error' && r.problem) return { l1: r.problem.name ?? fill, bad: r.problem.message }
  return { l1: fill, bad: null }
}

// ---- 行内动作 -------------------------------------------------------------------------

export type RowAction =
  | { kind: 'stop' }
  | { kind: 'start'; wired: boolean; reason: string }
  | { kind: 'promote'; href: string | null }
  | { kind: 'none' }

/** 运行中 / 出错 / 启动中 = 停止；已停的纸面行 = 启动（表单填标的 / 周期）；已停的实盘行没有「启动」，换「去晋级」→ 实验页。 */
export function rowAction(r: StrategyRow): RowAction {
  if (r.state !== 'stopped') return { kind: 'stop' }
  if (r.account?.mode === 'live') return { kind: 'promote', href: r.experimentId ? `#/lab/${r.experimentId}` : null }
  if (r.account?.mode === 'paper' || r.account?.mode === 'other') {
    const wired = r.instruments.length > 0
    return { kind: 'start', wired, reason: wired ? '' : tr('engine.strategies 缺 instruments / interval') }
  }
  return { kind: 'none' }
}

export const stopStrategyText = (r: StrategyRow): string => tr('停止 {0}：不会自动平仓，持仓与挂单保留', r.strategyId)

export interface Cmd { action: string; params: Rec }
export const stopStrategyCmd = (r: StrategyRow): Cmd => ({ action: 'engine.call', params: { id: r.engineId, method: 'strategy.stop', params: { instanceId: r.instanceId } } })
/** 启动表单选的标的 / 周期；不给就用行里已有的（内核将来在 engine.strategies 里补上的值）。 */
export interface StartPick { instruments: readonly string[]; interval: string }
export const startStrategyCmd = (r: StrategyRow, pick?: StartPick): Cmd => {
  const instruments = pick ? [...pick.instruments] : r.instruments
  const interval = pick ? pick.interval : r.interval
  return {
    action: 'engine.call',
    params: { id: r.engineId, method: 'strategy.start', params: { strategyId: r.strategyId, instanceId: r.instanceId, accountId: r.accountId, instruments, ...(interval ? { interval } : {}), params: r.params } },
  }
}

// ---- 启动表单 -------------------------------------------------------------------------

export const INTERVAL_OPTIONS = ['1m', '5m', '15m', '1h', '4h', '1d'] as const
export type StartInterval = (typeof INTERVAL_OPTIONS)[number]
export const DEFAULT_START_INTERVAL: StartInterval = '15m'
export const isStartInterval = (v: unknown): v is StartInterval => typeof v === 'string' && (INTERVAL_OPTIONS as readonly string[]).includes(v)

/** 行里已有 instruments / interval 就预填，否则空标的 + 15m。 */
export const startFormSeed = (r: StrategyRow): { text: string; interval: StartInterval } => ({ text: r.instruments.join(', '), interval: isStartInterval(r.interval) ? r.interval : DEFAULT_START_INTERVAL })

/** 标的文本框：逗号分隔，每项必须是 `<场所>:<符号>`。 */
export function parseInstruments(text: string): { ok: true; instruments: string[] } | { ok: false; message: string } {
  const items = text.split(',').map((s) => s.trim()).filter(Boolean)
  if (!items.length) return { ok: false, message: tr('请填写标的') }
  for (const it of items) if (!/^[^:\s]+:[^:\s]+$/.test(it)) return { ok: false, message: tr('{0} 应写成 <场所>:<符号>', it) }
  return { ok: true, instruments: [...new Set(items)] }
}

/** 提交前校验：标的必填且格式对；周期认不出就退回 15m。 */
export function readStartForm(text: string, interval: string): { ok: true; pick: { instruments: string[]; interval: StartInterval } } | { ok: false; message: string } {
  const parsed = parseInstruments(text)
  if (!parsed.ok) return parsed
  return { ok: true, pick: { instruments: parsed.instruments, interval: isStartInterval(interval) ? interval : DEFAULT_START_INTERVAL } }
}

export const updateParamsCmd = (r: StrategyRow, params: Record<string, ParamValue>): Cmd => ({ action: 'engine.call', params: { id: r.engineId, method: 'strategy.update', params: { instanceId: r.instanceId, params } } })
export const stopEngineCmd = (id: string): Cmd => ({ action: 'engine.stop', params: { id } })
export const startEngineCmd = (id: string): Cmd => ({ action: 'engine.start', params: { id } })
/** engine.bind 的账户项：纸面账户给账户号（内核用这次的 PIN 签 L1 授权书），实盘账户给 {accountId, mandateId}。 */
export type BindAccount = string | { accountId: string; mandateId: string }
export const bindCmd = (id: string, accounts: readonly BindAccount[]): Cmd => ({ action: 'engine.bind', params: { id, accounts: [...accounts] } })

// ---- 参数 -----------------------------------------------------------------------------

export function paramEntries(params: Record<string, ParamValue>): Array<{ key: string; text: string }> {
  return Object.entries(params).map(([key, v]) => ({ key, text: typeof v === 'boolean' ? (v ? tr('开') : tr('关')) : typeof v === 'number' ? fmtLoose(v) : v }))
}
/** 编辑框里的初始文字（原值，不加千分位）。 */
export const editText = (v: ParamValue): string => String(v)

export type ParamEdit = { ok: true; changed: Record<string, ParamValue> } | { ok: false; key: string; message: string }
/** 把编辑框文字按原值类型还原：数字要能解析，布尔只认 true / false；只返回改动过的键。 */
export function parseParamEdit(original: Record<string, ParamValue>, texts: Record<string, string>): ParamEdit {
  const changed: Record<string, ParamValue> = {}
  for (const [key, was] of Object.entries(original)) {
    const text = (texts[key] ?? editText(was)).trim()
    if (text === editText(was)) continue
    if (typeof was === 'number') {
      const n = text === '' ? Number.NaN : Number(text)
      if (!Number.isFinite(n)) return { ok: false, key, message: tr('{0} 需要数字', key) }
      changed[key] = n
    } else if (typeof was === 'boolean') {
      if (text !== 'true' && text !== 'false') return { ok: false, key, message: tr('{0} 只能填 true 或 false', key) }
      changed[key] = text === 'true'
    } else changed[key] = text
  }
  return { ok: true, changed }
}

// ---- 引擎 -----------------------------------------------------------------------------

export type EngineTone = 'ok' | 'dim' | 'bad' | 'warn'
/** engine.list 每项的绑定（含账户模式与授权书号）。 */
export interface BindingRef { accountId: string; mode: string; mandateId?: string }
export interface EngineRow {
  id: string
  state: string
  stateText: string
  tone: EngineTone
  version: string | null
  /** 能停止（就绪 / 降级 / 启动中）；否则给「启动」。停止中两个都禁用。 */
  canStop: boolean
  busy: boolean
  bound: string[]
  boundIds: string[]
  /** engine.list 每项的 bindings；老内核没有这个字段 = null（网页绑定保持原来的事实行）。 */
  bindings: BindingRef[] | null
  /** 最近心跳（毫秒）；内核没给 = null。 */
  lastHeartbeatAt: number | null
  strategies: number
  running: number
  errors: number
  detail: string | null
  since: number | null
}
const ENGINE_TEXT: Record<string, [string, EngineTone]> = {
  ready: [tr('就绪'), 'ok'], starting: [tr('启动中'), 'dim'], degraded: [tr('降级'), 'warn'], stopping: [tr('停止中'), 'dim'], stopped: [getLang() === 'en' ? 'Stopped' : tr('已停止'), 'dim'], failed: [tr('失败'), 'bad'],
}
export const healthText = (to: string): string => (to === 'lost' ? tr('失联') : to === 'ready' ? tr('已就绪') : ENGINE_TEXT[to]?.[0] ?? to)

/** engine.list 每项的 bindings（老内核没有就是 null）；只认带账户号的条目。 */
function bindingsOf(e: Rec, gep: Rec | null): BindingRef[] | null {
  const raw = Array.isArray(e.bindings) ? e.bindings : gep && Array.isArray(gep.bindings) ? gep.bindings : null
  if (!raw) return null
  return raw.filter(isRec).flatMap((b) => {
    const accountId = str(b.accountId)
    if (!accountId) return []
    const mode = str(b.mode) ?? ''
    const mandateId = str(b.mandateId)
    return [{ accountId, mode, ...(mandateId ? { mandateId } : {}) }]
  })
}

/** 心跳格：「N 秒前 / N 分钟前」；内核没给时间 = 「—」（不写未接通）。 */
export const HEARTBEAT_STALE_MS = 60_000
export function heartbeatAge(ts: number | null, now: number): { text: string; stale: boolean } {
  if (ts === null) return { text: '—', stale: false }
  const sec = Math.max(0, Math.floor((now - ts) / 1000))
  if (sec < 60) return { text: tr('{0} 秒前', sec), stale: false }
  return { text: tr('{0} 分钟前', Math.floor(sec / 60)), stale: sec * 1000 > HEARTBEAT_STALE_MS }
}

export function normalizeEngines(raw: unknown, strategies: readonly StrategyRow[] = [], accounts: readonly AccountLite[] = []): EngineRow[] {
  const alias = new Map(accounts.map((a) => [a.accountId, a.alias]))
  return listOf(raw, 'engines').filter(isRec).flatMap((e) => {
    const id = str(e.id)
    if (!id) return []
    const gep = isRec(e.gep) ? e.gep : null
    const state = str(e.state) ?? 'stopped'
    const lost = gep?.lost === true
    const [text, tone] = lost ? ([tr('失联'), 'bad'] as [string, EngineTone]) : (ENGINE_TEXT[state] ?? [state, 'dim' as EngineTone])
    const mine = strategies.filter((s) => s.engineId === id)
    const boundIds = arr(gep?.accounts).filter((x): x is string => typeof x === 'string')
    const engineRef = gep ? str(gep.engine) : undefined
    const at = engineRef ? engineRef.lastIndexOf('@') : -1
    return [{
      id, state, stateText: text, tone,
      version: at > 0 ? engineRef!.slice(at + 1) : null,
      canStop: state === 'ready' || state === 'degraded' || state === 'starting',
      busy: state === 'stopping',
      bound: boundIds.map((a) => alias.get(a) ?? a),
      boundIds,
      strategies: mine.length,
      running: mine.filter((s) => s.state === 'running' || s.state === 'starting').length,
      errors: mine.filter((s) => s.state === 'error').length,
      detail: str(e.detail) ?? (gep ? str(gep.detail) : undefined) ?? null,
      since: toNum(e.since),
      bindings: bindingsOf(e, gep),
      lastHeartbeatAt: toNum(e.lastHeartbeatAt) ?? (gep ? toNum(gep.lastHeartbeatAt) : null),
    }]
  })
}
export const stopEngineText = (e: EngineRow): string => tr('停止 {0}：{1} 个策略随之停止，持仓保留', e.id, e.running)

/** 绑定弹出卡只列纸面账户（实盘另签授权书，界面只给一行事实）。 */
export const paperAccounts = (accounts: readonly AccountLite[]): AccountLite[] => accounts.filter((a) => a.mode === 'paper')

/**
 * 内核的 engine.bind 是整体替换：只传这次选的账户，会把该引擎原来的绑定一并顶掉。
 * 新内核的 engine.list 带 bindings（含实盘授权书号）：把已绑的实盘账户连同 mandateId 原样带上，再加这次选的纸面账户；
 * 老内核没有 bindings 字段：engine.list 只回账户号、不回授权书号，实盘绑定重签不了，所以已绑实盘时不在网页里绑。
 * 永远不传 replaceLive。
 */
export function bindPlan(e: Pick<EngineRow, 'boundIds'> & Partial<Pick<EngineRow, 'bindings'>>, pick: string, accounts: readonly AccountLite[]): { ok: true; accounts: BindAccount[] } | { ok: false; reason: string } {
  if (e.bindings) {
    const kept: BindAccount[] = []
    for (const b of e.bindings) {
      if (b.mode !== 'live' || b.accountId === pick) continue
      if (!b.mandateId) return { ok: false, reason: tr('该引擎已绑定实盘账户，绑定会整体替换它；请用 gitrader engines bind') }
      kept.push({ accountId: b.accountId, mandateId: b.mandateId })
    }
    return { ok: true, accounts: [...kept, pick] }
  }
  const mode = new Map(accounts.map((a) => [a.accountId, a.mode]))
  if (e.boundIds.some((id) => mode.get(id) !== 'paper')) return { ok: false, reason: tr('该引擎已绑定实盘账户，绑定会整体替换它；请用 gitrader engines bind') }
  return { ok: true, accounts: [...new Set([...e.boundIds, pick])] }
}

// ---- 事件 -----------------------------------------------------------------------------

export const EVENT_TYPES = ['engine.event', 'engine.health_changed', 'engine.bound'] as const
export type ActorKind = 'human' | 'engine' | 'system' | 'agent'
export interface EventRow {
  key: string
  seq: number
  ts: number
  actor: { kind: ActorKind; name: string }
  text: string
  /** 红色一行：内核或引擎给的原文。 */
  bad: string | null
  /** 灰色一行：补充事实（绑定事件的授权书号）。 */
  note: string | null
  engineId: string | null
  instanceId: string | null
  strategyId: string | null
}

export function actorOf(origin: unknown): { kind: ActorKind; name: string } {
  const actor = isRec(origin) ? str(origin.actor) ?? '' : ''
  const i = actor.indexOf(':')
  const prefix = i > 0 ? actor.slice(0, i) : actor
  const id = i > 0 ? actor.slice(i + 1) : ''
  if (prefix === 'user') return { kind: 'human', name: tr('你') }
  if (prefix === 'agent') return { kind: 'agent', name: 'Agent' }
  if (prefix === 'engine' || prefix === 'strategy' || prefix === 'workflow' || prefix === 'plugin') return { kind: 'engine', name: id || prefix }
  return { kind: 'system', name: tr('系统') }
}

const TEXT_KEYS = ['message', 'text', 'summary', 'event', 'action', 'kind', 'type'] as const
export function toEventRow(e: unknown, accounts: readonly AccountLite[] = []): EventRow | null {
  if (!isRec(e) || !(EVENT_TYPES as readonly string[]).includes(String(e.type))) return null
  const seq = toNum(e.seq)
  const ts = toNum(e.ts)
  if (seq === null || ts === null) return null
  const payload = isRec(e.payload) ? e.payload : {}
  const subject = isRec(e.subject) ? e.subject : {}
  const engineId = str(subject.engineId) ?? null
  const causation = isRec(e.origin) && isRec(e.origin.causation) ? e.origin.causation : {}
  const alias = new Map(accounts.map((a) => [a.accountId, a.alias]))
  let text = ''
  let bad: string | null = null
  let note: string | null = null
  if (e.type === 'engine.health_changed') {
    const to = str(payload.to) ?? ''
    text = `${engineId ?? tr('引擎')} ${healthText(to)}`
    const detail = str(payload.detail)
    if (detail && (to === 'failed' || to === 'lost' || to === 'degraded')) bad = detail
  } else if (e.type === 'engine.bound') {
    const names = arr(payload.accounts).map((a) => (isRec(a) ? str(a.accountId) : typeof a === 'string' ? a : undefined)).filter((x): x is string => !!x).map((a) => alias.get(a) ?? a)
    text = tr('绑定 {0}{1}', engineId ?? tr('引擎'), names.length ? ` · ${names.join(tr('、'))}` : '')
    const mandates = arr(payload.accounts).map((a) => (isRec(a) ? str(a.mandateId) : undefined)).filter((x): x is string => !!x)
    // UX-30：纸面账户的授权是内核自动签的 L1，没有值得给人看的号（mdt_…）；写「纸面授权」。实盘授权仍列授权书号，人要拿它去核对
    const modeOf = new Map(accounts.map((a) => [a.accountId, a.mode]))
    const paperOnly = arr(payload.accounts).filter(isRec).filter((a) => str(a.mandateId)).every((a) => modeOf.get(str(a.accountId) ?? '') === 'paper')
    if (mandates.length) note = paperOnly ? tr('纸面授权') : tr('授权书 {0}', mandates.join(tr('、')))
  } else {
    const key = TEXT_KEYS.find((k) => typeof payload[k] === 'string' && payload[k] !== '')
    text = key ? String(payload[key]) : tr('引擎事件')
    const p = isRec(payload.problem) ? str(payload.problem.message) : undefined
    if (p) bad = p
  }
  return {
    key: str(e.id) ?? `seq-${seq}`, seq, ts, actor: actorOf(e.origin), text, bad, note,
    engineId, instanceId: str(causation.instanceId) ?? str(payload.instanceId) ?? null, strategyId: str(payload.strategyId) ?? null,
  }
}

/** ledger.query 回包 → 事件行（新在前）。 */
export function normalizeEvents(raw: unknown, accounts: readonly AccountLite[] = [], max = 200): EventRow[] {
  const seen = new Set<string>()
  return listOf(raw, 'entries').map((e) => toEventRow(e, accounts)).filter((x): x is EventRow => x !== null)
    .filter((r) => (seen.has(r.key) ? false : (seen.add(r.key), true))).sort((a, b) => b.seq - a.seq).slice(0, max)
}
/** 实时来的一条：同一条不重复，新的排在最前。 */
export function mergeEvent(list: readonly EventRow[], row: EventRow, max = 200): EventRow[] {
  if (list.some((x) => x.key === row.key)) return [...list]
  return [row, ...list].sort((a, b) => b.seq - a.seq).slice(0, max)
}
/** 展开区里属于这条策略的事件（按实例号或策略号 + 引擎号对上）。 */
export function eventsOfStrategy(events: readonly EventRow[], r: StrategyRow, max = 5): EventRow[] {
  return events.filter((e) => e.instanceId === r.instanceId || (e.strategyId === r.strategyId && e.engineId === r.engineId)).slice(0, max)
}
