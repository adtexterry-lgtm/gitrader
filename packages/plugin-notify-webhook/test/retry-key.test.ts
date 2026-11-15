// SPDX-License-Identifier: CPAL-1.0
// R2-REL-03：一条通知在一个通道上最多 3 次 HTTP 尝试（插件 3 次，内核不再叠加），退避递增，
// 每次请求都带同一个 X-Gitrader-Notice-Key；一个通道的请求挂着不挡同一个插件进程里的别的通道。
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { notifySend } from '../index.mjs'
import { markExhausted } from '../gsp.mjs'
import { WebhookClient, buildWebhookRequest, noticeKeyValue } from '../webhook.mjs'

const dir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const KEY = 'b0f5c2d1e9a84c7f9a3d6e1b2c4d5e6f7a8b9c0d1e2f30415263748596a7b8c9'
const notice = { key: KEY, level: 'critical', title: 'Takeover', lines: ['takeoverId: t1'], ts: 1760000000000, topic: 'takeover.alert' }
const params = { url: 'https://ntfy.internal/alerts' }

interface Call { url: string; headers: Record<string, string> }
function failingFetch(kind: '503' | 'abort') {
  const calls: Call[] = []
  const fetch = async (url: string, init: { headers: Record<string, string> }): Promise<{ status: number; text: () => Promise<string> }> => {
    calls.push({ url, headers: init.headers })
    if (kind === 'abort') { const error = new Error('aborted'); error.name = 'AbortError'; throw error }
    return { status: 503, text: async () => '' }
  }
  return { calls, fetch }
}

describe('R2-REL-03 重试上限、退避与去重键', () => {
  it('[R6F-NQ3] 5xx/timeout: at most 3 HTTP attempts per notice per channel in total, growing backoff, same X-Gitrader-Notice-Key on every attempt', async () => {
    for (const kind of ['503', 'abort'] as const) {
      const delays: number[] = []
      const { calls, fetch } = failingFetch(kind)
      const result = await notifySend({ notice, params }, { fetch, env: {}, sleep: async (ms: number) => { delays.push(ms) }, timeoutMs: 5 })
      expect(calls, kind).toHaveLength(3)
      expect(new Set(calls.map(c => c.headers['X-Gitrader-Notice-Key'])), kind).toEqual(new Set([KEY]))
      expect(delays[0]).toBeGreaterThanOrEqual(200)
      expect(delays[1]).toBeGreaterThan(delays[0]!)
      expect(result.ok).toBe(false)
      // 经 stdio 交给内核的结果：可重试 = 插件已重试到头，内核不再叠加
      expect(markExhausted(result)).toMatchObject({ ok: false, retryable: true, exhausted: true })
    }
    expect(markExhausted({ ok: true })).toEqual({ ok: true })
    expect(markExhausted({ ok: false, reason: 'http_400', retryable: false })).toEqual({ ok: false, reason: 'http_400', retryable: false })
  })

  it('默认退避带抖动：首次重试不早于 250 ms，两次间隔严格递增（真实计时）', async () => {
    const stamps: number[] = []
    const fetch = async (): Promise<{ status: number; text: () => Promise<string> }> => { stamps.push(Date.now()); return { status: 503, text: async () => '' } }
    const client = new WebhookClient({ url: 'https://ntfy.internal/alerts', fetch })
    expect((await client.send('x', { noticeKey: KEY })).ok).toBe(false)
    expect(stamps).toHaveLength(3)
    const gaps = [stamps[1]! - stamps[0]!, stamps[2]! - stamps[1]!]
    expect(gaps[0]).toBeGreaterThanOrEqual(240)
    expect(gaps[1]).toBeGreaterThan(gaps[0]!)
  })

  it('去重键进所有方言的请求头；长正文分块时每块的键不同但确定；怪键用 sha256 且稳定', () => {
    for (const url of [
      'https://open.feishu.cn/open-apis/bot/v2/hook/abc', 'https://oapi.dingtalk.com/robot/send?access_token=t', 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=k',
      'https://hooks.slack.com/services/T/B/x', 'https://discord.com/api/webhooks/1/x', 'https://ntfy.internal/alerts',
    ]) {
      const dialect = url.includes('feishu') ? 'feishu' : url.includes('dingtalk') ? 'dingtalk' : url.includes('weixin') ? 'wecom' : url.includes('slack') ? 'slack' : url.includes('discord') ? 'discord' : 'generic'
      expect(buildWebhookRequest(dialect, url, 'hi', { noticeKey: KEY }).headers['X-Gitrader-Notice-Key'], dialect).toBe(KEY)
      expect(buildWebhookRequest(dialect, url, 'hi').headers['X-Gitrader-Notice-Key'], dialect).toBeUndefined()
    }
    expect(noticeKeyValue(KEY, 2)).toBe(`${KEY}#2`)
    const odd = noticeKeyValue('带 空格 的键')
    expect(odd).toMatch(/^[0-9a-f]{64}$/)
    expect(noticeKeyValue('带 空格 的键')).toBe(odd)
    expect(noticeKeyValue('')).toBeUndefined()
  })

  it('分块发送：每块带自己的确定键，重试时同一块的键不变', async () => {
    const calls: Call[] = []
    const fetch = async (url: string, init: { headers: Record<string, string> }): Promise<{ status: number; text: () => Promise<string> }> => {
      calls.push({ url, headers: init.headers })
      return { status: calls.length === 2 ? 503 : 204, text: async () => '' }
    }
    const long = { ...notice, lines: ['x'.repeat(2000), 'y'.repeat(2000)] }
    const result = await notifySend({ notice: long, params: { url: 'https://discord.com/api/webhooks/1/x' } }, { fetch, env: {}, sleep: async () => {} })
    expect(result).toEqual({ ok: true })
    expect(calls.map(c => c.headers['X-Gitrader-Notice-Key'])).toEqual([KEY, `${KEY}#1`, `${KEY}#1`, `${KEY}#2`])
  })
})

