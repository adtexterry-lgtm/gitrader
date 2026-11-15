// SPDX-License-Identifier: CPAL-1.0
// 研究作业（x-gitrader.research.run / status / result / cancel）：寻优（optimize / walk_forward）与因子报告（factor_report）。
//
// 分工（第六轮 C 包）：
//   - 本文件只管「作业表」和「数据入口」——规格校验、装载 K 线（与回测同一个 loadCandles）、排队 / 进度 / 取消、
//     摘要 ≤ 8 KB 与分页明细；形态照 backtest-jobs.ts 的 run / status / result / cancel。
//   - 真正的计算（optimizer 的 optimize()、因子评估）由产品层经 EngineCoreOptions.research 注入的 ResearchProvider 完成：
//     依赖方向是 optimizer → engine-core，engine-core 不 import optimizer / report / portfolio / ta-plus / symbol-search，
//     装配放在 packages/cli/src/engine-core-launcher.ts（同机器人模板的注入方式）。
//   - 研究只读：不碰账户、不下单、不写账本；产物只在内存里按作业号保留（重启即失）。
import { RESEARCH_KINDS, RESEARCH_LIMITS, type BacktestState, type Problem, type ResearchKind } from '../proto'
import { makeProblem } from '../proto'
import { RpcError, rpcErr } from '../gep/peer'
import type { Candle } from '../types'
import type { StrategyDef, Params } from '../strategy/types'
import { newId } from '../util/hash'
import type { EngineContext } from './context'
import { loadCandles } from './data'
import { DEFAULT_TAKER, MIN_BARS, resolveSpec, type ResolvedSpec } from './spec'

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const invalid = (msg: string): never => { throw rpcErr('INVALID_PARAMS', msg) }

// ---- 注入点 -------------------------------------------------------------------------------

/** 一份完成的产物：summary 不含明细数组，明细放 parts（按 part 名分页）。 */
export interface ResearchOutcome {
  summary: Record<string, unknown>
  parts: Partial<Record<'trials' | 'folds' | 'factors', readonly unknown[]>>
}

export interface OptimizeComputeInput {
  kind: 'optimize'
  /** def = 注册表里的策略；params = 不参与寻优的固定参数（已按策略定义补全默认值）。 */
  strategy: { def: StrategyDef; params: Params }
  candles: Candle[]
  /** 回测选项（initialCash / leverage / feeRate / slippageBps …），与回测作业同一个推法。 */
  sim: Record<string, unknown>
  space: Record<string, unknown>
  search: Record<string, unknown>
  validation: Record<string, unknown>
  seed: number
  metric: string
  warmupBars?: number
}
export interface FactorComputeInput { kind: 'factor_report'; candles: Candle[]; horizon: number; window: number; quantiles: number; top: number }
export type ResearchComputeInput = OptimizeComputeInput | FactorComputeInput

export interface ResearchComputeHandle {
  done: Promise<ResearchOutcome>
  /** 立刻停掉计算（工作线程直接终止）；done 随后 reject 或 resolve 都行，作业表已经把状态标成 cancelled。 */
  cancel(): void
}
export interface ResearchComputeHooks {
  /** done = 已完成的评估次数；total 在知道精确值（折数已定）时更新。 */
  progress(done: number, total?: number): void
}
export interface OptimizeCheck {
  kind: ResearchKind
  space: unknown
  search: unknown
  validation: unknown
  metric: unknown
  /** 策略声明过的参数名（space 里的键必须是它们之一）。 */
  strategyParamKeys: readonly string[]
}

export interface ResearchProvider {
  /** 起作业之前同步校验寻优规格里只有 provider 才懂的部分；返回 { error } = 回 INVALID_PARAMS 且不建作业；{ total } = 预计评估次数（进度分母的初值）。 */
  checkOptimize(plan: OptimizeCheck): { total: number } | { error: string }
  compute(input: ResearchComputeInput, hooks: ResearchComputeHooks): ResearchComputeHandle
}

export interface ResearchOptions {
  provider: ResearchProvider
  maxConcurrent?: number
  /** 内存里保留多少个作业（含终态）。 */
  keep?: number
}

// ---- 作业表 -------------------------------------------------------------------------------

