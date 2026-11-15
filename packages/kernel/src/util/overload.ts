// SPDX-License-Identifier: CPAL-1.0
// ADR-27：只读 / 预检类 op 的全局在途上限，以及事件循环延迟过高时的短时卸载。
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { makeProblem } from '../proto'
import { KernelError } from './errors'

export interface OverloadOptions { maxInflight?: number; loopDelayShedMs?: number; sampleLoopDelay?: () => number; /** 每个调用方每秒的公平份额（默认 10）：不超过份额的调用方不被卸载。 */ fairPerSecond?: number }

const DEFAULT_MAX_INFLIGHT = 32
const DEFAULT_LOOP_DELAY_SHED_MS = 200
const RETRY_AFTER_MS = 250

interface Sampler { sample: () => number; close: () => void }

/** 默认采样：perf_hooks 直方图取 p99，取完就 reset，下一次看到的是新窗口。 */
function histogramSampler(): Sampler {
  const histogram = monitorEventLoopDelay({ resolution: 20 })
  histogram.enable()
  return {
    sample: () => {
      const p99Ms = histogram.percentile(99) / 1e6
      histogram.reset()
      return Number.isFinite(p99Ms) ? p99Ms : 0
    },
    close: () => { histogram.disable() },
  }
}

export class OverloadGuard {
  private readonly maxInflight: number
  private readonly loopDelayShedMs: number
  private readonly sampler?: Sampler
  private readonly sample: () => number
  private inflight = 0
  private shedding = false
  private lastLoopDelayP99Ms = 0
  private rejected = 0
  /** 本秒（两次 tick 之间）每个调用方的调用数；超过 fairPerSecond 才会被卸载 / 受在途上限约束。 */
  private readonly perCaller = new Map<string, number>()
  private readonly fairPerSecond: number
  private closed = false

  constructor(o: OverloadOptions = {}) {
    const maxInflight = o.maxInflight ?? DEFAULT_MAX_INFLIGHT
    const loopDelayShedMs = o.loopDelayShedMs ?? DEFAULT_LOOP_DELAY_SHED_MS
    if (!Number.isInteger(maxInflight) || maxInflight < 1) throw new TypeError('overload maxInflight must be a positive integer')
    if (!Number.isFinite(loopDelayShedMs) || loopDelayShedMs < 0) throw new TypeError('overload loopDelayShedMs must be a non-negative number')
    this.maxInflight = maxInflight
    this.fairPerSecond = o.fairPerSecond ?? 10
    this.loopDelayShedMs = loopDelayShedMs
    if (o.sampleLoopDelay) this.sample = o.sampleLoopDelay
    else {
      const sampler = histogramSampler()
      this.sampler = sampler
      this.sample = sampler.sample
    }
  }

  /** 只读 / 预检类进入：超过在途上限或正在卸载 → 抛 BUSY（retryable，retryAfterMs 250）；否则在途 +1 并返回释放函数（幂等）。 */
  enter(cls: 'readOnly' | 'default', caller = ''): () => void {
    // 公平：只卸载「本秒调用数超过公平份额」的调用方（ADR-27「不让一把钥匙拖垮别人」）；正常节奏的钥匙在过载时照常通过
    const seen = (this.perCaller.get(caller) ?? 0) + 1
    this.perCaller.set(caller, seen)
    const heavy = caller === '' || seen > this.fairPerSecond
    // 事件循环卸载只针对只读类；预检 / 其它非豁免调用只受在途上限约束
    if (heavy && this.shedding && cls === 'readOnly') {
      this.rejected += 1
      throw this.busyDelay()
    }
    if (heavy && this.inflight >= this.maxInflight) {
      this.rejected += 1
      throw this.busyCap()
    }
    this.inflight += 1
    let released = false
    return () => {
      if (released) return
      released = true
      this.inflight = Math.max(0, this.inflight - 1)
    }
  }

  /** 每秒调用一次：取事件循环延迟 p99（毫秒），超过阈值则到下一次 tick 之前卸载只读 / 预检。 */
  tick(): void {
    if (this.closed) return
    let p99Ms: number
    try { p99Ms = this.sample() } catch { return }
    this.lastLoopDelayP99Ms = Number.isFinite(p99Ms) && p99Ms > 0 ? p99Ms : 0
    // 超过阈值才卸载（等于阈值不算）；下一次 tick 重新采样，恢复服务。
    this.shedding = this.lastLoopDelayP99Ms > this.loopDelayShedMs
    this.perCaller.clear()
  }

  stats(): { inflight: number; shedding: boolean; lastLoopDelayP99Ms: number; rejected: number } {
    return { inflight: this.inflight, shedding: this.shedding, lastLoopDelayP99Ms: this.lastLoopDelayP99Ms, rejected: this.rejected }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.shedding = false
    this.sampler?.close()
  }

  private busyCap(): KernelError {
    return new KernelError(makeProblem('BUSY', `kernel busy: too many concurrent read-only calls (limit ${this.maxInflight})`, { retryAfterMs: RETRY_AFTER_MS }))
  }

  private busyDelay(): KernelError {
    return new KernelError(makeProblem('BUSY', `kernel busy: event loop delay p99 ${this.lastLoopDelayP99Ms} ms is over ${this.loopDelayShedMs} ms`, { retryAfterMs: RETRY_AFTER_MS }))
  }
}
