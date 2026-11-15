// SPDX-License-Identifier: CPAL-1.0
// 账户读取（全离线）：/fapi/v2/account、/fapi/v2/positionRisk、/fapi/v1/userTrades、启动对账。
// 断言一律走协议的 JSON Schema 校验器（validateConnectorAccountSnapshot / validatePosition / validateBalance）。
import { describe, expect, it } from 'vitest'
import { validateBalance, validateConnectorAccountSnapshot, validateMarginSnapshot, validatePosition } from '@gitrader/protocol'
import type { AccountRef } from '@gitrader/protocol/connector'
import { createWeightBudget } from '../src/budget'
import { BinanceTradeConnector } from '../src/connector'
import { parseAccountSnapshot, parseUserTrade, parsePositionRisk } from '../src/account'
import { API_KEY, API_SECRET, BASE_URL, FakeBinanceTrade, NOW } from './helpers/fake-binance-trade'

const ref = { accountId: 'acct_01TEST', address: '0x0000000000000000000000000000000000000000' } as unknown as AccountRef

async function setup(o: { defaultSymbol?: string } = {}) {
  const f = new FakeBinanceTrade()
  const connector = new BinanceTradeConnector({
    baseUrl: BASE_URL,
    apiKey: API_KEY,
    apiSecret: API_SECRET,
    fetchImpl: f.fetch,
    clock: () => NOW,
    budget: createWeightBudget({ clock: () => NOW }),
    ...(o.defaultSymbol !== undefined ? { defaultSymbol: o.defaultSymbol } : {}),
    onWarn: () => {},
  })
  await connector.start()
  f.reset()
  return { f, connector }
}

describe('/fapi/v2/account → AccountSnapshot', () => {
  it('parses balances with a derived hold, and the margin block', async () => {
    const { connector } = await setup()
    const snap = await connector.accountState(ref)
    expect(snap.accountModel).toBe('standard')
    expect(snap.source).toBe('rest')
    expect(snap.balances).toEqual([
      { accountId: 'acct_01TEST', asset: 'USDT', total: '1000', available: '900', hold: '100', ts: NOW },
      { accountId: 'acct_01TEST', asset: 'BNB', total: '0', available: '0', hold: '0', ts: NOW },
    ])
    expect(snap.margin).toMatchObject({
      model: 'standard', valuationCcy: 'USDT', equity: '1002.5', initialMargin: '100', maintenanceMargin: '10',
      available: '900', marginRatio: '0.00997506', leverage: 0,
    })
  })

  it('positions come from positionRisk (account only supplies balances): long and short exposure', async () => {
    const { f, connector } = await setup()
    const snap = await connector.accountState(ref)
    expect(snap.positions).toHaveLength(2)
    expect(snap.positions[0]).toMatchObject({
      instrumentId: 'binance:BTCUSDT', side: 'long', size: '0.01', entryPrice: '99000', markPrice: '100000',
      notional: '1000', unrealizedPnl: '10', leverage: 10, marginMode: 'cross', liquidationPrice: null,
    })
    expect(snap.positions[1]).toMatchObject({
      instrumentId: 'binance:ETHUSDT', side: 'short', size: '2.5', entryPrice: '3100', markPrice: '3000',
      notional: '7500', unrealizedPnl: '250', leverage: 20, marginMode: 'isolated', liquidationPrice: '3900',
    })
    // account 只打一次，持仓看 positionRisk
    expect(f.callsFor('GET', '/fapi/v2/account')).toHaveLength(1)
    expect(f.callsFor('GET', '/fapi/v2/positionRisk')).toHaveLength(1)
  })

  it('the snapshot passes the protocol JSON Schema', async () => {
    const { connector } = await setup()
    const snap = await connector.accountState(ref)
    expect(validateConnectorAccountSnapshot(snap)).toMatchObject({ ok: true })
    for (const b of snap.balances) expect(validateBalance(b)).toMatchObject({ ok: true })
    expect(validateMarginSnapshot(snap.margin)).toMatchObject({ ok: true })
    for (const p of snap.positions) expect(validatePosition(p)).toMatchObject({ ok: true })
  })

  it('a 401 on the account read becomes VENUE_AUTH with a redacted body', async () => {
    const { f, connector } = await setup()
    f.fail('GET', '/fapi/v2/account', { code: -2015, msg: `Invalid API-key ${API_KEY}` }, 401)
    await expect(connector.accountState(ref)).rejects.toMatchObject({
      problem: { name: 'VENUE_AUTH' },
    })
  })
})

