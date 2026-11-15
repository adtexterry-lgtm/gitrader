// SPDX-License-Identifier: CPAL-1.0
// 速率与错误：每请求先要额度（一次一单位、顺序在前）、成功 reportOk；
// 429 → VENUE_UNAVAILABLE + Retry-After；HTTP 200 + status:"error" 的业务错误也必须变成异常而不是空数据。
import { describe, expect, it } from 'vitest'
import { HtxDataConnector } from '../src/connector'
import { FakeHtx, FX_NOW, KLINE_EXAMPLE } from './helpers/fake-htx'

function make(budget?: unknown) {
  const fake = new FakeHtx()
  fake.klineSource = () => [KLINE_EXAMPLE]
  const connector = new HtxDataConnector({
    baseUrl: 'https://htx.example.test', fetchImpl: fake.fetch, clock: () => FX_NOW, ...(budget ? { budget } : {}),
  })
  return { fake, connector }
}

function recordingBudget() {
  const events: string[] = []
  const penalties: Array<number | undefined> = []
  let used = 0
  let oks = 0
  const budget = {
    async acquire(weight: number) {
      used += weight
      events.push(`acquire:${weight}`)
    },
    charge() {},
    reportOk() {
      oks += 1
      events.push('ok')
    },
    penalize(retryAfterMs?: number) {
      penalties.push(retryAfterMs)
    },
    usage: () => ({ used, target: 800, limit: 800, ratio: used / 800, windowMs: 1000, backoffUntil: 0 }),
  }
  return { budget, events, penalties, oks: () => oks }
}

describe('rate budget', () => {
  it('takes one unit before each HTTP call and reports success after it, once per call', async () => {
    const rec = recordingBudget()
    const { connector } = make(rec.budget)

    await connector.start() // contracts
    await connector.candles('htx:BTC-USDT', '1m', { n: 300 }) // kline
    await connector.book('htx:BTC-USDT') // depth（清单已缓存，不再拉）
    await connector.context('htx:BTC-USDT') // mark kline + funding
    await connector.refreshQuote('htx:BTC-USDT') // merged

    // contracts 1 + kline 1 + depth 1 + context 2（标记价 K 线 + 资金费）+ merged 1 = 6 次
    expect(rec.events).toEqual([
      'acquire:1', 'ok',
      'acquire:1', 'ok',
      'acquire:1', 'ok',
      'acquire:1', 'ok',
      'acquire:1', 'ok',
      'acquire:1', 'ok',
    ])
    expect(rec.oks()).toBe(6)
    expect(connector.status().rateBudget).toEqual({ used: 6, limit: 800, windowMs: 1000 })
  })

  it('defaults to an unlimited budget when none is injected', async () => {
    const { connector } = make()
    await connector.start()
    expect(connector.status().rateBudget).toEqual({ used: 0, limit: 800, windowMs: 1000 })
  })
})

