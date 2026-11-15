// SPDX-License-Identifier: CPAL-1.0
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { assertSafeRelativePath } from '../src/util/confined-path'
import { MANIFEST_FILE, pinPluginDir } from '../src/plugins'
import type { PluginManifest } from '../src/proto'
import { makeHarness } from './helpers/harness'
import type { Harness } from './helpers/harness'

let h: Harness

beforeEach(async () => {
  h = await makeHarness()
  h.k.config.plugins.developerMode = true
})
afterEach(async () => { await h.cleanup() })
function serverUrl(protocol: 'http' | 'ws' = 'http'): string {
  const address = h.k.http?.server.address()
  if (!address || typeof address === 'string') throw new Error('HTTP server address unavailable')
  const host = address.address.includes(':') ? `[${address.address}]` : address.address
  return `${protocol}://${host}:${address.port}`
}

const contract = JSON.parse(readFileSync(join(__dirname, '..', '..', 'protocol', 'test', 'fixtures', 'contract', 'plugin-nautilus.json'), 'utf8')) as PluginManifest

function installBlock(name: string): string {
  const dir = join(h.k.paths.plugins, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'index.mjs'), 'export const ready = true')
  writeFileSync(join(dir, 'block.js'), 'export const block = true')
  const manifest = JSON.parse(JSON.stringify(contract)) as PluginManifest
  Object.assign(manifest, {
    id: `block.test.${name}`, package: 'block', kind: 'block', name, desc: 'path test', version: '0.1.0', tags: ['test'],
    vendor: { ...contract.vendor, id: 'test' }, tools: [], permissions: ['ui.block'], net: undefined, engine: undefined, requires: undefined, signature: undefined, evidence: undefined,
    runtime: { type: 'node', node: '22', native: false, diskMB: 1 }, entry: { module: 'index.mjs' },
    install: { by: 'user-install', requireHashes: true }, provides: { blocks: [`block.test.${name}`] },
    ui: { blocks: [{ id: `block.test.${name}`, name: 'Test block', entry: { module: 'block.js', element: 'x-test' } }] },
    license: { spdx: 'Apache-2.0', redistribute: 'bundle', notice: 'test', commercialUse: true },
    source: { repo: 'local/test', commit: 'a'.repeat(40), sha256: 'sha256:' + '0'.repeat(64), fetchedAt: 1 },
    compat: { gitrader: '>=0.1.0 <0.2.0', pluginSchema: '1' },
  } as Partial<PluginManifest>)
  for (const key of Object.keys(manifest) as (keyof PluginManifest)[]) if (manifest[key] === undefined) delete manifest[key]
  writeFileSync(join(dir, MANIFEST_FILE), JSON.stringify(manifest, null, 2))
  pinPluginDir(dir)
  return `block.test.${name}`
}

describe('B3 static plugin paths', () => {
  it('serves a valid block asset with the existing sandbox Origin exemption', async () => {
    const id = installBlock('safe')
    expect((await h.k.plugins.reload()).rejected).toEqual([])
    await h.k.start({ port: 0 })

    const response = await fetch(`${serverUrl()}/plugins/${id}/block.js`, { headers: { origin: 'null', 'sec-fetch-site': 'cross-site' } })

    expect(response.status).toBe(200)
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    expect(await response.text()).toContain('export const block = true')
  })

  it('rejects encoded ADS and reserved-name paths without disclosing a physical path', async () => {
    const id = installBlock('safe')
    expect((await h.k.plugins.reload()).rejected).toEqual([])
    await h.k.start({ port: 0 })

    const ads = await fetch(`${serverUrl()}/plugins/${id}/block.js%3A%3A%24DATA`)
    const reserved = await fetch(`${serverUrl()}/plugins/${id}/CON.txt`)

    expect(ads.status).toBe(404)
    expect(reserved.status).toBe(404)
    expect(await ads.text()).not.toContain(h.k.paths.plugins)
    expect(() => assertSafeRelativePath('block.js::$DATA')).toThrow()
    expect(() => assertSafeRelativePath('folder\\..\\block.js')).toThrow()
    expect(() => assertSafeRelativePath('CON.txt')).toThrow()
  })
})
