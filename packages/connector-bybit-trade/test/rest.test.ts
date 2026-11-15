// SPDX-License-Identifier: CPAL-1.0
// REST 层：信封解包、retCode 分类、429 / 418 退避、3006（结果未知）与 3003 的分界、
// 网络错误、超时、非法 JSON、限流头回填、权重 0 也 acquire(0)。
import { describe, expect, it } from 'vitest'
import { asProblem, BybitHttpError, BybitNetworkError, ProblemError, venueProblem } from '../src/errors'
import { asDecimal } from '@gitrader/protocol'
import { retCodeOf, retMsgOf } from '../src/rest'
import { createWeightBudget } from '../src/budget'
import type { BybitBudget } from '../src/budget'
import { FakeBybitTrade, hangingFetch, throwingFetch, NOW } from './helpers/fake-bybit-trade'
import { newHttp } from './helpers/harness'

const problemOf = async (fn: () => Promise<unknown>, secrets: string[] = []): Promise<{ name: string; code: number; retryable: boolean }> => {
  try {
    await fn()
  } catch (e) {
    return asProblem(e, { secrets, endpoint: 'signed' })
  }
  throw new Error('expected a rejection')
}

describe('信封与结果解包', () => {
  it('成功信封只把 result 交出来（retCode / retMsg / time 不泄漏到调用方）', async () => {
    const http = newHttp(new FakeBybitTrade())
    const result = await http.signed<{ list: Array<{ coin: string }> }>('GET', '/v5/account/wallet-balance', {
      params: { accountType: 'UNIFIED' },
    })
    expect(result.list?.length).toBeGreaterThan(0)
    expect((result as unknown as { retCode?: number }).retCode).toBeUndefined()
  })

  it('retCodeOf / retMsgOf 从原文取字段（取不到时 undefined / 空串）', () => {
    expect(retCodeOf('{"retCode":10004,"retMsg":"error sign"}')).toBe(10004)
    expect(retMsgOf('{"retCode":10004,"retMsg":"error sign"}')).toBe('error sign')
    expect(retCodeOf('{"x":1}')).toBeUndefined()
    expect(retMsgOf('{"x":1}')).toBe('')
  })

  it('HTTP 200 + retCode 10001 → BybitHttpError 带 retCode，Problem 落 INVALID_PARAMS', async () => {
    const fake = new FakeBybitTrade()
    const http = newHttp(fake)
    const problem = await problemOf(() => http.signed('GET', '/v5/account/wallet-balance', {}))
    expect(problem.name).toBe('INVALID_PARAMS')
    expect(problem.retryable).toBe(false)
  })

  it('未处理的路径回 HTTP 404，Problem 是 3001（认不出来不猜）', async () => {
    const http = newHttp(new FakeBybitTrade())
    const problem = await problemOf(() => http.signed('POST', '/v5/nope', { body: {} }))
    expect(problem.code).toBe(3001)
  })

  it('非法 JSON 也当上游故障（非 GET → 3006）', async () => {
    const fake = new FakeBybitTrade()
    fake.failWith.set('POST /v5/order/create', () => new Response('not json', { status: 200 }))
    const http = newHttp(fake)
    const problem = await problemOf(() =>
      http.signed('POST', '/v5/order/create', { body: { category: 'linear', symbol: 'BTCUSDT', side: 'Buy', orderType: 'Market', qty: '0.001' } }))
    expect(problem.code).toBe(3006)
  })
})

