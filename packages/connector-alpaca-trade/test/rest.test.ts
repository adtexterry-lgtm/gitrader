// SPDX-License-Identifier: CPAL-1.0
// 鉴权与 HTTP 语义（十二条 #3、#6、#11；美股八条第 7 条）：
//   · 头鉴权（APCA-API-KEY-ID / APCA-API-SECRET-KEY），**没有 HMAC 签名头**；
//   · 非 GET 无响应 / 5xx / 坏 JSON → 3006（不可重试，按 clientOrderId 对账）；GET 同类只算 3003（可重试）；
//   · 429 → 3003 retryable + Retry-After，并让预算整体退避；
//   · 密钥不进 JSON.stringify / util.inspect / 错误文本；PK / AK 前缀与声明不符 → 构造期拒绝。
import { inspect } from 'node:util'
import { describe, expect, it } from 'vitest'
import { AlpacaHttp, ModeMismatchError, assertModeMatchesKey, encodeQuery, keyMode } from '../src/rest'
import { asProblem } from '../src/errors'
import { API_KEY, API_SECRET, BASE_URL, DATA_URL, FakeAlpaca, LIVE_API_KEY, NOW } from './helpers/fake-alpaca'
import { fixedBudget } from './helpers/connector'

function makeHttp(over: Partial<ConstructorParameters<typeof AlpacaHttp>[0]> = {}): { http: AlpacaHttp; fake: FakeAlpaca } {
  const fake = over.fetchImpl === undefined ? new FakeAlpaca() : new FakeAlpaca()
  const http = new AlpacaHttp({
    mode: 'paper',
    baseUrl: BASE_URL,
    dataBaseUrl: DATA_URL,
    apiKey: API_KEY,
    apiSecret: API_SECRET,
    fetchImpl: fake.fetch,
    clock: () => NOW,
    budget: fixedBudget(),
    ...over,
  })
  return { http, fake }
}

describe('头鉴权（不是 HMAC）', () => {
  it('发 PAT 请求带两个 APCA 头', async () => {
    const { http, fake } = makeHttp()
    await http.request('GET', '/v2/account')
    const headers = fake.last()?.headers ?? {}
    expect(headers['apca-api-key-id']).toBe(API_KEY)
    expect(headers['apca-api-secret-key']).toBe(API_SECRET)
  })
  it('没有签名头（Alpaca 不用 HMAC）', async () => {
    const { http, fake } = makeHttp()
    await http.request('GET', '/v2/positions')
    const headers = fake.last()?.headers ?? {}
    expect(headers['access-sign']).toBeUndefined()
    expect(headers['access-timestamp']).toBeUndefined()
    expect(headers['x-mbx-apikey']).toBeUndefined()
  })
  it('POST 带 content-type: application/json', async () => {
    const { http, fake } = makeHttp()
    await http.request('POST', '/v2/orders', { body: { symbol: 'AAPL', qty: '1', side: 'buy', type: 'limit', time_in_force: 'gtc', limit_price: '190.00' } })
    expect(fake.last()?.headers['content-type']).toBe('application/json')
  })
  it('缺 key 的请求被假服务器拒绝（401）', async () => {
    const fake = new FakeAlpaca()
    const res = await fake.fetch(`${BASE_URL}/v2/account`, { method: 'GET', headers: {} })
    expect(res.status).toBe(401)
    expect((await res.json() as { code: number }).code).toBe(40110000)
  })
  it('GET 参数按键名排序编码', () => {
    expect(encodeQuery({ b: '2', a: '1', skip: undefined })).toBe('a=1&b=2')
  })
  it('GET 的 query 出现在 URL 上', async () => {
    const { http, fake } = makeHttp()
    await http.request('GET', '/v2/orders', { params: { status: 'open', limit: 500 } })
    expect(fake.last()?.params.get('status')).toBe('open')
    expect(fake.last()?.params.get('limit')).toBe('500')
  })
  it('DELETE 的参数也进 query（撤单 / 全撤没有 body）', async () => {
    const { http, fake } = makeHttp()
    await http.request('DELETE', '/v2/orders', { params: { symbol: 'AAPL' } })
    expect(fake.last()?.method).toBe('DELETE')
    expect(fake.last()?.params.get('symbol')).toBe('AAPL')
  })
})

