// SPDX-License-Identifier: CPAL-1.0
// R2-REL-03（集成项）：Slack 插件自己重试（最多 3 次 HTTP 尝试）；重试到头的可重试失败标 exhausted:true，内核据此不再叠一层重试。
import { describe, expect, it } from 'vitest'
// @ts-expect-error 纯 JS 插件，没有类型声明
import { markExhausted, notifySendTool } from '../gsp.mjs'

const WEBHOOK = 'https://hooks.slack.com/services/T00000000/B00000000/fixtureSecretSegment'
const ARGS = { notice: { key: 'takeover:tk_1', level: 'critical', title: 'Takeover', lines: ['takeoverId: tk_1'], ts: 1760000000000, topic: 'takeover.alert' }, params: {} }

/** 每次都回同一个状态码的假 fetch，并数请求。 */
function always(status: number, body = 'boom') {
  const calls: string[] = []
  const fetchImpl = async (url: string) => { calls.push(url); return { ok: status < 300, status, headers: new Headers(), text: async () => body } }
  return { calls, fetchImpl }
}
const deps = (fetchImpl: unknown) => ({ webhookUrl: WEBHOOK, fetchImpl, sleepImpl: async () => {} })

describe('Slack notify_send 工具：重试到头 → exhausted', () => {
  it('503 一直不好：恰好 3 次 HTTP 请求（不多），结果 retryable 且 exhausted:true', async () => {
    const { calls, fetchImpl } = always(503)
    const result = await notifySendTool(ARGS, deps(fetchImpl))
    expect(calls).toHaveLength(3)
    expect(result).toMatchObject({ ok: false, retryable: true, exhausted: true })
  })

  it('不可重试的失败（400）：1 次请求，不带 exhausted；成功结果原样', async () => {
    const bad = always(400)
    const result = await notifySendTool(ARGS, deps(bad.fetchImpl))
    expect(bad.calls).toHaveLength(1)
    expect(result).toMatchObject({ ok: false, retryable: false })
    expect(result).not.toHaveProperty('exhausted')
    const good = always(200, 'ok')
    expect(await notifySendTool(ARGS, deps(good.fetchImpl))).toEqual({ ok: true })
  })

  it('markExhausted 只动「可重试的失败」', () => {
    expect(markExhausted({ ok: false, reason: 'x', retryable: true })).toEqual({ ok: false, reason: 'x', retryable: true, exhausted: true })
    expect(markExhausted({ ok: false, reason: 'x', retryable: false })).toEqual({ ok: false, reason: 'x', retryable: false })
    expect(markExhausted({ ok: true })).toEqual({ ok: true })
  })
})
