// SPDX-License-Identifier: CPAL-1.0
// 复审 N1 + N2：reload() 判「状态不明」只认本轮开头那次读盘的结果；状态不明时一律不记 plugin.removed、不动已知集合。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Kernel } from '../src/kernel'
import { MANIFEST_FILE, PluginHost, inspectPluginDir, pinPluginDir } from '../src/plugins'
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

/** 放一个能通过校验的块插件（不起进程）：目录名是 name，插件 id 是 block.test.<name>。 */
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

describe('复审 N1/N2 reload() 状态不明不补记 plugin.removed', () => {
  it('N1：开头读清单失败、末尾又读得出（杀毒软件锁文件刚好在两次读之间释放）-> removed 为空、账本不记、已知集合保留', async () => {
    const keep = installBlock('toctou')
    await h.k.plugins.reload()
    expect(h.k.docs.get('pluginknown', keep.id)).toBeDefined()
    const fresh = freshHost(h.k)
    const real = fresh.inspect.bind(fresh)
    // 开头那次 inspect 读不出清单（指向一个不存在的目录，id 退回目录名）；磁盘上的清单其实完好，之后任何第二次读盘都会读得出
    fresh.inspect = (dir, probe) => dir === keep.dir
      ? inspectPluginDir(join(h.home, 'nonexistent', 'toctou'), { developerMode: true, trustRoots: [], kernelVersion: '' }, probe)
      : real(dir, probe)
    expect((await fresh.reload()).removed).toEqual([])
    expect(removedCount(h.k, keep.id)).toBe(0)
    expect(h.k.docs.get('pluginknown', keep.id)).toBeDefined()
    expect(h.k.ledger.verify().ok).toBe(true)
  })

  it('N2：同一进程里清单变坏后 reload() -> removed 为空、账本不记、已知集合保留；清单恢复后不补记 installed、也不重复记', async () => {
    const keep = installBlock('inproc')
    await h.k.plugins.reload()
    expect(h.k.plugins.get(keep.id)).toBeDefined()
    const good = readFileSync(join(keep.dir, MANIFEST_FILE), 'utf8')
    writeFileSync(join(keep.dir, MANIFEST_FILE), '{ not json')
    expect((await h.k.plugins.reload()).removed).toEqual([])
    expect(removedCount(h.k, keep.id)).toBe(0)
    expect(h.k.docs.get('pluginknown', keep.id)).toBeDefined()
    expect(h.k.ledger.verify().ok).toBe(true)

    writeFileSync(join(keep.dir, MANIFEST_FILE), good)
    const back = await h.k.plugins.reload()
    expect(back.removed).toEqual([])
    expect(back.added).toEqual([])
    expect(removedCount(h.k, keep.id)).toBe(0)
  })
})
