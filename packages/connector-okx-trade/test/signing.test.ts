// SPDX-License-Identifier: CPAL-1.0
// 签名与请求形状（全离线，假 fetch）：base64 HMAC 向量、ISO 时间戳、四个 OK-ACCESS 头、
// 演示盘头、签名覆盖 body、429 退避、信封错误码、非 ASCII 凭据、密钥脱敏。
import { describe, expect, it } from 'vitest'
import { createCountBudget } from '../src/budget'
import { asProblem, redactSecret } from '../src/errors'
import { isoOf } from '../src/nonce'
import { encodeQuery, OkxHttp, OKX_ENDPOINTS, signOkx, signWsLogin, signedPathOf } from '../src/rest'
import { API_KEY, API_SECRET, BASE_URL, FakeOkxTrade, NOW, PASSPHRASE } from './helpers/fake-okx-trade'

const fake = (): FakeOkxTrade => new FakeOkxTrade()

function httpOf(f: FakeOkxTrade, opts: { environment?: 'mainnet' | 'testnet'; budget?: ReturnType<typeof createCountBudget> } = {}): OkxHttp {
  return new OkxHttp({
    baseUrl: BASE_URL,
    apiKey: API_KEY,
    apiSecret: API_SECRET,
    passphrase: PASSPHRASE,
    fetchImpl: f.fetch,
    clock: () => NOW,
    budget: opts.budget ?? createCountBudget({ clock: () => NOW }),
    ...(opts.environment !== undefined ? { environment: opts.environment } : {}),
    onWarn: () => {},
  })
}

// 已知向量：固定 secret + 预签名串 → base64 HMAC-SHA256（node:crypto 与 python hmac 两套实现各自算过，一致）
const VECTOR_TS = '2026-10-21T03:00:00.000Z'
const VECTOR_BODY = '{"instId":"BTC-USDT-SWAP","tdMode":"cross","side":"buy","posSide":"net","ordType":"limit","sz":"5","px":"100000","clOrdId":"gt0123456789abcdef"}'
const VECTOR_REST = 't7RlK4vPx4mdwZ7ivlpAYaCiLprEvAtG2GmpC9g8tXQ='
const VECTOR_GET = 'XQQWRTKSG9fAinOdyszETpnLmU/UeSfg6cWtykEzBAM='
const VECTOR_WS = 'JzIipbOA83x3esj9lrwzCfP5+nefo0Og/Aqk8Sarpo0='

describe('base64 HMAC signature vectors', () => {
  it('matches the known REST vector (timestamp + method + path + body)', () => {
    expect(signOkx(API_SECRET, VECTOR_TS, 'POST', '/api/v5/trade/order', VECTOR_BODY)).toBe(VECTOR_REST)
  })

  it('matches the known GET vector with an empty body', () => {
    expect(signOkx(API_SECRET, VECTOR_TS, 'GET', '/api/v5/account/positions?instType=SWAP', '')).toBe(VECTOR_GET)
  })

  it('uppercases the method, so the prehash is stable across callers', () => {
    expect(signOkx(API_SECRET, VECTOR_TS, 'post', '/api/v5/trade/order', VECTOR_BODY)).toBe(VECTOR_REST)
  })

  it('a different secret produces a different signature', () => {
    expect(signOkx('another-secret', VECTOR_TS, 'POST', '/api/v5/trade/order', VECTOR_BODY)).not.toBe(VECTOR_REST)
  })

  it('body is part of the signature: same path, different body → different signature', () => {
    expect(signOkx(API_SECRET, VECTOR_TS, 'POST', '/api/v5/trade/order', '{}')).not.toBe(VECTOR_REST)
  })

  it('WS login vector signs `${ts}GET/users/self/verify` with the timestamp in seconds', () => {
    expect(signWsLogin(API_SECRET, '1791483435')).toBe(VECTOR_WS)
  })
})

