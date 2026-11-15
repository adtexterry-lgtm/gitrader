// SPDX-License-Identifier: CPAL-1.0
import { describe, expect, it } from 'vitest'
import { WebhookClient, isSecureWebhookUrl, webhookUrlKind } from '../src/index'
import { hangingFetch, scriptedFetch } from './helpers/fake-http'

const SLACK_URL = 'https://hooks.slack.com/services/T000/B000/xxxx'
const FEISHU_URL = 'https://open.feishu.cn/open-apis/bot/v2/hook/aaaa'
const FEISHU_SECRET = 'feishu-test-secret'
const FEISHU_SIGN_1700000000 = 'e3MJ8Q5llVxGJ8pVkGPBhexDAgjvYqpjPP1GkY9XceI='

const noWait = (): Promise<void> => Promise.resolve()

describe('WebhookClient', () => {
  it('成功：POST 到端点，返回 ok 与状态码', async () => {
    const fake = scriptedFetch([{ status: 200, body: 'ok' }])
    const client = new WebhookClient({ url: SLACK_URL, fetch: fake.fetchImpl, sleep: noWait })
    const result = await client.send('BTC 0.3%', { title: '资金费率告警' })
    expect(result).toEqual({ ok: true, status: 200 })
    expect(fake.calls).toHaveLength(1)
    const call = fake.calls[0]
    expect(call?.method).toBe('POST')
    expect(call?.url).toBe(SLACK_URL)
    expect(JSON.parse(call?.body ?? '{}')).toEqual({ text: '*资金费率告警*\nBTC 0.3%' })
    expect(client.getDialect()).toBe('slack')
  })

  it('429 之后按退避重试成功', async () => {
    const waits: number[] = []
    const fake = scriptedFetch([{ status: 429, body: 'slow down' }, { status: 200, body: 'ok' }])
    const client = new WebhookClient({
      url: SLACK_URL, fetch: fake.fetchImpl, maxRetries: 2, backoffBaseMs: 250,
      sleep: (ms) => { waits.push(ms); return Promise.resolve() },
    })
    const result = await client.send('x')
    expect(result).toEqual({ ok: true, status: 200 })
    expect(waits).toEqual([250])
    expect(fake.calls).toHaveLength(2)
  })

  it('5xx 重试到上限后失败且标 retryable，退避指数增长', async () => {
    const waits: number[] = []
    const fake = scriptedFetch([
      { status: 503, body: '{"msg":"upstream unavailable"}' },
      { status: 502, body: '' },
      { status: 500, body: '' },
    ])
    const client = new WebhookClient({
      url: SLACK_URL, fetch: fake.fetchImpl, maxRetries: 2, backoffBaseMs: 100, maxBackoffMs: 150,
      sleep: (ms) => { waits.push(ms); return Promise.resolve() },
    })
    const result = await client.send('x')
    expect(result).toEqual({ ok: false, reason: 'http_500', retryable: true })
    expect(waits).toEqual([100, 150])
    expect(fake.calls).toHaveLength(3)
  })

  it('业务错误（厂商非 0 码）不重试', async () => {
    const fake = scriptedFetch([{ status: 200, body: '{"code":19021,"msg":"sign match fail"}' }])
    const client = new WebhookClient({ url: FEISHU_URL, secret: FEISHU_SECRET, fetch: fake.fetchImpl, maxRetries: 3, sleep: noWait })
    const result = await client.send('x')
    expect(result).toEqual({ ok: false, reason: 'feishu_error:code=19021:sign match fail', retryable: false })
    expect(fake.calls).toHaveLength(1)
  })

  it('超时：reason 为 timeout 且 retryable', async () => {
    const fake = hangingFetch()
    const waits: number[] = []
    const client = new WebhookClient({
      url: SLACK_URL, fetch: fake.fetchImpl, timeoutMs: 20, maxRetries: 1,
      sleep: (ms) => { waits.push(ms); return Promise.resolve() },
    })
    const started = Date.now()
    const result = await client.send('x')
    expect(result).toEqual({ ok: false, reason: 'timeout', retryable: true })
    expect(waits).toHaveLength(1)
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('网络错误：折算成 network_error 并重试，reason 不含密钥与其 base64', async () => {
    const encoded = Buffer.from(FEISHU_SECRET, 'utf8').toString('base64')
    const boom = (): Promise<Response> => Promise.reject(new Error(`connect refused sign=${FEISHU_SECRET} b64=${encoded}`))
    const client = new WebhookClient({
      url: FEISHU_URL, secret: FEISHU_SECRET, fetch: boom as unknown as typeof fetch, maxRetries: 0, sleep: noWait,
    })
    const result = await client.send('x')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.retryable).toBe(true)
    expect(result.reason.startsWith('network_error:')).toBe(true)
    expect(result.reason).not.toContain(FEISHU_SECRET)
    expect(result.reason).not.toContain(encoded)
    expect(result.reason).toContain('<redacted>')
  })

  it('厂商错误文本里的密钥同样脱敏', async () => {
    const fake = scriptedFetch([{ status: 200, body: JSON.stringify({ code: 19021, msg: `bad sign for ${FEISHU_SECRET}` }) }])
    const client = new WebhookClient({ url: FEISHU_URL, secret: FEISHU_SECRET, fetch: fake.fetchImpl, sleep: noWait })
    const result = await client.send('x')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('feishu_error:code=19021:bad sign for <redacted>')
  })

  it('网络错误里的 URL 只留 origin + 路径第一段：query 与 access_token 不出现', async () => {
    const url = 'https://oapi.dingtalk.com/robot/send?access_token=XYZ'
    const boom = (): Promise<Response> => Promise.reject(new Error(`request failed for ${url}`))
    const client = new WebhookClient({
      url, fetch: boom as unknown as typeof fetch, maxRetries: 0, sleep: noWait,
    })
    const result = await client.send('x')
    expect(result).toEqual({ ok: false, reason: 'network_error:request failed for https://oapi.dingtalk.com/robot', retryable: true })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).not.toContain('XYZ')
    expect(result.reason).not.toContain('?')
    expect(result.reason).not.toContain('access_token')
  })

  it('签名时间戳取自注入的时钟', async () => {
    const fake = scriptedFetch([{ status: 200, body: '{"code":0}' }])
    const client = new WebhookClient({
      url: FEISHU_URL, secret: FEISHU_SECRET, fetch: fake.fetchImpl, sleep: noWait, clock: () => 1700000000000,
    })
    await client.send('BTC 0.3%')
    const body = JSON.parse(fake.calls[0]?.body ?? '{}') as { timestamp?: string; sign?: string }
    expect(body.timestamp).toBe('1700000000')
    expect(body.sign).toBe(FEISHU_SIGN_1700000000)
  })

  it('空文本不发请求', async () => {
    const fake = scriptedFetch([])
    const client = new WebhookClient({ url: SLACK_URL, fetch: fake.fetchImpl, sleep: noWait })
    expect(await client.send('   ')).toEqual({ ok: false, reason: 'empty_text', retryable: false })
    expect(fake.calls).toHaveLength(0)
  })

  it('缺 url 时构造直接报错', () => {
    expect(() => new WebhookClient({ url: '  ' })).toThrow(/url is required/)
  })

  it('明文 http 非回环目标构造期即拒（不出网、不拼签名）', () => {
    for (const url of [
      'http://hooks.slack.com/services/T/B/x',
      'http://example.test/x',
      'http://169.254.169.254/',
      'http://10.0.0.1/x',
      'http://127.0.0.1.example.test/x',
    ]) {
      expect(() => new WebhookClient({ url })).toThrow(/must use https/)
    }
    expect(isSecureWebhookUrl('http://hooks.slack.com/services/T/B/x')).toBe(false)
    expect(webhookUrlKind('http://hooks.slack.com/services/T/B/x')).toBe('insecure')
    expect(webhookUrlKind('https://hooks.slack.com/services/T/B/x')).toBe('https')
    expect(webhookUrlKind('ftp://example.com/x')).toBe('invalid')
    expect(webhookUrlKind('not-a-url')).toBe('invalid')
  })

  it('明文 http 发往字面回环主机放行（loopback 例外）：127.0.0.1 / localhost / [::1] 都构造成功', async () => {
    for (const url of ['http://127.0.0.1:8787/hook', 'http://localhost/x', 'http://[::1]/x']) {
      expect(webhookUrlKind(url), url).toBe('loopback')
      expect(isSecureWebhookUrl(url), url).toBe(true)
      const fake = scriptedFetch([{ status: 200, body: 'ok' }])
      const client = new WebhookClient({ url, fetch: fake.fetchImpl, sleep: noWait })
      expect(await client.send('x')).toEqual({ ok: true, status: 200 })
      expect(fake.calls).toHaveLength(1)
    }
  })
})
