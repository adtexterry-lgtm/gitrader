// SPDX-License-Identifier: CPAL-1.0
import { describe, expect, it } from 'vitest'
import { HyperliquidConnector } from '../src/connector'
import { createWeightBudget, extraInfoWeight } from '../src/budget'
import { HlHttp } from '../src/rest'
import { buildInstrumentRecords } from '../src/parse'
import { buildOrder } from '../src/orders'
import { FakeHl, FX_NOW, loadFixture } from './helpers/fake-hl'
import { makeTestSigner } from './helpers/test-signer'

const meta = buildInstrumentRecords(loadFixture('metaAndAssetCtxs.json'), '', 0, FX_NOW)
const BTC = meta.find((record) => record.coin === 'BTC')!
const order = (over: Record<string, unknown> = {}) => ({
  accountId: 'acct_01TEST',
  instrumentId: 'hyperliquid:BTC',
  side: 'buy',
  type: 'limit',
  size: '0.001',
  price: '80000',
  ...over,
}) as never

describe('B1 H1 trigger execution prices', () => {
  it('derives the buy trigger execution price above the trigger', () => {
    const buy = buildOrder(order({ type: 'stop_market', price: undefined, triggerPrice: '80000', triggerType: 'mark', maxSlippageBps: 100 }), BTC)

    expect(buy.orders[0]).toMatchObject({ p: '80800', t: { trigger: { triggerPx: '80000', isMarket: true } } })
  })

  it('derives the sell trigger execution price below the trigger', () => {
    const sell = buildOrder(order({ side: 'sell', type: 'take_market', price: undefined, triggerPrice: '80000', triggerType: 'mark', maxSlippageBps: 100 }), BTC)

    expect(sell.orders[0]).toMatchObject({ p: '79200', t: { trigger: { triggerPx: '80000', isMarket: true } } })
  })

  it('derives market TP and SL child execution prices from each child direction', () => {
    const built = buildOrder(order({
      maxSlippageBps: 100,
      tpsl: {
        takeProfit: { triggerPrice: '82000' },
        stopLoss: { triggerPrice: '78000' },
        grouping: 'order',
      },
    }), BTC)

    expect(built.orders[1]).toMatchObject({ p: '81180', b: false, t: { trigger: { triggerPx: '82000', isMarket: true } } })
    expect(built.orders[2]).toMatchObject({ p: '77220', b: false, t: { trigger: { triggerPx: '78000', isMarket: true } } })
  })

  it('preserves explicit trigger prices and zero-slippage legacy calls', () => {
    const explicit = buildOrder(order({ type: 'stop_market', triggerPrice: '80000', triggerType: 'mark', price: '80500', maxSlippageBps: 100 }), BTC)
    const legacy = buildOrder(order({ type: 'stop_market', price: undefined, triggerPrice: '80000', triggerType: 'mark' }), BTC)

    expect(explicit.orders[0]!.p).toBe('80500')
    expect(legacy.orders[0]!.p).toBe('80000')
  })
})

async function setupAmend(exchange: (body: any) => unknown) {
  const hl = new FakeHl()
  hl.exchange = exchange
  const signer = makeTestSigner()
  const connector = new HyperliquidConnector({
    environment: 'testnet',
    useWs: false,
    discoveryIntervalMs: 0,
    clock: () => FX_NOW,
    fetchImpl: hl.fetch,
  })
  await connector.market.refreshInstruments()
  const ctx = () => ({
    account: { accountId: 'acct_01TEST', address: signer.address, accountModel: 'standard' },
    signer,
    onSigned: () => {},
  })
  return { hl, connector, ctx }
}

const amendRequest = (extra: Record<string, unknown> = {}) => ({
  instrumentId: 'hyperliquid:BTC',
  venueOrderId: '321',
  order: order({ price: '79500', clientOrderId: '0123456789abcdef0123456789abcdef' }),
  ...extra,
})

