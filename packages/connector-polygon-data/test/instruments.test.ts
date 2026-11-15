// SPDX-License-Identifier: CPAL-1.0
// 标的清单：/v3/reference/tickers 按 cursor 翻页（不跟随 next_url 的主机）、只收 stocks/us 行、
// active:false → delisted、includeDelisted 过滤、start() 只拉一次、空清单报错、instrumentPages 上限。
import { describe, expect, it } from 'vitest'
import { PolygonDataConnector } from '../src/connector'
import { API_KEY, FX_NOW, FakePolygon, HOST } from './helpers/fake-polygon'

const ID = 'polygon:AAPL'

function make(o: Record<string, unknown> = {}): { fake: FakePolygon; connector: PolygonDataConnector } {
  const fake = new FakePolygon()
  const connector = new PolygonDataConnector({
    apiKey: API_KEY,
    baseUrl: `http://${HOST}`,
    fetchImpl: fake.fetch,
    clock: () => FX_NOW,
    ...o,
  })
  return { fake, connector }
}

describe('instruments', () => {
  it('parses a ticker page into protocol instruments', async () => {
    const { connector } = make()
    await connector.start()
    const aapl = connector.getInstrument(ID)!
    expect(aapl).toMatchObject({
      instrumentId: 'polygon:AAPL',
      venue: 'polygon',
      symbol: 'AAPL',
      displaySymbol: 'AAPL',
      kind: 'spot',
      base: 'AAPL',
      quote: 'USD',
      settle: 'USD',
      settlement: 'linear',
      venueSizeUnit: 'base',
      assetClass: 'stocks',
      marketGroup: 'XNAS',
      status: 'trading',
      underlying: { description: 'Apple Inc.', synthetic: false },
    })
    expect(aapl.contractSize.toString()).toBe('1')
    expect(aapl.updatedAt).toBe(FX_NOW)
  })

  it('walks the cursor across pages and merges the results', async () => {
    const { fake, connector } = make()
    await connector.start()

    const calls = fake.callsTo('/v3/reference/tickers')
    expect(calls).toHaveLength(2)
    expect(calls[0]!.params.get('market')).toBe('stocks')
    expect(calls[0]!.params.get('active')).toBe('true')
    expect(calls[0]!.params.get('limit')).toBe('1000')
    expect(calls[0]!.params.get('cursor')).toBeNull()
    expect(calls[1]!.params.get('cursor')).toBe('PAGE2')
    // 翻页请求仍打注入的基址（不跟随 next_url 里的 api.polygon.io）
    expect(calls[1]!.url.startsWith(`http://${HOST}`)).toBe(true)

    expect(connector.listInstruments().map((i) => i.symbol)).toEqual(['AAPL', 'BRK.B', 'MSFT', 'NVDA', 'SPY'])
  })

  it('drops rows from other markets and hides delisted rows by default', async () => {
    const { connector } = make()
    await connector.start()
    expect(connector.getInstrument('polygon:BTCUSD')).toBeUndefined()
    expect(connector.getInstrument('polygon:OLD')!.status).toBe('delisted')
    expect(connector.listInstruments({ includeDelisted: true }).map((i) => i.symbol))
      .toEqual(['AAPL', 'BRK.B', 'MSFT', 'NVDA', 'OLD', 'SPY'])
  })

  it('stops after instrumentPages pages even when the upstream keeps handing out cursors', async () => {
    const { fake, connector } = make({ instrumentPages: 1 })
    await connector.start()
    expect(fake.callsTo('/v3/reference/tickers')).toHaveLength(1)
    expect(connector.listInstruments().map((i) => i.symbol)).toEqual(['AAPL', 'BRK.B', 'MSFT', 'SPY'])
  })

  it('requests the listing only once across repeated start() calls', async () => {
    const { fake, connector } = make()
    await connector.start()
    await connector.start()
    expect(fake.callsTo('/v3/reference/tickers')).toHaveLength(2)
  })

  it('fails loudly when the listing is empty instead of caching an empty universe', async () => {
    const { fake, connector } = make()
    fake.override.set('/v3/reference/tickers', () => ({ status: 'OK', results: [], count: 0 }))
    await expect(connector.start()).rejects.toThrow(/returned no instruments/)
    expect(connector.listInstruments()).toEqual([])
  })

  it('keeps the previously loaded universe when a later refresh fails mid-way', async () => {
    const { fake, connector } = make()
    await connector.start()
    fake.override.set('/v3/reference/tickers', () => new Response('boom', { status: 500 }))
    await expect(connector.market.refreshInstruments()).rejects.toThrow(/HTTP 500/)
    expect(connector.listInstruments().map((i) => i.symbol)).toEqual(['AAPL', 'BRK.B', 'MSFT', 'NVDA', 'SPY'])
  })
})
