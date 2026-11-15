// SPDX-License-Identifier: CPAL-1.0
// 脱敏：webhook URL / token 塞进错误文本与平台回显，断言输出里一个都不出现。
import { describe, expect, it } from 'vitest'
// @ts-expect-error 纯 JS 插件，没有类型声明
import { handleNotifySend } from '../index.mjs'
// @ts-expect-error 纯 JS 插件，没有类型声明
import { DiscordWebhookClient, redactSecrets, redactWebhookUrl } from '../discord.mjs'
import { FakeDiscordServer } from './fake-server'

const fake = new FakeDiscordServer()
const NOTICE = { key: 'k', level: 'critical', title: 'Risk denial', lines: ['rule Y'] }
const ARGS = { notice: NOTICE, params: {} }

function leaks(text: string): string[] {
  const found: string[] = []
  for (const secret of [fake.token, fake.url, Buffer.from(fake.url).toString('base64')]) if (text.includes(secret)) found.push(secret)
  return found
}

describe('脱敏', () => {
  it('redactWebhookUrl 保留 id、隐藏 token', () => {
    expect(redactWebhookUrl(fake.url)).toBe(`https://discord.com/api/webhooks/${fake.id}/<redacted>`)
    expect(redactWebhookUrl('nonsense')).toBe('<invalid webhook url>')
  })

  it('redactSecrets 同时抹掉 token 与整条 URL，并压成一行', () => {
    const out = redactSecrets(`a=${fake.url} b=${fake.token}\nline2`, [fake.token, fake.url])
    expect(leaks(out)).toEqual([])
    expect(out).toContain('<redacted>')
    expect(out).not.toContain('\n')
  })

  it('假 fetch 抛错带 URL 与 token 时，reason 里都没有', async () => {
    const fetchImpl = async () => {
      throw new Error(`connect failed for ${fake.url} token=${fake.token}`)
    }
    const result = await handleNotifySend(ARGS, { webhookUrl: fake.url, fetchImpl })
    expect(result.ok).toBe(false)
    expect(result.retryable).toBe(true)
    expect(leaks(result.reason)).toEqual([])
    expect(result.reason).toContain('<redacted>')
  })

  it('平台把 URL 回显在错误 message 里也不漏', async () => {
    const fetchImpl = async () =>
      fake.json({ message: `Invalid Webhook Token for ${fake.url} token ${fake.token}`, code: 50027 }, 401)
    const result = await handleNotifySend(ARGS, { webhookUrl: fake.url, fetchImpl })
    expect(result).toMatchObject({ ok: false, retryable: false })
    expect(leaks(result.reason)).toEqual([])
    expect(result.reason).toContain('Invalid Webhook Token')
  })

  it('reason 压成一行短句（无换行、不超上限）', async () => {
    const fetchImpl = async () => fake.json({ message: `line1\nline2\n\t${'z'.repeat(500)}`, code: 0 }, 400)
    const result = await handleNotifySend(ARGS, { webhookUrl: fake.url, fetchImpl })
    expect(result.reason).not.toContain('\n')
    expect(result.reason.length).toBeLessThanOrEqual(301)
  })

  it('构造后 JSON.stringify / Object.keys 不含 token 与完整 URL', () => {
    const client = new DiscordWebhookClient({ url: fake.url })
    const exposed = `${JSON.stringify(client)}|${Object.keys(client).join(',')}`
    for (const secret of [fake.token, fake.url, `/api/webhooks/${fake.id}/${fake.token}`]) expect(exposed).not.toContain(secret)
    expect(Object.keys(client)).not.toContain('target')
  })
})
