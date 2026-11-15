// SPDX-License-Identifier: CPAL-1.0
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { once } from 'node:events'
import { WebSocketServer } from 'ws'
import { PluginHost, MANIFEST_FILE, pinPluginDir } from '../src/plugins'
import { pluginLaunch } from '../src/plugin-transport'
import { makeHarness, type Harness } from './helpers/harness'

let h: Harness
let host: PluginHost
let server: WebSocketServer | undefined
const token = randomBytes(24).toString('hex')
const id = 'skill.test.exec'
const script = `
import { createInterface } from 'node:readline'
let health = 0
createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line)
  let result = { ok: true }
  if (m.method === 'plugin.hello' && m.params.token !== process.env.GITRADER_GSP_TOKEN) return process.exit(1)
  if (m.method === 'plugin.health') health++
  if (m.method === 'tool.call') {
    if (m.params.tool === 'crash') return process.exit(3)
    result = { keys: Object.keys(process.env), explicit: process.env.EXPLICIT_VALUE, cwd: process.cwd(), pid: process.pid, health }
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n')
  if (m.method === 'plugin.shutdown') setTimeout(() => process.exit(0), 10)
})
`

beforeEach(async () => {
  h = await makeHarness()
  host = new PluginHost({
    home: h.home, pluginsDir: h.k.paths.plugins, docs: h.k.docs, ledger: h.k.ledger,
    events: h.k.events, clock: h.clock, developerMode: () => true, trustRoots: () => [],
    backoffMinMs: 80, backoffMaxMs: 100, healthIntervalMs: 40, healthTimeoutMs: 100,
    shutdownGraceMs: 300, stdioCloseGraceMs: 100,
    resolveSecret: (ref: string) => ref === 'test-channel' ? token : undefined,
  })
})
afterEach(async () => {
  await host?.stopAll()
  if (server) {
    for (const client of server.clients) client.terminate()
    await new Promise<void>(resolve => server!.close(() => resolve()))
    server = undefined
  }
  vi.unstubAllEnvs()
  await h?.cleanup()
})

async function install(runtime = 'sidecar', remote?: { url: string; ref?: string }, options: { source?: string; launch?: Record<string, unknown>; module?: string; inspectOnly?: boolean } = {}): Promise<string> {
  const dir = join(h.k.paths.plugins, 'exec')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'plugin.mjs'), options.source ?? script)
  writeFileSync(join(dir, MANIFEST_FILE), JSON.stringify({
    schema: 'gitrader-plugin/1', id, package: 'skill', kind: 'skill', name: 'Executable example',
    desc: 'Protocol fixture', tags: [], version: '0.1.0',
    vendor: { id: 'test', name: 'Test', kind: 'self', verified: false },
    source: { repo: 'local/exec', commit: '0'.repeat(40), sha256: `sha256:${'0'.repeat(64)}`, fetchedAt: 1 },
    license: { spdx: 'Apache-2.0', redistribute: 'bundle', notice: 'Fixture', commercialUse: true },
    runtime: { type: runtime, native: false, diskMB: 1 },
    entry: { ...(remote ? { transport: remote.url.startsWith('wss:') ? 'wss' : 'ws', url: remote.url } : { transport: 'stdio' }), ...(options.module ? { module: options.module } : {}) },
    'x-launch': remote
      ? { auth: { method: 'token', tokenRef: remote.ref ?? 'test-channel' } }
      : { command: process.execPath, args: ['plugin.mjs'], cwd: '.', env: { EXPLICIT_VALUE: 'allowed' }, ...options.launch },
    install: { by: 'user-install', requireHashes: true }, permissions: [],
    privacy: { hosted: false, sends: [] }, provides: {},
    tools: ['inspect', 'crash'].map(name => ({ name, desc: name, tags: ['utility'], input: { type: 'object' } })),
    fixtures: { offline: [], smoke: [] }, compat: { gitrader: '*', pluginSchema: '1' },
  }))
  pinPluginDir(dir)
  if (options.inspectOnly) return dir
  expect((await host.reload()).rejected).toEqual([])
  host.grant(id, [], h.sessionProof())
  return dir
}

