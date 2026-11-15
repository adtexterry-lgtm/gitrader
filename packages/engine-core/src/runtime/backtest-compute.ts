// SPDX-License-Identifier: CPAL-1.0
// 回测纯计算函数（GQ-03：抽出来以便放进工作线程，不阻塞心跳）
import type { Candle } from '../types'
import type { Params, StrategyDef } from '../strategy/types'
import type { SignalSeries } from '../strategy/types'
import type { Workflow } from '../flow/types'
import { evaluateStrategy, Simulator, type SimOptions, type SimOpenPosition, type SimStats } from '../strategy'
import { workflowSignalSeries } from '../flow'
import { lookaheadCheck, type LookaheadResult } from '../strategy/bias'

export type ComputeSubject =
  | { kind: 'strategy'; def: StrategyDef; params: Params }
  | { kind: 'workflow'; workflow: Workflow; instrumentId: string; interval: string }

export interface ComputeInput {
  subject: ComputeSubject
  candles: Candle[]
  sim: SimOptions
  stepMs: number
}

export interface ComputeOutput {
  lookahead: LookaheadResult
  stats: SimStats
  equity: Simulator['equity']
  trades: Simulator['trades']
  funding: Simulator['funding']
  openPosition: SimOpenPosition | null
  annualizedUnavailable: boolean
  cash: number
  pos: number
  entry: number
  shortfalls: Array<{ t: number; amount: number }>
  statNotes: readonly string[]
}

export interface ComputeHooks {
  stage(s: 'signals' | 'simulating', fraction: number): void
  cancelled(): boolean
  yieldLoop(): Promise<void>
}

/**
 * 回测纯计算：信号序列 → 撮合 → 统计，不依赖外部 I/O。
 * 取消返回 null；否则返回完整计算输出（供主线程写结果）。
 */
export async function computeBacktest(i: ComputeInput, h: ComputeHooks): Promise<ComputeOutput | null> {
  // 信号序列
  h.stage('signals', 0)
  let series: SignalSeries
  let lookahead: LookaheadResult
  let cap: number | undefined
  if (i.subject.kind === 'strategy') {
    const { def, params: base } = i.subject
    // validateParams 已在 runCompute（主线程）检查，这里仅作防御性二次检查（同线程分支或直接调用）
    if (def.validateParams) {
      try {
        def.validateParams(base)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        throw new Error(`INVALID_PARAMS: ${msg}`)
      }
    }
    // 网格等带锚点的策略：回测以区间第一根为锚（Demo 同）
    const params = def.anchor ? def.anchor(i.candles.slice(0, 1), base) : base
    series = evaluateStrategy(def, i.candles, params).series
    lookahead = await lookaheadCheck((cs) => def.evaluate(cs, params), i.candles)
    cap = def.notionalCap ? def.notionalCap(params) : undefined
  } else {
    const wf = i.subject.workflow
    const opts = { instrumentId: i.subject.instrumentId, interval: i.subject.interval }
    const result = await workflowSignalSeries(wf, i.candles, opts)
    series = result.series
    lookahead = await lookaheadCheck(async (cs) => (await workflowSignalSeries(wf, cs, opts)).series, i.candles, { window: 2000 })
  }
  if (h.cancelled()) return null
  h.stage('simulating', 0)

  // 撮合：分片推进
  const sim = new Simulator(i.sim)
  const n = i.candles.length
  const chunk = 20_000
  for (let idx = 0; idx < n; idx += chunk) {
    const end = Math.min(n, idx + chunk)
    for (let k = idx; k < end; k++) {
      const hasSignal = k > 0 && k - 1 >= series.warmup
      sim.onBar(k, i.candles[k]!, hasSignal ? series.target[k - 1]! : null, hasSignal ? series.reasons[k - 1] || '' : '', cap)
    }
    h.stage('simulating', end / n)
    await h.yieldLoop()
    if (h.cancelled()) return null
  }

  const stats = sim.stats(i.candles, i.stepMs)
  // stats() 之后才能读 annualizedUnavailable（stats() 会设置它）
  const annualizedUnavailable = sim.annualizedUnavailable
  const op = sim.openPosition(i.candles[n - 1])

  return {
    lookahead,
    stats,
    equity: sim.equity,
    trades: sim.trades,
    funding: sim.funding,
    openPosition: op,
    annualizedUnavailable,
    cash: sim.cash,
    pos: sim.pos,
    entry: sim.entry,
    shortfalls: sim.shortfalls,
    statNotes: sim.statNotes,
  }
}
