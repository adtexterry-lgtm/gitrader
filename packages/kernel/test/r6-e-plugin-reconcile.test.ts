// SPDX-License-Identifier: CPAL-1.0
// R3-04：服务停着时卸载的插件，下次打开内核补记一条 plugin.removed（沿用已有账本类型）；已知集合同步清掉，不重复记；plugins reload 走同一套对比。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { Kernel } from '../src/kernel'
import { fileProvider } from '../src/device-key'
import { MANIFEST_FILE, PluginHost, pinPluginDir } from '../src/plugins'
import type { PluginManifest } from '../src/proto'
import { FAST_SCRYPT, makeHarness } from './helpers/harness'
import type { Harness } from './helpers/harness'

let h: Harness
const opened: Kernel[] = []

beforeEach(async () => {
  h = await makeHarness()
  h.k.config.plugins.developerMode = true
  const cfgPath = join(h.home, 'gitrader.json')
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as { plugins?: Record<string, unknown> }
  cfg.plugins = { ...(cfg.plugins ?? {}), developerMode: true }
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2))
})
afterEach(async () => {
  await Promise.all(opened.splice(0).map((k) => k.stop().catch(() => undefined)))
  await h.cleanup()
})

const contract = JSON.parse(readFileSync(join(__dirname, '..', '..', 'protocol', 'test', 'fixtures', 'contract', 'plugin-nautilus.json'), 'utf8')) as PluginManifest

/** 在插件目录里放一个能通过校验的块插件（不起进程），返回 { id, dir }。 */
function installBlock(name: string): { id: string; dir: string } {
  const dir = join(h.k.paths.plugins, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'index.mjs'), 'export const ready = true')
  writeFileSync(join(dir, 'block.js'), 'export const block = true')
  const id = `block.test.${name}`
  const manifest = JSON.parse(JSON.stringify(contract)) as PluginManifest
  Object.assign(manifest, {
    id, package: 'block', kind: 'block', name, desc: 'reconcile test', version: '0.1.0', tags: ['test'],
    vendor: { ...contract.vendor, id: 'test' }, tools: [], permissions: ['ui.block'], net: undefined, engine: undefined, requires: undefined, signature: undefined, evidence: undefined,
    runtime: { type: 'node', node: '22', native: false, diskMB: 1 }, entry: { module: 'index.mjs' },
    install: { by: 'user-install', requireHashes: true }, provides: { blocks: [id] },
    ui: { blocks: [{ id, name: 'Test block', entry: { module: 'block.js', element: 'x-test' } }] },
    license: { spdx: 'Apache-2.0', redistribute: 'bundle', notice: 'test', commercialUse: true },
    source: { repo: 'local/test', commit: 'a'.repeat(40), sha256: 'sha256:' + '0'.repeat(64), fetchedAt: 1 },
    compat: { gitrader: '>=0.1.0 <0.2.0', pluginSchema: '1' },
  } as Partial<PluginManifest>)
  for (const key of Object.keys(manifest) as (keyof PluginManifest)[]) if (manifest[key] === undefined) delete manifest[key]
  writeFileSync(join(dir, MANIFEST_FILE), JSON.stringify(manifest, null, 2))
  pinPluginDir(dir)
  return { id, dir }
}

const count = (k: Kernel, type: 'plugin.installed' | 'plugin.removed', id: string): number =>
  Array.from(k.ledger.iterate()).filter((e) => e.type === type && e.subject.pluginId === id).length

/** 把插件目录挪到插件目录之外（= 卸载）。 */
function moveAway(dir: string, tag: string): void {
  const away = join(h.home, 'moved-away', tag)
  mkdirSync(away, { recursive: true })
  renameSync(dir, join(away, basename(dir)))
}

/** 服务停着：关掉当前内核，把插件目录挪走（= 用户在没开服务时删掉它），再按同一个主目录重新打开一个内核。 */
async function stopMoveReopen(dir: string): Promise<Kernel> {
  await h.k.stop()
  moveAway(dir, `stopped-${Date.now()}`)
  return reopen()
}
async function reopen(): Promise<Kernel> {
  const k = await Kernel.create({ home: h.home, clock: h.clock, scrypt: FAST_SCRYPT, deviceKeyProvider: fileProvider, timers: false })
  opened.push(k)
  return k
}

