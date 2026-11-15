// SPDX-License-Identifier: CPAL-1.0
import { describe, expect, it } from 'vitest'
import type { OrderIntent } from '@gitrader/protocol'
import { ACCOUNT_ID, makeConnector, tradeContext } from './helpers/connector'
import { FakeBitget, NOW } from './helpers/fake-bitget'

function intent(over: Record<string, unknown> = {}): OrderIntent {
  return {
    accountId: ACCOUNT_ID,
    instrumentId: 'bitget:BTCUSDT',
    side: 'buy',
    type: 'limit',
    size: '0.1',
    price: '60000',
    clientOrderId: 'gt-b4a-known',
    ...over,
  } as unknown as OrderIntent
}

function setup() {
  const fake = new FakeBitget()
  const made = makeConnector(fake)
  made.connector.market.seedContracts(fake.contracts, NOW)
  made.connector.market.seedQuote('bitget:BTCUSDT', 100.1, 100.2, NOW)
  made.accounts.seedPosMode('BTCUSDT', 'one_way_mode')
  return { fake, connector: made.connector }
}

describe('B4a Bitget place outcome', () => {
  it('treats missing or malformed orderId as unknown for ordinary and plan submits', async () => {
    const invalidResponses: unknown[] = [
      { clientOid: 'gt-b4a-known' },
      { orderId: null, clientOid: 'gt-b4a-known' },
      { orderId: '', clientOid: 'gt-b4a-known' },
      { orderId: '   ', clientOid: 'gt-b4a-known' },
      { orderId: {}, clientOid: 'gt-b4a-known' },
      { orderId: [], clientOid: 'gt-b4a-known' },
      { orderId: false, clientOid: 'gt-b4a-known' },
      { orderId: 0, clientOid: 'gt-b4a-known' },
      { orderId: -1, clientOid: 'gt-b4a-known' },
    ]

    for (const response of invalidResponses) {
      for (const plan of [false, true]) {
        const { fake, connector } = setup()
        const hook = () => response
        if (plan) fake.planResponse = hook
        else fake.orderResponse = hook
        const order = plan
          ? intent({ type: 'stop_market', price: undefined, triggerPrice: '59000' })
          : intent()
        const result = await connector.submit(tradeContext(), [order])
        const path = plan ? '/api/v2/mix/order/place-plan-order' : '/api/v2/mix/order/place-order'
        expect(fake.callsFor('POST', path)).toHaveLength(1)
        expect(result.acks[0]).toMatchObject({
          status: 'unknown',
          clientOrderId: 'gtb4aknown',
          venueOrderId: null,
          problem: { code: 3006, retryable: false },
        })
      }
    }
  })

  it('keeps a valid string or positive finite numeric orderId accepted', async () => {
    for (const id of ['venue-1', 12]) {
      const { fake, connector } = setup()
      fake.orderResponse = () => ({ orderId: id })
      const result = await connector.submit(tradeContext(), [intent()])
      expect(result.acks[0]).toMatchObject({ status: 'open', venueOrderId: String(id) })
      expect(fake.callsFor('POST', '/api/v2/mix/order/place-order')).toHaveLength(1)
    }
  })
})
