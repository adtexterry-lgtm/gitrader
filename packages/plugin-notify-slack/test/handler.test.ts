// SPDX-License-Identifier: CPAL-1.0
// 处理函数单测：注入假 fetch，断言成功 / 平台报错 / 缺 webhook / 非法 URL / 429 / 超时 / 超长 / params 隔离。
import { describe, expect, it } from 'vitest'
// @ts-expect-error 纯 JS 插件，没有类型声明
import { handleNotifySend } from '../index.mjs'

const WEBHOOK = 'https://hooks.slack.com/services/T00000000/B00000000/fixtureSecretSegment'
const NOTICE = {
  key: 'risk.denials:acct_x:ruleY',
  level: 'warn',
  title: 'Risk denial',
  lines: ['account acct_x', 'rule Y', 'notional 1200 > 1000'],
  ts: 1760000000000,
  topic: 'risk.denials',
}
const ARGS = { notice: NOTICE, params: {} }

interface Call {
  url: string
  method: string | undefined
  headers: Record<string, string> | undefined
  body: { text?: string }
}

interface Reply {
  status?: number
  body?: string
  retryAfter?: string
}

function recorder(replies: Reply[]) {
  const calls: Call[] = []
  let index = 0
  const fetchImpl = async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string }) => {
    const reply = replies[Math.min(index, replies.length - 1)] ?? { status: 200, body: 'ok' }
    index += 1
    const status = reply.status ?? 200
    const raw = reply.body ?? ''
    const headers = new Headers()
    if (reply.retryAfter !== undefined) headers.set('retry-after', reply.retryAfter)
    calls.push({
      url,
      method: init.method,
      headers: init.headers,
      body: JSON.parse(init.body ?? '{}') as Call['body'],
    })
    return { ok: status >= 200 && status < 300, status, headers, text: async () => raw }
  }
  return { calls, fetchImpl }
}

const deps = (fetchImpl: unknown, extra: Record<string, unknown> = {}) => ({ webhookUrl: WEBHOOK, fetchImpl, sleepImpl: async () => {}, ...extra })

