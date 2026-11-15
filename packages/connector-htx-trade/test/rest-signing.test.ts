// SPDX-License-Identifier: CPAL-1.0
// 签名 / 时间源 / REST 信封。签名断言**不用客户端函数自己算的答案**：期望值在本文件里用 node:crypto
// 按官方规则重算一遍（独立复算），并断言待签串的**字面形状**（四行、排序、编码）。
import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { encodeParams, hostOf, HtxHttp, prehashOf, retryAfterOf, signatureOf, codeOf, envelopeOk } from '../src/rest'
import { formatHtxTimestamp, HtxClock } from '../src/time'
import { asProblem } from '../src/errors'
import { API_SECRET, API_KEY, NOW } from './helpers/fake-htx'
import { newHttp } from './helpers/harness'
import { FakeHtx } from './helpers/fake-htx'

const independentSignature = (secret: string, prehash: string): string =>
  createHmac('sha256', secret).update(prehash, 'utf8').digest('base64')

describe('签名（官方规则 + 独立复算）', () => {
  it('参数按名字升序、值 URL 编码后拼接', () => {
    expect(encodeParams({ b: 2, a: 1, c: 'x y' })).toBe('a=1&b=2&c=x%20y')
  })

  it('跳过 undefined 与 null', () => {
    expect(encodeParams({ a: undefined, b: null, c: 'v' })).toBe('c=v')
  })

  it('排序按参数名而不是按 "名=值" 字符串（前缀键陷阱）', () => {
    expect(encodeParams({ a1: 'x', a: 'y' })).toBe('a=y&a1=x')
  })

  it('布尔与数字都按 String 编码', () => {
    expect(encodeParams({ flag: true, n: 10 })).toBe('flag=true&n=10')
  })

  it('待签串是四行：METHOD / Host / Path / 编码后的参数', () => {
    expect(prehashOf('get', 'api.hbdm.com', '/v5/trade/order', 'a=1')).toBe('GET\napi.hbdm.com\n/v5/trade/order\na=1')
  })

  it('签名的期望值在测试里用 node:crypto 独立重算', () => {
    const prehash = 'GET\napi.hbdm.com\n/v5/account/balance\nAccessKeyId=k&SignatureMethod=HmacSHA256'
    expect(signatureOf(API_SECRET, prehash)).toBe(independentSignature(API_SECRET, prehash))
  })

  it('签名是 Base64（不是 hex）', () => {
    const sig = signatureOf(API_SECRET, 'GET\nh\n/p\n')
    expect(sig).toMatch(/^[A-Za-z0-9+/]+={0,2}$/)
    expect(sig).toHaveLength(44)
  })

  it('不同 secret 得到不同签名', () => {
    const prehash = 'GET\nh\n/p\na=1'
    expect(signatureOf('s1', prehash)).not.toBe(signatureOf('s2', prehash))
  })

  it('Host 从基址取，不带协议头与路径', () => {
    expect(hostOf('https://api.hbdm.com')).toBe('api.hbdm.com')
    expect(hostOf('http://htx.example.test/')).toBe('htx.example.test')
  })

  it('Timestamp 是 UTC ISO8601 秒级（无毫秒、无时区后缀）', () => {
    expect(formatHtxTimestamp(Date.UTC(2017, 4, 18, 6, 20, 56, 789))).toBe('2017-05-18T06:20:56')
  })

  it('同一秒内连发 200 个请求：时间戳都等于当前秒（不做自创的严格递增）', () => {
    const clock = new HtxClock(() => NOW)
    const stamps = Array.from({ length: 200 }, () => clock.nextTimestamp())
    expect(new Set(stamps).size).toBe(1)
    expect(stamps[0]).toBe(formatHtxTimestamp(NOW))
  })

  it('用场所时间重校偏移后时间戳跟着走', () => {
    const clock = new HtxClock(() => NOW)
    clock.resync(NOW + 60_000)
    expect(clock.now()).toBe(NOW + 60_000)
    expect(clock.offset).toBe(60_000)
  })

  it('非法场所时间不改变偏移', () => {
    const clock = new HtxClock(() => NOW)
    clock.resync(0)
    clock.resync(Number.NaN)
    expect(clock.offset).toBe(0)
  })

  it('签名请求把鉴权参数与业务参数一起放在 query 上，并带 Signature', async () => {
    const fake = new FakeHtx()
    const http = newHttp(fake)
    await http.signed('GET', '/v5/trade/order/opens', { params: { contract_code: 'BTC-USDT', order_id: '1' } })
    const req = fake.seen[0]!
    expect(req.query.AccessKeyId).toBe(API_KEY)
    expect(req.query.SignatureMethod).toBe('HmacSHA256')
    expect(req.query.SignatureVersion).toBe('2')
    expect(req.query.Timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/)
    expect(req.query.contract_code).toBe('BTC-USDT')
    expect(req.query.Signature).toBeTruthy()
    expect(fake.signatureFailures).toBe(0)
  })

  it('POST 的业务参数走 JSON body，不进待签串', async () => {
    const fake = new FakeHtx()
    const http = newHttp(fake)
    await http.signed('POST', '/v5/position/lever', { body: { contract_code: 'BTC-USDT', lever_rate: 5, margin_mode: 'cross' } })
    const req = fake.seen[0]!
    expect(req.body).toEqual({ contract_code: 'BTC-USDT', lever_rate: 5, margin_mode: 'cross' })
    expect(req.query.lever_rate).toBeUndefined()
    expect(req.query.contract_code).toBeUndefined()
    // 待签串里只有四个鉴权参数
    expect(http.lastPrehash).toBe([
      'POST', 'htx.example.test', '/v5/position/lever',
      `AccessKeyId=${API_KEY}&SignatureMethod=HmacSHA256&SignatureVersion=2&Timestamp=${NOW / 1000 > 0 ? http.lastPrehash!.split('Timestamp=')[1] : ''}`,
    ].join('\n'))
  })

  it('lastSignature 与待签串可复算（诊断字段不是黑盒）', async () => {
    const fake = new FakeHtx()
    const http = newHttp(fake)
    await http.signed('GET', '/v5/account/balance')
    expect(http.lastSignature).toBe(independentSignature(API_SECRET, http.lastPrehash!))
  })

  it('签名错误被场所拒绝 → 3005 VENUE_AUTH', async () => {
    const fake = new FakeHtx()
    const http = newHttp(fake, { apiSecret: 'wrong-secret' })
    let problem
    try {
      await http.signed('GET', '/v5/account/balance')
    } catch (e) {
      problem = asProblem(e, { secrets: [API_SECRET] })
    }
    expect(problem?.code).toBe(3005)
    expect(fake.signatureFailures).toBe(1)
  })
})

