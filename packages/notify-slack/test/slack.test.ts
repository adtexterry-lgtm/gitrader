// SPDX-License-Identifier: CPAL-1.0
// slack.ts 的单元测试：URL 校验、单条发送、429 重试、错误分类、脱敏、尺寸上限、节流。全部离线。
import { describe, expect, it } from 'vitest'
import {
  SlackClient,
  SlackError,
  assertSlackWebhookUrl,
  isRetryableStatus,
  parseSlackResponse,
  redactWebhookUrl,
} from '../src/slack'
import { MAX_TEXT } from '../src/format'

const URL_OK = 'https://hooks.slack.com/services/T00000000/B00000000/XXXXXXXXfixtureSecret'
const SECRET_SEGMENT = 'XXXXXXXXfixtureSecret'

interface Call {
  url: string
  method: string | undefined
  headers: Record<string, string> | undefined
  body: unknown
  raw: string
  at: number
}

interface Reply {
  status?: number
  body?: string
  retryAfter?: string
}

interface Harness {
  calls: Call[]
  sleeps: number[]
  clock: () => number
  sleepImpl: (ms: number) => Promise<void>
  fetchImpl: typeof fetch
}

function harness(replies: Reply[], options: { failWith?: Error } = {}): Harness {
  const calls: Call[] = []
  const sleeps: number[] = []
  let now = 0
  let index = 0
  const clock = (): number => now
  const sleepImpl = async (ms: number): Promise<void> => {
    sleeps.push(ms)
    now += ms
  }
  const fetchImpl = (async (input: unknown, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
    if (options.failWith) throw options.failWith
    const reply = replies[Math.min(index, replies.length - 1)] ?? { status: 200, body: 'ok' }
    index += 1
    const status = reply.status ?? 200
    const raw = reply.body ?? ''
    calls.push({
      url: String(input),
      method: init?.method,
      headers: init?.headers,
      body: init?.body === undefined ? undefined : (JSON.parse(init.body) as unknown),
      raw: String(init?.body ?? ''),
      at: clock(),
    })
    const headers = new Headers()
    if (reply.retryAfter !== undefined) headers.set('retry-after', reply.retryAfter)
    return {
      ok: status >= 200 && status < 300,
      status,
      headers,
      text: async () => raw,
    }
  }) as unknown as typeof fetch
  return { calls, sleeps, clock, sleepImpl, fetchImpl }
}

function client(h: Harness, overrides: Partial<ConstructorParameters<typeof SlackClient>[0]> = {}): SlackClient {
  return new SlackClient({
    webhookUrl: URL_OK,
    fetchImpl: h.fetchImpl,
    clock: h.clock,
    sleepImpl: h.sleepImpl,
    minIntervalMs: 0,
    ...overrides,
  })
}