interface PreparedRun {
  total: number
  /** 排到槽位后才调用：装数据 → 计算 → 补全上下文字段。 */
  execute(hooks: ResearchComputeHooks, onHandle: (h: ResearchComputeHandle) => void, cancelled: () => boolean): Promise<ResearchOutcome>
}
interface Job {
  jobId: string
  kind: ResearchKind
  state: BacktestState
  done: number
  total: number
  run: PreparedRun
  handle?: ResearchComputeHandle
  outcome?: ResearchOutcome
  error?: Problem
  createdAt: number
}

const PARTS = ['trials', 'folds', 'factors'] as const
type DetailPart = (typeof PARTS)[number]

/** 摘要超过字节上限时先压缩提示类字段，仍超就如实失败（不静默截断数值）。 */
function fitSummary(summary: Record<string, unknown>, limit: number): Record<string, unknown> {
  const size = (s: unknown): number => Buffer.byteLength(JSON.stringify(s))
  if (size(summary) <= limit) return summary
  const slim = { ...summary }
  for (const key of ['warnings']) if (Array.isArray(slim[key])) slim[key] = (slim[key] as unknown[]).slice(0, 5).map((w) => (typeof w === 'string' ? w.slice(0, 200) : w))
  if (isObj(slim.overfit) && Array.isArray(slim.overfit.missing)) slim.overfit = { ...slim.overfit, missing: slim.overfit.missing.slice(0, 5) }
  if (size(slim) > limit) throw rpcErr('BACKTEST_FAILED', `research summary is ${size(slim)} bytes, over the ${limit}-byte limit`)
  return slim
}

export class ResearchJobs {
  private readonly jobs = new Map<string, Job>()
  private readonly queue: Job[] = []
  private running = 0
  private readonly max: number
  private readonly keep: number

  constructor(private readonly ctx: EngineContext, private readonly o: ResearchOptions, private readonly limits: { maxBars: number }) {
    this.max = o.maxConcurrent ?? 2
    this.keep = o.keep ?? 50
  }

  // ---- 提交 ----
  submit(kindRaw: unknown, specRaw: unknown): { jobId: string; kind: ResearchKind; state: BacktestState } {
    if (typeof kindRaw !== 'string' || !(RESEARCH_KINDS as readonly string[]).includes(kindRaw)) invalid(`kind must be one of ${RESEARCH_KINDS.join(', ')}`)
    const kind = kindRaw as ResearchKind
    if (!isObj(specRaw)) invalid('spec must be an object')
    let spec: Record<string, unknown>
    try { spec = structuredClone(specRaw) as Record<string, unknown> } catch { return invalid('spec could not be cloned') }
    const run = kind === 'factor_report' ? this.prepareFactor(spec) : this.prepareOptimize(kind, spec)
    const job: Job = { jobId: newId('rsh', this.ctx.now()), kind, state: 'queued', done: 0, total: run.total, run, createdAt: this.ctx.now() }
    this.jobs.set(job.jobId, job)
    this.queue.push(job)
    while (this.jobs.size > this.keep) {
      const old = [...this.jobs.values()].find((j) => j.state === 'done' || j.state === 'failed' || j.state === 'cancelled')
      if (!old) break
      this.jobs.delete(old.jobId)
    }
    this.pump()
    return { jobId: job.jobId, kind, state: job.state }
  }

