// SPDX-License-Identifier: CPAL-1.0
// 引擎监管（v0.1.2：不限语言、不限跑在哪）：任意语言子进程 { command, args, env, cwd } 与远程 { url, auth }。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { WebSocketServer } from 'ws'
import { EngineSupervisor } from '../src/engines'
import type { EngineHandle } from '../src/engines'
import { makeHarness } from './helpers/harness'
import type { Harness } from './helpers/harness'

let h: Harness
let sup: EngineSupervisor
beforeEach(async () => { h = await makeHarness(); sup = new EngineSupervisor({ clock: h.clock, events: h.k.events, ledger: h.k.ledger, backoffMinMs: 20, backoffMaxMs: 80, resolveSecret: (ref) => (ref === 'tok-1' ? 'secret-token' : undefined) }) })
afterEach(async () => { await sup.stopAll(300); await h.cleanup() })

const until = async (f: () => boolean, ms = 4000): Promise<void> => { for (let i = 0; i < ms / 25 && !f(); i++) await new Promise((r) => setTimeout(r, 25)); expect(f()).toBe(true) }
const state = (id: string): string => sup.status().find((e) => e.id === id)!.state
function script(name: string, body: string): string {
  const dir = join(h.home, 'eng'); mkdirSync(dir, { recursive: true })
  const f = join(dir, name); writeFileSync(f, body); return f
}

describe('本地任意语言子进程（这里用 node 脚本代表"任意语言"）', () => {
  it('拉起 → ready → 经 stdio NDJSON 往返；env 只传显式列出的 + GITRADER_GEP_TOKEN，不继承宿主密钥', async () => {
    process.env.OPENAI_API_KEY = 'sk-not-real'
    try {
      const f = script('echo.mjs', `process.stdin.setEncoding('utf8'); process.stdin.on('data', (d) => { for (const l of d.split('\\n').filter(Boolean)) process.stdout.write(JSON.stringify({ echo: JSON.parse(l), env: Object.keys(process.env), my: process.env.MY_FLAG, cwd: process.cwd() }) + '\\n') })`)
      sup.load([{ id: 'e1', enabled: true, launch: { command: process.execPath, args: [f], env: { MY_FLAG: 'on' }, cwd: h.home } }])
      let handle: EngineHandle | undefined
      sup.onConnected((_id, hd) => { handle = hd })
      sup.start('e1')
      await until(() => state('e1') === 'ready' && !!handle)
      const got: any[] = [] // eslint-disable-line @typescript-eslint/no-explicit-any
      if (handle!.kind === 'stdio') handle!.onLine((l) => got.push(JSON.parse(l)))
      handle!.send(JSON.stringify({ hi: 1 }))
      await until(() => got.length === 1)
      expect(got[0].echo).toEqual({ hi: 1 })
      expect(got[0].my).toBe('on')
      expect(got[0].cwd.toLowerCase()).toBe(h.home.toLowerCase())
      const keys = (got[0].env as string[]).map((k) => k.toUpperCase())
      expect(keys).toContain('GITRADER_GEP_TOKEN')
      expect(keys).not.toContain('OPENAI_API_KEY')
      expect(sup.status()[0]).toMatchObject({ transport: 'stdio', remote: false })
      expect(sup.status()[0]!.pid).toBeGreaterThan(0)
    } finally { delete process.env.OPENAI_API_KEY }
  })

  it('崩溃 → 退避重启；10 分钟内崩 5 次 → failed 并说明原因；状态变化入账', async () => {
    const f = script('crash.mjs', `setTimeout(() => process.exit(1), 30)`)
    sup.load([{ id: 'crashy', enabled: true, launch: { command: process.execPath, args: [f] } }])
    sup.start('crashy')
    await until(() => state('crashy') === 'failed', 8000)
    const st = sup.status()[0]!
    expect(st.restarts).toBeGreaterThanOrEqual(4)
    expect(st.detail).toMatch(/5 crashes within 10 minutes/)
    expect(h.k.ledger.query({ types: ['engine.health_changed'], limit: 50 }).some((e) => (e.payload as any).to === 'failed')).toBe(true)
  })

  it('命令不存在（任意语言的可执行文件没装）→ 不崩内核，进入退避并报明原因', async () => {
    sup.load([{ id: 'nope', enabled: true, launch: { command: 'definitely-not-a-real-binary-xyz' } }])
    sup.start('nope')
    await until(() => ['degraded', 'failed'].includes(state('nope')))
    expect(sup.status()[0]!.detail).toMatch(/ENOENT|process error|spawn/i)
  })

  it('stop：按自己持有的子进程句柄结束，进程确实没了；之后不再重启', async () => {
    const f = script('idle.mjs', `setInterval(() => {}, 1000)`)
    sup.load([{ id: 'idle', enabled: true, launch: { command: process.execPath, args: [f] } }])
    sup.start('idle')
    await until(() => state('idle') === 'ready')
    const pid = sup.status()[0]!.pid!
    await sup.stop('idle', 300)
    expect(state('idle')).toBe('stopped')
    expect(() => process.kill(pid, 0)).toThrow()
    await new Promise((r) => setTimeout(r, 200))
    expect(state('idle')).toBe('stopped')
  })

  it('内置参考引擎不起子进程；未启用的不被 startAll 拉起', async () => {
    sup.load([{ id: 'gitrader-core', enabled: true, builtin: true }, { id: 'off', enabled: false, launch: { command: process.execPath, args: ['-e', ''] } }])
    sup.startAll()
    expect(sup.status().find((e) => e.id === 'gitrader-core')).toMatchObject({ builtin: true, state: 'ready', transport: 'builtin', pid: null })
    expect(state('off')).toBe('stopped')
  })
})

