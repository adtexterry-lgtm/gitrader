// SPDX-License-Identifier: Apache-2.0
// 示例插件的清单与目录：gitrader-plugin/1 校验、钉版本 + 哈希（拿内核自己的加载器对拍）、权限声明、块桥规则、产物没过期。
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { KernelClient, LinkHub, createHostBridge, validateBlockManifest as validateSdkBlock, type BlockManifest } from '@gitrader/blocks-sdk'
import { startFakeKernel, type FakeKernel } from '@gitrader/blocks-sdk/testing'
import { PluginHost, artifactList, pinOf } from '@gitrader/kernel'
import { NEVER_GRANTABLE_PERMISSIONS, checkPluginManifest, validatePluginManifest, type PluginManifest } from '@gitrader/protocol'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
// @ts-expect-error 纯 JS 脚本，没有类型声明
import { artifactList as myArtifactList, pinOf as myPinOf } from '../scripts/pin.mjs'

const root = resolve(__dirname, '..')
const dir = join(root, 'example/ema-reading')
const read = <T>(f: string): T => JSON.parse(readFileSync(join(dir, f), 'utf8')) as T
const plugin = read<PluginManifest>('gitrader-plugin.json')
const block = read<BlockManifest>('block.json')

/** 只用到 inspect() 的最小宿主（inspect 只读 developerMode / trustRoots，不碰数据库与账本）。 */
const host = (developerMode: boolean) => new PluginHost({ home: tmpdir(), pluginsDir: tmpdir(), developerMode: () => developerMode, trustRoots: () => [] } as never)

describe('gitrader-plugin/1 清单', () => {
  it('过协议校验（含跨字段规则）', () => {
    const r = validatePluginManifest(plugin)
    expect(r.ok, JSON.stringify(r.ok ? [] : r.issues)).toBe(true)
    expect(checkPluginManifest(plugin)).toEqual([])
  })

  it('是一个 block 插件、精确版本、没有网络与密钥、不申请不可授予的权限', () => {
    expect(plugin.kind).toBe('block')
    expect(plugin.package).toBe('block')
    expect(plugin.version).toMatch(/^\d+\.\d+\.\d+$/)
    expect(plugin.runtime.type).toBe('browser')
    expect(plugin.install.requireHashes).toBe(true)
    expect(plugin.net).toBeUndefined()
    expect(plugin.secrets).toBeUndefined()
    expect(plugin.privacy).toEqual({ hosted: false, sends: [] })
    for (const p of plugin.permissions) expect(NEVER_GRANTABLE_PERMISSIONS as readonly string[]).not.toContain(p)
    expect(plugin.permissions.sort()).toEqual(['market.read', 'ui.block'])
    expect(plugin.license.spdx).toBe('Apache-2.0')
  })

  it('权限只有最小集：多申请一项（比如 trade.live）校验就挡住', () => {
    const bad = { ...plugin, permissions: [...plugin.permissions, 'trade.live'] } as PluginManifest
    expect(checkPluginManifest(bad).join(' ')).toContain('trade.live')
    const badNet = { ...plugin, permissions: [...plugin.permissions, 'net.fetch'] } as PluginManifest
    expect(checkPluginManifest(badNet).join(' ')).toMatch(/net\.fetch/)
    const never = { ...plugin, permissions: ['withdraw'] } as unknown as PluginManifest
    expect(checkPluginManifest(never).join(' ')).toContain('can never be granted')
  })

  it('钉版本：清单里的 source.sha256 等于目录内容哈希（内核算法）；脚本的算法与内核一致', () => {
    const arts = artifactList(dir)
    expect(arts.map((a) => a.path)).toEqual(['block.js', 'block.json', 'fixtures/candles.json'])
    expect(plugin.source.sha256).toBe(pinOf(arts))
    expect(myArtifactList(dir)).toEqual(arts)
    expect(myPinOf(myArtifactList(dir))).toBe(pinOf(arts))
  })
})

describe('内核的插件宿主装载它', () => {
  it('开发者模式下：校验通过、列出一个块；没开开发者模式：未签名被拒（原因写明）', () => {
    const ok = host(true).inspect(dir)
    expect(ok.issues).toEqual([])
    expect(ok.ok).toBe(true)
    expect(ok.blocks).toEqual([{ id: 'block.example.ema-reading', name: 'EMA 读数', entry: { module: './block.js', element: 'gr-ema-reading' } }])
    expect(ok.pin).toBe(plugin.source.sha256)
    const refused = host(false).inspect(dir)
    expect(refused.ok).toBe(false)
    expect(refused.issues.join(' ')).toContain('unsigned plugin')
  })

  it('改了目录里任何一个文件：哈希对不上，拒装并提示怎么重新钉', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'gr-plugin-'))
    try {
      cpSync(dir, tmp, { recursive: true })
      expect(host(true).inspect(tmp).ok).toBe(true)
      writeFileSync(join(tmp, 'block.js'), readFileSync(join(tmp, 'block.js'), 'utf8') + '\n// tampered\n')
      const r = host(true).inspect(tmp)
      expect(r.ok).toBe(false)
      expect(r.issues.join(' ')).toMatch(/hash mismatch.*gitrader plugins pin/)
    } finally { rmSync(tmp, { recursive: true, force: true }) }
  })

  it('入口文件不存在 / 逃出目录都被拒', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'gr-plugin-'))
    try {
      cpSync(dir, tmp, { recursive: true })
      const m = JSON.parse(readFileSync(join(tmp, 'gitrader-plugin.json'), 'utf8')) as PluginManifest
      writeFileSync(join(tmp, 'gitrader-plugin.json'), JSON.stringify({ ...m, entry: { module: '../outside.js', element: 'gr-x' } }))
      expect(host(true).inspect(tmp).issues.join(' ')).toMatch(/entry\.module/)
    } finally { rmSync(tmp, { recursive: true, force: true }) }
  })
})