describe('B1 H1 amend statuses', () => {
  it('maps the SDK default response to unknown without inventing a venue order id', async () => {
    const { hl, connector, ctx } = await setupAmend(() => ({ status: 'ok', response: { type: 'default' } }))
    const result = await connector.amend(ctx() as never, amendRequest() as never)

    expect(result.acks[0]).toMatchObject({ status: 'unknown', venueOrderId: null, problem: { code: 3006, name: 'VENUE_OUTCOME_UNKNOWN', retryable: false } })
    expect(hl.exchangeCalls()).toHaveLength(1)
  })

  it('rejects an object error status and does not retry the request', async () => {
    const { hl, connector, ctx } = await setupAmend(() => ({ status: 'ok', response: { type: 'modify', data: { statuses: [{ error: 'insufficient margin' }] } } }))
    const result = await connector.amend(ctx() as never, amendRequest() as never)

    expect(result.acks[0]).toMatchObject({ status: 'rejected', problem: { code: 3004, venue: { message: 'insufficient margin' } } })
    expect(hl.exchangeCalls()).toHaveLength(1)
  })

  it('rejects a missing status and returns null when no venue order id was requested', async () => {
    const { hl, connector, ctx } = await setupAmend(() => ({ status: 'ok', response: { type: 'modify', data: { statuses: [] } } }))
    const result = await connector.amend(ctx() as never, amendRequest({ venueOrderId: undefined, clientOrderId: '0123456789abcdef0123456789abcdef' }) as never)

    expect(result.acks[0]).toMatchObject({ status: 'unknown', venueOrderId: null, problem: { code: 3006, name: 'VENUE_OUTCOME_UNKNOWN', retryable: false } })
    expect(hl.exchangeCalls()).toHaveLength(1)
  })

  it('maps an unrecognized amend status to unknown without retrying', async () => {
    const { hl, connector, ctx } = await setupAmend(() => ({ status: 'ok', response: { type: 'modify', data: { statuses: ['waiting'] } } }))
    const result = await connector.amend(ctx() as never, amendRequest() as never)

    expect(result.acks[0]).toMatchObject({ status: 'unknown', venueOrderId: null, problem: { code: 3006, name: 'VENUE_OUTCOME_UNKNOWN', retryable: false } })
    expect(hl.exchangeCalls()).toHaveLength(1)
  })

  it('parses an error status inside an API request error response', async () => {
    const { hl, connector, ctx } = await setupAmend(() => ({ status: 'err', response: { type: 'modify', data: { statuses: [{ error: 'insufficient margin' }] } } }))
    const result = await connector.amend(ctx() as never, amendRequest() as never)

    expect(result.acks[0]).toMatchObject({ status: 'rejected', problem: { code: 3004, venue: { message: 'insufficient margin' } } })
    expect(hl.exchangeCalls()).toHaveLength(1)
  })
})

describe('B1 H1 info response weights', () => {
  it.each(['nonUserFundingUpdates', 'userTwapSliceFillsByTime', 'delegatorRewards', 'validatorStats'])(
    'adds returned row weights for %s',
    (type) => expect(extraInfoWeight(type, 40)).toBe(2),
  )

  it('measures the largest nested array instead of summing nested arrays', async () => {
    const hl = new FakeHl()
    hl.info.set('userTwapSliceFillsByTime', () => ({
      result: { rows: Array.from({ length: 45 }, () => ({})) },
      extra: { rows: Array.from({ length: 20 }, () => ({})) },
    }))
    const budget = createWeightBudget()
    const http = new HlHttp({ environment: 'testnet', budget, fetchImpl: hl.fetch })

    await http.info({ type: 'userTwapSliceFillsByTime' })

    expect(http.weightSpent).toBe(22)
    expect(budget.usage().byKind.query).toBe(22)
  })

  it('keeps candle snapshot charging at one unit per 60 rows', () => {
    expect(extraInfoWeight('candleSnapshot', 120)).toBe(2)
  })

  it('records weights from a valid 150000-row info response', async () => {
    const hl = new FakeHl()
    const rows = Array.from({ length: 150_000 }, () => null)
    hl.info.set('userTwapSliceFillsByTime', () => ({ result: { rows } }))
    const http = new HlHttp({ environment: 'testnet', budget: createWeightBudget(), fetchImpl: hl.fetch })

    const result = await http.info<{ result: { rows: null[] } }>({ type: 'userTwapSliceFillsByTime' })

    expect(result.result.rows).toHaveLength(150_000)
    expect(http.weightSpent).toBe(7_520)
    expect(hl.infoCalls('userTwapSliceFillsByTime')).toHaveLength(1)
  })

  it('counts the largest array through 200 nested object layers', async () => {
    const hl = new FakeHl()
    let nested: Record<string, unknown> = { rows: Array.from({ length: 45 }, () => null) }
    for (let i = 0; i < 200; i++) nested = { rows: Array.from({ length: 20 }, () => null), child: nested }
    const body = { result: { nested } }
    hl.info.set('userTwapSliceFillsByTime', () => body)
    const http = new HlHttp({ environment: 'testnet', budget: createWeightBudget(), fetchImpl: hl.fetch })

    const result = await http.info<typeof body>({ type: 'userTwapSliceFillsByTime' })

    expect(result).toEqual(body)
    expect(http.weightSpent).toBe(22)
    expect(hl.infoCalls('userTwapSliceFillsByTime')).toHaveLength(1)
  })
})
