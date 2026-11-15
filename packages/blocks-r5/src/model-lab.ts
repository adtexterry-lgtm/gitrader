// SPDX-License-Identifier: CPAL-1.0
// 实验页纯函数（P7 列表；P8 详情只在文件末尾追加）。不碰界面、不碰钩子，输入是 lab.list 回包里的 Experiment。
// 口径：列表不放任何收益数（没法按结果排序挑最好的）；结果数只在详情里看。
import { EXPERIMENT_STAGE_ALIASES, LLM_LEAK_MARGIN_DAYS } from '@gitrader/protocol/constants'
import type { Experiment } from '@gitrader/protocol/types'
import { normalizeAccounts, normalizeStrategies } from './model-strategies'
import { t as tr } from '@gitrader/workbench/i18n'

type Rec = Record<string, unknown>
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v)
const DAY = 86_400_000

export type CreatorType = 'human' | 'engine' | 'llm-agent' | 'system'
export type CreatorFilter = 'all' | CreatorType

/** K-r5-1 建议形状；内核补上之前回包里没有这个字段。 */
export interface LabLastAction { kind: 'run' | 'stage' | 'note' | 'conclusion' | 'promotion_request'; at: number; running: boolean }
export type LabItem = Experiment & { lastAction?: unknown }

// ---- 阶段 ---------------------------------------------------------------------------------

/** 页签只有协议口径的五段；live / review / closed / retired 只出现在「全部」里。 */
export const LAB_TABS = [
  { id: 'hypothesis', label: tr('假设') }, { id: 'backtest', label: tr('回测') }, { id: 'holdout', label: tr('保留期') }, { id: 'shadow', label: tr('影子') }, { id: 'live_small', label: tr('小额实盘') },
] as const
export type LabTab = (typeof LAB_TABS)[number]['id']
export type StageFilter = 'all' | LabTab

const STAGE_LABEL: Record<string, string> = {
  hypothesis: tr('假设'), backtest: tr('回测'), holdout: tr('保留期'), shadow: tr('影子'), live_small: tr('小额实盘'), live: tr('实盘'), review: tr('复核'), closed: tr('已关闭'), retired: tr('已退役'),
}
/** draft → hypothesis、paper → shadow（协议别名）。 */
export const canonicalStage = (stage: string): string => (EXPERIMENT_STAGE_ALIASES as Record<string, string>)[stage] ?? stage
export const stageLabel = (stage: string): string => STAGE_LABEL[canonicalStage(stage)] ?? stage

// ---- 偏差检查 -----------------------------------------------------------------------------

/** 训练截止存疑：用了大模型、且回测 / 保留期数据起点早于「训练截止 + LLM_LEAK_MARGIN_DAYS」，或模型的训练截止未知。没跑过回测 / 保留期就不判。 */
export function trainingCutoffDoubtful(e: Pick<Experiment, 'llm' | 'runs'>): boolean {
  if (!e.llm?.involved) return false
  const starts = (e.runs ?? []).filter((r) => r.stage === 'backtest' || r.stage === 'holdout').map((r) => r.from)
  if (!starts.length) return false
  const cutoffs = e.llm.models.map((m) => m.trainingCutoff)
  if (!cutoffs.length || cutoffs.some((c) => typeof c !== 'number')) return true
  return Math.min(...starts) < Math.max(...(cutoffs as number[])) + LLM_LEAK_MARGIN_DAYS * DAY
}

export type BiasView =
  | { kind: 'unrun' }
  | { kind: 'pass'; passed: number; total: number }
  | { kind: 'lookahead_fail' }
  | { kind: 'recursive_fail' }
  | { kind: 'cutoff' }

/** 优先级：未通过（红）> 训练截止存疑（琥珀）> 通过 n / 2 > 未跑。 */
export function biasView(e: Pick<Experiment, 'biasChecks' | 'llm' | 'runs'>): BiasView {
  const b = e.biasChecks
  if (b?.lookahead === 'fail') return { kind: 'lookahead_fail' }
  if (b?.recursive === 'fail') return { kind: 'recursive_fail' }
  if (trainingCutoffDoubtful(e)) return { kind: 'cutoff' }
  const results = b ? [b.lookahead, b.recursive] : []
  const passed = results.filter((r) => r === 'pass').length
  return passed === 0 ? { kind: 'unrun' } : { kind: 'pass', passed, total: 2 }
}

// ---- 最近动作 -----------------------------------------------------------------------------

export interface LastView { at: number; text: string; running: boolean }

/** 回包没有 lastAction（或形状不对）= null，界面该格显示「未接通」。 */
export function lastView(e: Pick<LabItem, 'lastAction' | 'runs'>): LastView | null {
  const a = e.lastAction
  if (!isRec(a) || typeof a.at !== 'number' || !Number.isFinite(a.at) || typeof a.kind !== 'string') return null
  const running = a.running === true
  switch (a.kind) {
    case 'run': {
      const runs = e.runs ?? []
      const last = runs.reduce<(typeof runs)[number] | undefined>((m, r) => (!m || (r.attachedAt ?? r.from) >= (m.attachedAt ?? m.from) ? r : m), undefined)
      if (!last) return { at: a.at, text: tr('运行'), running }
      const n = runs.filter((r) => r.stage === last.stage).length
      return { at: a.at, text: tr('{0} 第 {1} 次', stageLabel(last.stage), n), running }
    }
    case 'stage': return { at: a.at, text: tr('阶段变更'), running }
    case 'note': return { at: a.at, text: tr('备注'), running }
    case 'conclusion': return { at: a.at, text: tr('结论'), running }
    case 'promotion_request': return { at: a.at, text: tr('申请晋级'), running }
    default: return null
  }
}

