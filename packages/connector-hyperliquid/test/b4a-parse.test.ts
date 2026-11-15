// SPDX-License-Identifier: CPAL-1.0
// Untrusted venue payloads must be filtered or rejected with ProblemError, never leak native parse errors.
import { afterEach, describe, expect, it } from 'vitest'
import { ProblemError } from '../src/errors'
import { HyperliquidConnector } from '../src/connector'
import {
  buildInstrumentRecords, parseBook, parseCandles, parseContext, parseMids,
} from '../src/parse'
import { FX_NOW, FakeHl, FakeWS, FakeWebSocket, loadFixture } from './helpers/fake-hl'

const connectors: HyperliquidConnector[] = []
const BTC = 'hyperliquid:BTC' as const

function make(options: { useWs?: boolean; WebSocketImpl?: typeof WebSocket } = {}) {
  const hl = new FakeHl()
  const c = new HyperliquidConnector({
    environment: 'testnet', useWs: false, discoveryIntervalMs: 0,
    clock: () => FX_NOW, fetchImpl: hl.fetch, ...options,
  })
  connectors.push(c)
  return { hl, c }
}

afterEach(async () => { await Promise.all(connectors.splice(0).map((c) => c.close())) })
afterEach(() => FakeWebSocket.reset())

const validMeta = () => structuredClone(loadFixture<unknown[]>('metaAndAssetCtxs.json'))
const validBook = () => ({ coin: 'BTC', time: FX_NOW, levels: [[{ px: '10', sz: '2', n: 1 }], [{ px: '11', sz: '3', n: 2 }]] })
const validCandle = () => ({ t: FX_NOW, o: '10', h: '12', l: '9', c: '11', v: '3' })
const invalidCollateralCases: Array<{ label: string; value: unknown }> = [
  { label: 'null', value: null },
  { label: 'string', value: '1' },
  { label: 'boolean', value: true },
  { label: 'array', value: [1] },
  { label: 'nested object', value: { nested: true } },
  { label: 'object with null toString', value: { toString: null } },
  { label: 'object with numeric toString', value: { toString: 0 } },
  { label: 'negative number', value: -1 },
  { label: 'fractional number', value: 1.5 },
  { label: 'NaN', value: NaN },
  { label: 'Infinity', value: Infinity },
  { label: 'unsafe integer', value: Number.MAX_SAFE_INTEGER + 1 },
]

function expectTypedFailure(fn: () => unknown) {
  expect(fn).toThrow(ProblemError)
}

function assertFiniteTree(value: unknown): void {
  if (typeof value === 'number') expect(Number.isFinite(value)).toBe(true)
  else if (Array.isArray(value)) value.forEach(assertFiniteTree)
  else if (value !== null && typeof value === 'object') Object.values(value).forEach(assertFiniteTree)
}

