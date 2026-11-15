// SPDX-License-Identifier: CPAL-1.0
// 构建骨架（esbuild）。用法：
//   node scripts/build.mjs                 构建所有声明了 gitrader.build 的包
//   node scripts/build.mjs kernel mcp      只构建指定的包（目录名）
//   node scripts/build.mjs --notices       构建后生成 THIRD-PARTY-NOTICES.md
//
// 各包在自己的 package.json 里声明构建：
//   "gitrader": { "build": { "entry": "src/index.ts", "outfile": "dist/index.js",
//                  "platform": "node" | "browser", "format": "esm", "external": ["node:*"] } }
// 没有 gitrader.build 的包会被跳过（占位包就是这样）。产物只写 packages/<包>/dist/，不碰别处。
import { build } from 'esbuild'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeNotices } from './gen-notices.mjs'

const REQUIRE_BANNER = "import { createRequire as __gtCreateRequire } from 'node:module'; const require = __gtCreateRequire(import.meta.url);"
const QD_MARKER = 'Ported from QuantDinger'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const wantNotices = args.includes('--notices')
const only = args.filter((a) => !a.startsWith('--'))

const pkgDirs = readdirSync(join(root, 'packages'), { withFileTypes: true })
  .filter((d) => d.isDirectory() && (only.length === 0 || only.includes(d.name)))
  .map((d) => d.name)

const groups = {}
let built = 0

function qdNoticeSection() {
  const noticeFile = join(root, 'THIRD_PARTY_NOTICES.md')
  if (!existsSync(noticeFile)) throw new Error('QD-derived source is included, but THIRD_PARTY_NOTICES.md is missing')
  const source = readFileSync(noticeFile, 'utf8')
  const heading = /^## QuantDinger\s*$/m
  const match = heading.exec(source)
  if (!match) throw new Error('QD-derived source is included, but the QuantDinger notice section is missing')
  const end = source.slice(match.index + match[0].length).search(/^##\s/m)
  const section = source.slice(match.index, end < 0 ? undefined : match.index + match[0].length + end).trim()
  for (const required of ['- Project:', '- License:', '- What was ported', '- Changes:']) {
    if (!section.includes(required)) throw new Error(`QD notice section is missing required attribution: ${required}`)
  }
  return section
}

function hasQdDerivedInput(inputs) {
  for (const file of inputs) {
    // esbuild 虚拟命名空间输入（如工作台的 `gr-tw:…`）不是磁盘文件，跳过；Windows 盘符路径不算命名空间
    if (file.indexOf(':', 2) !== -1) continue // 盘符之后还有冒号 = 虚拟命名空间（esbuild 会拼成 `<目录>\gr-tw:<路径>`）
    if (!existsSync(file)) throw new Error(`Build input disappeared before notice inspection: ${file}`)
    if (readFileSync(file, 'utf8').includes(QD_MARKER)) return true
  }
  return false
}

function appendQdNotice(outFile, files) {
  if (!hasQdDerivedInput(files)) return false
  const existing = readFileSync(outFile, 'utf8')
  const section = qdNoticeSection()
  if (!existing.includes(section)) writeFileSync(outFile, `${existing.trimEnd()}\n\n${section}\n`, 'utf8')
  return true
}

for (const name of pkgDirs) {
  const dir = join(root, 'packages', name)
  const pj = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  const cfg = pj.gitrader?.build
  if (!cfg) { console.log(`跳过 ${name}（无 gitrader.build）`); continue }
  const entries = Array.isArray(cfg.entry) ? cfg.entry : [cfg.entry]
  const single = entries.length === 1
  const result = await build({
    absWorkingDir: dir,
    entryPoints: entries,
    ...(single ? { outfile: cfg.outfile } : { outdir: cfg.outdir ?? 'dist' }),
    bundle: true,
    platform: cfg.platform ?? 'node',
    format: cfg.format ?? 'esm',
    target: 'node22',
    sourcemap: true,
    metafile: true,
    legalComments: 'external',
    external: cfg.external ?? ['node:*'],
    // ESM 产物里被打包进来的 CJS 依赖（如 ws）会调用 require('events') 之类；esbuild 的 ESM 输出没有 require，补一个。
    ...((cfg.format ?? 'esm') === 'esm' && (cfg.platform ?? 'node') === 'node' ? { banner: { js: REQUIRE_BANNER } } : {}),
    logLevel: 'info',
  })
  groups[name] = Object.keys(result.metafile.inputs).map((f) => resolve(dir, f))
  mkdirSync(join(dir, 'dist'), { recursive: true })
  writeFileSync(join(dir, 'dist', 'meta.json'), JSON.stringify(result.metafile))
  const packageNotice = join(dir, 'dist', 'THIRD-PARTY-NOTICES.md')
  writeNotices(packageNotice, { [name]: groups[name] }, { productNames: { [name]: `packages/${name}` } })
  appendQdNotice(packageNotice, groups[name])
  built += 1
  console.log(`已构建 ${name}`)
}

if (wantNotices) {
  // 集成修补（H）：自带构建脚本的包（workbench 的界面包、engine-core 的引擎单文件）没有 gitrader.build，但它们的产物同样随仓库分发——
  // 读它们 dist/ 下的 esbuild metafile 一并统计（没构建过就提示，不编造）。
  for (const [name, meta] of [['workbench', 'dist/meta.json'], ['engine-core', 'dist/meta.json']]) {
    if (groups[name]) continue
    const p = join(root, 'packages', name, meta)
    if (!existsSync(p)) { console.warn(`提示：packages/${name} 没有 ${meta}，先构建它（npm run build -w @gitrader/${name}）再生成声明`); continue }
    const m = JSON.parse(readFileSync(p, 'utf8'))
    groups[name] = Object.keys(m.inputs ?? {}).map((x) => resolve(join(root, 'packages', name), x))
  }
  const out = join(root, 'THIRD-PARTY-NOTICES.md')
  const pkgs = writeNotices(out, groups, { productNames: Object.fromEntries(Object.keys(groups).map((k) => [k, `packages/${k}`])) })
  const allInputs = Object.values(groups).flat()
  appendQdNotice(out, allInputs)
  console.log(`THIRD-PARTY-NOTICES.md：${pkgs.length} 个第三方包`)
}
if (built === 0) console.log('没有任何包声明了 gitrader.build：构建骨架就绪，各包落地时在 package.json 里加上它。')
if (!existsSync(join(root, 'node_modules'))) console.warn('提示：先在仓库根目录运行 npm install')