describe('环境与密钥前缀（八条第 7 条）', () => {
  it('paper 的缺省基址', () => {
    const http = new AlpacaHttp({ mode: 'paper', apiKey: API_KEY, apiSecret: API_SECRET })
    expect(http.baseUrl).toBe('https://paper-api.alpaca.markets')
  })
  it('live 的缺省基址（AK 前缀）', () => {
    const http = new AlpacaHttp({ mode: 'live', apiKey: LIVE_API_KEY, apiSecret: API_SECRET })
    expect(http.baseUrl).toBe('https://api.alpaca.markets')
  })
  it('PK 密钥声明 live → 构造时拒绝', () => {
    expect(() => new AlpacaHttp({ mode: 'live', apiKey: API_KEY, apiSecret: API_SECRET })).toThrow(ModeMismatchError)
  })
  it('AK 密钥声明 paper → 构造时拒绝', () => {
    expect(() => new AlpacaHttp({ mode: 'paper', apiKey: LIVE_API_KEY, apiSecret: API_SECRET })).toThrow(/does not match the declared mode/)
  })
  it('拒绝消息只带前缀，不带密钥', () => {
    try {
      new AlpacaHttp({ mode: 'live', apiKey: API_KEY, apiSecret: API_SECRET })
      throw new Error('expected a throw')
    } catch (e) {
      const text = (e as Error).message
      expect(text).toContain('PK')
      expect(text).not.toContain(API_KEY)
      expect(text).not.toContain(API_SECRET)
    }
  })
  it('keyMode / assertModeMatchesKey', () => {
    expect(keyMode(API_KEY)).toBe('paper')
    expect(keyMode(LIVE_API_KEY)).toBe('live')
    expect(keyMode('ZZ123')).toBe('unknown')
    expect(() => assertModeMatchesKey('ZZ123', 'live')).toThrow(ModeMismatchError)
  })
  it('前缀既非 PK 也非 AK → 构造期拒绝，消息不回显前缀字符', () => {
    const key = 'CKZZTESTKEY0000'
    try {
      new AlpacaHttp({ mode: 'paper', apiKey: key, apiSecret: API_SECRET })
      throw new Error('expected a throw')
    } catch (e) {
      expect(e).toBeInstanceOf(ModeMismatchError)
      const text = (e as Error).message
      expect(text).toContain('not recognised')
      expect(text).not.toContain('CK')
      expect(text).not.toContain(key)
      expect(text).not.toContain(API_SECRET)
    }
  })
  it('缺 key / secret → RangeError', () => {
    expect(() => new AlpacaHttp({ apiKey: '', apiSecret: API_SECRET })).toThrow(/apiKey is required/)
    expect(() => new AlpacaHttp({ apiKey: API_KEY, apiSecret: '   ' })).toThrow(/apiSecret is required/)
  })
})

describe('密钥不外泄（教训 6）', () => {
  it('JSON.stringify / util.inspect 不含密钥', () => {
    const { http } = makeHttp()
    expect(JSON.stringify(http)).not.toContain(API_SECRET)
    expect(inspect(http)).not.toContain(API_SECRET)
    expect(String(http)).not.toContain(API_KEY)
  })
  it('上游回显密钥的错误文本被脱敏', async () => {
    const { http, fake } = makeHttp()
    fake.fail('GET', '/v2/account', { code: 40010000, message: `bad request with secret ${API_SECRET}` }, 400)
    const problem = await http.request('GET', '/v2/account').then(() => null, (e: unknown) => asProblem(e, { secrets: http.secretsForRedaction() }))
    expect(problem).not.toBeNull()
    expect(problem?.message).not.toContain(API_SECRET)
    expect(problem?.venue?.message).not.toContain(API_SECRET)
    expect(problem?.venue?.message).toContain('<redacted>')
  })
})