describe('notify_send 处理函数（Slack）', () => {
  it('成功：一次 POST，URL / JSON / body 只有 text，返回 {ok:true} 且无 ref', async () => {
    const { calls, fetchImpl } = recorder([{ status: 200, body: 'ok' }])
    const result = await handleNotifySend(ARGS, deps(fetchImpl))
    expect(result).toEqual({ ok: true })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(WEBHOOK)
    expect(calls[0]!.method).toBe('POST')
    expect(calls[0]!.headers?.['content-type']).toBe('application/json')
    expect(Object.keys(calls[0]!.body)).toEqual(['text'])
    // 正文只做转义与排版，不改写
    expect(calls[0]!.body.text).toContain('[WARN] *Risk denial*')
    expect(calls[0]!.body.text).toContain('notional 1200 &gt; 1000')
    expect(calls[0]!.body.text).toContain('2025-10-09T08:53:20.000Z')
  })

  it('没有 ts 时没有时间行', async () => {
    const { calls, fetchImpl } = recorder([{ status: 200, body: 'ok' }])
    const args = { notice: { ...NOTICE, ts: undefined }, params: {} }
    await handleNotifySend(args, deps(fetchImpl))
    expect(calls[0]!.body.text?.split('\n')).toHaveLength(4)
    expect(calls[0]!.body.text).not.toContain('T00:')
  })

  it('平台 400 invalid_payload → {ok:false, retryable:false}，reason 不含 webhook', async () => {
    const { fetchImpl } = recorder([{ status: 400, body: 'invalid_payload' }])
    const result = await handleNotifySend(ARGS, deps(fetchImpl))
    expect(result).toMatchObject({ ok: false, retryable: false })
    expect(result.reason).toContain('invalid_payload')
    expect(result.reason).not.toContain('fixtureSecretSegment')
  })

  it('平台 503 → retryable:true', async () => {
    const { fetchImpl } = recorder([{ status: 503, body: 'service_unavailable' }])
    const result = await handleNotifySend(ARGS, deps(fetchImpl))
    expect(result).toMatchObject({ ok: false, retryable: true })
  })

  it('缺 SLACK_WEBHOOK_URL → {ok:false, retryable:false}，不发请求', async () => {
    const saved = process.env.SLACK_WEBHOOK_URL
    delete process.env.SLACK_WEBHOOK_URL
    try {
      const { calls, fetchImpl } = recorder([{ status: 200, body: 'ok' }])
      const result = await handleNotifySend(ARGS, { fetchImpl })
      expect(result).toMatchObject({ ok: false, retryable: false })
      expect(result.reason).toContain('SLACK_WEBHOOK_URL')
      expect(calls).toHaveLength(0)
    } finally {
      if (saved !== undefined) process.env.SLACK_WEBHOOK_URL = saved
    }
  })

  it('webhook 不是 https → 配置错误，不发请求', async () => {
    const { calls, fetchImpl } = recorder([{ status: 200, body: 'ok' }])
    const result = await handleNotifySend(ARGS, deps(fetchImpl, { webhookUrl: 'http://hooks.slack.com/services/T/B/X' }))
    expect(result).toMatchObject({ ok: false, retryable: false })
    expect(result.reason).toContain('https')
    expect(calls).toHaveLength(0)
  })

  it('notice 缺失 → 不发送', async () => {
    const { calls, fetchImpl } = recorder([{ status: 200, body: 'ok' }])
    const result = await handleNotifySend({ params: {} }, deps(fetchImpl))
    expect(result).toMatchObject({ ok: false, retryable: false })
    expect(result.reason).toContain('notice')
    expect(calls).toHaveLength(0)
  })

  it('params 不是对象 → 不发送', async () => {
    const { calls, fetchImpl } = recorder([{ status: 200, body: 'ok' }])
    const result = await handleNotifySend({ notice: NOTICE, params: ['x'] }, deps(fetchImpl))
    expect(result).toMatchObject({ ok: false, retryable: false })
    expect(calls).toHaveLength(0)
  })

  it('params 里的自由文本不进正文（Slack 的目标由 webhook 决定）', async () => {
    const { calls, fetchImpl } = recorder([{ status: 200, body: 'ok' }])
    const result = await handleNotifySend(
      { notice: NOTICE, params: { note: '自由文本不进正文', chatId: 'C123', url: 'https://evil.example' } },
      deps(fetchImpl),
    )
    expect(result).toEqual({ ok: true })
    const text = calls[0]!.body.text ?? ''
    expect(text).not.toContain('自由文本')
    expect(text).not.toContain('C123')
    expect(text).not.toContain('evil.example')
    expect(Object.keys(calls[0]!.body)).toEqual(['text'])
  })

  it('429 带 Retry-After: 0 → 重试一次后成功', async () => {
    const { calls, fetchImpl } = recorder([{ status: 429, body: 'ratelimited', retryAfter: '0' }, { status: 200, body: 'ok' }])
    const result = await handleNotifySend(ARGS, deps(fetchImpl))
    expect(result).toEqual({ ok: true })
    expect(calls).toHaveLength(2)
  })

  it('网络超时（8 s 预算）→ {ok:false, retryable:true}', async () => {
    const fetchImpl = (_url: string, init: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
      })
    const result = await handleNotifySend(ARGS, deps(fetchImpl, { timeoutMs: 30 }))
    expect(result).toMatchObject({ ok: false, retryable: true })
    expect(result.reason).toContain('timed out')
  })

  it('正文超过 40000 字符 → 不发请求，不拆分成多条', async () => {
    const { calls, fetchImpl } = recorder([{ status: 200, body: 'ok' }])
    const result = await handleNotifySend({ notice: { ...NOTICE, lines: ['x'.repeat(40000)] }, params: {} }, deps(fetchImpl))
    expect(result).toMatchObject({ ok: false, retryable: false })
    expect(result.reason).toContain('40000')
    expect(calls).toHaveLength(0)
  })
})