describe('429 / 418：与 HL 包同口径的限流 Problem', () => {
  it('429 → VENUE_RATE_LIMITED（3002）+ retryable + Retry-After', async () => {
    const fake = new FakeBybitTrade()
    fake.httpStatusOverride.set('/v5/account/wallet-balance', { status: 429, headers: { 'retry-after': '2' } })
    const http = newHttp(fake)
    try {
      await http.signed('GET', '/v5/account/wallet-balance', { params: { accountType: 'UNIFIED' } })
      throw new Error('expected a rejection')
    } catch (e) {
      const p = asProblem(e)
      expect(p.code).toBe(3002)
      expect(p.retryable).toBe(true)
      expect(p.retryAfterMs).toBe(2_000)
    }
  })

  it('418 → 也是 3002（HL 与 Binance 包同口径）', async () => {
    const fake = new FakeBybitTrade()
    fake.httpStatusOverride.set('/v5/account/wallet-balance', { status: 418 })
    const http = newHttp(fake)
    try {
      await http.signed('GET', '/v5/account/wallet-balance', { params: { accountType: 'UNIFIED' } })
      throw new Error('expected a rejection')
    } catch (e) {
      expect(asProblem(e).code).toBe(3002)
      expect(asProblem(e).retryable).toBe(true)
    }
  })

  it('429 让预算整体退避（penalize 收到 Retry-After）', async () => {
    const fake = new FakeBybitTrade()
    fake.httpStatusOverride.set('/v5/account/wallet-balance', { status: 429, headers: { 'retry-after': '3' } })
    const budget = { penalized: [] as number[], ok: 0 }
    const wrapped = createWeightBudget({ clock: () => NOW })
    const spy: BybitBudget = {
      ...wrapped,
      acquire: (w, o) => wrapped.acquire(w, o),
      charge: (w, k) => wrapped.charge(w, k),
      penalize: (ms) => {
        budget.penalized.push(ms ?? 0)
        wrapped.penalize(ms)
      },
      reportOk: () => {
        budget.ok += 1
        wrapped.reportOk()
      },
      usage: () => wrapped.usage(),
      reconcile: (u) => wrapped.reconcile(u),
      noteOrder: (c) => wrapped.noteOrder(c),
    }
    const http = newHttp(fake, { budget: spy })
    await expect(http.signed('GET', '/v5/account/wallet-balance', { params: { accountType: 'UNIFIED' } })).rejects.toBeInstanceOf(BybitHttpError)
    expect(budget.penalized).toEqual([3_000])
  })

  it('POST 遇 retCode 10018 → 3002，可重试', async () => {
    const fake = new FakeBybitTrade()
    fake.fail('POST', '/v5/order/create', 10018, 'access too frequent')
    const http = newHttp(fake)
    const p = await problemOf(() => http.signed('POST', '/v5/order/create', { body: { category: 'linear', symbol: 'BTCUSDT', side: 'Buy', orderType: 'Market', qty: '0.001' } }))
    expect(p.code).toBe(3002)
    expect(p.retryable).toBe(true)
  })

  it('GET 遇 HTTP 403 + access too frequent → VENUE_RATE_LIMITED，退避 600 s', async () => {
    const fake = new FakeBybitTrade()
    fake.httpStatusOverride.set('/v5/position/list', { status: 403, body: 'access too frequent' })
    const wrapped = createWeightBudget({ clock: () => NOW })
    const http = newHttp(fake, { budget: wrapped })
    const err = await http.signed('GET', '/v5/position/list', { params: { category: 'linear', settleCoin: 'USDT' } }).catch((e: unknown) => e)
    const p = asProblem(err)
    expect(p.name).toBe('VENUE_RATE_LIMITED')
    expect(p.retryAfterMs).toBe(600_000)
    expect(wrapped.usage().backoffUntil).toBeGreaterThanOrEqual(NOW + 600_000)
  })

  it('HTTP 403 + forbidden 不是 VENUE_AUTH', async () => {
    const fake = new FakeBybitTrade()
    fake.httpStatusOverride.set('/v5/position/list', { status: 403, body: 'forbidden' })
    const http = newHttp(fake)
    const p = await problemOf(() => http.signed('GET', '/v5/position/list', { params: { category: 'linear', settleCoin: 'USDT' } }))
    expect(p.name).not.toBe('VENUE_AUTH')
    expect(p.code).toBe(3001)
  })

  it('POST 遇 retCode 10006 按 reset 头退避', async () => {
    const fake = new FakeBybitTrade()
    fake.failWith.set('POST /v5/order/create', () => new Response(
      JSON.stringify({ retCode: 10006, retMsg: 'Too many visits', result: null, time: NOW }),
      { status: 200, headers: { 'content-type': 'application/json', 'x-bapi-limit-reset-timestamp': String(NOW + 2_000) } },
    ))
    const wrapped = createWeightBudget({ clock: () => NOW })
    const http = newHttp(fake, { budget: wrapped })
    const err = await http.signed('POST', '/v5/order/create', { body: { category: 'linear', symbol: 'BTCUSDT', side: 'Buy', orderType: 'Market', qty: '0.001' } }).catch((e: unknown) => e)
    const p = asProblem(err)
    expect(p.retryAfterMs).toBe(2_000)
    expect(wrapped.usage().backoffUntil).toBeGreaterThanOrEqual(NOW + 2_000)
  })
})

