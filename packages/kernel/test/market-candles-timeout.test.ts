// SPDX-License-Identifier: CPAL-1.0
// fix-r4 C8：market.candles 10 s 无结果 → DATA_UNAVAILABLE（上游原文写明超时）；正常返回时不留定时器。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BTC } from './helpers/fake-connector'
import { makeHarness } from './helpers/harness'
import type { Harness } from './helpers/harness'

let h: Harness
beforeEach(async () => { h = await makeHarness() })
afterEach(async () => { vi.useRealTimers(); await h.cleanup() })

const candles = (): Promise<unknown> => h.k.ops.call(h.k, 'market.candles', { principal: h.session, params: { instrumentId: BTC, interval: '15m', limit: 10 }, transport: 'http' })

describe('market.candles 超时', () => {
  it('源永不返回：10 s 后 DATA_UNAVAILABLE，消息写明 timed out after 10000 ms', async () => {
    h.live.candles = () => new Promise(() => undefined)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const p = candles()
    const settled = p.then(() => 'resolved', (e: unknown) => e)
    await vi.advanceTimersByTimeAsync(9_999)
    expect(vi.getTimerCount()).toBe(1) // 还没到时限
    await vi.advanceTimersByTimeAsync(2)
    const err = await settled
    expect(err).toMatchObject({ problem: { name: 'DATA_UNAVAILABLE', message: 'market.candles timed out after 10000 ms' } })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('源正常返回：结果原样给出，超时定时器被清掉', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const rows = await candles()
    expect(Array.isArray(rows)).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('源自己报错：原样抛出，不被超时覆盖', async () => {
    h.live.candles = async () => { throw new Error('upstream said no') }
    await expect(candles()).rejects.toThrow('upstream said no')
  })
})