// ---- 行 -----------------------------------------------------------------------------------

export interface LabRow {
  id: string
  title: string
  /** 别名折算后的阶段（draft → hypothesis）。 */
  stage: string
  stageLabel: string
  createdAt: number
  updatedAt: number
  forwardDays: number | null
  forwardTrades: number | null
  trials: number
  bias: BiasView
  last: LastView | null
  creatorType: CreatorType
  /** 人显示「你」，其余取 actor 冒号后的名字。 */
  creatorName: string
}

const CREATOR_TYPES: readonly string[] = ['human', 'engine', 'llm-agent', 'system']
const TYPE_OF_PREFIX: Record<string, CreatorType> = { user: 'human', agent: 'llm-agent', engine: 'engine', workflow: 'engine', strategy: 'engine', plugin: 'engine', mandate: 'system', system: 'system', venue: 'system' }

export function rowOf(e: LabItem): LabRow {
  const actor = typeof e.origin?.actor === 'string' ? e.origin.actor : ''
  const colon = actor.indexOf(':')
  const t = e.owner?.actorType ?? e.origin?.actorType
  const creatorType: CreatorType = CREATOR_TYPES.includes(t as string) ? (t as CreatorType) : (TYPE_OF_PREFIX[colon < 0 ? actor : actor.slice(0, colon)] ?? 'system')
  const fwd = e.forward?.sample
  const runs = e.runs ?? []
  const stage = canonicalStage(e.stage)
  return {
    id: e.experimentId,
    title: e.title,
    stage,
    stageLabel: stageLabel(stage),
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
    forwardDays: typeof fwd?.spanDays === 'number' ? fwd.spanDays : null,
    forwardTrades: typeof fwd?.trades === 'number' ? fwd.trades : null,
    trials: e.biasChecks?.trialCount ?? runs.filter((r) => r.stage === 'backtest' || r.stage === 'holdout').length,
    bias: biasView(e),
    last: lastView(e),
    creatorType,
    creatorName: creatorType === 'human' ? tr('你') : colon < 0 ? actor : actor.slice(colon + 1),
  }
}

/** 回包 → 行。条目缺 experimentId / stage / title 的整条丢掉；排序同内核：更新时间新→旧，同刻编号大→小。 */
export function rowsOf(items: readonly unknown[]): LabRow[] {
  return items
    .filter((it): it is LabItem => isRec(it) && typeof it.experimentId === 'string' && typeof it.stage === 'string' && typeof it.title === 'string')
    .map(rowOf)
    .sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
}

// ---- 筛选 / 计数 ---------------------------------------------------------------------------

export const filterByCreator = (rows: readonly LabRow[], creator: CreatorFilter): LabRow[] => (creator === 'all' ? [...rows] : rows.filter((r) => r.creatorType === creator))

/** 页签计数按创建方筛选后的集合算，和点进页签后看到的行数一致。 */
export function stageCounts(rows: readonly LabRow[]): Record<StageFilter, number> {
  const out: Record<StageFilter, number> = { all: rows.length, hypothesis: 0, backtest: 0, holdout: 0, shadow: 0, live_small: 0 }
  for (const r of rows) if (r.stage in out) out[r.stage as LabTab] += 1
  return out
}

export function filterRows(rows: readonly LabRow[], stage: StageFilter, creator: CreatorFilter): LabRow[] {
  const byCreator = filterByCreator(rows, creator)
  return stage === 'all' ? byCreator : byCreator.filter((r) => r.stage === stage)
}

// ---- 回包 ---------------------------------------------------------------------------------

/** lab.list 回包缺必要字段（不是内核报错）：界面按「未接通」显示，原文写字段名。 */
export class LabShapeError extends Error {
  readonly field: string
  constructor(field: string) { super(tr('lab.list 回包缺少 {0}', field)); this.name = 'LabShapeError'; this.field = field }
}

/** 一页回包。内核回 ok:false 的 Problem 时抛出它的原文，不改写。 */
export function readPage(raw: unknown): { items: unknown[]; next?: string } {
  if (isRec(raw) && raw.ok === false) {
    const p = isRec(raw.error) ? raw.error : isRec(raw.problem) ? raw.problem : undefined
    throw new Error(typeof p?.message === 'string' && p.message ? p.message : 'lab.list ok:false')
  }
  if (!isRec(raw) || !Array.isArray(raw.items)) throw new LabShapeError('items')
  return { items: raw.items, ...(typeof raw.next === 'string' && raw.next ? { next: raw.next } : {}) }
}

// ---- 显示 ---------------------------------------------------------------------------------

const p2 = (n: number): string => String(n).padStart(2, '0')
/** 本地时间 `MM-DD HH:mm`。 */
export function stamp(ms: number): string {
  const d = new Date(ms)
  return `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`
}

// =================================================================================================
// P8 · 实验详情（只追加）。输入是 lab.get / lab.run / ledger.query 的回包；回包没有的字段一律回 null / 空，界面显示「无」或「未接通」。
// 口径：只有前向着色（涨跌）；保留期 / 回测数字中性；不出年化、不出预测段；曲线只画到最后一个真实点。
// =================================================================================================
const MINUS = '−'
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null)
const recs = (v: unknown): Rec[] => (Array.isArray(v) ? v.filter(isRec) : [])