describe('/fapi/v2/positionRisk → Position[]', () => {
  it('maps a short isolated position: absolute size, notional, liquidation price, leverage', async () => {
    const { connector } = await setup()
    const positions = await connector.accounts.positions(ref)
    expect(positions).toHaveLength(2)
    expect(positions[1]).toMatchObject({
      instrumentId: 'binance:ETHUSDT', side: 'short', size: '2.5', entryPrice: '3100', markPrice: '3000',
      notional: '7500', unrealizedPnl: '250', leverage: 20, marginMode: 'isolated',
    })
    expect(positions[1]!.liquidationPrice).toBe('3900')
    expect(validatePosition(positions[1]!)).toMatchObject({ ok: true })
  })

  it('derives notional from positionAmt × markPrice when the venue omits it (decimal, no float)', () => {
    const rows = [{ symbol: 'BTCUSDT', positionAmt: '0.30000000', entryPrice: '100', markPrice: '0.66666667', unRealizedProfit: '0.00000001', marginType: 'cross', leverage: '3' }]
    const [p] = parsePositionRisk(rows, 'acct_01TEST', NOW)
    expect(p).toMatchObject({ size: '0.3', notional: '0.200000001', unrealizedPnl: '0.00000001', marginMode: 'cross' })
  })

  it('parsePositionRisk tolerates an empty / malformed body and skips zero amounts', () => {
    expect(parsePositionRisk(null, 'acct_01TEST', NOW)).toEqual([])
    expect(parsePositionRisk([{ symbol: 'BTCUSDT', positionAmt: '0' }], 'acct_01TEST', NOW)).toEqual([])
  })
})

describe('/fapi/v1/userTrades → VenueFill', () => {
  it('namespaces native and fallback trade ids by symbol', () => {
    const nativeIds = ['BTCUSDT', 'ETHUSDT'].map((symbol) => parseUserTrade({ symbol, id: 77, orderId: 9, qty: '1', time: 123 }, NOW)!.venueFillId)
    const fallbackIds = ['BTCUSDT', 'ETHUSDT'].map((symbol) => parseUserTrade({ symbol, orderId: 9, qty: '1', time: 123 }, NOW)!.venueFillId)
    expect(nativeIds).toEqual(['BTCUSDT:77', 'ETHUSDT:77'])
    expect(fallbackIds).toEqual(['BTCUSDT:9-123', 'ETHUSDT:9-123'])
    const explicitEmptyId = parseUserTrade({ symbol: 'BTCUSDT', id: '' as unknown as number, qty: '1', time: 123 }, NOW)
    expect(explicitEmptyId!.venueFillId).toBe('')
  })

  it('parses both maker and taker fills with fees and venue ids', async () => {
    const { f, connector } = await setup({ defaultSymbol: 'BTCUSDT' })
    const fills = await connector.fills(ref, NOW - 60_000)
    expect(fills).toHaveLength(2)
    expect(fills[0]).toMatchObject({
      venueFillId: 'BTCUSDT:11', venueOrderId: '1001', instrumentId: 'binance:BTCUSDT', side: 'buy', price: '100.1',
      size: '0.005', fee: '0.0002', feeCcy: 'USDT', liquidity: 'taker', realizedPnl: '0', ts: NOW - 500,
    })
    expect(fills[1]!.liquidity).toBe('maker')
    const call = f.callsFor('GET', '/fapi/v1/userTrades')[0]!
    expect(call.params.get('symbol')).toBe('BTCUSDT')
    expect(call.params.get('startTime')).toBe(String(NOW - 60_000))
    expect(call.params.get('limit')).toBe('1000')
  })

  it('refuses to guess a symbol when neither the call nor the connector has one', async () => {
    const { f, connector } = await setup()
    await expect(connector.fills(ref, NOW - 60_000)).rejects.toMatchObject({ problem: { name: 'INVALID_PARAMS' } })
    expect(f.callsFor('GET', '/fapi/v1/userTrades')).toHaveLength(0)
  })

  it('uses the explicit instrumentId for fills when no default symbol exists', async () => {
    const { f, connector } = await setup()
    const fills = await connector.fills(ref, NOW - 60_000, { instrumentId: 'binance:BTCUSDT' })
    expect(fills).toHaveLength(2)
    expect(f.callsFor('GET', '/fapi/v1/userTrades')[0]!.params.get('symbol')).toBe('BTCUSDT')
  })

  it('parseUserTrade drops zero-quantity rows', () => {
    expect(parseUserTrade({ symbol: 'BTCUSDT', qty: '0', price: '100', id: 1, orderId: 2 }, NOW)).toBeNull()
    expect(parseUserTrade({ qty: '1', price: '100' }, NOW)).toBeNull()
  })
})

