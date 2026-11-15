// SPDX-License-Identifier: CPAL-1.0
/** Synchronous sliding-window budget for outbound WebSocket frames. */
export interface HlWsSendBudgetOptions {
  clock?: () => number
  limit?: number
  windowMs?: number
}

export class HlWsSendBudget {
  private readonly sentAt: number[] = []
  private readonly clock: () => number
  private readonly limit: number
  private readonly windowMs: number

  constructor(options: HlWsSendBudgetOptions = {}) {
    this.clock = options.clock ?? (() => Date.now())
    this.limit = options.limit ?? 2000
    this.windowMs = options.windowMs ?? 60_000
    if (!Number.isSafeInteger(this.limit) || this.limit <= 0) throw new RangeError('limit must be a positive safe integer')
    if (!Number.isFinite(this.windowMs) || this.windowMs <= 0) throw new RangeError('windowMs must be positive')
  }

  tryAcquire(): boolean {
    const now = this.clock()
    this.expire(now)
    if (this.sentAt.length >= this.limit) return false
    this.sentAt.push(now)
    return true
  }

  /** Milliseconds until the oldest charge expires, or zero when a slot is free. */
  remainingWaitMs(): number {
    const now = this.clock()
    this.expire(now)
    if (this.sentAt.length < this.limit) return 0
    return Math.max(0, this.sentAt[0]! + this.windowMs - now)
  }

  private expire(now: number): void {
    const cutoff = now - this.windowMs
    while (this.sentAt.length > 0 && this.sentAt[0]! <= cutoff) this.sentAt.shift()
  }
}

/** Shared by every client by default; reconnects never reset this budget. */
export const sharedHlWsSendBudget = new HlWsSendBudget()
