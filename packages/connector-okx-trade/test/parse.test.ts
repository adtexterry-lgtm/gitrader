// SPDX-License-Identifier: CPAL-1.0
// 状态映射与私有流归一（纯函数，全离线）：OKX state → 协议状态集、挂单类型映射、
// 合约目录的 settleCcy 过滤、orders / account / login / error 帧。
import { describe, expect, it } from 'vitest'
import {
  ALGO_STATE_MAP, ORDER_STATE_MAP, isWorkingState, mapOpenOrderType, mapOrderState, normalizeUserEvents,
  parseInstrumentRecords, parseUserStreamMessage, recordOf, symbolOf,
} from '../src/parse'
import { NOW, instruments } from './helpers/fake-okx-trade'

describe('order state mapping', () => {
  it('maps the documented OKX states onto protocol statuses', () => {
    expect(mapOrderState('live')).toBe('open')
    expect(mapOrderState('partially_filled')).toBe('partially_filled')
    expect(mapOrderState('filled')).toBe('filled')
    expect(mapOrderState('canceled')).toBe('cancelled')
    expect(mapOrderState('mmp_canceled')).toBe('cancelled')
    expect(mapOrderState('order_failed', 'algo')).toBe('rejected')
  })

  it('maps the algo states with the algo table', () => {
    expect(mapOrderState('live', 'algo')).toBe('untriggered')
    expect(mapOrderState('pause', 'algo')).toBe('untriggered')
    expect(mapOrderState('canceled', 'algo')).toBe('cancelled')
    expect(mapOrderState('partially_failed', 'algo')).toBe('rejected')
    expect(mapOrderState('effective', 'algo')).toBeNull()
    expect(mapOrderState('partially_effective', 'algo')).toBeNull()
  })

  it('returns null for anything it does not know (no guessing)', () => {
    expect(mapOrderState('weird')).toBeNull()
    expect(mapOrderState(undefined)).toBeNull()
    expect(mapOrderState(42)).toBeNull()
  })

  it('keeps the tables and the helper in sync', () => {
    for (const [state, status] of Object.entries(ORDER_STATE_MAP)) expect(mapOrderState(state)).toBe(status)
    for (const [state, status] of Object.entries(ALGO_STATE_MAP)) expect(mapOrderState(state, 'algo')).toBe(status)
  })

  it('knows which states are still working', () => {
    expect(isWorkingState('live')).toBe(true)
    expect(isWorkingState('partially_filled')).toBe(true)
    expect(isWorkingState('partially_effective')).toBe(true)
    expect(isWorkingState('filled')).toBe(false)
    expect(isWorkingState('canceled')).toBe(false)
  })
})

describe('open-order type mapping', () => {
  it('collapses the OKX ordTypes into protocol VenueOpenOrder types', () => {
    expect(mapOpenOrderType('limit')).toBe('limit')
    expect(mapOpenOrderType('post_only')).toBe('limit')
    expect(mapOpenOrderType('ioc')).toBe('limit')
    expect(mapOpenOrderType('conditional')).toBe('stop_market')
    expect(mapOpenOrderType('oco')).toBe('stop_market')
    expect(mapOpenOrderType('move_order_stop')).toBe('unknown')
    expect(mapOpenOrderType(undefined)).toBe('unknown')
  })
})

describe('instrument records', () => {
  it('drops coin-margined SWAPs (settleCcy = the base coin)', () => {
    const symbols = parseInstrumentRecords(instruments, NOW).map((r) => r.symbol)
    expect(symbols).toContain('BTC-USDT-SWAP')
    expect(symbols).toContain('BTC-USDC-SWAP')
    expect(symbols).not.toContain('BTC-USD-SWAP')
  })

  it('drops FUTURES entries (instType != SWAP)', () => {
    expect(parseInstrumentRecords(instruments, NOW).map((r) => r.symbol)).not.toContain('BTC-USDT-260327')
  })

  it('carries ctVal, contract lot and min contracts', () => {
    const btc = parseInstrumentRecords(instruments, NOW).find((r) => r.symbol === 'BTC-USDT-SWAP')!
    expect(btc.ctVal).toBe('0.01')
    expect(btc.lotContracts).toBe('0.01')
    expect(btc.minContracts).toBe('0.01')
    expect(btc.instrument.settlement).toBe('linear')
    expect(btc.instrument.venueSizeUnit).toBe('base')
  })

  it('every record has a positive ctVal (recordOf refuses to guess)', () => {
    for (const record of parseInstrumentRecords(instruments, NOW)) {
      expect(Number(record.ctVal)).toBeGreaterThan(0)
      expect(recordOf(record.instrument)?.symbol).toBe(record.symbol)
    }
  })
})

describe('instrument id guard', () => {
  it('accepts okx ids and rejects other venues', () => {
    expect(symbolOf('okx:BTC-USDT-SWAP')).toBe('BTC-USDT-SWAP')
    expect(() => symbolOf('binance:BTCUSDT')).toThrow(/not a okx instrument id/)
    expect(() => symbolOf('BTC-USDT-SWAP')).toThrow()
    expect(() => symbolOf('okx:')).toThrow()
  })
})