describe('startup snapshot', () => {
  it('bundles account + open orders + fills, not truncated below the page limit', async () => {
    const { f, connector } = await setup({ defaultSymbol: 'BTCUSDT' })
    const snap = await connector.startupSnapshot(ref, NOW - 3_600_000)
    expect(snap.account.balances).toHaveLength(2)
    expect(snap.openOrders).toHaveLength(2)
    expect(snap.fills).toHaveLength(2)
    expect(snap.fillsSince).toBe(NOW - 3_600_000)
    expect(snap.truncated).toBe(false)
    // 持仓 ∪ 挂单的 symbol 集合都要拉一遍 userTrades（不只 defaultSymbol）
    const symbols = f.callsFor('GET', '/fapi/v1/userTrades').map((c) => c.params.get('symbol')).sort()
    expect(symbols).toEqual(['BTCUSDT', 'ETHUSDT'])
  })

  it('reads algo open orders too and includes their symbols in the reconciliation set', async () => {
    const { f, connector } = await setup()
    f.openAlgoOrders = [{ symbol: 'SOLUSDT', algoId: 4001, clientAlgoId: 'gt-algo-1', side: 'SELL', orderType: 'STOP_MARKET', algoStatus: 'NEW', quantity: '3', triggerPrice: '90', reduceOnly: true, createTime: NOW - 1_000 }]
    const snap = await connector.startupSnapshot(ref, NOW - 3_600_000)
    expect(f.callsFor('GET', '/fapi/v1/openAlgoOrders')).toHaveLength(1)
    expect(snap.openOrders).toHaveLength(3)
    expect(snap.openOrders[2]).toMatchObject({
      instrumentId: 'binance:SOLUSDT', venueOrderId: '4001', clientOrderId: 'gt-algo-1', type: 'stop_market',
      triggerPrice: '90', size: '3', origSize: '3', reduceOnly: true, isTrigger: true,
    })
    const symbols = f.callsFor('GET', '/fapi/v1/userTrades').map((c) => c.params.get('symbol'))
    expect(symbols).toContain('SOLUSDT')
  })

  it('marks truncated when the venue returns a full page (1000 rows)', async () => {
    const { f, connector } = await setup({ defaultSymbol: 'BTCUSDT' })
    f.userTrades = Array.from({ length: 1000 }, (_, i) => ({
      symbol: 'BTCUSDT', id: i + 1, orderId: 1001, side: 'BUY', price: '100', qty: '0.001',
      realizedPnl: '0', commission: '0.001', commissionAsset: 'USDT', time: NOW - i * 10, maker: false,
    }))
    const snap = await connector.startupSnapshot(ref, NOW - 3_600_000)
    expect(snap.fills).toHaveLength(1000)
    expect(snap.truncated).toBe(true)
  })

  it('orderStatus reports found=false for -2013 (order does not exist) instead of throwing', async () => {
    const { f, connector } = await setup({ defaultSymbol: 'BTCUSDT' })
    f.fail('GET', '/fapi/v1/order', { code: -2013, msg: 'Order does not exist.' })
    f.fail('GET', '/fapi/v1/algoOrder', { code: -2013, msg: 'Order does not exist.' })
    const status = await connector.orderStatus(ref, { venueOrderId: 'nope' })
    expect(status.found).toBe(false)
  })

  it('orderStatus uses an explicit instrumentId when no default symbol exists', async () => {
    const { f, connector } = await setup()
    const status = await connector.orderStatus(ref, { venueOrderId: '1001', instrumentId: 'binance:BTCUSDT' })
    expect(status.found).toBe(true)
    expect(f.callsFor('GET', '/fapi/v1/order')[0]!.params.get('symbol')).toBe('BTCUSDT')
  })

  it('orderStatus falls back to GET /fapi/v1/algoOrder when the regular order does not exist', async () => {
    const { f, connector } = await setup({ defaultSymbol: 'BTCUSDT' })
    f.fail('GET', '/fapi/v1/order', { code: -2013, msg: 'Order does not exist.' })
    const status = await connector.orderStatus(ref, { clientOrderId: 'gt-algo-1' })
    expect(status).toMatchObject({ found: true, status: 'TRIGGERED', venueOrderId: '3001' })
    expect(f.callsFor('GET', '/fapi/v1/order')).toHaveLength(1)
    expect(f.callsFor('GET', '/fapi/v1/algoOrder')[0]!.params.get('clientAlgoId')).toBe('gt-algo-1')
  })

  it('parseAccountSnapshot works on a raw body without a network round-trip', () => {
    const snap = parseAccountSnapshot({ totalWalletBalance: '10', assets: [], positions: [] }, 'acct_01TEST', NOW)
    expect(snap.balances).toEqual([])
    expect(snap.margin.equity).toBe('10')
    expect(validateConnectorAccountSnapshot(snap)).toMatchObject({ ok: true })
  })
})
