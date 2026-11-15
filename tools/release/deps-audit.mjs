// SPDX-License-Identifier: CPAL-1.0
// 依赖边界审计（CI 与首发前都跑，只用 Node 标准库，不联网、不读 node_modules）：
//   node tools/release/deps-audit.mjs [--root DIR] [--whitelist FILE]
// 规则：
//   1. 每个工作区包的 dependencies / optionalDependencies / peerDependencies 只能是：
//      (a) 工作区包（版本必须写 `*`），或 (b) tools/release/deps-whitelist.json 里的第三方包，
//      且版本字符串必须在该条目的 ranges 里；两者都不满足即失败。
//   2. 名字像工作区包（@gitrader/*）但工作区里没有 → 失败（拼错 / 幽灵依赖）。
//   3. devDependencies 不随包发布，但 @gitrader/* 的 devDependency 仍必须是真实工作区包。
//   4. 白名单条目必须被用到（过期条目失败），且必须写 reason —— 白名单不许变成垃圾桶。
// 输出：逐条列出真实的第三方运行时依赖（名字@范围 → 包），最后给总数。
// 退出码：0 全过；1 有失败项。
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { loadJson, loadWorkspaces, parseArgs, reporter, toPosix } from './lib.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_ROOT = resolve(HERE, '..', '..')
const DEFAULT_WHITELIST = join(HERE, 'deps-whitelist.json')

export const RUNTIME_FIELDS = ['dependencies', 'optionalDependencies', 'peerDependencies']
const WORKSPACE_SCOPE = '@gitrader/'

/**
 * 纯审计：workspaces 是 loadWorkspaces 的结果，allow 是白名单对象。
 * 返回 { failures, thirdParty: [{name, spec, from}], stats }，不打印、不退出。
 */
export function auditDeps({ workspaces, allow, rootPkg = null }) {
  const failures = []
  const fail = (msg) => failures.push(msg)
  const thirdParty = []
  const used = new Set()
  const wsNames = new Set(workspaces.keys())

  for (const pkg of [...workspaces.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    for (const field of RUNTIME_FIELDS) {
      const deps = pkg.pkg[field]
      if (!deps || typeof deps !== 'object') continue
      for (const [name, spec] of Object.entries(deps)) {
        if (wsNames.has(name)) {
          if (spec !== '*' && spec !== 'workspace:*') fail(`${pkg.name}（${field}）依赖工作区包 ${name}，版本应写 "*"（现在 ${spec}）`)
          continue
        }
        if (name.startsWith(WORKSPACE_SCOPE)) {
          fail(`${pkg.name}（${field}）依赖 ${name}，但工作区里没有这个包`)
          continue
        }
        const entry = allow?.[name]
        if (!entry) {
          fail(`${pkg.name}（${field}）出现未登记的第三方依赖 ${name}@${spec}：要么去掉，要么在 tools/release/deps-whitelist.json 登记 reason 与允许范围`)
          continue
        }
        const ranges = Array.isArray(entry.ranges) ? entry.ranges : []
        if (ranges.length === 0) fail(`白名单 ${name} 没有 ranges（版本范围），无法判定 ${spec} 是否可接受`)
        else if (!ranges.includes('*') && !ranges.includes(spec)) {
          fail(`${pkg.name}（${field}）的 ${name}@${spec} 不在白名单允许范围 ${JSON.stringify(ranges)} 里`)
        }
        if (!entry.reason || String(entry.reason).trim().length < 8) fail(`白名单 ${name} 必须写 reason（为什么这个第三方依赖要留下）`)
        used.add(name)
        thirdParty.push({ name, spec, from: pkg.name, field })
      }
    }
    // devDependencies：只校验 @gitrader/* 必须存在（第三方 devDeps 是本地构建工具，不随包发布）
    for (const [name, spec] of Object.entries(pkg.pkg.devDependencies ?? {})) {
      if (!name.startsWith(WORKSPACE_SCOPE)) continue
      if (!wsNames.has(name)) fail(`${pkg.name}（devDependencies）依赖 ${name}，但工作区里没有这个包`)
      else if (spec !== '*' && spec !== 'workspace:*') fail(`${pkg.name}（devDependencies）依赖工作区包 ${name}，版本应写 "*"（现在 ${spec}）`)
    }
    for (const [name] of Object.entries(pkg.pkg.dependencies ?? {})) {
      if (name === pkg.name) fail(`${pkg.name} 依赖自己`)
    }
  }

  for (const name of Object.keys(allow ?? {})) {
    if (!used.has(name)) fail(`白名单条目 ${name} 没有被任何包使用（过期），请从 tools/release/deps-whitelist.json 删掉`)
  }

  if (rootPkg && !rootPkg.private) fail('根 package.json 不是 private：monorepo 根不应可发布')

  return {
    failures,
    thirdParty: thirdParty.sort((a, b) => a.name.localeCompare(b.name) || a.from.localeCompare(b.from)),
    stats: {
      packages: workspaces.size,
      thirdPartyNames: new Set(thirdParty.map((d) => d.name)).size,
      thirdPartyRefs: thirdParty.length,
    },
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2), ['root', 'whitelist'])
  if (args.help) {
    console.log('用法：node tools/release/deps-audit.mjs [--root DIR] [--whitelist FILE]')
    return 0
  }
  const root = args.root ? resolve(args.root) : DEFAULT_ROOT
  const whitelistPath = args.whitelist ? resolve(args.whitelist) : DEFAULT_WHITELIST
  const r = reporter()
  console.log(`依赖边界审计：${toPosix(root)}`)
  const { workspaces, rootPkg } = loadWorkspaces(root)
  if (workspaces.size === 0) { r.fail('一个工作区包都没找到（根 package.json 的 workspaces 变了？）'); return r.finish('') }
  const wl = loadJson(whitelistPath)
  if (!wl || typeof wl.allow !== 'object' || wl.allow === null) {
    r.fail(`白名单读不出来或缺 allow 字段：${toPosix(whitelistPath)}`)
    return r.finish('')
  }
  const { failures, thirdParty, stats } = auditDeps({ workspaces, allow: wl.allow, rootPkg })
  for (const f of failures) r.fail(f)
  r.ok(`${stats.packages} 个工作区包，运行时依赖全部是工作区包或已登记白名单`)
  const grouped = new Map()
  for (const d of thirdParty) {
    const key = `${d.name}@${d.spec}`
    if (!grouped.has(key)) grouped.set(key, [])
    grouped.get(key).push(`${d.from}${d.field === 'dependencies' ? '' : `(${d.field})`}`)
  }
  for (const [dep, from] of grouped) r.note(`第三方运行时依赖 ${dep} ← ${from.join(', ')}`)
  r.note(`第三方运行时依赖共 ${stats.thirdPartyNames} 个名字 / ${stats.thirdPartyRefs} 处引用`)
  return r.finish(`ok    依赖边界审计通过（第三方 ${stats.thirdPartyNames} 个，全部在白名单里）`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main())