/** lab.get / lab.run 回包缺必要字段：界面按「未接通」显示，原文写字段名。name 与 LabShapeError 相同，kit 的 wireState 认得。 */
export class LabDetailShapeError extends Error {
  readonly field: string
  constructor(method: string, field: string) { super(tr('{0} 回包缺少 {1}', method, field)); this.name = 'LabShapeError'; this.field = field }
}

/** 内核回 ok:false 的 Problem 时抛它的原文，不改写。 */
function failText(raw: unknown): string | null {
  if (!isRec(raw) || raw.ok !== false) return null
  const p = isRec(raw.error) ? raw.error : isRec(raw.problem) ? raw.problem : undefined
  return typeof p?.message === 'string' && p.message ? p.message : 'ok:false'
}

export type LabDetail = Rec & { experimentId: string; title: string; stage: string }
export function readDetail(raw: unknown): LabDetail {
  const f = failText(raw)
  if (f !== null) throw new Error(f)
  if (!isRec(raw)) throw new LabDetailShapeError('lab.get', 'experimentId')
  for (const k of ['experimentId', 'title', 'stage']) if (typeof raw[k] !== 'string') throw new LabDetailShapeError('lab.get', k)
  return raw as LabDetail
}

// ---- 阶段阶梯与晋级目标 -------------------------------------------------------------------------

export const LADDER = ['hypothesis', 'backtest', 'holdout', 'shadow', 'live_small'] as const
export interface LadderStep { id: string; label: string; current: boolean }
export function ladderOf(stage: string): LadderStep[] {
  const cur = canonicalStage(stage)
  return LADDER.map((id) => ({ id, label: stageLabel(id), current: id === cur }))
}
const ladderIndex = (stage: string): number => (LADDER as readonly string[]).indexOf(canonicalStage(stage))
/** 下一级；小额实盘之后（实盘）不在本页晋级，复核 / 关闭等也没有。 */
export function promotionTarget(stage: string): string | null {
  const i = ladderIndex(stage)
  return i < 0 ? null : (LADDER[i + 1] ?? null)
}

// ---- 显示小件 -----------------------------------------------------------------------------------

/** 带符号百分比：+0.46% / −0.52%（零不带符号）。 */
export function pctSigned(ratio: number | null, digits = 2): string {
  if (ratio === null) return tr('无')
  const v = ratio * 100
  const s = Math.abs(v).toFixed(digits)
  return Number(s) === 0 ? `${s}%` : `${v > 0 ? '+' : MINUS}${s}%`
}
const pctPlain = (ratio: number | null): string => (ratio === null ? tr('无') : `${Math.round(ratio * 100)}%`)
/** 最大回撤按「负的幅度」显示：−0.52%。 */
const drawdown = (ratio: number | null): string => {
  if (ratio === null) return tr('无')
  const s = Math.abs(ratio * 100).toFixed(2)
  return Number(s) === 0 ? `${s}%` : `${MINUS}${s}%`
}
const fixed2 = (n: number | null): string => (n === null ? tr('无') : n.toFixed(2))
/** 费用 / 资金费：内核给「花掉多少」的正数，显示成负的现金流。 */
function cost(v: unknown): string {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : num(v)
  if (n === null || !Number.isFinite(n)) return tr('无')
  const s = Math.abs(n).toFixed(2)
  return Number(s) === 0 ? s : `${n > 0 ? MINUS : '+'}${s}`
}
const THOUSANDS = /(\d)(?=(\d{3})+$)/g
function group(n: number, dp: number): string {
  const [i = '', f] = Math.abs(n).toFixed(dp).split('.')
  return `${n < 0 ? MINUS : ''}${i.replace(THOUSANDS, '$1,')}${f ? `.${f}` : ''}`
}
const dayRange = (from: number, to: number): string => tr('{0} 至 {1}', stamp(from).slice(0, 5), stamp(to).slice(0, 5))

// ---- 曲线 ---------------------------------------------------------------------------------------

export interface CurvePt { x: number; y: number; t: number; v: number }
export interface Curve {
  line: string
  area: string
  base: number
  end: { x: number; y: number }
  grid: { y: number; label: string }[]
  startLabel: string
  endLabel: string
  pts: CurvePt[]
}
/** 取「落在范围内至少 3 条」的最大整齐步长（1 / 2 / 2.5 / 5 × 10^k），只给 3 条。 */
function ticks(lo: number, hi: number): number[] {
  for (let p = Math.ceil(Math.log10(hi - lo)); p >= -4; p -= 1) {
    for (const m of [5, 2.5, 2, 1]) {
      const step = m * 10 ** p
      const out: number[] = []
      for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Number(v.toFixed(6)))
      if (out.length >= 3) return out.slice(0, 3)
    }
  }
  return []
}
const MAX_PTS = 400
const r2 = (n: number): string => String(Math.round(n * 100) / 100)

