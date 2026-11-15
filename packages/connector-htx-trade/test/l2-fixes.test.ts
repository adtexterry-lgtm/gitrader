// SPDX-License-Identifier: CPAL-1.0
// 批 10 · L2 修复回归（反证用）：
//   · L2-06 —— 下单请求已发出、HTTP 200，但信封不合法（`{}`）/ 信封合法却没有 order_id。
//     修前：`{}` → 3001 VENUE_REJECTED + ack rejected（内核会重发）；缺 id → ack open 无单号。
//     修后：两支都是 3006 VENUE_OUTCOME_UNKNOWN + ack unknown（按 clientOrderId 对账）。
//   · L2-10 —— 公开行情路径的裸 Error / SyntaxError / 丢 429→3002 映射。
//     修后：公开读只抛 ProblemError（429→3002、5xx→3003、200 非 JSON→3003）。
import { describe, expect, it } from 'vitest'
import { asDecimal } from '@gitrader/protocol'
import type { InstrumentId, OrderIntent } from '@gitrader/protocol'
import { HtxAccounts } from '../src/account'
import { HtxTradeMarket } from '../src/market'
import { HtxTrading } from '../src/trading'
import { FakeHtx, NOW } from './helpers/fake-htx'
import { contractSizeOf, ctx, freshQuote, instrumentOf, newHttp } from './helpers/harness'

function setup() {
  const fake = new FakeHtx()
  const http = newHttp(fake)
  const sizeOf = contractSizeOf
  const accounts = new HtxAccounts({
    http,
    clock: () => NOW,
    options: { family: 'v5', defaultSymbol: 'BTC-USDT' },
    contractSizeOf: sizeOf,
  }, ['secret', 'key'])
  const trading = new HtxTrading({
    http,
    instrumentOf: (id) => instrumentOf(id),
    quoteOf: () => freshQuote(),
    openOrders: (ref, symbol) => accounts.openOrders(ref, symbol),
    orderStatus: (ref, key, opts) => accounts.orderStatus(ref, key, opts ?? {}),
    faceValueOf: (id) => sizeOf(id.replace(/^htx:/i, '')),
    clock: () => NOW,
    family: 'v5',
    hedge: false,
    marginMode: 'cross',
    defaultSymbol: 'BTC-USDT',
    accounts,
  }, ['secret', 'key'])
  return { fake, http, accounts, trading }
}

const intent = (over: Partial<OrderIntent> = {}): OrderIntent => ({
  accountId: 'acct_htx_1',
  instrumentId: 'htx:BTC-USDT',
  side: 'buy',
  type: 'limit',
  size: asDecimal('0.001'),
  price: asDecimal('100'),
  ...over,
} as OrderIntent)

describe('L2-06 下单 200 但信封不合法 / 缺 order_id → 3006（不是 3001 rejected，也不是 open）', () => {
  it('200 {}（合法 JSON、认不出信封）：3006 + ack unknown，请求确实发过一次', async () => {
    const { fake, trading } = setup()
    // 下一次请求（signature 通过后的建单）回 HTTP 200 + `{}`
    fake.nextFailure = { body: {} }
    const result = await trading.submit(ctx(), [intent({ clientOrderId: 'gt-l2-06-empty' })])

    const ack = result.acks[0]!
    expect(ack.status).toBe('unknown')
    expect(ack.problem?.code).toBe(3006)
    expect(ack.problem?.name).toBe('VENUE_OUTCOME_UNKNOWN')
    // 反证：不是 3001 拒单（修前就是这条）
    expect(ack.problem?.code).not.toBe(3001)
  })

  it('200 信封合法但没有 order_id：3006 + ack unknown + venueOrderId null', async () => {
    const { fake, trading } = setup()
    fake.nextFailure = { body: { status: 'ok', data: {}, ts: NOW } }
    const result = await trading.submit(ctx(), [intent({ clientOrderId: 'gt-l2-06-noid' })])

    const ack = result.acks[0]!
    expect(ack.status).toBe('unknown')
    expect(ack.problem?.code).toBe(3006)
    expect(ack.venueOrderId).toBeNull()
  })

  it('对照：明确的 error 信封（err_code 1061）仍是 3001 拒单，不被升成 3006', async () => {
    const { fake, trading } = setup()
    fake.nextFailure = { body: { status: 'error', err_code: 1061, err_msg: "This order doesn't exist.", ts: NOW } }
    const result = await trading.submit(ctx(), [intent({ clientOrderId: 'gt-l2-06-err' })])

    const ack = result.acks[0]!
    expect(ack.status).toBe('rejected')
    expect(ack.problem?.code).toBe(3001)
  })

  it('对照：正常建单（有 order_id）仍是 open + 场所订单号', async () => {
    const { trading } = setup()
    const result = await trading.submit(ctx(), [intent({ clientOrderId: 'gt-l2-06-ok' })])
    expect(result.acks[0]!.status).toBe('open')
    expect(result.acks[0]!.venueOrderId).toBeTruthy()
  })
})

