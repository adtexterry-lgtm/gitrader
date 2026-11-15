// SPDX-License-Identifier: CPAL-1.0
// 首行 SPDX 与包许可证一致性审计（CI 与首发前都跑，只用 Node 标准库，不联网）：
//   node tools/release/audit-headers.mjs [--root DIR] [--baseline FILE]
// 规则：
//   1. 受版本控制的源码文件（.ts/.tsx/.mts/.cts/.mjs/.cjs/.js/.jsx/.py）第 1 行必须是
//      `// SPDX-License-Identifier: <ID>`（Python 用 `#`），不留空行、不写在第 2 行之后。
//   2. <ID> 必须等于「最近的带 license 字段的 package.json」的 license；工作区里没有包声明的
//      文件（tools/、scripts/、ops/、docs/、integrations/、assets/）取根 package.json 的 license。
//      包许可证只认 CPAL-1.0 / Apache-2.0 两种。
//   3. 根 LICENSE 必须是 CPAL-1.0 原文 + Exhibit B 归属信息（Powered by Gitrader + 词标路径）；
//      根 package.json 的 license 必须是 CPAL-1.0，NOTICE 必须逐个列出 Apache-2.0 的包。
//   4. Apache-2.0 的包各自带 LICENSE（Apache 2.0 全文）。
//   5. 历史例外走 tools/release/spdx-baseline.json：只准缩小。基线里多出来的条目（文件已修好）
//      或指向不存在的文件同样算失败，逼着把修好的条目删掉，不让基线变成永久豁免。
// 退出码：0 全过；1 有失败项（逐条打印原因）。
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  listTrackedFiles, loadJson, loadWorkspaces, parseArgs, posixDirname, readText, reporter, toPosix,
} from './lib.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_ROOT = resolve(HERE, '..', '..')
const DEFAULT_BASELINE = join(HERE, 'spdx-baseline.json')

