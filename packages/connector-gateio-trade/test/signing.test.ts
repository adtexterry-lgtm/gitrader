// SPDX-License-Identifier: CPAL-1.0
// 签名 / 传输层：预签串口径、头形状、时钟、限流与「结果未知」分类。全部离线（假服务器复算签名）。
import { createHash, createHmac } from 'node:crypto'
import { beforeEach, describe, expect, it } from 'vitest'
import { makeProblem } from '@gitrader/protocol'
import { asProblem, GateHttpError, GateNetworkError, redactSecret, ProblemError } from '../src/errors'
import { GateioTradeConnector } from '../src/connector'
import { GateHttp, encodeSortedQuery, labelOf, parseJsonExact, signatureOf } from '../src/rest'
import { VenueClock } from '../src/clock'
import { FakeGate, API_KEY, API_SECRET, BASE_URL, NOW } from './helpers/fake-gate'

const fake = new FakeGate()

const manualSignature = (secret: string, ts: string, method: string, path: string, query: string, body: string): string => {
  const hashed = createHash('sha512').update(body, 'utf8').digest('hex')
  const message = `${method}\n${path}\n${query}\n${hashed}\n${ts}`
  return createHmac('sha512', secret).update(message, 'utf8').digest('hex')
}

const httpOf = (f = fake, over: Partial<ConstructorParameters<typeof GateHttp>[0]> = {}): GateHttp =>
  new GateHttp({
    baseUrl: BASE_URL,
    apiKey: API_KEY,
    apiSecret: API_SECRET,
    fetchImpl: f.fetch,
    clock: () => NOW,
    ...over,
  })

beforeEach(() => { fake.reset() })

