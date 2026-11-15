// SPDX-License-Identifier: CPAL-1.0
import { afterEach, describe, expect, it } from 'vitest'
import { D } from '../src/util/dec'
import type { Harness } from './helpers/harness'
import { makeHarness } from './helpers/harness'

let h: Harness | undefined
afterEach(async () => { await h?.cleanup(); h = undefined })

const HOUR = 3_600_000
const q = (accountId: string, from: number, to: number, step: '1m' | '1h' | '1d' = '1h'): Promise<unknown> => h!.k.ops.call(h!.k, 'account.equity_history', {
  principal: h!.session, params: { accountId, from, to, step }, transport: 'ws', kind: 'query',
})
const points = (value: unknown): { t: number; equity: string }[] => (value as { points: { t: number; equity: string }[] }).points
const sample = async (at: number, equity: string): Promise<void> => {
  h!.clock.set(at)
  h!.sim.equity = D(equity)
  await h!.k.tickOnce()
}

describe('WI-F23 equity history head and tail anchors', () => {
  it('anchors the first and last sample of a single hour bucket instead of only the bucket close', async () => {
    h = await makeHarness()
    const hour = Math.floor(h.clock.now() / HOUR) * HOUR
    await sample(hour + 5 * 60_000, '100')
    await sample(hour + 9 * 60_000, '110')
    await sample(hour + 20 * 60_000, '120')
    const view = points(await q(h.paper.accountId, hour, hour + HOUR))
    expect(view.map((point) => point.equity)).toEqual(['100', '120'])
    expect(view[0]?.t).toBe(hour + 5 * 60_000)
    expect(view[view.length - 1]?.t).toBe(hour + 20 * 60_000)
  })

  it('keeps the latest sample of middle buckets while anchoring head and tail across hours', async () => {
    h = await makeHarness()
    const hour = Math.floor(h.clock.now() / HOUR) * HOUR
    await sample(hour + 5 * 60_000, '100')
    await sample(hour + HOUR + 5 * 60_000, '110')
    await sample(hour + HOUR + 50 * 60_000, '115')
    await sample(hour + 2 * HOUR + 5 * 60_000, '120')
    const view = points(await q(h.paper.accountId, hour, hour + 2 * HOUR + 10 * 60_000))
    expect(view.map((point) => point.equity)).toEqual(['100', '115', '120'])
    expect(view.map((point) => point.t)).toEqual([hour + 5 * 60_000, hour + HOUR + 50 * 60_000, hour + 2 * HOUR + 5 * 60_000])
  })
})
