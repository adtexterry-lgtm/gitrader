// SPDX-License-Identifier: CPAL-1.0
// 插件协议 r2 · 内核：工具声明与四道检查、结构化问题码、插件间隔离。真内核、真子进程，不 mock。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pinPluginDir, MANIFEST_FILE } from '../src/plugins'
import type { PluginManifest } from '../src/proto'
import { makeHarness } from './helpers/harness'
import type { Harness } from './helpers/harness'

let h: Harness
beforeEach(async () => {
  h = await makeHarness({ kernel: { plugins: { backoffMinMs: 20, backoffMaxMs: 100, healthIntervalMs: 200, healthTimeoutMs: 500, shutdownGraceMs: 1000 } } })
  h.k.config.plugins.developerMode = true
})
afterEach(async () => { await h.cleanup() })

const base = JSON.parse(readFileSync(join(__dirname, '..', '..', 'protocol', 'test', 'fixtures', 'contract', 'plugin-nautilus.json'), 'utf8')) as PluginManifest

const PLUGIN_JS = `import { readFileSync } from 'node:fs'
process.stdin.setEncoding('utf8')
let buf = ''
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n')
process.stdin.on('data', (d) => {
  buf += d
  let i
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1)
    const m = JSON.parse(line)
    if (m.method === 'plugin.hello') reply(m.id, { ok: true })
    else if (m.method === 'plugin.health') reply(m.id, { ok: true })
    else if (m.method === 'plugin.shutdown') { reply(m.id, { ok: true }); setTimeout(() => process.exit(0), 10) }
    else if (m.method === 'tool.call') {
      const t = m.params.tool
      if (t === 'echo') reply(m.id, m.params.args)
      else if (t === 'crash') process.exit(3)
      else if (t === 'badargs') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32602, message: 'qty must be positive' } }) + '\\n')
      else if (t === 'pid') reply(m.id, { pid: process.pid })
      else if (t === 'flood') process.stdout.write('x'.repeat(2 * 1024 * 1024))
      else if (t === 'big') reply(m.id, { s: 'x'.repeat(1100000) })
      else if (t === 'badout') reply(m.id, { n: 'not-a-number' })
      else if (t === 'needmkt') reply(m.id, { ok: true })
      else if (t === 'readPath') { try { readFileSync(m.params.args.path); reply(m.id, { read: true }) } catch (e) { reply(m.id, { read: false, code: e.code }) } }
      else reply(m.id, { unknown: t })
    }
  }
})
`

const TOOLS = [
  { name: 'echo', desc: 'echo', tags: ['utility'], input: { type: 'object', required: ['msg'], properties: { msg: { type: 'string' } } } },
  { name: 'badargs', desc: 'plugin-side arg error', tags: ['utility'], input: { type: 'object' } },
  { name: 'big', desc: 'oversized result', tags: ['utility'], input: { type: 'object' } },
  { name: 'pid', desc: 'pid', tags: ['utility'], input: { type: 'object' } },
  { name: 'flood', desc: 'unterminated output', tags: ['utility'], input: { type: 'object' } },
  { name: 'crash', desc: 'crash', tags: ['utility'], input: { type: 'object' } },
  { name: 'badout', desc: 'bad output', tags: ['utility'], input: { type: 'object' }, output: { type: 'object', required: ['n'], properties: { n: { type: 'number' } } } },
  { name: 'needmkt', desc: 'needs market.read', tags: ['market'], input: { type: 'object' }, permissions: ['market.read'] },
  { name: 'readPath', desc: 'read a file', tags: ['utility'], input: { type: 'object' } },
]

function writePlugin(name: string, over: Record<string, unknown> = {}): string {
  const dir = join(h.k.paths.plugins, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'index.mjs'), PLUGIN_JS)
  writeFileSync(join(dir, 'block.js'), 'export {}')
  const m = JSON.parse(JSON.stringify(base)) as Record<string, unknown>
  Object.assign(m, {
    id: `block.test.${name}`, package: 'block', kind: 'block', name, desc: 'test plugin', version: '0.1.0', tags: ['test'],
    vendor: { ...base.vendor, id: 'test' }, tools: TOOLS,
    permissions: ['market.read', 'ui.block'], net: undefined, engine: undefined, requires: undefined, signature: undefined, evidence: undefined,
    runtime: { type: 'node', node: '22', native: false, diskMB: 1 }, entry: { module: 'index.mjs' },
    install: { by: 'user-install', requireHashes: true }, provides: { blocks: ['block.test.hello'] },
    ui: { blocks: [{ id: 'block.test.hello', name: 'Hello', entry: { module: 'block.js', element: 'x-hello' } }] },
    license: { spdx: 'Apache-2.0', redistribute: 'bundle', notice: 'n', commercialUse: true },
    source: { repo: 'local/test', commit: 'a'.repeat(40), sha256: 'sha256:' + '0'.repeat(64), fetchedAt: 1 },
    compat: { gitrader: '>=0.1.0 <0.2.0', pluginSchema: '1' },
  }, over)
  for (const k of Object.keys(m)) if (m[k] === undefined) delete m[k]
  writeFileSync(join(dir, MANIFEST_FILE), JSON.stringify(m, null, 2))
  pinPluginDir(dir)
  return dir
}

