// SPDX-License-Identifier: CPAL-1.0
// 签名与请求形状（全离线，假 fetch）：HMAC 向量、timestamp + recvWindow、X-MBX-APIKEY、
// 权重头回填、429 / 418 退避、5xx 的「结果未知」、密钥脱敏。
import { inspect } from 'node:util'
import { describe, expect, it } from 'vitest'
import { createWeightBudget } from '../src/budget'
import { asProblem, redactSecret } from '../src/errors'
import { BinanceHttp, BINANCE_ENDPOINTS, encodeQuery, signatureOf } from '../src/rest'
import { BinanceTradeConnector } from '../src/connector'
import { API_KEY, API_SECRET, BASE_URL, FakeBinanceTrade, NOW } from './helpers/fake-binance-trade'

const fake = (): FakeBinanceTrade => new FakeBinanceTrade()

function httpOf(f: FakeBinanceTrade, opts: { recvWindowMs?: number } = {}): BinanceHttp {
  return new BinanceHttp({
    baseUrl: BASE_URL,
    apiKey: API_KEY,
    apiSecret: API_SECRET,
    fetchImpl: f.fetch,
    clock: () => NOW,
    budget: createWeightBudget({ clock: () => NOW }),
    ...(opts.recvWindowMs !== undefined ? { recvWindowMs: opts.recvWindowMs } : {}),
    onWarn: () => {},
  })
}

// 已知向量：固定 secret + query → HMAC-SHA256 hex（python hmac 与 node:crypto 两套实现各自算过，一致）
const VECTOR_QUERY = 'symbol=BTCUSDT&side=BUY&type=LIMIT&timeInForce=GTC&quantity=0.01&price=95000&recvWindow=5000&timestamp=1791483435048'
const VECTOR_SIG = 'bb53e258cc5379e37e47503e9ae5b513df1786fd4532f3920831e1e20bba39d0'
const MARKET_QUERY = 'symbol=BTCUSDT&side=SELL&type=MARKET&quantity=0.002&recvWindow=5000&timestamp=1791483435048'
const MARKET_SIG = '07cb4b7af69e41c152c21587e074d9c5f20b845b1c1cb8003d339d1a05244927'

describe('HMAC-SHA256 signature vectors', () => {
  it('signatureOf matches the known limit-order vector', () => {
    expect(signatureOf(API_SECRET, VECTOR_QUERY)).toBe(VECTOR_SIG)
  })

  it('signatureOf matches the known market-order vector (no timeInForce)', () => {
    expect(signatureOf(API_SECRET, MARKET_QUERY)).toBe(MARKET_SIG)
  })

  it('a different secret produces a different signature', () => {
    expect(signatureOf('another-secret', VECTOR_QUERY)).not.toBe(VECTOR_SIG)
  })

  it('encodeQuery keeps insertion order and skips undefined', () => {
    expect(encodeQuery({ symbol: 'BTCUSDT', quantity: 1, missing: undefined })).toBe('symbol=BTCUSDT&quantity=1')
  })
})

