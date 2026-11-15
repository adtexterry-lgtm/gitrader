// SPDX-License-Identifier: CPAL-1.0
// 单源熔断器：closed → 连续失败达阈值 → open → 冷却到期 → half_open → 成功 closed / 失败 open。

export type CircuitBreakerState = 'closed' | 'open' | 'half_open'

export interface CircuitBreakerOptions {
  failureThreshold: number
  cooldownMs: number
  halfOpenMaxCalls?: number
  clock?: () => number
}

export interface CircuitBreakerStats {
  failures: number
  openedAt: number | null
  opens: number
}

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/data_sources/circuit_breaker.py:31-164; adapted.
export class CircuitBreaker {
  private readonly failureThreshold: number
  private readonly cooldownMs: number
  private readonly halfOpenMaxCalls: number
  private readonly clock: () => number

  private current: CircuitBreakerState = 'closed'
  private failureCount = 0
  private openedAtValue: number | null = null
  private openCount = 0
  private halfOpenCalls = 0

  constructor(opts: CircuitBreakerOptions) {
    this.failureThreshold = opts.failureThreshold
    this.cooldownMs = opts.cooldownMs
    this.halfOpenMaxCalls = opts.halfOpenMaxCalls ?? 1
    this.clock = opts.clock ?? (() => Date.now())
  }

  state(): CircuitBreakerState {
    return this.current
  }

  /** open 且未到冷却期 → false；到期 → 转 half_open，放行最多 halfOpenMaxCalls 次。 */
  allow(): boolean {
    if (this.current === 'open') {
      if (this.openedAtValue === null) return false
      if (this.clock() - this.openedAtValue < this.cooldownMs) return false
      this.current = 'half_open'
      this.halfOpenCalls = 0
    }
    if (this.current === 'closed') return true
    if (this.halfOpenCalls >= this.halfOpenMaxCalls) return false
    this.halfOpenCalls += 1
    return true
  }

  /** half_open 成功 → closed，计数清零。 */
  onSuccess(): void {
    this.current = 'closed'
    this.failureCount = 0
    this.openedAtValue = null
    this.halfOpenCalls = 0
  }

  /**
   * 归还 half_open 的在途许可：探针请求结果不确定（错误不计失败，如其余 4xx / 解析失败 / 中止）时调用。
   * 只在 half_open 且有在途许可时把在途计数减一；状态与失败计数都不变，其他状态下为空操作。
   */
  release(): void {
    if (this.current !== 'half_open') return
    if (this.halfOpenCalls <= 0) return
    this.halfOpenCalls -= 1
  }

  /** closed 连续失败达阈值 → open；half_open 失败 → open 并重置冷却。 */
  onFailure(): void {
    this.failureCount += 1
    if (this.current === 'half_open') {
      this.trip()
      return
    }
    if (this.current === 'closed' && this.failureCount >= this.failureThreshold) this.trip()
  }

  stats(): CircuitBreakerStats {
    return { failures: this.failureCount, openedAt: this.openedAtValue, opens: this.openCount }
  }

  private trip(): void {
    this.current = 'open'
    this.openedAtValue = this.clock()
    this.openCount += 1
    this.halfOpenCalls = 0
  }
}
