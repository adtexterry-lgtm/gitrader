// SPDX-License-Identifier: CPAL-1.0
// stdio 冒烟：真拉起 `node gsp.mjs`，plugin.hello → tool.call notify_send（内置假 fetch）→ plugin.shutdown，
// 断言应答形状与退出码；stdout 里不许出现 webhook key。全程离线，不读任何真密钥。
import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const GSP = fileURLToPath(new URL('../gsp.mjs', import.meta.url))
const DIR = fileURLToPath(new URL('..', import.meta.url))
const GSP_TOKEN = 'fixture-gsp-token'
const KEY = 'stdio-fixture-webhook-key'
const WEBHOOK = `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${KEY}`

interface Plugin {
  child: ChildProcessWithoutNullStreams
  frames: unknown[]
  stderr: () => string
  exited: Promise<number | null>
}

function startPlugin(env: Record<string, string> = {}): Plugin {
  const child = spawn(process.execPath, [GSP], {
    cwd: DIR,
    env: {
      ...process.env,
      GITRADER_GSP_TOKEN: GSP_TOKEN,
      WECOM_WEBHOOK_URL: WEBHOOK,
      GITRADER_PLUGIN_FAKE_FETCH: '1',
      ...env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const frames: unknown[] = []
  const stderrChunks: string[] = []
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
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    stderrChunks.push(chunk)
  })
  const exited = new Promise<number | null>((resolve) => child.on('close', (code) => resolve(code)))
  return { child, frames, stderr: () => stderrChunks.join(''), exited }
}

async function waitFor(plugin: Plugin, count: number, ms = 8000): Promise<unknown[]> {
  const startedAt = Date.now()
  while (plugin.frames.length < count) {
    if (Date.now() - startedAt > ms) throw new Error(`timed out waiting for ${count} frames (got ${plugin.frames.length})`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return plugin.frames
}

const send = (plugin: Plugin, message: unknown): void => {
  plugin.child.stdin.write(`${JSON.stringify(message)}\n`)
}

const HELLO = {
  jsonrpc: '2.0',
  id: 1,
  method: 'plugin.hello',
  params: { gsp: '0.1.0', token: GSP_TOKEN, plugin: { id: 'connector.gitrader.notify-wecom', version: '0.1.0' }, permissions: ['net.fetch'], config: {} },
}

const CALL = {
  jsonrpc: '2.0',
  id: 3,
  method: 'tool.call',
  params: { tool: 'notify_send', args: { notice: { key: 'takeover:tk_1', level: 'warn', title: 'Risk denial', lines: ['rule Y'] }, params: {} } },
}

describe('GSP stdio', () => {
  it('hello → health → tool.call notify_send → shutdown，退出码 0，stdout 无 key', async () => {
    const plugin = startPlugin()
    try {
      send(plugin, HELLO)
      const afterHello = (await waitFor(plugin, 1)) as { result?: unknown; error?: unknown }[]
      expect(afterHello[0]!.error).toBeUndefined()
      expect(afterHello[0]!.result).toEqual({ gsp: '0.1.0' })

      send(plugin, { jsonrpc: '2.0', id: 2, method: 'plugin.health', params: {} })
      const afterHealth = (await waitFor(plugin, 2)) as { result?: unknown }[]
      expect(afterHealth[1]!.result).toEqual({ ok: true })

      send(plugin, CALL)
      const afterCall = (await waitFor(plugin, 3)) as { result?: Record<string, unknown>; error?: unknown }[]
      expect(afterCall[2]!.error).toBeUndefined()
      expect(afterCall[2]!.result).toEqual({ ok: true })
      expect(JSON.stringify(plugin.frames)).not.toContain(KEY)

      send(plugin, { jsonrpc: '2.0', id: 4, method: 'plugin.shutdown', params: {} })
      expect(await plugin.exited).toBe(0)
    } finally {
      plugin.child.kill()
    }
  }, 20000)

  it('清单未声明的 notify.send 别名被拒（METHOD_NOT_FOUND，不执行工具）', async () => {
    const plugin = startPlugin()
    try {
      send(plugin, HELLO)
      await waitFor(plugin, 1)
      send(plugin, { ...CALL, params: { ...CALL.params, tool: 'notify.send' } })
      const frames = (await waitFor(plugin, 2)) as { result?: Record<string, unknown>; error?: { code: number } }[]
      expect(frames[1]!.result).toBeUndefined()
      expect(frames[1]!.error?.code).toBe(-32601)
      send(plugin, { jsonrpc: '2.0', id: 4, method: 'plugin.shutdown', params: {} })
      expect(await plugin.exited).toBe(0)
    } finally {
      plugin.child.kill()
    }
  }, 20000)

  it('{name,input} 旧写法被拒（-32601）：只认内核发的 {tool,args}', async () => {
    const plugin = startPlugin()
    try {
      send(plugin, HELLO)
      await waitFor(plugin, 1)
      send(plugin, { jsonrpc: '2.0', id: 2, method: 'tool.call', params: { name: 'notify_send', input: CALL.params.args } })
      const frames = (await waitFor(plugin, 2)) as { result?: unknown; error?: { code: number } }[]
      expect(frames[1]!.result).toBeUndefined()
      // 旧写法里没有 params.tool，按「未知工具」拒绝（不再回退到 params.name）
      expect(frames[1]!.error?.code).toBe(-32601)
      send(plugin, { jsonrpc: '2.0', id: 3, method: 'plugin.shutdown', params: {} })
      expect(await plugin.exited).toBe(0)
    } finally {
      plugin.child.kill()
    }
  }, 20000)

  it('写 21 帧后立即 stdin.end()：应答 id 序列完整、退出码 0（L5-11 stdout flush 收尾）', async () => {
    const plugin = startPlugin()
    try {
      send(plugin, HELLO)
      for (let id = 2; id <= 21; id++) send(plugin, { jsonrpc: '2.0', id, method: 'plugin.health', params: {} })
      // 21 帧一次性写入后立即关 stdin：进程退出前必须把 21 条应答都刷出去
      plugin.child.stdin.end()
      expect(await plugin.exited).toBe(0)
      const ids = (plugin.frames as { id: number }[]).map((frame) => frame.id)
      expect(ids).toEqual(Array.from({ length: 21 }, (_, i) => i + 1))
    } finally {
      plugin.child.kill()
    }
  }, 20000)

  it('缺 GITRADER_GSP_TOKEN → 退出码 2（不进入协议循环）', async () => {
    const plugin = startPlugin({ GITRADER_GSP_TOKEN: '' })
    expect(await plugin.exited).toBe(2)
    // stdio 关闭后 stderr 数据可能还在通道里，等一拍再断言
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(plugin.stderr()).toContain('GSP channel token is required')
    expect(plugin.frames).toHaveLength(0)
  }, 20000)
})
