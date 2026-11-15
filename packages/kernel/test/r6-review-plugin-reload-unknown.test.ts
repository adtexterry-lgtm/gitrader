// SPDX-License-Identifier: CPAL-1.0
// 审稿 P1-1：reload() 在状态不明（清单读不出 / id 不是字符串、目录名≠id）时不得并入已知集合补记 plugin.removed，口径同 reconcileRemoved。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { Kernel } from '../src/kernel'
import { MANIFEST_FILE, PluginHost, pinPluginDir } from '../src/plugins'
import type { PluginManifest } from '../src/proto'
import { makeHarness } from './helpers/harness'
import type { Harness } from './helpers/harness'

let h: Harness

beforeEach(async () => {
  h = await makeHarness()
  h.k.config.plugins.developerMode = true
})
afterEach(async () => { await h.cleanup() })

const contract = JSON.parse(readFileSync(join(__dirname, '..', '..', 'protocol', 'test', 'fixtures', 'contract', 'plugin-nautilus.json'), 'utf8')) as PluginManifest

/** 放一个能通过校验的块插件（不起进程）：目录名是 name，插件 id 是 block.test.<name>（目录名 ≠ id）。 */
function installBlock(name: string): { id: string; dir: string } {
  const dir = join(h.k.paths.plugins, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'index.mjs'), 'export const ready = true')
  writeFileSync(join(dir, 'block.js'), 'export const block = true')
  const id = `block.test.${name}`
  const manifest = JSON.parse(JSON.stringify(contract)) as PluginManifest
  Object.assign(manifest, {
    id, package: 'block', kind: 'block', name, desc: 'reload unknown test', version: '0.1.0', tags: ['test'],
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

const removedCount = (k: Kernel, id: string): number =>
  Array.from(k.ledger.iterate()).filter((e) => e.type === 'plugin.removed' && e.subject.pluginId === id).length

/** 新进程的插件宿主：recs 为空，已知集合取自同一个库。 */
const freshHost = (k: Kernel): PluginHost => new PluginHost({
  home: h.home, pluginsDir: k.paths.plugins, docs: k.docs, ledger: k.ledger, events: k.events, clock: h.clock,
  developerMode: () => true, trustRoots: () => [],
  knownIds: () => (k.db.prepare("SELECT DISTINCT id FROM docs WHERE coll='pluginknown'").all() as { id: string }[]).map((r) => r.id),
})

describe('审稿 P1-1 reload() 状态不明不补记 plugin.removed', () => {
  it.each([
    ['清单是坏 JSON', '{ not json'],
    ['清单 id 不是字符串', JSON.stringify({ id: 42 })],
  ])('目录在、%s、目录名≠id：新 host 的 reload() removed 为空、账本不记、已知集合保留', async (_name, broken) => {
    const keep = installBlock('keepbroken')
    await h.k.plugins.reload()
    expect(h.k.docs.get('pluginknown', keep.id)).toBeDefined()
    writeFileSync(join(keep.dir, MANIFEST_FILE), broken)
    const fresh = freshHost(h.k)
    expect((await fresh.reload()).removed).toEqual([])
    expect(removedCount(h.k, keep.id)).toBe(0)
    expect(h.k.docs.get('pluginknown', keep.id)).toBeDefined()
    expect(h.k.ledger.verify().ok).toBe(true)
  })

  it('状态不明时，另一个确实被卸载的插件也不记（整体按状态不明处理，口径同 reconcileRemoved）', async () => {
    const keep = installBlock('keepbroken2')
    const drop = installBlock('dropgone')
    await h.k.plugins.reload()
    const away = join(h.home, 'moved-away'); mkdirSync(away, { recursive: true })
    renameSync(drop.dir, join(away, basename(drop.dir)))
    writeFileSync(join(keep.dir, MANIFEST_FILE), '{ not json')
    const fresh = freshHost(h.k)
    expect((await fresh.reload()).removed).toEqual([])
    expect(removedCount(h.k, drop.id)).toBe(0)
    expect(h.k.docs.get('pluginknown', drop.id)).toBeDefined()
  })

  it('正常卸载（目录确实没了、其余清单都读得出）仍记一次 plugin.removed', async () => {
    const { id, dir } = installBlock('reallygone')
    await h.k.plugins.reload()
    const away = join(h.home, 'moved-away'); mkdirSync(away, { recursive: true })
    renameSync(dir, join(away, basename(dir)))
    const fresh = freshHost(h.k)
    expect((await fresh.reload()).removed).toEqual([id])
    expect(removedCount(h.k, id)).toBe(1)
    expect(h.k.docs.get('pluginknown', id)).toBeUndefined()
    expect((await fresh.reload()).removed).toEqual([])
    expect(removedCount(h.k, id)).toBe(1)
  })
})
