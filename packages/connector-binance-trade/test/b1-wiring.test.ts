// SPDX-License-Identifier: CPAL-1.0
import { describe, expect, it } from 'vitest'
import type { AccountRef } from '@gitrader/protocol/connector'
import { BinanceTradeConnector } from '../src/connector'
import { createWeightBudget } from '../src/budget'
import { normalizeUserEvent } from '../src/parse'
import { API_KEY, API_SECRET, BASE_URL, FakeBinanceTrade, NOW } from './helpers/fake-binance-trade'

const ref = { accountId: 'acct_test' } as unknown as AccountRef
const DAY_MS = 86_400_000

async function setup() {
  const f = new FakeBinanceTrade()
  const connector = new BinanceTradeConnector({
    baseUrl: BASE_URL,
    apiKey: API_KEY,
    apiSecret: API_SECRET,
    fetchImpl: f.fetch,
    clock: () => NOW,
    budget: createWeightBudget({ clock: () => NOW }),
    onWarn: () => {},
  })
  await connector.start()
  f.reset()
  return { f, connector }
}

function algo(status: string, over: Record<string, unknown> = {}) {
  return normalizeUserEvent({
    e: 'ALGO_UPDATE', E: NOW, T: NOW + 1, o: {
      aid: 701, caid: 'client-algo', X: status, ai: 901, aq: '0', ap: '0', tp: '99', q: '2',
      s: 'BTCUSDT', S: 'SELL', ps: 'LONG', o: 'STOP_MARKET', R: true,
      ...over,
    },
  })
}

describe('Binance ALGO_UPDATE wiring', () => {
  it('uses the outer transaction time ahead of the event time', () => {
    const event = normalizeUserEvent({
      e: 'ALGO_UPDATE', E: NOW + 2, T: NOW + 5,
      o: { aid: 701, X: 'NEW', q: '2', s: 'BTCUSDT', S: 'SELL' },
    })
    expect(event).toMatchObject({ kind: 'order', ts: NOW + 5 })
  })

  it('falls back to the outer event time when transaction time is missing', () => {
    const event = normalizeUserEvent({
      e: 'ALGO_UPDATE', E: NOW + 2,
      o: { aid: 701, X: 'NEW', q: '2', s: 'BTCUSDT', S: 'SELL', T: NOW + 5 },
    })
    expect(event).toMatchObject({ kind: 'order', ts: NOW + 2 })
  })

  it('normalizes lifecycle statuses without inventing fills', () => {
    const cases = [
      ['NEW', 'untriggered'], ['TRIGGERING', null], ['TRIGGERED', 'open'],
      ['FINISHED', 'filled'], ['CANCELED', 'cancelled'], ['REJECTED', 'rejected'], ['EXPIRED', 'expired'],
    ] as const
    for (const [status, expected] of cases) {
      const ev = algo(status, status === 'FINISHED' ? { aq: '2', ap: '1.5' } : {})
      expect(ev).toMatchObject({
        kind: 'order', rawStatus: status, status: expected, instrumentId: 'binance:BTCUSDT',
        venueOrderId: status === 'TRIGGERED' || status === 'FINISHED' ? '901' : '701',
        clientOrderId: 'client-algo', filledSize: status === 'FINISHED' ? '2' : '0',
        avgPrice: status === 'FINISHED' ? '1.5' : '0', stopPrice: '99', side: 'sell', positionSide: 'LONG',
        orderType: 'STOP_MARKET', reduceOnly: true, ts: NOW + 1,
        tradeId: '', lastFillSize: '0', lastFillPrice: null, fee: null, feeCcy: null, realizedPnl: '0', maker: false,
      })
    }
    expect(algo('UNKNOWN')).toMatchObject({ kind: 'order', status: null })
    expect(algo('NEW', { ia: false })).toMatchObject({ kind: 'order', status: 'untriggered', tradeId: '' })
    expect(algo('NEW', { ia: true })).toMatchObject({ kind: 'order', status: 'untriggered', tradeId: '' })
  })

  it('treats FINISHED partial or zero execution as canceled and ambiguous quantities as unknown', () => {
    expect(algo('FINISHED', { aq: '0' })).toMatchObject({ kind: 'order', status: 'cancelled', filledSize: '0' })
    expect(algo('FINISHED', { aq: '1.25', q: '2' })).toMatchObject({ kind: 'order', status: 'cancelled', filledSize: '1.25' })
    for (const fields of [{ q: undefined }, { aq: undefined }, { q: '-1' }, { aq: '-1' }, { aq: '3' }, { q: '2', aq: 'bad' }, { aq: 1 }]) {
      expect(algo('FINISHED', fields)).toMatchObject({ kind: 'order', status: null })
    }
    expect(algo('FINISHED', { q: '0', aq: '0' })).toMatchObject({ kind: 'order', status: null })
    expect(algo('FINISHED', { q: undefined, aq: '0', closePosition: true })).toMatchObject({ kind: 'order', status: null })
  })

  it('rejects malformed frames instead of creating a venue order identity', () => {
    expect(algo('NEW', { s: '' })).toBeNull()
    expect(algo('NEW', { aid: undefined })).toBeNull()
    expect(algo('NEW', { S: 'SIDEWAYS' })).toBeNull()
  })
})

