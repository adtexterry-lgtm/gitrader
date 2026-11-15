// SPDX-License-Identifier: CPAL-1.0
// 交易动作（全离线，假服务器）：submit / cancel / cancelAll / amend / status / openOrders / 杠杆 / 死人开关。
import { describe, expect, it } from 'vitest'
import type { OrderIntent } from '@gitrader/protocol'
import type { TradeContext } from '@gitrader/protocol/connector'
import { createWeightBudget } from '../src/budget'
import { BinanceTradeConnector } from '../src/connector'
import { API_KEY, API_SECRET, BASE_URL, FakeBinanceTrade, NOW } from './helpers/fake-binance-trade'

const ctx = (): TradeContext => ({
  account: { accountId: 'acct_01TEST', address: '0x0000000000000000000000000000000000000000' },
  signer: {
    address: '0x0000000000000000000000000000000000000000',
    signTypedData: async () => '0x00',
  },
}) as unknown as TradeContext

const intent = (over: Record<string, unknown> = {}): OrderIntent => ({
  accountId: 'acct_01TEST',
  instrumentId: 'binance:BTCUSDT',
  side: 'buy',
  type: 'limit',
  size: '0.010',
  price: '95000',
  ...over,
}) as unknown as OrderIntent

async function setup(o: { positionMode?: 'oneWay' | 'hedge'; defaultSymbol?: string; budget?: ReturnType<typeof createWeightBudget> } = {}) {
  const f = new FakeBinanceTrade()
  const connector = new BinanceTradeConnector({
    baseUrl: BASE_URL,
    apiKey: API_KEY,
    apiSecret: API_SECRET,
    fetchImpl: f.fetch,
    clock: () => NOW,
    budget: o.budget ?? createWeightBudget({ clock: () => NOW }),
    ...(o.positionMode !== undefined ? { positionMode: o.positionMode } : {}),
    ...(o.defaultSymbol !== undefined ? { defaultSymbol: o.defaultSymbol } : {}),
    onWarn: () => {},
  })
  await connector.start()
  f.reset()
  return { f, connector }
}

