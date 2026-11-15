// SPDX-License-Identifier: CPAL-1.0
// 联调：插件处理函数 × 假服务器（按官方规则独立校验）。断言「发出去的东西在官方规则下成立」。
import { describe, expect, it } from 'vitest'
// @ts-expect-error 纯 JS 插件，没有类型声明
import { handleNotifySend } from '../index.mjs'
import { FakeDiscordServer } from './fake-server'

const NOTICE = { key: 'risk.denials:acct_x', level: 'critical', title: 'Risk denial', lines: ['account acct_x', 'quantity 2 price 100'] }

describe('插件 × 假服务器：请求合法性', () => {
  it('正常发送：一条请求、wait=true、application/json、官方形状的 User-Agent', async () => {
    const fake = new FakeDiscordServer()
    const result = await handleNotifySend({ notice: NOTICE, params: {} }, { webhookUrl: fake.url, fetchImpl: fake.fetch })
    expect(result).toEqual({ ok: true, ref: '4242' })
    expect(fake.seen).toHaveLength(1)
    expect(fake.seen[0]?.wait).toBe('true')
    expect(fake.seen[0]?.contentType).toBe('application/json')
    expect(fake.seen[0]?.userAgent).toMatch(/^DiscordBot \(.+\)$/)
  })

  it('正文正好 2000 字符能发出去（官方上限边界）', async () => {
    const fake = new FakeDiscordServer()
    const lines = ['z'.repeat(1990)]
    const result = await handleNotifySend({ notice: { ...NOTICE, title: 't', lines, ts: undefined }, params: {} }, { webhookUrl: fake.url, fetchImpl: fake.fetch })
    expect(result.ok).toBe(true)
    expect((fake.seen[0]?.content ?? '').length).toBeLessThanOrEqual(2000)
  })

  it('假服务器确实在按官方规则判定：直接发超 2000 字符 → 400 / 50035', async () => {
    const fake = new FakeDiscordServer()
    const response = await fake.fetch(`${fake.url}?wait=true`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'x'.repeat(2001), allowed_mentions: { parse: [] } }),
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ message: 'Invalid Form Body', code: 50035 })
  })

  it('假服务器确实在校验提及：parse 打开时同一段文本会被记成提及（反证）', async () => {
    const fake = new FakeDiscordServer()
    await fake.fetch(`${fake.url}?wait=true`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '@everyone <@80351110224678912>', allowed_mentions: { parse: ['everyone', 'users'] } }),
    })
    expect(fake.pings).toEqual(['everyone', 'user'])
  })

  it('插件发出的同一段文本，提及为空（allowed_mentions.parse 为空数组）', async () => {
    const fake = new FakeDiscordServer()
    await handleNotifySend(
      { notice: { ...NOTICE, lines: ['@everyone <@80351110224678912>'] }, params: {} },
      { webhookUrl: fake.url, fetchImpl: fake.fetch },
    )
    expect(fake.pings).toEqual([])
  })
})

describe('插件 × 假服务器：失败分类', () => {
  it('token 错 → 401 / 50027，不重试', async () => {
    const fake = new FakeDiscordServer()
    const result = await handleNotifySend({ notice: NOTICE, params: {} }, {
      webhookUrl: `https://discord.com/api/webhooks/${fake.id}/wrong-token-000000000000`,
      fetchImpl: fake.fetch,
    })
    expect(result).toMatchObject({ ok: false, retryable: false })
    expect(result.reason).toContain('50027')
    expect(fake.seen).toHaveLength(1)
  })

  it('webhook id 不存在 → 404 / 10015，不重试', async () => {
    const fake = new FakeDiscordServer()
    const result = await handleNotifySend({ notice: NOTICE, params: {} }, {
      webhookUrl: `https://discord.com/api/webhooks/999999999999999999/${fake.token}`,
      fetchImpl: fake.fetch,
    })
    expect(result).toMatchObject({ ok: false, retryable: false })
    expect(result.reason).toContain('10015')
  })

  it('429 一次后成功：假服务器按官方结构回 retry_after，插件等完重发', async () => {
    const fake = new FakeDiscordServer({ rateLimitFirst: 1, retryAfterSec: 0.02 })
    const result = await handleNotifySend({ notice: NOTICE, params: {} }, { webhookUrl: fake.url, fetchImpl: fake.fetch })
    expect(result.ok).toBe(true)
    expect(fake.seen).toHaveLength(2)
  })

  it('分块发送的每一块都被官方规则接受（2000 上限不会被越过）', async () => {
    const fake = new FakeDiscordServer()
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i} ${'q'.repeat(24)}`)
    const result = await handleNotifySend({ notice: { ...NOTICE, lines }, params: {} }, { webhookUrl: fake.url, fetchImpl: fake.fetch })
    expect(result.ok).toBe(true)
    expect(fake.seen.length).toBeGreaterThan(1)
    for (const seen of fake.seen) expect((seen.content ?? '').length).toBeLessThanOrEqual(2000)
  })
})