describe('结果未知 → 3006（只给非 GET）', () => {
  it('POST 5xx → 3006 且不可重试', async () => {
    const { http, fake } = makeHttp()
    fake.fail('POST', '/v2/orders', { message: 'internal server error' }, 500)
    const problem = await http.request('POST', '/v2/orders', { body: { symbol: 'AAPL' } }).then(() => null, (e: unknown) => asProblem(e, { endpoint: 'signed' }))
    expect(problem?.code).toBe(3006)
    expect(problem?.retryable).toBe(false)
    expect(problem?.message).toContain('client_order_id')
  })
  it('POST 断网 → 3006', async () => {
    const { http, fake } = makeHttp()
    fake.networkError('POST', '/v2/orders')
    const problem = await http.request('POST', '/v2/orders', { body: {} }).then(() => null, (e: unknown) => asProblem(e))
    expect(problem?.code).toBe(3006)
  })
  it('DELETE 5xx → 3006', async () => {
    const { http, fake } = makeHttp()
    fake.fail('DELETE', '/v2/orders/ord-1', { message: 'service unavailable' }, 503)
    const problem = await http.request('DELETE', '/v2/orders/ord-1').then(() => null, (e: unknown) => asProblem(e))
    expect(problem?.code).toBe(3006)
  })
  it('PATCH 5xx → 3006', async () => {
    const { http, fake } = makeHttp()
    fake.fail('PATCH', '/v2/orders/ord-1', { message: 'gateway timeout' }, 504)
    const problem = await http.request('PATCH', '/v2/orders/ord-1', { body: { qty: '1' } }).then(() => null, (e: unknown) => asProblem(e))
    expect(problem?.code).toBe(3006)
  })
  it('POST 200 但 body 不是 JSON → 3006（结果不可知）', async () => {
    const { http, fake } = makeHttp()
    fake.failWith.set('POST /v2/orders', () => new Response('not-json', { status: 200 }))
    const problem = await http.request('POST', '/v2/orders', { body: {} }).then(() => null, (e: unknown) => asProblem(e))
    expect(problem?.code).toBe(3006)
  })
  it('GET 5xx → 3003 可重试（不是 3006）', async () => {
    const { http, fake } = makeHttp()
    fake.fail('GET', '/v2/account', { message: 'internal server error' }, 500)
    const problem = await http.request('GET', '/v2/account').then(() => null, (e: unknown) => asProblem(e))
    expect(problem?.code).toBe(3003)
    expect(problem?.retryable).toBe(true)
  })
  it('GET 断网 → 3003 可重试', async () => {
    const { http, fake } = makeHttp()
    fake.networkError('GET', '/v2/positions')
    const problem = await http.request('GET', '/v2/positions').then(() => null, (e: unknown) => asProblem(e))
    expect(problem?.code).toBe(3003)
    expect(problem?.retryable).toBe(true)
  })
  it('GET 200 坏 JSON → 3003', async () => {
    const { http, fake } = makeHttp()
    fake.failWith.set('GET /v2/account', () => new Response('<<<', { status: 200 }))
    const problem = await http.request('GET', '/v2/account').then(() => null, (e: unknown) => asProblem(e))
    expect(problem?.code).toBe(3003)
  })
  it('POST 408 → 3006', async () => {
    const { http, fake } = makeHttp()
    fake.fail('POST', '/v2/orders', { message: 'request timeout' }, 408)
    const problem = await http.request('POST', '/v2/orders', { body: {} }).then(() => null, (e: unknown) => asProblem(e))
    expect(problem?.code).toBe(3006)
  })
  it('POST 422 参数校验 → 3001（不是 3006，重发也没用）', async () => {
    const { http, fake } = makeHttp()
    fake.fail('POST', '/v2/orders', { code: 42210000, message: 'invalid request: qty is required' }, 422)
    const problem = await http.request('POST', '/v2/orders', { body: {} }).then(() => null, (e: unknown) => asProblem(e))
    expect(problem?.code).toBe(3001)
    expect(problem?.retryable).toBe(false)
  })
})