/** 权益点 → 画布 1000 × 100 的折线。x 按时间比例；y 上下各留数据幅度 12%；第一点画基准线。少于 2 个点不画（返回 null）。 */
export function curveOf(points: readonly { t: number; v: number }[], endWithTime: boolean): Curve | null {
  const pts0 = points.filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v)).sort((a, b) => a.t - b.t)
  if (pts0.length < 2) return null
  const stride = Math.ceil(pts0.length / MAX_PTS)
  const pts = pts0.filter((_, i) => i % stride === 0 || i === pts0.length - 1)
  const first = pts[0]!
  const last = pts[pts.length - 1]!
  const vs = pts.map((p) => p.v)
  const min = Math.min(...vs)
  const max = Math.max(...vs)
  const span = max - min || Math.abs(max) * 0.01 || 1
  const lo = min - span * 0.12
  const hi = max + span * 0.12
  const dt = last.t - first.t || 1
  const yOf = (v: number): number => ((hi - v) / (hi - lo)) * 100
  const out: CurvePt[] = pts.map((p) => ({ x: ((p.t - first.t) / dt) * 1000, y: yOf(p.v), t: p.t, v: p.v }))
  const line = out.map((p, i) => `${i ? 'L' : 'M'}${r2(p.x)} ${r2(p.y)}`).join('')
  const dp = hi - lo < 10 ? 2 : 0
  return {
    line,
    area: `${line}L1000 100L0 100Z`,
    base: yOf(first.v),
    end: { x: 1000, y: out[out.length - 1]!.y },
    grid: ticks(lo, hi).map((v) => ({ y: yOf(v), label: group(v, dp) })),
    startLabel: stamp(first.t).slice(0, 5),
    endLabel: endWithTime ? stamp(last.t) : stamp(last.t).slice(0, 5),
    pts: out,
  }
}
export const curveValue = (v: number): string => group(v, 2)

// ---- 三口径 -------------------------------------------------------------------------------------

export type TierId = 'forward' | 'holdout' | 'backtest'
export interface TierView {
  tier: TierId
  /** 口径名：纸面 / 小额实盘 / 样本外 / 样本内。 */
  basis: string
  window: { from: number; to: number } | null
  windowText: string
  /** 前向才有：账户号与是否纸面。 */
  account?: { id: string; paper: boolean }
  /** 权益的计价币种（前向有；回测结果里没有就不写）。 */
  ccy?: string
  /** 区间收益（不出年化）；只有前向用涨跌色。 */
  ret: string
  tone: 'up' | 'down' | 'neutral'
  /** 左列：交易 · 胜率 · 夏普 · 最大回撤；右列：手续费 · 资金费。 */
  left: { key: string; value: string }[]
  right: { key: string; value: string }[]
  curve: Curve | null
}
function metricRows(m: { trades: number | null; win: number | null; sharpe: number | null; maxDd: number | null; fees: unknown; funding: unknown }) {
  return {
    left: [
      { key: tr('交易'), value: m.trades === null ? tr('无') : String(m.trades) }, { key: tr('胜率'), value: pctPlain(m.win) },
      { key: tr('夏普'), value: fixed2(m.sharpe) }, { key: tr('最大回撤'), value: drawdown(m.maxDd) },
    ],
    right: [{ key: tr('手续费'), value: cost(m.fees) }, { key: tr('资金费'), value: cost(m.funding) }],
  }
}

/** 前向：ForwardStats + 日快照（forwardSnapshots，按 accountIds 过滤、同刻各账户相加）。没有前向统计 = null（界面写「前向 0 天」）。 */
export function forwardView(detail: Rec): TierView | null {
  const f = detail.forward
  if (!isRec(f) || !isRec(f.window)) return null
  const from = num(f.window.from)
  const to = num(f.window.to)
  const sample = isRec(f.sample) ? f.sample : {}
  const accountIds = Array.isArray(f.accountIds) ? (f.accountIds as unknown[]).filter((a): a is string => typeof a === 'string') : []
  const spanDays = num(sample.spanDays)
  const live = f.tier === 'forward_live'
  const sums = new Map<number, number>()
  for (const s of recs(detail.forwardSnapshots)) {
    const t = num(s.at)
    const v = typeof s.equity === 'string' ? Number(s.equity) : num(s.equity)
    if (t === null || v === null || !Number.isFinite(v)) continue
    if (accountIds.length && !accountIds.includes(String(s.accountId))) continue
    sums.set(t, (sums.get(t) ?? 0) + v)
  }
  const ret = num(f.returnRatio)
  const rows = metricRows({ trades: num(sample.trades), win: num(f.winRatio), sharpe: num(f.sharpe), maxDd: num(f.maxDrawdownRatio), fees: f.fees, funding: f.funding })
  const first = accountIds[0]
  return {
    tier: 'forward',
    basis: live ? tr('小额实盘') : tr('纸面'),
    window: from !== null && to !== null ? { from, to } : null,
    windowText: from !== null ? tr('{0} 至今{1}', stamp(from).slice(0, 5), spanDays !== null ? tr(' · {0} 天', spanDays) : '') : '',
    ...(first ? { account: { id: accountIds.length > 1 ? `${first} +${accountIds.length - 1}` : first, paper: !live } } : {}),
    ...(typeof f.valuationCcy === 'string' && f.valuationCcy ? { ccy: f.valuationCcy } : {}),
    ret: pctSigned(ret),
    tone: ret === null || ret === 0 ? 'neutral' : ret > 0 ? 'up' : 'down',
    ...rows,
    curve: curveOf([...sums].map(([t, v]) => ({ t, v })), true),
  }
}

