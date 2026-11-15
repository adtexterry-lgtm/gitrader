// SPDX-License-Identifier: CPAL-1.0
// 因子研究报告 CLI：读 K 线文件 -> 全部 Alpha158 因子 -> IC / IR / 分位组收益 -> Markdown + HTML。
// 用法见 README「factor-report.mjs」；离线运行，不联网（只读本地文件、写本地报告）。
import { writeFileSync } from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readCandleFile } from '../packages/cli/src/research/candles.mjs'
import { buildFactorReport, normalizeOptions, renderFactorHtml, renderFactorMarkdown } from '../packages/cli/src/research/factor-report.mjs'

/** 用法行（同时用于 --help 与参数错误提示）。 */
export const USAGE =
  '用法：factor-report.mjs <k线文件.csv|json> [--horizon 5] [--window 60] [--quantiles 5] [--top 20] [--title 标题] [--md out.md] [--html out.html]'

const INT_FLAGS = new Set(['horizon', 'window', 'quantiles', 'top'])
const STRING_FLAGS = new Set(['title', 'md', 'html'])

/** 默认输出路径：同目录下 `<文件名>.factors.md` / `.factors.html`。 */
export function defaultOutputs(file) {
  const base = basename(file, extname(file))
  const dir = dirname(resolve(file))
  return { md: join(dir, `${base}.factors.md`), html: join(dir, `${base}.factors.html`) }
}

/** 解析 argv；返回 { args } 或 { error }。 */
export function parseArgs(argv) {
  const args = { file: null, horizon: 5, window: 60, quantiles: 5, top: 20, title: null, md: null, html: null }
  if (argv.length === 0) return { error: '缺少 K 线文件' }
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (token === '--help' || token === '-h') return { help: true }
    if (!token.startsWith('--')) {
      if (args.file !== null) return { error: `多余的位置参数：${token}` }
      args.file = token
      continue
    }
    const name = token.slice(2)
    if (!INT_FLAGS.has(name) && !STRING_FLAGS.has(name)) return { error: `未知参数：${token}` }
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) return { error: `参数 ${token} 缺少取值` }
    i += 1
    if (INT_FLAGS.has(name)) {
      const n = Number(value)
      if (!Number.isInteger(n) || n < 1) return { error: `参数 ${token} 必须是 >= 1 的整数；收到 ${value}` }
      args[name] = n
    } else args[name] = value
  }
  if (args.file === null) return { error: '缺少 K 线文件' }
  return { args }
}

/**
 * 运行一次报告生成；返回退出码 0（成功）/ 2（参数或数据问题）。不调用 process.exit。
 */
export async function run(argv, io = { stdout: (s) => process.stdout.write(s), stderr: (s) => process.stderr.write(s) }) {
  const parsed = parseArgs(argv)
  if (parsed.help) {
    io.stdout(`${USAGE}\n`)
    return 0
  }
  if (parsed.error !== undefined) {
    io.stderr(`${parsed.error}\n${USAGE}\n`)
    return 2
  }
  const args = parsed.args
  let source
  try {
    source = readCandleFile(args.file)
  } catch (error) {
    io.stderr(`读取 K 线文件失败：${error instanceof Error ? error.message : String(error)}\n`)
    return 2
  }
  if (source.candles.length === 0) {
    io.stderr(`K 线文件里没有可用数据：${args.file}\n`)
    return 2
  }
  const outputs = defaultOutputs(args.file)
  const mdPath = args.md ?? outputs.md
  const htmlPath = args.html ?? outputs.html
  let options
  try {
    options = normalizeOptions({
      horizon: args.horizon,
      window: args.window,
      quantiles: args.quantiles,
      top: args.top,
      title: args.title ?? `因子研究报告 · ${basename(args.file)}`,
    })
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n${USAGE}\n`)
    return 2
  }
  const report = buildFactorReport({
    candles: source.candles,
    horizon: options.horizon,
    window: options.window,
    quantiles: options.quantiles,
    top: options.top,
    title: options.title,
    source: {
      path: args.file,
      sha256: source.sha256,
      rows: source.rows,
      skipped: source.skipped,
      duplicates: source.duplicates,
      format: source.format,
    },
  })
  writeFileSync(mdPath, renderFactorMarkdown(report), 'utf8')
  writeFileSync(htmlPath, renderFactorHtml(report), 'utf8')
  for (const warning of report.warnings) io.stderr(`提示：${warning}\n`)
  io.stdout(
    `因子报告已生成：${report.bars} 根 K 线，${report.catalogSize} 条因子，有效 IC ${report.withIc} 条\n  ${mdPath}\n  ${htmlPath}\n`,
  )
  return 0
}

const entry = process.argv[1]
if (entry !== undefined && resolve(entry) === fileURLToPath(import.meta.url)) {
  run(process.argv.slice(2)).then((code) => {
    process.exitCode = code
  })
}
