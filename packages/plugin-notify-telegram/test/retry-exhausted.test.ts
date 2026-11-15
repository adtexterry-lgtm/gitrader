// SPDX-License-Identifier: CPAL-1.0
// R2-REL-03（集成项）：Telegram 插件对 429 自己重试（最多 3 次 HTTP 尝试）；重试到头的可重试失败标 exhausted:true，内核据此不再叠一层重试。
import { describe, expect, it } from 'vitest'
// @ts-expect-error 纯 JS 插件，没有类型声明
import { markExhausted, notifySendTool } from '../gsp.mjs'

const TOKEN = '123456:fixture-token-value'
const ARGS = { notice: { key: 'takeover:tk_1', level: 'critical', title: 'Takeover', lines: ['takeoverId: tk_1'], ts: 1760000000000, topic: 'takeover.alert' }, params: { chatId: '123' } }

/** 每次都回同一个错误的假 fetch，并数请求。retry_after=0：不等。 */
function always(status: number, description: string) {
  let calls = 0
  const fetchImpl = async () => {
    calls += 1
    return { ok: false, status, json: async () => ({ ok: false, description, parameters: { retry_after: 0 } }) }
  }
  return { count: () => calls, fetchImpl }
}

describe('Telegram notify_send 工具：重试到头 → exhausted', () => {
  it('429 一直不好：恰好 3 次 HTTP 请求（不多），结果 retryable 且 exhausted:true', async () => {
    const { count, fetchImpl } = always(429, 'Too Many Requests: retry after 0')
    const result = await notifySendTool(ARGS, { token: TOKEN, fetchImpl })
    expect(count()).toBe(3)
    expect(result).toMatchObject({ ok: false, retryable: true, exhausted: true })
  })

  it('不可重试的失败（400）：1 次请求，不带 exhausted', async () => {
    const { count, fetchImpl } = always(400, 'Bad Request: chat not found')
    const result = await notifySendTool(ARGS, { token: TOKEN, fetchImpl })
    expect(count()).toBe(1)
    expect(result).toMatchObject({ ok: false, retryable: false })
    expect(result).not.toHaveProperty('exhausted')
  })

  it('markExhausted 只动「可重试的失败」', () => {
    expect(markExhausted({ ok: false, reason: 'x', retryable: true })).toEqual({ ok: false, reason: 'x', retryable: true, exhausted: true })
    expect(markExhausted({ ok: false, reason: 'x', retryable: false })).toEqual({ ok: false, reason: 'x', retryable: false })
    expect(markExhausted({ ok: true, ref: '1' })).toEqual({ ok: true, ref: '1' })
  })
})
