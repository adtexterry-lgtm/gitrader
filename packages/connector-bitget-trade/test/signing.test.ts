// SPDX-License-Identifier: CPAL-1.0
// 签名 / HTTP 出口：预签串、头、信封、429 退避、3006 判定、时钟重校、密钥脱敏。全部离线（假服务器复算签名）。
import { describe, expect, it } from 'vitest'
import { createCountBudget } from '../src/budget'
import { BitgetApiError, BitgetHttpError, BitgetNetworkError, ProblemError, asProblem } from '../src/errors'
import { BitgetHttp, BITGET_ENDPOINTS, encodeSortedQuery, signatureOf } from '../src/rest'
import { API_KEY, API_SECRET, BASE_URL, NOW, PASSPHRASE, FakeBitget, json } from './helpers/fake-bitget'

const newHttp = (fake: FakeBitget, over: Partial<ConstructorParameters<typeof BitgetHttp>[0]> = {}): BitgetHttp =>
  new BitgetHttp({
    environment: 'mainnet',
    baseUrl: BASE_URL,
    apiKey: API_KEY,
    apiSecret: API_SECRET,
    passphrase: PASSPHRASE,
    fetchImpl: fake.fetch,
    clock: () => NOW,
    budget: createCountBudget({ clock: () => NOW, sleep: async () => {} }),
    onWarn: () => {},
    ...over,
  })

describe('签名（timestamp + METHOD + path(+query) + body，base64 HMAC-SHA256）', () => {
  it('固定向量 A：GET + query', () => {
    expect(signatureOf(API_SECRET, '1791483435048', 'GET', '/api/v2/mix/account/accounts?productType=USDT-FUTURES'))
      .toBe('aimZbwFTiocNZm6DqnNtYnsEU8aWCh0NO3LOe5yvtOA=')
  })
  it('固定向量 B：POST + body', () => {
    expect(signatureOf(API_SECRET, '1791483435048', 'POST', '/api/v2/mix/order/place-order', '{"symbol":"BTCUSDT"}'))
      .toBe('nw9sDwhLLWaoYGvLzd9u0rfk5y2Z24DZkUgCZEtNykI=')
  })
  it('固定向量 C：公共行情端点（不带 query 顺序影响）', () => {
    expect(signatureOf(API_SECRET, '1710000000000', 'get', '/api/v2/mix/market/ticker?productType=USDT-FUTURES'))
      .toBe('CrLWhkIgumSMM6iqBhCkPwOwvDMVauEaIsL+xF4SPeM=')
  })
  it('method 大小写不改变签名（实现内部统一 upper）', () => {
    expect(signatureOf(API_SECRET, '1710000000000', 'post', '/x', '{}')).toBe(signatureOf(API_SECRET, '1710000000000', 'POST', '/x', '{}'))
  })
  it('换 method 签名就变', () => {
    expect(signatureOf(API_SECRET, '1710000000000', 'GET', '/x', '')).not.toBe(signatureOf(API_SECRET, '1710000000000', 'POST', '/x', ''))
  })
  it('换 body 签名就变（body 必须与发出去的字节一致）', () => {
    expect(signatureOf(API_SECRET, '1710000000000', 'POST', '/x', '{"a":1}')).not.toBe(signatureOf(API_SECRET, '1710000000000', 'POST', '/x', '{"a":2}'))
  })
  it('换 secret 签名就变', () => {
    expect(signatureOf('other', '1710000000000', 'GET', '/x')).not.toBe(signatureOf(API_SECRET, '1710000000000', 'GET', '/x'))
  })
  it('签名是 base64（44 字符、以 = 结尾）且不含 secret 原文', () => {
    const sign = signatureOf(API_SECRET, '1710000000000', 'GET', '/x')
    expect(sign).toHaveLength(44)
    expect(sign.endsWith('=')).toBe(true)
    expect(sign.includes(API_SECRET)).toBe(false)
  })
  it('query 顺序不同则签名不同（所以请求必须发排序后的串）', () => {
    const a = signatureOf(API_SECRET, '1710000000000', 'GET', '/x?a=1&b=2')
    const b = signatureOf(API_SECRET, '1710000000000', 'GET', '/x?b=2&a=1')
    expect(a).not.toBe(b)
  })
})

