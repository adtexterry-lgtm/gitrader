// SPDX-License-Identifier: CPAL-1.0
// stdio 冒烟：真拉起 `node gsp.mjs`，plugin.hello → tool.call notify.send（假 fetch）→ plugin.shutdown，
// 断言应答形状与退出码 0。全程离线，不读任何真密钥。
import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const GSP = fileURLToPath(new URL('../gsp.mjs', import.meta.url))
const DIR = fileURLToPath(new URL('..', import.meta.url))
const GSP_TOKEN = 'fixture-gsp-token'
const BOT_TOKEN = '999:fixture-bot-token'

interface Plugin {
  child: ChildProcessWithoutNullStreams
  frames: unknown[]
  exited: Promise<number | null>
}

function startPlugin(): Plugin {
  const child = spawn(process.execPath, [GSP], {
    cwd: DIR,
    env: {
      ...process.env,
      GITRADER_GSP_TOKEN: GSP_TOKEN,
      TELEGRAM_BOT_TOKEN: BOT_TOKEN,
      GITRADER_PLUGIN_FAKE_FETCH: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const frames: unknown[] = []
  let buffer = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk
    let at: number
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at)
      buffer = buffer.slice(at + 1)
      if (line.trim()) frames.push(JSON.parse(line))
    }
  })
  const exited = new Promise<number | null>((resolve) => child.on('close', (code) => resolve(code)))
  return { child, frames, exited }
}

async function waitFor(plugin: Plugin, count: number, ms = 8000): Promise<unknown[]> {
  const startedAt = Date.now()
  while (plugin.frames.length < count) {
    if (Date.now() - startedAt > ms) throw new Error(`timed out waiting for ${count} frames (got ${plugin.frames.length})`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return plugin.frames
}

function send(plugin: Plugin, message: unknown): void {
  plugin.child.stdin.write(`${JSON.stringify(message)}\n`)
}

describe('GSP stdio', () => {
  it('hello → tool.call notify.send → shutdown', async () => {
    const plugin = startPlugin()
    try {
      send(plugin, { jsonrpc: '2.0', id: 1, method: 'plugin.hello', params: { gsp: '0.1.0', token: GSP_TOKEN, plugin: { id: 'connector.gitrader.notify-telegram', version: '0.1.0' }, permissions: ['net.fetch'], config: {} } })
      const afterHello = (await waitFor(plugin, 1)) as { id: number; result?: { gsp?: string }; error?: unknown }[]
      expect(afterHello[0]!.error).toBeUndefined()
      expect(afterHello[0]!.result).toEqual({ gsp: '0.1.0' })

      send(plugin, { jsonrpc: '2.0', id: 2, method: 'plugin.health', params: {} })
      const afterHealth = (await waitFor(plugin, 2)) as { id: number; result?: unknown }[]
      expect(afterHealth[1]!.result).toEqual({ ok: true })

      send(plugin, { jsonrpc: '2.0', id: 3, method: 'tool.call', params: { tool: 'notify_send', args: { notice: { key: 'k', level: 'warn', title: 'Risk denial', lines: ['rule Y'] }, params: { chatId: '123' } } } })
      const afterCall = (await waitFor(plugin, 3)) as { id: number; result?: Record<string, unknown>; error?: unknown }[]
      expect(afterCall[2]!.error).toBeUndefined()
      expect(afterCall[2]!.result).toEqual({ ok: true, ref: '4242' })

      // stdout 里不能出现令牌
      expect(JSON.stringify(plugin.frames)).not.toContain(BOT_TOKEN)

      send(plugin, { jsonrpc: '2.0', id: 4, method: 'plugin.shutdown', params: {} })
      const code = await plugin.exited
      expect(code).toBe(0)
    } finally {
      plugin.child.kill()
    }
  })

  it('清单未声明的 notify.send 别名被拒（METHOD_NOT_FOUND），{name,input} 旧写法同样不再接受', async () => {
    const plugin = startPlugin()
    try {
      send(plugin, { jsonrpc: '2.0', id: 1, method: 'plugin.hello', params: { gsp: '0.1.0', token: GSP_TOKEN, plugin: { id: 'connector.gitrader.notify-telegram', version: '0.1.0' }, permissions: ['net.fetch'], config: {} } })
      await waitFor(plugin, 1)
      const args = { notice: { key: 'k', level: 'warn', title: 'Risk denial', lines: ['rule Y'] }, params: { chatId: '123' } }
      send(plugin, { jsonrpc: '2.0', id: 2, method: 'tool.call', params: { tool: 'notify.send', args } })
      send(plugin, { jsonrpc: '2.0', id: 3, method: 'tool.call', params: { name: 'notify_send', input: args } })
      const frames = (await waitFor(plugin, 3)) as { error?: { code: number }; result?: unknown }[]
      expect(frames[1]!.error?.code).toBe(-32601)
      // 旧写法的帧里没有 params.tool，按「未知工具」拒绝（不再回退到 params.name）
      expect(frames[2]!.error?.code).toBe(-32601)
      send(plugin, { jsonrpc: '2.0', id: 4, method: 'plugin.shutdown', params: {} })
      expect(await plugin.exited).toBe(0)
    } finally {
      plugin.child.kill()
    }
  })

  it('stdin 立刻关闭时已排队的应答仍写出（L5-11：不等 flush 就 exit 会丢帧）', async () => {
    const plugin = startPlugin()
    try {
      send(plugin, { jsonrpc: '2.0', id: 1, method: 'plugin.hello', params: { gsp: '0.1.0', token: GSP_TOKEN, plugin: { id: 'connector.gitrader.notify-telegram', version: '0.1.0' }, permissions: ['net.fetch'], config: {} } })
      for (let id = 2; id <= 21; id++) send(plugin, { jsonrpc: '2.0', id, method: 'plugin.health', params: {} })
      // 21 帧一次性写入后立即关 stdin：进程退出前必须把 21 条应答都刷出去
      plugin.child.stdin.end()
      const code = await plugin.exited
      expect(code).toBe(0)
      const ids = (plugin.frames as { id: number }[]).map((frame) => frame.id)
      expect(ids).toEqual(Array.from({ length: 21 }, (_, i) => i + 1))
    } finally {
      plugin.child.kill()
    }
  })
})
