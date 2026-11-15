// SPDX-License-Identifier: CPAL-1.0
// 插件权限：新增 / 放宽要 PIN（裁决 10）；只收窄或启用（空数组）不需要；plugin.list 带清单里的 license。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pinPluginDir, MANIFEST_FILE } from '../src/plugins'
import type { PluginManifest } from '../src/proto'
import { makeHarness, TEST_PIN } from './helpers/harness'
import type { Harness } from './helpers/harness'

let h: Harness
beforeEach(async () => {
  h = await makeHarness()
  h.k.config.plugins.developerMode = true
})
afterEach(async () => { await h.cleanup() })

const base = JSON.parse(readFileSync(join(__dirname, '..', '..', 'protocol', 'test', 'fixtures', 'contract', 'plugin-nautilus.json'), 'utf8')) as PluginManifest

function writePlugin(name: string, over: Partial<PluginManifest> = {}): string {
  const dir = join(h.k.paths.plugins, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'index.mjs'), 'export {}')
  const m = JSON.parse(JSON.stringify(base)) as PluginManifest
  Object.assign(m, {
    id: `block.test.${name}`, package: 'block', kind: 'block', name, desc: 'test plugin', version: '0.1.0', tags: ['test'],
    vendor: { ...base.vendor, id: 'test' },
    tools: [], permissions: ['market.read', 'ui.block'], net: undefined, engine: undefined, requires: undefined, signature: undefined, evidence: undefined,
    runtime: { type: 'node', node: '22', native: false, diskMB: 1 }, entry: { module: 'index.mjs' },
    install: { by: 'user-install', requireHashes: true }, provides: { blocks: [`block.test.${name}`] },
    ui: { blocks: [{ id: `block.test.${name}`, name, entry: { module: 'index.mjs', element: 'x-test' } }] },
    license: { spdx: 'Apache-2.0', redistribute: 'bundle', notice: 'n', commercialUse: true },
    source: { repo: 'local/test', commit: 'a'.repeat(40), sha256: 'sha256:' + '0'.repeat(64), fetchedAt: 1 },
    compat: { gitrader: '>=0.1.0 <0.2.0', pluginSchema: '1' },
  } as Partial<PluginManifest>, over)
  for (const k of Object.keys(m) as (keyof PluginManifest)[]) if (m[k] === undefined) delete m[k]
  writeFileSync(join(dir, MANIFEST_FILE), JSON.stringify(m, null, 2))
  pinPluginDir(dir)
  return dir
}

const grant = (id: string, permissions: string[], pin?: string): Promise<unknown> =>
  h.k.ops.call(h.k, 'plugin.grant', { principal: h.session, params: { id, permissions }, transport: 'ws', ...(pin !== undefined ? { pin } : {}) })

describe('plugin.grant：新增 / 放宽权限要 PIN', () => {
  it('adding a permission with only a session asks for a PIN', async () => {
    writePlugin('hello')
    await h.k.plugins.reload()
    const id = 'block.test.hello'
    await grant(id, [])
    expect(h.k.plugins.get(id)!.granted).toEqual([])
    await expect(grant(id, ['ui.block'])).rejects.toMatchObject({ problem: { name: 'ATTESTATION_REQUIRED' } })
    expect(h.k.plugins.get(id)!.granted).toEqual([])
  })

  it('adding a permission with a PIN proof succeeds', async () => {
    await h.pinProof()
    writePlugin('hello')
    await h.k.plugins.reload()
    const id = 'block.test.hello'
    await grant(id, [], TEST_PIN)
    await grant(id, ['ui.block'], TEST_PIN)
    expect(h.k.plugins.get(id)!.granted).toEqual(['ui.block'])
  })

  it('narrowing or enabling with an empty list needs no PIN', async () => {
    await h.pinProof()
    writePlugin('hello')
    await h.k.plugins.reload()
    const id = 'block.test.hello'
    await grant(id, ['market.read', 'ui.block'], TEST_PIN)
    expect(h.k.plugins.get(id)!.granted).toEqual(['market.read', 'ui.block'])
    await grant(id, ['market.read'])
    expect(h.k.plugins.get(id)!.granted).toEqual(['market.read', 'ui.block'])
    writePlugin('fresh')
    await h.k.plugins.reload()
    await grant('block.test.fresh', [])
    expect(h.k.plugins.get('block.test.fresh')!.enabled).toBe(true)
    expect(h.k.plugins.get('block.test.fresh')!.granted).toEqual([])
  })
})

describe('plugin.list：许可证', () => {
  it('plugin.list exposes the manifest license', async () => {
    writePlugin('hello')
    writePlugin('nolicense', { license: undefined })
    await h.k.plugins.reload()
    const rows = (await h.k.ops.call(h.k, 'plugin.list', { principal: h.session, params: {}, transport: 'ws' })) as Record<string, unknown>[]
    const hello = rows.find((r) => r['id'] === 'block.test.hello')!
    expect(hello['license']).toEqual({ spdx: 'Apache-2.0', redistribute: 'bundle', notice: 'n', commercialUse: true })
    const nolicense = rows.find((r) => r['id'] === 'block.test.nolicense')!
    expect('license' in nolicense).toBe(false)
  })
})
