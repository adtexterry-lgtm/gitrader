// SPDX-License-Identifier: CPAL-1.0
// instruments.search 只回能交易的标的（下架 / 过期的不回），非主市场的结果带 dex；market.instruments 不过滤、同样带 dex。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Instrument } from '../src/proto'
import { makeHarness } from './helpers/harness'
import type { Harness } from './helpers/harness'

let h: Harness
beforeEach(async () => { h = await makeHarness() })
afterEach(async () => { await h.cleanup() })

const seed = (): Instrument => h.sim.instrumentsList[0]!
const variant = (over: Partial<Instrument>): Instrument => ({ ...seed(), ...over })
const call = (name: string, params: Record<string, unknown>): Promise<unknown> =>
  h.k.ops.call(h.k, name, { principal: h.session, params, transport: 'ws', kind: 'query' })

interface Hit { id: string; name: string; venue: string; dex?: string }

describe('instruments.search filtering', () => {
  it('search drops non-live and expired, adds dex', async () => {
    const now = Date.now()
    h.sim.instrumentsList.push(
      variant({ instrumentId: 'hyperliquid:sekaw:BTC', symbol: 'sekaw:BTC', displaySymbol: 'sekaw:BTC-PERP', marketGroup: 'sekaw' }),
      variant({ instrumentId: 'hyperliquid:OLD', symbol: 'OLD', displaySymbol: 'OLD-PERP', status: 'delisted' }),
      variant({ instrumentId: 'hyperliquid:EXP', symbol: 'EXP', displaySymbol: 'EXP-PERP', kind: 'option', ...{ expiry: now - 1000 } }),
    )

    const found = (await call('instruments.search', { q: '', limit: 100 }) as { hits: Hit[] }).hits
    const ids = found.map((hit) => hit.id)
    expect(ids).toContain('hyperliquid:BTC')
    expect(ids).toContain('hyperliquid:sekaw:BTC')
    expect(ids).not.toContain('hyperliquid:OLD')
    expect(ids).not.toContain('hyperliquid:EXP')

    const main = found.find((hit) => hit.id === 'hyperliquid:BTC')!
    expect('dex' in main).toBe(false)
    expect(found.find((hit) => hit.id === 'hyperliquid:sekaw:BTC')).toMatchObject({ dex: 'sekaw', name: 'sekaw:BTC-PERP' })

    // market.instruments 保持原语义：不过滤，只追加 dex
    const all = await call('market.instruments', { q: '', limit: 100 }) as Array<Instrument & { dex?: string }>
    expect(all.map((i) => i.instrumentId)).toContain('hyperliquid:OLD')
    expect(all.find((i) => i.instrumentId === 'hyperliquid:BTC')!.dex).toBeUndefined()
    expect(all.find((i) => i.instrumentId === 'hyperliquid:sekaw:BTC')!.dex).toBe('sekaw')
  })
})