async function catchError(run: () => Promise<unknown>): Promise<SlackError> {
  const error = await run().then(
    () => undefined,
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(SlackError)
  return error as SlackError
}

describe('assertSlackWebhookUrl', () => {
  it('https + hooks.slack.com + /services/ 路径通过，返回同一串', () => {
    expect(assertSlackWebhookUrl(URL_OK)).toBe(URL_OK)
  })

  it('空值 / 非字符串 / 非法 URL 一律拒（配置错误不重试）', () => {
    for (const bad of ['', '   ', undefined, null, 42, 'not a url']) {
      const error = (() => {
        try {
          assertSlackWebhookUrl(bad)
          return undefined
        } catch (e) {
          return e as SlackError
        }
      })()
      expect(error).toBeInstanceOf(SlackError)
      expect(error?.retryable).toBe(false)
    }
  })

  it('http 被拒（生产路径永远 https）；只有显式放开 + 回环主机才允许', () => {
    expect(() => assertSlackWebhookUrl('http://hooks.slack.com/services/T/B/X')).toThrow(SlackError)
    expect(assertSlackWebhookUrl('http://127.0.0.1:9/services/T/B/X', { allowedHosts: ['127.0.0.1'], allowInsecureLoopback: true })).toContain('127.0.0.1')
    // 放开回环也不放公网 http
    expect(() => assertSlackWebhookUrl('http://evil.example/services/T/B/X', { allowedHosts: ['evil.example'], allowInsecureLoopback: true })).toThrow(SlackError)
  })

  it('主机不在允许清单内被拒（防把 webhook 发到别处）', () => {
    expect(() => assertSlackWebhookUrl('https://evil.example/services/T/B/X')).toThrow(/主机不在允许清单/)
  })

  it('路径不是 /services/ 开头被拒；带查询串 / 锚点被拒', () => {
    expect(() => assertSlackWebhookUrl('https://hooks.slack.com/other/T/B/X')).toThrow(/\/services\//)
    expect(() => assertSlackWebhookUrl(`${URL_OK}?a=1`)).toThrow(/查询串/)
    expect(() => assertSlackWebhookUrl(`${URL_OK}#x`)).toThrow(/查询串/)
  })
})

describe('SlackClient.send', () => {
  it('成功：一次 POST，body 只有 text，content-type 是 JSON，不返回消息 id', async () => {
    const h = harness([{ status: 200, body: 'ok' }])
    await client(h).send('[INFO] *t*\nline')
    expect(h.calls).toHaveLength(1)
    const call = h.calls[0]!
    expect(call.url).toBe(URL_OK)
    expect(call.method).toBe('POST')
    expect(call.headers?.['content-type']).toBe('application/json')
    expect(call.body).toEqual({ text: '[INFO] *t*\nline' })
    expect(Object.keys(call.body as object)).toEqual(['text'])
  })

  it('429 + Retry-After: 1 → 等 1000 ms 重试一次后成功', async () => {
    const h = harness([{ status: 429, body: 'ratelimited', retryAfter: '1' }, { status: 200, body: 'ok' }])
    await client(h).send('hi')
    expect(h.calls).toHaveLength(2)
    expect(h.sleeps).toEqual([1000])
  })

  it('429 没有 Retry-After → 按 500 ms 起的指数退避', async () => {
    const h = harness([{ status: 429, body: 'ratelimited' }, { status: 200, body: 'ok' }])
    await client(h).send('hi')
    expect(h.sleeps).toEqual([500])
  })

  it('重试次数用尽后抛 retryable=true（默认 2 次重试 = 3 次 POST）', async () => {
    const h = harness([{ status: 503, body: 'service_unavailable' }])
    const error = await catchError(() => client(h).send('hi'))
    expect(error.retryable).toBe(true)
    expect(error.message).toContain('503')
    expect(h.calls).toHaveLength(3)
    expect(h.sleeps).toEqual([500, 1000])
  })

  it('400 invalid_payload → retryable=false，只发一次', async () => {
    const h = harness([{ status: 400, body: 'invalid_payload' }])
    const error = await catchError(() => client(h).send('hi'))
    expect(error.retryable).toBe(false)
    expect(error.message).toBe('http_400:invalid_payload')
    expect(h.calls).toHaveLength(1)
  })

  it('403 no_service → retryable=false（配置 / 权限类）', async () => {
    const h = harness([{ status: 403, body: 'no_service' }])
    const error = await catchError(() => client(h).send('hi'))
    expect(error.retryable).toBe(false)
    expect(error.message).toContain('no_service')
  })

  it('200 但 body 不是 ok → slack_unexpected，不当作成功', async () => {
    const h = harness([{ status: 200, body: 'weird' }])
    const error = await catchError(() => client(h).send('hi'))
    expect(error.retryable).toBe(false)
    expect(error.message).toBe('slack_unexpected:weird')
  })

  it('超时（TimeoutError）→ retryable=true，消息是 timed out', async () => {
    const h = harness([], { failWith: Object.assign(new Error('aborted'), { name: 'TimeoutError' }) })
    const error = await catchError(() => client(h).send('hi'))
    expect(error.retryable).toBe(true)
    expect(error.message).toBe('Slack webhook timed out')
  })

  it('网络错误消息里不留 webhook URL 与路径段', async () => {
    const h = harness([], { failWith: new Error(`connect ECONNREFUSED ${URL_OK} ${SECRET_SEGMENT}`) })
    const error = await catchError(() => client(h).send('hi'))
    expect(error.message).not.toContain(URL_OK)
    expect(error.message).not.toContain(SECRET_SEGMENT)
    expect(error.message).toContain('<redacted>')
  })

  it('文本超过 40000 字符：不发请求，抛 retryable=false', async () => {
    const h = harness([{ status: 200, body: 'ok' }])
    const error = await catchError(() => client(h).send('x'.repeat(MAX_TEXT + 1)))
    expect(error.retryable).toBe(false)
    expect(error.message).toContain(String(MAX_TEXT))
    expect(h.calls).toHaveLength(0)
  })

  it('空文本不发请求', async () => {
    const h = harness([{ status: 200, body: 'ok' }])
    await catchError(() => client(h).send(''))
    expect(h.calls).toHaveLength(0)
  })

  it('同一 webhook 连发两条：第二条至少晚 minIntervalMs', async () => {
    const h = harness([{ status: 200, body: 'ok' }, { status: 200, body: 'ok' }])
    const c = client(h, { minIntervalMs: 1000 })
    await c.send('first')
    await c.send('second')
    expect(h.sleeps).toEqual([1000])
    expect(h.calls[1]!.at - h.calls[0]!.at).toBeGreaterThanOrEqual(1000)
  })

  it('构造时就拒绝 http：即使调用 send 也不会有请求', () => {
    expect(() => new SlackClient({ webhookUrl: 'http://hooks.slack.com/services/T/B/X' })).toThrow(SlackError)
  })

  it('构造后 JSON.stringify / Object.keys 不含 webhook URL 与路径段', () => {
    const c = new SlackClient({ webhookUrl: URL_OK })
    const exposed = `${JSON.stringify(c)}|${Object.keys(c).join(',')}`
    for (const secret of [URL_OK, SECRET_SEGMENT, 'T00000000', 'B00000000']) expect(exposed).not.toContain(secret)
    expect(Object.keys(c)).not.toContain('webhookUrl')
  })
})

describe('parseSlackResponse / isRetryableStatus', () => {
  it('200 ok / 大小写与空白都算成功', () => {
    expect(parseSlackResponse(200, 'ok')).toEqual({ ok: true })
    expect(parseSlackResponse(200, ' OK \n')).toEqual({ ok: true })
  })

  it('JSON 对象里 ok:false → slack_error，不重试；其余 JSON 对象算成功（与 notify-webhook 同口径）', () => {
    expect(parseSlackResponse(200, '{"ok":false,"error":"invalid_blocks"}')).toEqual({ ok: false, reason: 'slack_error:invalid_blocks', retryable: false })
    expect(parseSlackResponse(200, '{"ok":true}')).toEqual({ ok: true })
  })

  it('非 2xx：408 / 429 / 5xx 可重试，其余 4xx 不可重试', () => {
    expect(isRetryableStatus(408)).toBe(true)
    expect(isRetryableStatus(429)).toBe(true)
    expect(isRetryableStatus(500)).toBe(true)
    expect(isRetryableStatus(404)).toBe(false)
    expect(parseSlackResponse(429, 'ratelimited')).toEqual({ ok: false, reason: 'http_429:ratelimited', retryable: true })
    expect(parseSlackResponse(404, 'channel_not_found')).toEqual({ ok: false, reason: 'http_404:channel_not_found', retryable: false })
  })

  it('非 2xx 无 body：reason 只有状态码', () => {
    expect(parseSlackResponse(502, '')).toEqual({ ok: false, reason: 'http_502', retryable: true })
  })
})

describe('redactWebhookUrl', () => {
  it('整条 URL、path、路径段都被替换，压成一行', () => {
    const text = redactWebhookUrl(`POST ${URL_OK}\npath /services/T00000000/B00000000/${SECRET_SEGMENT} seg ${SECRET_SEGMENT}`, URL_OK)
    expect(text).not.toContain(SECRET_SEGMENT)
    expect(text).not.toContain('T00000000')
    expect(text).toContain('<redacted>')
    expect(text).not.toContain('\n')
  })

  it('空 url 时原样返回（只压行）', () => {
    expect(redactWebhookUrl('a\nb', '')).toBe('a b')
  })
})