describe('HTTP and business failures', () => {
  it('429 becomes VENUE_UNAVAILABLE with retryAfterMs and penalizes the budget', async () => {
    const fake = new FakeHtx()
    const rec = recordingBudget()
    fake.override.set(
      '/linear-swap-ex/market/detail/merged',
      () => new Response('too many requests', { status: 429, headers: { 'retry-after': '3' } }),
    )
    const connector = new HtxDataConnector({ fetchImpl: fake.fetch, budget: rec.budget, clock: () => FX_NOW })

    await expect(connector.refreshQuote('htx:BTC-USDT')).rejects.toMatchObject({
      problem: {
        name: 'VENUE_UNAVAILABLE', code: 3003, category: 'VENUE', retryable: true, retryAfterMs: 3000,
        venue: { code: 429, message: 'too many requests' },
      },
    })
    expect(rec.penalties).toEqual([3000])
    expect(connector.quote('htx:BTC-USDT')).toBeUndefined()
  })

  it('500 becomes a retryable VENUE_UNAVAILABLE without Retry-After', async () => {
    const fake = new FakeHtx()
    fake.override.set('/linear-swap-ex/market/history/kline', () => new Response('boom', { status: 500 }))
    const connector = new HtxDataConnector({ fetchImpl: fake.fetch, clock: () => FX_NOW })

    const error = await connector.candles('htx:BTC-USDT', '1m', { n: 1 }).catch((e: unknown) => e)
    expect(error).toMatchObject({
      problem: { name: 'VENUE_UNAVAILABLE', retryable: true, venue: { code: 500, message: 'boom' } },
    })
    expect((error as { problem?: { retryAfterMs?: number } }).problem?.retryAfterMs).toBeUndefined()
  })

  // 口径变更（WI-2）：1030 是官方参数错误（Input error），不再是 retryable 的 VENUE_UNAVAILABLE。
  it('turns an HTX business error (HTTP 200 + status:"error") into a non-retryable INVALID_PARAMS for 1030', async () => {
    const fake = new FakeHtx()
    fake.override.set('/linear-swap-api/v1/swap_funding_rate', () => ({
      status: 'error', err_code: 1030, err_msg: 'Input error.', ts: FX_NOW,
    }))
    const connector = new HtxDataConnector({ fetchImpl: fake.fetch, clock: () => FX_NOW })

    await expect(connector.context('htx:BTC-USDT')).rejects.toMatchObject({
      problem: {
        name: 'INVALID_PARAMS', retryable: false,
        venue: { id: 'htx', code: 1030, message: 'Input error.' },
      },
    })
  })

  it('maps 1013 (contract symbol does not exist) to a non-retryable INSTRUMENT_UNKNOWN', async () => {
    const fake = new FakeHtx()
    fake.override.set('/linear-swap-ex/market/detail/merged', () => ({
      status: 'error', err_code: 1013, err_msg: "This contract symbol doesn't exist.", ts: FX_NOW,
    }))
    const connector = new HtxDataConnector({ fetchImpl: fake.fetch, clock: () => FX_NOW })

    await expect(connector.refreshQuote('htx:BTC-USDT')).rejects.toMatchObject({
      problem: {
        name: 'INSTRUMENT_UNKNOWN', retryable: false,
        venue: { id: 'htx', code: 1013, message: "This contract symbol doesn't exist." },
      },
    })
    expect(connector.quote('htx:BTC-USDT')).toBeUndefined()
  })

  it('maps 1032 (access limit exceeded) to a retryable VENUE_RATE_LIMITED and penalizes the budget by 3s', async () => {
    const fake = new FakeHtx()
    const rec = recordingBudget()
    fake.override.set('/linear-swap-ex/market/detail/merged', () => ({
      status: 'error', err_code: 1032, err_msg: 'The number of access exceeded the limit.', ts: FX_NOW,
    }))
    const connector = new HtxDataConnector({ fetchImpl: fake.fetch, budget: rec.budget, clock: () => FX_NOW })

    await expect(connector.refreshQuote('htx:BTC-USDT')).rejects.toMatchObject({
      problem: {
        name: 'VENUE_RATE_LIMITED', code: 3002, category: 'VENUE', retryable: true, retryAfterMs: 3000,
        venue: { id: 'htx', code: 1032, message: 'The number of access exceeded the limit.' },
      },
    })
    expect(rec.penalties).toEqual([3000])
  })

  it('maps 1030 (input error) to a non-retryable INVALID_PARAMS', async () => {
    const fake = new FakeHtx()
    fake.override.set('/linear-swap-ex/market/detail/merged', () => ({
      status: 'error', err_code: 1030, err_msg: 'Input error.', ts: FX_NOW,
    }))
    const connector = new HtxDataConnector({ fetchImpl: fake.fetch, clock: () => FX_NOW })

    await expect(connector.refreshQuote('htx:BTC-USDT')).rejects.toMatchObject({
      problem: {
        name: 'INVALID_PARAMS', retryable: false,
        venue: { id: 'htx', code: 1030, message: 'Input error.' },
      },
    })
  })

  it('keeps unknown business codes and code-less errors as retryable VENUE_UNAVAILABLE', async () => {
    const fake = new FakeHtx()
    fake.override.set('/linear-swap-ex/market/detail/merged', () => ({ status: 'error', err_msg: 'boom', ts: FX_NOW }))
    const connector = new HtxDataConnector({ fetchImpl: fake.fetch, clock: () => FX_NOW })

    await expect(connector.refreshQuote('htx:BTC-USDT')).rejects.toMatchObject({
      problem: { name: 'VENUE_UNAVAILABLE', retryable: true, venue: { id: 'htx', message: 'boom' } },
    })
  })

  it('the fake itself rejects a period outside the documented list with 1033 (it is not a rubber stamp)', async () => {
    const fake = new FakeHtx()
    const res = await fake.fetch('https://htx.example.test/linear-swap-ex/market/history/kline?contract_code=BTC-USDT&period=7m&size=1')
    expect(await res.json()).toMatchObject({ status: 'error', err_code: 1033 })
    const missingTo = await fake.fetch('https://htx.example.test/linear-swap-ex/market/history/kline?contract_code=BTC-USDT&period=1min&from=1600000000')
    expect(await missingTo.json()).toMatchObject({ status: 'error', err_code: 1030 })
  })

  it('rejects a malformed JSON body instead of returning empty data', async () => {
    const fake = new FakeHtx()
    fake.override.set('/linear-swap-ex/market/detail/merged', () => new Response('<html>oops</html>', { status: 200 }))
    const connector = new HtxDataConnector({ fetchImpl: fake.fetch, clock: () => FX_NOW })
    await expect(connector.refreshQuote('htx:BTC-USDT')).rejects.toMatchObject({
      problem: { name: 'VENUE_UNAVAILABLE', retryable: true },
    })
  })

  it('rejects a JSON body that is not an object', async () => {
    const fake = new FakeHtx()
    fake.override.set('/linear-swap-ex/market/detail/merged', () => new Response('[]', { status: 200 }))
    const connector = new HtxDataConnector({ fetchImpl: fake.fetch, clock: () => FX_NOW })
    await expect(connector.refreshQuote('htx:BTC-USDT')).rejects.toMatchObject({
      problem: { name: 'VENUE_UNAVAILABLE' },
    })
  })
})