describe('结果未知（3006）与可重试（3003）的分界', () => {
  it('POST + HTTP 500 → 3006，不得重试', async () => {
    const fake = new FakeBybitTrade()
    fake.httpStatusOverride.set('/v5/order/create', { status: 500 })
    const http = newHttp(fake)
    const p = await problemOf(() => http.signed('POST', '/v5/order/create', { body: { category: 'linear', symbol: 'BTCUSDT', side: 'Buy', orderType: 'Market', qty: '0.001' } }))
    expect(p.name).toBe('VENUE_OUTCOME_UNKNOWN')
    expect(p.code).toBe(3006)
    expect(p.retryable).toBe(false)
  })

  it('GET + HTTP 500 → 3003（可重试）', async () => {
    const fake = new FakeBybitTrade()
    fake.httpStatusOverride.set('/v5/position/list', { status: 502 })
    const http = newHttp(fake)
    const p = await problemOf(() => http.signed('GET', '/v5/position/list', { params: { category: 'linear', settleCoin: 'USDT' } }))
    expect(p.name).toBe('VENUE_UNAVAILABLE')
    expect(p.code).toBe(3003)
  })

  it('POST + retCode 10000（server error）→ 3006', async () => {
    const fake = new FakeBybitTrade()
    fake.fail('POST', '/v5/order/create', 10000, 'Server error')
    const http = newHttp(fake)
    const p = await problemOf(() => http.signed('POST', '/v5/order/create', { body: { category: 'linear', symbol: 'BTCUSDT', side: 'Buy', orderType: 'Market', qty: '0.001' } }))
    expect(p.code).toBe(3006)
  })

  it('GET + retCode 10000 → 3003（只读可以重试）', async () => {
    const fake = new FakeBybitTrade()
    fake.fail('GET', '/v5/position/list', 10000, 'Server error')
    const http = newHttp(fake)
    const p = await problemOf(() => http.signed('GET', '/v5/position/list', { params: { category: 'linear', settleCoin: 'USDT' } }))
    expect(p.code).toBe(3003)
  })

  it('POST + retCode 10016（service restarting）→ 3006（可能已经落地）', async () => {
    const fake = new FakeBybitTrade()
    fake.fail('POST', '/v5/order/cancel', 10016, 'Service is restarting')
    const http = newHttp(fake)
    const p = await problemOf(() => http.signed('POST', '/v5/order/cancel', { body: { category: 'linear', symbol: 'BTCUSDT', orderId: '1' } }))
    expect(p.code).toBe(3006)
  })

  it('断网：POST → 3006，GET → 3003', async () => {
    const post = newHttp(new FakeBybitTrade(), { fetchImpl: throwingFetch() })
    const postProblem = await problemOf(() => post.signed('POST', '/v5/order/create', { body: { category: 'linear', symbol: 'BTCUSDT', side: 'Buy', orderType: 'Market', qty: '0.001' } }))
    expect(postProblem.code).toBe(3006)
    const get = newHttp(new FakeBybitTrade(), { fetchImpl: throwingFetch() })
    const getProblem = await problemOf(() => get.signed('GET', '/v5/position/list', { params: { category: 'linear', settleCoin: 'USDT' } }))
    expect(getProblem.code).toBe(3003)
  })

  it('超时：POST → 3006（hangingFetch + 小 timeout）', async () => {
    const http = newHttp(new FakeBybitTrade(), { fetchImpl: hangingFetch(), timeoutMs: 20 })
    const p = await problemOf(() => http.signed('POST', '/v5/order/create', { body: { category: 'linear', symbol: 'BTCUSDT', side: 'Buy', orderType: 'Market', qty: '0.001' } }))
    expect(p.code).toBe(3006)
  }, 10_000)

  it('超时：GET → 3003', async () => {
    const http = newHttp(new FakeBybitTrade(), { fetchImpl: hangingFetch(), timeoutMs: 20 })
    const p = await problemOf(() => http.signed('GET', '/v5/position/list', { params: { category: 'linear', settleCoin: 'USDT' } }))
    expect(p.code).toBe(3003)
  }, 10_000)

  it('BybitNetworkError 显式标了 outcomeUnknown（改变状态的请求）→ 3006', () => {
    const p = asProblem(new BybitNetworkError('socket hang up', 'signed', undefined, true))
    expect(p.code).toBe(3006)
    expect(p.retryable).toBe(false)
  })

  it('BybitNetworkError 没标 outcomeUnknown（签名的 GET）→ 3003，可以安全重试', () => {
    const p = asProblem(new BybitNetworkError('socket hang up', 'signed'))
    expect(p.code).toBe(3003)
    expect(p.retryable).toBe(true)
  })

  it('BybitNetworkError 的 public 端点不是结果未知', () => {
    const p = asProblem(new BybitNetworkError('socket hang up', 'public'))
    expect(p.code).toBe(3003)
  })

  it('ProblemError 原样透传 Problem（含 3006）', () => {
    const p = asProblem(new ProblemError(venueProblem('VENUE_OUTCOME_UNKNOWN', 'unknown', 'upstream')))
    expect(p.code).toBe(3006)
    expect(p.retryable).toBe(false)
  })
})

