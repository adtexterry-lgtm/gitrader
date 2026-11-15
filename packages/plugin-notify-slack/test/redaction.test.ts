// SPDX-License-Identifier: CPAL-1.0
// 脱敏：webhook URL / path / 路径段都不能出现在 reason 里（URL 本身即凭据）。
import { describe, expect, it } from 'vitest'
// @ts-expect-error 纯 JS 插件，没有类型声明
import { handleNotifySend } from '../index.mjs'
// @ts-expect-error 纯 JS 插件，没有类型声明
import { SlackClient, redactWebhookUrl } from '../slack.mjs'

const WEBHOOK = 'https://hooks.slack.com/services/T11111111/B22222222/verySecretWebhookToken'
const SEGMENTS = ['T11111111', 'B22222222', 'verySecretWebhookToken']
const NOTICE = { key: 'k', level: 'critical', title: 'Risk denial', lines: ['rule Y'] }
const ARGS = { notice: NOTICE, params: {} }

function leaks(text: string): string[] {
  return [WEBHOOK, ...SEGMENTS].filter((secret) => text.includes(secret))
}

describe('脱敏（webhook URL 即凭据）', () => {
  it('redactWebhookUrl 覆盖整串、path 与各路径段', () => {
    const text = redactWebhookUrl(`POST ${WEBHOOK} path /services/T11111111/B22222222/verySecretWebhookToken seg verySecretWebhookToken`, WEBHOOK)
    expect(leaks(text)).toEqual([])
    expect(text).toContain('<redacted>')
    expect(text).not.toContain('\n')
  })

  it('网络错误里带 webhook URL 也不漏', async () => {
    const fetchImpl = async () => {
      throw new Error(`connect ECONNREFUSED ${WEBHOOK} (${SEGMENTS[2]})`)
    }
    const result = await handleNotifySend(ARGS, { webhookUrl: WEBHOOK, fetchImpl, sleepImpl: async () => {} })
    expect(result.ok).toBe(false)
    expect(result.retryable).toBe(true)
    expect(leaks(result.reason)).toEqual([])
  })

  it('平台把 URL 回显在错误 body 里也不漏', async () => {
    const fetchImpl = async () => ({
      ok: false,
      status: 400,
      headers: new Headers(),
      text: async () => `invalid_payload ${WEBHOOK}`,
    })
    const result = await handleNotifySend(ARGS, { webhookUrl: WEBHOOK, fetchImpl, sleepImpl: async () => {} })
    expect(result).toMatchObject({ ok: false, retryable: false })
    expect(leaks(result.reason)).toEqual([])
    expect(result.reason).toContain('invalid_payload')
  })

  it('reason 压成一行短句（不带换行、不超过上限）', async () => {
    const fetchImpl = async () => ({
      ok: false,
      status: 400,
      headers: new Headers(),
      text: async () => `line1\nline2\n\t${'z'.repeat(400)}`,
    })
    const result = await handleNotifySend(ARGS, { webhookUrl: WEBHOOK, fetchImpl, sleepImpl: async () => {} })
    expect(result.reason).not.toContain('\n')
    expect(result.reason.length).toBeLessThanOrEqual(201)
    expect(redactWebhookUrl('a\nb\tc', '')).toBe('a b c')
  })

  it('构造后 JSON.stringify / Object.keys 不含 webhook URL 与路径段', () => {
    const client = new SlackClient({ webhookUrl: WEBHOOK })
    const exposed = `${JSON.stringify(client)}|${Object.keys(client).join(',')}`
    for (const secret of [WEBHOOK, ...SEGMENTS]) expect(exposed).not.toContain(secret)
    expect(Object.keys(client)).not.toContain('webhookUrl')
  })
})