describe('query 编码', () => {
  it('按键名排序', () => {
    expect(encodeSortedQuery({ size: '1', productType: 'USDT-FUTURES', marginCoin: 'USDT' }))
      .toBe('marginCoin=USDT&productType=USDT-FUTURES&size=1')
  })
  it('undefined / null 跳过，0 与空串保留', () => {
    expect(encodeSortedQuery({ a: undefined, b: null, c: 0, d: '' })).toBe('c=0&d=')
  })
  it('数字转字符串', () => {
    expect(encodeSortedQuery({ limit: 100 })).toBe('limit=100')
  })
  it('比较运算保持键顺序稳定（同输入同输出）', () => {
    const input = { z: '1', a: '2', m: '3' }
    expect(encodeSortedQuery(input)).toBe(encodeSortedQuery({ ...input }))
  })
})

describe('请求头与请求形态', () => {
  it('四个 ACCESS-* 头 + JSON Content-Type', async () => {
    const fake = new FakeBitget()
    const http = newHttp(fake)
    await http.signed('GET', '/api/v2/mix/account/accounts', { params: { productType: 'USDT-FUTURES' }, kind: 'query' })
    const headers = fake.last()!.headers
    expect(headers['access-key']).toBe(API_KEY)
    expect(headers['access-passphrase']).toBe(PASSPHRASE)
    expect(headers['access-timestamp']).toBe(String(NOW))
    expect(headers['content-type']).toBe('application/json')
    expect(headers['access-sign']).toBe(signatureOf(API_SECRET, String(NOW), 'GET', '/api/v2/mix/account/accounts?productType=USDT-FUTURES'))
  })
  it('主网不带 PAPTRADING', async () => {
    const fake = new FakeBitget()
    await newHttp(fake).signed('GET', '/api/v2/mix/account/accounts', { params: { productType: 'USDT-FUTURES' } })
    expect(fake.last()!.headers['paptrading']).toBeUndefined()
  })
  it('testnet 自动带 PAPTRADING: 1（同一域名，QD bitget.py:211-212）', async () => {
    const fake = new FakeBitget()
    const http = newHttp(fake, { environment: 'testnet' })
    await http.signed('GET', '/api/v2/mix/account/accounts', { params: { productType: 'USDT-FUTURES' } })
    expect(fake.last()!.headers['paptrading']).toBe('1')
    expect(BITGET_ENDPOINTS.testnet).toBe(BITGET_ENDPOINTS.mainnet)
  })
  it('显式 simulated=true 也会带 PAPTRADING', async () => {
    const fake = new FakeBitget()
    await newHttp(fake, { simulated: true }).signed('GET', '/api/v2/mix/account/accounts', { params: { productType: 'USDT-FUTURES' } })
    expect(fake.last()!.headers['paptrading']).toBe('1')
  })
  it('渠道码缺省不发（不冒用 QD 的渠道码）', async () => {
    const fake = new FakeBitget()
    await newHttp(fake).signed('POST', '/api/v2/mix/order/place-order', {
      body: { symbol: 'BTCUSDT', productType: 'USDT-FUTURES', marginCoin: 'USDT', size: '0.001', side: 'buy' },
    })
    expect(fake.last()!.headers['x-channel-api-code']).toBeUndefined()
  })
  it('配置了渠道码时只对下单类路径附加', async () => {
    const fake = new FakeBitget()
    const http = newHttp(fake, { channelApiCode: 'abc12' })
    await http.signed('POST', '/api/v2/mix/order/place-order', {
      body: { symbol: 'BTCUSDT', productType: 'USDT-FUTURES', marginCoin: 'USDT', size: '0.001', side: 'buy' },
    })
    expect(fake.last()!.headers['x-channel-api-code']).toBe('abc12')
    await http.signed('GET', '/api/v2/mix/account/accounts', { params: { productType: 'USDT-FUTURES' } })
    expect(fake.last()!.headers['x-channel-api-code']).toBeUndefined()
  })
  it('GET 参数进 query（不在 body 里）', async () => {
    const fake = new FakeBitget()
    await newHttp(fake).signed('GET', '/api/v2/mix/order/detail', { params: { productType: 'USDT-FUTURES', orderId: '9001' } })
    const call = fake.last()!
    expect(call.body).toBe('')
    expect(call.query).toBe('orderId=9001&productType=USDT-FUTURES')
  })
  it('POST 参数进 JSON body，且签名覆盖同一份文本', async () => {
    const fake = new FakeBitget()
    await newHttp(fake).signed('POST', '/api/v2/mix/order/place-order', {
      body: { symbol: 'BTCUSDT', productType: 'USDT-FUTURES', marginCoin: 'USDT', size: '0.001', side: 'buy', clientOid: 'abc' },
    })
    const call = fake.last()!
    expect(call.query).toBe('')
    expect(JSON.parse(call.body)).toMatchObject({ symbol: 'BTCUSDT', clientOid: 'abc' })
    expect(call.headers['access-sign']).toBe(signatureOf(API_SECRET, String(NOW), 'POST', call.path, call.body))
  })
  it('返回信封里的 data（不是整个信封）', async () => {
    const fake = new FakeBitget()
    const data = await newHttp(fake).signed<Array<{ marginCoin?: string }>>('GET', '/api/v2/mix/account/accounts', { params: { productType: 'USDT-FUTURES' } })
    expect(Array.isArray(data)).toBe(true)
    expect(data[0]?.marginCoin).toBe('USDT')
  })
  it('累计请求数与被标记的签名 / 时间戳（都不含密钥）', async () => {
    const fake = new FakeBitget()
    const http = newHttp(fake)
    await http.signed('GET', '/api/v2/mix/account/accounts', { params: { productType: 'USDT-FUTURES' } })
    expect(http.requests).toBe(1)
    expect(http.lastTimestamp).toBe(String(NOW))
    expect(http.lastSignature).not.toBeNull()
    expect(http.lastSignature!.includes(API_SECRET)).toBe(false)
    expect(http.lastCode).toBe('00000')
  })
})