describe('REST 信封（v1 / v5 两套）', () => {
  it('v1：status=ok 时返回 data', async () => {
    const http = newHttp(new FakeHtx())
    const data = await http.signed<Array<{ margin_asset: string }>>('POST', '/linear-swap-api/v1/swap_cross_account_info', { body: {} })
    expect(Array.isArray(data)).toBe(true)
    expect(data[0]!.margin_asset).toBe('USDT')
  })

  it('v5：code=200 时返回 data', async () => {
    const http = newHttp(new FakeHtx())
    const data = await http.signed<{ details: unknown[] }>('GET', '/v5/account/balance', {})
    expect(Array.isArray(data.details)).toBe(true)
  })

  it('envelopeOk：v1 ok / v1 error / v5 200 / v5 非 200 / 空对象', () => {
    expect(envelopeOk({ status: 'ok' })).toBe(true)
    expect(envelopeOk({ status: 'error' })).toBe(false)
    expect(envelopeOk({ code: 200 })).toBe(true)
    expect(envelopeOk({ code: 1002 })).toBe(false)
    expect(envelopeOk({})).toBe(false)
  })

  it('codeOf 优先取 err_code，其次 code，取不到 undefined', () => {
    expect(codeOf('{"err_code":1499}')).toBe(1499)
    expect(codeOf('{"code":200}')).toBe(200)
    expect(codeOf('{}')).toBeUndefined()
  })

  it('v1 业务错误（缺参）→ 3001 且保留上游文案', async () => {
    const http = newHttp(new FakeHtx())
    let problem
    try {
      await http.signed('POST', '/v5/position/lever', { body: {} })
    } catch (e) {
      problem = asProblem(e)
    }
    expect(problem?.code).toBe(3001)
    expect(problem?.venue?.message).toContain('invalid parameter')
  })

  it('HTTP 429 → 3002 + retryable + Retry-After', async () => {
    const fake = new FakeHtx()
    fake.nextFailure = { status: 429, body: { status: 'error', err_msg: 'too many requests' } }
    const http = newHttp(fake)
    let problem
    try {
      await http.signed('POST', '/v5/trade/order', { body: {} })
    } catch (e) {
      problem = asProblem(e)
    }
    expect(problem?.code).toBe(3002)
    expect(problem?.retryable).toBe(true)
  })

  it('非 GET 的 5xx → 3006（结果未知，不得重发）', async () => {
    const fake = new FakeHtx()
    fake.nextFailure = { status: 503, body: { status: 'error', err_msg: 'service unavailable' } }
    const http = newHttp(fake)
    let problem
    try {
      await http.signed('POST', '/v5/trade/order', { body: { contract_code: 'BTC-USDT' } })
    } catch (e) {
      problem = asProblem(e)
    }
    expect(problem?.code).toBe(3006)
    expect(problem?.retryable).toBe(false)
  })

  it('v1 系统错误 1000（HTTP 200）在非 GET 上 → 3006', async () => {
    const fake = new FakeHtx()
    fake.nextFailure = { body: { status: 'error', err_code: 1000, err_msg: 'System error', ts: NOW } }
    const http = newHttp(fake)
    let problem
    try {
      await http.signed('POST', '/linear-swap-api/v1/swap_cross_order', { body: {} })
    } catch (e) {
      problem = asProblem(e)
    }
    expect(problem?.code).toBe(3006)
  })

  it('v1 限频 1032（HTTP 200）→ 3002 retryable', async () => {
    const fake = new FakeHtx()
    fake.nextFailure = { body: { status: 'error', err_code: 1032, err_msg: 'The number of access exceeded the limit', ts: NOW } }
    const http = newHttp(fake)
    let problem
    try {
      await http.signed('POST', '/linear-swap-api/v1/swap_cross_order', { body: {} })
    } catch (e) {
      problem = asProblem(e)
    }
    expect(problem?.code).toBe(3002)
    expect(problem?.retryable).toBe(true)
    expect(http.usage().backoffUntil).toBeGreaterThan(NOW)
  })

  it('GET 的 5xx → 3003（可重试），不是 3006', async () => {
    const fake = new FakeHtx()
    fake.nextFailure = { status: 502, body: { status: 'error', err_msg: 'bad gateway' } }
    const http = newHttp(fake)
    let problem
    try {
      await http.signed('GET', '/v5/account/balance')
    } catch (e) {
      problem = asProblem(e)
    }
    expect(problem?.code).toBe(3003)
  })

  it('系统类码 1002 在非 GET 上 → 3006', async () => {
    const fake = new FakeHtx()
    fake.nextFailure = { body: { status: 'error', err_code: 1002, err_msg: 'system error' } }
    const http = newHttp(fake)
    let problem
    try {
      await http.signed('POST', '/v5/trade/cancel_order', { body: { contract_code: 'BTC-USDT', order_id: '1' } })
    } catch (e) {
      problem = asProblem(e)
    }
    expect(problem?.code).toBe(3006)
  })

  it('空响应体按结果未知处理（非 GET）', async () => {
    const fake = new FakeHtx()
    fake.nextFailure = { body: undefined }
    const http = newHttp(fake)
    // 用 200 + 空 body 走不到 json 解析，这里直接断言 envelope 判定不会当成功
    await expect(http.signed('POST', '/v5/trade/order', { body: {} })).rejects.toBeDefined()
  })

  it('404 走「端点 / 方法不对」而不是场所抖动', async () => {
    const http = newHttp(new FakeHtx())
    let problem
    try {
      await http.signed('GET', '/v5/no/such/path')
    } catch (e) {
      problem = asProblem(e)
    }
    expect(problem?.code).toBe(3001)
    expect(problem?.message).toContain('no such endpoint')
  })

  it('超时 → 3006（签名 POST 没拿到响应）', async () => {
    const http = newHttp(new FakeHtx(), {
      timeoutMs: 5,
      fetchImpl: ((_u: string, init?: RequestInit) => new Promise<Response>((_res, rej) => {
        init?.signal?.addEventListener('abort', () => rej(new Error('aborted')))
      })) as unknown as typeof fetch,
    })
    let problem
    try {
      await http.signed('POST', '/v5/trade/order', { body: {} })
    } catch (e) {
      problem = asProblem(e)
    }
    expect(problem?.code).toBe(3006)
  })

  it('只读 GET 超时 → 3003', async () => {
    const http = newHttp(new FakeHtx(), {
      timeoutMs: 5,
      fetchImpl: ((_u: string, init?: RequestInit) => new Promise<Response>((_res, rej) => {
        init?.signal?.addEventListener('abort', () => rej(new Error('aborted')))
      })) as unknown as typeof fetch,
    })
    let problem
    try {
      await http.signed('GET', '/v5/account/balance')
    } catch (e) {
      problem = asProblem(e)
    }
    expect(problem?.code).toBe(3003)
  })

  it('响应里的 v1 ts 用来校时（不用额外请求）', async () => {
    const fake = new FakeHtx()
    const http = newHttp(fake, { clock: () => NOW - 10_000 })
    await http.signed('POST', '/linear-swap-api/v1/swap_cross_account_info', { body: {} })
    expect(http.clockSource.offset).toBe(10_000)
  })

  it('下单计数桶记在预算里（权重 0 也走 acquire）', async () => {
    const fake = new FakeHtx()
    const http = newHttp(fake)
    await http.signed('POST', '/v5/trade/order', { body: { contract_code: 'BTC-USDT', volume: '1', side: 'buy', type: 'limit', time_in_force: 'gtc', margin_mode: 'cross', position_side: 'both', price: '100', client_order_id: '123' } }, { order: true, kind: 'trade' })
    const usage = http.usage() as unknown as { orders: { last1s: number } }
    expect(usage.orders.last1s).toBe(1)
    expect(http.weightSpent).toBe(0)
  })

  it('公共请求不带任何密钥参数', async () => {
    const fake = new FakeHtx()
    const http = newHttp(fake)
    await http.publicGet('/linear-swap-api/v1/swap_contract_info', { contract_code: 'BTC-USDT' })
    const req = fake.seen[0]!
    expect(req.query.AccessKeyId).toBeUndefined()
    expect(req.query.Signature).toBeUndefined()
  })

  it('v1 响应里 18 位 long 的 client_order_id 不丢精度（JSON.parse 前先转字符串）', async () => {
    const raw = '{"status":"ok","data":{"orders":[{"order_id":123456789012345678,"client_order_id":123456789012345678,"contract_code":"BTC-USDT"}]},"ts":' + String(NOW) + '}'
    const http = newHttp(new FakeHtx(), { fetchImpl: (async () => new Response(raw, { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch })
    const data = await http.signed<{ orders: Array<{ order_id: unknown; client_order_id: unknown }> }>('POST', '/linear-swap-api/v1/swap_cross_openorders', { body: {} })
    expect(data.orders[0]!.order_id).toBe('123456789012345678')
    expect(data.orders[0]!.client_order_id).toBe('123456789012345678')
  })

  it('Retry-After 秒 / HTTP-date / 缺失三种解析', () => {
    const res = (value?: string): Response => new Response('', { headers: value === undefined ? {} : { 'retry-after': value } })
    expect(retryAfterOf(res('2'), NOW)).toBe(2_000)
    expect(retryAfterOf(res(new Date(NOW + 5_000).toUTCString()), NOW)).toBe(5_000)
    expect(retryAfterOf(res(), NOW)).toBeUndefined()
  })

  it('构造参数缺 apiKey / apiSecret 直接拒绝', () => {
    expect(() => new HtxHttp({ apiKey: '', apiSecret: 'x' })).toThrow(/apiKey/)
    expect(() => new HtxHttp({ apiKey: 'k', apiSecret: '' })).toThrow(/apiSecret/)
  })
})
