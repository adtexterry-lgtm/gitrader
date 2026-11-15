// SPDX-License-Identifier: CPAL-1.0
// 源码级扫描（视觉轮 r4，施工单 7.2-3）：产物里中文是 \u 转义，界面禁区只能在源码层扫。命中即构建失败（build.mjs 调 assertClean）。
//   node design/source-scan.mjs [workbench/src 目录] [blocks-default/src 目录]     # 单独跑；缺省扫仓库本身，命中退出码 1
// 规则：① 全圆（9999px / 999px / rounded-full / border-radius: 50% / var(--gr-r-pill|--radius-full)）只许出现在下方白名单行；
//       ② border-radius: 0 / rounded-none 不许落在卡 / 按钮 / 输入选择器上；
//       ③ 解释性小标题（类名 __sub / __desc / subtitle / eyebrow / caption，或 EmptyState 带 desc=），限 blocks-default/src 与壳的 Workbench / Shell；
//       ④ 禁词与 emoji（r2 H1 规则，build.mjs 原有门禁保留，这里同规则再扫一遍并给出行号）。
import { readFileSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const LEGACY_TOKENS_SHA256 = 'ec4b6bf923e963363a070c55933d7273a4095767b9c39479489a840f6a468a8e'
const TOKENS_SOURCE = 'reports/visual-r5/design-system/tokens.css'

// 白名单：文件（相对 packages/）+ 该行必须匹配的模式。只放形状与令牌定义，不放宽规则本身。
const ALLOW = [
  { rule: 'round', file: 'workbench/src/ui/components/components.css', line: /^\.gr-dot \{.*border-radius: 9999px/ },                     // Dot（6 px 圆点）
  { rule: 'round', file: 'workbench/src/ui/components/components.css', line: /^\.gr-actor--(user|system) i \{.*border-radius: 50%/ },    // ActorMark ● ○（7 px）
  { rule: 'round', file: 'workbench/src/ui/theme.css', line: /^\s*--gr-r-pill: 9999px;\s*$/ },                                            // 令牌定义（用处由本规则限死）
  { rule: 'round', file: 'workbench/src/ui/tw.css', line: /--radius-full: 9999px;/ },                                                     // Tailwind 令牌定义（同上）
  { rule: 'round', file: 'workbench/src/ui/theme.css', line: /^\s*width: 40px; height: 40px; border-radius: 9999px;\s*$/ },             // .icon-orb 40 px 正圆图标球（r2 旧件，r4 界面未用；见 D-REPORT 待定）
  { rule: 'subtitle', file: 'blocks-default/src/shared.tsx', line: /<EmptyState compact art="offline" title=\{tr\('读取失败'\)\} desc=\{error \? error\.message : undefined\}/ }, // ErrorState：desc 是内核报错原文（G4），不是说明段
  { rule: 'round', file: 'workbench/src/ui/r5/components.css', line: /^:root\[data-ui="r5"\] \.g5-mk\{width:16px;height:16px;flex:none;align-self:center;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;color:var\(--gr-on-actor\)\}$/ },
  { rule: 'round', file: 'workbench/src/ui/r5/components.css', line: /^:root\[data-ui="r5"\] \.g5-ldot\{width:8px;height:8px;border-radius:50%;flex:none\}$/ },
  { rule: 'round', file: 'workbench/src/ui/r5/components.css', line: /^:root\[data-ui="r5"\] \.g5-pa \.g5-end,:root\[data-ui="r5"\] \.g5-pa \.g5-dot\{position:absolute;width:8px;height:8px;margin:-4px 0 0 -4px;border-radius:50%;background:var\(--gr-text-2\);box-shadow:0 0 0 2px var\(--gr-card\);pointer-events:none\}$/ },
  { rule: 'color-alias', file: 'workbench/src/ui/tw.css', line: /^  --color-up: var\(--gr-up\); --color-down: var\(--gr-down\); --color-warn: var\(--gr-warn\); --color-amber: var\(--gr-amber\);$/ },
  { rule: 'color-alias', file: 'workbench/src/ui/tw.css', line: /^  --color-up-a10: var\(--gr-up-a10\); --color-down-a10: var\(--gr-down-a10\); --color-warn-a10: var\(--gr-warn-a10\); --color-accent-a12: var\(--gr-accent-a12\);$/ },
]

const EXT = /\.(jsx|tsx|js|ts|css)$/
const ROUND = /(?<!-)\b9{3,4}px\b|\brounded-full\b|border-radius\s*:\s*50%|var\(--(?:gr-r-pill|radius-full)\)/
const ZERO_DECL = /(?:^|[;{\s])border-radius\s*:\s*0(?:px)?\s*(?:!important\s*)?(?:;|$)/
const CTL_TOKEN = /^(card|tile|btn|button|input|field|select|textarea)$/
const CTL_ELEM = /(?:^|[\s>+~,(])(button|input|select|textarea)(?=[\s.:#[>+~,)]|$)/
const SUB_CLASS = /['"`][^'"`\n]*?(?:__sub(?![a-z])|__desc(?![a-z])|\bsubtitle\b|\beyebrow\b|\bcaption\b)/
const EMPTY_DESC = /<EmptyState\b(?:=>|[^>])*?\bdesc=/g
const BANNED = /保守|激进|稳赚|跑赢|稳定盈利|\p{Emoji_Presentation}|\u{FE0F}/u
const EXPERIMENT_BANNED = /预期收益|预测|年化收益/g
const COLOR_LITERAL = /#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})(?![\da-f])|\b(?:rgba?|hsla?)\s*\([^)]*\)/gi
const NAMED_UP_DOWN = /(?<![\w-])(?:red|green)(?![\w-])/gi
const STYLE_PROP = '(?:color|background(?:Color|Image)?|border(?:Top|Right|Bottom|Left)?Color|outlineColor|fill|stroke|boxShadow|textShadow)'

function walk(dir) {
  const acc = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = resolve(dir, e.name)
    if (e.isDirectory()) acc.push(...walk(p))
    else if (EXT.test(e.name)) acc.push(p)
  }
  return acc
}

const lineAt = (text, i) => text.slice(0, i).split('\n').length
const allowed = (rule, file, line) => ALLOW.some((a) => a.rule === rule && a.file === file && a.line.test(line))
const isCtlSelector = (sel) => [...sel.matchAll(/\.([\w-]+)/g)].some((m) => m[1].split(/[-_]+/).some((t) => CTL_TOKEN.test(t))) || /\[data-card\b/.test(sel) || CTL_ELEM.test(sel)

function stripComments(text, lineComments = false) {
  const chars = text.split('')
  let quote = ''
  for (let i = 0; i < chars.length; i += 1) {
    const c = chars[i]
    if (quote) {
      if (c === '\\') i += 1
      else if (c === quote) quote = ''
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c
      continue
    }
    if (c === '/' && chars[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      const stop = end < 0 ? chars.length : end + 2
      for (let j = i; j < stop; j += 1) if (chars[j] !== '\n') chars[j] = ' '
      i = stop - 1
      continue
    }
    if (lineComments && c === '/' && chars[i + 1] === '/') {
      let stop = i + 2
      while (stop < chars.length && chars[stop] !== '\n') stop += 1
      for (let j = i; j < stop; j += 1) chars[j] = ' '
      i = stop - 1
    }
  }
  return chars.join('')
}

function tokenRanges(file, text) {
  const ranges = []
  const addMarkedRange = (begin, end, accept = () => true) => {
    const start = text.indexOf(begin)
    const endAt = text.indexOf(end, start + begin.length)
    if (start >= 0 && endAt >= 0) {
      const finish = endAt + end.length
      const segment = text.slice(start, finish).replace(/\r\n/g, '\n')
      if (accept(segment)) ranges.push([start, finish])
    }
  }
  if (file === TOKENS_SOURCE) return [[0, text.length]]
  if (file !== 'workbench/src/ui/theme.css') return ranges
  addMarkedRange('/* ===== BEGIN TOKENS v6 ===== */', '/* ===== END TOKENS v6 ===== */')
  addMarkedRange('/* ===== BEGIN TOKENS ===== */', '/* ===== END TOKENS ===== */', (segment) =>
    createHash('sha256').update(segment, 'utf8').digest('hex') === LEGACY_TOKENS_SHA256,
  )
  return ranges
}

function maskRanges(text, ranges) {
  const chars = text.split('')
  for (const [start, finish] of ranges) {
    for (let i = start; i < finish; i += 1) if (chars[i] !== '\n') chars[i] = ' '
  }
  return chars.join('')
}

function maskUrls(value) {
  return value.replace(/url\([^)]*\)/gi, (match) => ' '.repeat(match.length))
}

function quotedStrings(source) {
  const values = []
  for (let i = 0; i < source.length; i += 1) {
    const quote = source[i]
    if (quote !== "'" && quote !== '"' && quote !== '`') continue
    const start = i + 1
    i = start
    while (i < source.length) {
      if (source[i] === '\\') {
        i += 2
        continue
      }
      if (source[i] === quote) break
      i += 1
    }
    values.push({ value: source.slice(start, i), offset: start, named: false, template: quote === '`' })
  }
  return values
}

function dynamicColorTemplate(value) {
  return /^(?:rgba?|hsla?)\(\s*\$\{[^{}]+\}\s*,\s*\$\{[^{}]+\}\s*,\s*\$\{[^{}]+\}(?:\s*,\s*(?:\$\{[^{}]+\}|[-+]?(?:\d*\.)?\d+%?))?\s*\)$/i.test(value)
}

function colorMatches(file, text) {
  const masked = maskRanges(text, tokenRanges(file, text))
  const isCss = file.endsWith('.css')
  const source = stripComments(masked, !isCss)
  const values = []
  if (isCss) {
    for (const block of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const bodyStart = block.index + block[0].indexOf('{') + 1
      const declarations = /(?:^|[;{])\s*([\w-]+)\s*:\s*([^;{}]+)/g
      for (const decl of block[2].matchAll(declarations)) {
        if (decl[1].toLowerCase() === 'content' || decl[1].toLowerCase() === 'src') continue
        const value = maskUrls(decl[2])
        const offset = bodyStart + decl.index + decl[0].indexOf(decl[2])
        values.push({ value, offset, named: true })
      }
    }
  } else {
    const styleValues = new RegExp(`\\b${STYLE_PROP}\\s*:\\s*(?:'([^']*)'|"([^"]*)"|([^,}\\n]+))`, 'gi')
    const svgValues = /\b(?:fill|stroke)\s*=\s*(['"])(.*?)\1/gi
    for (const match of source.matchAll(styleValues)) {
      const value = match[1] ?? match[2] ?? match[3] ?? ''
      values.push({ value, offset: match.index + match[0].lastIndexOf(value), named: true })
    }
    for (const match of source.matchAll(svgValues)) values.push({ value: match[2], offset: match.index + match[0].indexOf(match[2]), named: true })
    values.push(...quotedStrings(source))
  }
  const hits = []
  const seen = new Set()
  const addHit = (index, value) => {
    const key = `${index}\0${value}`
    if (seen.has(key)) return
    seen.add(key)
    hits.push({ index, value })
  }
  for (const { value, offset, named = false, template = false } of values) {
    if (template && dynamicColorTemplate(value)) continue
    const withoutUrls = maskUrls(value)
    for (const match of withoutUrls.matchAll(COLOR_LITERAL)) addHit(offset + match.index, match[0])
    if (named) {
      for (const match of withoutUrls.matchAll(NAMED_UP_DOWN)) addHit(offset + match.index, match[0])
    }
  }
  return hits
}

/** Scan one file using the same rules as the tree scanner. `file` is a packages/-relative label. */
export function scanFile(file, text) {
  const hits = []
  const normalized = text.replace(/\r\n/g, '\n')
  const lines = normalized.split('\n')
  const hit = (n, rule, msg) => hits.push(`${file}:${n} ${rule} ${msg}`)
  const colorText = stripComments(maskRanges(normalized, tokenRanges(file, normalized)), !file.endsWith('.css'))
  const uncommented = stripComments(normalized, !file.endsWith('.css'))
  const ruleLines = (file.startsWith('blocks-r5/src/') ? uncommented : normalized).split('\n')
  const experimentLines = uncommented.split('\n')
  for (const match of colorMatches(file, normalized)) {
    hit(lineAt(normalized, match.index), '颜色字面量', `「${match.value}」只许出现在完整 token 定义中`)
  }
  for (const match of uncommented.matchAll(/--color-(?:up|down)\b/gi)) {
    const line = lineAt(normalized, match.index)
    if (!allowed('color-alias', file, normalized.split('\n')[line - 1])) {
      hit(line, '涨跌令牌名', `「${match[0]}」不属于设计系统令牌`)
    }
  }
  const inLabPath = /(?:^|\/)(?:lab|lab-detail)(?:\/|\.[^/]+$|$)/.test(file)
  lines.forEach((ln, i) => {
    const m = ROUND.exec(ln)
    if (m && !allowed('round', file, ln)) hit(i + 1, '全圆', `「${m[0]}」只许用于三类圆点形状`)
    const b = BANNED.exec(ruleLines[i])
    if (b) hit(i + 1, '禁词', `「${b[0]}」：零承诺语言、不用 emoji`)
    if (inLabPath) {
      for (const term of experimentLines[i].matchAll(EXPERIMENT_BANNED)) hit(i + 1, '实验禁词', `「${term[0]}」`)
    }
  })
  if (file.endsWith('.css')) {
    const css = stripComments(normalized)
    for (const r of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (ZERO_DECL.test(r[2]) && isCtlSelector(r[1])) hit(lineAt(css, r.index + r[0].indexOf('{')), '直角', `${r[1].trim().slice(0, 60)} 上 border-radius: 0`)
    }
  } else {
    lines.forEach((ln, i) => { if (/\brounded-none\b/.test(ln)) hit(i + 1, '直角', 'rounded-none') })
    const scoped = file.startsWith('blocks-default/src/') || /^workbench\/src\/shell\/(Workbench|Shell)\.jsx$/.test(file)
    if (scoped) {
      lines.forEach((ln, i) => { const s = SUB_CLASS.exec(ln); if (s && !allowed('subtitle', file, ln)) hit(i + 1, '解释性小标题', `类名「${s[0].slice(-24)}」`) })
      for (const e of normalized.matchAll(EMPTY_DESC)) {
        const n = lineAt(normalized, e.index)
        const span = lines.slice(n - 1, lineAt(normalized, e.index + e[0].length)).join('\n')
        if (!allowed('subtitle', file, span)) hit(n, '解释性小标题', 'EmptyState 带 desc=')
      }
    }
  }
  return hits
}

/** 扫两棵源码树，返回命中列表（每条「文件:行 规则 片段」）。label 用 packages/ 下的相对路径，白名单按它匹配。 */
export function scan(wbSrc = resolve(here, '../src'), bdSrc = resolve(here, '../../blocks-default/src'), r5Src = resolve(here, '../../blocks-r5/src')) {
  const hits = []
  const roots = [['workbench/src', resolve(wbSrc)], ['blocks-default/src', resolve(bdSrc)], ['blocks-r5/src', resolve(r5Src)]]
  for (const [label, root] of roots) {
    for (const f of walk(root)) {
      const file = label + '/' + relative(root, f).split('\\').join('/')
      hits.push(...scanFile(file, readFileSync(f, 'utf8')))
    }
  }
  return hits
}

/** build.mjs 用：有命中就抛错，构建失败。 */
export function assertClean(wbSrc, bdSrc, r5Src) {
  const hits = scan(wbSrc, bdSrc, r5Src)
  if (hits.length) throw new Error(`源码扫描命中 ${hits.length} 处（design/source-scan.mjs）：\n` + hits.join('\n'))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [wb, bd, r5] = process.argv.slice(2)
  const hits = scan(wb, bd, r5)
  console.log(hits.length ? hits.join('\n') : '源码扫描 0 命中')
  process.exit(hits.length ? 1 : 0)
}