type Rejected = { id: string; issues: string[]; problems: { code: string; path: string; message: string }[] }
const codesOf = (rejected: Rejected[], id: string): string[] => rejected.filter((x) => x.id === id).flatMap((x) => x.problems.map((p) => p.code))
const waitReady = async (id: string): Promise<void> => { for (let i = 0; i < 100 && h.k.plugins.get(id)!.state !== 'ready'; i++) await new Promise((r) => setTimeout(r, 50)) }
const problemOf = (e: unknown): { code: number; message: string } => (e as { problem: { code: number; message: string } }).problem

describe('工具声明与校验', () => {
  it('未启用 → 2004；grant(id, []) 即启用，零权限工具可调；入参缺字段 → -32602 并带字段名', async () => {
    writePlugin('t1')
    const id = 'block.test.t1'
    await h.k.plugins.reload()
    await h.k.plugins.start(id)
    expect(h.k.plugins.get(id)).toMatchObject({ ok: true, enabled: false })
    await expect(h.k.plugins.callTool(id, 'echo', { msg: 'hi' })).rejects.toMatchObject({ problem: { code: 2004, message: expect.stringContaining('not enabled') } })
    h.k.plugins.grant(id, [], h.sessionProof())
    expect(h.k.plugins.get(id)).toMatchObject({ enabled: true, granted: [] })
    expect(await h.k.plugins.callTool(id, 'echo', { msg: 'hi' })).toEqual({ msg: 'hi' })
    const e = problemOf(await h.k.plugins.callTool(id, 'echo', {}).catch((x: unknown) => x))
    expect(e.code).toBe(-32602)
    expect(e.message).toMatch(/^tool echo: /)
    expect(e.message).toContain('msg')
  })

  it('未声明工具 → 5008；声明了 output 而插件返回不合 → 5009（结果不返回）', async () => {
    writePlugin('t2')
    const id = 'block.test.t2'
    await h.k.plugins.reload()
    await h.k.plugins.start(id)
    h.k.plugins.grant(id, [], h.sessionProof())
    await expect(h.k.plugins.callTool(id, 'nope', {})).rejects.toMatchObject({ problem: { code: 5008, message: expect.stringContaining('does not declare tool nope') } })
    await expect(h.k.plugins.callTool(id, 'badout', {})).rejects.toMatchObject({ problem: { code: 5009 } })
  })

  it('工具声明了 permissions 而用户没授予 → 2004；授予后通过；启用记录持久（重载后仍启用）', async () => {
    writePlugin('t3')
    const id = 'block.test.t3'
    await h.k.plugins.reload()
    await h.k.plugins.start(id)
    h.k.plugins.grant(id, [], h.sessionProof())
    await expect(h.k.plugins.callTool(id, 'needmkt', {})).rejects.toMatchObject({ problem: { code: 2004, message: expect.stringContaining('needs permission market.read') } })
    h.k.plugins.grant(id, ['market.read'], h.sessionProof())
    expect(await h.k.plugins.callTool(id, 'needmkt', {})).toEqual({ ok: true })
    await h.k.plugins.reload()
    expect(h.k.plugins.get(id)).toMatchObject({ enabled: true, granted: ['market.read'] })
    expect(h.k.plugins.enabled(id)).toBe(true)
    expect(h.k.docs.get<{ enabledAt?: number }>('plugingrant', id)!.enabledAt).toBeTypeOf('number')
  })

  it('说真话：没有记录 → no such plugin；被拒（改文件不 pin）→ failed validation + 问题码 + 怎么修；grant 同样', async () => {
    const dir = writePlugin('t6')
    const id = 'block.test.t6'
    await h.k.plugins.reload()
    await expect(h.k.plugins.callTool('block.test.ghost', 'echo', {})).rejects.toMatchObject({ problem: { code: -32602, message: expect.stringContaining('no such plugin: block.test.ghost') } })
    writeFileSync(join(dir, 'block.js'), 'export const tampered = 1')
    await h.k.plugins.reload()
    expect(h.k.plugins.get(id)!.ok).toBe(false)
    const e = problemOf(await h.k.plugins.callTool(id, 'echo', { msg: 'x' }).catch((x: unknown) => x))
    expect(e.code).toBe(-32602)
    expect(e.message).toContain('failed validation')
    expect(e.message).toContain('[HASH_MISMATCH]')
    expect(e.message).toContain('gitrader plugins pin')
    const g = problemOf((() => { try { h.k.plugins.grant(id, [], h.sessionProof()) } catch (x) { return x } return null })())
    expect(g.message).toContain('[HASH_MISMATCH]')
  })

  it('插件自己回 JSON-RPC -32602 → 内核 -32602，消息原样；其余插件错误仍是 INTERNAL', async () => {
    writePlugin('t7')
    const id = 'block.test.t7'
    await h.k.plugins.reload()
    await h.k.plugins.start(id)
    h.k.plugins.grant(id, [], h.sessionProof())
    await expect(h.k.plugins.callTool(id, 'badargs', {})).rejects.toMatchObject({ problem: { code: -32602, message: 'qty must be positive' } })
  })

  it('权限名拼错 → PERMISSION_UNKNOWN，message 点名、hint 列出合法权限', async () => {
    writePlugin('t8', { permissions: ['market.write'] })
    const r = await h.k.plugins.reload()
    const p = (r.rejected as Rejected[]).find((x) => x.id === 'block.test.t8')!.problems.find((x) => x.code === 'PERMISSION_UNKNOWN')! as { path: string; message: string; hint?: string }
    expect(p).toMatchObject({ path: '/permissions/0', message: 'unknown permission market.write' })
    expect(p.hint).toContain('market.read')
  })

  it('启用后不手动 start 直接调用：自动拉起；结果超过 1 MiB → 5007', async () => {
    writePlugin('t9')
    const id = 'block.test.t9'
    await h.k.plugins.reload()
    h.k.plugins.grant(id, [], h.sessionProof())
    expect(h.k.plugins.get(id)!.state).toBe('installed')
    expect(await h.k.plugins.callTool(id, 'echo', { msg: 'auto' })).toEqual({ msg: 'auto' })
    expect(h.k.plugins.get(id)!.state).toBe('ready')
    await expect(h.k.plugins.callTool(id, 'big', {})).rejects.toMatchObject({ problem: { code: 5007 } })
    await waitReady(id) // 超限的插件被杀后退避重启，等它回来再收场
  })

  it('同 id 多版本目录：高版本胜，低版本 DUPLICATE_ID；升级后不再声明的权限不保留，启用状态保留', async () => {
    writePlugin('multi/0.1.0', { id: 'block.test.multi', version: '0.1.0' })
    const id = 'block.test.multi'
    await h.k.plugins.reload()
    h.k.plugins.grant(id, ['market.read'], h.sessionProof())
    expect(h.k.plugins.get(id)!.granted).toEqual(['market.read'])
    writePlugin('multi/0.2.0', { id, version: '0.2.0', permissions: ['ui.block'], tools: TOOLS.filter((t) => t.name !== 'needmkt') })
    const r = await h.k.plugins.reload()
    const lost = (r.rejected as Rejected[]).filter((x) => x.id === id)
    expect(lost.length).toBe(1)
    expect(lost[0]!.problems[0]).toMatchObject({ code: 'DUPLICATE_ID' })
    expect(lost[0]!.issues[0]).toContain('wins (higher version); remove this directory')
    expect(h.k.plugins.get(id)).toMatchObject({ ok: true, version: '0.2.0', enabled: true, granted: [] })
  })

  it('重复 id 先比是否通过校验：已装的 0.1.0 旁放一个没 pin 的 0.2.0 → 0.1.0 照常可调，0.2.0 以 HASH_MISMATCH 被拒', async () => {
    writePlugin('rk/0.1.0', { id: 'block.test.rk', version: '0.1.0' })
    const id = 'block.test.rk'
    await h.k.plugins.reload()
    h.k.plugins.grant(id, [], h.sessionProof())
    const dir2 = writePlugin('rk/0.2.0', { id, version: '0.2.0' })
    writeFileSync(join(dir2, 'block.js'), 'export const unpinned = 1')
    const r = await h.k.plugins.reload()
    const lost = (r.rejected as Rejected[]).filter((x) => x.id === id)
    expect(lost.map((x) => x.problems.map((p) => p.code))).toEqual([['HASH_MISMATCH']])
    expect(h.k.plugins.get(id)).toMatchObject({ ok: true, version: '0.1.0', enabled: true })
    expect(await h.k.plugins.callTool(id, 'echo', { msg: 'old' })).toEqual({ msg: 'old' })
  })

  it('插件输出 2 MiB 不换行 → 调用得 5007，进程被杀并重启（pid 变了）', async () => {
    writePlugin('t10')
    const id = 'block.test.t10'
    await h.k.plugins.reload()
    h.k.plugins.grant(id, [], h.sessionProof())
    const pid1 = ((await h.k.plugins.callTool(id, 'pid', {})) as { pid: number }).pid
    await expect(h.k.plugins.callTool(id, 'flood', {})).rejects.toMatchObject({ problem: { code: 5007 } })
    let pid2 = pid1 // taskkill 有延迟：轮询到换了新进程为止
    for (let i = 0; i < 100 && pid2 === pid1; i++) {
      await new Promise((r) => setTimeout(r, 100))
      pid2 = ((await h.k.plugins.callTool(id, 'pid', {}).catch(() => ({ pid: pid1 }))) as { pid: number }).pid
    }
    expect(pid2).not.toBe(pid1)
  })

  it('显式 stop 后不自动拉起 → 3003；再 start 才恢复', async () => {
    writePlugin('t11')
    const id = 'block.test.t11'
    await h.k.plugins.reload()
    h.k.plugins.grant(id, [], h.sessionProof())
    await h.k.plugins.callTool(id, 'echo', { msg: 'a' })
    await h.k.plugins.stop(id)
    await expect(h.k.plugins.callTool(id, 'echo', { msg: 'b' })).rejects.toMatchObject({ problem: { code: 3003, message: `plugin ${id} was stopped; start it again` } })
    await h.k.plugins.reload() // reload 保留"用户停过"
    await expect(h.k.plugins.callTool(id, 'echo', { msg: 'b' })).rejects.toMatchObject({ problem: { code: 3003 } })
    await h.k.plugins.start(id)
    expect(await h.k.plugins.callTool(id, 'echo', { msg: 'c' })).toEqual({ msg: 'c' })
  })

  it('两路并发首调：只拉起一个进程，两路都拿到结果', async () => {
    writePlugin('t12')
    const id = 'block.test.t12'
    await h.k.plugins.reload()
    h.k.plugins.grant(id, [], h.sessionProof())
    const [a, b] = (await Promise.all([h.k.plugins.callTool(id, 'pid', {}), h.k.plugins.callTool(id, 'pid', {})])) as { pid: number }[]
    expect(a!.pid).toBe(b!.pid)
  })

  it('只改清单（不动包内容、不重新 pin）也算升级：reload 得 updated，账本多一条 plugin.updated（changed: manifest）', async () => {
    const dir = writePlugin('t13')
    const id = 'block.test.t13'
    await h.k.plugins.reload()
    expect(h.k.ledger.query({ types: ['plugin.updated'] }).length).toBe(0)
    const m = JSON.parse(readFileSync(join(dir, MANIFEST_FILE), 'utf8')) as PluginManifest
    writeFileSync(join(dir, MANIFEST_FILE), JSON.stringify({ ...m, desc: 'changed description' }, null, 2))
    const r = await h.k.plugins.reload()
    expect(r.updated).toEqual([id])
    const ev = h.k.ledger.query({ types: ['plugin.updated'] })
    expect(ev.length).toBe(1)
    expect(ev[0]!.payload).toMatchObject({ changed: ['manifest'], permissions: ['market.read', 'ui.block'] })
    expect((await h.k.plugins.reload()).updated).toEqual([]) // 没再变就不重复入账
  })

  it('plugin.list 带 problems / enabled / tools', async () => {
    writePlugin('t4')
    await h.k.plugins.reload()
    const rows = (await h.k.ops.call(h.k, 'plugin.list', { principal: h.session, params: {}, transport: 'ws' })) as { id: string; enabled: boolean; tools: { name: string }[]; problems: unknown[] }[]
    const row = rows.find((r) => r.id === 'block.test.t4')!
    expect(row.enabled).toBe(false)
    expect(row.tools.map((t) => t.name)).toContain('echo')
    expect(row.problems).toEqual([])
  })

  it('vendor.verified：未受信而清单写 true → 记录里的副本是 false，磁盘不动', async () => {
    const dir = writePlugin('t5')
    await h.k.plugins.reload()
    expect((JSON.parse(readFileSync(join(dir, MANIFEST_FILE), 'utf8')) as PluginManifest).vendor.verified).toBe(true)
    expect(h.k.plugins.get('block.test.t5')!.manifest!.vendor.verified).toBe(false)
  })
})

