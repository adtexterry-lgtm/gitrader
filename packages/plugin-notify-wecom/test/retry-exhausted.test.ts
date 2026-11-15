// SPDX-License-Identifier: CPAL-1.0
// R2-REL-03（集成项）：企业微信插件自己重试（maxRetries=1，最多 2 次 HTTP 尝试）；重试到头的可重试失败标 exhausted:true，内核据此不再叠一层重试。
import { describe, expect, it } from 'vitest'
// @ts-expect-error 纯 JS 插件，没有类型声明
import { markExhausted, notifySendTool } from '../gsp.mjs'
import { FakeWeComServer } from './helpers/fake-wecom'

const KEY = 'fixture-webhook-key-0001'
const WEBHOOK = `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${KEY}`
const ARGS = { notice: { key: 'takeover:tk_1', level: 'critical', title: 'Takeover', lines: ['takeoverId: tk_1'], ts: 1760000000000, topic: 'takeover.alert' }, params: {} }
const deps = (fake: FakeWeComServer) => ({ webhookUrl: WEBHOOK, fetchImpl: fake.fetch, timeoutMs: 500, retryDelayMs: 10 })

describe('企业微信 notify_send 工具：重试到头 → exhausted', () => {
  it('45009（限频）一直不好：恰好 2 次 HTTP 请求（不多于 3），结果 retryable 且 exhausted:true', async () => {
    const fake = new FakeWeComServer({ key: KEY, errcodes: [45009, 45009, 45009, 45009] })
    const result = await notifySendTool(ARGS, deps(fake))
    expect(fake.calls).toHaveLength(2)
    expect(result).toMatchObject({ ok: false, retryable: true, exhausted: true })
  })

  it('不可重试的失败（93000）：1 次请求，不带 exhausted；成功结果原样', async () => {
    const bad = new FakeWeComServer({ key: KEY, errcodes: [93000] })
    const result = await notifySendTool(ARGS, deps(bad))
    expect(bad.calls).toHaveLength(1)
    expect(result).toMatchObject({ ok: false, retryable: false })
    expect(result).not.toHaveProperty('exhausted')
    expect(await notifySendTool(ARGS, deps(new FakeWeComServer({ key: KEY })))).toEqual({ ok: true })
  })

  it('markExhausted 只动「可重试的失败」', () => {
    expect(markExhausted({ ok: false, reason: 'x', retryable: true })).toEqual({ ok: false, reason: 'x', retryable: true, exhausted: true })
    expect(markExhausted({ ok: false, reason: 'x', retryable: false })).toEqual({ ok: false, reason: 'x', retryable: false })
    expect(markExhausted({ ok: true })).toEqual({ ok: true })
  })
})
