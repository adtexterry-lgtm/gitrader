// SPDX-License-Identifier: CPAL-1.0
// 解析（全离线）：标的、K 线、盘口、报价、上下文、订单状态映射、私有流归一。
import { describe, expect, it } from 'vitest'
import {
  ORDER_STATUS_MAP, mapOpenOrderType, mapOrderStatus, normalizeUserEvent, parseBookTicker, parseDepth, parseInstrumentRecords,
  parseKlines, parsePremiumIndex, parseUserStreamMessage, symbolOf, instrumentIdOf,
} from '../src/parse'
import { NOW, klines, symbolEntry } from './helpers/fake-binance-trade'

describe('instrument records', () => {
  it('keeps perpetuals only, sorted by symbol, with tradable type declarations', () => {
    const records = parseInstrumentRecords({ symbols: [
      symbolEntry({ symbol: 'ETHUSDT', baseAsset: 'ETH' }),
      symbolEntry(),
      symbolEntry({ symbol: 'OLDUSDT', status: 'CLOSE' }),
      symbolEntry({ symbol: 'BTCUSDT_240628', contractType: 'CURRENT_QUARTER' }),
    ] }, NOW)
    expect(records.map((r) => r.symbol)).toEqual(['BTCUSDT', 'ETHUSDT', 'OLDUSDT'])
    const btc = records.find((r) => r.symbol === 'BTCUSDT')!.instrument
    expect(btc.instrumentId).toBe('binance:BTCUSDT')
    expect(btc.kind).toBe('perp')
    expect(btc.settlement).toBe('linear')
    expect(btc.venueSizeUnit).toBe('base')
    expect(btc.size).toEqual({ step: '0.001', decimals: 3, min: '0.001' })
    expect(btc.price).toEqual({ tick: '0.1', maxDecimals: 2 })
    expect(btc.minNotional).toBe('5')
    expect(btc.orderTypes).toEqual(['market', 'limit', 'stop_market', 'stop_limit', 'take_market', 'take_limit', 'trailing_stop'])
    expect(btc.tif).toEqual(['gtc', 'ioc', 'fok', 'alo'])
    expect(btc.triggerPriceTypes).toEqual(['mark'])
    expect(btc.fundingIntervalMs).toBe(28_800_000)
    expect(records.find((r) => r.symbol === 'OLDUSDT')!.instrument.status).toBe('delisted')
  })

  it('falls back to a 5 USDT min notional when the filter is missing', () => {
    const rec = parseInstrumentRecords({ symbols: [symbolEntry({ filters: [{ filterType: 'PRICE_FILTER', tickSize: '0.10' }] })] }, NOW)[0]!
    expect(rec.instrument.minNotional).toBe('5')
  })

  it('symbolOf rejects ids from other venues', () => {
    expect(symbolOf('binance:BTCUSDT')).toBe('BTCUSDT')
    expect(() => symbolOf('hyperliquid:BTC')).toThrow()
    expect(() => symbolOf('BTCUSDT')).toThrow()
    expect(instrumentIdOf('ETHUSDT')).toBe('binance:ETHUSDT')
  })
})

