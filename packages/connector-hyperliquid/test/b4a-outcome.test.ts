// SPDX-License-Identifier: CPAL-1.0
// Submit acknowledgements stay unknown when a sent order's venue outcome cannot be matched safely.
import { afterEach, describe, expect, it } from 'vitest'
import type { OrderIntent } from '@gitrader/protocol'
import type { HyperliquidConnector } from '../src/connector'
import { HyperliquidConnector as Connector } from '../src/connector'
import type { TradeContext } from '@gitrader/protocol/connector'
import { FX_NOW, FakeHl } from './helpers/fake-hl'
import { makeTestSigner } from './helpers/test-signer'

const CLIENT_ORDER_ID = '0123456789abcdef0123456789abcdef'
const MAIN = '0x2222222222222222222222222222222222222222' as const
const opened: HyperliquidConnector[] = []

async function setup(response: unknown) {
  const hl = new FakeHl()
  hl.exchange = () => response
  const c = new Connector({
    environment: 'testnet', useWs: false, discoveryIntervalMs: 0,
    clock: () => FX_NOW, fetchImpl: hl.fetch,
  })
  opened.push(c)
  await c.market.refreshInstruments()
  const signer = makeTestSigner()
  const ctx: TradeContext = {
    account: { accountId: 'acct_test', address: MAIN, accountModel: 'standard' },
    signer,
  }
  const intent = (instrumentId: 'hyperliquid:BTC' | 'hyperliquid:ETH' = 'hyperliquid:BTC'): OrderIntent => ({
    accountId: 'acct_test', instrumentId, side: 'buy', type: 'limit', size: '0.001', price: '80000',
    clientOrderId: CLIENT_ORDER_ID,
  } as unknown as OrderIntent)
  return { hl, c, ctx, intent }
}

afterEach(async () => {
  await Promise.all(opened.splice(0).map((c) => c.close()))
})

function expectUnknown(result: Awaited<ReturnType<HyperliquidConnector['submit']>>, index = 0) {
  expect(result.acks[index]).toMatchObject({
    intentIndex: index, clientOrderId: CLIENT_ORDER_ID, status: 'unknown',
    venueOrderId: null, problem: { code: 3006, retryable: false },
  })
}

describe('Hyperliquid submit outcome boundary', () => {
  it.each([
    ['empty success object', {}],
    ['null success body', null],
    ['missing response', { status: 'ok' }],
    ['missing data', { status: 'ok', response: { type: 'order' } }],
    ['missing statuses', { status: 'ok', response: { type: 'order', data: {} } }],
    ['non-array statuses', { status: 'ok', response: { type: 'order', data: { statuses: {} } } }],
    ['unrecognized status item', { status: 'ok', response: { type: 'order', data: { statuses: [{ pending: true }] } } }],
    ['resting without oid', { status: 'ok', response: { type: 'order', data: { statuses: [{ resting: {} }] } } }],
    ['filled without oid', { status: 'ok', response: { type: 'order', data: { statuses: [{ filled: { totalSz: '1', avgPx: '2' } }] } } }],
    ['filled with invalid size', { status: 'ok', response: { type: 'order', data: { statuses: [{ filled: { oid: 9, totalSz: 'bad', avgPx: '2' } }] } } }],
    ['filled with zero average price', { status: 'ok', response: { type: 'order', data: { statuses: [{ filled: { oid: 9, totalSz: '1', avgPx: '0' } }] } } }],
  ])('keeps %s as unknown after one exchange request', async (_label, response) => {
    const { hl, c, ctx, intent } = await setup(response)
    const result = await c.submit(ctx, [intent()])
    expectUnknown(result)
    expect(hl.exchangeCalls()).toHaveLength(1)
  })

  it.each([
    ['short status list', [{ resting: { oid: 9 } }]],
    ['long status list', [{ resting: { oid: 9 } }, { resting: { oid: 10 } }, { resting: { oid: 11 } }]],
  ])('marks every order unknown for a %s', async (_label, statuses) => {
    const { hl, c, ctx, intent } = await setup({ status: 'ok', response: { type: 'order', data: { statuses } } })
    const result = await c.submit(ctx, [intent(), intent('hyperliquid:ETH')])
    expectUnknown(result, 0)
    expectUnknown(result, 1)
    expect(hl.exchangeCalls()).toHaveLength(1)
  })

  it('keeps an unparseable HTTP 2xx body unknown after the order was sent', async () => {
    const { hl, c, ctx, intent } = await setup(new Response('<html>unavailable</html>', { status: 200, headers: { 'content-type': 'text/html' } }))
    const result = await c.submit(ctx, [intent()])
    expectUnknown(result)
    expect(hl.exchangeCalls()).toHaveLength(1)
  })

  it.each([
    ['resting', { resting: { oid: 9 } }, 'open', '9'],
    ['filled', { filled: { oid: '9', totalSz: '0.25', avgPx: '4.5' } }, 'filled', '9'],
  ] as const)('maps valid %s status', async (_label, status, expected, oid) => {
    const { hl, c, ctx, intent } = await setup({ status: 'ok', response: { type: 'order', data: { statuses: [status] } } })
    const result = await c.submit(ctx, [intent()])
    expect(result.acks[0]).toMatchObject({ clientOrderId: CLIENT_ORDER_ID, status: expected, venueOrderId: oid })
    expect(hl.exchangeCalls()).toHaveLength(1)
  })

  it('keeps explicit venue error strings on the existing rejection mapping', async () => {
    const { hl, c, ctx, intent } = await setup({ status: 'err', response: 'insufficient margin' })
    const result = await c.submit(ctx, [intent()])
    expect(result.acks[0]).toMatchObject({ clientOrderId: CLIENT_ORDER_ID, status: 'rejected', problem: { code: 3004 } })
    expect(hl.exchangeCalls()).toHaveLength(1)
  })

  it('maps a valid status carried by an ApiRequestError response', async () => {
    const { hl, c, ctx, intent } = await setup({ status: 'err', response: { type: 'order', data: { statuses: [{ resting: { oid: 17 } }] } } })
    const result = await c.submit(ctx, [intent()])
    expect(result.acks[0]).toMatchObject({ clientOrderId: CLIENT_ORDER_ID, status: 'open', venueOrderId: '17' })
    expect(hl.exchangeCalls()).toHaveLength(1)
  })

  it('preserves exchange transport mapping for HTTP 500 and network failure', async () => {
    const http = await setup(new Response('temporarily unavailable', { status: 500 }))
    const httpResult = await http.c.submit(http.ctx, [http.intent()])
    expectUnknown(httpResult)
    expect(http.hl.exchangeCalls()).toHaveLength(1)

    const network = await setup({ status: 'ok', response: { type: 'order', data: { statuses: [{ resting: { oid: 1 } }] } } })
    network.hl.exchangeNetworkFail = true
    const networkResult = await network.c.submit(network.ctx, [network.intent()])
    expectUnknown(networkResult)
    expect(network.hl.exchangeCalls()).toHaveLength(1)
  })
})
