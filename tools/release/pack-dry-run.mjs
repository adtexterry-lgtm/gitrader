// SPDX-License-Identifier: CPAL-1.0
// npm 包产物审计（CI 与首发前都跑，离线；npm pack 只做 --dry-run，不写 tarball、不跑 prepack）：
//   node tools/release/pack-dry-run.mjs [--root DIR] [--input FILE]
//   对每个带 `files` 字段的工作区包执行 `npm pack --dry-run --json --ignore-scripts`，
//   校验产物只含允许的文件、必需文件齐全、入口（bin/main/exports）真的在包里。
//   --input FILE 吃一份离线夹具（{package, files:[...]} 或它的数组），不调 npm —— 测试用这条路。
// 规则（照 scripts/check-public.mjs --pack 的口径，按包泛化）：
//   允许：`files` 字段点名的路径 + npm 自动包含的 package.json / README.md / LICENSE / NOTICE /
//         THIRD-PARTY-NOTICES.md；dist/ 下的产物与 `*.LEGAL.txt`。
//   禁止：source map、测试与 fixtures、src/、before-r1/、reports/、CHANGES.md、.tgz、.env、
//         点文件、package-lock.json、以及 dist/ 之外的 .ts/.mts/.py/.sh/.yml 源码。
//   必需：package.json、README.md、LICENSE；package.json 的 bin/main/module/types/exports 指向的文件。
// 退出码：0 全过；1 有失败项。
import { execSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { loadJson, loadWorkspaces, parseArgs, reporter, toPosix } from './lib.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_ROOT = resolve(HERE, '..', '..')
// Windows 上 npm 是 npm.cmd，execFileSync 不会自动补扩展名
const NPM = process.env.GITRADER_NPM || (process.platform === 'win32' ? 'npm.cmd' : 'npm')

export const AUTO_INCLUDED = ['package.json', 'README.md', 'LICENSE', 'NOTICE', 'THIRD-PARTY-NOTICES.md']
export const REQUIRED = ['package.json', 'README.md', 'LICENSE']
export const FORBIDDEN = [
  [/\.map$/, 'source map'],
  [/(^|\/)\./,'点文件'],
  [/(^|\/)(test|tests|__tests__|spec|specs|fixtures|verify|reports|before-r1|node_modules|src|coverage|\.tmp)(\/|$)/, '测试 / 源码 / 内部记录目录'],
  [/(^|\/)CHANGES\.md$/, '内部变更记录'],
  [/\.tgz$/, 'tarball'],
  [/(^|\/)\.env(\.|$)/, '环境变量文件'],
  [/(^|\/)package-lock\.json$/, 'lock 文件'],
  [/\.(ts|tsx|mts|cts|py|sh|yml|yaml|json5)$/, '源码 / 配置文件（dist/ 下只允许 .d.ts 声明）'],
]
const SOURCE_RULE = '源码 / 配置文件（dist/ 下只允许 .d.ts 声明）'
const ALLOWED_TS_UNDER_DIST = /^dist\/.*\.d\.(ts|mts|cts)$/
/** dist/ 下随包分发的资源本来就是 .py / .ts 源码：Python 引擎入口、示例策略。只放过「源码扩展名」这一条规则，其余规则（source map、test/、点文件…）照旧。 */
const ALLOWED_SOURCE_UNDER_DIST = /^dist\/(python-engine|examples)\//

function globToRegExp(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`)
}

/** 该产物路径是否被 package.json 的 files 字段点名（目录前缀 / 精确路径 / 简单 glob）。 */
export function listedInFilesField(path, filesField) {
  for (const raw of filesField ?? []) {
    const entry = toPosix(String(raw)).replace(/^\.\//, '').replace(/\/+$/, '')
    if (!entry) continue
    if (entry.includes('*') || entry.includes('?')) {
      if (globToRegExp(entry).test(path) || globToRegExp(`${entry}/*`).test(path)) return true
      continue
    }
    if (path === entry || path.startsWith(`${entry}/`)) return true
  }
  return false
}

/** 收集 package.json 里声明的入口文件（bin / main / module / types / exports）。 */
export function declaredEntries(pkg) {
  const out = new Set()
  const add = (value) => {
    if (typeof value !== 'string') return
    if (!/^\.?\/?[^/]/.test(value)) return
    const clean = toPosix(value).replace(/^\.\//, '')
    if (clean && !clean.includes('*')) out.add(clean)
  }
  if (typeof pkg.bin === 'string') add(pkg.bin)
  else if (pkg.bin && typeof pkg.bin === 'object') for (const v of Object.values(pkg.bin)) add(v)
  add(pkg.main); add(pkg.module); add(pkg.types); add(pkg.typings)
  const walk = (node) => {
    if (typeof node === 'string') { add(node); return }
    if (Array.isArray(node)) { node.forEach(walk); return }
    if (node && typeof node === 'object') for (const v of Object.values(node)) walk(v)
  }
  walk(pkg.exports)
  return [...out]
}

/**
 * 纯校验：pkg 是 package.json 内容，files 是 npm pack 报出的产物路径数组。
 * 不打印、不退出，返回 { failures, stats }，方便测试直接断言。
 */
export function validatePack({ pkg, files, label = pkg?.name ?? '(unnamed)' }) {
  const failures = []
  const fail = (msg) => failures.push(`${label}: ${msg}`)
  const list = [...new Set((files ?? []).map((f) => toPosix(String(f))))].sort()
  if (list.length === 0) { fail('产物为空'); return { failures, stats: { files: 0 } } }

  for (const path of list) {
    const hit = FORBIDDEN.find(([re, why]) => re.test(path) && !(why === SOURCE_RULE && ALLOWED_SOURCE_UNDER_DIST.test(path)))
    if (hit && !ALLOWED_TS_UNDER_DIST.test(path)) fail(`产物里不该有 ${path}（${hit[1]}）`)
    const allowed = listedInFilesField(path, pkg?.files) || AUTO_INCLUDED.includes(path) || ALLOWED_TS_UNDER_DIST.test(path)
    if (!allowed) fail(`产物 ${path} 既不在 files 字段里，也不是 npm 自动包含的文件`)
  }

  for (const need of REQUIRED) {
    if (!list.includes(need)) fail(`产物里缺 ${need}`)
  }
  for (const entry of declaredEntries(pkg ?? {})) {
    if (!list.includes(entry)) fail(`package.json 指向的入口 ${entry} 不在产物里`)
  }
  for (const entry of pkg?.files ?? []) {
    const clean = toPosix(String(entry)).replace(/^\.\//, '').replace(/\/+$/, '')
    if (!clean || clean.includes('*')) continue
    const covered = list.some((p) => p === clean || p.startsWith(`${clean}/`))
    if (!covered) fail(`files 字段点名了 ${clean}，但产物里没有它的任何文件`)
  }
  const forbiddenHit = list.find((p) => /\.map$/.test(p))
  if (forbiddenHit) fail(`source map 进了包：${forbiddenHit}`)
  return { failures, stats: { files: list.length, entries: declaredEntries(pkg ?? {}).length } }
}

/** 真实模式：对每个带 files 字段的包跑一次 npm pack --dry-run。 */
export function runNpmPacks(root, log = () => {}) {
  const { workspaces } = loadWorkspaces(root)
  const results = []
  for (const pkg of [...workspaces.values()].sort((a, b) => a.dir.localeCompare(b.dir))) {
    if (!pkg.pkg.files?.length) continue
    log(`npm pack --dry-run -w ${pkg.dir}`)
    // 下面要拼进 shell 命令：目录名只许 packages/<名> 这种安全字符，否则不执行、记为失败。
    if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(pkg.dir)) {
      results.push({ dir: pkg.dir, pkg: pkg.pkg, files: [], error: `包目录名含不安全字符，拒绝拼进 shell：${JSON.stringify(pkg.dir)}` })
      continue
    }
    let stdout
    try {
      // 走 shell：Windows 的 npm 是 .cmd，Node 22 起 execFileSync 直接调 .cmd 会 EINVAL
      stdout = execSync(`${NPM} pack --dry-run --json --ignore-scripts -w "${pkg.dir}"`, {
        cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (err) {
      results.push({ dir: pkg.dir, pkg: pkg.pkg, files: [], error: `npm pack 失败：${String(err.stderr ?? err.message).trim().split(/\r?\n/).slice(-3).join(' | ')}` })
      continue
    }
    const start = stdout.indexOf('[')
    const end = stdout.lastIndexOf(']')
    if (start === -1 || end === -1) {
      results.push({ dir: pkg.dir, pkg: pkg.pkg, files: [], error: `npm pack 的 JSON 输出解析不了：${stdout.slice(0, 200)}` })
      continue
    }
    let parsed
    try { parsed = JSON.parse(stdout.slice(start, end + 1)) } catch (err) {
      results.push({ dir: pkg.dir, pkg: pkg.pkg, files: [], error: `npm pack 的 JSON 不合法：${err.message}` })
      continue
    }
    results.push({ dir: pkg.dir, pkg: pkg.pkg, files: (parsed[0]?.files ?? []).map((f) => f.path) })
  }
  return results
}

function main() {
  const args = parseArgs(process.argv.slice(2), ['root', 'input'])
  if (args.help) {
    console.log('用法：node tools/release/pack-dry-run.mjs [--root DIR] [--input FIXTURE.json]')
    return 0
  }
  const root = args.root ? resolve(args.root) : DEFAULT_ROOT
  const r = reporter()
  let cases
  if (args.input) {
    const fixture = loadJson(resolve(args.input))
    if (!fixture) { r.fail(`夹具读不出来：${args.input}`); return r.finish('') }
    cases = Array.isArray(fixture) ? fixture : [fixture]
    console.log(`npm 产物审计（离线夹具 ${toPosix(resolve(args.input))}，${cases.length} 个包）`)
  } else {
    console.log(`npm 产物审计：${toPosix(root)}（npm pack --dry-run --ignore-scripts）`)
    cases = runNpmPacks(root, (m) => console.log(`      ${m}`))
  }
  if (cases.length === 0) r.fail('没有任何带 files 字段的包，审计没有覆盖面')
  for (const c of cases) {
    const pkg = c.pkg ?? c.package
    if (c.error) { r.fail(`${c.dir ?? pkg?.name ?? '(fixture)'}: ${c.error}`); continue }
    const { failures, stats } = validatePack({ pkg, files: c.files, label: pkg?.name ?? c.dir })
    for (const f of failures) r.fail(f)
    if (!failures.length) r.ok(`${pkg?.name ?? c.dir}: ${stats.files} 个文件、${stats.entries} 个入口，产物只含允许文件`)
  }
  r.note(`共 ${cases.length} 个包（带 files 字段）`)
  return r.finish('ok    npm 产物审计通过：所有包的产物只含允许文件，入口齐全')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main())
