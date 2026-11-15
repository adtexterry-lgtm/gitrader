// SPDX-License-Identifier: CPAL-1.0
// 发布包依赖体检（离线、只读）：`npm pack` 出来的 gitrader 包不该带任何运行时依赖。
//   packages/cli/build.mjs 已把所有 @gitrader/* 内联进 dist/，package.json 里再列运行时依赖，
//   用户 `npm install <tgz>` 时 npm 会去公网找这些未发布的包 → E404。
// 用法：
//   node tools/release/pack-deps.mjs          # 读 packages/cli/package.json，有问题退出 1
//   import { checkPackDeps } from './pack-deps.mjs'  # 纯函数，吃 package.json 对象
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLI_PKG = resolve(HERE, '..', '..', 'packages', 'cli', 'package.json')
// devDependencies 之外这些字段出现 @gitrader/ 依赖都算问题
const RUNTIME_FIELDS = ['dependencies', 'optionalDependencies', 'peerDependencies']
const SCOPE = '@gitrader/'

/**
 * 检查一个 package.json 对象，返回问题描述数组（空数组表示没问题）。
 * 规则：`dependencies` 非空 → 一条；`dependencies` / `optionalDependencies` / `peerDependencies`
 * 里每个 `@gitrader/` 依赖 → 各一条。
 */
export function checkPackDeps(pkg) {
  const problems = []
  if (!pkg || typeof pkg !== 'object') return ['package.json 不是对象']
  const deps = pkg.dependencies
  if (deps && typeof deps === 'object' && Object.keys(deps).length > 0) {
    problems.push(`运行时 dependencies 非空（${Object.keys(deps).length} 项）：发布包不应有运行时依赖`)
  }
  for (const field of RUNTIME_FIELDS) {
    const block = pkg[field]
    if (!block || typeof block !== 'object') continue
    for (const name of Object.keys(block)) {
      if (name.startsWith(SCOPE)) problems.push(`${field} 出现工作区依赖 ${name}：应移到 devDependencies`)
    }
  }
  return problems
}

/** 命令行入口：读真实的 packages/cli/package.json，打印结论。 */
export function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('用法：node tools/release/pack-deps.mjs')
    return 0
  }
  let pkg
  try {
    pkg = JSON.parse(readFileSync(CLI_PKG, 'utf8'))
  } catch (err) {
    console.error(`读取 packages/cli/package.json 失败：${err instanceof Error ? err.message : String(err)}`)
    return 1
  }
  const problems = checkPackDeps(pkg)
  if (problems.length > 0) {
    console.error(`pack deps 有问题（${problems.length} 条）：`)
    for (const p of problems) console.error(`  - ${p}`)
    return 1
  }
  console.log('pack deps ok')
  return 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main()
}

export { CLI_PKG }