describe('远程 / 本地 ws 引擎 { url, auth }', () => {
  async function server(): Promise<{ wss: WebSocketServer; port: number; conns: number; kick(): void }> {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await new Promise((r) => wss.once('listening', r))
    const o = { wss, port: (wss.address() as { port: number }).port, conns: 0, kick: () => { for (const c of wss.clients) c.terminate() } }
    wss.on('connection', () => { o.conns++ })
    return o
  }

  it('连接 → ready（令牌句柄经 resolveSecret 取，配置里没有明文）；断线 → degraded → 退避重连；stop 关闭', async () => {
    const s = await server()
    try {
      sup.load([{ id: 'r1', enabled: true, launch: { url: `ws://127.0.0.1:${s.port}/gep`, auth: { method: 'token', tokenRef: 'tok-1' } } }])
      sup.start('r1')
      await until(() => state('r1') === 'ready')
      expect(sup.status()[0]).toMatchObject({ transport: 'ws', remote: false })
      s.kick()
      await until(() => s.conns >= 2 && state('r1') === 'ready', 6000)
      expect(sup.status()[0]!.restarts).toBeGreaterThanOrEqual(1)
      await sup.stop('r1')
      expect(state('r1')).toBe('stopped')
    } finally { s.wss.close() }
  })

  it('令牌句柄解析不出来 → failed 并说明；非 loopback 的 wss 标"远程引擎"', async () => {
    sup.load([{ id: 'r2', enabled: true, launch: { url: 'ws://127.0.0.1:1/gep', auth: { method: 'token', tokenRef: 'missing' } } }, { id: 'r3', enabled: false, launch: { url: 'wss://engine.example.test/gep', auth: { method: 'token', tokenRef: 'tok-1' } } }])
    sup.start('r2')
    expect(state('r2')).toBe('failed')
    expect(sup.status().find((e) => e.id === 'r2')!.detail).toMatch(/cannot resolve tokenRef/)
    expect(sup.status().find((e) => e.id === 'r3')).toMatchObject({ remote: true, transport: 'wss' })
  })
})
