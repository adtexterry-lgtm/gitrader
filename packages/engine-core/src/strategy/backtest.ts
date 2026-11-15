// SPDX-License-Identifier: CPAL-1.0
// 同步回测入口（策略 → 信号序列 → Simulator）。GEP 的异步任务封装在 runtime/backtest-jobs.ts。
import type { Candle } from '../types'
import { evaluateStrategy } from './runtime'
import { Simulator, inferIntervalMs, type SimOpenPosition, type SimOptions, type SimStats } from './simulator'
import type { BacktestTrade, Params, SignalSeries, StrategyDef } from './types'

/** 已结算的资金费明细一条（paid 正数为支出）。 */
export interface SimFundingEntry { t: number; rate: number; notional: number; paid: number }

export interface SimulationOutput {
  stats: SimStats
  equity: Array<{ t: number; v: number }>
  trades: BacktestTrade[]
  /** 已结算的资金费明细（t 升序）；没有结算时为空数组。 */
  funding: SimFundingEntry[]
  candlesUsed: number
  openPosition: SimOpenPosition | null
  overlays: SignalSeries['overlays']
  series: SignalSeries
}
export interface BacktestRun extends SimulationOutput { params: Params }

export interface BacktestRunOptions extends Partial<SimOptions> {
  /** K 线周期（毫秒），缺省按相邻 K 线间隔推断。 */
  intervalMs?: number
}

export function resolveSimOptions(o: BacktestRunOptions = {}): SimOptions {
  const out: SimOptions = {
    initialCash: o.initialCash !== undefined && o.initialCash > 0 ? o.initialCash : 10_000,
    leverage: o.leverage !== undefined && o.leverage > 0 ? o.leverage : 1,
    feeRate: o.feeRate !== undefined && o.feeRate >= 0 ? o.feeRate : 0.00045,
    slippageBps: o.slippageBps !== undefined && o.slippageBps >= 0 ? o.slippageBps : 2,
  }
  // 资金费 / 强平 / 成交量上限：只在给了的时候透传，缺省行为与模拟器一致（关闭 / 不设限）
  if (o.funding !== undefined) {
    out.funding = o.funding
      .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.rate))
      .map((p) => ({ t: p.t, rate: p.rate }))
      .sort((a, b) => a.t - b.t)
  }
  if (o.liquidation !== undefined) out.liquidation = o.liquidation
  if (o.maintenanceMarginRatio !== undefined) out.maintenanceMarginRatio = o.maintenanceMarginRatio
  if (o.maxVolumeShare !== undefined) out.maxVolumeShare = o.maxVolumeShare
  if (o.liquidationPenaltyRatio !== undefined) out.liquidationPenaltyRatio = o.liquidationPenaltyRatio
  // 成交模式：全量透传，由 Simulator 校验（缺 'book' 所需数据 / 选项冲突都在那里报错，不在这里猜）
  if (o.fillMode !== undefined) out.fillMode = o.fillMode
  if (o.bookFeed !== undefined) out.bookFeed = o.bookFeed
  return out
}

/**
 * 信号序列入口断言（审计 L4-02 / G18）：simulateSeries 是导出的公共入口，
 * flow/graph.ts 的 workflowSignalSeries 会把主信号未经有限性校验直接交进来，
 * 所以这里必须自己拦住非有限 / 缺失 / 越界的 target，而不是让 Infinity 进账本。
 */
function assertTargets(series: SignalSeries, bars: number): void {
  if (!Array.isArray(series.target)) {
    throw new RangeError('simulateSeries: series.target must be an array of numbers')
  }
  if (series.target.length !== bars) {
    throw new RangeError(`simulateSeries: series.target has ${series.target.length} entries but there are ${bars} candles`)
  }
  for (let i = 0; i < series.target.length; i++) {
    const v = series.target[i]
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new RangeError(`simulateSeries: series.target[${i}] is not a finite number (${String(v)})`)
    }
    if (v < -1 || v > 1) {
      throw new RangeError(`simulateSeries: series.target[${i}] is outside [-1, 1] (${String(v)})`)
    }
  }
}

/** 把一条已算好的信号序列按 next-bar-open 撮合（策略 / 工作流共用）。 */
export function simulateSeries(series: SignalSeries, candles: readonly Candle[], opts: BacktestRunOptions = {}, notionalCap?: number): SimulationOutput {
  assertTargets(series, candles.length)
  const sim = new Simulator(resolveSimOptions(opts))
  const stepMs = opts.intervalMs && opts.intervalMs > 0 ? opts.intervalMs : inferIntervalMs(candles)
  for (let i = 0; i < candles.length; i++) {
    const hasSignal = i > 0 && i - 1 >= series.warmup
    sim.onBar(i, candles[i]!, hasSignal ? series.target[i - 1]! : null, hasSignal ? series.reasons[i - 1] || '' : '', notionalCap)
  }
  return {
    stats: sim.stats(candles, stepMs), equity: sim.equity, trades: sim.trades, funding: sim.funding, candlesUsed: candles.length,
    openPosition: sim.openPosition(candles[candles.length - 1]), overlays: series.overlays, series,
  }
}

export function runBacktest(def: StrategyDef, candles: readonly Candle[], paramsIn: Record<string, unknown> | undefined, opts: BacktestRunOptions = {}): BacktestRun {
  // 先调用策略的参数校验钩子（缺参或越界拒绝）
  if (def.validateParams) {
    try {
      def.validateParams((paramsIn ?? {}) as Params)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      throw new Error(`INVALID_PARAMS: ${msg}`)
    }
  }
  const { params, series } = evaluateStrategy(def, candles as Candle[], paramsIn)
  const cap = def.notionalCap ? def.notionalCap(params) : undefined
  return { ...simulateSeries(series, candles, opts, cap), params }
}
