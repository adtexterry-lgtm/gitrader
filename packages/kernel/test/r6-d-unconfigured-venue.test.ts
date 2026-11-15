// SPDX-License-Identifier: CPAL-1.0
// R3-09：没配置的场所不能悄悄退回模拟场所——market candles / quote 要点名场所并回 INSTRUMENT_UNKNOWN，不再 INTERNAL_ERROR、也不再回 ok + no_feed。
import { afterEach, describe, expect, it } from 'vitest'
import { BTC } from './helpers/fake-connector'
import { makeAgent, makeHarness } from './helpers/harness'
import type { Harness } from './helpers/harness'

const harnesses: Harness[] = []
afterEach(async () => { await Promise.all(harnesses.splice(0).map((h) => h.cleanup())) })

describe('未配置的场所', () => {
  it.each([
    ['candles', { instrumentId: 'binance:BTCUSDT', interval: '1h' }, 'binance'],
    ['quote', { instrumentId: 'binance:BTCUSDT' }, 'binance'],
    ['candles', { instrumentId: 'okx:BTC-USDT', interval: '1h' }, 'okx'],
    ['quote', { instrumentId: 'nosuchvenue:BTC' }, 'nosuchvenue'],
    ['book', { instrumentId: 'nosuchvenue:BTC' }, 'nosuchvenue'],
  ])('market %s %j 点名场所 %s，回 INSTRUMENT_UNKNOWN', async (action, args, venue) => {
    const h = await makeHarness(); harnesses.push(h)
    const a = await makeAgent(h, 'read_only')
    const err = await h.k.ops.call(h.k, 'agent.market', { principal: a.principal, params: { action, ...args }, transport: 'http' }).then(() => null, (e: unknown) => e as { problem: { name: string; message: string } })
    expect(err?.problem.name).toBe('INSTRUMENT_UNKNOWN')
    expect(err?.problem.message).toContain(venue)
    expect(err?.problem.message).toContain('gitrader.json')
  })

  it('已配置的场所照常工作', async () => {
    const h = await makeHarness(); harnesses.push(h)
    const a = await makeAgent(h, 'read_only')
    const r = (await h.k.ops.call(h.k, 'agent.market', { principal: a.principal, params: { action: 'quote', instrumentId: BTC }, transport: 'http' })) as { data: unknown }
    expect(r.data).toBeTruthy()
  })
})