  private prepareOptimize(kind: ResearchKind, spec: Record<string, unknown>): PreparedRun {
    // 与回测同一份规格解析（BacktestSpec）：策略查找 / 固定参数补全 / 窗口 / 假设 / 数据源校验
    const r = resolveSpec(spec, { maxBars: this.limits.maxBars }, this.ctx.strategies)
    if (r.subject.kind !== 'strategy' || !r.subject.strategy) return invalid('only strategies can be optimized (spec.subject.strategy)')
    const { def, params } = r.subject.strategy
    const v = spec.validation
    if (!isObj(v)) return invalid('spec.validation is required: { kind: "holdout", holdoutBars } or { kind: "walk-forward", trainBars, testBars } (an optimization without out-of-sample evidence is not accepted)')
    if (kind === 'walk_forward' && v.kind !== 'walk-forward') return invalid('walk_forward needs spec.validation.kind "walk-forward" (use optimize for a holdout plan)')
    const space = spec.space
    if (!isObj(space)) return invalid('spec.space is required: { <param>: { type: "integer"|"number", min, max, step? } }')
    const search = spec.search === undefined ? { kind: 'grid' } : spec.search
    const metric = spec.metric === undefined ? 'sharpe' : spec.metric
    const seed = spec.seed
    if (!Number.isInteger(seed)) return invalid('spec.seed must be an integer')
    const warmupBars = spec.warmupBars
    if (warmupBars !== undefined && (!Number.isInteger(warmupBars) || (warmupBars as number) < 0)) return invalid('spec.warmupBars must be a non-negative integer')
    const checked = this.o.provider.checkOptimize({ kind, space, search, validation: v, metric, strategyParamKeys: def.params.map((p) => p.key) })
    if ('error' in checked) return invalid(checked.error)
    const input = (candles: Candle[], sim: Record<string, unknown>): OptimizeComputeInput => ({
      kind: 'optimize', strategy: { def, params }, candles, sim, space, search: search as Record<string, unknown>, validation: v, seed: seed as number, metric: metric as string,
      ...(warmupBars !== undefined ? { warmupBars: warmupBars as number } : {}),
    })
    return {
      total: checked.total,
      execute: async (hooks, onHandle, cancelled) => {
        const data = await this.load(r)
        const { sim, warnings: simWarnings } = await this.simOf(r)
        if (cancelled()) throw new Error('cancelled')
        const handle = this.o.provider.compute(input(data.candles, sim), hooks)
        onHandle(handle)
        const out = await handle.done
        const extra = [...r.warnings, ...data.warnings, ...simWarnings]
        if (r.spec.assumptions.funding === true) extra.push('funding is not applied in optimization runs (assumptions.funding was requested)')
        return this.withContext(out, {
          strategy: { id: def.id, version: def.version, fixedParams: params }, instrumentId: r.instrumentId, interval: r.interval, bars: data.candles.length,
          assumptions: { fees: r.assumptions.fees, slippageBps: r.slippageBps, fillModel: r.assumptions.fillModel, funding: false, liquidation: r.assumptions.liquidation, initialBalance: r.spec.account.initialBalance, ccy: r.spec.account.ccy, leverage: r.leverage, seed },
        }, extra)
      },
    }
  }

  private prepareFactor(spec: Record<string, unknown>): PreparedRun {
    // 因子报告没有策略 / 账户 / 假设：只借回测的数据入口，自己校验 instruments / interval / from / to / data
    const ins = spec.instruments
    if (!Array.isArray(ins) || ins.length !== 1 || typeof ins[0] !== 'string' || !/^[a-z0-9][a-z0-9-]*:.+$/.test(ins[0])) invalid('spec.instruments must contain exactly one instrumentId (a factor report covers one instrument)')
    const { interval, from, to, data } = spec
    if (typeof interval !== 'string') invalid('spec.interval is required')
    if (!Number.isInteger(from) || !Number.isInteger(to) || (from as number) < 0 || (to as number) <= (from as number)) invalid('spec.from / spec.to must be integer milliseconds with from < to')
    if (!isObj(data) || !['host', 'files'].includes(data.source as string)) invalid('spec.data.source must be host or files')
    const ds = data as { source: string; files?: unknown }
    if (ds.source === 'files' && (!Array.isArray(ds.files) || ds.files.length < 1 || ds.files.length > 2)) invalid('spec.data.files must hold one candles entry { path, sha256, format }')
    const int = (name: string, def: number, max: number): number => {
      const x = spec[name] === undefined ? def : spec[name]
      if (!Number.isInteger(x) || (x as number) < 1 || (x as number) > max) invalid(`spec.${name} must be an integer in [1, ${max}]`)
      return x as number
    }
    const horizon = int('horizon', 5, 1000)
    const window = int('window', 60, 100_000)
    const quantiles = int('quantiles', 5, 100)
    const top = int('top', 20, 1000)
    // loadCandles 只读 spec.data / instrumentId / interval / from / to：用同形的最小对象，不去凑策略 / 账户 / 假设
    const r = { spec: { data }, instrumentId: (ins as string[])[0]!, interval: interval as string, from: from as number, to: to as number } as unknown as ResolvedSpec
    return {
      total: 1,
      execute: async (hooks, onHandle, cancelled) => {
        const d = await this.load(r)
        if (cancelled()) throw new Error('cancelled')
        const handle = this.o.provider.compute({ kind: 'factor_report', candles: d.candles, horizon, window, quantiles, top }, hooks)
        onHandle(handle)
        const out = await handle.done
        return this.withContext(out, { instrumentId: r.instrumentId, interval: r.interval, bars: d.candles.length }, d.warnings)
      },
    }
  }