describe('R2-REL-03 同一个插件进程里的通道互不阻塞', () => {
  const children: ReturnType<typeof spawn>[] = []
  afterEach(() => { for (const c of children.splice(0)) c.kill() })

  it('一个通道的请求挂着（慢 Webhook）时，另一个通道的请求照常返回', async () => {
    const server = createServer((req, res) => {
      if (req.url === '/slow') setTimeout(() => { res.statusCode = 200; res.end('ok') }, 1500)
      else { res.statusCode = 200; res.end('ok') }
    })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as AddressInfo).port
    const child = spawn(process.execPath, [join(dir, 'gsp.mjs')], { cwd: dir, env: { ...process.env, GITRADER_GSP_TOKEN: 'tok' }, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
    children.push(child)
    const arrivals: number[] = []
    let buffer = ''
    const done = new Promise<void>((resolveAll, reject) => {
      const timer = setTimeout(() => reject(new Error('no responses')), 10_000)
      child.stdout!.setEncoding('utf8').on('data', (chunk: string) => {
        buffer += chunk
        let i: number
        while ((i = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, i); buffer = buffer.slice(i + 1)
          if (!line.trim()) continue
          const frame = JSON.parse(line) as { id: number; result?: { ok?: boolean } }
          if (frame.id >= 2) arrivals.push(frame.id)
          if (arrivals.length === 2) { clearTimeout(timer); resolveAll() }
        }
      })
    })
    const send = (frame: Record<string, unknown>): void => { child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', ...frame })}\n`) }
    send({ id: 1, method: 'plugin.hello', params: { gsp: '0.1.0', token: 'tok' } })
    await new Promise(r => setTimeout(r, 400))
    const call = (id: number, path: string) => send({ id, method: 'tool.call', params: { tool: 'notify_send', args: { notice, params: { url: `http://127.0.0.1:${port}${path}` } } } })
    call(2, '/slow')
    call(3, '/fast')
    await done
    expect(arrivals).toEqual([3, 2])
    child.stdin!.end()
    await new Promise<void>(r => server.close(() => r()))
  }, 20_000)
})