describe('错误映射（HTTP / 信封 / 网络）', () => {
  it('签名不符（信封 40009）→ 3005 VENUE_AUTH', async () => {
    const fake = new FakeBitget()
    fake.fail('GET', '/api/v2/mix/account/accounts', { code: '40009', msg: 'Sign signature error' }, 400)
    const problem = asProblem(await capture(() => newHttp(fake).signed('GET', '/api/v2/mix/account/accounts', { params: { productType: 'USDT-FUTURES' } })))
    expect(problem.code).toBe(3005)
    expect(problem.name).toBe('VENUE_AUTH')
    expect(problem.retryable).toBe(false)
  })
  it('429 → 3003 retryable + Retry-After', async () => {
    const fake = new FakeBitget()
    fake.fail('GET', '/api/v2/mix/account/accounts', { code: '429', msg: 'Too Many Requests' }, 429, { 'retry-after': '3' })
    const problem = asProblem(await capture(() => newHttp(fake).signed('GET', '/api/v2/mix/account/accounts', { params: { productType: 'USDT-FUTURES' } })))
    expect(problem.code).toBe(3003)
    expect(problem.retryable).toBe(true)
    expect(problem.retryAfterMs).toBe(3_000)
  })
  it('418 → 同一口径（3003 retryable）', async () => {
    const fake = new FakeBitget()
    fake.fail('GET', '/api/v2/mix/account/accounts', { code: '418', msg: 'teapot' }, 418)
    const problem = asProblem(await capture(() => newHttp(fake).signed('GET', '/api/v2/mix/account/accounts', { params: { productType: 'USDT-FUTURES' } })))
    expect(problem.code).toBe(3003)
    expect(problem.retryable).toBe(true)
    expect(problem.retryAfterMs).toBe(60_000)
  })
  it('429 让预算整体退避', async () => {
    const fake = new FakeBitget()
    fake.fail('GET', '/api/v2/mix/account/accounts', { code: '429' }, 429, { 'retry-after': '2' })
    const http = newHttp(fake)
    await capture(() => http.signed('GET', '/api/v2/mix/account/accounts', { params: { productType: 'USDT-FUTURES' } }))
    expect(http.usage().backoffUntil).toBe(NOW + 2_000)
  })
  it('POST 的 5xx → 3006（不重发，先对账）', async () => {
    const fake = new FakeBitget()
    fake.fail('POST', '/api/v2/mix/order/place-order', { code: '500', msg: 'internal' }, 502)
    const problem = asProblem(await capture(() => newHttp(fake).signed('POST', '/api/v2/mix/order/place-order', {
      body: { symbol: 'BTCUSDT', productType: 'USDT-FUTURES', marginCoin: 'USDT', size: '0.001', side: 'buy' },
    })))
    expect(problem.code).toBe(3006)
    expect(problem.retryable).toBe(false)
  })
  it('GET 的 5xx → 3003（只读可重试）', async () => {
    const fake = new FakeBitget()
    fake.fail('GET', '/api/v2/mix/order/orders-pending', { code: '500' }, 503)
    const problem = asProblem(await capture(() => newHttp(fake).signed('GET', '/api/v2/mix/order/orders-pending', { params: { productType: 'USDT-FUTURES' } })))
    expect(problem.code).toBe(3003)
    expect(problem.retryable).toBe(true)
  })
  it('POST 408 → 3006', async () => {
    const fake = new FakeBitget()
    fake.fail('POST', '/api/v2/mix/order/cancel-order', { code: '408' }, 408)
    const problem = asProblem(await capture(() => newHttp(fake).signed('POST', '/api/v2/mix/order/cancel-order', {
      body: { symbol: 'BTCUSDT', productType: 'USDT-FUTURES', marginCoin: 'USDT', orderId: '1' },
    })))
    expect(problem.code).toBe(3006)
  })
  it('网络错误（POST）→ 3006', async () => {
    const fake = new FakeBitget()
    const http = newHttp(fake, { fetchImpl: (async () => { throw new Error('socket hang up') }) as unknown as typeof fetch })
    const problem = asProblem(await capture(() => http.signed('POST', '/api/v2/mix/order/place-order', { body: { a: '1' } })))
    expect(problem.code).toBe(3006)
    expect(problem.retryable).toBe(false)
  })
  it('网络错误（公共 GET）→ 3003', async () => {
    const fake = new FakeBitget()
    const http = newHttp(fake, { fetchImpl: (async () => { throw new Error('dns failure') }) as unknown as typeof fetch })
    const problem = asProblem(await capture(() => http.publicGet('/api/v2/mix/market/ticker', { productType: 'USDT-FUTURES' })))
    expect(problem.code).toBe(3003)
    expect(problem.retryable).toBe(true)
  })
  it('2xx 但不是 JSON（POST）→ 3006', async () => {
    const fake = new FakeBitget()
    fake.failWith.set('POST /api/v2/mix/order/place-order', () => new Response('<html>oops</html>', { status: 200 }))
    const problem = asProblem(await capture(() => newHttp(fake).signed('POST', '/api/v2/mix/order/place-order', { body: { a: '1' } })))
    expect(problem.code).toBe(3006)
  })
  it('信封里的「System error」在 POST 上按结果未知（3006）', async () => {
    const fake = new FakeBitget()
    fake.fail('POST', '/api/v2/mix/order/place-order', { code: '30001', msg: 'System error, please try again later' }, 200)
    const problem = asProblem(await capture(() => newHttp(fake).signed('POST', '/api/v2/mix/order/place-order', { body: { a: '1' } })))
    expect(problem.code).toBe(3006)
  })
  it('信封里的缺参（40001）→ INVALID_PARAMS（-32602）', async () => {
    const fake = new FakeBitget()
    const problem = asProblem(await capture(() => newHttp(fake).signed('GET', '/api/v2/mix/order/fills', { params: {} })))
    expect(problem.code).toBe(-32602)
    expect(problem.name).toBe('INVALID_PARAMS')
  })
  it('信封错误保留上游 code 与原文（venue 段）', async () => {
    const fake = new FakeBitget()
    fake.fail('GET', '/api/v2/mix/account/accounts', { code: '40001', msg: 'Parameter does not exist: productType' }, 200)
    const problem = asProblem(await capture(() => newHttp(fake).signed('GET', '/api/v2/mix/account/accounts', { params: { productType: 'USDT-FUTURES' } })))
    expect(problem.venue?.code).toBe('40001')
    expect(problem.venue?.message).toBe('Parameter does not exist: productType')
    expect(problem.venue?.id).toBe('bitget')
  })
  it('超时（fetch 不返回）→ POST 3006', async () => {
    const fake = new FakeBitget()
    const never = ((_i: unknown, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted by timeout')))
    })) as unknown as typeof fetch
    const http = newHttp(fake, { fetchImpl: never, timeoutMs: 5 })
    const problem = asProblem(await capture(() => http.signed('POST', '/api/v2/mix/order/place-order', { body: { a: '1' } })))
    expect(problem.code).toBe(3006)
  })
  it('签名 GET 超时 → 3003 retryable（只认 outcomeUnknown，不按 endpoint=signed 判 3006）', async () => {
    const fake = new FakeBitget()
    const never = ((_i: unknown, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted by timeout')))
    })) as unknown as typeof fetch
    const http = newHttp(fake, { fetchImpl: never, timeoutMs: 5 })
    const problem = asProblem(await capture(() => http.signed('GET', '/api/v2/mix/account/accounts', { params: { productType: 'USDT-FUTURES' } })))
    expect(problem.code).toBe(3003)
    expect(problem.retryable).toBe(true)
  })
  it('签名 GET 的 fetch 直接抛错 → 3003', async () => {
    const fake = new FakeBitget()
    const http = newHttp(fake, { fetchImpl: (async () => { throw new Error('socket hang up') }) as unknown as typeof fetch })
    const problem = asProblem(await capture(() => http.signed('GET', '/api/v2/mix/account/accounts', { params: { productType: 'USDT-FUTURES' } })))
    expect(problem.code).toBe(3003)
    expect(problem.retryable).toBe(true)
  })
})

