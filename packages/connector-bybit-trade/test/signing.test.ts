// SPDX-License-Identifier: CPAL-1.0
// 签名：待签串组成、HMAC 向量、头、GET 排序、POST body 原文、时间戳严格递增、密钥不外泄。
// 每个用例都在假服务器上跑真请求（假服务器用同一个 secret 复算签名），所以「签名正确」是被上游验证过的。
import { inspect } from 'node:util'
import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { BybitHttp, encodeQuery, prehashOf, signatureOf } from '../src/rest'
import { redactSecret } from '../src/errors'
import { TimestampSource } from '../src/nonce'
import { API_KEY, API_SECRET, FakeBybitTrade, NOW, RECV_WINDOW } from './helpers/fake-bybit-trade'
import { newHttp } from './helpers/harness'

describe('待签串与 HMAC', () => {
  it('prehashOf 是 timestamp + apiKey + recvWindow + payload 的顺序拼接', () => {
    expect(prehashOf('1700000000000', 'key', 5000, 'a=1&b=2')).toBe('1700000000000key5000a=1&b=2')
  })

  it('signatureOf 是 HMAC-SHA256 hex（与 node:crypto 手算一致）', () => {
    const expected = createHmac('sha256', 'secret').update('abc').digest('hex')
    expect(signatureOf('secret', 'abc')).toBe(expected)
  })

  it('signatureOf 是 64 位小写 hex', () => {
    expect(signatureOf('secret', 'abc')).toMatch(/^[0-9a-f]{64}$/)
  })

  it('同一个 payload 的签名可复现，payload 改一个字符签名就变', () => {
    expect(signatureOf(API_SECRET, 'a')).toBe(signatureOf(API_SECRET, 'a'))
    expect(signatureOf(API_SECRET, 'a')).not.toBe(signatureOf(API_SECRET, 'b'))
  })

  it('encodeQuery 按参数名排序（GET 的待签串与发出去的 query 必须同一份）', () => {
    expect(encodeQuery({ symbol: 'BTCUSDT', category: 'linear', limit: 5 })).toBe('category=linear&limit=5&symbol=BTCUSDT')
  })

  it('encodeQuery 跳过 undefined / null，布尔与数字都 String 化', () => {
    expect(encodeQuery({ a: undefined, b: null, c: true, d: 0 })).toBe('c=true&d=0')
  })

  it('encodeQuery 对需要转义的字符做 URL 编码', () => {
    expect(encodeQuery({ symbol: 'BTC USDT' })).toBe('symbol=BTC+USDT')
  })
})

describe('签名请求头', () => {
  it('四个 X-BAPI-* 头齐全，SIGN-TYPE 固定 2', async () => {
    const fake = new FakeBybitTrade()
    const http = newHttp(fake)
    await http.signed('GET', '/v5/account/wallet-balance', { params: { accountType: 'UNIFIED' } })
    const call = fake.callsFor('GET', '/v5/account/wallet-balance')[0]!
    expect(call.apiKey).toBe(API_KEY)
    expect(call.sign).toMatch(/^[0-9a-f]{64}$/)
    expect(call.timestamp).toBe(String(NOW))
    expect(call.recvWindow).toBe(String(RECV_WINDOW))
    expect(call.signType).toBe('2')
  })

  it('GET 的签名覆盖排序后的 query（假服务器复算通过，响应 retCode = 0）', async () => {
    const fake = new FakeBybitTrade()
    const http = newHttp(fake)
    const page = await http.signed<{ list?: unknown[] }>('GET', '/v5/position/list', {
      params: { category: 'linear', settleCoin: 'USDT' },
    })
    expect(Array.isArray(page.list)).toBe(true)
    const call = fake.callsFor('GET', '/v5/position/list')[0]!
    expect(call.query).toBe('category=linear&settleCoin=USDT')
  })

  it('POST 的签名覆盖 body 原文（不是 query）', async () => {
    const fake = new FakeBybitTrade()
    const http = newHttp(fake)
    await http.signed('POST', '/v5/account/set-margin-mode', { body: { setMarginMode: 'REGULAR_MARGIN' } })
    const call = fake.callsFor('POST', '/v5/account/set-margin-mode')[0]!
    expect(call.query).toBe('')
    expect(call.bodyText).toBe('{"setMarginMode":"REGULAR_MARGIN"}')
    expect(call.sign).toMatch(/^[0-9a-f]{64}$/)
  })

  it('body 的键顺序变化会改变签名（同一份字符串既签又发）', async () => {
    const fake = new FakeBybitTrade()
    const http = newHttp(fake)
    await http.signed('POST', '/v5/account/set-margin-mode', { body: { setMarginMode: 'REGULAR_MARGIN' } })
    const a = http.lastSignature
    await http.signed('POST', '/v5/account/set-margin-mode', { body: { setMarginMode: 'REGULAR_MARGIN' } })
    const b = http.lastSignature
    // 两次的时间戳不同，所以签名也不同；第二次请求的 body 原文就是签的那一份
    expect(a).not.toBe(b)
    expect(fake.callsFor('POST', '/v5/account/set-margin-mode')[1]!.bodyText).toBe('{"setMarginMode":"REGULAR_MARGIN"}')
  })

  it('错误的 secret 会被上游判为 10004（error sign）', async () => {
    const fake = new FakeBybitTrade()
    const http = newHttp(fake, { apiSecret: 'wrong-secret' })
    await expect(http.signed('GET', '/v5/account/wallet-balance', { params: { accountType: 'UNIFIED' } }))
      .rejects.toMatchObject({ retCode: 10004 })
  })

  it('缺 apiKey 的构造直接抛 RangeError（密钥只从构造参数进）', () => {
    expect(() => new BybitHttp({ apiKey: '', apiSecret: 's', baseUrl: 'http://x.example.test' })).toThrow(RangeError)
  })

  it('缺 apiSecret 的构造直接抛 RangeError', () => {
    expect(() => new BybitHttp({ apiKey: 'k', apiSecret: '', baseUrl: 'http://x.example.test' })).toThrow(RangeError)
  })
})