describe('signed request shape', () => {
  it('builds the exact vector query with timestamp + recvWindow, and signs it', async () => {
    const f = fake()
    const http = httpOf(f)
    await http.signed('POST', '/fapi/v1/order', { symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', timeInForce: 'GTC', quantity: '0.01', price: '95000' }, { order: true })
    const call = f.callsFor('POST', '/fapi/v1/order')[0]!
    expect(call.url).toBe(`${BASE_URL}/fapi/v1/order?${VECTOR_QUERY}&signature=${VECTOR_SIG}`)
    expect(call.signature).toBe(VECTOR_SIG)
    expect(http.lastSignature).toBe(VECTOR_SIG)
  })

  it('sends X-MBX-APIKEY on signed calls and never on public calls', async () => {
    const f = fake()
    const http = httpOf(f)
    await http.signed('GET', '/fapi/v2/account', {})
    await http.publicGet('/fapi/v1/time', {})
    expect(f.callsFor('GET', '/fapi/v2/account')[0]!.apiKey).toBe(API_KEY)
    expect(f.callsFor('GET', '/fapi/v1/time')[0]!.apiKey).toBeNull()
    expect(f.callsFor('GET', '/fapi/v1/time')[0]!.signature).toBeNull()
  })

  it('honours a custom recvWindow and a resynced server clock offset', async () => {
    const f = fake()
    const http = httpOf(f, { recvWindowMs: 10_000 })
    http.resync(NOW + 2_000)
    await http.signed('GET', '/fapi/v2/account', {})
    const call = f.callsFor('GET', '/fapi/v2/account')[0]!
    expect(call.params.get('recvWindow')).toBe('10000')
    expect(call.params.get('timestamp')).toBe(String(NOW + 2_000))
  })

  it('timestamps are strictly increasing even when the clock stands still', async () => {
    const f = fake()
    const http = httpOf(f)
    await http.signed('GET', '/fapi/v2/account', {})
    await http.signed('GET', '/fapi/v2/account', {})
    const [a, b] = f.callsFor('GET', '/fapi/v2/account')
    expect(Number(b!.params.get('timestamp'))).toBeGreaterThan(Number(a!.params.get('timestamp')))
  })

  it('calibrate() reads /fapi/v1/time and stores the offset', async () => {
    const f = fake()
    const http = httpOf(f)
    await http.calibrate()
    expect(http.ts.offset).toBe(0)
    expect(f.callsFor('GET', '/fapi/v1/time')).toHaveLength(1)
  })

  it('testnet and mainnet base urls are configurable, and the environment picks a default', () => {
    expect(BINANCE_ENDPOINTS.mainnet).toBe('https://fapi.binance.com')
    expect(BINANCE_ENDPOINTS.testnet).toBe('https://demo-fapi.binance.com')
    const f = fake()
    const http = new BinanceHttp({ environment: 'testnet', apiKey: API_KEY, apiSecret: API_SECRET, fetchImpl: f.fetch, clock: () => NOW })
    expect(http.baseUrl).toBe('https://demo-fapi.binance.com')
    expect(http.environment).toBe('testnet')
  })

  it('rejects an empty apiKey or apiSecret at construction (no silent anonymous trading)', () => {
    const f = fake()
    expect(() => new BinanceHttp({ apiKey: '', apiSecret: API_SECRET, fetchImpl: f.fetch })).toThrow(RangeError)
    expect(() => new BinanceHttp({ apiKey: API_KEY, apiSecret: '', fetchImpl: f.fetch })).toThrow(RangeError)
  })
})

describe('weight accounting', () => {
  it('backfills X-MBX-USED-WEIGHT-1M into the budget and usedWeight', async () => {
    const f = fake()
    f.usedWeightHeader = '345'
    const budget = createWeightBudget({ clock: () => NOW })
    const http = new BinanceHttp({ baseUrl: BASE_URL, apiKey: API_KEY, apiSecret: API_SECRET, fetchImpl: f.fetch, clock: () => NOW, budget })
    await http.signed('GET', '/fapi/v2/account', {}, { weight: 5 })
    expect(http.usedWeight).toBe(345)
    expect(budget.usage().used).toBeGreaterThanOrEqual(345)
  })

  it('weights: account = 5, openOrders(all) = 40, order = 0', async () => {
    const f = fake()
    const budget = createWeightBudget({ clock: () => NOW })
    const http = new BinanceHttp({ baseUrl: BASE_URL, apiKey: API_KEY, apiSecret: API_SECRET, fetchImpl: f.fetch, clock: () => NOW, budget })
    f.usedWeightHeader = null
    await http.signed('GET', '/fapi/v2/account', {}, { weight: 5 })
    await http.signed('GET', '/fapi/v1/openOrders', {}, { weight: 40 })
    await http.signed('POST', '/fapi/v1/order', { symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quantity: '0.001' }, { order: true })
    expect(http.weightSpent).toBe(45)
    expect(http.requests).toBe(3)
  })

  it('a 429 penalizes the budget and maps to VENUE_UNAVAILABLE with Retry-After', async () => {
    const f = fake()
    const budget = createWeightBudget({ clock: () => NOW })
    const http = new BinanceHttp({ baseUrl: BASE_URL, apiKey: API_KEY, apiSecret: API_SECRET, fetchImpl: f.fetch, clock: () => NOW, budget })
    f.failWith.set('GET /fapi/v2/account', () => new Response('{"code":-1003,"msg":"Too many requests"}', {
      status: 429,
      headers: { 'retry-after': '5' },
    }))
    let caught: unknown
    try {
      await http.signed('GET', '/fapi/v2/account', {})
    } catch (e) {
      caught = e
    }
    const problem = asProblem(caught, { secrets: [API_SECRET], endpoint: 'signed' })
    expect(problem.name).toBe('VENUE_UNAVAILABLE')
    expect(problem.retryable).toBe(true)
    expect(problem.retryAfterMs).toBe(5_000)
    expect(budget.usage().backoffUntil).toBe(NOW + 5_000)
  })

  it('418 (IP ban) is treated the same way', async () => {
    const f = fake()
    const http = httpOf(f)
    f.failWith.set('GET /fapi/v2/account', () => new Response('banned', { status: 418, headers: { 'retry-after': '120' } }))
    let caught: unknown
    try {
      await http.signed('GET', '/fapi/v2/account', {})
    } catch (e) {
      caught = e
    }
    const problem = asProblem(caught)
    expect(problem.code).toBe(3003)
    expect(problem.retryAfterMs).toBe(120_000)
  })
})

describe('transport failures and secret hygiene', () => {
  it('a 5xx on a mutating request is VENUE_OUTCOME_UNKNOWN (3006), not a plain rejection', async () => {
    const f = fake()
    const http = httpOf(f)
    f.failWith.set('POST /fapi/v1/order', () => new Response('bad gateway', { status: 502 }))
    let caught: unknown
    try {
      await http.signed('POST', '/fapi/v1/order', { symbol: 'BTCUSDT' }, { order: true })
    } catch (e) {
      caught = e
    }
    const problem = asProblem(caught, { secrets: [API_SECRET], endpoint: 'signed' })
    expect(problem.code).toBe(3006)
    expect(problem.retryable).toBe(false)
  })

  it('a 5xx on a read-only public call is VENUE_UNAVAILABLE (3003, retryable)', async () => {
    const f = fake()
    const http = httpOf(f)
    f.failWith.set('GET /fapi/v1/time', () => new Response('service unavailable', { status: 503 }))
    let caught: unknown
    try {
      await http.publicGet('/fapi/v1/time', {})
    } catch (e) {
      caught = e
    }
    const problem = asProblem(caught, { endpoint: 'public' })
    expect(problem.code).toBe(3003)
    expect(problem.retryable).toBe(true)
  })

  it('a thrown fetch on a signed order becomes 3006 and never leaks the secret', async () => {
    const failing: typeof fetch = async () => {
      throw new Error(`socket hang up while signing with ${API_SECRET}`)
    }
    const http = new BinanceHttp({ baseUrl: BASE_URL, apiKey: API_KEY, apiSecret: API_SECRET, fetchImpl: failing, clock: () => NOW })
    let caught: unknown
    try {
      await http.signed('POST', '/fapi/v1/order', { symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quantity: '0.001' }, { order: true })
    } catch (e) {
      caught = e
    }
    const problem = asProblem(caught, { secrets: [API_SECRET, API_KEY], endpoint: 'signed' })
    expect(problem.code).toBe(3006)
    expect(problem.venue?.message).not.toContain(API_SECRET)
    expect(problem.venue?.message).toContain('<redacted>')
  })

  it('a signed GET with no response is VENUE_UNAVAILABLE (3003, retryable)', async () => {
    const failing: typeof fetch = async () => {
      throw new Error('timed out waiting for response')
    }
    const http = new BinanceHttp({ baseUrl: BASE_URL, apiKey: API_KEY, apiSecret: API_SECRET, fetchImpl: failing, clock: () => NOW })
    let caught: unknown
    try {
      await http.signed('GET', '/fapi/v2/account', {})
    } catch (e) {
      caught = e
    }
    const problem = asProblem(caught, { endpoint: 'signed' })
    expect(problem.code).toBe(3003)
    expect(problem.retryable).toBe(true)
  })

  it('-1021 resyncs the clock from /fapi/v1/time and retries exactly once', async () => {
    const f = fake()
    const http = httpOf(f)
    f.userTrades = []
    f.failNext('GET', '/fapi/v1/userTrades', { code: -1021, msg: 'Timestamp for this request is outside of the recvWindow.' })
    const rows = await http.signed<unknown[]>('GET', '/fapi/v1/userTrades', { symbol: 'BTCUSDT' })
    expect(rows).toEqual([])
    expect(f.callsFor('GET', '/fapi/v1/userTrades')).toHaveLength(2)
    expect(f.callsFor('GET', '/fapi/v1/time')).toHaveLength(1)
    // 第二次请求用了重校后的时间戳（/fapi/v1/time fake 返回 NOW，偏移 0；至少证明重发了新签名）
    const [a, b] = f.callsFor('GET', '/fapi/v1/userTrades')
    expect(b!.signature).not.toBe(a!.signature)
  })

  it('-1021 that persists is thrown after one retry (no infinite loop)', async () => {
    const f = fake()
    const http = httpOf(f)
    f.fail('GET', '/fapi/v1/userTrades', { code: -1021, msg: 'Timestamp for this request is outside of the recvWindow.' })
    let caught: unknown
    try {
      await http.signed('GET', '/fapi/v1/userTrades', { symbol: 'BTCUSDT' })
    } catch (e) {
      caught = e
    }
    const problem = asProblem(caught, { endpoint: 'signed' })
    expect(problem.name).toBe('INVALID_PARAMS')
    expect(problem.retryable).toBe(false)
    expect(f.callsFor('GET', '/fapi/v1/userTrades')).toHaveLength(2)
  })

  it('the connector object serialises without the api secret or key', async () => {
    const f = fake()
    const connector = new BinanceTradeConnector({
      baseUrl: BASE_URL, apiKey: API_KEY, apiSecret: API_SECRET, fetchImpl: f.fetch, clock: () => NOW, onWarn: () => {},
    })
    const text = JSON.stringify(connector)
    expect(text).not.toContain(API_SECRET)
    expect(text).not.toContain(API_KEY)
    expect(inspect(connector, { depth: 6 })).not.toContain(API_SECRET)
  })

  it('redactSecret removes both the raw secret and its base64 form', () => {
    const text = `key=${API_SECRET} b64=${Buffer.from(API_SECRET).toString('base64')}`
    const out = redactSecret(text, API_SECRET)
    expect(out).not.toContain(API_SECRET)
    expect(out).not.toContain(Buffer.from(API_SECRET).toString('base64'))
    expect(out.match(/<redacted>/g)).toHaveLength(2)
  })

  it('an upstream error body echoing the api key is redacted on the way out', async () => {
    const f = fake()
    const http = httpOf(f)
    f.failWith.set('GET /fapi/v2/account', () => new Response(`{"code":-2015,"msg":"Invalid API-key ${API_KEY}"}`, { status: 401 }))
    let caught: unknown
    try {
      await http.signed('GET', '/fapi/v2/account', {})
    } catch (e) {
      caught = e
    }
    const problem = asProblem(caught, { secrets: [API_KEY, API_SECRET], endpoint: 'signed' })
    expect(problem.name).toBe('VENUE_AUTH')
    expect(problem.venue?.message).not.toContain(API_KEY)
  })
})

describe('fake server contract (signature + required parameters)', () => {
  it('rejects a tampered signature with -1022', async () => {
    const f = fake()
    const query = 'symbol=BTCUSDT&side=BUY&type=MARKET&quantity=0.001&recvWindow=5000&timestamp=1&signature=' + 'deadbeef'
    const res = await f.fetch(`${BASE_URL}/fapi/v1/order?${query}`, { method: 'POST', headers: { 'X-MBX-APIKEY': API_KEY } })
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ code: -1022 })
  })

  it('rejects a missing mandatory parameter with -1102', async () => {
    const f = fake()
    const http = httpOf(f)
    let caught: unknown
    try {
      // 绕过 buildOrderParams，直接发缺 quantity 的请求
      await http.signed('POST', '/fapi/v1/order', { symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET' }, { order: true })
    } catch (e) {
      caught = e
    }
    const problem = asProblem(caught, { endpoint: 'signed' })
    expect(problem.venue?.message).toContain('-1102')
  })

  it('rejects an algo order without triggerPrice / workingType with -1102', async () => {
    const f = fake()
    const http = httpOf(f)
    let caught: unknown
    try {
      await http.signed('POST', '/fapi/v1/algoOrder', {
        algoType: 'CONDITIONAL', symbol: 'BTCUSDT', side: 'SELL', type: 'STOP_MARKET', quantity: '0.01',
      }, { order: true })
    } catch (e) {
      caught = e
    }
    const problem = asProblem(caught, { endpoint: 'signed' })
    expect(problem.venue?.message).toContain('-1102')
    expect(problem.venue?.message).toContain('triggerPrice')
  })
})

describe('weight-0 requests respect the 429 backoff', () => {
  it('acquire(0) still waits while the budget is penalised', async () => {
    const waits: number[] = []
    let now = NOW
    const budget = createWeightBudget({
      clock: () => now,
      sleep: async (ms) => { waits.push(ms); now += ms },
    })
    budget.penalize(5_000)
    const f = fake()
    const http = new BinanceHttp({ baseUrl: BASE_URL, apiKey: API_KEY, apiSecret: API_SECRET, fetchImpl: f.fetch, clock: () => now, budget })
    await http.signed('POST', '/fapi/v1/order', { symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quantity: '0.001' }, { order: true })
    expect(waits).toHaveLength(1)
    expect(waits[0]).toBeGreaterThanOrEqual(5_000)
    expect(f.callsFor('POST', '/fapi/v1/order')).toHaveLength(1)
  })
})

describe('ambiguous execution status (item: unknown outcome must not retry)', () => {
  it('a non-GET -1006 / -1007 / -1000 / 408 becomes 3006, retryable false', async () => {
    for (const [code, status] of [[-1006, 400], [-1007, 400], [-1000, 400], [undefined, 408]] as const) {
      const f = fake()
      const http = httpOf(f)
      const body = code === undefined ? {} : { code, msg: 'Execution status unknown.' }
      f.fail('POST', '/fapi/v1/order', body, status)
      let caught: unknown
      try {
        await http.signed('POST', '/fapi/v1/order', { symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quantity: '0.001' }, { order: true })
      } catch (e) {
        caught = e
      }
      const problem = asProblem(caught, { endpoint: 'signed' })
      expect(problem.code).toBe(3006)
      expect(problem.retryable).toBe(false)
    }
  })

  it('the same -1006 on a GET stays a retryable 3003', async () => {
    const f = fake()
    const http = httpOf(f)
    f.fail('GET', '/fapi/v1/userTrades', { code: -1006, msg: 'Execution status unknown.' })
    let caught: unknown
    try {
      await http.signed('GET', '/fapi/v1/userTrades', { symbol: 'BTCUSDT' })
    } catch (e) {
      caught = e
    }
    const problem = asProblem(caught, { endpoint: 'signed' })
    expect(problem.code).toBe(3003)
    expect(problem.retryable).toBe(true)
  })

  it('a GET 408 is a retryable 3003', async () => {
    const f = fake()
    const http = httpOf(f)
    f.fail('GET', '/fapi/v1/userTrades', {}, 408)
    let caught: unknown
    try {
      await http.signed('GET', '/fapi/v1/userTrades', { symbol: 'BTCUSDT' })
    } catch (e) {
      caught = e
    }
    const problem = asProblem(caught, { endpoint: 'signed' })
    expect(problem.code).toBe(3003)
    expect(problem.retryable).toBe(true)
  })
})