describe('签名口径（QD gate.py:78-138）', () => {
  it('1. 预签串 = METHOD\\nPATH\\nQUERY\\nsha512hex(body)\\nTIMESTAMP，HMAC-SHA512 出 128 位十六进制', () => {
    const sig = signatureOf(API_SECRET, '1791483435', 'GET', '/api/v4/futures/usdt/accounts')
    expect(sig).toMatch(/^[0-9a-f]{128}$/)
    expect(sig).toBe(manualSignature(API_SECRET, '1791483435', 'GET', '/api/v4/futures/usdt/accounts', '', ''))
  })

  it('2. 同样输入永远同样签名（决定性）', () => {
    const a = signatureOf(API_SECRET, '1791483435', 'POST', '/api/v4/futures/usdt/orders', '', '{"a":1}')
    const b = signatureOf(API_SECRET, '1791483435', 'POST', '/api/v4/futures/usdt/orders', '', '{"a":1}')
    expect(a).toBe(b)
  })

  it('3. 方法大小写归一：get 与 GET 同签名', () => {
    expect(signatureOf(API_SECRET, '1', 'get', '/x')).toBe(signatureOf(API_SECRET, '1', 'GET', '/x'))
  })

  it('4. body 进的是 sha512 十六进制，不是原文（币安口径的关键差别）', () => {
    const body = '{"contract":"BTC_USDT"}'
    const sig = signatureOf(API_SECRET, '1', 'POST', '/x', '', body)
    const rawBodyVariant = createHmac('sha512', API_SECRET)
      .update(`POST\n/x\n\n${body}\n1`, 'utf8')
      .digest('hex')
    expect(sig).not.toBe(rawBodyVariant)
    expect(sig).toBe(manualSignature(API_SECRET, '1', 'POST', '/x', '', body))
  })

  it('5. 任何一个字段变化都改签名：method / path / query / body / ts', () => {
    const base = signatureOf(API_SECRET, '100', 'GET', '/p', 'a=1', '')
    expect(signatureOf(API_SECRET, '100', 'POST', '/p', 'a=1', '')).not.toBe(base)
    expect(signatureOf(API_SECRET, '100', 'GET', '/p2', 'a=1', '')).not.toBe(base)
    expect(signatureOf(API_SECRET, '100', 'GET', '/p', 'a=2', '')).not.toBe(base)
    expect(signatureOf(API_SECRET, '101', 'GET', '/p', 'a=1', '')).not.toBe(base)
    expect(signatureOf('other', '100', 'GET', '/p', 'a=1', '')).not.toBe(base)
  })

  it('6. query 按键排序编码，undefined / null 跳过', () => {
    expect(encodeSortedQuery({ b: '2', a: '1' })).toBe('a=1&b=2')
    expect(encodeSortedQuery({ b: undefined, a: '1', c: null })).toBe('a=1')
    expect(encodeSortedQuery({})).toBe('')
    expect(encodeSortedQuery({ 'x y': 'a b' })).toBe('x+y=a+b')
  })

  it('7. 请求头：KEY / Timestamp / SIGN / X-Gate-Size-Decimal，时间戳是 10 位秒', async () => {
    const h = httpOf()
    await h.signed('GET', '/api/v4/futures/usdt/accounts')
    const call = fake.last()!
    expect(call.headers['key']).toBe(API_KEY)
    expect(call.headers['sign']).toMatch(/^[0-9a-f]{128}$/)
    expect(call.headers['timestamp']).toBe(String(Math.floor(NOW / 1000)))
    expect(call.headers['timestamp']).toMatch(/^\d{10}$/)
    expect(call.headers['x-gate-size-decimal']).toBe('1')
    expect(call.headers['content-type']).toBe('application/json')
  })

  it('8. 假服务器接受我们的签名（往返成功）', async () => {
    const h = httpOf()
    const account = await h.signed<{ total?: string }>('GET', '/api/v4/futures/usdt/accounts')
    expect(account.total).toBe('1020.5')
    expect(fake.callsFor('GET', '/api/v4/futures/usdt/accounts')).toHaveLength(1)
  })

  it('9. 假服务器复算签名：换掉 apiSecret 立刻 401 / VENUE_AUTH', async () => {
    const h = httpOf(fake, { apiSecret: 'wrong-secret' })
    const problem = await asProblemOf(() => h.signed('GET', '/api/v4/futures/usdt/accounts'))
    expect(problem.code).toBe(3005)
    expect(problem.name).toBe('VENUE_AUTH')
    expect(problem.retryable).toBe(false)
  })

  it('10. 假服务器校验 KEY：换掉 apiKey 也拒', async () => {
    const h = httpOf(fake, { apiKey: 'someone-else' })
    const problem = await asProblemOf(() => h.signed('GET', '/api/v4/futures/usdt/positions'))
    expect(problem.code).toBe(3005)
  })

  it('11. 签名后被改动 body → 假服务器算出不同签名并拒绝', async () => {
    const tampering: typeof fetch = async (input, init) => {
      const body = typeof init?.body === 'string' ? `${init.body} ` : init?.body
      return fake.fetch(input, { ...init, body })
    }
    const h = httpOf(fake, { fetchImpl: tampering })
    const problem = await asProblemOf(() => h.signed('POST', '/api/v4/futures/usdt/orders', {
      body: { contract: 'BTC_USDT', size: '1', price: '100', tif: 'gtc', text: 't-a' },
    }))
    expect(problem.name).toBe('VENUE_AUTH')
  })

  it('12. GET 参数排序后既进签名也进 URL（乱序传入也过验签）', async () => {
    const h = httpOf()
    await h.signed('GET', '/api/v4/futures/usdt/orders', { params: { status: 'open', limit: 100, offset: 0 } })
    const call = fake.last()!
    expect(call.query).toBe('limit=100&offset=0&status=open')
    expect(h.lastSignature).toBe(signatureOf(API_SECRET, String(Math.floor(NOW / 1000)), 'GET', '/api/v4/futures/usdt/orders', 'limit=100&offset=0&status=open', ''))
  })

  it('13. 限额 429：VENUE_UNAVAILABLE + retryable + Retry-After，并让预算整体退避', async () => {
    fake.failNext('GET', '/api/v4/futures/usdt/accounts', { label: 'TOO_MANY_REQUESTS', message: 'too many requests' }, 429, { 'retry-after': '3' })
    const h = httpOf()
    const problem = await asProblemOf(() => h.signed('GET', '/api/v4/futures/usdt/accounts'))
    expect(problem.code).toBe(3003)
    expect(problem.retryable).toBe(true)
    expect(problem.retryAfterMs).toBe(3000)
    expect(h.usage().backoffUntil).toBeGreaterThan(NOW)
  })

  it('14. 418 与 429 同码（与 HL 包一致）', async () => {
    fake.failNext('GET', '/api/v4/futures/usdt/accounts', { label: 'TOO_MANY_REQUESTS', message: 'banned' }, 418)
    const h = httpOf()
    const problem = await asProblemOf(() => h.signed('GET', '/api/v4/futures/usdt/accounts'))
    expect(problem.code).toBe(3003)
    expect(problem.retryable).toBe(true)
  })

  it('15. 只读请求 5xx → 3003（可重试）', async () => {
    fake.failNext('GET', '/api/v4/futures/usdt/accounts', { label: 'INTERNAL', message: 'boom' }, 500)
    const h = httpOf()
    const problem = await asProblemOf(() => h.signed('GET', '/api/v4/futures/usdt/accounts'))
    expect(problem.code).toBe(3003)
    expect(problem.retryable).toBe(true)
  })

  it('16. 改变状态的请求 5xx → 3006 且不可重试（必须按 clientOrderId 对账）', async () => {
    fake.failNext('POST', '/api/v4/futures/usdt/orders', { label: 'INTERNAL', message: 'boom' }, 503)
    const h = httpOf()
    const problem = await asProblemOf(() => h.signed('POST', '/api/v4/futures/usdt/orders', { body: { contract: 'BTC_USDT' } }))
    expect(problem.code).toBe(3006)
    expect(problem.retryable).toBe(false)
    expect(problem.message).toContain('query by clientOrderId')
  })

  it('17. 408 上的 POST 也算结果未知（3006）', async () => {
    fake.failNext('DELETE', '/api/v4/futures/usdt/orders/7001', { label: 'TIMEOUT', message: 'timeout' }, 408)
    const h = httpOf()
    const problem = await asProblemOf(() => h.signed('DELETE', '/api/v4/futures/usdt/orders/7001'))
    expect(problem.code).toBe(3006)
  })

  it('18. 断连：POST → 3006；GET → 3003', async () => {
    const broken: typeof fetch = async () => { throw new Error('socket hang up') }
    const h = httpOf(fake, { fetchImpl: broken })
    const post = await asProblemOf(() => h.signed('POST', '/api/v4/futures/usdt/orders', { body: {} }))
    expect(post.code).toBe(3006)
    const get = await asProblemOf(() => h.signed('GET', '/api/v4/futures/usdt/accounts'))
    expect(get.code).toBe(3003)
  })

  it('19. 2xx 但不是 JSON：GET 按不可用、POST 按结果未知', async () => {
    const notJson: typeof fetch = async () => new Response('<html>ok</html>', { status: 200 })
    const h = httpOf(fake, { fetchImpl: notJson })
    const get = await asProblemOf(() => h.signed('GET', '/api/v4/futures/usdt/accounts'))
    expect(get.code).toBe(3003)
    const post = await asProblemOf(() => h.signed('POST', '/api/v4/futures/usdt/orders', { body: { contract: 'BTC_USDT' } }))
    expect(post.code).toBe(3006)
  })

  it('20. 时间戳只从注入时钟取；resync 后按服务端时间走', async () => {
    const clock = new VenueClock(() => NOW)
    expect(clock.timestamp()).toBe(String(Math.floor(NOW / 1000)))
    clock.resync(NOW + 30_000)
    expect(clock.timestamp()).toBe(String(Math.floor((NOW + 30_000) / 1000)))
    expect(clock.skewed()).toBe(true)
    expect(clock.offset).toBe(30_000)
  })

  it('21. 权重 0 的下单请求也走 acquire(0)（429 退避期间不得绕过限流）', async () => {
    const seen: Array<{ weight: number; kind?: string; order?: boolean }> = []
    const h = httpOf(fake, {
      budget: {
        acquire: async (weight, o) => { seen.push({ weight, ...(o?.kind !== undefined ? { kind: o.kind } : {}), ...(o?.order !== undefined ? { order: o.order } : {}) }) },
        charge: () => {},
        penalize: () => {},
        reportOk: () => {},
        noteOrder: () => {},
        usage: () => ({ used: 0, target: 1, limit: 1, ratio: 0, windowMs: 1000, backoffUntil: 0, byKind: { trade: 0, query: 0, background: 0 }, orders: { lastSec: 0, limit: 10 } }),
      },
    })
    await h.signed('POST', '/api/v4/futures/usdt/orders', { body: { contract: 'BTC_USDT', size: '1', price: '1', tif: 'gtc' }, order: true })
    expect(seen).toEqual([{ weight: 0, kind: 'trade', order: true }])
  })

  it('22. 密钥不出现在任何出口：JSON.stringify / util.inspect / 错误文本', async () => {
    const h = httpOf(fake, { apiSecret: 'super-secret-value' })
    const serialized = JSON.stringify(h)
    expect(serialized).not.toContain('super-secret-value')
    expect(serialized).not.toContain(API_KEY)
    const inspected = (await import('node:util')).inspect(h, { depth: 10, showHidden: false })
    expect(inspected).not.toContain('super-secret-value')
    fake.failNext('GET', '/api/v4/futures/usdt/accounts', { label: 'INVALID_SIGNATURE', message: `bad signature for key ${API_KEY}` }, 401)
    const problem = await asProblemOf(() => h.signed('GET', '/api/v4/futures/usdt/accounts'))
    expect(problem.venue?.message ?? '').not.toContain(API_KEY)
    expect(problem.venue?.message ?? '').toContain('<redacted>')
    expect(h.lastSignature).not.toBe(API_SECRET)
  })

  it('23. redactSecret 连 base64 形态一起抹掉', () => {
    const secret = 'abc123'
    const b64 = Buffer.from(secret, 'utf8').toString('base64')
    expect(redactSecret(`x ${secret} y ${b64}`, secret)).toBe('x <redacted> y <redacted>')
    expect(redactSecret('nothing', [])).toBe('nothing')
  })

  it('24. labelOf 只认形状；parseJsonExact 保留大整数源文本', () => {
    expect(labelOf('{"label":"ORDER_NOT_FOUND","message":"x"}')).toBe('ORDER_NOT_FOUND')
    expect(labelOf('[1,2]')).toBeNull()
    expect(labelOf('not json')).toBeNull()
    expect(parseJsonExact('{"id":2111713079019438081,"x":1.5,"s":"a"}')).toEqual({ id: '2111713079019438081', x: 1.5, s: 'a' })
  })

  it('25. GateHttp 把超过 2^53 的 id 保留成字符串（price_orders 响应原文）', async () => {
    const h = httpOf(fake)
    fake.failWith.set('POST /api/v4/futures/usdt/price_orders', () => new Response('{"id":2111713079019438081}', { status: 201, headers: { 'content-type': 'application/json' } }))
    const raw = await h.signed<{ id: string }>('POST', '/api/v4/futures/usdt/price_orders', { body: { initial: { contract: 'BTC_USDT' } } })
    expect(raw).toEqual({ id: '2111713079019438081' })
  })

  it('26. 测试网基址是 api-testnet.gateapi.io（GateHttp 与连接器一致）', () => {
    const h = new GateHttp({ environment: 'testnet', apiKey: API_KEY, apiSecret: API_SECRET })
    expect(h.baseUrl).toBe('https://api-testnet.gateapi.io')
    const connector = new GateioTradeConnector({ environment: 'testnet', apiKey: API_KEY, apiSecret: API_SECRET })
    expect(connector.http.baseUrl).toBe('https://api-testnet.gateapi.io')
  })

  it('27. 429 是限流（POST 也 3003）；POST 400 TOO_BUSY → 3006，GET 400 TOO_BUSY → 3003', async () => {
    const h = httpOf(fake, {
      budget: {
        acquire: async () => {},
        charge: () => {},
        penalize: () => {},
        reportOk: () => {},
        noteOrder: () => {},
        usage: () => ({ used: 0, target: 1, limit: 1, ratio: 0, windowMs: 1000, backoffUntil: 0, byKind: { trade: 0, query: 0, background: 0 }, orders: { lastSec: 0, limit: 10 } }),
      },
    })
    fake.failNext('POST', '/api/v4/futures/usdt/orders', { label: 'TOO_MANY_REQUESTS', message: 'Too many requests, please try again later' }, 429)
    expect((await asProblemOf(() => h.signed('POST', '/api/v4/futures/usdt/orders', { body: { contract: 'BTC_USDT' } }))).code).toBe(3003)
    fake.failNext('POST', '/api/v4/futures/usdt/orders', { label: 'TOO_BUSY' }, 400)
    expect((await asProblemOf(() => h.signed('POST', '/api/v4/futures/usdt/orders', { body: { contract: 'BTC_USDT' } }))).code).toBe(3006)
    fake.failNext('GET', '/api/v4/futures/usdt/accounts', { label: 'TOO_BUSY' }, 400)
    expect((await asProblemOf(() => h.signed('GET', '/api/v4/futures/usdt/accounts'))).code).toBe(3003)
  })

  it('25. asProblem 保留别的包的 ProblemError（按形状认，不退化成 INTERNAL）', () => {
    const foreign = new ProblemError(makeProblem('INSTRUMENT_UNKNOWN', 'gateio:BTC_USDT'))
    expect(asProblem(foreign).name).toBe('INSTRUMENT_UNKNOWN')
    expect(asProblem(new Error('plain')).name).toBe('INTERNAL')
    expect(asProblem(new GateHttpError(400, '{"label":"X"}', 'signed', 'X')).name).toBe('VENUE_REJECTED')
    expect(asProblem(new GateNetworkError('down', 'signed', undefined, true)).code).toBe(3006)
  })
})

async function asProblemOf(fn: () => Promise<unknown>): Promise<{ code: number; name: string; message: string; retryable: boolean; retryAfterMs?: number; venue?: { code?: string | number; message: string } }> {
  try {
    await fn()
  } catch (e) {
    return asProblem(e)
  }
  throw new Error('expected the call to throw')
}