describe('defensive Hyperliquid parsers', () => {
  it('accepts the real metadata fixture and empty metadata/context arrays', () => {
    const records = buildInstrumentRecords(validMeta() as never, '', 0, FX_NOW)
    expect(records.some((r) => r.coin === 'BTC')).toBe(true)
    expect(buildInstrumentRecords([{ universe: [] }, []] as never, '', 0, FX_NOW)).toEqual([])
  })

  it.each([
    ['null tuple', null], ['primitive tuple', 'bad'], ['wrong tuple length', [{}]],
    ['null meta', [null, []]], ['missing universe', [{}, []]], ['non-array universe', [{ universe: {} }, []]],
    ['non-array contexts', [{ universe: [] }, {}]],
  ])('rejects %s metadata as a typed problem', (_label, value) => {
    expectTypedFailure(() => buildInstrumentRecords(value as never, '', 0, FX_NOW))
  })

  it.each([
    ['null row', null], ['primitive row', 'BTC'], ['empty name', { name: '', szDecimals: 2, maxLeverage: 10 }],
    ['oversized precision', { name: 'X', szDecimals: 7, maxLeverage: 10 }],
    ['fractional precision', { name: 'X', szDecimals: 1.5, maxLeverage: 10 }],
    ['infinite leverage', { name: 'X', szDecimals: 2, maxLeverage: 'Infinity' }],
    ['negative leverage', { name: 'X', szDecimals: 2, maxLeverage: -1 }],
  ])('rejects an invalid universe row (%s) without filtering it', (_label, row) => {
    expectTypedFailure(() => buildInstrumentRecords([{ universe: [row] }, [null]] as never, '', 0, FX_NOW))
  })

  it('rejects a malformed context row while preserving the delisted null-context shape', () => {
    expectTypedFailure(() => buildInstrumentRecords([{ universe: [{ name: 'X', szDecimals: 2, maxLeverage: 5 }] }, [false]] as never, '', 0, FX_NOW))
    const data = validMeta() as any[]
    data[0].universe = [{ ...data[0].universe[0], isDelisted: true }]
    expect(buildInstrumentRecords([data[0], [null]] as never, '', 0, FX_NOW)).toHaveLength(1)
  })

  it.each([
    ['null context', null], ['primitive context', 4],
    ['no usable mark or mid', { markPx: '0', midPx: 'Infinity' }],
  ])('rejects %s as a typed problem', (_label, value) => {
    expectTypedFailure(() => parseContext(BTC, value as never, FX_NOW))
  })

  it('keeps context fallbacks and omits invalid optional numbers', () => {
    const c = parseContext(BTC, { markPx: 'bad', midPx: '100', oraclePx: 'NaN', funding: 'Infinity', openInterest: '-1' }, FX_NOW)
    expect(c).toMatchObject({ markPrice: 100, midPrice: 100, openInterest: -1 })
    expect(c).not.toHaveProperty('oraclePrice')
    expect(c).not.toHaveProperty('fundingRate')
    assertFiniteTree(c)
  })

  it.each([[null], [3], ['bad'], [[]]])('rejects a non-object mids response (%j)', (value) => {
    expectTypedFailure(() => parseMids(value as never))
  })

  it('skips invalid mids values and only returns finite positive prices', () => {
    expect(parseMids({ BTC: '10', ETH: '-1', BAD: 'Infinity', EMPTY: 'x' })).toEqual({ 'hyperliquid:BTC': 10 })
  })

  it.each([
    ['null book', null], ['primitive book', 3], ['empty coin', { ...validBook(), coin: '' }],
    ['negative time', { ...validBook(), time: -1 }], ['fractional time', { ...validBook(), time: 1.5 }],
    ['wrong levels shape', { ...validBook(), levels: [] }], ['wrong side shape', { ...validBook(), levels: [null, []] }],
  ])('rejects %s as a typed problem', (_label, value) => {
    expectTypedFailure(() => parseBook(value as never))
  })

  it('filters malformed book levels and keeps finite valid levels sorted', () => {
    const raw = { ...validBook(), levels: [[
      { px: '9', sz: '2', n: 1 }, { px: 'bad', sz: '1', n: 0 }, { px: '12', sz: '-1', n: 0 },
      { px: '10', sz: '0', n: 0 }, { px: '13', sz: '2', n: 1.2 },
    ], [{ px: '11', sz: '3', n: 1 }]] }
    const b = parseBook(raw as never)
    expect(b.bids).toEqual([{ price: 10, size: 0, count: 0 }, { price: 9, size: 2, count: 1 }])
    expect(b.asks).toEqual([{ price: 11, size: 3, count: 1 }])
    assertFiniteTree(b)
  })

  it('accepts empty candle arrays and filters rows with malformed required values', () => {
    expect(parseCandles([])).toEqual([])
    expect(parseCandles([
      validCandle(), null, { ...validCandle(), t: -1 }, { ...validCandle(), t: 1.5 },
      { ...validCandle(), o: 'Infinity' }, { ...validCandle(), h: '-1' },
      { ...validCandle(), l: '0' }, { ...validCandle(), c: 'bad' }, { ...validCandle(), v: '-1' },
    ] as never)).toHaveLength(1)
  })

  it('survives 500 fixed-seed malformed payloads across all five parsers', () => {
    let seed = 0x4b1d
    const random = () => { seed = (seed * 48271) % 0x7fffffff; return seed }
    const atoms: unknown[] = [null, false, 0, -1, Infinity, NaN, 'x', '', {}, [], { px: 'Infinity' }]
    const attempt = (fn: () => unknown) => {
      try { assertFiniteTree(fn()) } catch (e) { expect(e).toBeInstanceOf(ProblemError) }
    }
    for (let i = 0; i < 500; i++) {
      const atom = atoms[random() % atoms.length]
      const malformedMeta = random() % 2 ? atom : [{ universe: [atom] }, [atom]]
      attempt(() => buildInstrumentRecords(malformedMeta as never, '', 0, FX_NOW))
      attempt(() => parseContext(BTC, atom as never, FX_NOW))
      attempt(() => parseMids(atom as never))
      attempt(() => parseBook(atom as never))
      attempt(() => parseCandles(atom as never))
    }
  })

  it('discards malformed WS parser frames without changing market caches', async () => {
    const { c } = make({ useWs: true, WebSocketImpl: FakeWS })
    await c.market.start()
    const ws = FakeWebSocket.last
    ws.open()
    const midsBefore = c.market.allMids()
    const contextBefore = c.market.cachedContext(BTC)
    const candleEvents: unknown[] = []
    c.subscribe({ channel: 'candle', instrumentId: BTC, interval: '1m' }, (event) => candleEvents.push(event))

    ws.push({ channel: 'allMids', data: { mids: [] } })
    ws.push({ channel: 'l2Book', data: { coin: 'BTC', time: -1, levels: [[], []] } })
    ws.push({ channel: 'candle', data: { s: 'BTC', i: '1m', t: -1, o: '1', h: '1', l: '1', c: '1', v: '0' } })
    ws.push({ channel: 'activeAssetCtx', data: { coin: 'BTC', ctx: { markPx: 'bad', midPx: '0' } } })

    expect(c.market.allMids()).toEqual(midsBefore)
    expect(c.market.bookSnapshot(BTC)).toBeUndefined()
    expect(candleEvents).toEqual([])
    expect(c.market.cachedContext(BTC)).toEqual(contextBefore)
  })
})