describe('submit', () => {
  it('market order: LIMIT + IOC at ref ± slippage via POST /fapi/v1/order, ack filled', async () => {
    const { f, connector } = await setup()
    connector.market.seedQuote('binance:BTCUSDT', 99.9, 100.1)
    f.orderResponse = (p) => ({ orderId: 1001, clientOrderId: p.get('newClientOrderId'), status: 'FILLED', executedQty: '0.1', avgPrice: '100.1' })
    const res = await connector.submit(ctx(), [intent({ type: 'market', price: undefined, size: '0.1', maxSlippageBps: 10, clientOrderId: 'gt-mkt-1' })])
    expect(res.acks).toHaveLength(1)
    expect(res.acks[0]).toMatchObject({ intentIndex: 0, status: 'filled', venueOrderId: '1001', filledSize: '0.1', avgFillPrice: '100.1' })
    expect(res.acks[0]!.builder).toEqual({ attached: false })
    const call = f.callsFor('POST', '/fapi/v1/order')[0]!
    expect(call.params.get('type')).toBe('LIMIT')
    expect(call.params.get('timeInForce')).toBe('IOC')
    expect(call.params.get('price')).toBe('100.1')
    expect(call.params.get('quantity')).toBe('0.1')
    expect(call.params.get('newClientOrderId')).toBe('gt-mkt-1')
    expect(call.apiKey).toBe(API_KEY)
  })

  it('market order without maxSlippageBps is rejected locally (INVALID_PARAMS, no HTTP)', async () => {
    const { f, connector } = await setup()
    connector.market.seedQuote('binance:BTCUSDT', 99.9, 100.1)
    const res = await connector.submit(ctx(), [intent({ type: 'market', price: undefined })])
    expect(res.acks[0]!.problem?.name).toBe('INVALID_PARAMS')
    expect(f.callsFor('POST', '/fapi/v1/order')).toHaveLength(0)
  })

  it('a market order whose reference quote is older than refPriceMaxAgeMs is rejected (reference price stale), nothing sent', async () => {
    let now = NOW
    const f = new FakeBinanceTrade()
    const connector = new BinanceTradeConnector({
      baseUrl: BASE_URL, apiKey: API_KEY, apiSecret: API_SECRET, fetchImpl: f.fetch, clock: () => now,
      budget: createWeightBudget({ clock: () => now }), onWarn: () => {},
    })
    await connector.start()
    connector.market.seedQuote('binance:BTCUSDT', 99.9, 100.1)
    now += 5_001
    const res = await connector.submit(ctx(), [intent({ type: 'market', price: undefined, size: '0.1', maxSlippageBps: 10 })])
    expect(res.acks[0]!.status).toBe('rejected')
    expect(res.acks[0]!.problem?.name).toBe('INVALID_PARAMS')
    expect(res.acks[0]!.problem?.message).toContain('reference price stale')
    expect(f.callsFor('POST', '/fapi/v1/order')).toHaveLength(0)
  })

  it('limit order acknowledged NEW by the venue is open with filledSize 0', async () => {
    const { connector } = await setup()
    const res = await connector.submit(ctx(), [intent()])
    expect(res.acks[0]).toMatchObject({ status: 'open', filledSize: '0', avgFillPrice: null })
    expect(res.acks[0]!.venueOrderId).toBe('1001')
  })

  it('a trigger order goes to POST /fapi/v1/algoOrder with algo params and ack untriggered', async () => {
    const { f, connector } = await setup()
    const res = await connector.submit(ctx(), [intent({ type: 'stop_market', price: undefined, triggerPrice: '90000', clientOrderId: 'gt-stop-9' })])
    expect(res.acks[0]!.status).toBe('untriggered')
    expect(res.acks[0]!.venueOrderId).toBe('3001')
    expect(res.acks[0]!.clientOrderId).toBe('gt-stop-9')
    expect(f.callsFor('POST', '/fapi/v1/order')).toHaveLength(0)
    const call = f.callsFor('POST', '/fapi/v1/algoOrder')[0]!
    expect(call.params.get('algoType')).toBe('CONDITIONAL')
    expect(call.params.get('type')).toBe('STOP_MARKET')
    expect(call.params.get('triggerPrice')).toBe('90000')
    expect(call.params.get('workingType')).toBe('MARK_PRICE')
    expect(call.params.get('clientAlgoId')).toBe('gt-stop-9')
    expect(call.params.get('stopPrice')).toBeNull()
    expect(call.params.get('newClientOrderId')).toBeNull()
  })

  it('intents with tpsl are rejected with 1004 and never reach the venue', async () => {
    const { f, connector } = await setup()
    const res = await connector.submit(ctx(), [intent({
      tpsl: { takeProfit: { triggerPrice: '110000' }, stopLoss: { triggerPrice: '90000' }, grouping: 'position' },
    })])
    expect(res.acks[0]!.status).toBe('rejected')
    expect(res.acks[0]!.problem?.code).toBe(1004)
    expect(res.acks[0]!.problem?.message).toContain('buildProtectionOrders')
    expect(f.callsFor('POST', '/fapi/v1/order')).toHaveLength(0)
    expect(f.callsFor('POST', '/fapi/v1/algoOrder')).toHaveLength(0)
  })

  it('an unknown instrument is rejected locally with 1001 (no HTTP)', async () => {
    const { f, connector } = await setup()
    const res = await connector.submit(ctx(), [intent({ instrumentId: 'binance:NOPEUSDT' })])
    expect(res.acks[0]!.problem?.code).toBe(1001)
    expect(f.callsFor('POST', '/fapi/v1/order')).toHaveLength(0)
  })

  it('a venue rejection (-2019) becomes a rejected ack carrying 3004 and the upstream text', async () => {
    const { f, connector } = await setup()
    f.fail('POST', '/fapi/v1/order', { code: -2019, msg: 'Margin is insufficient.' })
    const res = await connector.submit(ctx(), [intent()])
    expect(res.acks[0]!.status).toBe('rejected')
    expect(res.acks[0]!.problem?.code).toBe(3004)
    expect(res.acks[0]!.problem?.venue?.message).toContain('Margin is insufficient')
  })

  it('a 5xx on submit is status unknown (3006) — the kernel must query by clientOrderId', async () => {
    const { f, connector } = await setup()
    f.failWith.set('POST /fapi/v1/order', () => new Response('bad gateway', { status: 502 }))
    const res = await connector.submit(ctx(), [intent({ clientOrderId: 'gt-unknown-1' })])
    expect(res.acks[0]!.status).toBe('unknown')
    expect(res.acks[0]!.problem?.code).toBe(3006)
  })

  it('one rejected intent does not stop the others', async () => {
    const { connector } = await setup()
    const res = await connector.submit(ctx(), [intent({ instrumentId: 'binance:NOPEUSDT' }), intent({ clientOrderId: 'gt-second' })])
    expect(res.acks).toHaveLength(2)
    expect(res.acks[0]!.problem?.code).toBe(1001)
    expect(res.acks[1]!.status).toBe('open')
  })

  it('an expired response with fills is not a rejection (partial fill → open, full fill → filled)', async () => {
    const { f, connector } = await setup()
    f.orderResponse = (p) => ({ orderId: 1001, clientOrderId: p.get('newClientOrderId'), status: 'EXPIRED', executedQty: '0.004', origQty: '0.010' })
    const partial = await connector.submit(ctx(), [intent()])
    expect(partial.acks[0]).toMatchObject({ status: 'open', filledSize: '0.004' })
    expect(partial.acks[0]!.problem).toBeUndefined()
    f.orderResponse = (p) => ({ orderId: 1001, clientOrderId: p.get('newClientOrderId'), status: 'EXPIRED', executedQty: '0.010', origQty: '0.010' })
    const full = await connector.submit(ctx(), [intent()])
    expect(full.acks[0]!.status).toBe('filled')
  })

  it('a canceled response without fills is still a rejection', async () => {
    const { f, connector } = await setup()
    f.orderResponse = (p) => ({ orderId: 1001, clientOrderId: p.get('newClientOrderId'), status: 'CANCELED', executedQty: '0' })
    const res = await connector.submit(ctx(), [intent()])
    expect(res.acks[0]!.status).toBe('rejected')
    expect(res.acks[0]!.problem?.name).toBe('VENUE_REJECTED')
  })

  it('receiptHash is the sha256 of the raw responses and stays stable', async () => {
    const { connector } = await setup()
    const a = await connector.submit(ctx(), [intent({ clientOrderId: 'gt-stable' })])
    const b = await connector.submit(ctx(), [intent({ clientOrderId: 'gt-stable' })])
    expect(a.receiptHash).toMatch(/^[0-9a-f]{64}$/)
    expect(a.receiptHash).toBe(b.receiptHash)
    expect(a.requestWeight).toBe(0) // Binance charges orders to a separate count bucket, not request weight
  })
})