export interface RunRef { runId: string; from: number; to: number; startedAt: number; specDigest?: string }
function runRef(r: Rec): RunRef | null {
  const w = isRec(r.window) ? r.window : {}
  const runId = str(r.runId)
  const from = num(w.from)
  const to = num(w.to)
  const specDigest = str(r.specDigest)
  return runId && from !== null && to !== null ? { runId, from, to, startedAt: num(r.startedAt) ?? to, ...(specDigest ? { specDigest } : {}) } : null
}
/** 保留期 / 回测各取各的 run；lab.get 没带 runSummaries（不是数组）= 内核不区分这两个阶段的结果，两张卡都按「未接通」显示，绝不互相借用。 */
export function runSummariesMissing(detail: Rec): LabDetailShapeError | null {
  return Array.isArray(detail.runSummaries) ? null : new LabDetailShapeError('lab.get', 'runSummaries')
}
/** 已跑完的回测，按开始时间旧→新（不含保留期那一次）。 */
export function backtestRuns(detail: Rec): RunRef[] {
  const ho = str(detail.holdoutRunId)
  return recs(detail.runSummaries)
    .filter((r) => r.status === 'done' && r.kind !== 'replay' && r.runId !== ho)
    .map(runRef).filter((r): r is RunRef => r !== null)
    .sort((a, b) => a.startedAt - b.startedAt || (a.runId < b.runId ? -1 : 1))
}
export function holdoutRun(detail: Rec): RunRef | null {
  const id = str(detail.holdoutRunId)
  const hit = id ? recs(detail.runSummaries).find((r) => r.runId === id && r.status === 'done') : undefined
  return hit ? runRef(hit) : null
}
export const hasHoldoutWindow = (detail: Rec): boolean => isRec(detail.holdoutWindow)
/** 回测下拉：第 N 次 / 共 N 次。 */
export const runLabel = (index: number, total: number): string => tr('第 {0} 次 / 共 {1} 次', index + 1, total)
/** 选中第几次；没选或选的不在了 = 最新一次。 */
export function pickRun(runs: readonly RunRef[], runId: string | null | undefined): number {
  const i = runId ? runs.findIndex((r) => r.runId === runId) : -1
  return i >= 0 ? i : runs.length - 1
}

/** 保留期 / 回测：BacktestResult（lab.run 回包）。stats 缺 = 抛形状错（界面「未接通」）；统计里没有的项显示「无」。 */
export function resultView(tier: 'holdout' | 'backtest', run: RunRef, raw: unknown): TierView {
  const f = failText(raw)
  if (f !== null) throw new Error(f)
  if (!isRec(raw) || !isRec(raw.stats)) throw new LabDetailShapeError('lab.run', 'stats')
  // 内核自己保证 result.specDigest === 这次 run 的 specDigest；回来的不是所请求的那次运行就不画（不借用别的阶段的数据）
  if (run.specDigest && typeof raw.specDigest === 'string' && raw.specDigest !== run.specDigest) {
    const e = new LabDetailShapeError('lab.run', 'specDigest')
    e.message = tr('lab.run 回包不是所请求的那次运行（specDigest 与 {0} 不符）', run.runId)
    throw e
  }
  const s = raw.stats as Rec
  const days = num(s.spanDays) ?? Math.round((run.to - run.from) / 86_400_000)
  const equity = recs(raw.equity).flatMap((p) => { const t = num(p.t); const v = num(p.v); return t !== null && v !== null ? [{ t, v }] : [] })
  const rows = metricRows({ trades: num(s.trades), win: num(s.winRatio), sharpe: num(s.sharpe), maxDd: num(s.maxDrawdownRatio), fees: s.feesPaid, funding: s.fundingPaid })
  return {
    tier,
    basis: tier === 'holdout' ? tr('样本外') : tr('样本内'),
    window: { from: run.from, to: run.to },
    windowText: tr('{0} · {1} 天', dayRange(run.from, run.to), days),
    ret: pctSigned(num(s.totalReturnRatio)),
    tone: 'neutral',
    ...rows,
    curve: curveOf(equity, false),
  }
}

export interface TradeRow { at: number; side: string; price: string; size: string; pnl: string; fee: string; reason: string }
/** 成交页签：lab.run 回包里的 trades，新→旧；盈亏 / 手续费中性色显示。 */
export function tradeRows(raw: unknown, max = 200): TradeRow[] {
  if (!isRec(raw)) return []
  return recs(raw.trades).flatMap((t): TradeRow[] => {
    const at = num(t.t)
    const price = num(t.price)
    const size = num(t.size)
    const pnl = num(t.pnl)
    if (at === null || price === null || size === null || (t.side !== 'buy' && t.side !== 'sell')) return []
    return [{
      at, side: t.side === 'buy' ? tr('买入') : tr('卖出'), price: group(price, 2), size: String(size),
      pnl: pnl === null ? tr('无') : `${pnl > 0 ? '+' : pnl < 0 ? MINUS : ''}${Math.abs(pnl).toFixed(2)}`, fee: cost(num(t.fee)), reason: str(t.reason) ?? '',
    }]
  }).sort((a, b) => b.at - a.at).slice(0, max)
}

// ---- 右列三卡 -----------------------------------------------------------------------------------

export interface DefRow { key: string; value: string; tone?: 'warn' | 'bad' | 'muted'; copy?: string; href?: string }

