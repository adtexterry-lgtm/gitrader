// SPDX-License-Identifier: CPAL-1.0
// 标的清单：LISTING_STATUS 的 CSV（表头照官方文档）、带逗号 / 转义引号的公司名、active / delisted、
// 按 symbol 升序、includeDelisted 过滤、空清单报错、start() 只拉一次。
import { describe, expect, it } from 'vitest'
import { AlphaVantageDataConnector } from '../src/connector'
import { parseCsv } from '../src/parse'
import { API_KEY, FX_NOW, FakeAlphaVantage, HOST, LISTING_CSV } from './helpers/fake-alphavantage'

const ID = 'alphavantage:AAPL'

function make(o: Record<string, unknown> = {}): { fake: FakeAlphaVantage; connector: AlphaVantageDataConnector } {
  const fake = new FakeAlphaVantage()
  const connector = new AlphaVantageDataConnector({
    apiKey: API_KEY,
    baseUrl: `http://${HOST}`,
    fetchImpl: fake.fetch,
    clock: () => FX_NOW,
    ...o,
  })
  return { fake, connector }
}

describe('instruments', () => {
  it('parses the listing CSV into protocol instruments', async () => {
    const { connector } = make()
    await connector.start()
    const aapl = connector.getInstrument(ID)!

    expect(aapl).toMatchObject({
      instrumentId: 'alphavantage:AAPL',
      venue: 'alphavantage',
      symbol: 'AAPL',
      displaySymbol: 'AAPL',
      kind: 'spot',
      base: 'AAPL',
      quote: 'USD',
      settle: 'USD',
      settlement: 'linear',
      venueSizeUnit: 'base',
      assetClass: 'stocks',
      marketGroup: 'Stock',
      status: 'trading',
      underlying: { description: 'Apple Inc', synthetic: false },
    })
    expect(aapl.contractSize.toString()).toBe('1')
    expect(aapl.size.step.toString()).toBe('1')
    expect(aapl.updatedAt).toBe(FX_NOW)
  })

  it('asks LISTING_STATUS for the active universe, with the key in the query string', async () => {
    const { fake, connector } = make()
    await connector.start()
    const call = fake.callsOf('LISTING_STATUS')[0]!
    expect(call.params.get('datatype')).toBe('csv')
    expect(call.params.get('apikey')).toBe(API_KEY)
    expect(call.params.get('date')).toBeNull()
  })

  it('keeps quoted commas and escaped quotes in company names', async () => {
    const { connector } = make()
    await connector.start()
    expect(connector.getInstrument('alphavantage:ACME')!.underlying?.description).toBe('Acme, Inc. "Class A"')
    expect(connector.getInstrument('alphavantage:SPY')!.marketGroup).toBe('ETF')
  })

  it('hides delisted rows by default and shows them when asked', async () => {
    const { connector } = make()
    await connector.start()
    expect(connector.listInstruments().map((i) => i.symbol)).toEqual(['AAPL', 'ACME', 'BRK.B', 'MSFT', 'SPY'])
    expect(connector.listInstruments({ includeDelisted: true }).map((i) => i.symbol))
      .toEqual(['AAPL', 'ACME', 'BRK.B', 'MSFT', 'OLD', 'SPY'])
    expect(connector.getInstrument('alphavantage:OLD')!.status).toBe('delisted')
  })

  it('requests the listing only once across repeated start() calls', async () => {
    const { fake, connector } = make()
    await connector.start()
    await connector.start()
    await connector.start()
    expect(fake.callsOf('LISTING_STATUS')).toHaveLength(1)
  })

  it('fails loudly when the listing comes back empty instead of caching an empty universe', async () => {
    const { fake, connector } = make()
    fake.override.set('LISTING_STATUS', () => 'symbol,name,exchange,assetType,ipoDate,delistingDate,status')
    await expect(connector.start()).rejects.toThrow(/returned no instruments/)
    expect(connector.listInstruments()).toEqual([])
  })

  it('parses the CSV helper on its own (header row is not data, blank lines dropped)', () => {
    expect(parseCsv('a,b\r\n1,"x,y"\r\n\r\n')).toEqual([['a', 'b'], ['1', 'x,y']])
    expect(parseCsv(LISTING_CSV)).toHaveLength(7)
  })
})