describe('executable and remote GSP plugins', () => {
  it.each(['sidecar', 'python-sidecar'])('%s uses explicit launch, isolated env, health and graceful shutdown', async runtime => {
    vi.stubEnv('HOME', 'must-not-inherit')
    vi.stubEnv('GITRADER_GEP_TOKEN', 'must-not-inherit')
    vi.stubEnv('GITRADER_TEST_PRIVATE', 'must-not-inherit')
    const dir = await install(runtime)
    await host.start(id)
    expect(host.get(id)?.state).toBe('ready')
    await vi.waitFor(async () => {
      const data = await host.callTool(id, 'inspect', {}) as { keys: string[]; explicit: string; cwd: string; health: number }
      expect(data.health).toBeGreaterThan(0)
      expect(data.explicit).toBe('allowed')
      expect(data.cwd).toBe(dir)
      expect(data.keys.map(key => key.toUpperCase()).sort()).toEqual([
        'EXPLICIT_VALUE', 'GITRADER_GSP_TOKEN',
        ...(process.env.PATH ? ['PATH'] : []),
        ...(process.platform === 'win32' && process.env.SystemRoot ? ['SYSTEMROOT'] : []),
        // Windows adds these OS environment keys even when spawn receives an explicit env.
        ...(process.platform === 'win32' ? ['HOMEDRIVE', 'HOMEPATH', 'LOGONSERVER', 'SYSTEMDRIVE', 'TEMP', 'USERDOMAIN', 'USERNAME', 'USERPROFILE', 'WINDIR'].filter(key => process.env[key] !== undefined) : []),
      ].sort())
    })
    const { pid } = await host.callTool(id, 'inspect', {}) as { pid: number }
    await host.stop(id)
    expect(host.get(id)?.state).toBe('stopped')
    expect(() => process.kill(pid, 0)).toThrow()
  })

  it('backs off after a crash and cancels pending restart on stop', async () => {
    await install()
    await host.start(id)
    const first = await host.callTool(id, 'inspect', {}) as { pid: number }
    await expect(host.callTool(id, 'crash', {})).rejects.toBeTruthy()
    await vi.waitFor(() => expect(host.get(id)?.state).toBe('ready'))
    const next = await host.callTool(id, 'inspect', {}) as { pid: number }
    expect(next.pid).not.toBe(first.pid)
    await expect(host.callTool(id, 'crash', {})).rejects.toBeTruthy()
    await host.stop(id)
    await new Promise(resolve => setTimeout(resolve, 180))
    expect(host.get(id)?.state).toBe('stopped')
    await expect(host.callTool(id, 'inspect', {})).rejects.toMatchObject({ problem: { code: 3003 } })
  })

  it('blocks the backoff restart when reload rejected the changed manifest', async () => {
    const source = `
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
const count = existsSync('attempts') ? Number(readFileSync('attempts', 'utf8')) + 1 : 1
writeFileSync('attempts', String(count))
createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line)
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { ok: true, count } }) + '\\n')
  if (m.method === 'plugin.hello') setTimeout(() => process.exit(3), 10)
})
`
    const dir = await install('sidecar', undefined, { source })
    const states: { id?: string; state?: string; detail?: string }[] = []
    h.k.events.subscribe('plugin.state', (e) => states.push(e.data as { id?: string; state?: string; detail?: string }))
    await host.start(id)
    await vi.waitFor(() => expect(host.get(id)?.state).toBe('degraded'), { interval: 5 })
    expect(readFileSync(join(dir, 'attempts'), 'utf8')).toBe('1')
    // 退避期间把清单 cwd 改成越界值：reload 只登记拒绝，不替换记录、不动退避定时器
    const file = join(dir, MANIFEST_FILE)
    const manifest = JSON.parse(readFileSync(file, 'utf8')) as { 'x-launch': { cwd?: string } }
    manifest['x-launch'].cwd = '../..'
    writeFileSync(file, JSON.stringify(manifest, null, 2))
    const reloaded = await host.reload()
    expect(reloaded.rejected).toEqual([
      expect.objectContaining({ id, problems: expect.arrayContaining([expect.objectContaining({ code: 'ENTRY_ESCAPES' })]) }),
    ])
    expect(host.get(id)?.ok).toBe(false)
    expect(host.get(id)?.problems.map((p) => p.code)).toContain('ENTRY_ESCAPES')
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(readFileSync(join(dir, 'attempts'), 'utf8')).toBe('1')
    expect(host.get(id)?.state).toBe('failed')
    expect(states).toEqual(expect.arrayContaining([
      expect.objectContaining({ id, state: 'failed', detail: expect.stringContaining('ENTRY_ESCAPES') }),
    ]))
  })

  it('rejects remote ws before connecting or writing the ledger', async () => {
    server = new WebSocketServer({ host: 'localhost', port: 0 })
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('expected ephemeral listener')
    let connections = 0
    server.on('connection', () => { connections++ })
    const before = h.k.ledger.query({}).length
    const dir = await install('sidecar', { url: `ws://localhost:${address.port}/gsp` }, { inspectOnly: true })
    const inspected = host.inspect(dir)
    expect(inspected).toMatchObject({ ok: false, problem: { code: 5002, message: 'remote plugins arrive with S3-C' } })
    expect(inspected.warnings).toEqual(['manifest tokenRef ignored; the host derives the plugin credential reference'])
    expect((await host.reload()).rejected).toHaveLength(1)
    await expect(host.start(id)).rejects.toMatchObject({ problem: { code: 5002 } })
    await host.stop(id)
    await new Promise(resolve => setTimeout(resolve, 180))
    expect(connections).toBe(0)
    expect(h.k.ledger.query({})).toHaveLength(before)
  })

  it('rejects wss even with a manifest credential reference and never audits a connection', async () => {
    const before = h.k.ledger.query({}).length
    const dir = await install('sidecar', { url: 'wss://localhost/gsp', ref: 'env:UNRELATED_CHANNEL' }, { inspectOnly: true })
    expect(host.inspect(dir)).toMatchObject({ ok: false, problem: { code: 5002 } })
    await host.reload()
    await expect(host.start(id)).rejects.toMatchObject({ problem: { code: 5002 } })
    expect(h.k.ledger.query({})).toHaveLength(before)
    expect(pluginLaunch(host.get(id)!.manifest!)).toMatchObject({ auth: { method: 'token', tokenRef: 'env:GITRADER_PLUGIN_TOKEN_SKILL_TEST_EXEC' } })
  })

  it('counts hello failures and process exits in one bounded retry window', async () => {
    const source = `
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
const count = existsSync('attempts') ? Number(readFileSync('attempts', 'utf8')) + 1 : 1
writeFileSync('attempts', String(count))
createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line)
  const body = m.method === 'plugin.hello' && count % 2
    ? { error: { code: -32602, message: 'hello rejected' } } : { result: { ok: true } }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, ...body }) + '\\n')
  if (m.method === 'plugin.hello' && !(count % 2)) setTimeout(() => process.exit(3), 20)
})
`
    const dir = await install('sidecar', undefined, { source })
    const before = h.k.ledger.query({}).length
    await host.start(id)
    await vi.waitFor(() => expect(host.get(id)?.state).toBe('failed'), { timeout: 7000 })
    expect(readFileSync(join(dir, 'attempts'), 'utf8')).toBe('5')
    await new Promise(resolve => setTimeout(resolve, 250))
    expect(readFileSync(join(dir, 'attempts'), 'utf8')).toBe('5')
    expect(h.k.ledger.query({}).length).toBeLessThanOrEqual(before + 5)
  })

  it('stop returns after bounded stdio drain when a grandchild inherits stdout', async () => {
    const source = `
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
const grandchild = spawn(process.execPath, ['-e', "require('node:fs').writeFileSync('grandchild-ready', 'ready'); setTimeout(() => process.exit(0), 6000)"], {
  stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true, detached: true
})
grandchild.unref()
${script.replace('health }', "health, grandchildPid: grandchild.pid, grandchildReady: existsSync('grandchild-ready') }")}
`
    await install('sidecar', undefined, { source })
    await host.start(id)
    const { grandchildPid, pid } = await host.callTool(id, 'inspect', {}) as { grandchildPid: number; pid: number }
    try {
      await vi.waitFor(async () => {
        expect(await host.callTool(id, 'inspect', {})).toMatchObject({ grandchildReady: true })
      })
      expect(() => process.kill(grandchildPid, 0)).not.toThrow()
      const at = Date.now()
      await host.stop(id)
      expect(Date.now() - at).toBeLessThan(1500)
      expect(host.get(id)?.state).toBe('stopped')
      expect(() => process.kill(pid, 0)).toThrow()
    } finally {
      try { process.kill(grandchildPid, 'SIGKILL') } catch { /* fixture already exited */ }
      await vi.waitFor(() => expect(() => process.kill(grandchildPid, 0)).toThrow())
    }
  })

  it('wraps synchronous spawn errors as Problem and leaves failed instead of starting', async () => {
    await install('sidecar', undefined, { launch: { command: 'invalid\0command' } })
    await expect(host.start(id)).rejects.toMatchObject({ problem: { code: 4001, message: expect.stringContaining('ERR_INVALID_ARG_VALUE') } })
    expect(host.get(id)?.state).toBe('failed')
  })

  it('rejects invalid x-launch and escaping cwd during inspect', async () => {
    const dir = await install('sidecar', undefined, { launch: { cwd: '../..' }, inspectOnly: true })
    expect(host.inspect(dir)).toMatchObject({ ok: false, problems: expect.arrayContaining([
      expect.objectContaining({ code: 'ENTRY_ESCAPES', path: '/x-launch/cwd' }),
    ]) })
    await install('sidecar', undefined, { launch: { args: 'not-an-array' }, inspectOnly: true })
    expect(host.inspect(dir)).toMatchObject({ ok: false, problem: { code: -32602 } })
  })

  it.each(['node', 'browser', 'sidecar'])('%s remote transport cannot bypass entry module checks', async runtime => {
    const dir = await install(runtime, { url: 'ws://localhost/gsp' }, { module: '../../missing.mjs', inspectOnly: true })
    const inspected = host.inspect(dir)
    expect(inspected.ok).toBe(false)
    expect(inspected.problems.map(p => p.code)).toEqual(expect.arrayContaining(['ENTRY_ESCAPES', 'ENTRY_NOT_FOUND']))
  })
})