describe('query encoding', () => {
  it('sorts keys, drops undefined and blank values', () => {
    expect(encodeQuery({ instId: 'BTC-USDT-SWAP', instType: 'SWAP', limit: 100, empty: '', missing: undefined }))
      .toBe('instId=BTC-USDT-SWAP&instType=SWAP&limit=100')
  })

  it('signedPathOf appends the query only when there is one', () => {
    expect(signedPathOf('/api/v5/account/balance')).toBe('/api/v5/account/balance')
    expect(signedPathOf('/api/v5/trade/order', { instId: 'BTC-USDT-SWAP', ordId: '1' })).toBe('/api/v5/trade/order?instId=BTC-USDT-SWAP&ordId=1')
  })
})

describe('ISO timestamp', () => {
  it('renders OKX RFC3339 with three fractional digits and a trailing Z', () => {
    expect(isoOf(NOW)).toBe(`${new Date(NOW).toISOString().slice(0, 19)}.048Z`)
    expect(isoOf(NOW)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  })

  it('timestamps are strictly increasing even when the clock stands still', async () => {
    const f = fake()
    const http = httpOf(f)
    await http.signed('GET', '/api/v5/account/balance')
    await http.signed('GET', '/api/v5/account/balance')
    const [a, b] = f.callsFor('GET', '/api/v5/account/balance')
    expect(Date.parse(b!.timestamp!)).toBeGreaterThan(Date.parse(a!.timestamp!))
  })
})

describe('signed request shape', () => {
  it('sends the four OK-ACCESS headers and signs the body it actually sends', async () => {
    const f = fake()
    // 用向量里的时间点当注入时钟，签名才与固定向量逐字节可比
    const http = new OkxHttp({
      baseUrl: BASE_URL, apiKey: API_KEY, apiSecret: API_SECRET, passphrase: PASSPHRASE,
      fetchImpl: f.fetch, clock: () => Date.parse(VECTOR_TS), budget: createCountBudget({ clock: () => NOW }), onWarn: () => {},
    })
    const body = { instId: 'BTC-USDT-SWAP', tdMode: 'cross', side: 'buy', posSide: 'net', ordType: 'limit', sz: '5', px: '100000', clOrdId: 'gt0123456789abcdef' }
    await http.signed('POST', '/api/v5/trade/order', { body })
    const call = f.callsFor('POST', '/api/v5/trade/order')[0]!
    expect(call.key).toBe(API_KEY)
    expect(call.hasPassphrase).toBe(true)
    expect(call.sign).toBe(VECTOR_REST)
    expect(call.body).toBe(VECTOR_BODY)
    expect(http.lastBody).toBe(VECTOR_BODY)
    expect(http.lastSignature).toBe(VECTOR_REST)
  })

  it('GET requests carry the query string in the signed path and send no body', async () => {
    const f = fake()
    const http = httpOf(f)
    await http.signed('GET', '/api/v5/account/positions', { params: { instType: 'SWAP' } })
    const call = f.callsFor('GET', '/api/v5/account/positions')[0]!
    expect(call.url).toBe(`${BASE_URL}/api/v5/account/positions?instType=SWAP`)
    expect(call.body).toBe('')
    expect(call.sign).toBe(signOkx(API_SECRET, call.timestamp!, 'GET', '/api/v5/account/positions?instType=SWAP', ''))
  })

  it('public requests carry no credentials at all', async () => {
    const f = fake()
    const http = httpOf(f)
    await http.publicGet('/api/v5/public/time', {})
    const call = f.callsFor('GET', '/api/v5/public/time')[0]!
    expect(call.key).toBeNull()
    expect(call.sign).toBeNull()
    expect(call.hasPassphrase).toBe(false)
  })

  it('testnet sets x-simulated-trading: 1, mainnet does not', async () => {
    const f = fake()
    await httpOf(f, { environment: 'testnet' }).signed('GET', '/api/v5/account/balance')
    expect(f.callsFor('GET', '/api/v5/account/balance')[0]!.simulated).toBe('1')
    const g = fake()
    await httpOf(g).signed('GET', '/api/v5/account/balance')
    expect(g.callsFor('GET', '/api/v5/account/balance')[0]!.simulated).toBeNull()
  })

  it('mainnet and testnet share the same base url (demo is a header, not a host)', () => {
    expect(OKX_ENDPOINTS.mainnet).toBe('https://www.okx.com')
    expect(OKX_ENDPOINTS.testnet).toBe('https://www.okx.com')
    expect(httpOf(fake()).baseUrl).toBe(BASE_URL)
  })

  it('rejects empty credentials at construction (no silent anonymous trading)', () => {
    expect(() => new OkxHttp({ apiKey: '', apiSecret: API_SECRET, passphrase: PASSPHRASE })).toThrow(RangeError)
    expect(() => new OkxHttp({ apiKey: API_KEY, apiSecret: '  ', passphrase: PASSPHRASE })).toThrow(RangeError)
    expect(() => new OkxHttp({ apiKey: API_KEY, apiSecret: API_SECRET, passphrase: '' })).toThrow(RangeError)
  })

  it('rejects non-ASCII credentials before any header is built', () => {
    expect(() => new OkxHttp({ apiKey: '密钥', apiSecret: API_SECRET, passphrase: PASSPHRASE })).toThrow(/non-ASCII/)
    expect(() => new OkxHttp({ apiKey: API_KEY, apiSecret: API_SECRET, passphrase: '口令' })).toThrow(/non-ASCII/)
  })

  it('calibrate() reads /public/time and stores the offset', async () => {
    const f = fake()
    const http = httpOf(f)
    await http.calibrate()
    expect(f.callsFor('GET', '/api/v5/public/time')).toHaveLength(1)
    expect(http.ts.offset).toBe(0)
  })

  it('resync() shifts the timestamps by the venue offset', async () => {
    const f = fake()
    const http = httpOf(f)
    http.resync(NOW + 3_000)
    await http.signed('GET', '/api/v5/account/balance')
    const call = f.callsFor('GET', '/api/v5/account/balance')[0]!
    expect(Date.parse(call.timestamp!)).toBe(NOW + 3_000)
  })
})

describe('error handling', () => {
  it('429 penalizes the budget and maps to VENUE_RATE_LIMITED with Retry-After', async () => {
    const f = fake()
    const budget = createCountBudget({ clock: () => NOW })
    const http = httpOf(f, { budget })
    f.fail('GET', '/api/v5/account/balance', { code: '50011', msg: 'Too Many Requests' }, 429, { 'retry-after': '5' })
    let caught: unknown
    try {
      await http.signed('GET', '/api/v5/account/balance')
    } catch (e) {
      caught = e
    }
    const problem = asProblem(caught, { secrets: [API_SECRET] })
    expect(problem).toMatchObject({ code: 3002, name: 'VENUE_RATE_LIMITED', retryable: true, retryAfterMs: 5_000 })
    expect(budget.usage().backoffUntil).toBe(NOW + 5_000)
  })

  it('GET 503 is venue unavailable and retryable', async () => {
    const f = fake()
    const http = httpOf(f)
    f.fail('GET', '/api/v5/trade/orders-pending', { code: '50013', msg: 'System busy' }, 503)
    let caught: unknown
    try {
      await http.signed('GET', '/api/v5/trade/orders-pending')
    } catch (e) {
      caught = e
    }
    const problem = asProblem(caught)
    expect(problem.name).toBe('VENUE_UNAVAILABLE')
    expect(problem.retryable).toBe(true)
    expect(problem.retryAfterMs).toBe(2_000)
  })

  it('POST 503 is outcome unknown (3006) and not retryable', async () => {
    const f = fake()
    const http = httpOf(f)
    f.fail('POST', '/api/v5/trade/order', { code: '50013', msg: 'System busy' }, 503)
    let caught: unknown
    try {
      await http.signed('POST', '/api/v5/trade/order', { body: { instId: 'BTC-USDT-SWAP' } })
    } catch (e) {
      caught = e
    }
    expect(asProblem(caught)).toMatchObject({ code: 3006, retryable: false })
  })

  it('GET 50004 stays a retryable transport error', async () => {
    const f = fake()
    const http = httpOf(f)
    f.fail('GET', '/api/v5/account/balance', { code: '50004', msg: 'Endpoint request timeout', data: [] }, 200)
    let caught: unknown
    try {
      await http.signed('GET', '/api/v5/account/balance')
    } catch (e) {
      caught = e
    }
    expect(asProblem(caught)).toMatchObject({ name: 'VENUE_UNAVAILABLE', retryable: true })
  })

  it('only rate-limit envelope codes penalize the budget', async () => {
    const f = fake()
    const budget = createCountBudget({ clock: () => NOW })
    const http = httpOf(f, { budget })
    f.fail('GET', '/api/v5/trade/order', { code: '51603', msg: 'Order does not exist', data: [] }, 200)
    await expect(http.signed('GET', '/api/v5/trade/order')).rejects.toBeTruthy()
    expect(budget.usage().backoffUntil).toBe(0)
    f.fail('GET', '/api/v5/trade/order', { code: '50011', msg: 'Too Many Requests', data: [] }, 200)
    await expect(http.signed('GET', '/api/v5/trade/order')).rejects.toBeTruthy()
    expect(budget.usage().backoffUntil).toBeGreaterThan(0)
  })

  it('network failures follow the GET / non-GET split', async () => {
    const throwing: typeof fetch = async () => { throw new Error('fetch failed') }
    const get = new OkxHttp({
      baseUrl: BASE_URL, apiKey: API_KEY, apiSecret: API_SECRET, passphrase: PASSPHRASE,
      fetchImpl: throwing, clock: () => NOW, budget: createCountBudget({ clock: () => NOW }), onWarn: () => {},
    })
    await expect(get.signed('GET', '/api/v5/account/balance')).rejects.toBeTruthy()
    const getProblem = asProblem(await get.signed('GET', '/api/v5/account/balance').catch((e: unknown) => e))
    expect(getProblem).toMatchObject({ name: 'VENUE_UNAVAILABLE', retryable: true })
    const postProblem = asProblem(await get.signed('POST', '/api/v5/trade/order', { body: {} }).catch((e: unknown) => e))
    expect(postProblem).toMatchObject({ code: 3006, retryable: false })
  })

  it('a wrong secret is rejected by the venue as VENUE_AUTH', async () => {
    const f = fake()
    const http = new OkxHttp({
      baseUrl: BASE_URL, apiKey: API_KEY, apiSecret: 'wrong-secret', passphrase: PASSPHRASE,
      fetchImpl: f.fetch, clock: () => NOW, budget: createCountBudget({ clock: () => NOW }), onWarn: () => {},
    })
    const problem = asProblem(await http.signed('GET', '/api/v5/account/balance').catch((e: unknown) => e))
    expect(problem).toMatchObject({ code: 3005, name: 'VENUE_AUTH' })
  })

  it('an envelope code that is not "0" becomes a classified venue problem', async () => {
    const f = fake()
    const http = httpOf(f)
    f.fail('GET', '/api/v5/account/balance', { code: '50111', msg: 'Invalid API Key' }, 200)
    let caught: unknown
    try {
      await http.signed('GET', '/api/v5/account/balance')
    } catch (e) {
      caught = e
    }
    const problem = asProblem(caught)
    expect(problem.name).toBe('VENUE_AUTH')
    expect(problem.venue?.code).toBe(50111)
    expect(problem.venue?.message).toBe('Invalid API Key')
  })

  it('redacts the secret and its base64 form from error text', () => {
    const text = `bad ${API_SECRET} and ${Buffer.from(API_SECRET, 'utf8').toString('base64')}`
    const out = redactSecret(text, [API_SECRET])
    expect(out).not.toContain(API_SECRET)
    expect(out).not.toContain(Buffer.from(API_SECRET, 'utf8').toString('base64'))
    expect(out).toContain('<redacted>')
  })

  it('a request count is kept for diagnostics', async () => {
    const f = fake()
    const http = httpOf(f)
    await http.signed('GET', '/api/v5/account/balance')
    await http.signed('GET', '/api/v5/account/positions', { params: { instType: 'SWAP' } })
    expect(http.requests).toBe(2)
    expect(http.costSpent).toBe(2)
  })
})
