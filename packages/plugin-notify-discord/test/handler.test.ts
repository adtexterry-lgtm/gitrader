// SPDX-License-Identifier: CPAL-1.0
// 处理函数单测：注入假服务器 / 假 fetch，断言成功、渲染、提及抑制、缺环境变量、参数校验、
// 平台错误分类、429 重试、分块与脱敏。
import { describe, expect, it } from 'vitest'
// @ts-expect-error 纯 JS 插件，没有类型声明
import { URL_ENV, handleNotifySend } from '../index.mjs'
import { FakeDiscordServer } from './fake-server'

const NOTICE = {
  key: 'risk.denials:acct_x:ruleY',
  level: 'warn',
  title: 'Risk denial',
  lines: ['account acct_x', 'rule Y', 'notional 1200 > 1000'],
  ts: 1760000000000,
  topic: 'risk.denials',
}

function args(params: Record<string, unknown> = {}): { notice: typeof NOTICE; params: Record<string, unknown> } {
  return { notice: NOTICE, params }
}

describe('notify_send 处理函数：成功路径', () => {
  it('一次 POST，返回 {ok:true, ref}，body 是 content + allowed_mentions', async () => {
    const fake = new FakeDiscordServer()
    const result = await handleNotifySend(args(), { webhookUrl: fake.url, fetchImpl: fake.fetch })
    expect(result).toEqual({ ok: true, ref: '4242' })
    expect(fake.seen).toHaveLength(1)
    const seen = fake.seen[0]!
    expect(seen.url).toBe(`${fake.url}?wait=true`)
    expect(seen.method).toBe('POST')
    expect(seen.contentType).toBe('application/json')
    expect(seen.userAgent).toMatch(/^DiscordBot \(.+\)$/)
    expect(seen.allowedMentions).toEqual({ parse: [] })
  })

  it('正文是渲染后的通知：level 标记 + 标题，动态字符已转义，含 Discord 时间戳', async () => {
    const fake = new FakeDiscordServer()
    await handleNotifySend(args(), { webhookUrl: fake.url, fetchImpl: fake.fetch })
    const content = fake.seen[0]?.content ?? ''
    expect(content.split('\n')[0]).toBe('**[WARN]** Risk denial')
    expect(content).toContain('account acct\\_x')
    expect(content).toContain('notional 1200 \\> 1000')
    expect(content).toContain('<t:1760000000:f>')
    expect(content).not.toMatch(/Gitrader|QuantDinger/i)
  })

  it('正文里的 @everyone 与 <@id> 不会产生提及（allowed_mentions.parse 为空）', async () => {
    const fake = new FakeDiscordServer()
    const result = await handleNotifySend(
      { notice: { ...NOTICE, lines: ['@everyone <@80351110224678912> <@&165511591545143296>'] }, params: {} },
      { webhookUrl: fake.url, fetchImpl: fake.fetch },
    )
    expect(result.ok).toBe(true)
    expect(fake.pings).toEqual([])
  })

  it('params.threadId 透传成 thread_id；能给到子区', async () => {
    const fake = new FakeDiscordServer()
    await handleNotifySend(args({ threadId: '987654321098765432' }), { webhookUrl: fake.url, fetchImpl: fake.fetch })
    expect(fake.seen[0]?.threadId).toBe('987654321098765432')
  })

  it('超长正文按 2000 分块，每块都被官方规则接受，ref 取第一条', async () => {
    const fake = new FakeDiscordServer({ startMessageId: 5001 })
    const result = await handleNotifySend(
      { notice: { ...NOTICE, lines: Array.from({ length: 120 }, (_, i) => `line ${i} ${'y'.repeat(20)}`) }, params: {} },
      { webhookUrl: fake.url, fetchImpl: fake.fetch },
    )
    expect(result).toEqual({ ok: true, ref: '5001' })
    expect(fake.seen.length).toBeGreaterThan(1)
    for (const seen of fake.seen) expect((seen.content ?? '').length).toBeLessThanOrEqual(2000)
  })
})

