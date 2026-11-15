// SPDX-License-Identifier: CPAL-1.0
// stdio 冒烟：spawn `node gsp.mjs`，plugin.hello → tool.call notify.send（假 fetch）→ 断言应答形状 → shutdown 退出码 0。
// 顺带验令牌缺失（退出码 2）与令牌不对（5003 + 退出码 1）。
import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const dir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TOKEN = 'smoke-token'

interface Frame { jsonrpc?: string; id?: number | null; result?: Record<string, unknown>; error?: { code: number; data?: { category?: string } } }

function start(env: Record<string, string> = {}): {
  child: ReturnType<typeof spawn>
  request: (frame: Record<string, unknown>, id: number) => Promise<Frame>
  closed: Promise<number | null>
  stderr: () => string
} {
  const child = spawn(process.execPath, [join(dir, 'gsp.mjs')], {
    cwd: dir,
    env: { ...process.env, GITRADER_GSP_TOKEN: TOKEN, GITRADER_PLUGIN_FAKE_FETCH: '1', ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let buffer = ''
  let stderr = ''
  const waiting: { id: number; resolve: (frame: Frame) => void; reject: (error: Error) => void }[] = []
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    buffer += chunk
    let index: number
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (line === '') continue
      const frame = JSON.parse(line) as Frame
      const slot = waiting.findIndex((entry) => entry.id === frame.id)
      if (slot >= 0) waiting.splice(slot, 1)[0]!.resolve(frame)
    }
  })
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
  const closed = new Promise<number | null>((resolveClose) => child.once('close', (code) => resolveClose(code)))
  return {
    child,
    request(frame, id) {
      return new Promise<Frame>((resolveFrame, rejectFrame) => {
        waiting.push({ id, resolve: resolveFrame, reject: rejectFrame })
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, ...frame })}\n`)
        setTimeout(() => rejectFrame(new Error(`timeout waiting for id ${id}`)), 5000).unref()
      })
    },
    closed,
    stderr: () => stderr,
  }
}

const hello = (extra: Record<string, unknown> = {}) => ({ method: 'plugin.hello', params: { gsp: '0.1.0', token: TOKEN, plugin: { id: 'connector.gitrader.notify-webhook', version: '0.1.0' }, ...extra } })
const args = {
  notice: { key: 'risk.denials:acct_x:ruleY', level: 'warn', title: 'Risk denial', lines: ['account acct_x', 'rule Y'], ts: 1760000000000, topic: 'risk.denials' },
  params: { url: 'https://open.feishu.cn/open-apis/bot/v2/hook/smoke' },
}

describe('stdio 冒烟（GSP）', () => {
  it('hello → tool.call notify.send（假 fetch）→ shutdown：应答形状与退出码', async () => {
    const session = start()
    try {
      const greeted = await session.request(hello(), 1)
      expect(greeted.error).toBeUndefined()
      expect(greeted.result).toMatchObject({ gsp: '0.1.0' })

      const described = await session.request({ method: 'plugin.describe', params: {} }, 2)
      expect(described.error).toBeUndefined()
      expect((described.result!.tools as { name: string }[])[0]!.name).toBe('notify_send')

      // B0 契约里的点号名字照收
      const sent = await session.request({ method: 'tool.call', params: { tool: 'notify_send', args } }, 3)
      expect(sent.error).toBeUndefined()
      expect(sent.result).toEqual({ ok: true, ref: 'fake-webhook-1' })

      // 清单里声明的名字同样可用
      const sentAgain = await session.request({ method: 'tool.call', params: { tool: 'notify_send', args } }, 4)
      expect(sentAgain.result).toEqual({ ok: true, ref: 'fake-webhook-1' })

      const shutdown = await session.request({ method: 'plugin.shutdown', params: {} }, 5)
      expect(shutdown.error).toBeUndefined()
      expect(await session.closed).toBe(0)
    } finally {
      session.child.kill()
    }
  })

  it('坏形状的参数走 JSON-RPC 错误而不是崩进程；未知工具 -32601', async () => {
    const session = start()
    try {
      expect((await session.request(hello(), 1)).error).toBeUndefined()
      const bad = await session.request({ method: 'tool.call', params: { tool: 'notify_send', args: 'invalid' } }, 2)
      expect(bad.error?.code).toBe(-32602)
      expect(bad.error?.data?.category).toBe('PROTOCOL')
      const unknown = await session.request({ method: 'tool.call', params: { tool: 'nope', args: {} } }, 3)
      expect(unknown.error?.code).toBe(-32601)
      await session.request({ method: 'plugin.shutdown', params: {} }, 4)
      expect(await session.closed).toBe(0)
    } finally {
      session.child.kill()
    }
  })

  it('没有 GITRADER_GSP_TOKEN：stderr 一行、退出码 2', async () => {
    const session = start({ GITRADER_GSP_TOKEN: '' })
    try {
      expect(await session.closed).toBe(2)
      expect(session.stderr().trim().split('\n')).toHaveLength(1)
    } finally {
      session.child.kill()
    }
  })

  it('令牌不对：5003 且一秒内退出（退出码 1）', async () => {
    const session = start()
    try {
      const started = Date.now()
      const rejected = await session.request({ method: 'plugin.hello', params: { gsp: '0.1.0', token: 'wrong' } }, 1)
      expect(rejected.error?.code).toBe(5003)
      expect(await session.closed).toBe(1)
      expect(Date.now() - started).toBeLessThan(1000)
    } finally {
      session.child.kill()
    }
  })
})
