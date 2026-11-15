// SPDX-License-Identifier: CPAL-1.0
import { afterEach, describe, expect, it } from 'vitest'
import { HyperliquidConnector } from '../src/connector'
import type { HyperliquidConnectorOptions } from '../src/connector'
import { FX_NOW, FakeHl, FakeWS, FakeWebSocket, loadFixture } from './helpers/fake-hl'

const markId = 'hyperliquid:BTC'

function make(over: Partial<HyperliquidConnectorOptions> = {}) {
  const hl = new FakeHl()
  const t = { now: FX_NOW }
  const c = new HyperliquidConnector({
    environment: 'mainnet', fetchImpl: hl.fetch, useWs: false, discoveryIntervalMs: 0, clock: () => t.now, ...over,
  })
  return { hl, t, c }
}

afterEach(() => { FakeWebSocket.reset() })

describe('optional stale mark reads', () => {
  it('returns no stale mark by default and an unchanged cached venue mark when explicitly allowed', async () => {
    const { hl, t, c } = make()
    await c.market.start()
    const original = c.mark(markId)
    expect(original).toMatchObject({ source: 'venue_mark' })

    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    hl.info.set('metaAndAssetCtxs', async (body) => {
      if (body.dex) return loadFixture(`metaAndAssetCtxs-${body.dex}.json`)
      await held
      return loadFixture('metaAndAssetCtxs.json')
    })
    t.now += 5_001
    try {
      expect(c.mark(markId)).toBeUndefined()
      expect(c.mark(markId, { allowStale: true })).toEqual(original)
    } finally {
      release()
      await c.close()
    }
  })

  it('keeps the default mark available at exactly the stale threshold', async () => {
    const { t, c } = make()
    await c.market.start()
    const original = c.mark(markId)
    t.now += 5_000
    expect(c.mark(markId)).toEqual(original)
    await c.close()
  })

  it('returns the latest valid mark after a refresh', async () => {
    const { t, c } = make({ WebSocketImpl: FakeWS, useWs: true })
    await c.market.start()
    const ws = FakeWebSocket.last
    ws.open()
    const original = c.mark(markId)
    t.now += 5_001
    ws.push({ channel: 'activeAssetCtx', data: { coin: 'BTC', ctx: { markPx: '82000', midPx: '81999' } } })
    expect(c.mark(markId)).toMatchObject({ price: '82000', ts: t.now, source: 'venue_mark' })
    expect(c.mark(markId, { allowStale: true })).not.toEqual(original)
    expect(c.mark(markId, { allowStale: true })).toMatchObject({ price: '82000', ts: t.now, source: 'venue_mark' })
    await c.close()
  })

  it('returns no mark for an unknown instrument or a delisted instrument', async () => {
    const { c } = make()
    await c.market.start()
    expect(c.mark('hyperliquid:missing')).toBeUndefined()
    expect(c.mark('hyperliquid:missing', { allowStale: true })).toBeUndefined()
    expect(c.mark('hyperliquid:xyz:OLDCO1')).toBeUndefined()
    expect(c.mark('hyperliquid:xyz:OLDCO1', { allowStale: true })).toBeUndefined()
    await c.close()
  })

  it('does not manufacture a mark from a mid-only context', async () => {
    const { hl, c } = make()
    hl.info.set('metaAndAssetCtxs', (body) => {
      if (body.dex) return loadFixture(`metaAndAssetCtxs-${body.dex}.json`)
      const raw = structuredClone(loadFixture<any[]>('metaAndAssetCtxs.json'))
      delete raw[1][0].markPx
      raw[1][0] = { ...raw[1][0], midPx: '80000' }
      return raw
    })
    await c.market.start()
    expect(c.mark(markId)).toBeUndefined()
    expect(c.mark(markId, { allowStale: true })).toBeUndefined()
    await c.close()
  })
})