describe('结构化问题码', () => {
  it('每类问题都有稳定的 code；issues 字符串以 [CODE] 开头', async () => {
    writePlugin('bad-schema', { version: 'not-a-version' })
    writePlugin('bad-perm', { permissions: ['withdraw'] })
    writePlugin('bad-schema2', { compat: { gitrader: '>=0.1.0 <0.2.0', pluginSchema: '2' } })
    writePlugin('bad-range', { compat: { gitrader: '>=9.0.0', pluginSchema: '1' } })
    writePlugin('bad-promise', { desc: 'guaranteed profit every week' })
    writePlugin('bad-prefix', { id: 'strategy.test.bad-prefix' })
    writePlugin('bad-privacy', { privacy: { hosted: true, sends: [] } })
    writePlugin('dup-a')
    writePlugin('dup-b', { id: 'block.test.dup-a' })
    const r = await h.k.plugins.reload()
    const rej = r.rejected as Rejected[]
    expect(rej.find((x) => x.id === 'block.test.bad-schema')!.problems.find((p) => p.code === 'SCHEMA')).toMatchObject({ path: '/version' })
    expect(codesOf(rej, 'block.test.bad-perm')).toContain('PERMISSION_NEVER_GRANTABLE')
    expect(codesOf(rej, 'block.test.bad-schema2')).toContain('COMPAT_SCHEMA_UNSUPPORTED')
    expect(codesOf(rej, 'block.test.bad-range')).toContain('COMPAT_GITRADER_UNSATISFIED')
    expect(codesOf(rej, 'block.test.bad-promise')).toContain('PROMISE_LANGUAGE')
    expect(codesOf(rej, 'strategy.test.bad-prefix')).toContain('ID_PREFIX_MISMATCH')
    expect(codesOf(rej, 'block.test.bad-privacy')).toContain('PRIVACY_HOSTED_WITHOUT_NET')
    expect(codesOf(rej, 'block.test.dup-a')).toEqual(['DUPLICATE_ID'])
    expect(h.k.plugins.get('block.test.dup-a')).toMatchObject({ ok: true, dir: join(h.k.paths.plugins, 'dup-a') }) // 第一个不被覆盖
    expect(rej.length).toBe(8)
    for (const x of rej) {
      expect(x.issues[0]!.startsWith('[')).toBe(true)
      expect(x.issues).toEqual(x.problems.map((p) => `[${p.code}] ${p.message}`))
    }
  })
})

