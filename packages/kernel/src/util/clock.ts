// SPDX-License-Identifier: CPAL-1.0
/** 时钟注入点：测试用假时钟推进时间，生产用系统时钟。 */
import { makeProblem } from '../proto'
import { KernelError } from './errors'

export interface Clock { now(): number }
export const systemClock: Clock = { now: () => Date.now() }

const invalidReplayClock = (): never => { throw new KernelError(makeProblem('INVALID_PARAMS', 'invalid replay clock')) }

export class ReplayClock implements Clock {
  private current: number

  constructor(start: number) {
    if (!Number.isSafeInteger(start) || start < 0) invalidReplayClock()
    this.current = start
  }

  now(): number { return this.current }

  advanceTo(timestamp: number): number {
    if (!Number.isSafeInteger(timestamp) || timestamp < this.current) invalidReplayClock()
    this.current = timestamp
    return this.current
  }
}

export class FakeClock implements Clock {
  constructor(private t = 1_791_549_000_000) {}
  now(): number { return this.t }
  set(t: number): void { this.t = t }
  advance(ms: number): number { this.t += ms; return this.t }
}
