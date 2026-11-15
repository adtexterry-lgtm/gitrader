// SPDX-License-Identifier: CPAL-1.0
// 最小渲染层：Markdown 表格与单文件 HTML（内联 CSS、无 <script>、无外链）。
// 图表与版式口径参考 packages/report/src/{markdown,html}.ts，但这里不 import 那个包（TS 源 + 本目录无构建），
// 只复用它的两条红线：单文件、无脚本；固定免责声明一行（packages/report/src/types.ts:146）。

/** 因子报告免责声明。 */
export const DISCLAIMER = '本报告为历史数据上的因子统计结果，不构成任何预测或建议。'

/** 回测类（参数扫描 / 走查）报告免责声明。 */
export const BACKTEST_DISCLAIMER = '本报告为历史数据回测的统计结果，不构成任何预测或建议。'

/** 数值显示：null / 非有限数显示「—」；否则固定位数。 */
export function fmt(value, digits = 4) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  return value.toFixed(digits)
}

/** 百分比显示（输入为比率，如 0.25 -> 25.0%）。 */
export function pct(value, digits = 1) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  return `${(value * 100).toFixed(digits)}%`
}

const HTML_ESCAPE = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

/** HTML 转义（所有进入 HTML 的文本都过这里）。 */
export function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => HTML_ESCAPE[ch])
}

/** Markdown 单元格转义：竖线与换行会把表格弄乱。 */
export function mdCell(text) {
  return String(text).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

/** 生成 Markdown 表格：headers 为表头，rows 为二维数组（已格式化的字符串）。 */
export function mdTable(headers, rows) {
  const head = `| ${headers.map(mdCell).join(' | ')} |`
  const sep = `| ${headers.map(() => '---').join(' | ')} |`
  const body = rows.map((row) => `| ${row.map(mdCell).join(' | ')} |`)
  return [head, sep, ...body].join('\n')
}

/** 生成 HTML 表格。 */
export function htmlTable(headers, rows, className = 'grid') {
  const head = `<tr>${headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr>`
  const body = rows
    .map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`)
    .join('\n')
  return `<table class="${className}">\n<thead>${head}</thead>\n<tbody>\n${body}\n</tbody>\n</table>`
}

/** 键值表（Markdown）。 */
export function mdFacts(pairs) {
  return pairs.map(([key, value]) => `- ${key}：${value}`).join('\n')
}

/** 键值表（HTML）。 */
export function htmlFacts(pairs) {
  const rows = pairs.map(([key, value]) => `<tr><th>${escapeHtml(key)}</th><td>${escapeHtml(value)}</td></tr>`)
  return `<table class="facts">\n<tbody>\n${rows.join('\n')}\n</tbody>\n</table>`
}

const CSS = `
:root { color-scheme: light dark; }
body { font-family: -apple-system, "Segoe UI", "Noto Sans SC", sans-serif; margin: 2rem auto; max-width: 68rem; padding: 0 1rem; line-height: 1.5; }
h1 { font-size: 1.5rem; margin-bottom: .25rem; }
h2 { font-size: 1.1rem; margin-top: 2rem; border-bottom: 1px solid #8884; padding-bottom: .25rem; }
.sub { color: #6668; font-size: .85rem; }
table { border-collapse: collapse; width: 100%; font-size: .85rem; margin-top: .75rem; }
th, td { border: 1px solid #8884; padding: .25rem .4rem; text-align: right; }
th:first-child, td:first-child, th:nth-child(2), td:nth-child(2) { text-align: left; }
thead th { background: #8881; }
table.facts { width: auto; }
table.facts th { text-align: left; background: none; border: none; padding-right: 1rem; white-space: nowrap; }
table.facts td { text-align: left; border: none; }
.note { font-size: .8rem; color: #6668; margin-top: 1rem; }
footer { margin-top: 2rem; font-size: .8rem; color: #6668; border-top: 1px solid #8884; padding-top: .5rem; }
`

/** 单文件 HTML：内联 CSS、无脚本、无外链资源。disclaimer 缺省为因子报告免责声明。 */
export function htmlPage({ title, subtitle, sections, disclaimer = DISCLAIMER }) {
  const body = sections
    .map((section) => `<h2>${escapeHtml(section.heading)}</h2>\n${section.html}`)
    .join('\n')
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${CSS}</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
<p class="sub">${escapeHtml(subtitle)}</p>
${body}
<footer>${escapeHtml(disclaimer)}</footer>
</body>
</html>
`
}