describe('market data parsing', () => {
  it('K 线: 12-column rows, short rows skipped', () => {
    const rows = [...klines(NOW, 2), [NOW, '1', '2']]
    const candles = parseKlines(rows)
    expect(candles).toHaveLength(2)
    expect(candles[0]).toEqual({ t: NOW, o: 100, h: 101, l: 99, c: 100.5, v: 10 })
  })

  it('bookTicker: missing or non-positive sides mean no quote', () => {
    expect(parseBookTicker({ bidPrice: '100.1', askPrice: '100.2', time: NOW }, NOW + 1)).toEqual({ ts: NOW, bid: 100.1, ask: 100.2 })
    expect(parseBookTicker({ bidPrice: '', askPrice: '100.2' }, NOW)).toBeUndefined()
    expect(parseBookTicker({ bidPrice: '100.1', askPrice: '0' }, NOW)).toBeUndefined()
  })

  it('depth: bids descending, asks ascending, depth respected', () => {
    const book = parseDepth({ T: NOW, bids: [['99.9', '1'], ['100.0', '2']], asks: [['100.3', '1'], ['100.2', '2']] }, 'binance:BTCUSDT', 5, NOW)
    expect(book.bids.map((b) => b.price)).toEqual([100, 99.9])
    expect(book.asks.map((a) => a.price)).toEqual([100.2, 100.3])
    expect(book.ts).toBe(NOW)
  })

  it('premiumIndex: mark price, oracle price, funding rate, timestamp', () => {
    const ctx = parsePremiumIndex({ markPrice: '100.05', indexPrice: '100', lastFundingRate: '0.0001', time: NOW }, 'binance:BTCUSDT', NOW + 5)
    expect(ctx.markPrice).toBe(100.05)
    expect(ctx.oraclePrice).toBe(100)
    expect(ctx.fundingRate).toBe(0.0001)
    expect(ctx.ts).toBe(NOW)
    expect(ctx.fundingIntervalMs).toBe(28_800_000)
  })
})

describe('order status mapping', () => {
  it('covers every documented Binance status, including algo statuses', () => {
    expect(ORDER_STATUS_MAP).toEqual({
      NEW: 'open',
      PARTIALLY_FILLED: 'partially_filled',
      FILLED: 'filled',
      CANCELED: 'cancelled',
      REJECTED: 'rejected',
      EXPIRED: 'expired',
      EXPIRED_IN_MATCH: 'expired',
      TRIGGERING: 'open',
      TRIGGERED: 'open',
      FINISHED: 'filled',
    })
  })

  it('unknown statuses return null instead of guessing', () => {
    expect(mapOrderStatus('WHATEVER')).toBeNull()
    expect(mapOrderStatus(undefined)).toBeNull()
    expect(mapOrderStatus('FILLED')).toBe('filled')
  })

  it('open-order types map to the protocol vocabulary', () => {
    expect(mapOpenOrderType('LIMIT')).toBe('limit')
    expect(mapOpenOrderType('STOP_MARKET')).toBe('stop_market')
    expect(mapOpenOrderType('STOP')).toBe('stop_limit')
    expect(mapOpenOrderType('TAKE_PROFIT_MARKET')).toBe('take_market')
    expect(mapOpenOrderType('TAKE_PROFIT')).toBe('take_limit')
    expect(mapOpenOrderType('TRAILING_STOP_MARKET')).toBe('stop_market')
    expect(mapOpenOrderType('LIQUIDATION')).toBe('unknown')
  })
})

