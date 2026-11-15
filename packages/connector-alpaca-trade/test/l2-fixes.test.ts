// SPDX-License-Identifier: CPAL-1.0
// 批 10 · L2 修复回归（反证用）：L2-07 —— 下单请求已发出、场所回 200，但回执缺 id。
// 修前：parseOrder 抛 TypeError → asProblem 归 INTERNAL(4001) → ack rejected（内核会重发 → 重复开仓）。
// 修后：3006 VENUE_OUTCOME_UNKNOWN + ack unknown（按 client_order_id 对账）。
// 对照：正常回执仍是 open；场所明确 4xx 仍是 rejected（行为只在「2xx 但读不懂」这一支变化）。
import { describe, expect, it } from 'vitest'
import type { OrderIntent } from '@gitrader/protocol'
import { FakeAlpaca } from './helpers/fake-alpaca'
import { makeConnector, tradeContext } from './helpers/connector'

const CID = 'b'.repeat(32)

const intent = (over: Record<string, unknown> = {}): OrderIntent => ({
  accountId: 'acct_alpaca_test',
  instrumentId: 'alpaca:AAPL',
  side: 'buy',
  type: 'limit',
  price: '190.00',
  size: '1',
  ...over,
} as unknown as OrderIntent)

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

async function setup() {
  const fake = new FakeAlpaca()
  const t = makeConnector(fake)
  await t.connector.start()
  return { fake, ...t }
}

describe('L2-07 下单 200 但缺 id → 3006（不是 INTERNAL 4001 / rejected）', () => {
  it('200 回执缺 id：ack unknown + 3006，请求只发一次（不重发）', async () => {
    const { fake, trading } = await setup()
    // 200 + 有 symbol/side 但没有 id：parseOrder 会抛 TypeError（这是有意设计：坏行不当成「没这张单」）
    fake.failWith.set('POST /v2/orders', () => jsonResponse({ symbol: 'AAPL', side: 'buy', status: 'accepted' }))
    const result = await trading.submit(tradeContext(), [intent({ clientOrderId: CID })])

    const ack = result.acks[0]!
    expect(fake.callsFor('POST', '/v2/orders')).toHaveLength(1)
    expect(ack.status).toBe('unknown')
    expect(ack.problem?.name).toBe('VENUE_OUTCOME_UNKNOWN')
    expect(ack.problem?.code).toBe(3006)
    // 反证：修前这里是 INTERNAL 4001 + rejected
    expect(ack.problem?.code).not.toBe(4001)
    expect(ack.venueOrderId).toBeNull()
  })

  it('200 空对象 {}：同样 3006（不许把「读不懂」当拒单）', async () => {
    const { fake, trading } = await setup()
    fake.failWith.set('POST /v2/orders', () => jsonResponse({}))
    const result = await trading.submit(tradeContext(), [intent({ clientOrderId: CID })])

    const ack = result.acks[0]!
    expect(ack.status).toBe('unknown')
    expect(ack.problem?.code).toBe(3006)
  })

  it('对照：正常回执（有 id）仍是 open + venueOrderId', async () => {
    const { trading } = await setup()
    const result = await trading.submit(tradeContext(), [intent({ clientOrderId: CID })])
    expect(result.acks[0]!.status).toBe('open')
    expect(result.acks[0]!.venueOrderId).toBeTruthy()
  })

  it('对照：场所明确 4xx（拒绝）仍是 rejected，不被升成 3006', async () => {
    const { fake, trading } = await setup()
    fake.failWith.set('POST /v2/orders', () => jsonResponse({ code: 40310000, message: 'insufficient buying power' }, 403))
    const result = await trading.submit(tradeContext(), [intent({ clientOrderId: CID })])

    const ack = result.acks[0]!
    expect(ack.status).toBe('rejected')
    expect(ack.problem?.code).not.toBe(3006)
  })
})