describe('公共请求与限流头', () => {
  it('publicGet 不带任何密钥头（假服务器会因此回 10003）', async () => {
    const fake = new FakeBybitTrade()
    const http = newHttp(fake)
    const body = await http.publicGet<{ timeSecond?: string }>('/v5/market/time')
    expect(body.timeSecond).toBeDefined()
    expect(fake.last()!.apiKey).toBeNull()
  })

  it('X-Bapi-Limit-Status 是剩余次数：37 → rateLimitStatus 37，预算只记实际权重', async () => {
    const fake = new FakeBybitTrade()
    const wrapped = createWeightBudget({ clock: () => NOW })
    // 在构造 BybitHttp 之前包一层 fetch，给每个响应加上限流头（假服务器本身不伪装这个头）
    const withLimitHeader: typeof fetch = async (input, init) => {
      const res = await fake.fetch(input, init)
      const headers = new Headers(res.headers)
      headers.set('x-bapi-limit-status', '37')
      return new Response(await res.text(), { status: res.status, headers })
    }
    const http = newHttp(fake, { budget: wrapped, fetchImpl: withLimitHeader })
    await http.signed('GET', '/v5/account/wallet-balance', { params: { accountType: 'UNIFIED' } })
    expect(http.rateLimitStatus).toBe(37)
    expect(wrapped.usage().used).toBe(1)
  })

  it('X-Bapi-Limit-Status 为 0 时按 reset 头退避', async () => {
    const fake = new FakeBybitTrade()
    const wrapped = createWeightBudget({ clock: () => NOW })
    const withLimitHeader: typeof fetch = async (input, init) => {
      const res = await fake.fetch(input, init)
      const headers = new Headers(res.headers)
      headers.set('x-bapi-limit-status', '0')
      headers.set('x-bapi-limit-reset-timestamp', String(NOW + 1_500))
      return new Response(await res.text(), { status: res.status, headers })
    }
    const http = newHttp(fake, { budget: wrapped, fetchImpl: withLimitHeader })
    await http.signed('GET', '/v5/account/wallet-balance', { params: { accountType: 'UNIFIED' } })
    expect(http.rateLimitStatus).toBe(0)
    expect(wrapped.usage().backoffUntil).toBeGreaterThanOrEqual(NOW + 1_500)
  })

  it('X-Bapi-Limit-Status 为 0 但 reset 就是当前时间（未超限）时不退避', async () => {
    const fake = new FakeBybitTrade()
    const wrapped = createWeightBudget({ clock: () => NOW })
    const withLimitHeader: typeof fetch = async (input, init) => {
      const res = await fake.fetch(input, init)
      const headers = new Headers(res.headers)
      headers.set('x-bapi-limit-status', '0')
      headers.set('x-bapi-limit-reset-timestamp', String(NOW))
      return new Response(await res.text(), { status: res.status, headers })
    }
    const http = newHttp(fake, { budget: wrapped, fetchImpl: withLimitHeader })
    await http.signed('GET', '/v5/account/wallet-balance', { params: { accountType: 'UNIFIED' } })
    expect(http.rateLimitStatus).toBe(0)
    expect(wrapped.usage().backoffUntil).toBe(NOW)
  })

  it('权重 0 的下单请求也走 acquire(0)（429 退避期间不得绕过限流）', async () => {
    const acquired: number[] = []
    const wrapped = createWeightBudget({ clock: () => NOW })
    const spy: BybitBudget = {
      ...wrapped,
      acquire: async (w, o) => {
        acquired.push(w)
        return wrapped.acquire(w, o)
      },
      charge: (w, k) => wrapped.charge(w, k),
      penalize: (ms) => wrapped.penalize(ms),
      reportOk: () => wrapped.reportOk(),
      usage: () => wrapped.usage(),
      reconcile: (u) => wrapped.reconcile(u),
      noteOrder: (c) => wrapped.noteOrder(c),
    }
    const http = newHttp(new FakeBybitTrade(), { budget: spy })
    await http.signed('POST', '/v5/account/set-margin-mode', { body: { setMarginMode: 'REGULAR_MARGIN' } }, { order: true, kind: 'trade' })
    expect(acquired).toEqual([0])
  })

  it('下单请求计入独立的下单计数桶（noteOrder）', async () => {
    const wrapped = createWeightBudget({ clock: () => NOW })
    const http = newHttp(new FakeBybitTrade(), { budget: wrapped })
    await http.signed('POST', '/v5/account/set-margin-mode', { body: { setMarginMode: 'REGULAR_MARGIN' } }, { order: true })
    expect(wrapped.usage().orders.last1s).toBe(1)
  })

  it('成功请求把预算的连续退避计数清零（reportOk）', async () => {
    const fake = new FakeBybitTrade()
    const wrapped = createWeightBudget({ clock: () => NOW })
    const http = newHttp(fake, { budget: wrapped })
    await http.signed('GET', '/v5/account/wallet-balance', { params: { accountType: 'UNIFIED' } })
    expect(wrapped.usage().backoffUntil).toBeLessThanOrEqual(NOW + 1)
  })

  it('累计计数：requests / weightSpent 按发出量递增', async () => {
    const http = newHttp(new FakeBybitTrade())
    await http.signed('GET', '/v5/account/wallet-balance', { params: { accountType: 'UNIFIED' } })
    await http.publicGet('/v5/market/time')
    expect(http.requests).toBe(2)
    expect(http.weightSpent).toBe(2)
  })

  it('calibrate 读 /v5/market/time 并写入偏移（timeNano → ms）', async () => {
    const http = newHttp(new FakeBybitTrade())
    await http.calibrate()
    // 假服务器的市场时间 = NOW，本机时钟也是 NOW：偏移应为 0
    expect(http.ts.offset).toBe(0)
  })

  it('calibrate 失败只 warn，不抛', async () => {
    const warnings: string[] = []
    const http = newHttp(new FakeBybitTrade(), { fetchImpl: throwingFetch(), onWarn: (m) => warnings.push(m) })
    await http.calibrate()
    expect(warnings.length).toBe(1)
  })

  it('usage() 透传注入的预算对象', async () => {
    const http = newHttp(new FakeBybitTrade())
    expect(http.usage().limit).toBe(600)
    expect(asDecimal(String(http.usage().used))).toBeTruthy()
  })
})
