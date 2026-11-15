// SPDX-License-Identifier: CPAL-1.0
// gen-notices.mjs：从 esbuild 的 metafile 里找出真正被打进产物的第三方包，读它们自己的 package.json 与 LICENSE 文件，
// 生成 THIRD-PARTY-NOTICES.md。不手抄任何版权行 / 版本 / 许可证文本——全部来自 node_modules 里的原件。
// 由 build.mjs 调用；也可单独 `node scripts/gen-notices.mjs <输出文件> <groups.json>`（groups.json: {产物名: [输入文件路径,…]}）。
// 搬运自 早期 Demo 原型 的同名脚本，改动：产物名由调用方给、主入口判断改用 fileURLToPath、措辞改为仓库口径、工作区内的 @gitrader/* 包不算第三方。
// 手工清单（开关化，默认等价）：同目录有 notices-manual.json 才读入「不经 npm 打进产物」的第三方材料（字体原字节、构建期生成的 CSS、改写进仓库的代码）；
// 文件不存在时输出与没有这项功能时逐字节相同。
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const LICENSE_NAMES = /^(licen[sc]e|licen[sc]e\.(md|txt)|copying|notice)(\.[a-z]+)?$/i
const MANUAL_FILE = fileURLToPath(new URL('./notices-manual.json', import.meta.url))

/** 输入文件路径 → 它所属的 npm 包目录（取路径里最后一个 node_modules/<包> 或 node_modules/@scope/<包>）；不在 node_modules 里返回 null。 */
export function packageDirOf(file) {
  const parts = resolve(file).split(sep)
  const i = parts.lastIndexOf('node_modules')
  if (i < 0 || i + 1 >= parts.length) return null
  const first = parts[i + 1]
  const n = first.startsWith('@') ? 2 : 1
  if (i + n >= parts.length) return null
  return parts.slice(0, i + 1 + n).join(sep)
}

function licenseFilesOf(dir) {
  try { return readdirSync(dir).filter((f) => LICENSE_NAMES.test(f)).sort() } catch { return [] }
}