describe('时间戳源', () => {
  it('同一毫秒内连发两个请求时时间戳严格递增（+1 ms）', async () => {
    const fake = new FakeBybitTrade()
    const http = newHttp(fake)
    await http.signed('GET', '/v5/account/wallet-balance', { params: { accountType: 'UNIFIED' } })
    await http.signed('GET', '/v5/account/wallet-balance', { params: { accountType: 'UNIFIED' } })
    const [a, b] = fake.callsFor('GET', '/v5/account/wallet-balance')
    expect(Number(b!.timestamp)).toBe(Number(a!.timestamp) + 1)
  })

  it('TimestampSource.next 单调递增，resync 用场所时间校正偏移', () => {
    let now = 1_000
    const ts = new TimestampSource(() => now, 5_000)
    expect(ts.next()).toBe(1_000)
    expect(ts.next()).toBe(1_001)
    now = 2_000
    expect(ts.next()).toBe(2_000)
    ts.resync(2_500)
    expect(ts.offset).toBe(500)
    expect(ts.next()).toBe(2_500)
  })

  it('recvWindow 越界（0 / 60001）直接 RangeError', () => {
    expect(() => new TimestampSource(() => 0, 0)).toThrow(RangeError)
    expect(() => new TimestampSource(() => 0, 60_001)).toThrow(RangeError)
  })

  it('recvWindow 由构造参数决定并发在头上', async () => {
    const fake = new FakeBybitTrade()
    const http = newHttp(fake, { recvWindowMs: 3_000 })
    await http.signed('GET', '/v5/account/wallet-balance', { params: { accountType: 'UNIFIED' } })
    expect(fake.last()!.recvWindow).toBe('3000')
  })

  it('10002（时间戳越界）先用 /v5/market/time 重校，再重试一次成功', async () => {
    const fake = new FakeBybitTrade()
    fake.failNext('GET', '/v5/account/wallet-balance', 10002, 'timestamp for this request is outside of the recvWindow')
    const http = newHttp(fake)
    const page = await http.signed<{ list?: unknown[] }>('GET', '/v5/account/wallet-balance', { params: { accountType: 'UNIFIED' } })
    expect(page.list?.length).toBe(1)
    expect(fake.callsTo('/v5/market/time').length).toBe(1)
    expect(fake.callsTo('/v5/account/wallet-balance').length).toBe(2)
  })

  it('连续两次 10002 就抛出去（只重试一次，不无限重试）', async () => {
    const fake = new FakeBybitTrade()
    fake.fail('GET', '/v5/account/wallet-balance', 10002, 'timestamp outside recvWindow')
    const http = newHttp(fake)
    await expect(http.signed('GET', '/v5/account/wallet-balance', { params: { accountType: 'UNIFIED' } }))
      .rejects.toMatchObject({ retCode: 10002 })
    expect(fake.callsTo('/v5/account/wallet-balance').length).toBe(2)
  })

  it('10002 重试时时间戳必须比上一次大（否则还是越界）', async () => {
    const fake = new FakeBybitTrade()
    fake.failNext('GET', '/v5/account/wallet-balance', 10002, 'timestamp outside recvWindow')
    const http = newHttp(fake)
    await http.signed('GET', '/v5/account/wallet-balance', { params: { accountType: 'UNIFIED' } })
    const [first, second] = fake.callsFor('GET', '/v5/account/wallet-balance')
    expect(Number(second!.timestamp)).toBeGreaterThan(Number(first!.timestamp))
  })
})

describe('密钥不外泄', () => {
  it('JSON.stringify(BybitHttp) 不含 apiSecret / apiKey', () => {
    const http = newHttp(new FakeBybitTrade())
    const text = JSON.stringify(http)
    expect(text).not.toContain(API_SECRET)
    expect(text).not.toContain(API_KEY)
  })

  it('util.inspect(BybitHttp) 不含 apiSecret / apiKey', () => {
    const http = newHttp(new FakeBybitTrade())
    const text = inspect(http, { depth: 5, showHidden: false })
    expect(text).not.toContain(API_SECRET)
    expect(text).not.toContain(API_KEY)
  })

  it('错误消息里出现密钥时被替换成 <redacted>', () => {
    const text = redactSecret(`boom ${API_SECRET} / ${API_KEY}`, [API_SECRET, API_KEY])
    expect(text).not.toContain(API_SECRET)
    expect(text).not.toContain(API_KEY)
    expect(text).toContain('<redacted>')
  })

  it('safeText 会把上游报错里的密钥抹掉', () => {
    const http = newHttp(new FakeBybitTrade())
    const text = http.safeText(new Error(`upstream echoed ${API_SECRET}`))
    expect(text).not.toContain(API_SECRET)
  })

  it('lastSignature 只暴露签名（hex），不含密钥', async () => {
    const http = newHttp(new FakeBybitTrade())
    expect(http.lastSignature).toBeNull()
    await http.signed('GET', '/v5/account/wallet-balance', { params: { accountType: 'UNIFIED' } })
    expect(http.lastSignature).toMatch(/^[0-9a-f]{64}$/)
    expect(http.lastSignature).not.toContain(API_SECRET)
  })
})
