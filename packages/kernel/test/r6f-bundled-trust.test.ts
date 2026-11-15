// SPDX-License-Identifier: CPAL-1.0
// R2-REL-10：随包插件靠“构建时生成、随产品发布”的内容哈希清单获得信任（不引入签名私钥）；改过的随包插件必须被拒；
// 用户可写目录（GITRADER_HOME）里的同名清单一概不认。
import { afterEach, describe, expect, it } from 'vitest'
import { appendFileSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { bundledHashManifest, inspectPluginDir, pinPluginDir, readBundledHashes } from '../src/plugins'
import type { BundledHash } from '../src/plugins'
import { makeHarness } from './helpers/harness'
import type { Harness } from './helpers/harness'

const WEBHOOK_SRC = resolve(__dirname, '..', '..', 'plugin-notify-webhook')
const roots: string[] = []
let h: Harness | undefined
afterEach(async () => {
  await h?.cleanup(); h = undefined
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

/** 按 packages/cli/build.mjs 第 8 步的规则装出一个“随包目录”（只含 notify-webhook）。 */
function bundledRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'gt-r6f-bundled-'))
  roots.push(root)
  const dest = join(root, 'notify-webhook')
  mkdirSync(dest, { recursive: true })
  for (const f of readdirSync(WEBHOOK_SRC, { withFileTypes: true })) {
    if (!f.isFile()) continue
    if (['gitrader-plugin.json', 'LICENSE', 'README.md'].includes(f.name) || (f.name.endsWith('.mjs') && f.name !== 'run-conformance.mjs')) copyFileSync(join(WEBHOOK_SRC, f.name), join(dest, f.name))
  }
  return root
}
/** 模拟 `gitrader plugins install`：拷到用户目录并现场钉版本。 */
function install(root: string, into: string): string {
  const dest = join(into, 'notify-webhook')
  mkdirSync(into, { recursive: true })
  cpSync(join(root, 'notify-webhook'), dest, { recursive: true })
  pinPluginDir(dest)
  return dest
}
const strict = (dir: string, bundledHashes?: readonly BundledHash[]) => inspectPluginDir(dir, { developerMode: false, trustRoots: [], kernelVersion: '', ...(bundledHashes ? { bundledHashes } : {}) })
const unsigned = (r: ReturnType<typeof strict>) => r.problems.filter(p => p.code === 'UNSIGNED_NOT_ALLOWED')

describe('R2-REL-10 随包插件内置信任', () => {
  it('[R6F-PT2] bundled plugin whose content pin is on the list is trusted with developerMode=false', () => {
    const root = bundledRoot()
    const manifest = bundledHashManifest(root)
    expect(manifest.schema).toBe('gitrader-bundled-hashes/1')
    expect(manifest.plugins.map(p => p.dir)).toEqual(['notify-webhook'])
    const installed = install(root, mkdtempSync(join(tmpdir(), 'gt-r6f-home-')))
    roots.push(join(installed, '..'))
    // 没有清单：照旧 UNSIGNED_NOT_ALLOWED
    expect(unsigned(strict(installed))).toHaveLength(1)
    // 有清单且 id / version / pin / 清单摘要都对得上：放行，且不要求 developerMode
    const ok = strict(installed, manifest.plugins)
    expect(ok.problems).toEqual([])
    expect(ok.ok).toBe(true)
    expect(ok.trusted).toBe(true)
    expect(ok.signed).toBe(false)
    // 清单文件读写往返
    const file = join(root, 'BUNDLED-HASHES.json')
    writeFileSync(file, JSON.stringify(manifest))
    expect(readBundledHashes(file)).toEqual(manifest.plugins)
    // 坏清单（schema 不对 / 条目格式不对）= 没有信任
    writeFileSync(file, JSON.stringify({ schema: 'other/1', plugins: manifest.plugins }))
    expect(readBundledHashes(file)).toEqual([])
    writeFileSync(file, JSON.stringify({ schema: manifest.schema, plugins: [{ ...manifest.plugins[0], pin: 'sha256:xyz' }] }))
    expect(readBundledHashes(file)).toEqual([])
    expect(readBundledHashes(join(root, 'missing.json'))).toEqual([])
  })

  it('[R6F-PT3] modified + re-pinned bundled plugin is rejected with developerMode=false; a hash list inside GITRADER_HOME is ignored', async () => {
    const root = bundledRoot()
    const list = bundledHashManifest(root).plugins
    const homeDir = mkdtempSync(join(tmpdir(), 'gt-r6f-home-'))
    roots.push(homeDir)
    // 改了任何一个文件，即使用 plugins pin 重新钉过版本（清单自洽），也被拒
    const tampered = install(root, homeDir)
    appendFileSync(join(tampered, 'webhook.mjs'), '\n// tampered\n')
    pinPluginDir(tampered)
    const bad = strict(tampered, list)
    expect(bad.ok).toBe(false)
    expect(unsigned(bad)).toHaveLength(1)
    expect(bad.trusted).toBe(false)
    // 只改清单（权限 / 描述）不动制品：pin 不变，但清单摘要对不上，同样被拒
    const edited = install(root, mkdtempSync(join(tmpdir(), 'gt-r6f-home-')))
    roots.push(join(edited, '..'))
    const m = JSON.parse(readFileSync(join(edited, 'gitrader-plugin.json'), 'utf8')) as { desc: string }
    m.desc = `${m.desc} (edited)`
    writeFileSync(join(edited, 'gitrader-plugin.json'), JSON.stringify(m, null, 2))
    expect(unsigned(strict(edited, list))).toHaveLength(1)
    // 内核：用户目录里放一份“对得上篡改版”的清单，一概不认
    h = await makeHarness({})
    const dir = join(h.home, 'plugins', 'notify-webhook')
    cpSync(tampered, dir, { recursive: true })
    const forged = JSON.stringify(bundledHashManifest(join(h.home, 'plugins')))
    for (const p of [join(h.home, 'BUNDLED-HASHES.json'), join(h.home, 'plugins-bundled', 'BUNDLED-HASHES.json'), join(h.home, 'plugins', 'BUNDLED-HASHES.json')]) {
      mkdirSync(join(p, '..'), { recursive: true })
      writeFileSync(p, forged)
    }
    expect(existsSync(join(h.home, 'plugins-bundled', 'BUNDLED-HASHES.json'))).toBe(true)
    const result = await h.k.plugins.reload()
    const rejected = result.rejected.find(r => r.id === 'connector.gitrader.notify-webhook')
    expect(rejected, JSON.stringify(result)).toBeDefined()
    expect(rejected!.problems.map(p => p.code)).toContain('UNSIGNED_NOT_ALLOWED')
  })
})
