// SPDX-License-Identifier: CPAL-1.0
// 联调：客户端 × 假 Discord 服务器（假服务器按官方规则独立校验，见 test/fake-discord.ts）。
// 这里断言的是「我们发出去的东西在官方规则下成立」，不是「客户端和假服务器互相认对方」。
import { describe, expect, it } from 'vitest'
import { DiscordWebhookClient } from '../src/client'
import { renderNotice } from '../src/format'
import { FakeDiscord } from './fake-discord'

const ID = '123456789012345678'
const TOKEN = 'fixture-webhook-token-0123456789'
const URL_OK = `https://discord.com/api/webhooks/${ID}/${TOKEN}`

function clientFor(fake: FakeDiscord, url = URL_OK): DiscordWebhookClient {
  return new DiscordWebhookClient({ url, fetchImpl: fake.fetch, maxRetries: 1, timeoutMs: 2000 })
}

describe('客户端 × 假服务器：成功路径', () => {
  it('一条消息：wait=true、JSON、User-Agent，ref 是服务端返回的 message id', async () => {
    const fake = new FakeDiscord()
    const result = await clientFor(fake).sendContent('**[WARN]** Risk denial\naccount acct_x')
    expect(result.ok).toBe(true)
    expect(result).toEqual({ ok: true, ref: '1300000000000000000' })
    expect(fake.requests).toHaveLength(1)
    const request = fake.requests[0]!
    expect(request.wait).toBe('true')
    expect(request.method).toBe('POST')
    expect(request.contentType).toBe('application/json')
    expect(request.userAgent).toMatch(/^DiscordBot \(.+\)$/)
  })

  it('通知模板出来的文本能被官方规则接受，且长度不超过 2000', async () => {
    const fake = new FakeDiscord()
    const text = renderNotice({
      title: 'Risk denial',
      lines: ['account acct_x', 'rule Y', 'notional 1200 > limit 1000'],
      ts: 1760000000000,
      level: 'warn',
    })
    expect(text.length).toBeLessThanOrEqual(2000)
    const result = await clientFor(fake).sendText(text)
    expect(result.ok).toBe(true)
    expect(fake.requests).toHaveLength(1)
    expect(fake.requests[0]?.body?.content).toBe(text)
  })

  it('threadId 通过 thread_id 查询参数传到服务端', async () => {
    const fake = new FakeDiscord()
    await clientFor(fake).sendContent('x', { threadId: '987654321098765432' })
    expect(fake.requests[0]?.threadId).toBe('987654321098765432')
  })

  it('2000 字符边界：单条正好 2000 通过；2001 由客户端拒绝且不发请求', async () => {
    const fake = new FakeDiscord()
    const client = clientFor(fake)
    expect((await client.sendContent('x'.repeat(2000))).ok).toBe(true)
    expect(await client.sendContent('x'.repeat(2001))).toMatchObject({ ok: false, retryable: false })
    expect(fake.requests).toHaveLength(1)
  })

  it('超长正文分块发送，每个请求单独都被官方规则接受', async () => {
    const fake = new FakeDiscord()
    const result = await clientFor(fake).sendText(Array.from({ length: 300 }, (_, i) => `line ${i} ${'y'.repeat(20)}`).join('\n'))
    expect(result.ok).toBe(true)
    expect(fake.requests.length).toBeGreaterThan(1)
    for (const request of fake.requests) expect(String(request.body?.content ?? '').length).toBeLessThanOrEqual(2000)
  })
})

describe('客户端 × 假服务器：提及不触发', () => {
  it('正文含 @everyone 与 <@id> 时，按官方 allowed_mentions 语义算出的提及为空', async () => {
    const fake = new FakeDiscord()
    const result = await clientFor(fake).sendContent('@everyone <@80351110224678912> <@&165511591545143296>')
    expect(result.ok).toBe(true)
    expect(fake.pings).toEqual([])
  })

  it('反证对照：同一段文本把 parse 打开，假服务器就会记到 everyone / user / role（证明这项校验有区分力）', async () => {
    const fake = new FakeDiscord()
    await fake.fetch(`${URL_OK}?wait=true`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content: '@everyone <@80351110224678912> <@&165511591545143296>',
        allowed_mentions: { parse: ['everyone', 'users', 'roles'] },
      }),
    })
    expect(fake.pings).toEqual(['everyone', 'user', 'role'])
  })

  it('缺省 allowed_mentions 时假服务器也按「全部允许」判定（默认值符合官方说明）', async () => {
    const fake = new FakeDiscord()
    await fake.fetch(`${URL_OK}?wait=true`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '@here' }),
    })
    expect(fake.pings).toEqual(['everyone'])
  })
})

describe('客户端 × 假服务器：失败与限流', () => {
  it('token 错 → 401 / 50027，不重试，reason 不含 token', async () => {
    const fake = new FakeDiscord()
    const client = clientFor(fake, `https://discord.com/api/webhooks/${ID}/wrong-token-000000000000`)
    const result = await client.sendContent('x')
    expect(result).toMatchObject({ ok: false, retryable: false })
    const reason = result.ok === false ? result.reason : ''
    expect(reason).toContain('50027')
    expect(reason).not.toContain('wrong-token-000000000000')
    expect(fake.requests).toHaveLength(1)
  })

  it('webhook id 不存在 → 404 / 10015，不重试', async () => {
    const fake = new FakeDiscord()
    const client = clientFor(fake, `https://discord.com/api/webhooks/999999999999999999/${TOKEN}`)
    const result = await client.sendContent('x')
    expect(result).toMatchObject({ ok: false, retryable: false })
    expect(result.ok === false && result.reason).toContain('10015')
  })

  it('429（官方 retry_after 0.05 秒）→ 等 50 ms 后重发成功，共两条请求', async () => {
    const fake = new FakeDiscord({ rateLimitFirst: 1, retryAfterSec: 0.05 })
    const result = await clientFor(fake).sendContent('x')
    expect(result).toEqual({ ok: true, ref: '1300000000000000000' })
    expect(fake.requests).toHaveLength(2)
  })

  it('脚本化两次 500 → retryable，reason 带 http_500', async () => {
    const fake = new FakeDiscord({
      script: [
        { status: 500, body: { message: 'Internal Server Error', code: 0 } },
        { status: 500, body: { message: 'Internal Server Error', code: 0 } },
      ],
    })
    const result = await clientFor(fake).sendContent('x')
    expect(result).toMatchObject({ ok: false, retryable: true })
    expect(result.ok === false && result.reason).toContain('http_500')
    expect(fake.requests).toHaveLength(2)
  })

  it('假服务器不接受非 JSON Content-Type 的请求（说明它真的在校验官方规则）', async () => {
    const fake = new FakeDiscord()
    const response = await fake.fetch(`${URL_OK}?wait=true`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({ content: 'x' }),
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ code: 50035 })
  })

  it('假服务器对超过 2000 字符的 content 回 400 / 50035（客户端之外的独立第二道判定）', async () => {
    const fake = new FakeDiscord()
    const response = await fake.fetch(`${URL_OK}?wait=true`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'x'.repeat(2001) }),
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ message: 'Invalid Form Body', code: 50035 })
  })
})
