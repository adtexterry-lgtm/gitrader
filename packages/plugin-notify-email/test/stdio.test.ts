// SPDX-License-Identifier: CPAL-1.0
// stdio 冒烟：spawn node gsp.mjs，走 plugin.hello → plugin.describe → tool.call notify.send（假连接）→ plugin.shutdown。
// 另测：缺令牌退出码 2；错令牌 5003 后退出码 1；未 hello 的请求一律 5003。
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { PluginManifest } from '@gitrader/protocol'
import { describe, expect, it } from 'vitest'

const dir = fileURLToPath(new URL('..', import.meta.url))
const ENTRY = join(dir, 'gsp.mjs')
const manifest = JSON.parse(readFileSync(join(dir, 'gitrader-plugin.json'), 'utf8')) as PluginManifest

interface Frame {
  id: number | null
  result?: unknown
  error?: { code: number; message: string; data?: { code: number; name: string; category: string } }
}

const ARGS = {
  notice: {
    key: 'risk.denials:acct_x:ruleY',
    level: 'warn',
    title: 'Risk denial',
    lines: ['account acct_x', 'rule Y', 'notional 1200 > 1000'],
    ts: 1760000000000,
    topic: 'risk.denials',
  },
  params: { host: 'localhost', port: 2525, secure: false, from: 'bot@localhost', to: ['ops@localhost'] },
}

/** 极简 stdio 客户端：一行一帧，按 id 取应答。 */
class Session {
  readonly child: ChildProcessWithoutNullStreams
  stderr = ''
  private buffer = ''
  private readonly frames = new Map<number, Frame>()

  constructor(env: Record<string, string>) {
    // 空字符串 = 显式不设该变量（Node 在 Windows 上会把 env:'' 传成空串，这里直接删键更贴近真实缺省）
    const merged: Record<string, string | undefined> = { ...process.env, ...env }
    for (const [key, value] of Object.entries(env)) if (value === '') delete merged[key]
    this.child = spawn(process.execPath, [ENTRY], {
      cwd: dir,
      env: merged,
      windowsHide: true,
    })
    this.child.stdout.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf8')
      let idx = this.buffer.indexOf('\n')
      while (idx >= 0) {
        const line = this.buffer.slice(0, idx).trim()
        this.buffer = this.buffer.slice(idx + 1)
        if (line.length > 0) {
          const frame = JSON.parse(line) as Frame
          this.frames.set(Number(frame.id), frame)
        }
        idx = this.buffer.indexOf('\n')
      }
    })
    this.child.stderr.on('data', (chunk: Buffer) => {
      this.stderr += chunk.toString('utf8')
    })
  }

  send(value: unknown): void {
    this.child.stdin.write(`${JSON.stringify(value)}\n`)
  }

  async request(id: number, method: string, params: unknown): Promise<Frame> {
    this.send({ jsonrpc: '2.0', id, method, params })
    const deadline = Date.now() + 5000
    for (;;) {
      const frame = this.frames.get(id)
      if (frame !== undefined) {
        this.frames.delete(id)
        return frame
      }
      if (Date.now() > deadline) throw new Error(`timeout waiting for frame ${id}`)
      await new Promise<void>((resolve) => setTimeout(resolve, 10))
    }
  }

  exitCode(timeoutMs = 5000): Promise<number | null> {
    if (this.child.exitCode !== null) return Promise.resolve(this.child.exitCode)
    return new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('child did not exit')), timeoutMs)
      this.child.once('exit', (code) => {
        clearTimeout(timer)
        resolve(code)
      })
    })
  }

  kill(): void {
    if (this.child.exitCode === null) this.child.kill()
  }
}

const VALID = { GITRADER_GSP_TOKEN: 'fixture-token', GITRADER_PLUGIN_FAKE_FETCH: '1' }

describe('gsp.mjs（stdio 冒烟）', () => {
  it('hello → describe（清单同源）→ tool.call notify.send → shutdown，退出码 0', async () => {
    const session = new Session(VALID)
    try {
      const hello = await session.request(1, 'plugin.hello', { gsp: '0.1.0', token: 'fixture-token' })
      expect(hello.error).toBeUndefined()
      expect(hello.result).toEqual({ gsp: '0.1.0' })

      const describe = await session.request(2, 'plugin.describe', {})
      expect(describe.error).toBeUndefined()
      expect(describe.result).toEqual(manifest)

      const call = await session.request(3, 'tool.call', { tool: 'notify_send', args: ARGS })
      expect(call.error).toBeUndefined()
      expect(call.result).toEqual({ ok: true, ref: 'fake-smtp-1' })

      // 清单没声明的 B0 别名不再分发：插件端只认 notify_send（L5-10）
      const alias = await session.request(3, 'tool.call', { tool: 'notify.send', args: ARGS })
      expect(alias.error?.code).toBe(-32601)

      const unknown = await session.request(4, 'tool.call', { tool: 'gsp_unknown_tool', args: {} })
      expect(unknown.error?.code).toBe(-32601)

      const bye = await session.request(5, 'plugin.shutdown', {})
      expect(bye.result).toEqual({ ok: true })
      expect(await session.exitCode()).toBe(0)
    } finally {
      session.kill()
    }
  })

  it('缺 GITRADER_GSP_TOKEN → stderr 一行、退出码 2', async () => {
    const session = new Session({ GITRADER_GSP_TOKEN: '', GITRADER_PLUGIN_FAKE_FETCH: '1' })
    try {
      expect(await session.exitCode()).toBe(2)
      expect(session.stderr).toContain('token')
    } finally {
      session.kill()
    }
  })

  it('错令牌 → 5003（Problem data 带码与类别），进程 1 s 内以退出码 1 结束', async () => {
    const session = new Session(VALID)
    try {
      const startedAt = Date.now()
      const frame = await session.request(1, 'plugin.hello', { gsp: '0.1.0', token: 'wrong-token' })
      expect(frame.error?.code).toBe(5003)
      expect(frame.error?.data).toMatchObject({ code: 5003, category: 'PROTOCOL' })
      expect(frame.error?.message).not.toContain('wrong-token')
      expect(await session.exitCode()).toBe(1)
      expect(Date.now() - startedAt).toBeLessThan(2000)
    } finally {
      session.kill()
    }
  })

  it('未 hello 就 tool.call → 5003；版本 9.9.0 → 5001', async () => {
    const session = new Session(VALID)
    try {
      const before = await session.request(1, 'plugin.health', {})
      expect(before.error?.code).toBe(5003)

      const badVersion = await session.request(2, 'plugin.hello', { gsp: '9.9.0', token: 'fixture-token' })
      expect(badVersion.error?.code).toBe(5001)

      const good = await session.request(3, 'plugin.hello', { gsp: '0.1.9', token: 'fixture-token' })
      expect(good.error).toBeUndefined()
      expect(good.result).toEqual({ gsp: '0.1.0' })

      // 请求参数里出现口令样子字段 → 5006，且不回显请求值
      const secret = await session.request(4, 'tool.call', { tool: 'notify_send', args: { nested: [{ password: 'fixture-only' }] } })
      expect(secret.error?.code).toBe(5006)
      expect(JSON.stringify(secret)).not.toContain('fixture-only')

      const bye = await session.request(5, 'plugin.shutdown', {})
      expect(bye.result).toEqual({ ok: true })
      expect(await session.exitCode()).toBe(0)
    } finally {
      session.kill()
    }
  })
})
