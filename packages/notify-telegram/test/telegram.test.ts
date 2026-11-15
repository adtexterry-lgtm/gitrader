// SPDX-License-Identifier: CPAL-1.0
// telegram.ts 的单元测试：全部离线（假 fetch 记录请求，假时钟；token 只用 '123:test-token'）。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { chunkMessage } from '../src/format'
import { redactToken, TelegramClient } from '../src/telegram'

const TOKEN = '123:test-token'

interface RecordedCall {
  url: string
  body: { chat_id: string | number; text: string; parse_mode: string; disable_web_page_preview: boolean }
  at: number
}

interface FakeReply {
  status?: number
  payload: unknown
}

function makeFetch(replies: FakeReply[], calls: RecordedCall[], clock: () => number): typeof fetch {
  let index = 0
  const impl = async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    calls.push({
      url: String(input),
      body: JSON.parse(String(init?.body)) as RecordedCall['body'],
      at: clock(),
    })
    const reply = replies[Math.min(index, replies.length - 1)]
    index += 1
    if (!reply) throw new Error('fake fetch: no reply configured')
    const status = reply.status ?? 200
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => reply.payload,
    } as unknown as Response
  }
  return impl as unknown as typeof fetch
}

const okReply = (messageId: number): FakeReply => ({ payload: { ok: true, result: { message_id: messageId } } })

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve()
}

afterEach(() => {
  vi.useRealTimers()
})

describe('TelegramClient.sendMessage', () => {
  it('正常发送：URL、body、返回 messageIds', async () => {
    const calls: RecordedCall[] = []
    const fetchImpl = makeFetch([okReply(42)], calls, () => 0)
    const client = new TelegramClient({ token: TOKEN, fetchImpl, clock: () => 0, minIntervalMs: 0 })

    const out = await client.sendMessage(7, 'hello')

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toContain(`/bot${TOKEN}/sendMessage`)
    expect(calls[0]!.body.chat_id).toBe(7)
    expect(calls[0]!.body.parse_mode).toBe('MarkdownV2')
    expect(calls[0]!.body.disable_web_page_preview).toBe(true)
    expect(out.messageIds).toEqual([42])
  })

  it('超长文本分块顺序发送，次数 = 块数', async () => {
    const text = ['a'.repeat(1500), 'b'.repeat(1500), 'c'.repeat(1500), 'd'.repeat(1500), 'e'.repeat(1500), 'f'.repeat(1500)].join('\n')
    const parts = chunkMessage(text)
    expect(parts.length).toBe(3)

    const calls: RecordedCall[] = []
    const fetchImpl = makeFetch([okReply(1), okReply(2), okReply(3)], calls, () => 0)
    const client = new TelegramClient({ token: TOKEN, fetchImpl, clock: () => 0, minIntervalMs: 0 })

    const out = await client.sendMessage('chat-a', text)

    expect(calls).toHaveLength(parts.length)
    expect(calls.map((c) => c.body.text)).toEqual(parts)
    expect(out.messageIds).toEqual([1, 2, 3])
  })

  it('429 按 parameters.retry_after 等待后重试一次', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const calls: RecordedCall[] = []
    const clock = (): number => Date.now()
    const fetchImpl = makeFetch(
      [{ status: 429, payload: { ok: false, description: 'Too Many Requests', parameters: { retry_after: 1 } } }, okReply(9)],
      calls,
      clock,
    )
    const client = new TelegramClient({ token: TOKEN, fetchImpl, clock, minIntervalMs: 0 })

    const startedAt = clock()
    const pending = client.sendMessage(1, 'hi')
    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(1000)
    const out = await pending

    expect(calls).toHaveLength(2)
    expect(out.messageIds).toEqual([9])
    expect(clock() - startedAt).toBe(1000)
  })

  it('ok=false 抛错：含 description，不含 token', async () => {
    const calls: RecordedCall[] = []
    const fetchImpl = makeFetch([{ status: 400, payload: { ok: false, description: 'chat not found' } }], calls, () => 0)
    const client = new TelegramClient({ token: TOKEN, fetchImpl, clock: () => 0, minIntervalMs: 0 })

    const error = await client.sendMessage(1, 'hi').then(
      () => undefined,
      (e: unknown) => e as Error,
    )

    expect(error).toBeInstanceOf(Error)
    expect(error?.message).toContain('chat not found')
    expect(error?.message).not.toContain(TOKEN)
    expect(error?.message).not.toContain('test-token')
  })

  it('同一 chat 连发两条：第二条 ≥ 第一条 + minIntervalMs', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const calls: RecordedCall[] = []
    const clock = (): number => Date.now()
    const fetchImpl = makeFetch([okReply(1), okReply(2)], calls, clock)
    const client = new TelegramClient({ token: TOKEN, fetchImpl, clock })

    await client.sendMessage(1, 'first')
    const pending = client.sendMessage(1, 'second')
    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(1000)
    await pending

    expect(calls).toHaveLength(2)
    expect(calls[1]!.at - calls[0]!.at).toBeGreaterThanOrEqual(1000)
  })
})

describe('redactToken', () => {
  it('把 token 替换成 bot<redacted>', () => {
    const redacted = redactToken(`https://api.telegram.org/bot${TOKEN}/sendMessage`, TOKEN)
    expect(redacted).not.toContain(TOKEN)
    expect(redacted).toContain('bot<redacted>')
  })
})