/** 假设七项（费 / 滑点 / 成交模型 / 资金费 / 强平 / 成交量上限 / 延迟）；没记假设 = null（界面写「无假设记录」）。没写的项显示「缺」+ 琥珀 ⚠。 */
export function assumptionRows(raw: unknown): DefRow[] | null {
  if (!isRec(raw)) return null
  const fees = raw.fees
  const slip = num(raw.slippageBps)
  const model = str(raw.fillModel)
  const share = num(raw.maxVolumeShare)
  const latency = num(raw.latencyMs)
  const miss = (key: string): DefRow => ({ key, value: tr('缺'), tone: 'warn' })
  const flag = (key: string, v: unknown): DefRow => (typeof v === 'boolean' ? { key, value: v ? tr('计入') : tr('不计入') } : miss(key))
  return [
    fees === 'venue' ? { key: tr('手续费'), value: tr('场所费率') } : isRec(fees) ? { key: tr('手续费'), value: `maker ${String(fees.maker)} / taker ${String(fees.taker)}` } : miss(tr('手续费')),
    slip === null ? miss(tr('滑点')) : { key: tr('滑点'), value: `${slip} bp` },
    model ? { key: tr('成交模型'), value: model } : miss(tr('成交模型')),
    flag(tr('资金费'), raw.funding),
    flag(tr('强平'), raw.liquidation),
    share === null ? miss(tr('成交量上限')) : { key: tr('成交量上限'), value: `${Number((share * 100).toFixed(2))}%` },
    latency === null ? miss(tr('延迟')) : { key: tr('延迟'), value: `${latency} ms` },
  ]
}

const checkText = (r: unknown): string => (r === 'pass' ? tr('通过') : r === 'fail' ? tr('未通过') : tr('未跑'))
function check(key: string, r: unknown): DefRow {
  return { key, value: checkText(r), ...(r === 'fail' ? { tone: 'bad' as const } : r === 'pass' ? {} : { tone: 'muted' as const }) }
}
/** 偏差检查四项：前视 / 递归 / 试验次数 / 训练截止（没用大模型 = 不涉及；用了且数据起点不足余量 = 存疑）。 */
export function biasRows(detail: Rec): DefRow[] {
  const b = isRec(detail.biasChecks) ? (detail.biasChecks as Rec) : {}
  const llm = isRec(detail.llm) && detail.llm.involved === true
  const trials = num(b.trialCount)
  const cutoff: DefRow = !llm
    ? { key: tr('训练截止'), value: tr('不涉及'), tone: 'muted' }
    : trainingCutoffDoubtful(detail as never) ? { key: tr('训练截止'), value: tr('存疑'), tone: 'warn' } : { key: tr('训练截止'), value: tr('无存疑') }
  return [check(tr('前视'), b.lookahead), check(tr('递归'), b.recursive), trials === null ? { key: tr('试验次数'), value: tr('无'), tone: 'muted' } : { key: tr('试验次数'), value: String(trials) }, cutoff]
}

const SHA_PREFIX = 'sha256:'
const hex = (d: string | null): string | null => (d ? (d.startsWith(SHA_PREFIX) ? d.slice(SHA_PREFIX.length) : d) : null)
/** 数据与来历：数据 / 区间 / 摘要（每份数据三行）、协议哈希（subjectKey）、派生自。 */
export function dataRows(detail: Rec): DefRow[] {
  const rows: DefRow[] = []
  const data = recs(detail.data)
  if (!data.length) rows.push({ key: tr('数据'), value: tr('无'), tone: 'muted' })
  for (const d of data) {
    rows.push({ key: tr('数据'), value: str(d.source) ?? tr('无') })
    rows.push({ key: tr('区间'), value: str(d.range) ?? tr('无') })
    const h = hex(str(d.sha256))
    rows.push(h ? { key: tr('摘要'), value: `sha256 ${h.slice(0, 4)}`, copy: h } : { key: tr('摘要'), value: tr('无'), tone: 'muted' })
  }
  const key = hex(str(detail.subjectKey))
  rows.push(key ? { key: tr('协议'), value: key.slice(0, 8), copy: key } : { key: tr('协议'), value: tr('无'), tone: 'muted' })
  const parent = isRec(detail.lineage) ? str(detail.lineage.parentExperimentId) : null
  rows.push(parent ? { key: tr('派生自'), value: parent, href: `#/lab/${encodeURIComponent(parent)}` } : { key: tr('派生自'), value: tr('无'), tone: 'muted' })
  return rows
}