describe('leverage and margin mode', () => {
  it('rejects an explicit mode that differs from positionRisk without settings or order writes', async () => {
    const { f, connector } = await setup()
    f.positionRisk = [{ symbol: 'BTCUSDT', marginType: 'cross' }]
    const result = await connector.submit(ctx(), [intent({ marginMode: 'isolated' })])
    expect(result.acks[0]!.status).toBe('rejected')
    expect(result.acks[0]!.problem?.name).toBe('INVALID_PARAMS')
    expect(result.acks[0]!.problem?.message).toContain('hint: 请在场所显式确认保证金模式；订单不会切换模式')
    expect(f.callsFor('GET', '/fapi/v2/positionRisk')).toHaveLength(1)
    expect(f.callsFor('POST', '/fapi/v1/leverage')).toHaveLength(0)
    expect(f.callsFor('POST', '/fapi/v1/marginType')).toHaveLength(0)
    expect(f.callsFor('POST', '/fapi/v1/order')).toHaveLength(0)
  })

  it('rejects an unknown explicit mode rather than guessing cross', async () => {
    const { f, connector } = await setup()
    f.positionRisk = [{ symbol: 'BTCUSDT', positionAmt: '0' }]
    const result = await connector.submit(ctx(), [intent({ marginMode: 'cross' })])
    expect(result.acks[0]!.problem?.name).toBe('INVALID_PARAMS')
    expect(f.callsFor('POST', '/fapi/v1/marginType')).toHaveLength(0)
    expect(f.callsFor('POST', '/fapi/v1/order')).toHaveLength(0)
  })

  it('rejects conflicting positionRisk modes, including a zero-position row, without writes', async () => {
    const { f, connector } = await setup()
    f.positionRisk = [
      { symbol: 'BTCUSDT', marginType: 'cross', positionAmt: '1' },
      { symbol: 'BTCUSDT', marginType: 'isolated', positionAmt: '0' },
    ]
    const result = await connector.submit(ctx(), [intent({ marginMode: 'isolated' })])
    expect(result.acks[0]!.problem?.name).toBe('INVALID_PARAMS')
    expect(result.acks[0]!.problem?.message).toContain('hint: 请在场所显式确认保证金模式；订单不会切换模式')
    expect(f.calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual(['GET /fapi/v2/positionRisk'])
    expect(f.callsFor('POST', '/fapi/v1/marginType')).toHaveLength(0)
    expect(f.callsFor('POST', '/fapi/v1/leverage')).toHaveLength(0)
    expect(f.callsFor('POST', '/fapi/v1/order')).toHaveLength(0)
  })

  it('uses a confirmed isolated mode for leverage without submitting marginType', async () => {
    const { f, connector } = await setup()
    f.positionRisk = [{ symbol: 'BTCUSDT', marginType: 'isolated', positionAmt: '0' }]
    const result = await connector.submit(ctx(), [intent({ leverage: 10, marginMode: 'strictIsolated' })])
    expect(result.acks[0]!.status).toBe('open')
    expect(f.callsFor('POST', '/fapi/v1/leverage')).toHaveLength(1)
    expect(f.callsFor('POST', '/fapi/v1/marginType')).toHaveLength(0)
    expect(f.callsFor('POST', '/fapi/v1/order')).toHaveLength(1)
  })

  it('reduceOnly with an explicit mode remains submit-able and never sends marginType', async () => {
    const { f, connector } = await setup()
    const result = await connector.submit(ctx(), [intent({ side: 'sell', reduceOnly: true, leverage: 5, marginMode: 'isolated' })])
    expect(result.acks[0]!.status).toBe('open')
    expect(f.callsFor('GET', '/fapi/v2/positionRisk')).toHaveLength(0)
    expect(f.callsFor('POST', '/fapi/v1/marginType')).toHaveLength(0)
    expect(f.callsFor('POST', '/fapi/v1/order')).toHaveLength(1)
  })

  it('explicit setLeverage applies leverage + marginType; submit reuses leverage once per instrument', async () => {
    const { f, connector } = await setup()
    f.positionRisk = [{ symbol: 'BTCUSDT', marginType: 'isolated' }]
    await connector.setLeverage(ctx(), 'binance:BTCUSDT', 10, 'isolated')
    const lev = f.callsFor('POST', '/fapi/v1/leverage')
    expect(lev).toHaveLength(1)
    expect(lev[0]!.params.get('leverage')).toBe('10')
    expect(f.callsFor('POST', '/fapi/v1/marginType')[0]!.params.get('marginType')).toBe('ISOLATED')
    const res = await connector.submit(ctx(), [intent({ leverage: 10, marginMode: 'isolated' })])
    expect(res.acks[0]!.status).toBe('open')
    expect(lev).toHaveLength(1)
    // 第二次同样的杠杆不再发
    await connector.submit(ctx(), [intent({ leverage: 10, marginMode: 'isolated' })])
    expect(f.callsFor('POST', '/fapi/v1/leverage')).toHaveLength(1)
    expect(f.callsFor('POST', '/fapi/v1/marginType')).toHaveLength(1)
    expect(connector.trading.leverageState()).toEqual([{ instrumentId: 'binance:BTCUSDT', leverage: 10, marginMode: 'isolated' }])
  })

  it('explicit setLeverage treats marginType -4046 (no need to change) as success before submit', async () => {
    const { f, connector } = await setup()
    f.fail('POST', '/fapi/v1/marginType', { code: -4046, msg: 'No need to change margin type.' })
    await connector.setLeverage(ctx(), 'binance:BTCUSDT', 5, 'cross')
    const res = await connector.submit(ctx(), [intent({ leverage: 5, marginMode: 'cross' })])
    expect(res.acks[0]!.status).toBe('open')
    expect(f.callsFor('POST', '/fapi/v1/marginType')).toHaveLength(1)
  })

  it('a leverage failure rejects only that intent', async () => {
    const { f, connector } = await setup()
    f.fail('POST', '/fapi/v1/leverage', { code: -4028, msg: 'Leverage is not valid.' })
    const res = await connector.submit(ctx(), [intent({ leverage: 20 })])
    expect(res.acks[0]!.status).toBe('rejected')
    expect(res.acks[0]!.problem?.code).toBe(3001)
    expect(f.callsFor('POST', '/fapi/v1/order')).toHaveLength(0)
  })

  it('setLeverage validates the range (1..125)', async () => {
    const { connector } = await setup()
    await expect(connector.setLeverage(ctx(), 'binance:BTCUSDT', 0, 'cross')).rejects.toThrow()
    await expect(connector.setLeverage(ctx(), 'binance:BTCUSDT', 126, 'cross')).rejects.toThrow()
    await connector.setLeverage(ctx(), 'binance:BTCUSDT', 20, 'cross')
  })
})

describe('cancel / cancelAll', () => {
  it('cancel by venueOrderId sends DELETE with orderId', async () => {
    const { f, connector } = await setup()
    const acks = await connector.cancel(ctx(), [{ instrumentId: 'binance:BTCUSDT', venueOrderId: '1001' }])
    expect(acks[0]!.ok).toBe(true)
    const call = f.callsFor('DELETE', '/fapi/v1/order')[0]!
    expect(call.params.get('orderId')).toBe('1001')
    expect(call.params.get('symbol')).toBe('BTCUSDT')
  })

  it('cancel by clientOrderId sends origClientOrderId', async () => {
    const { f, connector } = await setup()
    const acks = await connector.cancel(ctx(), [{ instrumentId: 'binance:BTCUSDT', clientOrderId: 'gt-cancel-1' }])
    expect(acks[0]!.ok).toBe(true)
    expect(f.callsFor('DELETE', '/fapi/v1/order')[0]!.params.get('origClientOrderId')).toBe('gt-cancel-1')
  })

  it('cancel without a target id or with a foreign instrument fails locally', async () => {
    const { f, connector } = await setup()
    const acks = await connector.cancel(ctx(), [
      { instrumentId: 'binance:BTCUSDT' },
      { instrumentId: 'hyperliquid:BTC', venueOrderId: '1' },
    ] as never)
    expect(acks[0]!.ok).toBe(false)
    expect(acks[0]!.problem?.code).toBe(-32602)
    expect(f.callsFor('DELETE', '/fapi/v1/order')).toHaveLength(0)
  })

  it('cancel falls back to DELETE /fapi/v1/algoOrder when the order is an algo order', async () => {
    const { f, connector } = await setup()
    f.fail('DELETE', '/fapi/v1/order', { code: -2011, msg: 'Unknown order sent.' })
    const acks = await connector.cancel(ctx(), [{ instrumentId: 'binance:BTCUSDT', venueOrderId: '3001' }])
    expect(acks[0]!.ok).toBe(true)
    expect(f.callsFor('DELETE', '/fapi/v1/algoOrder')[0]!.params.get('algoId')).toBe('3001')
  })

  it('cancel by clientOrderId on the algo fallback uses clientAlgoId', async () => {
    const { f, connector } = await setup()
    f.fail('DELETE', '/fapi/v1/order', { code: -2013, msg: 'Order does not exist.' })
    const acks = await connector.cancel(ctx(), [{ instrumentId: 'binance:BTCUSDT', clientOrderId: 'gt-algo-1' }])
    expect(acks[0]!.ok).toBe(true)
    expect(f.callsFor('DELETE', '/fapi/v1/algoOrder')[0]!.params.get('clientAlgoId')).toBe('gt-algo-1')
  })

  it('cancel of an unknown order on both endpoints surfaces -2011 as a classified problem', async () => {
    const { f, connector } = await setup()
    f.fail('DELETE', '/fapi/v1/order', { code: -2011, msg: 'Unknown order sent.' })
    f.fail('DELETE', '/fapi/v1/algoOrder', { code: -2011, msg: 'Unknown order sent.' })
    const acks = await connector.cancel(ctx(), [{ instrumentId: 'binance:BTCUSDT', venueOrderId: 'nope' }])
    expect(acks[0]!.ok).toBe(false)
    expect(acks[0]!.problem?.name).toBe('VENUE_REJECTED')
    expect(acks[0]!.problem?.venue?.message).toContain('-2011')
  })

  it('cancelAll(instrumentId) uses DELETE for normal and algo open orders', async () => {
    const { f, connector } = await setup()
    const acks = await connector.cancelAll(ctx(), 'binance:BTCUSDT')
    expect(acks).toHaveLength(1)
    expect(acks[0]!.ok).toBe(true)
    expect(f.callsFor('DELETE', '/fapi/v1/allOpenOrders')).toHaveLength(1)
    expect(f.callsFor('DELETE', '/fapi/v1/allOpenOrders')[0]!.params.get('symbol')).toBe('BTCUSDT')
    expect(f.callsFor('DELETE', '/fapi/v1/algoOpenOrders')).toHaveLength(1)
    expect(f.callsFor('DELETE', '/fapi/v1/algoOpenOrders')[0]!.params.get('symbol')).toBe('BTCUSDT')
    expect(f.calls.filter((c) => c.method === 'POST' && c.path.endsWith('allOpenOrders'))).toHaveLength(0)
  })

  it('cancelAll() with no instrument reads open orders and cancels symbol by symbol', async () => {
    const { f, connector } = await setup()
    const acks = await connector.cancelAll(ctx())
    expect(f.callsFor('GET', '/fapi/v1/openOrders')).toHaveLength(1)
    const cancels = f.callsFor('DELETE', '/fapi/v1/allOpenOrders')
    expect(cancels.map((c) => c.params.get('symbol')).sort()).toEqual(['BTCUSDT', 'ETHUSDT'])
    expect(acks.map((a) => a.ok)).toEqual([true, true])
  })
})

describe('amend', () => {
  it('amends a LIMIT order through PUT /fapi/v1/order with only the allowed fields', async () => {
    const { f, connector } = await setup()
    const res = await connector.amend(ctx(), {
      instrumentId: 'binance:BTCUSDT',
      venueOrderId: '1001',
      order: intent({ price: '96000', size: '0.020' }),
    })
    expect(res.acks[0]!.status).toBe('open')
    const call = f.callsFor('PUT', '/fapi/v1/order')[0]!
    expect(call.params.get('orderId')).toBe('1001')
    expect(call.params.get('symbol')).toBe('BTCUSDT')
    expect(call.params.get('side')).toBe('BUY')
    expect(call.params.get('price')).toBe('96000')
    expect(call.params.get('quantity')).toBe('0.02')
    expect(call.params.get('timeInForce')).toBeNull()
    expect(call.params.get('positionSide')).toBeNull()
  })

  it('amend ack follows the returned status and filled size (not hard-coded open)', async () => {
    const { f, connector } = await setup()
    f.amendResponse = (p) => ({ orderId: Number(p.get('orderId') ?? 1001), status: 'FILLED', executedQty: '0.02', avgPrice: '96000' })
    const res = await connector.amend(ctx(), { instrumentId: 'binance:BTCUSDT', venueOrderId: '1001', order: intent({ price: '96000', size: '0.020' }) })
    expect(res.acks[0]).toMatchObject({ status: 'filled', filledSize: '0.02', avgFillPrice: '96000' })
    f.amendResponse = (p) => ({ orderId: Number(p.get('orderId') ?? 1001), status: 'CANCELED', executedQty: '0' })
    const canceled = await connector.amend(ctx(), { instrumentId: 'binance:BTCUSDT', venueOrderId: '1001', order: intent() })
    expect(canceled.acks[0]!.status).toBe('rejected')
  })

  it('amends by clientOrderId through origClientOrderId', async () => {
    const { f, connector } = await setup()
    await connector.amend(ctx(), { instrumentId: 'binance:BTCUSDT', clientOrderId: 'gt-amend-1', order: intent() })
    expect(f.callsFor('PUT', '/fapi/v1/order')[0]!.params.get('origClientOrderId')).toBe('gt-amend-1')
  })

  it('any non-LIMIT type is 1004 and never sent', async () => {
    const { f, connector } = await setup()
    for (const type of ['market', 'stop_market', 'trailing_stop', 'take_limit'] as const) {
      const res = await connector.amend(ctx(), { instrumentId: 'binance:BTCUSDT', venueOrderId: '1', order: intent({ type, triggerPrice: '90000' }) })
      expect(res.acks[0]!.problem?.code).toBe(1004)
    }
    expect(f.callsFor('PUT', '/fapi/v1/order')).toHaveLength(0)
  })

  it('amend without any order reference is INVALID_PARAMS', async () => {
    const { connector } = await setup()
    const res = await connector.amend(ctx(), { instrumentId: 'binance:BTCUSDT', order: intent() })
    expect(res.acks[0]!.problem?.name).toBe('INVALID_PARAMS')
  })
})

describe('read paths through the connector', () => {
  it('status returns the raw venue status string (not translated)', async () => {
    const { f, connector } = await setup({ defaultSymbol: 'BTCUSDT' })
    const status = await connector.orderStatus(ctx().account, { venueOrderId: '1001' })
    expect(status.found).toBe(true)
    expect(status.status).toBe('PARTIALLY_FILLED')
    expect(status.filledSize).toBe('0.003')
    expect(f.callsFor('GET', '/fapi/v1/order')[0]!.params.get('symbol')).toBe('BTCUSDT')
  })

  it('openOrders maps LIMIT / STOP_MARKET rows into VenueOpenOrder', async () => {
    const { connector } = await setup()
    const open = await connector.openOrders(ctx().account)
    expect(open).toHaveLength(2)
    expect(open[0]).toMatchObject({
      instrumentId: 'binance:BTCUSDT', venueOrderId: '2001', clientOrderId: 'gt-open-1', side: 'buy', type: 'limit',
      price: '99000', triggerPrice: null, origSize: '0.01', size: '0.006', reduceOnly: false, isTrigger: false,
    })
    expect(open[1]).toMatchObject({ type: 'stop_market', triggerPrice: '2800', reduceOnly: true, isTrigger: true })
  })

  it('scheduleCancel is CAPABILITY_UNSUPPORTED (5002) — countdownCancelAll is not wired in', async () => {
    const { connector } = await setup()
    await expect(connector.scheduleCancel(ctx(), null)).rejects.toThrow(/countdownCancelAll/)
    expect(() => connector.armDeadman(ctx())).toThrow(/countdownCancelAll/)
  })

  it('algo order status is read through GET /fapi/v1/algoOrder', async () => {
    const { f, connector } = await setup()
    const status = await connector.algoOrderStatus(ctx().account, { venueOrderId: '3001' })
    expect(status.found).toBe(true)
    expect(status.status).toBe('TRIGGERED')
    expect(status.venueOrderId).toBe('3001')
    const call = f.callsFor('GET', '/fapi/v1/algoOrder')[0]!
    expect(call.params.get('algoId')).toBe('3001')
    expect(f.callsFor('GET', '/fapi/v1/order')).toHaveLength(0)
  })

  it('trading.status passes algo through', async () => {
    const { f, connector } = await setup()
    const status = await connector.trading.status(ctx().account, { clientOrderId: 'gt-algo-1' }, { algo: true })
    expect(status.status).toBe('TRIGGERED')
    expect(f.callsFor('GET', '/fapi/v1/algoOrder')[0]!.params.get('clientAlgoId')).toBe('gt-algo-1')
  })

  it('describe() advertises both position modes and native cancelAll', async () => {
    const { connector } = await setup()
    const caps = connector.describe()
    expect(caps.positionMode).toEqual(['oneWay', 'hedge'])
    expect(caps.cancelAll).toBe('native')
    expect(caps.venue).toBe('binance')
  })
})

describe('venue parameter problems', () => {
  it('-4164 (notional below venue minimum) becomes MIN_NOTIONAL 1003 with a hint', async () => {
    const { f, connector } = await setup()
    f.fail('POST', '/fapi/v1/order', { code: -4164, msg: "Order's notional must be no smaller than 5 (unless you choose reduce only)." })
    const res = await connector.submit(ctx(), [intent()])
    expect(res.acks[0]!.status).toBe('rejected')
    expect(res.acks[0]!.problem?.code).toBe(1003)
    expect(res.acks[0]!.problem?.name).toBe('MIN_NOTIONAL')
    expect(res.acks[0]!.problem?.message).toContain('hint')
  })
})
