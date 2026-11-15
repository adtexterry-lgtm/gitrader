// SPDX-License-Identifier: CPAL-1.0
// tools/release 测试的共用取证helper：在系统临时目录里搭一个假仓库，跑真脚本，断言退出码与输出。
// 不联网、不写真实仓库：夹具一律落在 mkdtemp 出来的目录里，用完删掉。
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const RELEASE_DIR = resolve(HERE, '..')
export const REPO = resolve(HERE, '..', '..', '..')

/** 跑一个发布卫生脚本，返回 { status, stdout, stderr, output }（不抛异常）。 */
export function runScript(script, args = [], { cwd = REPO } = {}) {
  try {
    const stdout = execFileSync(process.execPath, [join(RELEASE_DIR, script), ...args], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { status: 0, stdout, stderr: '', output: stdout }
  } catch (err) {
    const stdout = String(err.stdout ?? '')
    const stderr = String(err.stderr ?? '')
    return { status: err.status ?? 1, stdout, stderr, output: `${stdout}\n${stderr}` }
  }
}

/** 搭夹具根目录：files 是 { '相对路径': '内容' }；传 null 内容表示空文件。 */
export function makeRoot(files, { copyLicense = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'gitrader-release-'))
  const write = (rel, content) => {
    const abs = join(root, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content ?? '')
  }
  for (const [rel, content] of Object.entries(files)) write(rel, content)
  if (copyLicense && !files.LICENSE) copyFileSync(join(REPO, 'LICENSE'), join(root, 'LICENSE'))
  return { root, write, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

/** 夹具的根 package.json（CPAL-1.0，workspaces = packages/*）。 */
export function rootPkgJson(extra = {}) {
  return JSON.stringify({ name: 'fixture-root', private: true, license: 'CPAL-1.0', workspaces: ['packages/*'], ...extra }, null, 2)
}

export function pkgJson(name, extra = {}) {
  return JSON.stringify({ name, version: '0.1.0', private: true, license: 'CPAL-1.0', ...extra }, null, 2)
}

export function writeBaseline(dir, entries = []) {
  const p = join(dir, 'baseline.json')
  writeFileSync(p, JSON.stringify({ entries }, null, 2))
  return p
}

export function hasDist() {
  return existsSync(join(REPO, 'packages', 'cli', 'dist'))
}

export function writeJson(dir, name, value) {
  const p = join(dir, name)
  writeFileSync(p, JSON.stringify(value, null, 2))
  return p
}
