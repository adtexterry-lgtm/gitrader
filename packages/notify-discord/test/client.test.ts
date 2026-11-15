// SPDX-License-Identifier: CPAL-1.0
// client.ts 单测：成功 / ref、429 等待与上限、5xx 重试、4xx 不重试、网络错误与超时、分块发送、reason 脱敏。
import { describe, expect, it } from 'vitest'
import { DiscordWebhookClient, DEFAULT_MAX_RETRY_AFTER_MS } from '../src/client'
import { WebhookUrlError } from '../src/url'

const ID = '123456789012345678'
const TOKEN = 'fixture-webhook-token-0123456789'
const URL_OK = `https://discord.com/api/webhooks/${ID}/${TOKEN}`

interface Harness {
  client: DiscordWebhookClient
  calls: Array<{ url: string; body: string }>
  sleeps: number[]
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
}

function harness(respond: Array<() => Response>, options: { maxRetries?: number; timeoutMs?: number } = {}): Harness {
  const calls: Array<{ url: string; body: string }> = []
  const sleeps: number[] = []
  let now = 1_000
  let index = 0
  const fetchImpl: typeof fetch = async (url, init = {}) => {
    calls.push({ url: String(url), body: typeof init.body === 'string' ? init.body : '' })
    const next = respond[Math.min(index, respond.length - 1)] as () => Response
    index += 1
    return next()
  }
  const client = new DiscordWebhookClient({
    url: URL_OK,
    fetchImpl,
    clock: () => now,
    sleep: async (ms) => {
      sleeps.push(ms)
      now += ms
    },
    ...(options.maxRetries === undefined ? {} : { maxRetries: options.maxRetries }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  })
  return { client, calls, sleeps }
}

describe('DiscordWebhookClient：成功路径', () => {
  it('200 + message 对象 → {ok, ref}，一次 POST，body 是 content + allowed_mentions', async () => {
    const { client, calls } = harness([() => jsonResponse(200, { id: '1300000000000000001', content: 'x' })])
    const result = await client.sendContent('**[WARN]** Risk denial')
    expect(result).toEqual({ ok: true, ref: '1300000000000000001' })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(`${URL_OK}?wait=true`)
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({ content: '**[WARN]** Risk denial', allowed_mentions: { parse: [] } })
  })

  it('200 但读不到 id → {ok:true} 无 ref（不把缺 id 当成发送失败）', async () => {
    const { client } = harness([() => jsonResponse(200, { content: 'x' })])
    expect(await client.sendContent('x')).toEqual({ ok: true })
  })

  it('204（未带 wait 的官方成功）也照成功处理', async () => {
    const { client } = harness([() => new Response(null, { status: 204 })])
    expect(await client.sendContent('x')).toEqual({ ok: true })
  })
})

describe('DiscordWebhookClient：重试与 429', () => {
  it('429 retry_after=1 → 等 1000 ms 后重试一次成功', async () => {
    const { client, calls, sleeps } = harness([
      () => jsonResponse(429, { message: 'You are being rate limited.', retry_after: 1, global: false }, { 'retry-after': '1' }),
      () => jsonResponse(200, { id: '77' }),
    ])
    const result = await client.sendContent('x')
    expect(result).toEqual({ ok: true, ref: '77' })
    expect(sleeps).toEqual([1000])
    expect(calls).toHaveLength(2)
  })

  it('429 的 retry_after 超过上限 → 不等、直接 retryable', async () => {
    const { client, calls, sleeps } = harness([
      () => jsonResponse(429, { message: 'You are being rate limited.', retry_after: 120, global: true }),
    ])
    const result = await client.sendContent('x')
    expect(result).toMatchObject({ ok: false, retryable: true })
    expect(sleeps).toEqual([])
    expect(calls).toHaveLength(1)
    expect(result.ok === false && result.reason).toContain(String(DEFAULT_MAX_RETRY_AFTER_MS))
  })

  it('429 等两次会超出预算 → 第二次直接报预算不足（不无限等）', async () => {
    const { client, sleeps } = harness(
      [() => jsonResponse(429, { message: 'You are being rate limited.', retry_after: 2, global: false })],
      { maxRetries: 2 },
    )
    const result = await client.sendContent('x')
    expect(result).toMatchObject({ ok: false, retryable: true })
    expect(sleeps).toEqual([2000])
    expect(result.ok === false && result.reason).toContain('重试预算不足')
  })

  it('5xx 按退避重试一次后成功', async () => {
    const { client, calls, sleeps } = harness([
      () => jsonResponse(503, { message: 'Service Unavailable', code: 0 }),
      () => jsonResponse(200, { id: '88' }),
    ])
    expect(await client.sendContent('x')).toEqual({ ok: true, ref: '88' })
    expect(sleeps).toEqual([500])
    expect(calls).toHaveLength(2)
  })

  it('5xx 连续两次（maxRetries=1）→ 交回 retryable', async () => {
    const { client, calls } = harness([() => jsonResponse(500, { message: 'Internal Server Error', code: 0 })])
    const result = await client.sendContent('x')
    expect(result).toMatchObject({ ok: false, retryable: true })
    expect(calls).toHaveLength(2)
  })

  it('401 (50027) 不重试：令牌错重发也没用', async () => {
    const { client, calls } = harness([() => jsonResponse(401, { message: 'Invalid Webhook Token', code: 50027 })])
    const result = await client.sendContent('x')
    expect(result).toMatchObject({ ok: false, retryable: false })
    expect(calls).toHaveLength(1)
    expect(result.ok === false && result.reason).toContain('50027')
  })

  it('404 (10015) 不重试', async () => {
    const { client, calls } = harness([() => jsonResponse(404, { message: 'Unknown Webhook', code: 10015 })])
    const result = await client.sendContent('x')
    expect(result).toMatchObject({ ok: false, retryable: false })
    expect(calls).toHaveLength(1)
  })
})

describe('DiscordWebhookClient：异常与脱敏', () => {
  it('网络错误 → retryable，且 reason 不含 token 与 URL', async () => {
    const client = new DiscordWebhookClient({
      url: URL_OK,
      fetchImpl: async () => {
        throw new Error(`connect ECONNREFUSED for ${URL_OK} token=${TOKEN}`)
      },
      sleep: async () => {},
    })
    const result = await client.sendContent('x')
    expect(result).toMatchObject({ ok: false, retryable: true })
    const reason = result.ok === false ? result.reason : ''
    expect(reason).toContain('network error')
    expect(reason).not.toContain(TOKEN)
    expect(reason).not.toContain(`/api/webhooks/${ID}/${TOKEN}`)
    expect(reason).not.toContain('\n')
  })

  it('请求超时（AbortSignal 触发）→ retryable，reason 说明超时', async () => {
    const client = new DiscordWebhookClient({
      url: URL_OK,
      timeoutMs: 25,
      maxRetries: 0,
      fetchImpl: (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
        }),
    })
    const result = await client.sendContent('x')
    expect(result).toMatchObject({ ok: false, retryable: true })
    expect(result.ok === false && result.reason).toContain('超时')
  })

  it('空文本与超长文本在客户端就失败，不发请求', async () => {
    const { client, calls } = harness([() => jsonResponse(200, { id: '1' })])
    expect(await client.sendContent('   ')).toMatchObject({ ok: false, retryable: false })
    expect(await client.sendContent('x'.repeat(2001))).toMatchObject({ ok: false, retryable: false })
    expect(calls).toHaveLength(0)
  })

  it('构造时校验 URL：非法主机 / http 抛 WebhookUrlError；webhookId 可取', () => {
    expect(() => new DiscordWebhookClient({ url: `https://example.test/api/webhooks/${ID}/${TOKEN}` })).toThrow(WebhookUrlError)
    expect(() => new DiscordWebhookClient({ url: `http://discord.com/api/webhooks/${ID}/${TOKEN}` })).toThrow(WebhookUrlError)
    expect(new DiscordWebhookClient({ url: URL_OK }).webhookId).toBe(ID)
  })

  it('构造后 JSON.stringify / Object.keys 不含 token 与完整 URL', () => {
    const client = new DiscordWebhookClient({ url: URL_OK })
    const exposed = `${JSON.stringify(client)}|${Object.keys(client).join(',')}`
    for (const secret of [TOKEN, URL_OK, `/api/webhooks/${ID}/${TOKEN}`]) expect(exposed).not.toContain(secret)
    expect(Object.keys(client)).not.toContain('target')
  })
})

describe('DiscordWebhookClient：分块', () => {
  it('2500 字符分成 2000 + 500 两条顺序发，ref 取第一条', async () => {
    const { client, calls } = harness([
      () => jsonResponse(200, { id: '5001' }),
      () => jsonResponse(200, { id: '5002' }),
    ])
    const result = await client.sendText('x'.repeat(2500))
    expect(result).toEqual({ ok: true, ref: '5001' })
    expect(calls).toHaveLength(2)
    expect(JSON.parse(calls[0]?.body ?? '{}').content).toHaveLength(2000)
    expect(JSON.parse(calls[1]?.body ?? '{}').content).toHaveLength(500)
  })

  it('中间一块失败即停止，后续块不再发', async () => {
    const { client, calls } = harness([
      () => jsonResponse(200, { id: '1' }),
      () => jsonResponse(400, { message: 'Invalid Form Body', code: 50035 }),
      () => jsonResponse(200, { id: '3' }),
    ])
    const result = await client.sendText('x'.repeat(4500))
    expect(result).toMatchObject({ ok: false, retryable: false })
    expect(calls).toHaveLength(2)
  })
})
