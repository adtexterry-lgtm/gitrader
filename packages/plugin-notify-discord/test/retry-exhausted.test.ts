// SPDX-License-Identifier: CPAL-1.0
// R2-REL-03（集成项）：Discord 插件自己重试（maxRetries=1，最多 2 次 HTTP 尝试）；重试到头的可重试失败标 exhausted:true，内核据此不再叠一层重试。
import { describe, expect, it } from 'vitest'
// @ts-expect-error 纯 JS 插件，没有类型声明
import { markExhausted, notifySendTool } from '../gsp.mjs'
import { FakeDiscordServer } from './fake-server'

const ARGS = { notice: { key: 'takeover:tk_1', level: 'critical', title: 'Takeover', lines: ['takeoverId: tk_1'], ts: 1760000000000, topic: 'takeover.alert' }, params: {} }

describe('Discord notify_send 工具：重试到头 → exhausted', () => {
  it('500 一直不好：恰好 2 次 HTTP 请求（不多于 3），结果 retryable 且 exhausted:true', async () => {
    const fake = new FakeDiscordServer()
    let calls = 0
    const fetchImpl = async () => { calls += 1; return fake.json({ message: 'Internal Server Error', code: 0 }, 500) }
    const result = await notifySendTool(ARGS, { webhookUrl: fake.url, fetchImpl })
    expect(calls).toBe(2)
    expect(result).toMatchObject({ ok: false, retryable: true, exhausted: true })
  })

  it('不可重试的失败（401）：1 次请求，不带 exhausted；成功结果原样', async () => {
    const fake = new FakeDiscordServer()
    let calls = 0
    const fetchImpl = async () => { calls += 1; return fake.json({ message: 'Invalid Webhook Token', code: 50027 }, 401) }
    const result = await notifySendTool(ARGS, { webhookUrl: fake.url, fetchImpl })
    expect(calls).toBe(1)
    expect(result).toMatchObject({ ok: false, retryable: false })
    expect(result).not.toHaveProperty('exhausted')
    expect(await notifySendTool(ARGS, { webhookUrl: fake.url, fetchImpl: fake.fetch })).toEqual({ ok: true, ref: '4242' })
  })

  it('markExhausted 只动「可重试的失败」', () => {
    expect(markExhausted({ ok: false, reason: 'x', retryable: true })).toEqual({ ok: false, reason: 'x', retryable: true, exhausted: true })
    expect(markExhausted({ ok: false, reason: 'x', retryable: false })).toEqual({ ok: false, reason: 'x', retryable: false })
    expect(markExhausted({ ok: true, ref: '1' })).toEqual({ ok: true, ref: '1' })
  })
})
