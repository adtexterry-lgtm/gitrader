// SPDX-License-Identifier: CPAL-1.0
import { describe, expect, it } from 'vitest'
import type { OrderIntent } from '@gitrader/protocol'
import type { TradeContext } from '@gitrader/protocol/connector'
import { createWeightBudget } from '../src/budget'
import { BinanceTradeConnector } from '../src/connector'
import { API_KEY, API_SECRET, BASE_URL, FakeBinanceTrade, NOW } from './helpers/fake-binance-trade'

const ctx = (): TradeContext => ({
  account: { accountId: 'acct_b4a', address: 'addr_b4a' },
  signer: { address: 'addr_b4a', signTypedData: async () => 'sig_test' },
}) as unknown as TradeContext

const intent = (overrides: Partial<OrderIntent> = {}): OrderIntent => ({
  accountId: 'acct_b4a', instrumentId: 'binance:BTCUSDT', side: 'buy', type: 'limit', size: '0.010', price: '95000', clientOrderId: 'gt-b4a-known',
  ...overrides,
}) as unknown as OrderIntent

async function start(fake: FakeBinanceTrade) {
  const connector = new BinanceTradeConnector({
    baseUrl: BASE_URL,
    apiKey: API_KEY,
    apiSecret: API_SECRET,
    fetchImpl: fake.fetch,
    clock: () => NOW,
    budget: createWeightBudget({ clock: () => NOW }),
    onWarn: () => {},
  })
  await connector.start()
  fake.reset()
  return connector
}

const unknownResponses = [
  { label: 'empty response', make: () => ({}) },
  { label: 'missing status', make: (params: URLSearchParams) => ({ orderId: 1001, clientOrderId: params.get('newClientOrderId') }) },
  { label: 'null status', make: (params: URLSearchParams) => ({ orderId: 1001, clientOrderId: params.get('newClientOrderId'), status: null }) },
  { label: 'empty status', make: (params: URLSearchParams) => ({ orderId: 1001, clientOrderId: params.get('newClientOrderId'), status: '' }) },
  { label: 'unrecognized status', make: (params: URLSearchParams) => ({ orderId: 1001, clientOrderId: params.get('newClientOrderId'), status: 'UNRECOGNIZED' }) },
] as const

describe('B4a Binance submit outcome mapping', () => {
  for (const route of [
    {
      name: 'ordinary order', path: '/fapi/v1/order', otherPath: '/fapi/v1/algoOrder', clientParam: 'newClientOrderId',
      response: (fake: FakeBinanceTrade, make: (params: URLSearchParams) => unknown) => { fake.orderResponse = make },
      order: intent(),
    },
    {
      name: 'algo order', path: '/fapi/v1/algoOrder', otherPath: '/fapi/v1/order', clientParam: 'clientAlgoId',
      response: (fake: FakeBinanceTrade, make: (params: URLSearchParams) => unknown) => {
        fake.algoOrderResponse = (params) => {
          const row = make(params) as Record<string, unknown>
          if ('status' in row) return { algoId: 3001, clientAlgoId: params.get('clientAlgoId'), ...row, algoStatus: row.status }
          return { algoId: 3001, clientAlgoId: params.get('clientAlgoId'), ...row }
        }
      },
      order: intent({ type: 'stop_market', price: undefined, triggerPrice: '90000' } as unknown as Partial<OrderIntent>),
    },
  ]) {
    for (const response of unknownResponses) {
      it(`${route.name} maps ${response.label} to an unknown, non-retryable outcome`, async () => {
        const fake = new FakeBinanceTrade()
        const connector = await start(fake)
        route.response(fake, response.make)

        const result = await connector.submit(ctx(), [route.order])
        expect(fake.callsFor('POST', route.path)).toHaveLength(1)
        expect(fake.callsFor('POST', route.otherPath)).toHaveLength(0)
        expect(fake.callsFor('POST', route.path)[0]!.params.get(route.clientParam)).toBe('gt-b4a-known')
        expect(result.acks[0]).toMatchObject({
          status: 'unknown',
          clientOrderId: 'gt-b4a-known',
          problem: { code: 3006, retryable: false },
        })
        expect(result.acks[0]!.problem?.message).toContain('clientOrderId')
        expect(result.acks[0]!.problem?.message).toContain('check')
      })
    }
  }

  it('keeps a recognized NEW response open', async () => {
    const fake = new FakeBinanceTrade()
    const connector = await start(fake)
    fake.orderResponse = (params) => ({ orderId: 1001, clientOrderId: params.get('newClientOrderId'), status: 'NEW', executedQty: '0', avgPrice: '0' })

    const result = await connector.submit(ctx(), [intent()])
    expect(result.acks[0]).toMatchObject({ status: 'open', clientOrderId: 'gt-b4a-known' })
    expect(result.acks[0]!.problem).toBeUndefined()
    expect(fake.callsFor('POST', '/fapi/v1/order')).toHaveLength(1)
  })

  it('keeps an explicit venue rejection rejected with its existing code', async () => {
    const fake = new FakeBinanceTrade()
    const connector = await start(fake)
    fake.fail('POST', '/fapi/v1/order', { code: -2019, msg: 'Margin is insufficient.' })

    const result = await connector.submit(ctx(), [intent()])
    expect(result.acks[0]).toMatchObject({ status: 'rejected', problem: { code: 3004 } })
    expect(fake.callsFor('POST', '/fapi/v1/order')).toHaveLength(1)
  })
})
