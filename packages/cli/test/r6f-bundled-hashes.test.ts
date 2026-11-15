// SPDX-License-Identifier: CPAL-1.0
// R2-REL-10：构建时生成 dist/plugins-bundled/BUNDLED-HASHES.json，随产品发布；每个随包插件目录一条，pin 与 `plugins check --json` 一致。
import { afterEach, describe, expect, it } from 'vitest'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { artifactList, bundledHashManifest, inspectPluginDir, pinOf, readBundledHashes, KERNEL_VERSION } from '@gitrader/kernel'
import { cmdPluginsInstall } from '../src/bundled'

const REPO = join(__dirname, '..', '..', '..')
const DIST = join(__dirname, '..', 'dist', 'plugins-bundled')
const tmps: string[] = []
afterEach(() => { for (const t of tmps.splice(0)) rmSync(t, { recursive: true, force: true }) })

/** 按 packages/cli/build.mjs 第 8 步的规则装出完整的随包目录（所有 plugin-notify-*）。 */
function assemble(): string {
  const root = mkdtempSync(join(tmpdir(), 'gt-r6f-hashes-'))
  tmps.push(root)
  for (const d of readdirSync(join(REPO, 'packages'), { withFileTypes: true })) {
    if (!d.isDirectory() || !d.name.startsWith('plugin-notify-')) continue
    const src = join(REPO, 'packages', d.name)
    const dest = join(root, d.name.slice('plugin-'.length))
    mkdirSync(dest, { recursive: true })
    for (const f of readdirSync(src, { withFileTypes: true })) {
      if (f.isFile() && (['gitrader-plugin.json', 'LICENSE', 'README.md'].includes(f.name) || (f.name.endsWith('.mjs') && f.name !== 'run-conformance.mjs'))) copyFileSync(join(src, f.name), join(dest, f.name))
    }
  }
  return root
}

function checkAgainstDirs(root: string, file: string): void {
  const dirs = readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort()
  expect(dirs.length).toBeGreaterThanOrEqual(6)
  const json = JSON.parse(readFileSync(file, 'utf8')) as { schema: string; plugins: { dir: string; id: string; version: string; pin: string }[] }
  expect(json.schema).toBe('gitrader-bundled-hashes/1')
  expect(json.plugins.map(p => p.dir).sort()).toEqual(dirs)
  for (const d of dirs) {
    const entry = json.plugins.find(p => p.dir === d)!
    // `gitrader plugins check <dir> --json` 打印的 pin / id / version 就是 inspectPluginDir 的结果
    const checked = inspectPluginDir(join(root, d), { developerMode: true, trustRoots: [], kernelVersion: KERNEL_VERSION })
    expect(entry.pin).toBe(checked.pin)
    expect(entry.pin).toBe(pinOf(artifactList(join(root, d))))
    expect(entry.id).toBe(checked.id)
    expect(entry.version).toBe(checked.version)
    expect(entry.pin).toMatch(/^sha256:[0-9a-f]{64}$/)
  }
  expect(readBundledHashes(file)).toHaveLength(dirs.length)
}

describe('R2-REL-10 随包哈希清单', () => {
  it('[R6F-PT1] build writes plugins-bundled/BUNDLED-HASHES.json whose pins match every bundled plugin directory', async () => {
    // 1) 生成函数（build.mjs 用的就是它）：每个随包目录一条，pin 与目录内容一致；装上以后 developerMode 关着也放行
    const root = assemble()
    const file = join(root, 'BUNDLED-HASHES.json')
    writeFileSync(file, `${JSON.stringify(bundledHashManifest(root), null, 2)}\n`)
    checkAgainstDirs(root, file)
    const home = mkdtempSync(join(tmpdir(), 'gt-r6f-home-'))
    tmps.push(home)
    const out: string[] = []
    const io = { out: (s: string) => { out.push(s) }, err: (s: string) => { out.push(s) }, env: {}, readSecret: async () => '', interactive: false }
    expect(await cmdPluginsInstall(home, { cmd: ['plugins', 'install', 'notify-webhook'], flags: {} }, io as never, root)).toBe(0)
    expect(out.join('')).toContain('随包内置信任')
    expect(out.join('')).not.toMatch(/developerMode/)
    // 2) 已构建的产物（G3 之后的 dist）：清单存在，条目与 dist 里的目录逐个一致
    if (existsSync(DIST)) {
      expect(existsSync(join(DIST, 'BUNDLED-HASHES.json'))).toBe(true)
      checkAgainstDirs(DIST, join(DIST, 'BUNDLED-HASHES.json'))
    }
  })
})