describe('块清单 gitrader-block/1', () => {
  it('SDK 校验通过；第三方块必须是 iframe 隔离，不钉住', () => {
    expect(validateSdkBlock(block)).toEqual([])
    expect(block.isolation).toBe('iframe')
    expect(block.pinned).toBeUndefined()
    expect(block.id).toBe(plugin.id)
    expect(block.version).toBe(plugin.version)
  })
  it('块权限是插件权限的子集（ui.block 不是块清单里的权限）；不带命令、不联网', () => {
    for (const p of block.permissions) expect(plugin.permissions as string[]).toContain(p)
    expect(block.actions ?? []).toEqual([])
    expect(block.permissions).not.toContain('net.fetch')
    expect(block.inputs?.events?.every((e) => e.maxHz && e.maxHz > 0)).toBe(true)
  })
  it('回放文件的查询与事件都是块声明过的', () => {
    const fx = read<{ events: Array<{ topic: string }>; queries: Record<string, unknown> }>('fixtures/candles.json')
    for (const q of Object.keys(fx.queries)) expect(block.inputs?.queries).toContain(q)
    for (const e of fx.events) expect(block.inputs?.events?.map((x) => x.topic)).toContain(e.topic)
    expect(plugin.fixtures.offline).toEqual(['fixtures/candles.json'])
  })
})

describe('块桥对这个第三方块的约束（假内核 + 真桥）', () => {
  let kernel: FakeKernel
  let client: KernelClient
  beforeAll(async () => {
    kernel = await startFakeKernel()
    kernel.onQuery('market.candles', () => [{ t: 1, o: 1, h: 1, l: 1, c: 1, v: 1 }])
    const boot = await fetch(`${kernel.url}/api/session`, { method: 'POST', body: JSON.stringify({ bootstrap: kernel.bootstrapToken }) }).then((r) => r.json() as Promise<{ sessionToken: string }>)
    client = new KernelClient({ url: kernel.wsUrl, getToken: () => boot.sessionToken, WebSocketCtor: (await import('ws')).WebSocket as never, reconnect: false })
    await client.connect()
  })
  afterAll(async () => { client.close(); await kernel.close() })
  const bridge = () => createHostBridge({ manifest: block, instanceId: 'bi_x', kernel: client, hub: new LinkHub({ A: { symbol: 'hyperliquid:BTC' } }), trusted: false, schedule: (fn) => fn() })

  it('声明过的可以：读行情 K 线、订阅 market.candles、读联动的标的', async () => {
    const b = bridge()
    expect(await b.query('market.candles', { limit: 1 })).toHaveLength(1)
    const off = b.subscribe('market.candles', () => undefined)
    off()
    expect((await b.hello()).links.symbol).toBe('hyperliquid:BTC')
  })
  it('没声明的一律被拒：账户 / 账本 / 持仓、任何命令（包括批准）、改联动', async () => {
    const b = bridge()
    expect(() => b.subscribe('account.positions', () => undefined)).toThrowError(/没有声明/)
    expect(() => b.subscribe('ledger.entry', () => undefined)).toThrowError(/没有声明/)
    await expect(b.query('ledger.query')).rejects.toMatchObject({ code: 'QUERY_NOT_ALLOWED' })
    await expect(b.command('takeover.flatten_all', {})).rejects.toMatchObject({ code: 'ACTION_NOT_DECLARED' })
    await expect(b.command('proposal.approve', { id: 'x' })).rejects.toMatchObject({ code: 'ACTION_NOT_DECLARED' })
    expect(() => b.link.set('symbol', 'x')).toThrowError(/未声明可写联动组/)
  })
})

describe('构建产物', () => {
  it('example/ema-reading/block.js 是当前源码打出来的（改了源码要重新 npm run build）', async () => {
    const r = await build({ entryPoints: [join(root, 'src/block.ts')], bundle: true, write: false, format: 'esm', target: 'es2022', minify: false, legalComments: 'none', logLevel: 'silent', outfile: join(root, 'out.js') })
    expect(r.outputFiles[0]!.text).toBe(readFileSync(join(dir, 'block.js'), 'utf8'))
  })
  it('产物不联网、不碰存储、不写 innerHTML、没有外链', () => {
    const js = readFileSync(join(dir, 'block.js'), 'utf8')
    expect(js).not.toMatch(/\bfetch\(|XMLHttpRequest|WebSocket|localStorage|sessionStorage|indexedDB|innerHTML|eval\(|new Function/)
    expect(js).not.toMatch(/https?:\/\//)
  })
  it('源码与产物没有颜色字面量，源文件头是 Apache-2.0', () => {
    for (const f of ['src/ema.ts', 'src/block.ts', 'src/index.ts', 'scripts/pin.mjs', 'scripts/build.mjs']) {
      const t = readFileSync(join(root, f), 'utf8')
      expect(t.split('\n').slice(0, 3).join('\n'), f).toContain('SPDX-License-Identifier: Apache-2.0')
      expect(t, f).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/)
    }
  })
})