describe('Binance read wiring', () => {
  it('requires both regular and algo open order reads to be complete and well formed', async () => {
    const { f, connector } = await setup()
    f.openAlgoOrders = [{ symbol: 'SOLUSDT', algoId: 4001, clientAlgoId: 'algo-client', side: 'SELL', orderType: 'STOP_MARKET', quantity: '3', triggerPrice: '90' }]
    const orders = await connector.accounts.openOrders(ref)
    expect(orders).toHaveLength(3)
    expect(orders[2]).toMatchObject({ venueOrderId: '4001', isTrigger: true })

    for (const path of ['/fapi/v1/openOrders', '/fapi/v1/openAlgoOrders']) {
      const { f: broken, connector: brokenConnector } = await setup()
      broken.fail('GET', path, { code: -1000, msg: 'read failed' })
      await expect(brokenConnector.accounts.openOrders(ref)).rejects.toMatchObject({ problem: { name: 'DATA_UNAVAILABLE' } })
      expect(broken.calls.some((c) => c.method !== 'GET')).toBe(false)
    }

    for (const [field, badValues] of [
      ['openOrders', ['not-an-array', [{ orderId: 1 }], [{ symbol: 'BTCUSDT' }]]],
      ['openAlgoOrders', ['not-an-array', [{ algoId: 1 }], [{ symbol: 'BTCUSDT' }]]],
    ] as const) {
      for (const value of badValues) {
        const { f: malformed, connector: malformedConnector } = await setup()
        malformed[field] = value
        await expect(malformedConnector.accounts.openOrders(ref)).rejects.toMatchObject({ problem: { name: 'DATA_UNAVAILABLE' } })
        expect(malformed.calls.some((c) => c.method !== 'GET')).toBe(false)
      }
    }
  })

  it('accepts empty order arrays and carries algo rows into startup reconciliation', async () => {
    const { f, connector } = await setup()
    f.openOrders = []
    f.openAlgoOrders = [{ symbol: 'SOLUSDT', algoId: 4001, side: 'SELL', orderType: 'STOP_MARKET', quantity: '3' }]
    const snapshot = await connector.accounts.startupSnapshot(ref, NOW - DAY_MS)
    expect(snapshot.openOrders).toHaveLength(1)
    expect(snapshot.openOrders[0]).toMatchObject({ venueOrderId: '4001', isTrigger: true })
    expect(f.callsFor('GET', '/fapi/v1/userTrades').map((call) => call.params.get('symbol'))).toContain('SOLUSDT')
    expect(f.calls.some((c) => c.method !== 'GET')).toBe(false)

    const empty = await setup()
    empty.f.openOrders = []
    empty.f.openAlgoOrders = []
    await expect(empty.connector.accounts.openOrders(ref)).resolves.toEqual([])
  })

  it('enforces the local 90-day fills window before making a request', async () => {
    const { f, connector } = await setup()
    const cutoff = NOW - 90 * DAY_MS
    for (const sinceMs of [cutoff - 1, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(connector.accounts.fills(ref, sinceMs, { symbol: 'BTCUSDT' })).rejects.toMatchObject({
        problem: { name: 'INVALID_PARAMS', message: expect.stringContaining('3 months') },
      })
    }
    expect(f.callsFor('GET', '/fapi/v1/userTrades')).toHaveLength(0)
    const boundary = await connector.accounts.fills(ref, cutoff, { symbol: 'BTCUSDT' })
    expect(boundary).toHaveLength(2)
    expect(f.callsFor('GET', '/fapi/v1/userTrades')).toHaveLength(1)
  })
})
