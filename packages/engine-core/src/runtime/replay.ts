// SPDX-License-Identifier: CPAL-1.0
// 历史回放（replay.start / stop / status）：把历史 K 线一根一根喂给策略，每根只用「截止这一根之前已收盘」的数据重算信号，
// 成交用与回测同一个 Simulator（成交模型 next-bar-open）。因为回放不能偷看后面的 K 线，
// 它的成交序列与回测逐笔一致，本身就是对回测前视偏差的一次独立复核（一致性测试 O5）。
import type { Problem } from '../proto'
import { makeProblem } from '../proto'
import { RpcError, rpcErr } from '../gep/peer'
import type { Candle } from '../types'
import { evaluateStrategy, Simulator } from '../strategy'
import type { BacktestTrade } from '../strategy/types'
import { workflowSignalSeries } from '../flow'
import { newId } from '../util/hash'
import type { EngineContext } from './context'
import { loadCandles } from './data'
import { DEFAULT_TAKER, MIN_BARS, resolveSpec, type ResolvedSpec } from './spec'

export type ReplayRunState = 'running' | 'paused' | 'done' | 'stopped'

interface Replay {
  replayId: string
  state: ReplayRunState
  clock: number
  /** 已回放的 K 线数 / 总数。 */
  done: number
  total: number
  fills: BacktestTrade[]
  equity: number | null
  stop: boolean
  error?: Problem
  resolved: ResolvedSpec
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r))

export interface ReplayOptions { maxBars?: number; maxWorkflowBars?: number; chunk?: number; keep?: number }

export class ReplayManager {
  private readonly items = new Map<string, Replay>()
  private readonly o: Required<ReplayOptions>

  constructor(private readonly ctx: EngineContext, opts: ReplayOptions = {}) {
    // 前缀重算是 O(n²)：策略上限 20,000 根，工作流 3,000 根
    this.o = { maxBars: opts.maxBars ?? 20_000, maxWorkflowBars: opts.maxWorkflowBars ?? 3_000, chunk: opts.chunk ?? 100, keep: opts.keep ?? 20 }
  }

  start(rawSpec: unknown): string {
    const resolved = resolveSpec(rawSpec, { maxBars: this.o.maxBars }, this.ctx.strategies)
    const rp: Replay = { replayId: newId('rpl', this.ctx.now()), state: 'running', clock: resolved.from, done: 0, total: 0, fills: [], equity: null, stop: false, resolved }
    this.items.set(rp.replayId, rp)
    while (this.items.size > this.o.keep) {
      const old = [...this.items.values()].find((x) => x.state === 'done' || x.state === 'stopped')
      if (!old) break
      this.items.delete(old.replayId)
    }
    void this.run(rp)
    return rp.replayId
  }

  private need(id: unknown): Replay {
    const r = typeof id === 'string' ? this.items.get(id) : undefined
    if (!r) throw rpcErr('INVALID_PARAMS', 'unknown replayId')
    return r
  }

  stop(id: unknown): { state: ReplayRunState } {
    const r = this.need(id)
    if (r.state === 'running') r.stop = true
    return { state: r.stop && r.state === 'running' ? 'running' : r.state }
  }

  /** 协议 ReplayState + 追加的 x- 字段：进度、已成交序列（按回测 trades 同形）、权益、错误。 */
  status(id: unknown): Record<string, unknown> {
    const r = this.need(id)
    return {
      replayId: r.replayId, state: r.state, clock: r.clock,
      'x-progress': r.total > 0 ? Number((r.done / r.total).toFixed(4)) : 0,
      'x-fills': r.fills, 'x-equity': r.equity, ...(r.error ? { 'x-error': r.error } : {}),
    }
  }

  private async run(rp: Replay): Promise<void> {
    const r = rp.resolved
    try {
      const data = await loadCandles(r, this.ctx.host, this.o.maxBars)
      const candles = data.candles
      const cap = r.subject.kind === 'workflow' ? this.o.maxWorkflowBars : this.o.maxBars
      if (candles.length < MIN_BARS) throw rpcErr('DATA_UNAVAILABLE', `only ${candles.length} bars in range; at least ${MIN_BARS} are needed`)
      if (candles.length > cap) throw rpcErr('INVALID_PARAMS', `replay of a ${r.subject.kind} is limited to ${cap} bars in this engine (asked ${candles.length})`)
      rp.total = candles.length
      let feeRate = r.feeRate === 'venue' ? DEFAULT_TAKER : r.feeRate
      if (r.feeRate === 'venue') {
        try { const [ins] = await this.ctx.host.instruments([r.instrumentId]); if (ins?.fees?.taker !== undefined) feeRate = Number(ins.fees.taker) } catch { /* 默认费率 */ }
      }
      const sim = new Simulator({ initialCash: r.initialCash, leverage: r.leverage, feeRate, slippageBps: r.slippageBps })
      const params = r.subject.kind === 'strategy' ? (r.subject.strategy!.def.anchor ? r.subject.strategy!.def.anchor(candles.slice(0, 1), r.subject.strategy!.params) : r.subject.strategy!.params) : {}
      const opts = { instrumentId: r.instrumentId, interval: r.interval }
      const targetAt = async (prefix: Candle[]): Promise<{ want: number | null; reason: string }> => {
        // prefix = 截止上一根（含）的全部已收盘 K 线；信号取它的最后一根
        const s = r.subject.kind === 'strategy' ? evaluateStrategy(r.subject.strategy!.def, prefix, params).series : (await workflowSignalSeries(r.subject.workflow!, prefix, opts)).series
        const last = prefix.length - 1
        return last >= s.warmup ? { want: s.target[last]!, reason: s.reasons[last] || '' } : { want: null, reason: '' }
      }
      for (let i = 0; i < candles.length; i++) {
        const sig = i > 0 ? await targetAt(candles.slice(0, i)) : { want: null, reason: '' }
        const fill = sim.onBar(i, candles[i]!, sig.want, sig.reason)
        rp.done = i + 1
        rp.clock = candles[i]!.t + r.intervalMs
        rp.equity = sim.equity[sim.equity.length - 1]!.v
        if (fill) {
          rp.fills.push(fill)
          this.ctx.emit({ stream: 'backtest', type: 'backtest.replay_fill', ts: rp.clock, key: `${rp.replayId}:${fill.t}`, data: { replayId: rp.replayId, fill }, origin: this.ctx.origin('replay') })
        }
        if ((i + 1) % this.o.chunk === 0) {
          this.ctx.emit({ stream: 'backtest', type: 'backtest.replay_progress', ts: rp.clock, key: rp.replayId, data: { replayId: rp.replayId, clock: rp.clock, progress: Number((rp.done / rp.total).toFixed(4)) }, origin: this.ctx.origin('replay') })
          await tick()
        }
        if (rp.stop) { rp.state = 'stopped'; return }
      }
      rp.state = 'done'
      this.ctx.emit({ stream: 'backtest', type: 'backtest.replay_done', ts: rp.clock, key: rp.replayId, data: { replayId: rp.replayId, fills: rp.fills.length }, origin: this.ctx.origin('replay') })
    } catch (e) {
      rp.error = e instanceof RpcError ? e.problem : makeProblem('BACKTEST_FAILED', e instanceof Error ? e.message : 'replay failed')
      rp.state = 'stopped'
      this.ctx.log('warn', 'replay failed', { replayId: rp.replayId, code: rp.error.code })
    }
  }
}
