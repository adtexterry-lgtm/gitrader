// SPDX-License-Identifier: CPAL-1.0
// 批 10 · L2 修复回归（反证用）：L2-02 —— 建单请求已发出、场所回 200，但回执里读不到 orderId。
// 修前：ack.status = 'open' + venueOrderId = null + 无 problem（内核会以为单已进场）。
// 修后：3006 VENUE_OUTCOME_UNKNOWN + status 'unknown'（按 clientOrderId / orderLinkId 对账，不重发）。
// 对照：正常回执（有 orderId）仍是 open —— 行为只在「读不到号」这一支变化。
import { describe, expect, it } from 'vitest'
import type { OrderIntent } from '@gitrader/protocol'
import { BybitAccounts } from '../src/account'
import { BybitTrading } from '../src/trading'
import { API_KEY, API_SECRET, FakeBybitTrade, NOW } from './helpers/fake-bybit-trade'
import { ctx, freshQuote, instrumentOf, newHttp } from './helpers/harness'

function harness(fake: FakeBybitTrade) {
  const http = newHttp(fake)
  const accounts = new BybitAccounts(
    { http, clock: () => NOW, instrumentOf: (id) => instrumentOf(id) },
    [API_SECRET, API_KEY],
  )
  const trading = new BybitTrading({
    http,
    instrumentOf: (id) => instrumentOf(id),
    quoteOf: () => freshQuote(),
    openOrders: (ref, id) => accounts.openOrders(ref, id),
    orderStatus: (ref, key, opts) => accounts.orderStatus(ref, key, opts ?? {}),
    clock: () => NOW,
    defaultSymbol: 'BTCUSDT',
  }, [API_SECRET, API_KEY])
  return { http, accounts, trading }
}

const intent = (over: Record<string, unknown> = {}): OrderIntent => ({
  accountId: 'acc_bybit_1',
  instrumentId: 'bybit:BTCUSDT',
  side: 'buy',
  type: 'limit',
  size: '0.1',
  price: '100',
  ...over,
} as unknown as OrderIntent)

describe('L2-02 建单回执没有订单号 → 3006 结果未知（不许报 open）', () => {
  it('200 {retCode:0,result:{}}：请求已发出，ack 是 unknown + 3006，不是 open', async () => {
    const fake = new FakeBybitTrade()
    // 假服务器回 {retCode:0,result:{}}：合法 JSON、retCode 为 0、没有 orderId
    fake.createResponse = () => ({})
    const { trading } = harness(fake)
    const result = await trading.submit(ctx(), [intent({ clientOrderId: 'gt-l2-02-empty' })])

    // 反证的关键：请求真的发出去了（不是「没下单」）
    expect(fake.callsFor('POST', '/v5/order/create')).toHaveLength(1)
    const ack = result.acks[0]!
    expect(ack.status).toBe('unknown')
    expect(ack.venueOrderId).toBeNull()
    expect(ack.problem?.name).toBe('VENUE_OUTCOME_UNKNOWN')
    expect(ack.problem?.code).toBe(3006)
    expect(ack.problem?.message).toMatch(/no orderId/i)
  })

  it('200 只有 orderLinkId：仍是 unknown（clientOrderId 用 orderLinkId 对账）', async () => {
    const fake = new FakeBybitTrade()
    fake.createResponse = (body) => ({ orderLinkId: body.orderLinkId })
    const { trading } = harness(fake)
    const result = await trading.submit(ctx(), [intent({ clientOrderId: 'gt-l2-02-link' })])

    const ack = result.acks[0]!
    expect(ack.status).toBe('unknown')
    expect(ack.problem?.code).toBe(3006)
    // 仍然带着可对账的 id（场所回的 orderLinkId）
    expect(ack.clientOrderId).toBe('gt-l2-02-link')
    expect(ack.venueOrderId).toBeNull()
  })

  it('200 空 body（rest 返回 undefined）：同样落 3006，不许当 open', async () => {
    const fake = new FakeBybitTrade()
    // 空字符串 body → rest.signed 返回 undefined（不变式：HTTP 200 但没有任何回执）
    fake.httpStatusOverride.set('/v5/order/create', { status: 200, body: '' })
    const { trading } = harness(fake)
    const result = await trading.submit(ctx(), [intent({ clientOrderId: 'gt-l2-02-blank' })])

    const ack = result.acks[0]!
    expect(ack.status).toBe('unknown')
    expect(ack.problem?.code).toBe(3006)
    expect(ack.venueOrderId).toBeNull()
  })

  it('对照：正常回执（有 orderId）→ open + venueOrderId（行为只在缺号那一支变化）', async () => {
    const fake = new FakeBybitTrade()
    const { trading } = harness(fake)
    const result = await trading.submit(ctx(), [intent({ clientOrderId: 'gt-l2-02-ok' })])

    const ack = result.acks[0]!
    expect(ack.status).toBe('open')
    expect(ack.venueOrderId).toMatch(/^ord-/)
    expect(ack.problem).toBeUndefined()
  })

  it('对照：触发单有 orderId 仍是 untriggered', async () => {
    const fake = new FakeBybitTrade()
    const { trading } = harness(fake)
    const result = await trading.submit(ctx(), [intent({
      type: 'stop_market', side: 'sell', triggerPrice: '99', price: undefined, reduceOnly: true, clientOrderId: 'gt-l2-02-trig',
    })])
    expect(result.acks[0]!.status).toBe('untriggered')
    expect(result.acks[0]!.venueOrderId).toMatch(/^ord-/)
  })
})

describe('L2-02b 3006 分支的场所原文先脱敏（ack JSON 里不许出现 API key / secret）', () => {
  it('200 无 orderId 且 body 回显 API_KEY / API_SECRET：3006，两者都不在 ack JSON 里', async () => {
    const fake = new FakeBybitTrade()
    fake.createResponse = () => ({ echo: API_KEY, sig: API_SECRET })
    const { trading } = harness(fake)
    const result = await trading.submit(ctx(), [intent({ clientOrderId: 'gt-l2-02b-echo' })])

    const ack = result.acks[0]!
    expect(ack.problem?.code).toBe(3006)
    const json = JSON.stringify(ack)
    expect(json).not.toContain(API_KEY)
    expect(json).not.toContain(API_SECRET)
  })
})