describe('private stream normalization', () => {
  const orderFrame = {
    e: 'ORDER_TRADE_UPDATE',
    E: NOW,
    T: NOW + 1,
    o: {
      s: 'BTCUSDT', c: 'gt-order-1', S: 'BUY', o: 'LIMIT', f: 'GTC', q: '0.010', p: '95000',
      ap: '95000', sp: '0', x: 'TRADE', X: 'PARTIALLY_FILLED', i: 1001, l: '0.004', z: '0.004',
      L: '95000', n: '0.01', N: 'USDT', T: NOW + 1, t: 7, m: false, R: false, ps: 'BOTH', rp: '0',
    },
  }

  it('ORDER_TRADE_UPDATE → order event with protocol status and Decimal fields', () => {
    const ev = normalizeUserEvent(orderFrame)
    expect(ev?.kind).toBe('order')
    if (ev?.kind !== 'order') throw new Error('expected order event')
    expect(ev.instrumentId).toBe('binance:BTCUSDT')
    expect(ev.venueOrderId).toBe('1001')
    expect(ev.clientOrderId).toBe('gt-order-1')
    expect(ev.rawStatus).toBe('PARTIALLY_FILLED')
    expect(ev.status).toBe('partially_filled')
    expect(ev.tradeId).toBe('7')
    expect(ev.executionType).toBe('TRADE')
    expect(ev.side).toBe('buy')
    expect(ev.positionSide).toBe('BOTH')
    expect(ev.filledSize).toBe('0.004')
    expect(ev.lastFillSize).toBe('0.004')
    expect(ev.avgPrice).toBe('95000')
    expect(ev.fee).toBe('0.01')
    expect(ev.feeCcy).toBe('USDT')
    expect(ev.reduceOnly).toBe(false)
    expect(ev.ts).toBe(NOW + 1)
  })

  it('ORDER_TRADE_UPDATE: reduceOnly, hedge positionSide and maker flag are carried', () => {
    const ev = normalizeUserEvent({
      e: 'ORDER_TRADE_UPDATE', E: NOW,
      o: { s: 'ETHUSDT', c: '', S: 'SELL', X: 'FILLED', i: 9, l: '0.5', z: '0.5', L: '2900', ap: '2900', n: '0.1', N: 'USDT', T: NOW, m: true, R: true, ps: 'LONG' },
    })
    if (ev?.kind !== 'order') throw new Error('expected order event')
    expect(ev.clientOrderId).toBeNull()
    expect(ev.status).toBe('filled')
    expect(ev.side).toBe('sell')
    expect(ev.positionSide).toBe('LONG')
    expect(ev.reduceOnly).toBe(true)
    expect(ev.maker).toBe(true)
    expect(ev.orderType).toBe('')
  })

  it('ACCOUNT_UPDATE → balances from wb / cw (no available balance) and positions (pa=0 kept)', () => {
    const ev = normalizeUserEvent({
      e: 'ACCOUNT_UPDATE', E: NOW, T: NOW,
      a: {
        m: 'ORDER',
        B: [{ a: 'USDT', wb: '1000', cw: '950', bc: '0' }],
        P: [{ s: 'BTCUSDT', pa: '-0.020', ep: '101000', up: '20', ps: 'BOTH' }, { s: 'ETHUSDT', pa: '0', ep: '0', up: '0' }],
      },
    })
    if (ev?.kind !== 'account') throw new Error('expected account event')
    expect(ev.reason).toBe('ORDER')
    expect(ev.balances).toEqual([{ asset: 'USDT', total: '1000', crossWallet: '950', ts: NOW }])
    expect('available' in ev.balances[0]!).toBe(false)
    expect(ev.positions).toEqual([
      { instrumentId: 'binance:BTCUSDT', side: 'short', size: '0.02', entryPrice: '101000', unrealizedPnl: '20' },
      { instrumentId: 'binance:ETHUSDT', side: 'long', size: '0', entryPrice: '0', unrealizedPnl: '0' },
    ])
  })

  it('listenKeyExpired, unknown events and malformed JSON', () => {
    expect(normalizeUserEvent({ e: 'listenKeyExpired', E: NOW })).toEqual({ kind: 'listenKeyExpired', ts: NOW })
    expect(normalizeUserEvent({ e: 'MARGIN_CALL', E: NOW })).toEqual({ kind: 'unknown', eventType: 'MARGIN_CALL', ts: NOW })
    expect(normalizeUserEvent(null)).toBeNull()
    expect(parseUserStreamMessage('not json')).toBeNull()
    expect(parseUserStreamMessage(JSON.stringify(orderFrame))?.kind).toBe('order')
  })
})

describe('ProblemError unification', () => {
  it('symbolOf errors are INVALID_PARAMS (never INTERNAL 4001)', async () => {
    const { asProblem } = await import('../src/errors')
    let caught: unknown
    try {
      symbolOf('not-a-binance-id')
    } catch (e) {
      caught = e
    }
    const problem = asProblem(caught)
    expect(problem.name).toBe('INVALID_PARAMS')
    expect(problem.code).not.toBe(4001)
  })
})
