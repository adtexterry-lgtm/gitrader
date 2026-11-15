// SPDX-License-Identifier: CPAL-1.0
// 处理函数单测：注入假 fetch，断言成功 / 平台报错 / 缺环境变量 / 429 重试 / 超时 / 分块。
import { describe, expect, it } from 'vitest'
// @ts-expect-error 纯 JS 插件，没有类型声明
import { FAKE_MESSAGE_ID, handleNotifySend } from '../index.mjs'

const TOKEN = '123456:fixture-token-value'
const NOTICE = {
  key: 'risk.denials:acct_x:ruleY',
  level: 'warn',
  title: 'Risk denial',
  lines: ['account acct_x', 'rule Y', 'notional 1200 > 1000'],
  ts: 1760000000000,
  topic: 'risk.denials',
}
const ARGS = { notice: NOTICE, params: { chatId: '123' } }

interface Call {
  url: string
  body: { chat_id: unknown; text: string; parse_mode: string; disable_web_page_preview: boolean }
}

function okResponse(messageId: number) {
  return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: messageId } }) }
}

function errorResponse(status: number, description: string, retryAfter?: number) {
  return {
    ok: false,
    status,
    json: async () => ({ ok: false, description, ...(retryAfter === undefined ? {} : { parameters: { retry_after: retryAfter } }) }),
  }
}

function recorder(responses: unknown[]) {
  const calls: Call[] = []
  let index = 0
  const fetchImpl = async (url: string, init: { body?: string }) => {
    calls.push({ url, body: JSON.parse(init.body ?? '{}') as Call['body'] })
    const next = responses[Math.min(index, responses.length - 1)]
    index += 1
    return next
  }
  return { calls, fetchImpl }
}

describe('notify_send 处理函数', () => {
  it('成功：一次 sendMessage，MarkdownV2，返回 {ok:true, ref}', async () => {
    const { calls, fetchImpl } = recorder([okResponse(FAKE_MESSAGE_ID)])
    const result = await handleNotifySend(ARGS, { token: TOKEN, fetchImpl })
    expect(result).toEqual({ ok: true, ref: String(FAKE_MESSAGE_ID) })
    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`)
    expect(call.body.chat_id).toBe('123')
    expect(call.body.parse_mode).toBe('MarkdownV2')
    expect(call.body.disable_web_page_preview).toBe(true)
    // 正文只做转义与排版，不改写：level 标记 + 加粗 title，逐行原文
    expect(call.body.text).toContain('\\[WARN\\] *Risk denial*')
    expect(call.body.text).toContain('notional 1200 > 1000'.replace('>', '\\>'))
  })

  it('平台报错（400 chat not found）→ {ok:false, retryable:false}，reason 不含密钥', async () => {
    const { fetchImpl } = recorder([errorResponse(400, 'Bad Request: chat not found')])
    const result = await handleNotifySend(ARGS, { token: TOKEN, fetchImpl })
    expect(result.ok).toBe(false)
    expect(result.retryable).toBe(false)
    expect(result.reason).toContain('chat not found')
    expect(result.reason).not.toContain(TOKEN)
  })

  it('平台 5xx → retryable:true', async () => {
    const { fetchImpl } = recorder([errorResponse(502, 'Bad Gateway')])
    const result = await handleNotifySend(ARGS, { token: TOKEN, fetchImpl })
    expect(result).toMatchObject({ ok: false, retryable: true })
  })

  it('缺 TELEGRAM_BOT_TOKEN → {ok:false, retryable:false}，不发请求', async () => {
    const saved = process.env.TELEGRAM_BOT_TOKEN
    delete process.env.TELEGRAM_BOT_TOKEN
    try {
      const { calls, fetchImpl } = recorder([okResponse(1)])
      const result = await handleNotifySend(ARGS, { fetchImpl })
      expect(result).toMatchObject({ ok: false, retryable: false })
      expect(result.reason).toContain('TELEGRAM_BOT_TOKEN')
      expect(calls).toHaveLength(0)
    } finally {
      if (saved !== undefined) process.env.TELEGRAM_BOT_TOKEN = saved
    }
  })

  it('params.chatId 缺失 → {ok:false, retryable:false}，不发请求', async () => {
    const { calls, fetchImpl } = recorder([okResponse(1)])
    const result = await handleNotifySend({ notice: NOTICE, params: {} }, { token: TOKEN, fetchImpl })
    expect(result).toMatchObject({ ok: false, retryable: false })
    expect(result.reason).toContain('chatId')
    expect(calls).toHaveLength(0)
  })

  it('429 带 retry_after=0 → 重试一次后成功', async () => {
    const { calls, fetchImpl } = recorder([errorResponse(429, 'Too Many Requests: retry after 0', 0), okResponse(FAKE_MESSAGE_ID)])
    const result = await handleNotifySend(ARGS, { token: TOKEN, fetchImpl })
    expect(result).toEqual({ ok: true, ref: String(FAKE_MESSAGE_ID) })
    expect(calls).toHaveLength(2)
  })

  it('网络超时（≤8 s 预算）→ {ok:false, retryable:true}', async () => {
    const fetchImpl = (_url: string, init: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
      })
    const result = await handleNotifySend(ARGS, { token: TOKEN, fetchImpl, timeoutMs: 30 })
    expect(result).toMatchObject({ ok: false, retryable: true })
    expect(result.reason).toContain('timed out')
  })

  it('超长正文按 4096 分块顺序发送，ref 取第一条消息 id', async () => {
    const ids = [5001, 5002, 5003, 5004]
    const { calls, fetchImpl } = recorder(ids.map((id) => okResponse(id)))
    const longArgs = { notice: { ...NOTICE, lines: ['x'.repeat(5000)] }, params: { chatId: 42 } }
    const result = await handleNotifySend(longArgs, { token: TOKEN, fetchImpl })
    expect(result).toEqual({ ok: true, ref: '5001' })
    // 一行 5000 字符 → 硬切；每块都不超过 4096，且正文一个字都没丢
    expect(calls.length).toBeGreaterThanOrEqual(2)
    for (const call of calls) expect(call.body.text.length).toBeLessThanOrEqual(4096)
    expect(calls.map((call) => call.body.text).join('\n')).toContain('x'.repeat(4096))
    expect(calls[calls.length - 1]!.body.chat_id).toBe(42)
  })
})