function repoOf(pkg) {
  let r = pkg.repository
  if (r && typeof r === 'object') r = r.url
  if (typeof r !== 'string') return pkg.homepage ?? ''
  if (/^[\w.-]+\/[\w.-]+$/.test(r)) return `https://github.com/${r}`
  return r.replace(/^git\+/, '').replace(/^git:\/\//, 'https://').replace(/\.git$/, '').replace(/^github:/, 'https://github.com/')
}

function licenseOf(pkg) {
  if (typeof pkg.license === 'string') return pkg.license
  if (pkg.license?.type) return pkg.license.type
  if (Array.isArray(pkg.licenses)) return pkg.licenses.map((l) => l.type ?? l).join(' OR ')
  return ''
}

function copyrightLines(text) {
  // 只取真正的版权行（Copyright [(c)|©] <年份> …），不取许可证正文里的 "COPYRIGHT HOLDERS BE LIABLE" 之类
  return [...new Set(text.split(/\r?\n/).map((l) => l.replace(/^[#*/\s]+/, '').trim()).filter((l) => /^(copyright\s*(\(c\)|©)?\s*\d{4}|\(c\)\s*\d{4}|©\s*\d{4})/i.test(l)))]
}

/** groups: { 产物名: [输入文件路径,…] } → 去重后的包清单（含它出现在哪些产物里）。 */
export function collectPackages(groups) {
  const byDir = new Map()
  for (const [product, files] of Object.entries(groups)) {
    for (const f of files) {
      const dir = packageDirOf(f)
      if (!dir) continue
      if (!byDir.has(dir)) byDir.set(dir, new Set())
      byDir.get(dir).add(product)
    }
  }
  const out = []
  for (const [dir, products] of byDir) {
    const pj = join(dir, 'package.json')
    if (!existsSync(pj)) continue
    const pkg = JSON.parse(readFileSync(pj, 'utf8'))
    if (pkg.private && !pkg.name) continue
    if (typeof pkg.name === 'string' && pkg.name.startsWith('@gitrader/')) continue
    const files = licenseFilesOf(dir)
    const texts = files.map((f) => ({ file: f, text: readFileSync(join(dir, f), 'utf8').replace(/\r\n/g, '\n').trim() }))
    const copyright = [...new Set(texts.flatMap((t) => copyrightLines(t.text)))]
    out.push({ name: pkg.name ?? dir.split(sep).pop(), version: pkg.version ?? '?', license: licenseOf(pkg), repo: repoOf(pkg), copyright, texts, products: [...products].sort(), dir })
  }
  out.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
  return out
}

/**
 * 读手工清单（缺省 scripts/notices-manual.json；不存在 → []）。条目：{ name, version?, license, copyright?: string[], repo?, products?: string[],
 * licenseFile?（相对仓库根）| licenseText? }。版权行缺省时从许可证文本里取。
 */
export function readManualEntries(file = MANUAL_FILE) {
  if (!existsSync(file)) return []
  const root = resolve(dirname(file), '..')
  return JSON.parse(readFileSync(file, 'utf8')).entries.map((e) => {
    const text = (e.licenseFile ? readFileSync(resolve(root, e.licenseFile), 'utf8') : (e.licenseText ?? '')).replace(/\r\n/g, '\n').trim()
    return { name: e.name, version: e.version ?? '—', license: e.license ?? '', repo: e.repo ?? '', copyright: e.copyright ?? copyrightLines(text), texts: text ? [{ file: e.licenseFile ?? 'manual', text }] : [], products: e.products ?? [] }
  })
}

export function renderNotices(pkgs, { generatedAt = new Date().toISOString().slice(0, 10), productNames = {}, manual = [] } = {}) {
  const L = []
  L.push('# 第三方软件声明（THIRD-PARTY NOTICES）')
  L.push('')
  L.push('Gitrader 的构建产物里随附了下列第三方开源软件。本文件**由构建脚本从各包 `node_modules` 里的 `package.json` 与 LICENSE 文件自动生成**（`scripts/gen-notices.mjs`），不是手写；版本以构建当时实际打进产物的那一份为准。')
  L.push('')
  const names = Object.entries(productNames).map(([k, v]) => `\`${k}\` = ${v}`).join('，')
  const extra = manual.length ? `另有 ${manual.length} 项不经 npm 打进产物的第三方材料（字体原字节、构建期生成的 CSS、改写进仓库的代码），来自手工清单 \`scripts/notices-manual.json\`，排在清单末尾。` : ''
  L.push(`生成日期：${generatedAt} · 共 ${pkgs.length} 个第三方包。${extra}${names ? `产物名：${names}。` : ''}各产物旁另有 \`*.LEGAL.txt\`（打包器保留的源码内版权注释）。`)
  L.push('')
  L.push('## 一、清单')
  L.push('')
  L.push('| 包 | 版本 | 许可证 | 版权 | 仓库 | 随哪些产物 |')
  L.push('|---|---|---|---|---|---|')
  const cell = (s) => String(s || '—').replace(/\|/g, '\\|').replace(/\n/g, ' ')
  for (const p of pkgs.concat(manual)) L.push(`| ${cell(p.name)} | ${cell(p.version)} | ${cell(p.license)} | ${cell(p.copyright.join('；'))} | ${cell(p.repo)} | ${cell(p.products.join(', '))} |`)
  L.push('')
  L.push('## 二、许可证全文')
  L.push('')
  L.push('同一份许可证文本只列一次，下面标出适用的包。')
  L.push('')
  const byText = new Map()
  for (const p of pkgs.concat(manual)) {
    if (p.texts.length === 0) { const k = `（该包没有随附 LICENSE 文件；package.json 声明的许可证：${p.license || '未声明'}）`; if (!byText.has(k)) byText.set(k, []); byText.get(k).push(`${p.name}@${p.version}`); continue }
    for (const t of p.texts) { if (!byText.has(t.text)) byText.set(t.text, []); byText.get(t.text).push(`${p.name}@${p.version}`) }
  }
  let n = 0
  for (const [text, owners] of byText) {
    n += 1
    L.push(`### ${n}. ${owners.join(', ')}`)
    L.push('')
    L.push('```text')
    L.push(text.replace(/```/g, "'''"))
    L.push('```')
    L.push('')
  }
  return L.join('\n')
}

export function writeNotices(outFile, groups, opts) {
  const pkgs = collectPackages(groups)
  writeFileSync(outFile, renderNotices(pkgs, { ...opts, manual: opts?.manual ?? readManualEntries() }), 'utf8')
  return pkgs
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const [out, groupsFile] = process.argv.slice(2)
  if (!out || !groupsFile) { console.error('用法：node scripts/gen-notices.mjs <输出.md> <groups.json>'); process.exit(2) }
  const pkgs = writeNotices(resolve(out), JSON.parse(readFileSync(groupsFile, 'utf8')))
  console.log(`${out}：${pkgs.length} 个包`)
}
