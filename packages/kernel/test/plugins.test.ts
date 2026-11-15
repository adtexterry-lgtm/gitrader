// SPDX-License-Identifier: CPAL-1.0
// 插件宿主：清单校验（缺签名 / 哈希不符 / 越权）、钉版本 + 哈希、权限默认拒绝、Node 插件子进程生命周期、reload。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { request } from 'node:http'
import { artifactList, pinPluginDir, signingDigest, MANIFEST_FILE } from '../src/plugins'
import type { PluginManifest } from '../src/proto'
import { makeHarness, TEST_PIN } from './helpers/harness'
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
    if (m.method === 'plugin.hello') reply(m.id, { ok: true, envKeys: Object.keys(process.env).sort(), token: !!process.env.GITRADER_GSP_TOKEN, granted: m.params.permissions })
    else if (m.method === 'plugin.health') reply(m.id, { ok: true })
    else if (m.method === 'plugin.shutdown') { reply(m.id, { ok: true }); setTimeout(() => process.exit(0), 10) }
    else if (m.method === 'tool.call') {
      const t = m.params.tool
      if (t === 'echo') reply(m.id, m.params.args)
      else if (t === 'crash') process.exit(3)
      else if (t === 'pid') reply(m.id, { pid: process.pid })
      else if (t === 'leak') reply(m.id, { fine: 1, privateKey: '0xdeadbeef' })
      else if (t === 'readPath') { try { readFileSync(m.params.args.path); reply(m.id, { read: true }) } catch (e) { reply(m.id, { read: false, code: e.code }) } }
      else if (t === 'readOutside') { try { readFileSync(process.env.GT_OUTSIDE ?? 'C:/Windows/win.ini'); reply(m.id, { read: true }) } catch (e) { reply(m.id, { read: false, code: e.code }) } }
      else reply(m.id, { unknown: t })
    }
  }
})
`

function writePlugin(name: string, over: Partial<PluginManifest> = {}, files: Record<string, string> = { 'index.mjs': PLUGIN_JS, 'block.js': 'export {}' }, pin = true): string {
  const dir = join(h.k.paths.plugins, name)
  mkdirSync(dir, { recursive: true })
  for (const [f, c] of Object.entries(files)) writeFileSync(join(dir, f), c)
  const m = JSON.parse(JSON.stringify(base)) as PluginManifest
  Object.assign(m, {
    id: `block.test.${name}`, package: 'block', kind: 'block', name, desc: 'test plugin', version: '0.1.0', tags: ['test'],
    vendor: { ...base.vendor, id: 'test' },
    tools: ['echo', 'crash', 'pid', 'leak', 'readOutside', 'readPath'].map((n) => ({ name: n, desc: n, tags: ['utility'], input: { type: 'object' } })),
    permissions: ['market.read', 'ui.block'], net: undefined, engine: undefined, requires: undefined, signature: undefined, evidence: undefined,
    runtime: { type: 'node', node: '22', native: false, diskMB: 1 }, entry: { module: 'index.mjs' },
    install: { by: 'user-install', requireHashes: true }, provides: { blocks: ['block.test.hello'] },
    ui: { blocks: [{ id: 'block.test.hello', name: 'Hello', entry: { module: 'block.js', element: 'x-hello' } }] },
    license: { spdx: 'Apache-2.0', redistribute: 'bundle', notice: 'n', commercialUse: true },
    source: { repo: 'local/test', commit: 'a'.repeat(40), sha256: 'sha256:' + '0'.repeat(64), fetchedAt: 1 },
    compat: { gitrader: '>=0.1.0 <0.2.0', pluginSchema: '1' },
  } as Partial<PluginManifest>, over)
  for (const k of Object.keys(m) as (keyof PluginManifest)[]) if (m[k] === undefined) delete m[k]
  writeFileSync(join(dir, MANIFEST_FILE), JSON.stringify(m, null, 2))
  if (pin) pinPluginDir(dir)
  return dir
}

describe('清单校验', () => {
  it('合法的未签名插件：开发者模式下可加载；默认模式拒绝（缺签名）', async () => {
    writePlugin('hello')
    let r = await h.k.plugins.reload()
    expect(r.rejected).toEqual([])
    expect(r.added).toEqual(['block.test.hello'])
    expect(h.k.plugins.get('block.test.hello')).toMatchObject({ ok: true, signed: false, version: '0.1.0' })
    expect(h.k.plugins.get('block.test.hello')!.blocks[0]).toMatchObject({ id: 'block.test.hello' })
    h.k.config.plugins.developerMode = false
    r = await h.k.plugins.reload()
    expect(r.rejected[0]!.issues.join(' ')).toMatch(/unsigned plugin/)
    expect(h.k.plugins.get('block.test.hello')!.ok).toBe(false)
  })

  it('哈希不符：包内文件被改 → 拒绝，并提示重新 pin', async () => {
    const dir = writePlugin('hello')
    expect((await h.k.plugins.reload()).rejected).toEqual([])
    writeFileSync(join(dir, 'block.js'), 'export const evil = 1')
    const r = await h.k.plugins.reload()
    expect(r.rejected[0]!.issues.join(' ')).toMatch(/hash mismatch/)
    pinPluginDir(dir)
    expect((await h.k.plugins.reload()).rejected).toEqual([])
  })

  it('越权：永不可授予的权限 / 与 kind 不符的权限 / 未签名申请实盘或凭据 → 拒绝', async () => {
    writePlugin('a', { permissions: ['withdraw'] as never })
    writePlugin('b', { permissions: ['venue.credentials'] as never })
    writePlugin('c', { permissions: ['trade.live'] as never, kind: 'executor' as never, package: 'block', risk: { disclosure: 'x', worstCase: 'y', builderAttribution: 'off' } as never })
    const r = await h.k.plugins.reload()
    expect(r.rejected.length).toBe(3)
    const all = r.rejected.map((x) => x.issues.join(' ')).join(' | ')
    expect(all).toMatch(/withdraw|never be granted|permissions/)
    expect(all).toMatch(/venue\.credentials/)
    expect(all).toMatch(/unsigned plugin must not request trade\.live/)
    expect(h.k.plugins.list().every((p) => !p.ok)).toBe(true)
  })

  it('签名：受信根签的通过；不在信任根里的拒绝；签名后改包被发现', async () => {
    h.k.config.plugins.developerMode = false
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const spki = publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
    const signIt = (dir: string, keyId: string): void => {
      const m = JSON.parse(readFileSync(join(dir, MANIFEST_FILE), 'utf8')) as PluginManifest
      const digest = signingDigest(m, artifactList(dir))
      m.signature = { alg: 'ed25519', keyId, digest: digest as never, sig: sign(null, Buffer.from(digest), privateKey).toString('base64') }
      writeFileSync(join(dir, MANIFEST_FILE), JSON.stringify(m, null, 2))
    }
    const dir = writePlugin('signed')
    signIt(dir, 'dev-key-1')
    let r = await h.k.plugins.reload()
    expect(r.rejected[0]!.issues.join(' ')).toMatch(/not a trusted root/)
    h.k.config.plugins.trustRoots.push({ keyId: 'dev-key-1', publicKey: spki })
    r = await h.k.plugins.reload()
    expect(r.rejected).toEqual([])
    expect(h.k.plugins.get('block.test.signed')).toMatchObject({ ok: true, signed: true, trusted: true })
    writeFileSync(join(dir, 'block.js'), 'export const tampered = 1')
    r = await h.k.plugins.reload()
    expect(r.rejected[0]!.issues.join(' ')).toMatch(/hash mismatch|digest does not match/)
    // 换了个人的私钥签名（信任根里是别的公钥）→ 验签失败
    const other = generateKeyPairSync('ed25519')
    const dir2 = writePlugin('forged')
    const m = JSON.parse(readFileSync(join(dir2, MANIFEST_FILE), 'utf8')) as PluginManifest
    const digest = signingDigest(m, artifactList(dir2))
    m.signature = { alg: 'ed25519', keyId: 'dev-key-1', digest: digest as never, sig: sign(null, Buffer.from(digest), other.privateKey).toString('base64') }
    writeFileSync(join(dir2, MANIFEST_FILE), JSON.stringify(m))
    expect((await h.k.plugins.reload()).rejected.find((x) => x.id === 'block.test.forged')!.issues.join(' ')).toMatch(/signature verification failed/)
  })

  it('坏清单（缺字段 / 未知 kind / 不是 JSON）不会让宿主崩溃', async () => {
    mkdirSync(join(h.k.paths.plugins, 'broken'), { recursive: true })
    writeFileSync(join(h.k.paths.plugins, 'broken', MANIFEST_FILE), '{ not json')
    writePlugin('nokind', { kind: 'model' as never })
    const r = await h.k.plugins.reload()
    expect(r.rejected.length).toBe(2)
  })
})

describe('权限默认拒绝 + 插件目录 reload', () => {
  it('安装即无权限；授予需要会话 + 逐项；只能授予清单里声明的；永不可授予的拒绝；授予入账', async () => {
    writePlugin('hello')
    await h.k.plugins.reload()
    const id = 'block.test.hello'
    expect(h.k.plugins.get(id)!.granted).toEqual([])
    expect(h.k.plugins.allowed(id, 'market.read')).toBe(false)
    expect(h.k.plugins.get(id)!.pending).toEqual(['market.read', 'ui.block'])
    expect(() => h.k.plugins.grant(id, ['trade.live'] as never, h.sessionProof())).toThrow(/not declared/)
    expect(() => h.k.plugins.grant(id, ['withdraw'] as never, h.sessionProof())).toThrow(/never be granted/)
    h.k.plugins.grant(id, ['market.read'], h.sessionProof())
    expect(h.k.plugins.allowed(id, 'market.read')).toBe(true)
    expect(h.k.plugins.allowed(id, 'ui.block')).toBe(false)
    expect(h.k.ledger.query({ types: ['plugin.permission_granted'] }).length).toBe(1)
    await h.k.plugins.reload()
    expect(h.k.plugins.get(id)!.granted).toEqual(['market.read']) // 授权持久化
    await h.pinProof()
    await expect(h.k.ops.call(h.k, 'plugin.grant', { principal: h.k.auth.authenticateToken(h.k.auth.exchangeBoot(h.k.auth.mintBootToken()).sessionToken)!, params: { id, permissions: ['ui.block'] }, transport: 'http', pin: TEST_PIN })).resolves.toBeTruthy()
    const svc = { kind: 'service' as const }
    await expect(h.k.ops.call(h.k, 'plugin.grant', { principal: svc, params: { id, permissions: ['ui.block'] }, transport: 'http' })).rejects.toMatchObject({ problem: { code: 5003 } })
  })

  it('reload：新增 / 升级 / 移除都入账；块清单被登记；账本记录永不删除', async () => {
    const dir = writePlugin('hello')
    let r = await h.k.plugins.reload()
    expect(r.added).toEqual(['block.test.hello'])
    expect((await h.k.plugins.reload()).added).toEqual([])
    writeFileSync(join(dir, 'block.js'), 'export const v2 = 1')
    pinPluginDir(dir)
    r = await h.k.plugins.reload()
    expect(r.updated).toEqual(['block.test.hello'])
    rmSync(dir, { recursive: true, force: true })
    r = await h.k.plugins.reload()
    expect(r.removed).toEqual(['block.test.hello'])
    expect(h.k.ledger.query({ types: ['plugin.installed', 'plugin.updated', 'plugin.removed'], order: 'asc' }).map((e) => e.type)).toEqual(['plugin.installed', 'plugin.updated', 'plugin.removed'])
    expect(h.k.ledger.verify().ok).toBe(true)
  })

  it('块文件读取限制在插件目录内', async () => {
    writePlugin('hello')
    await h.k.plugins.reload()
    expect(h.k.plugins.readFile('block.test.hello', 'block.js').toString()).toBe('export {}')
    expect(() => h.k.plugins.readFile('block.test.hello', '../../gitrader.json')).toThrow(/escapes/)
  })
})

describe('Node 插件子进程（GSP / NDJSON）', () => {
  it('start：环境变量不继承、拿不到密钥、读不了插件目录之外的文件；tool.call 往返；返回里出现密钥字段被丢弃（5006）', async () => {
    process.env.GITRADER_TEST_SECRET = 'super-secret-value'
    process.env.OPENAI_API_KEY = 'sk-test-not-real'
    process.env.GT_OUTSIDE = join(h.home, 'gitrader.json')
    try {
      writePlugin('hello')
      await h.k.plugins.reload()
      h.k.plugins.grant('block.test.hello', ['market.read'], h.sessionProof())
      await h.k.plugins.start('block.test.hello')
      expect(h.k.plugins.get('block.test.hello')!.state).toBe('ready')
      const hello = (await h.k.plugins.rpc('block.test.hello', 'plugin.hello', { permissions: [] })) as { envKeys: string[]; token: boolean }
      expect(hello.token).toBe(true)
      expect(hello.envKeys).not.toContain('GITRADER_TEST_SECRET')
      const upper = hello.envKeys.map((k) => k.toUpperCase()) // Windows 会自己补 PATH / TEMP / USERPROFILE 这类系统变量，不含密钥；关键是宿主里的密钥类变量一个都没传进去
      for (const k of ['OPENAI_API_KEY', 'GT_OUTSIDE', 'GITRADER_HOME']) expect(upper, k).not.toContain(k)
      expect(upper).toContain('GITRADER_GSP_TOKEN')
      expect(await h.k.plugins.callTool('block.test.hello', 'echo', { a: 1 })).toEqual({ a: 1 })
      expect(await h.k.plugins.callTool('block.test.hello', 'readOutside', {})).toMatchObject({ read: false, code: 'ERR_ACCESS_DENIED' })
      await expect(h.k.plugins.callTool('block.test.hello', 'leak', {})).rejects.toMatchObject({ problem: { code: 5006 } })
    } finally { delete process.env.GITRADER_TEST_SECRET; delete process.env.GT_OUTSIDE; delete process.env.OPENAI_API_KEY }
  })

  it('没有任何授权的插件：tool.call 默认拒绝', async () => {
    writePlugin('hello')
    await h.k.plugins.reload()
    await h.k.plugins.start('block.test.hello')
    await expect(h.k.plugins.callTool('block.test.hello', 'echo', {})).rejects.toMatchObject({ problem: { code: 2004 } })
  })

  it('崩溃 → 退避重启；stop 只按自己持有的句柄结束进程；卸载删目录但账本保留', async () => {
    writePlugin('hello')
    await h.k.plugins.reload()
    h.k.plugins.grant('block.test.hello', ['market.read'], h.sessionProof())
    await h.k.plugins.start('block.test.hello')
    const pid1 = ((await h.k.plugins.callTool('block.test.hello', 'pid', {})) as { pid: number }).pid
    await h.k.plugins.callTool('block.test.hello', 'crash', {}).catch(() => undefined)
    for (let i = 0; i < 100 && h.k.plugins.get('block.test.hello')!.state !== 'ready'; i++) await new Promise((r) => setTimeout(r, 50))
    expect(h.k.plugins.get('block.test.hello')!.state).toBe('ready')
    const pid2 = ((await h.k.plugins.callTool('block.test.hello', 'pid', {})) as { pid: number }).pid
    expect(pid2).not.toBe(pid1)
    await h.k.plugins.stop('block.test.hello')
    expect(h.k.plugins.get('block.test.hello')!.state).toBe('stopped')
    expect(() => process.kill(pid2, 0)).toThrow()
    await h.k.plugins.uninstall('block.test.hello', h.sessionProof())
    expect(h.k.plugins.get('block.test.hello')).toBeUndefined()
    expect(h.k.ledger.query({ types: ['plugin.removed'] }).length).toBe(1)
  })

  it('其他 runtime（python 旁车）在 M1 只留桩：start 返回 CAPABILITY_UNSUPPORTED', async () => {
    writePlugin('py', { runtime: { type: 'python-sidecar', python: '3.12', native: false, diskMB: 1 } as never, entry: { command: ['python', '-m', 'x'], transport: 'stdio' } as never, install: { by: 'user-consent', requireHashes: true } as never })
    await h.k.plugins.reload()
    const rec = h.k.plugins.get('block.test.py')!
    if (rec.ok) await expect(h.k.plugins.start('block.test.py')).rejects.toMatchObject({ problem: { code: 5002 } })
  })
})

describe('工作台插件区：plugin.blocks + 插件静态文件路由', () => {
  const op = (name: string, params: Record<string, unknown> = {}): Promise<any> => h.k.ops.call(h.k, name, { principal: h.session, params, transport: 'ws' }) // eslint-disable-line @typescript-eslint/no-explicit-any
  const get = (port: number, path: string, headers: Record<string, string> = {}, method = 'GET'): Promise<{ status: number; h: Record<string, string | string[] | undefined>; body: string }> =>
    new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (d) => { body += d })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, h: res.headers, body }))
      })
      req.on('error', reject)
      req.end()
    })

  it('plugin.blocks 只列校验通过且声明了块的插件：manifest、入口 URL、授权；坏插件不出现', async () => {
    writePlugin('hello', {}, { 'index.mjs': PLUGIN_JS, 'block.js': 'export const x = 1', 'sub-a.css': 'a{}' })
    writePlugin('bad', { permissions: ['withdraw'] as never })
    await h.k.plugins.reload()
    const r = await op('plugin.blocks')
    expect(r.blocks).toHaveLength(1)
    expect(r.blocks[0]).toMatchObject({ pluginId: 'block.test.hello', id: 'block.test.hello', name: 'Hello', moduleUrl: '/plugins/block.test.hello/block.js', granted: [], manifest: { entry: { module: 'block.js', element: 'x-hello' } } })
    await h.pinProof()
    await h.k.ops.call(h.k, 'plugin.grant', { principal: h.session, params: { id: 'block.test.hello', permissions: ['ui.block'] }, transport: 'ws', pin: TEST_PIN })
    expect((await op('plugin.blocks')).blocks[0].granted).toEqual(['ui.block'])
  })

  it('静态路由：插件文件带 ACAO:*（沙箱 iframe 的 null 源也能取）；API 不带；目录外 / 点文件 / 未知插件 / 坏插件 → 404；Host 仍校验', async () => {
    writePlugin('hello', {}, { 'index.mjs': PLUGIN_JS, 'block.js': 'export const x = 1', '.secret': 'nope' })
    writePlugin('bad', { permissions: ['withdraw'] as never })
    await h.k.plugins.reload()
    const { port } = await h.k.start({ port: 0 })
    const f = await get(port, '/plugins/block.test.hello/block.js', { origin: 'null', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors' })
    expect(f.status).toBe(200)
    expect(f.body).toBe('export const x = 1')
    expect(f.h['access-control-allow-origin']).toBe('*')
    expect(String(f.h['content-type'])).toContain('text/javascript')
    expect(String(f.h['content-security-policy'])).toContain("frame-ancestors 'self'")
    for (const bad of ['/plugins/block.test.hello/.secret', '/plugins/block.test.hello/..%2f..%2fgitrader.json', '/plugins/block.test.hello/sub%2f..%2f..%2f..%2fgitrader.json', '/plugins/nope/block.js', '/plugins/block.test.bad/block.js', '/plugins/block.test.hello/', '/plugins/block.test.hello/missing.js']) {
      const r = await get(port, bad)
      expect(r.status, bad).toBe(404)
    }
    // 不能借这条路由绕过 Host 校验
    expect((await get(port, '/plugins/block.test.hello/block.js', { host: 'evil.example' })).status).toBe(403)
    // 其他路由仍拒绝 null 源 / 跨站，且不带 ACAO
    const api = await get(port, '/api/health', { origin: 'null' })
    expect(api.status).toBe(403)
    expect(api.h['access-control-allow-origin']).toBeUndefined()
    const page = await get(port, '/', { origin: 'null', 'sec-fetch-site': 'cross-site' })
    expect(page.status).toBe(403)
    // POST 不行
    expect((await get(port, '/plugins/block.test.hello/block.js', {}, 'POST')).status).toBe(405)
  })

  it('/api/session/relink 明确 404（不是 401），无需令牌，壳据此回退到提示', async () => {
    const { port } = await h.k.start({ port: 0 })
    for (const method of ['GET', 'POST']) {
      const r = await get(port, '/api/session/relink', {}, method)
      expect(r.status, method).toBe(404)
      expect(r.h['www-authenticate']).toBeUndefined()
      expect(JSON.parse(r.body).error.message).toMatch(/gitrader open$/) // fix-r1 裁决 7
    }
  })
})

describe('GQ-56 运行中篡改：lastVerifiedAt + verify', () => {
  it('list() 给 lastVerifiedAt 且是缓存；篡改后 verify() 检出 HASH_MISMATCH；改回再 verify 恢复', async () => {
    const dir = writePlugin('hello')
    await h.k.plugins.reload()
    const id = 'block.test.hello'
    const first = h.k.plugins.list().find((p) => p.id === id)!
    expect(first.ok).toBe(true)
    expect(first.lastVerifiedAt).toBeTypeOf('number')
    const original = readFileSync(join(dir, 'block.js'), 'utf8')
    writeFileSync(join(dir, 'block.js'), original + '\n// tampered\n')
    // 未 verify 前仍是缓存结果（诚实地靠 lastVerifiedAt 告诉调用方这是什么时候的）
    expect(h.k.plugins.list().find((p) => p.id === id)!.ok).toBe(true)
    const checked = await h.k.plugins.verify(id)
    expect(checked!.ok).toBe(false)
    expect(checked!.problems.some((p) => p.code === 'HASH_MISMATCH')).toBe(true)
    expect(checked!.lastVerifiedAt).toBeGreaterThanOrEqual(first.lastVerifiedAt!)
    expect(h.k.plugins.list().find((p) => p.id === id)!.ok).toBe(false)
    await expect(h.k.plugins.callTool(id, 'echo', {})).rejects.toThrow(/HASH_MISMATCH|hash mismatch/)
    writeFileSync(join(dir, 'block.js'), original)
    expect((await h.k.plugins.verify(id))!.ok).toBe(true)
  })

  it('反例：没改过的插件 verify 后仍 ok；不存在的 id 返回 undefined；verifyAll 覆盖全部', async () => {
    writePlugin('hello')
    await h.k.plugins.reload()
    expect((await h.k.plugins.verify('block.test.hello'))!.ok).toBe(true)
    expect(await h.k.plugins.verify('block.test.nope')).toBeUndefined()
    expect((await h.k.plugins.verifyAll()).every((p) => p.ok && typeof p.lastVerifiedAt === 'number')).toBe(true)
  })
})