describe('时钟与脱敏', () => {
  it('resync 之后时间戳按偏移发出', async () => {
    const fake = new FakeBitget()
    const http = newHttp(fake)
    http.resync(NOW + 5_000)
    await http.signed('GET', '/api/v2/mix/account/accounts', { params: { productType: 'USDT-FUTURES' } })
    expect(fake.last()!.headers['access-timestamp']).toBe(String(NOW + 5_000))
  })
  it('偏差超过 10 s 时 skewed() 为真', () => {
    const http = newHttp(new FakeBitget())
    http.resync(NOW + 11_000)
    expect(http.clockSync.skewed()).toBe(true)
    http.resync(NOW + 1_000)
    expect(http.clockSync.skewed()).toBe(false)
  })
  it('resync 忽略非法值', () => {
    const http = newHttp(new FakeBitget())
    http.resync(Number.NaN)
    http.resync(-1)
    expect(http.clockSync.offset).toBe(0)
  })
  it('safeText 抹掉 secret / apiKey / passphrase 及其 base64', () => {
    const http = newHttp(new FakeBitget())
    const b64 = Buffer.from(API_SECRET, 'utf8').toString('base64')
    const text = http.safeText(new Error(`leak ${API_SECRET} ${API_KEY} ${PASSPHRASE} ${b64}`))
    expect(text.includes(API_SECRET)).toBe(false)
    expect(text.includes(API_KEY)).toBe(false)
    expect(text.includes(PASSPHRASE)).toBe(false)
    expect(text.includes(b64)).toBe(false)
    expect(text).toContain('<redacted>')
  })
  it('错误对象里的 body 已脱敏（上游回显 apiKey 时不外泄）', async () => {
    const fake = new FakeBitget()
    fake.fail('GET', '/api/v2/mix/account/accounts', { code: '40009', msg: `bad key ${API_KEY}` }, 400)
    const problem = asProblem(await capture(() => newHttp(fake).signed('GET', '/api/v2/mix/account/accounts', { params: { productType: 'USDT-FUTURES' } })), { secrets: [API_KEY] })
    expect(problem.venue?.message.includes(API_KEY)).toBe(false)
  })
  it('JSON.stringify(http) 不含密钥（# 私有字段）', () => {
    const http = newHttp(new FakeBitget())
    const text = JSON.stringify(http)
    expect(text.includes(API_SECRET)).toBe(false)
    expect(text.includes(PASSPHRASE)).toBe(false)
    expect(text.includes(API_KEY)).toBe(false)
  })
  it('错误类型可区分（HTTP / 信封 / 网络）', async () => {
    const fake = new FakeBitget()
    fake.failWith.set('GET /api/v2/mix/account/accounts', () => new Response('<html>bad</html>', { status: 400 }))
    const e = await capture(() => newHttp(fake).signed('GET', '/api/v2/mix/account/accounts', { params: { productType: 'USDT-FUTURES' } }))
    expect(e).toBeInstanceOf(BitgetHttpError)
    const fake2 = new FakeBitget()
    fake2.fail('GET', '/api/v2/mix/account/accounts', { code: '40001', msg: 'Parameter does not exist: x' }, 200)
    const e2 = await capture(() => newHttp(fake2).signed('GET', '/api/v2/mix/account/accounts', { params: { productType: 'USDT-FUTURES' } }))
    expect(e2).toBeInstanceOf(BitgetApiError)
    expect(new BitgetNetworkError('x', 'signed')).toBeInstanceOf(BitgetNetworkError)
    expect(new ProblemError({ code: 1, name: 'X', category: 'VENUE', message: 'm', retryable: false })).toBeInstanceOf(ProblemError)
  })
})

/** 抓住错误（测试里断言 error 类型 / Problem）。 */
async function capture(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn()
  } catch (e) {
    return e
  }
  throw new Error('expected the call to throw')
}

// 让未使用的导入在类型检查里保持有效（json 供个别用例构造原始响应）。
void json