/** 本地时间 YYYY-MM-DD（训练截止日要年份；stamp 不含年份）。 */
export function ymd(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 实验自身的「说了什么」：假设 / 策略 / 参数 / 留出窗口 / 大模型。无数据的项写「无」（muted），不省略。 */
export function originRows(detail: Rec): DefRow[] {
  const rows: DefRow[] = []
  const hyp = str(detail.hypothesis)
  rows.push(hyp ? { key: tr('假设'), value: hyp.length > 60 ? `${hyp.slice(0, 60)}…` : hyp } : { key: tr('假设'), value: tr('无'), tone: 'muted' })
  const subj = isRec(detail.subject) ? detail.subject : {}
  const strat = isRec(subj.strategy) ? subj.strategy : null
  const wf = isRec(subj.workflow) ? subj.workflow : null
  rows.push(strat ? { key: tr('策略'), value: `${str(strat.id) ?? '?'} ${str(strat.version) ?? ''}`.trim() } : wf ? { key: tr('工作流'), value: `${str(wf.id) ?? '?'} ${str(wf.version) ?? ''}`.trim() } : { key: tr('策略'), value: tr('无'), tone: 'muted' })
  const params = isRec(subj.params) ? Object.entries(subj.params) : []
  if (!params.length) rows.push({ key: tr('参数'), value: tr('无'), tone: 'muted' })
  params.slice(0, 8).forEach(([k, v]) => rows.push({ key: k, value: typeof v === 'object' && v !== null ? JSON.stringify(v).slice(0, 40) : String(v) }))
  if (params.length > 8) rows.push({ key: tr('参数'), value: tr('另 {0} 项', params.length - 8), tone: 'muted' })
  const hw = isRec(detail.holdoutWindow) ? detail.holdoutWindow : null
  const frozen = isRec(detail.frozen) && detail.frozen.holdout === true
  const from = hw ? num(hw.from) : null
  const to = hw ? num(hw.to) : null
  rows.push(from !== null && to !== null ? { key: tr('留出'), value: `${stamp(from)} → ${stamp(to)}${frozen ? tr(' · 已冻结') : ''}` } : { key: tr('留出'), value: tr('无'), tone: 'muted' })
  const llm = isRec(detail.llm) ? detail.llm : null
  const FROM: Record<string, string> = { creator: tr('创建者是 Agent'), workflow: tr('工作流含模型节点'), declared: tr('自报') }
  rows.push(llm && llm.involved === true ? { key: tr('大模型'), value: tr('参与 · {0}', FROM[str(llm.derivedFrom) ?? ''] ?? tr('自报')) } : { key: tr('大模型'), value: tr('未参与'), tone: 'muted' })
  for (const m of recs(llm?.models)) {
    const cutoff = num(m.trainingCutoff)
    rows.push({ key: tr('模型'), value: `${str(m.id) ?? '?'}${cutoff !== null ? tr(' · 截止 {0}', ymd(cutoff)) : ''}${str(m.source) === 'kernel-table' ? '' : tr(' · 自报')}` })
  }
  return rows
}

// ---- 注记与 Agent 晋级申请 -----------------------------------------------------------------------

export interface ActorView { kind: 'human' | 'engine' | 'agent' | 'system'; name: string }
export function actorOf(origin: unknown): ActorView {
  const o = isRec(origin) ? origin : {}
  const actor = typeof o.actor === 'string' ? o.actor : ''
  const colon = actor.indexOf(':')
  const t: CreatorType = CREATOR_TYPES.includes(o.actorType as string) ? (o.actorType as CreatorType) : (TYPE_OF_PREFIX[colon < 0 ? actor : actor.slice(0, colon)] ?? 'system')
  const kind = t === 'human' ? 'human' : t === 'engine' ? 'engine' : t === 'llm-agent' ? 'agent' : 'system'
  return { kind, name: t === 'human' ? tr('你') : t === 'system' ? tr('系统') : colon < 0 ? actor : actor.slice(colon + 1) }
}

export interface PromotionRequest { at: number; actor: ActorView; to: string | null; seq: number | null }
/** ledger.query 回包（数组或 {entries}）里最新一条本实验的 Agent 晋级申请；已经晋级到该阶段或更后就不再显示。取不到 = null（界面不出该行）。 */
export function promotionRequest(raw: unknown, detail: Pick<LabDetail, 'experimentId' | 'stage'>): PromotionRequest | null {
  const list: unknown[] = Array.isArray(raw) ? raw : isRec(raw) && Array.isArray(raw.entries) ? raw.entries : []
  let best: PromotionRequest | null = null
  for (const e of list) {
    if (!isRec(e) || !isRec(e.payload) || e.payload.kind !== 'experiment_promotion_request' || e.payload.experimentId !== detail.experimentId) continue
    const at = num(e.ts) ?? num(e.recordedAt)
    if (at === null) continue
    const seq = num(e.seq)
    if (!best || at > best.at || (at === best.at && (seq ?? 0) > (best.seq ?? 0))) best = { at, actor: actorOf(e.origin), to: str(e.payload.to), seq }
  }
  if (!best) return null
  return best.to && ladderIndex(detail.stage) >= ladderIndex(best.to) ? null : best
}

export interface NoteRow { at: number; actor: ActorView; text: string; kind: 'note' | 'conclusion' | 'promotion' }
/** 注记：notes + conclusions + 晋级申请，新→旧。 */
export function notesOf(detail: Rec, request: PromotionRequest | null): NoteRow[] {
  const out: NoteRow[] = []
  for (const n of recs(detail.notes)) {
    const at = num(n.at)
    const text = str(n.text)
    if (at !== null && text) out.push({ at, actor: actorOf(n.origin), text, kind: 'note' })
  }
  for (const n of recs(detail.conclusions)) {
    const at = num(n.at)
    const text = str(n.text)
    if (at !== null && text) out.push({ at, actor: actorOf(n.origin), text: tr('结论 {0}', text), kind: 'conclusion' })
  }
  if (request) out.push({ at: request.at, actor: request.actor, text: tr('申请晋级 {0}', request.to ? stageLabel(request.to) : '').trim(), kind: 'promotion' })
  return out.sort((a, b) => b.at - a.at)
}

// ---- 晋级弹出卡 ---------------------------------------------------------------------------------

function biasText(v: BiasView): string {
  switch (v.kind) {
    case 'pass': return tr('通过 {0} / {1}', v.passed, v.total)
    case 'lookahead_fail': return tr('前视未通过')
    case 'recursive_fail': return tr('递归未通过')
    case 'cutoff': return tr('训练截止存疑')
    case 'unrun': return tr('未跑')
  }
}
/** 弹出卡里列的证据事实（内核照旧自己判；这里只摆事实）。 */
export function evidenceRows(detail: Rec): { key: string; value: string }[] {
  const f = isRec(detail.forward) ? (detail.forward as Rec) : null
  const sample = f && isRec(f.sample) ? (f.sample as Rec) : {}
  const span = num(sample.spanDays)
  const trades = num(sample.trades)
  const trials = isRec(detail.biasChecks) ? num(detail.biasChecks.trialCount) : null
  return [
    { key: tr('当前阶段'), value: stageLabel(String(detail.stage ?? '')) },
    { key: tr('前向天数'), value: span === null ? tr('无') : tr('{0} 天', span) },
    { key: tr('前向交易'), value: trades === null ? tr('无') : String(trades) },
    { key: tr('偏差检查'), value: biasText(biasView(detail as never)) },
    { key: tr('试验次数'), value: trials === null ? tr('无') : String(trials) },
  ]
}
/** 第二步确认条里的后果：晋级到小额实盘 = 可在实盘账户启动本实验的策略（名取钉死的策略号）。 */
export function promotionConsequence(detail: Rec, to: string): string {
  const strat = isRec(detail.subject) && isRec(detail.subject.strategy) ? str(detail.subject.strategy.id) : null
  return canonicalStage(to) === 'live_small' ? tr('晋级后可在实盘账户启动 {0}', strat ?? tr('本实验的策略')) : tr('晋级后阶段变为 {0}', stageLabel(to))
}
/** 内核拒绝的原文：名字不在消息里时前面补上名字，不改写消息本身。 */
export function denyText(message: string, problem?: string): string {
  return problem && !message.includes(problem) ? `${problem} ${message}` : message
}
export const exportFileName = (id: string): string => `${id}-evidence.json`

// ---- 人面入口（GQ-09 / I-6）：附加纸面运行、出证据包 ----------------------------------------------

/** 可附加的引擎实例：纸面账户上、运行中、策略号与实验主体相同、还没有作为活动运行挂在本实验上。 */
export interface AttachCandidate { key: string; accountId: string; alias: string; engineId: string; instanceId: string }
export function attachCandidates(detail: Rec, strategiesRaw: unknown, accountsRaw: unknown): AttachCandidate[] {
  const subject = isRec(detail.subject) && isRec(detail.subject.strategy) ? str(detail.subject.strategy.id) : null
  if (!subject) return []
  const active = new Set(recs(detail.runs).flatMap((r) => (r.to == null && isRec(r.executor) && r.executor.kind === 'engine' ? [`${str(r.executor.engineId)}:${str(r.executor.instanceId)}`] : [])))
  return normalizeStrategies(strategiesRaw, normalizeAccounts(accountsRaw)).rows
    .filter((r) => r.state === 'running' && r.account?.mode === 'paper' && r.strategyId === subject && !active.has(r.key))
    .map((r) => ({ key: r.key, accountId: r.accountId, alias: r.account?.alias ?? r.accountId, engineId: r.engineId, instanceId: r.instanceId }))
}
/** 阶段已结束（closed / retired）的实验不再附加。 */
export const attachClosed = (detail: Rec): boolean => detail.stage === 'closed' || detail.stage === 'retired'
export const attachCmd = (experimentId: string, c: AttachCandidate) =>
  ({ experimentId, attach: { run: { accountId: c.accountId, executor: { kind: 'engine', engineId: c.engineId, instanceId: c.instanceId } } } })
/** 实例号只露后 6 位。 */
export const shortId = (id: string): string => (id.length > 6 ? `…${id.slice(-6)}` : id)

/** 这次回测能不能出证据包；第一次出包（未冻结、实验也没带窗口）要先填留出窗口。 */
export function packableRun(detail: Rec, runId: string): { ok: true; needsWindow: boolean } | { ok: false; reason: string } {
  const run = recs(detail.runSummaries).find((r) => r.runId === runId)
  if (!run) return { ok: false, reason: tr('找不到这次运行') }
  if (str(run.packId) || recs(detail.packs).some((p) => p.runId === runId)) return { ok: false, reason: tr('这次运行已出过证据包') }
  if (run.status !== 'done') return { ok: false, reason: tr('这次运行还没跑完') }
  const frozen = isRec(detail.frozen) && detail.frozen.holdout === true
  return { ok: true, needsWindow: !frozen && !isRec(detail.holdoutWindow) }
}
/** 出包的后果一行。 */
export const packConsequence = (detail: Rec): string =>
  (isRec(detail.frozen) && detail.frozen.holdout === true ? tr('出包后该运行不可重出') : tr('出包后冻结假设、策略与留出窗口'))

/** datetime-local 两段文本 → 留出窗口毫秒（按本机时区）；空、读不懂或起 ≥ 止都不行。 */
export function toWindowMs(fromText: string, toText: string): { ok: true; window: { from: number; to: number } } | { ok: false; reason: string } {
  const ms = (t: string): number | null => { if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(t)) return null; const v = new Date(t).getTime(); return Number.isFinite(v) ? v : null }
  const from = ms(fromText.trim())
  const to = ms(toText.trim())
  if (from === null || to === null) return { ok: false, reason: tr('填留出起止') }
  if (from >= to) return { ok: false, reason: tr('留出起要早于留出止') }
  return { ok: true, window: { from, to } }
}
