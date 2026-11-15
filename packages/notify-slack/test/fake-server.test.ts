// SPDX-License-Identifier: CPAL-1.0
// 假服务器联调：客户端走真实 socket 到回环端口，由 test/fake-slack-server.mjs 按官方规则独立校验
// （POST / JSON / 只有 text 键 / ≤ 40000 / & < > 已转义）。这一层不复用客户端的假 fetch。
// @ts-expect-error 测试辅助是纯 .mjs，没有类型声明
import { startFakeSlackServer } from './fake-slack-server.mjs'
import { afterEach, describe, expect, it } from 'vitest'
import { SlackClient, SlackError } from '../src/slack'
import { renderNotice } from '../src/format'

interface FakeServer {
  url: string
  requests: Array<{ path: string; body: { text?: string }; text?: string }>
  violations: string[]
  violationSummary: () => string[]
  setRespond: (fn: (index: number, body: unknown) => { status?: number; body?: string; headers?: Record<string, string> }) => void
  close: () => Promise<void>
}

const started: FakeServer[] = []

async function start(): Promise<FakeServer> {
  const server = (await startFakeSlackServer()) as FakeServer
  started.push(server)
  return server
}

afterEach(async () => {
  while (started.length > 0) await started.pop()!.close()
})

describe('Slack webhook 假服务器（独立校验）', () => {
  it('客户端一条消息 → 服务器收到 1 条 POST，形状无违规', async () => {
    const server = await start()
    const client = new SlackClient({ webhookUrl: server.url, allowedHosts: ['127.0.0.1'], allowInsecureLoopback: true, minIntervalMs: 0 })

    await client.send(renderNotice({ title: 'Risk denial', lines: ['notional 1200 > 1000'], level: 'warn', ts: 0 }))

    expect(server.violationSummary()).toEqual([])
    expect(server.requests).toHaveLength(1)
    expect(server.requests[0]!.path).toBe('/services/T00000000/B00000000/fixture-secret-value')
    expect(Object.keys(server.requests[0]!.body)).toEqual(['text'])
    expect(server.requests[0]!.text).toBe('[WARN] *Risk denial*\nnotional 1200 &gt; 1000\n1970-01-01T00:00:00.000Z')
  })

  it('动态文本里的 & < > 与 <!channel> 在线上是转义形态，服务器侧无裸 < > &', async () => {
    const server = await start()
    const client = new SlackClient({ webhookUrl: server.url, allowedHosts: ['127.0.0.1'], allowInsecureLoopback: true, minIntervalMs: 0 })

    await client.send(renderNotice({ title: 'a & b', lines: ['<!channel> <https://x|click> 5<6'] }))

    expect(server.violationSummary()).toEqual([])
    const text = server.requests[0]!.text ?? ''
    expect(text).toContain('a &amp; b')
    expect(text).toContain('&lt;!channel&gt;')
    expect(text).not.toContain('<!channel>')
  })

  it('服务器回 429 + Retry-After: 0 → 客户端重试，服务器收到 2 条', async () => {
    const server = await start()
    server.setRespond((index) => (index === 1 ? { status: 429, body: 'ratelimited', headers: { 'retry-after': '0' } } : { status: 200, body: 'ok' }))
    const client = new SlackClient({ webhookUrl: server.url, allowedHosts: ['127.0.0.1'], allowInsecureLoopback: true, minIntervalMs: 0 })

    await client.send('hi')
    expect(server.requests).toHaveLength(2)
    expect(server.violationSummary()).toEqual([])
  })

  it('服务器回 400 invalid_payload → retryable=false，只有 1 条请求', async () => {
    const server = await start()
    server.setRespond(() => ({ status: 400, body: 'invalid_payload' }))
    const client = new SlackClient({ webhookUrl: server.url, allowedHosts: ['127.0.0.1'], allowInsecureLoopback: true, minIntervalMs: 0 })

    const error = await client.send('hi').then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(SlackError)
    expect((error as SlackError).retryable).toBe(false)
    expect((error as SlackError).message).toBe('http_400:invalid_payload')
    expect(server.requests).toHaveLength(1)
  })

  it('超过 40000 字符：0 条请求（一条接管一条消息，不拆分）', async () => {
    const server = await start()
    const client = new SlackClient({ webhookUrl: server.url, allowedHosts: ['127.0.0.1'], allowInsecureLoopback: true, minIntervalMs: 0 })

    await expect(client.send('x'.repeat(40001))).rejects.toBeInstanceOf(SlackError)
    expect(server.requests).toHaveLength(0)
  })
})