export const SOURCE_FILE = /\.(ts|tsx|mts|cts|mjs|cjs|js|jsx|py)$/
// 类型声明（.d.ts / .d.mts / .d.cts）是构建产物或环境声明，不要求首行 SPDX
export const DECLARATION_FILE = /\.d\.(ts|mts|cts)$/
export const KNOWN_LICENSES = ['CPAL-1.0', 'Apache-2.0']
// 只认第 1 行：`//` 或 `#` 前缀，行尾允许空白
export const SPDX_FIRST_LINE = /^(?:\/\/|#)[ \t]*SPDX-License-Identifier:[ \t]*([A-Za-z0-9.+-]+)[ \t]*$/

/** 该文件应当使用的许可证：最近的带 license 字段的 package.json；都没有则 null。 */
export function expectedLicense(root, rel) {
  let dir = posixDirname(rel)
  for (;;) {
    const pkgRel = dir === '.' ? 'package.json' : `${dir}/package.json`
    if (existsSync(join(root, pkgRel))) {
      const pkg = loadJson(join(root, pkgRel))
      if (pkg?.license) return { license: pkg.license, pkgRel }
    }
    if (dir === '.') return null
    dir = posixDirname(dir)
  }
}

/** 读首行并解析 SPDX（不读整文件）。 */
export function readFirstLine(root, rel) {
  const text = readText(join(root, rel))
  if (text === null) return null
  return text.split(/\r?\n/, 1)[0]
}

/**
 * 纯审计函数：不打印、不退出。返回 { checks, violations, baseline }。
 * checks 是 { files: [{rel, license, header}], licenses: {…} }，方便测试断言。
 */
export function auditHeaders({ root, baselinePath = DEFAULT_BASELINE }) {
  const failures = []
  const notes = []
  const fail = (msg) => failures.push(msg)
  const all = listTrackedFiles(root)
  const sources = all.filter((f) => SOURCE_FILE.test(f) && !DECLARATION_FILE.test(f))
  if (sources.length === 0) fail(`${root} 下没有找到任何源码文件（.ts/.mjs/.py …），目录选错了？`)

  const licenseCount = new Map()
  const violations = []
  for (const rel of sources) {
    const exp = expectedLicense(root, rel)
    const first = readFirstLine(root, rel)
    if (first === null) { fail(`${rel}: 读不出来（二进制或权限？）`); continue }
    const m = SPDX_FIRST_LINE.exec(first)
    if (!m) {
      violations.push({ rel, kind: 'missing', header: first.slice(0, 80), expected: exp?.license ?? '(根 license)' })
      continue
    }
    const header = m[1]
    licenseCount.set(header, (licenseCount.get(header) ?? 0) + 1)
    if (!KNOWN_LICENSES.includes(header)) {
      fail(`${rel}: 首行 SPDX ${header} 不在已知许可证 ${KNOWN_LICENSES.join(' / ')} 里`)
      continue
    }
    if (!exp) { fail(`${rel}: 找不到任何 package.json 的 license，无法判定应当用哪种许可证`); continue }
    if (header !== exp.license) violations.push({ rel, kind: 'mismatch', header, expected: exp.license, pkgRel: exp.pkgRel })
  }

  // ---- 基线（历史例外，只准缩小）--------------------------------------------------------------------
  const baseline = loadJson(baselinePath) ?? { entries: [] }
  const entries = Array.isArray(baseline.entries) ? baseline.entries : []
  const byPath = new Map()
  for (const entry of entries) {
    if (!entry?.path) { fail(`基线 ${toPosix(baselinePath)} 有一条缺 path 的条目`); continue }
    if (!['missing', 'mismatch'].includes(entry.kind)) fail(`基线 ${entry.path}: kind 必须是 missing 或 mismatch`)
    if (!entry.reason || String(entry.reason).trim().length < 8) fail(`基线 ${entry.path}: 必须写 reason（为什么现在不能修）`)
    if (byPath.has(entry.path)) fail(`基线 ${entry.path}: 重复条目`)
    byPath.set(entry.path, entry)
  }
  const baselined = []
  for (const v of violations) {
    const entry = byPath.get(v.rel)
    if (entry && entry.kind === v.kind) { baselined.push(v); byPath.delete(v.rel); continue }
    if (entry) {
      fail(`${v.rel}: 首行 ${v.header ?? '(缺)'} 与期望 ${v.expected} 不符，但基线登记的种类是 ${entry.kind}（实为 ${v.kind}）`)
      byPath.delete(v.rel)
      continue
    }
    if (v.kind === 'missing') fail(`${v.rel}: 第 1 行缺 SPDX（现在写的是 ${JSON.stringify(v.header)}）；期望 ${v.expected}`)
    else fail(`${v.rel}: 首行 SPDX ${v.header} 与 ${v.pkgRel} 的 license ${v.expected} 不一致`)
  }
  for (const [rel, entry] of byPath) {
    if (!existsSync(join(root, rel))) fail(`基线 ${rel}: 文件已不存在，请从 ${toPosix(baselinePath)} 删掉这条`)
    else fail(`基线 ${rel}: 已经不是${entry.kind === 'missing' ? '缺首行 SPDX' : '许可证不一致'}了（已修好），请从基线删掉这条`)
  }

  // ---- 根 LICENSE / NOTICE / 各 Apache 包的 LICENSE ---------------------------------------------------
  const rootPkg = loadJson(join(root, 'package.json'))
  if (!rootPkg) fail('根 package.json 读不出来或不是合法 JSON')
  else if (rootPkg.license !== 'CPAL-1.0') fail(`根 package.json 的 license 是 ${rootPkg.license}，应为 CPAL-1.0`)
  else notes.push('根 package.json license = CPAL-1.0')

  const licenseText = readText(join(root, 'LICENSE'))
  if (licenseText === null) fail('根 LICENSE 不存在')
  else {
    const markers = [
      ['CPAL 标题行', /Common Public Attribution License Version 1\.0/],
      ['CPAL 第 1 节定义', /1\.\s*“Definitions”|1\.\s*"Definitions"/],
      ['CPAL 第 15 节（网络部署）', /15\.\s*ADDITIONAL TERM: NETWORK USE/],
      ['Exhibit A', /EXHIBIT A\.\s*Common Public Attribution License/],
      ['Exhibit B 归属信息', /EXHIBIT B\.\s*Attribution Information/],
      ['Exhibit B 归属短语', /Powered by Gitrader/],
      ['Exhibit B 词标路径', /assets\/brand\/gitrader-wordmark\.svg/],
    ]
    if (licenseText.replace(/\r\n/g, '\n').length < 8000) fail(`根 LICENSE 只有 ${licenseText.length} 字符，不像 CPAL 原文全文`)
    for (const [label, re] of markers) {
      if (!re.test(licenseText)) fail(`根 LICENSE 缺 ${label}（CPAL 原文 + Exhibit B 必须完整）`)
    }
    if (markers.every(([, re]) => re.test(licenseText))) {
      notes.push(`根 LICENSE = CPAL-1.0 原文 + Exhibit A/B（${licenseText.length} 字符）`)
    }
  }

  const notice = readText(join(root, 'NOTICE'))
  if (notice === null) fail('根 NOTICE 不存在')

  // 每个 Apache-2.0 的包：自带 LICENSE + 在 NOTICE 里点名 + 首行 SPDX 是 Apache-2.0
  const apachePackages = []
  const { workspaces } = loadWorkspaces(root)
  for (const pkg of workspaces.values()) {
    if (pkg.pkg.license !== 'Apache-2.0') continue
    apachePackages.push(pkg.dir)
    if (notice !== null && !notice.includes(pkg.dir)) fail(`NOTICE 没列出 Apache-2.0 的包：${pkg.dir}`)
    const lic = readText(join(pkg.abs, 'LICENSE'))
    if (lic === null) fail(`${pkg.dir}: package.json 是 Apache-2.0 但没有 LICENSE 文件`)
    else if (!/Apache License/.test(lic) || !/Version 2\.0/.test(lic)) fail(`${pkg.dir}/LICENSE 不是 Apache License 2.0 全文`)
  }
  if (apachePackages.length) notes.push(`Apache-2.0 包 ${apachePackages.length} 个（${apachePackages.join(' / ')}）各自带 LICENSE`)

  // protocol 包按工单要求必须是 Apache-2.0（两条独立的信号：包声明 + 首行 SPDX）。
  // 只有真仓库（根包名 gitrader-monorepo）必须存在这个包；夹具 / 裁剪目录只做一致性校验。
  const protocol = workspaces.get('@gitrader/protocol')
  if (!protocol) {
    if (rootPkg?.name === 'gitrader-monorepo') fail('工作区里找不到 @gitrader/protocol')
    else notes.push('目录里没有 @gitrader/protocol：跳过 protocol 专属检查（只有真仓库要求它存在）')
  } else if (protocol.pkg.license !== 'Apache-2.0') {
    fail(`@gitrader/protocol 的 license 是 ${protocol.pkg.license}，应为 Apache-2.0`)
  }

  return {
    failures,
    notes,
    stats: {
      checked: sources.length,
      byLicense: Object.fromEntries([...licenseCount].sort()),
      baselined,
      apachePackages,
    },
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2), ['root', 'baseline'])
  if (args.help) {
    console.log('用法：node tools/release/audit-headers.mjs [--root DIR] [--baseline FILE]')
    return 0
  }
  const root = args.root ? resolve(args.root) : DEFAULT_ROOT
  const baselinePath = args.baseline ? resolve(args.baseline) : DEFAULT_BASELINE
  const r = reporter()
  console.log(`首行 SPDX 审计：${toPosix(root)}`)
  const { failures, notes, stats } = auditHeaders({ root, baselinePath })
  for (const f of failures) r.fail(f)
  for (const n of notes) r.note(n)
  r.note(`共 ${stats.checked} 个源码文件，首行 SPDX 分布 ${JSON.stringify(stats.byLicense)}`)
  if (stats.baselined.length) {
    r.note(`历史例外 ${stats.baselined.length} 条（spdx-baseline.json，只准缩小）：${stats.baselined.map((v) => v.rel).join(', ')}`)
  }
  return r.finish(stats.baselined.length
    ? `ok    首行 SPDX 审计通过（${stats.checked} 文件，${stats.baselined.length} 条历史例外已登记）`
    : `ok    首行 SPDX 审计通过（${stats.checked} 文件，无例外）`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main())