describe('429 退避（教训 11）', () => {
  it('429 → 3003 retryable + Retry-After，并让预算退避', async () => {
    const { http, fake } = makeHttp()
    fake.failWith.set('GET /v2/account', () => new Response(JSON.stringify({ message: 'too many requests' }), {
      status: 429, headers: { 'content-type': 'application/json', 'retry-after': '2' },
    }))
    const problem = await http.request('GET', '/v2/account').then(() => null, (e: unknown) => asProblem(e))
    expect(problem?.code).toBe(3003)
    expect(problem?.retryable).toBe(true)
    expect(problem?.retryAfterMs).toBe(2000)
    expect(http.usage().backoffUntil).toBeGreaterThan(NOW)
  })
  it('429 没有 Retry-After 时按 60 s', async () => {
    const { http, fake } = makeHttp()
    fake.failWith.set('GET /v2/account', () => new Response('{}', { status: 429 }))
    const problem = await http.request('GET', '/v2/account').then(() => null, (e: unknown) => asProblem(e))
    expect(problem?.retryAfterMs).toBe(60_000)
  })
  it('下单请求权重记 1，并记入下单计数', async () => {
    const { http } = makeHttp()
    const before = http.usage()
    await http.request('POST', '/v2/orders', { body: { symbol: 'AAPL', qty: '1', side: 'buy', type: 'limit', time_in_force: 'gtc', limit_price: '190.00' }, order: true })
    const after = http.usage()
    expect(after.used - before.used).toBe(1) // Alpaca 每个请求都占 1 次额度
    const orders = (after as unknown as { orders: { lastMinute: number } }).orders
    expect(orders.lastMinute).toBe(1)
  })
  it('查询请求计入配额', async () => {
    const { http } = makeHttp()
    await http.request('GET', '/v2/account')
    expect(http.usage().used).toBe(1)
  })
  it('204 撤单回 undefined（不是错误）', async () => {
    const { http, fake } = makeHttp()
    const out = await http.request('DELETE', '/v2/orders/ord-open-1')
    expect(out).toBeUndefined()
    expect(fake.last()?.method).toBe('DELETE')
  })
  it('207 全撤结果按数组解析', async () => {
    const { http } = makeHttp()
    const out = await http.request('DELETE', '/v2/orders')
    expect(Array.isArray(out)).toBe(true)
    expect((out as Array<{ status: number }>)[0]?.status).toBe(200)
  })
})

describe('数据主机（参考价）', () => {
  it('dataGet 打数据主机并带同一对鉴权头', async () => {
    const { http, fake } = makeHttp()
    const row = await http.dataGet<{ latestQuote?: { ap?: number } }>('/v2/stocks/AAPL/snapshot', { feed: 'iex' })
    expect(row.latestQuote?.ap).toBe(190.02)
    const call = fake.last()
    expect(call?.host.startsWith('data.')).toBe(true)
    expect(call?.params.get('feed')).toBe('iex')
    expect(call?.headers['apca-api-key-id']).toBe(API_KEY)
  })
  it('数据主机的 403 也是 3001（无行情权限不是结果未知）', async () => {
    const { http, fake } = makeHttp()
    fake.dataForbidden = true
    const problem = await http.dataGet('/v2/stocks/AAPL/snapshot').then(() => null, (e: unknown) => asProblem(e))
    expect(problem?.code).toBe(3001)
  })
})