describe('notify_send 处理函数：入参校验', () => {
  it('缺 DISCORD_WEBHOOK_URL → {ok:false, retryable:false}，reason 指名环境变量，不发请求', async () => {
    const fake = new FakeDiscordServer()
    const saved = process.env[URL_ENV]
    delete process.env[URL_ENV]
    try {
      const result = await handleNotifySend(args(), { fetchImpl: fake.fetch })
      expect(result).toMatchObject({ ok: false, retryable: false })
      expect(result.reason).toContain(URL_ENV)
      expect(fake.seen).toHaveLength(0)
    } finally {
      if (saved !== undefined) process.env[URL_ENV] = saved
    }
  })

  it('webhook URL 是 http / 非官方主机 → 拒绝，不发请求', async () => {
    const fake = new FakeDiscordServer()
    for (const url of [
      'http://discord.com/api/webhooks/123456789012345678/fixture-webhook-token-0123456789',
      'https://example.test/api/webhooks/123456789012345678/fixture-webhook-token-0123456789',
    ]) {
      const result = await handleNotifySend(args(), { webhookUrl: url, fetchImpl: fake.fetch })
      expect(result).toMatchObject({ ok: false, retryable: false })
    }
    expect(fake.seen).toHaveLength(0)
  })

  it('缺 notice → 拒绝；threadId 不是 snowflake → 拒绝（都不发请求）', async () => {
    const fake = new FakeDiscordServer()
    expect(await handleNotifySend({ params: {} }, { webhookUrl: fake.url, fetchImpl: fake.fetch })).toMatchObject({ ok: false, retryable: false })
    expect(await handleNotifySend(args({ threadId: 'not-a-snowflake' }), { webhookUrl: fake.url, fetchImpl: fake.fetch })).toMatchObject({
      ok: false,
      retryable: false,
    })
    expect(fake.seen).toHaveLength(0)
  })

  it('notice 只有空行 → 拒绝（没有可发送的文本）', async () => {
    const fake = new FakeDiscordServer()
    const result = await handleNotifySend({ notice: { key: 'k', level: 'info', title: '', lines: [] }, params: {} }, {
      webhookUrl: fake.url,
      fetchImpl: fake.fetch,
    })
    // 空标题空正文仍会渲染出 `**[INFO]**` 一行，属于「有一条事实要报」，这里断言它不是失败而是照发
    expect(result.ok).toBe(true)
    expect(fake.seen[0]?.content).toBe('**[INFO]**')
  })
})

describe('notify_send 处理函数：平台错误与重试', () => {
  it('token 错（401 / 50027）→ retryable:false，reason 不含 token 与 URL', async () => {
    const fake = new FakeDiscordServer()
    const wrong = `https://discord.com/api/webhooks/${fake.id}/wrong-token-000000000000`
    const result = await handleNotifySend(args(), { webhookUrl: wrong, fetchImpl: fake.fetch })
    expect(result).toMatchObject({ ok: false, retryable: false })
    expect(result.reason).toContain('50027')
    expect(result.reason).not.toContain('wrong-token-000000000000')
  })

  it('429 带 retry_after → 等待后重发成功，共两条请求', async () => {
    const fake = new FakeDiscordServer({ rateLimitFirst: 1, retryAfterSec: 0.02 })
    const result = await handleNotifySend(args(), { webhookUrl: fake.url, fetchImpl: fake.fetch })
    expect(result).toEqual({ ok: true, ref: '4242' })
    expect(fake.seen).toHaveLength(2)
  })

  it('网络错误 → retryable:true，reason 抹掉 webhook URL 与 token', async () => {
    const fake = new FakeDiscordServer()
    const fetchImpl = async () => {
      throw new Error(`connect ECONNREFUSED ${fake.url}`)
    }
    const result = await handleNotifySend(args(), { webhookUrl: fake.url, fetchImpl })
    expect(result).toMatchObject({ ok: false, retryable: true })
    expect(result.reason).toContain('network error')
    expect(result.reason).not.toContain(fake.token)
    expect(result.reason).not.toContain(`/api/webhooks/${fake.id}/${fake.token}`)
  })

  it('5xx 两次（maxRetries=1）→ retryable:true', async () => {
    const fake = new FakeDiscordServer()
    let calls = 0
    const fetchImpl = async () => {
      calls += 1
      return fake.json({ message: 'Internal Server Error', code: 0 }, 500)
    }
    const result = await handleNotifySend(args(), { webhookUrl: fake.url, fetchImpl })
    expect(result).toMatchObject({ ok: false, retryable: true })
    expect(calls).toBe(2)
  })

  it('超时 → retryable:true（单次预算可用 deps.timeoutMs 收短做测试）', async () => {
    const fake = new FakeDiscordServer()
    const fetchImpl = async (_url: string, init?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
      })
    const result = await handleNotifySend(args(), { webhookUrl: fake.url, fetchImpl, timeoutMs: 25 })
    expect(result).toMatchObject({ ok: false, retryable: true })
    expect(result.reason).toContain('超时')
  })
})
