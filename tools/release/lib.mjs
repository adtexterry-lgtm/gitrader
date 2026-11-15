// SPDX-License-Identifier: CPAL-1.0
// tools/release 三个发布卫生脚本共用的只读小工具（只用 Node 标准库，不联网、不写仓库）。
//
// 约定：
//   - 仓库内路径一律用 posix 相对路径（'packages/cli/src/bin.ts'），与 git ls-files 一致；
//   - 目录参数用 path.join(root, rel) 交给 fs；
//   - 没有 git 仓库时（测试夹具 / 解压出来的目录）回退为遍历目录，跳过 node_modules / dist / .git / coverage。
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage', '.cache'])
const SKIP_FILES = /(^|\/)(package-lock\.json|\.DS_Store)$/

export function loadJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null }
}

export function readText(file) {
  try { return readFileSync(file, 'utf8') } catch { return null }
}

/** 极简参数解析：--key value / --key=value；只接受 allowed 里列出的键。 */
export function parseArgs(argv, allowed = []) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') { out.help = true; continue }
    if (!arg.startsWith('--')) throw new Error(`无法识别的参数：${arg}`)
    const eq = arg.indexOf('=')
    const key = eq === -1 ? arg.slice(2) : arg.slice(2, eq)
    if (!allowed.includes(key)) throw new Error(`未知参数：--${key}（可用：${allowed.map((k) => '--' + k).join(' ')}）`)
    let value = eq === -1 ? argv[i + 1] : arg.slice(eq + 1)
    if (eq === -1) {
      if (value === undefined || value.startsWith('--')) throw new Error(`--${key} 缺值`)
      i += 1
    }
    out[key] = value
  }
  return out
}

/** 版本受控的文件清单（posix 相对路径）。git 不可用时回退遍历。 */
export function listTrackedFiles(root) {
  try {
    const out = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    return out.split('\0').filter(Boolean)
  } catch { /* 不是 git 仓库 */ }
  const files = []
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (SKIP_DIRS.has(name)) continue
      const abs = join(dir, name)
      const rel = toPosix(abs.slice(root.length + 1))
      if (statSync(abs).isDirectory()) walk(abs)
      else if (!SKIP_FILES.test(rel)) files.push(rel)
    }
  }
  walk(root)
  return files.sort()
}

/** 工作区包索引：包名 -> { name, dir, abs, pkg }。只展开 packages/* 这一层（与根 package.json 一致）。 */
export function loadWorkspaces(root) {
  const rootPkg = loadJson(join(root, 'package.json'))
  const map = new Map()
  for (const pattern of rootPkg?.workspaces ?? []) {
    const base = pattern.replace(/\/\*$/, '')
    const abs = join(root, base)
    if (!existsSync(abs)) continue
    for (const name of readdirSync(abs)) {
      if (SKIP_DIRS.has(name)) continue
      const pkgPath = join(abs, name, 'package.json')
      if (!existsSync(pkgPath)) continue
      const pkg = loadJson(pkgPath)
      if (!pkg?.name) continue
      map.set(pkg.name, { name: pkg.name, dir: `${base}/${name}`, abs: join(abs, name), pkg, pkgPath })
    }
  }
  return { rootPkg, workspaces: map }
}

export function toPosix(p) {
  return p.split('\\').join('/')
}

export function posixDirname(p) {
  const i = p.lastIndexOf('/')
  return i === -1 ? '.' : p.slice(0, i)
}

export function isFile(p) {
  try { return statSync(p).isFile() } catch { return false }
}

/** 打印一行结果：ok / FAIL / note 三种前缀，与 scripts/check-public.mjs 同一套口吻。 */
export function reporter() {
  const failures = []
  const notes = []
  return {
    failures,
    notes,
    fail(msg) { failures.push(msg); console.error(`FAIL  ${msg}`) },
    ok(msg) { console.log(`ok    ${msg}`) },
    note(msg) { notes.push(msg); console.log(`note  ${msg}`) },
    finish(okMessage) {
      if (failures.length) {
        console.error(`\n${failures.length} 项不通过`)
        return 1
      }
      console.log(`\n${okMessage}`)
      return 0
    },
  }
}