describe('private stream frames', () => {
  const ctValOf = (instId: string): string | undefined => (instId === 'BTC-USDT-SWAP' ? '0.01' : undefined)

  it('normalizes an orders frame and folds the filled contracts into base units', () => {
    const events = normalizeUserEvents({
      arg: { channel: 'orders', instType: 'SWAP' },
      data: [{
        instId: 'BTC-USDT-SWAP', ordId: '3122698', clOrdId: 'gtopen1', side: 'sell', posSide: 'net',
        state: 'partially_filled', accFillSz: '2', avgPx: '100000', uTime: String(NOW),
      }],
    }, (id) => (ctValOf(id) as never), NOW)
    expect(events).toHaveLength(1)
    expect(events![0]).toMatchObject({
      kind: 'order',
      channel: 'orders',
      instrumentId: 'okx:BTC-USDT-SWAP',
      venueOrderId: '3122698',
      clientOrderId: 'gtopen1',
      state: 'partially_filled',
      status: 'partially_filled',
      side: 'sell',
      posSide: 'net',
      filledContracts: '2',
      filledBase: '0.02',
      avgPrice: '100000',
      ts: NOW,
    })
  })

  it('falls back to the first non-empty timestamp after an empty fillTime', () => {
    const events = normalizeUserEvents({
      arg: { channel: 'orders' },
      data: [{ instId: 'BTC-USDT-SWAP', ordId: '1', state: 'canceled', fillTime: '', uTime: String(NOW - 5) }],
    }, undefined, NOW)
    expect(events![0]).toMatchObject({ ts: NOW - 5 })
  })

  it('emits one event per data row and keeps fill / fee fields', () => {
    const events = normalizeUserEvents({
      arg: { channel: 'orders' },
      data: [
        { instId: 'BTC-USDT-SWAP', ordId: '1', state: 'filled' },
        {
          instId: 'BTC-USDT-SWAP', ordId: '2', tradeId: '77', fillSz: '2', fillPx: '100000', accFillSz: '2',
          fee: '-0.02', feeCcy: 'USDT', fillFee: '-0.01', fillFeeCcy: 'USDT', execType: 'M', pnl: '1.5', fillPnl: '0.5',
        },
      ],
    }, (id) => (ctValOf(id) as never), NOW)
    expect(events).toHaveLength(2)
    expect(events![1]).toMatchObject({
      tradeId: '77', fillBase: '0.02', fillPrice: '100000', fee: '0.02', fillFee: '0.01',
      liquidity: 'maker', pnl: '1.5', fillPnl: '0.5',
    })
  })

  it('keeps base fields null when ctVal is unknown', () => {
    const events = normalizeUserEvents({
      arg: { channel: 'orders' },
      data: [{ instId: 'XRP-USDT-SWAP', ordId: '1', accFillSz: '2', fillSz: '2', state: 'live' }],
    }, (id) => (ctValOf(id) as never), NOW)
    expect(events![0]).toMatchObject({ filledBase: null, fillBase: null })
  })

  it('maps orders-algo states and uses algoClOrdId', () => {
    const live = normalizeUserEvents({
      arg: { channel: 'orders-algo' },
      data: [{ instId: 'BTC-USDT-SWAP', algoId: '5566', algoClOrdId: 'gtsl1', state: 'live', sz: '2' }],
    }, (id) => (ctValOf(id) as never), NOW)
    expect(live![0]).toMatchObject({ channel: 'orders-algo', venueOrderId: '5566', clientOrderId: 'gtsl1', status: 'untriggered' })
    const effective = normalizeUserEvents({
      arg: { channel: 'orders-algo' },
      data: [{ instId: 'BTC-USDT-SWAP', algoId: '5566', state: 'effective' }],
    }, (id) => (ctValOf(id) as never), NOW)
    expect(effective![0]).toMatchObject({ state: 'effective', status: null })
  })

  it('keeps the unknown so callers can query by clOrdId when the state is unrecognised', () => {
    const events = normalizeUserEvents({
      arg: { channel: 'orders' },
      data: [{ instId: 'BTC-USDT-SWAP', ordId: '1', state: 'brand_new_state' }],
    })
    expect(events![0]).toMatchObject({ kind: 'order', status: null, state: 'brand_new_state' })
  })

  it('normalizes login frames (success and failure)', () => {
    expect(normalizeUserEvents({ event: 'login', success: true })).toMatchObject([{ kind: 'login', ok: true }])
    expect(normalizeUserEvents({ event: 'login', success: false })).toMatchObject([{ kind: 'login', ok: false }])
  })

  it('normalizes error frames', () => {
    expect(normalizeUserEvents({ event: 'error', code: '60009', msg: 'Login failed' }))
      .toMatchObject([{ kind: 'error', code: '60009', msg: 'Login failed' }])
  })

  it('normalizes positions / account channels', () => {
    expect(normalizeUserEvents({ arg: { channel: 'positions' }, data: [{ instId: 'BTC-USDT-SWAP', uTime: String(NOW) }] }))
      .toMatchObject([{ kind: 'account', channel: 'positions', ts: NOW }])
    expect(normalizeUserEvents({ arg: { channel: 'account' }, data: [{ uTime: String(NOW) }] }))
      .toMatchObject([{ kind: 'account', channel: 'account' }])
  })

  it('normalizes subscribe acks and anything else as unknown', () => {
    expect(normalizeUserEvents({ event: 'subscribe', arg: { channel: 'orders' } })).toMatchObject([{ kind: 'subscribed', channel: 'orders' }])
    expect(normalizeUserEvents({ arg: { channel: 'tickers' }, data: [] })).toMatchObject([{ kind: 'unknown', channel: 'tickers' }])
    expect(normalizeUserEvents(null)).toBeNull()
    expect(normalizeUserEvents({ arg: { channel: 'orders' }, data: [] })).toEqual([])
  })

  it('parseUserStreamMessage tolerates broken JSON', () => {
    expect(parseUserStreamMessage('not json')).toBeNull()
    expect(parseUserStreamMessage('{"event":"login","success":true}')).toMatchObject([{ kind: 'login', ok: true }])
  })
})
