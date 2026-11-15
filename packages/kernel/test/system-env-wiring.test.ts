// SPDX-License-Identifier: CPAL-1.0
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import type { SpawnOptions } from 'node:child_process'
import { join } from 'node:path'
import { EngineSupervisor } from '../src/engines'
import { MANIFEST_FILE, pinPluginDir } from '../src/plugins'
import { minimalSystemEnv } from '../src/util/system-env'
import type { PluginManifest } from '../src/proto'
import { makeHarness } from './helpers/harness'
import type { Harness } from './helpers/harness'

const spawnRecords = vi.hoisted((): { command: string; env?: Record<string, string | undefined> }[] => [])
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      spawnRecords.push({ command: String(args[0]), env: (args[2] as SpawnOptions | undefined)?.env })
      return actual.spawn(...args)
    },
  }
})

let h: Harness
const oldSystemRoot = process.env.SystemRoot
const oldSystemDrive = process.env.SystemDrive
const restoreSystemEnv = (): void => {
  if (oldSystemRoot === undefined) delete process.env.SystemRoot
  else process.env.SystemRoot = oldSystemRoot
  if (oldSystemDrive === undefined) delete process.env.SystemDrive
  else process.env.SystemDrive = oldSystemDrive
}
beforeEach(() => {
  spawnRecords.length = 0
  process.env.SystemDrive = 'Z:'
})
afterEach(async () => {
  restoreSystemEnv()
  await h?.cleanup()
  h = undefined as unknown as Harness
})

describe('最小子进程系统环境接线', () => {
  it('SystemDrive 缺失时从 Windows SystemRoot 推导盘符', () => {
    if (process.platform !== 'win32') return
    process.env.SystemRoot = 'Q:\\fixture-system-root'
    delete process.env.SystemDrive
    expect(minimalSystemEnv()).toEqual({ SystemRoot: 'Q:\\fixture-system-root', SystemDrive: 'Q:' })
  })

  it('engine supervisor 启动的子进程收到受控 SystemDrive', async () => {
    h = await makeHarness()
    const supervisor = new EngineSupervisor({ clock: h.clock, events: h.k.events, ledger: h.k.ledger, home: h.home })
    try {
      supervisor.load([{ id: 'env-engine', enabled: true, launch: { command: process.execPath, args: ['-e', "process.stdin.on('end', () => process.exit(0)); process.stdin.resume()"] } }])
      supervisor.start('env-engine')
      const call = spawnRecords.find(record => record.env?.GITRADER_GEP_TOKEN !== undefined)
      expect(call?.command).toBe(process.execPath)
      expect(call?.env?.SystemDrive).toBe(process.platform === 'win32' ? 'Z:' : undefined)
    } finally { await supervisor.stop('env-engine', 300) }
  })

  it('plugin host 启动的子进程收到受控 SystemDrive', async () => {
    h = await makeHarness()
    h.k.config.plugins.developerMode = true
    const dir = join(h.k.paths.plugins, 'system-env')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'index.mjs'), `process.stdin.setEncoding('utf8'); let buf=''; process.stdin.on('data', d => { buf += d; let i; while ((i=buf.indexOf('\\n')) >= 0) { const m=JSON.parse(buf.slice(0,i)); buf=buf.slice(i+1); if (m.method === 'plugin.hello') process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{ok:true}})+'\\n'); else if (m.method === 'plugin.shutdown') { process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{ok:true}})+'\\n'); setTimeout(() => process.exit(0), 10); } } })`)
    writeFileSync(join(dir, 'block.js'), 'export {}')
    const base = JSON.parse(readFileSync(join(__dirname, '..', '..', 'protocol', 'test', 'fixtures', 'contract', 'plugin-nautilus.json'), 'utf8')) as PluginManifest
    const manifest = { ...base, id: 'block.test.system-env', package: 'block', kind: 'block', name: 'system-env', desc: 'test plugin', version: '0.1.0', tags: ['test'], vendor: { ...base.vendor, id: 'test' }, tools: [{ name: 'env', desc: 'env', tags: ['utility'], input: { type: 'object' } }], permissions: ['market.read', 'ui.block'], net: undefined, engine: undefined, requires: undefined, signature: undefined, evidence: undefined, runtime: { type: 'node', node: '22', native: false, diskMB: 1 }, entry: { module: 'index.mjs' }, install: { by: 'user-install', requireHashes: true }, provides: { blocks: ['block.test.hello'] }, ui: { blocks: [{ id: 'block.test.hello', name: 'Hello', entry: { module: 'block.js', element: 'x-hello' } }] }, license: { spdx: 'Apache-2.0', redistribute: 'bundle', notice: 'n', commercialUse: true }, source: { repo: 'local/test', commit: 'a'.repeat(40), sha256: 'sha256:' + '0'.repeat(64), fetchedAt: 1 }, compat: { gitrader: '>=0.1.0 <0.2.0', pluginSchema: '1' } }
    for (const key of Object.keys(manifest) as (keyof typeof manifest)[]) if (manifest[key] === undefined) delete manifest[key]
    writeFileSync(join(dir, MANIFEST_FILE), JSON.stringify(manifest))
    pinPluginDir(dir)
    const reloaded = await h.k.plugins.reload()
    expect(reloaded.rejected, reloaded.rejected.map(record => record.issues.join('; ')).join(' | ')).toEqual([])
    await h.k.plugins.start('block.test.system-env')
    const call = spawnRecords.find(record => record.env?.GITRADER_GSP_TOKEN !== undefined)
    expect(call?.command).toBe(process.execPath)
    expect(call?.env?.SystemDrive).toBe(process.platform === 'win32' ? 'Z:' : undefined)
  })
})