describe('public market reads surface typed failures', () => {
  it('reads a valid book/candle and turns malformed 2xx payloads into DATA_UNAVAILABLE', async () => {
    const { hl, c } = make()
    await c.market.refreshInstruments()
    const book = await c.book(BTC)
    const candles = await c.candles(BTC, '1m', { n: 2 })
    expect(book.instrumentId).toBe(BTC)
    expect(candles.length).toBeGreaterThan(0)

    hl.info.set('l2Book', () => new Response('<html>bad</html>', { status: 200 }))
    await expect(c.book(BTC)).rejects.toMatchObject({ problem: { code: 4005 } })
    hl.info.set('candleSnapshot', () => null)
    await expect(c.candles(BTC, '1m', { n: 10 })).rejects.toMatchObject({ problem: { code: 4005 } })
    expect(hl.exchangeCalls()).toHaveLength(0)
  })

  it.each([
    ['HTTP 500', () => new Response('unavailable', { status: 500 }), 3003],
    ['HTTP 429', () => new Response('rate limit', { status: 429 }), 3002],
    ['network failure', () => { throw new TypeError('network unavailable') }, 3003],
  ])('keeps transport mapping for public book reads (%s)', async (_label, response, code) => {
    const { hl, c } = make()
    await c.market.refreshInstruments()
    hl.info.set('l2Book', response)
    await expect(c.book(BTC)).rejects.toMatchObject({ problem: { code } })
    expect(hl.exchangeCalls()).toHaveLength(0)
  })
})

describe('collateral token metadata guard', () => {
  it.each(invalidCollateralCases)('rejects invalid collateralToken: $label as DATA_UNAVAILABLE', ({ value }) => {
    const raw = validMeta() as any[]
    raw[0].collateralToken = value
    expect(() => buildInstrumentRecords(raw as never, '', 0, FX_NOW)).toThrow(ProblemError)
    try { buildInstrumentRecords(raw as never, '', 0, FX_NOW) } catch (e) {
      expect(e).toMatchObject({ problem: { code: 4005 } })
    }
  })

  it.each([
    { label: 'undefined', value: undefined, quote: 'USDC' },
    { label: 'zero', value: 0, quote: 'USDC' },
    { label: 'positive integer', value: 1, quote: 'TOKEN1' },
  ])('keeps the established quote mapping for $label', ({ value, quote }) => {
    const raw = validMeta() as any[]
    raw[0].collateralToken = value
    expect(buildInstrumentRecords(raw as never, '', 0, FX_NOW)[0]!.instrument.quote).toBe(quote)
  })

  it('does not publish an invalid root catalog and sends no exchange write', async () => {
    const { hl, c } = make()
    hl.info.set('perpDexs', () => [null])
    hl.info.set('metaAndAssetCtxs', () => {
      const raw = validMeta() as any[]
      raw[0].collateralToken = { nested: true }
      return raw
    })
    await c.market.refreshInstruments()
    expect(c.getInstrument(BTC)).toBeUndefined()
    expect(hl.infoCalls('metaAndAssetCtxs')).toHaveLength(1)
    expect(hl.exchangeCalls()).toHaveLength(0)
  })

  it('retains the previously loaded root catalog when a later collateral token is malformed', async () => {
    const { hl, c } = make()
    hl.info.set('perpDexs', () => [null])
    let malformed = false
    hl.info.set('metaAndAssetCtxs', () => {
      const raw = validMeta() as any[]
      raw[0].collateralToken = malformed ? { toString: null } : 1
      if (malformed) raw[0].universe[0].name = 'REPLACEMENT'
      return raw
    })
    await c.market.refreshInstruments()
    const before = structuredClone(c.getInstrument(BTC))
    expect(before?.quote).toBe('TOKEN1')
    malformed = true
    await c.market.refreshInstruments()
    expect(c.getInstrument(BTC)).toEqual(before)
    expect(c.getInstrument('hyperliquid:REPLACEMENT')).toBeUndefined()
    expect(hl.infoCalls('metaAndAssetCtxs')).toHaveLength(2)
    expect(hl.exchangeCalls()).toHaveLength(0)
  })
})
