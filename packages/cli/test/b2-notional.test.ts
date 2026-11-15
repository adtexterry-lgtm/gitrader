// SPDX-License-Identifier: CPAL-1.0
import { afterEach, describe, expect, it, vi } from 'vitest'
import { asDecimal } from '@gitrader/protocol'
import type { Instrument, InstrumentId } from '@gitrader/protocol'
import type { StampedQuote, VenueConnector } from '@gitrader/protocol/connector'
import type { PaperVenue } from '@gitrader/venue-paper'
import { parseInstrument } from '@gitrader/connector-okx-data'
import type { CliIo } from '../src/index'
import { assembleConnectors } from '../src/connectors'

const ID = 'binance:BTCUSDT' as InstrumentId
const OKX_ID = 'okx:BTC-USDT-SWAP' as InstrumentId
const ACCOUNT_ID = 'acct_B2PAPER0000000000000001'
const NOW = 1_800_000_000_000
const instrument: Instrument = {
  instrumentId: ID, venue: 'binance', symbol: 'BTCUSDT', displaySymbol: 'BTC/USDT', kind: 'perp', base: 'BTC', quote: 'USDT', settle: 'USDT',
  settlement: 'linear', contractSize: asDecimal('0.25'), venueSizeUnit: 'base', assetClass: 'crypto', status: 'trading',
  price: { tick: asDecimal('1') }, size: { step: asDecimal('0.01'), decimals: 2, min: asDecimal('0.01') }, minNotional: asDecimal('1'),
  maxLeverage: 10, marginModes: ['cross'], orderTypes: ['limit', 'market'], tif: ['gtc', 'ioc'], triggerPriceTypes: [], updatedAt: NOW as never,
}

let paper: PaperVenue | undefined
afterEach(async () => { await paper?.close(); paper = undefined; vi.restoreAllMocks() })