describe('L2-10 公开行情路径：裸 Error / SyntaxError 归一成 Problem，429→3002 映射恢复', () => {
  const fetchWith = (respond: (url: string) => Response): typeof fetch => async (input) => respond(String(input))

  const marketWith = (respond: (url: string) => Response): HtxTradeMarket =>
    new HtxTradeMarket({ baseUrl: 'https://htx.test.local', fetchImpl: fetchWith(respond), clock: () => NOW, httpTimeoutMs: 2_000 })

  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

  const depthFailure = async (respond: (url: string) => Response): Promise<{ code: number; name: string }> => {
    try {
      await marketWith(respond).book('htx:BTC-USDT' as InstrumentId)
      throw new Error('book() should have thrown')
    } catch (e) {
      const problem = (e as { problem?: { code: number; name: string } }).problem
      if (problem === undefined) throw new Error(`naked error escaped the public read path: ${(e as Error).name}: ${(e as Error).message}`)
      return problem
    }
  }

  it('HTTP 429 → 3002 VENUE_RATE_LIMITED（修前是裸 Error: … HTTP 429）', async () => {
    const problem = await depthFailure(() => new Response('rate limited', { status: 429, headers: { 'retry-after': '2' } }))
    expect(problem.name).toBe('VENUE_RATE_LIMITED')
    expect(problem.code).toBe(3002)
  })

  it('HTTP 500 → 3003 VENUE_UNAVAILABLE（不是裸 Error）', async () => {
    const problem = await depthFailure(() => new Response('boom', { status: 500 }))
    expect(problem.name).toBe('VENUE_UNAVAILABLE')
    expect(problem.code).toBe(3003)
  })

  it('200 但回 HTML → 3003（不是 SyntaxError 逃逸）', async () => {
    const problem = await depthFailure(() => new Response('<html>gateway</html>', { status: 200, headers: { 'content-type': 'text/html' } }))
    expect(problem.name).toBe('VENUE_UNAVAILABLE')
    expect(problem.code).toBe(3003)
  })

  it('断连 → 3003（不是裸 TypeError）', async () => {
    const problem = await depthFailure(() => { throw new TypeError('fetch failed') })
    expect(problem.code).toBe(3003)
  })

  it('200 信封 error 按码分类（1013 合约不存在 → INSTRUMENT_UNKNOWN），不被升成 3006', async () => {
    // 明确失败（status=error + err_code）走原分类路径：本修复只改「信封读不懂」那一支。
    const problem = await depthFailure(() => json({ status: 'error', err_code: 1013, err_msg: 'contract not exist' }))
    expect(problem.name).toBe('INSTRUMENT_UNKNOWN')
    expect(problem.code).not.toBe(3006)
  })

  it('对照：正常 depth 回包仍能解析出盘口（公开读没被拦死）', async () => {
    const market = marketWith((url) => url.includes('swap_contract_info')
      ? json({ status: 'ok', data: [{ contract_code: 'BTC-USDT', contract_size: 0.001, price_tick: 0.1, contract_status: 1, max_leverage: 125 }], ts: NOW })
      : json({
        status: 'ok',
        tick: { id: NOW, ts: NOW, bids: [[100, 3]], asks: [[100.1, 4]], version: 1, ch: 'depth' },
        ts: NOW,
      }))
    await market.start()
    const book = await market.book('htx:BTC-USDT' as InstrumentId)
    expect(book.bids.length).toBeGreaterThan(0)
    expect(book.asks.length).toBeGreaterThan(0)
  })
})

/** 与 setup() 相同，只有 secrets 换成两段专用金丝雀串（用来验 3006 分支的场所原文是否脱敏）。 */
const CANARY_SECRET = 'CANARY-HTX-SECRET-7f3a'
const CANARY_KEY = 'CANARY-HTX-KEY-91c2'

function canarySetup() {
  const fake = new FakeHtx()
  const http = newHttp(fake)
  const sizeOf = contractSizeOf
  const accounts = new HtxAccounts({
    http,
    clock: () => NOW,
    options: { family: 'v5', defaultSymbol: 'BTC-USDT' },
    contractSizeOf: sizeOf,
  }, [CANARY_SECRET, CANARY_KEY])
  const trading = new HtxTrading({
    http,
    instrumentOf: (id) => instrumentOf(id),
    quoteOf: () => freshQuote(),
    openOrders: (ref, symbol) => accounts.openOrders(ref, symbol),
    orderStatus: (ref, key, opts) => accounts.orderStatus(ref, key, opts ?? {}),
    faceValueOf: (id) => sizeOf(id.replace(/^htx:/i, '')),
    clock: () => NOW,
    family: 'v5',
    hedge: false,
    marginMode: 'cross',
    defaultSymbol: 'BTC-USDT',
    accounts,
  }, [CANARY_SECRET, CANARY_KEY])
  return { fake, trading }
}

describe('L2-06b 3006 分支的场所原文先脱敏（ack JSON 里不许出现金丝雀串）', () => {
  it('200 无 order_id 且 data 回显两段金丝雀：3006，两串都不在 ack JSON 里', async () => {
    const { fake, trading } = canarySetup()
    fake.nextFailure = { body: { status: 'ok', data: { echo: CANARY_SECRET, key: CANARY_KEY }, ts: NOW } }
    const result = await trading.submit(ctx(), [intent({ clientOrderId: 'gt-l2-06b-echo' })])

    const ack = result.acks[0]!
    expect(ack.problem?.code).toBe(3006)
    const json = JSON.stringify(ack)
    expect(json).not.toContain(CANARY_SECRET)
    expect(json).not.toContain(CANARY_KEY)
  })
})