  private async load(r: ResolvedSpec): Promise<{ candles: Candle[]; warnings: string[] }> {
    const data = await loadCandles(r, this.ctx.host, this.limits.maxBars)
    if (data.candles.length < MIN_BARS) throw rpcErr('DATA_UNAVAILABLE', `only ${data.candles.length} bars in range; at least ${MIN_BARS} are needed`)
    return { candles: data.candles, warnings: data.warnings }
  }

  /** 回测选项：与 backtest-jobs.ts 同一个推法（initialCash / leverage / taker 费率 / 滑点，强平另加）。 */
  private async simOf(r: ResolvedSpec): Promise<{ sim: Record<string, unknown>; warnings: string[] }> {
    const warnings: string[] = []
    let feeRate: number
    if (r.feeRate === 'venue') {
      feeRate = DEFAULT_TAKER
      try {
        const ins = (await this.ctx.host.instruments([r.instrumentId])).find((i) => i.instrumentId === r.instrumentId)
        if (ins?.fees?.taker !== undefined) feeRate = Number(ins.fees.taker)
        else warnings.push(`fees "venue": host gave no fee schedule; default taker ${DEFAULT_TAKER} used`)
      } catch { warnings.push(`fees "venue": host.instruments unavailable; default taker ${DEFAULT_TAKER} used`) }
    } else feeRate = r.feeRate
    const sim: Record<string, unknown> = { initialCash: r.initialCash, leverage: r.leverage, feeRate, slippageBps: r.slippageBps }
    if (r.spec.assumptions.liquidation === true) {
      const mmr = r.spec.account.maintenanceMarginRatio
      const penalty = r.spec.assumptions.liquidationPenaltyRatio
      sim.liquidation = true
      sim.maintenanceMarginRatio = typeof mmr === 'number' && Number.isFinite(mmr) && mmr >= 0 ? mmr : 0.5 / r.leverage
      sim.liquidationPenaltyRatio = typeof penalty === 'number' && Number.isFinite(penalty) && penalty >= 0 ? penalty : 0
    }
    const share = r.spec.assumptions.maxVolumeShare
    if (typeof share === 'number' && Number.isFinite(share) && share >= 0 && share <= 1) sim.maxVolumeShare = share
    return { sim, warnings }
  }

  private withContext(out: ResearchOutcome, ctx: Record<string, unknown>, extraWarnings: string[]): ResearchOutcome {
    const own = Array.isArray(out.summary.warnings) ? (out.summary.warnings as string[]) : []
    return { summary: { ...ctx, ...out.summary, warnings: [...extraWarnings, ...own], hypothetical: true }, parts: out.parts }
  }

  // ---- 执行 ----
  private pump(): void {
    while (this.running < this.max && this.queue.length > 0) {
      const j = this.queue.shift()!
      if (j.state !== 'queued') continue
      this.running += 1
      void this.start(j).finally(() => { this.running -= 1; this.pump() })
    }
  }

  private async start(j: Job): Promise<void> {
    j.state = 'running'
    try {
      const out = await j.run.execute(
        { progress: (done, total) => { if (j.state === 'running') { if (total !== undefined && total > 0) j.total = total; j.done = Math.min(done, j.total) } } },
        (h) => { j.handle = h; if (j.state === 'cancelled') h.cancel() },
        () => j.state !== 'running',
      )
      if (j.state !== 'running') return
      j.outcome = out
      j.done = j.total
      j.state = 'done'
    } catch (e) {
      if (j.state !== 'running') return
      j.state = 'failed'
      j.error = e instanceof RpcError ? e.problem : makeProblem('BACKTEST_FAILED', e instanceof Error ? e.message : 'research job failed')
      // 参数类问题如实回 INVALID_PARAMS，其余协议类一律归为作业失败（与回测作业同口径）
      if (j.error.category === 'PROTOCOL' && j.error.name !== 'INVALID_PARAMS') j.error = makeProblem('BACKTEST_FAILED', j.error.message)
      this.ctx.log('warn', 'research job failed', { jobId: j.jobId, kind: j.kind, code: j.error.code })
    } finally {
      j.handle = undefined
    }
  }