describe('B2 PaperVenue assembled market notional', () => {
  it('normalizes a base-unit data fixture through assembly before PaperVenue values an open order', async () => {
    const registered = new Map<string, VenueConnector>()
    const k = {
      config: { venues: [{ id: 'binance', environment: 'mainnet', enabled: true }], supportDeveloper: false },
      opts: {}, clock: { now: () => NOW },
      bus: { budgetFor: () => ({ take: () => true, takeSync: () => true, charge: () => undefined, remaining: () => 1, snapshot: () => ({}) }) },
      registerConnector: (connector: VenueConnector) => { registered.set(connector.venue, connector) },
      connectInBackground: () => undefined,
    }
    const io: CliIo = { out: () => undefined, err: () => undefined, env: {}, interactive: false, readSecret: async () => '' }
    assembleConnectors({ k: k as never, io })
    const source = registered.get('binance')!
    vi.spyOn(source, 'listInstruments').mockReturnValue([instrument])
    vi.spyOn(source, 'getInstrument').mockImplementation((id) => id === ID ? instrument : undefined)
    vi.spyOn(source, 'quote').mockReturnValue({ instrumentId: ID, ts: NOW as never, bid: 99, ask: 101, last: 100, stale: false, ageMs: 0 } satisfies StampedQuote)
    vi.spyOn(source, 'book').mockResolvedValue({ instrumentId: ID, ts: NOW as never, bids: [{ price: 99, size: 2 }], asks: [{ price: 101, size: 2 }] })
    vi.spyOn(source, 'subscribe').mockReturnValue(() => undefined)
    Object.defineProperty(source, 'bookSnapshot', { value: undefined, configurable: true })
    Object.defineProperty(source, 'refreshBook', { value: undefined, configurable: true })
    paper = registered.get('kernel-sim') as PaperVenue
    paper.createAccount({ accountId: ACCOUNT_ID, initialBalance: '10000', ccy: 'USDT' })

    const displayed = paper.getInstrument(ID)!
    expect(displayed.contractSize).toBe('1')
    expect(instrument.contractSize).toBe('0.25')
    const submitted = await paper.submit({ account: { accountId: ACCOUNT_ID } } as never, [{
      accountId: ACCOUNT_ID as never, instrumentId: ID, side: 'buy', type: 'limit', size: asDecimal('0.02'), price: asDecimal('90'), tif: 'gtc', clientOrderId: 'b2paper000000000000000000000001',
    }])
    expect(submitted.acks[0]?.status).toBe('open')
    const snapshot = await paper.accountState({ accountId: ACCOUNT_ID } as never)
    expect(snapshot.openOrders).toEqual([{ instrumentId: ID, side: 'buy', notional: asDecimal('1.8'), count: 1 }])
  })

  it('uses parsed OKX base step and face value once in assembled PaperVenue accountState', async () => {
    const parsed = parseInstrument({
      instType: 'SWAP', instId: 'BTC-USDT-SWAP', quoteCcy: 'USDT', settleCcy: 'USDT',
      ctVal: '0.25', ctValCcy: 'BTC', tickSz: '0.1', lotSz: '1', minSz: '1', state: 'live',
    } as never, NOW as never)!
    expect(parsed).toMatchObject({ contractSize: '0.25', venueSizeUnit: 'base', size: { step: '0.25', min: '0.25' }, orderTypes: [], tif: [] })
    // OKX data connector is read-only and parses no order capabilities. This test-only copy enables a PaperVenue limit submit solely to inspect its notional snapshot.
    const paperInstrument: Instrument = { ...parsed, orderTypes: ['limit'], tif: ['gtc'] }
    const registered = new Map<string, VenueConnector>()
    const k = {
      config: { venues: [{ id: 'okx', environment: 'mainnet', enabled: true }], supportDeveloper: false },
      opts: {}, clock: { now: () => NOW },
      bus: { budgetFor: () => ({ take: () => true, takeSync: () => true, charge: () => undefined, remaining: () => 1, snapshot: () => ({}) }) },
      registerConnector: (connector: VenueConnector) => { registered.set(connector.venue, connector) },
      connectInBackground: () => undefined,
    }
    const io: CliIo = { out: () => undefined, err: () => undefined, env: {}, interactive: false, readSecret: async () => '' }
    assembleConnectors({ k: k as never, io })
    const source = registered.get('okx')!
    vi.spyOn(source, 'listInstruments').mockReturnValue([paperInstrument])
    vi.spyOn(source, 'getInstrument').mockImplementation((id) => id === OKX_ID ? paperInstrument : undefined)
    vi.spyOn(source, 'quote').mockReturnValue({ instrumentId: OKX_ID, ts: NOW as never, bid: 89, ask: 91, last: 90, stale: false, ageMs: 0 } satisfies StampedQuote)
    vi.spyOn(source, 'book').mockResolvedValue({ instrumentId: OKX_ID, ts: NOW as never, bids: [{ price: 89, size: 2 }], asks: [{ price: 91, size: 2 }] })
    vi.spyOn(source, 'subscribe').mockReturnValue(() => undefined)
    Object.defineProperty(source, 'bookSnapshot', { value: undefined, configurable: true })
    Object.defineProperty(source, 'refreshBook', { value: undefined, configurable: true })
    paper = registered.get('kernel-sim') as PaperVenue
    paper.createAccount({ accountId: ACCOUNT_ID, initialBalance: '10000', ccy: 'USDT' })

    expect(paper.getInstrument(OKX_ID)?.contractSize).toBe('1')
    expect(paper.getInstrument(OKX_ID)?.size).toMatchObject({ step: '0.25', min: '0.25' })
    expect(paperInstrument.contractSize).toBe('0.25')
    const submitted = await paper.submit({ account: { accountId: ACCOUNT_ID } } as never, [{
      accountId: ACCOUNT_ID as never, instrumentId: OKX_ID, side: 'buy', type: 'limit', size: asDecimal('0.5'), price: asDecimal('90'), tif: 'gtc', clientOrderId: 'b2okx000000000000000000000000001',
    }])
    expect(submitted.acks[0]?.status).toBe('open')
    const snapshot = await paper.accountState({ accountId: ACCOUNT_ID } as never)
    expect(snapshot.openOrders).toEqual([{ instrumentId: OKX_ID, side: 'buy', notional: asDecimal('45'), count: 1 }])
  })
})