describe('R3-04 停机卸载补记 plugin.removed', () => {
  it('开内核时补记一条 plugin.removed、移出已知集合；再开几次也不重复；账本链仍完好', async () => {
    const { id, dir } = installBlock('gone')
    expect((await h.k.plugins.reload()).added).toEqual([id])
    expect(count(h.k, 'plugin.installed', id)).toBe(1)
    expect(h.k.docs.get('pluginknown', id)).toBeDefined()

    const k2 = await stopMoveReopen(dir)
    expect(existsSync(dir)).toBe(false)
    expect(count(k2, 'plugin.removed', id)).toBe(1)
    expect(k2.docs.get('pluginknown', id)).toBeUndefined()
    const removed = Array.from(k2.ledger.iterate()).find((e) => e.type === 'plugin.removed' && e.subject.pluginId === id)!
    expect(removed.payload).toEqual({})
    expect(removed.origin.actor).toBe('system:plugins')
    await k2.stop()

    const k3 = await reopen()
    await k3.stop()
    const k4 = await reopen()
    expect(count(k4, 'plugin.removed', id)).toBe(1)
    expect(await k4.plugins.reload()).toMatchObject({ removed: [], added: [] })
    expect(count(k4, 'plugin.removed', id)).toBe(1)
    expect(k4.plugins.list().some((p) => p.id === id)).toBe(false)
    expect(k4.ledger.verify().ok).toBe(true)
  })

  it('目录还在就什么都不记；其他插件不受影响', async () => {
    const keep = installBlock('keep')
    const drop = installBlock('drop')
    await h.k.plugins.reload()
    const k2 = await stopMoveReopen(drop.dir)
    expect(count(k2, 'plugin.removed', drop.id)).toBe(1)
    expect(count(k2, 'plugin.removed', keep.id)).toBe(0)
    expect(k2.docs.get('pluginknown', keep.id)).toBeDefined()
    await k2.plugins.reload()
    expect(k2.plugins.get(keep.id)?.ok).toBe(true)
    expect(count(k2, 'plugin.removed', keep.id)).toBe(0)
  })

  it('重装后再卸载：每次卸载各记一条，安装也各记一条', async () => {
    const { id, dir } = installBlock('again')
    await h.k.plugins.reload()
    const k2 = await stopMoveReopen(dir)
    expect(count(k2, 'plugin.removed', id)).toBe(1)

    const again = installBlock('again')
    expect(again.id).toBe(id)
    expect((await k2.plugins.reload()).added).toEqual([id])
    expect(count(k2, 'plugin.installed', id)).toBe(2)
    await k2.stop()
    moveAway(again.dir, 'again')
    const k3 = await reopen()
    expect(count(k3, 'plugin.removed', id)).toBe(2)
    expect(count(k3, 'plugin.installed', id)).toBe(2)
    expect(k3.ledger.verify().ok).toBe(true)
  })
})

describe('R3-04 reload 与对账共用一套对比', () => {
  const freshHost = (k: Kernel, pluginsDir: string): PluginHost => new PluginHost({
    home: h.home, pluginsDir, docs: k.docs, ledger: k.ledger, events: k.events, clock: h.clock,
    developerMode: () => true, trustRoots: () => [],
    knownIds: () => (k.db.prepare("SELECT DISTINCT id FROM docs WHERE coll='pluginknown'").all() as { id: string }[]).map((r) => r.id),
  })

  it('本进程没见过的已知插件（磁盘上没了）：新进程的 reload() 也报 removed 并补记，且只记一次', async () => {
    const { id, dir } = installBlock('viareload')
    await h.k.plugins.reload()
    moveAway(dir, 'reload')
    const fresh = freshHost(h.k, h.k.paths.plugins)
    expect(fresh.list()).toEqual([])
    expect((await fresh.reload()).removed).toEqual([id])
    expect(count(h.k, 'plugin.removed', id)).toBe(1)
    expect((await fresh.reload()).removed).toEqual([])
    expect(count(h.k, 'plugin.removed', id)).toBe(1)
  })

  it('有一个插件目录的清单读不出（认不出它是谁）：状态不明，对账什么都不记，已知集合原样保留', async () => {
    const keep = installBlock('keepbroken')
    const drop = installBlock('dropbroken')
    await h.k.plugins.reload()
    moveAway(drop.dir, 'broken-case')
    writeFileSync(join(keep.dir, MANIFEST_FILE), '{ not json')
    const host = freshHost(h.k, h.k.paths.plugins)
    expect(host.reconcileRemoved()).toEqual([])
    expect(count(h.k, 'plugin.removed', drop.id)).toBe(0)
    expect(h.k.docs.get('pluginknown', drop.id)).toBeDefined()
  })

  it('插件目录本身读不到时状态不明：对账什么都不记，已知集合原样保留', async () => {
    const { id } = installBlock('unknownstate')
    await h.k.plugins.reload()
    const lost = freshHost(h.k, join(h.home, 'no-such-plugins-dir'))
    expect(lost.reconcileRemoved()).toEqual([])
    expect(count(h.k, 'plugin.removed', id)).toBe(0)
    expect(h.k.docs.get('pluginknown', id)).toBeDefined()
  })
})