  private need(jobId: unknown): Job {
    const j = typeof jobId === 'string' ? this.jobs.get(jobId) : undefined
    if (!j) throw rpcErr('INVALID_PARAMS', 'unknown jobId')
    return j
  }

  status(jobId: unknown): { jobId: string; kind: ResearchKind; state: BacktestState; progress: { done: number; total: number } } {
    const j = this.need(jobId)
    return { jobId: j.jobId, kind: j.kind, state: j.state, progress: { done: j.done, total: j.total } }
  }

  cancel(jobId: unknown): { jobId: string; kind: ResearchKind; state: BacktestState } {
    const j = this.need(jobId)
    if (j.state === 'queued') { j.state = 'cancelled'; this.queue.splice(this.queue.indexOf(j), 1) }
    else if (j.state === 'running') { j.state = 'cancelled'; j.handle?.cancel() }
    return { jobId: j.jobId, kind: j.kind, state: j.state }
  }

  /** summary（缺省）或一页明细；未完成 BUSY，失败回作业的 problem，取消后回错误。 */
  result(jobId: unknown, partRaw?: unknown, limitRaw?: unknown, cursorRaw?: unknown): unknown {
    const j = this.need(jobId)
    if (j.state === 'failed') throw new RpcError(j.error!)
    if (j.state === 'cancelled') throw rpcErr('BACKTEST_FAILED', 'job was cancelled')
    if (j.state !== 'done') throw rpcErr('BUSY', `job is ${j.state}; poll x-gitrader.research.status`, { retryable: true, retryAfterMs: 500 })
    const out = j.outcome!
    const counts: Record<string, number> = {}
    for (const p of PARTS) if (out.parts[p]) counts[p] = out.parts[p]!.length
    const part = partRaw === undefined || partRaw === null || partRaw === '' ? 'summary' : partRaw
    if (part === 'summary') return fitSummary({ jobId: j.jobId, kind: j.kind, ...out.summary, counts }, RESEARCH_LIMITS.summaryMaxBytes)
    if (typeof part !== 'string' || !(PARTS as readonly string[]).includes(part)) return invalid(`part must be one of summary, ${PARTS.join(', ')}`)
    const items = out.parts[part as DetailPart]
    if (!items) return invalid(`part "${part}" is not available for a ${j.kind} job (it has: ${Object.keys(counts).join(', ') || 'summary only'})`)
    const lim = limitRaw === undefined ? RESEARCH_LIMITS.defaultLimit : Number(limitRaw)
    if (!Number.isInteger(lim) || lim < 1 || lim > RESEARCH_LIMITS.maxLimit) return invalid(`limit must be an integer in [1, ${RESEARCH_LIMITS.maxLimit}]`)
    const off = cursorRaw === undefined ? 0 : Number(cursorRaw)
    if (!Number.isInteger(off) || off < 0 || off > items.length) return invalid('cursor is not valid for this job')
    // 每页按序列化长度装，装满 pageMaxChars 就停并给 next（服务端少给几条，绝不截断单条）
    const page: unknown[] = []
    let chars = 0
    for (let i = off; i < items.length && page.length < lim; i++) {
      const len = JSON.stringify(items[i]).length + 1
      if (page.length > 0 && chars + len > RESEARCH_LIMITS.pageMaxChars) break
      page.push(items[i])
      chars += len
    }
    const end = off + page.length
    return { items: page, total: items.length, ...(end < items.length ? { next: String(end) } : {}) }
  }

  /** 引擎关闭：终止所有在跑的计算。 */
  close(): void {
    for (const j of this.jobs.values()) if (j.state === 'running' || j.state === 'queued') { j.state = 'cancelled'; j.handle?.cancel() }
    this.queue.length = 0
  }
}