describe('插件间隔离', () => {
  it('A 崩了 B 照常答；A 读不了 B 目录里的文件；只给 A 授权，B 仍未启用', async () => {
    writePlugin('a')
    const dirB = writePlugin('b')
    await h.k.plugins.reload()
    const A = 'block.test.a'
    const B = 'block.test.b'
    await h.k.plugins.start(A)
    await h.k.plugins.start(B)
    expect(h.k.plugins.get(A)!.state).toBe('ready')
    expect(h.k.plugins.get(B)!.state).toBe('ready')
    h.k.plugins.grant(A, [], h.sessionProof())
    expect(h.k.plugins.get(A)!.enabled).toBe(true)
    expect(h.k.plugins.get(B)!.enabled).toBe(false)
    await expect(h.k.plugins.callTool(B, 'echo', { msg: 'x' })).rejects.toMatchObject({ problem: { code: 2004 } })
    expect(await h.k.plugins.callTool(A, 'readPath', { path: join(dirB, 'index.mjs') })).toMatchObject({ read: false, code: 'ERR_ACCESS_DENIED' })
    h.k.plugins.grant(B, [], h.sessionProof())
    await h.k.plugins.callTool(A, 'crash', {}).catch(() => undefined)
    expect(await h.k.plugins.callTool(B, 'echo', { msg: 'still here' })).toEqual({ msg: 'still here' })
    expect(h.k.plugins.get(B)!.state).toBe('ready')
    // A 退避重启完再收场，免得清理目录时撞上正在拉起的子进程
    for (let i = 0; i < 100 && h.k.plugins.get(A)!.state !== 'ready'; i++) await new Promise((r) => setTimeout(r, 50))
    expect(h.k.plugins.get(A)!.state).toBe('ready')
  })
})
