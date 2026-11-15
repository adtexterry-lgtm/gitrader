// SPDX-License-Identifier: CPAL-1.0
// 扫描 / 走查结果报告 CLI：读 runSweep 或 runWalkForward 的 JSON 结果，渲染成 Markdown + HTML 表。
// 不重跑回测、不联网；只读一个 JSON、写两份报告。
import { readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildSweepReport,
  buildWalkForwardReport,
  detectKind,
  renderHtmlFor,
  renderMarkdownFor,
} from '../packages/cli/src/research/sweep-render.mjs'

/** 用法行。 */
export const USAGE =
  '用法：sweep-report.mjs <sweep|walk-forward 结果.json> [--kind sweep|walk-forward] [--top 10] [--title 标题] [--md out.md] [--html out.html]'

/** 默认输出路径：同目录下 `<文件名>.sweep.md` / `.sweep.html`。 */
export function defaultOutputs(file) {
  const base = basename(file, extname(file))
  const dir = dirname(resolve(file))
  return { md: join(dir, `${base}.sweep.md`), html: join(dir, `${base}.sweep.html`) }
}

/** 解析 argv；返回 { args } / { error } / { help }。 */
export function parseArgs(argv) {
  const args = { file: null, kind: 'auto', top: null, title: null, md: null, html: null }
  if (argv.length === 0) return { error: '缺少结果 JSON 文件' }
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (token === '--help' || token === '-h') return { help: true }
    if (!token.startsWith('--')) {
      if (args.file !== null) return { error: `多余的位置参数：${token}` }
      args.file = token
      continue
    }
    const name = token.slice(2)
    if (!['kind', 'top', 'title', 'md', 'html'].includes(name)) return { error: `未知参数：${token}` }
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) return { error: `参数 ${token} 缺少取值` }
    i += 1
    if (name === 'top') {
      const n = Number(value)
      if (!Number.isInteger(n) || n < 1) return { error: `参数 --top 必须是 >= 1 的整数；收到 ${value}` }
      args.top = n
    } else if (name === 'kind') {
      if (!['auto', 'sweep', 'walk-forward'].includes(value)) {
        return { error: `参数 --kind 只能是 auto / sweep / walk-forward；收到 ${value}` }
      }
      args.kind = value
    } else args[name] = value
  }
  if (args.file === null) return { error: '缺少结果 JSON 文件' }
  return { args }
}

/**
 * 运行一次渲染；返回退出码 0 / 2。不调用 process.exit。
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
  let data
  try {
    data = JSON.parse(readFileSync(args.file, 'utf8'))
  } catch (error) {
    io.stderr(`读取结果 JSON 失败：${error instanceof Error ? error.message : String(error)}\n`)
    return 2
  }
  const kind = args.kind === 'auto' ? detectKind(data) : args.kind
  if (kind === null) {
    io.stderr('结果 JSON 既没有 trials 也没有 folds 数组，无法判断类型；用 --kind 指定\n')
    return 2
  }
  const title = args.title ?? `${kind === 'walk-forward' ? '走查结果' : '参数扫描结果'} · ${basename(args.file)}`
  let report
  try {
    report =
      kind === 'walk-forward'
        ? buildWalkForwardReport(data, { title, top: args.top ?? 20 })
        : buildSweepReport(data, { title, top: args.top ?? 10 })
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n${USAGE}\n`)
    return 2
  }
  const outputs = defaultOutputs(args.file)
  const mdPath = args.md ?? outputs.md
  const htmlPath = args.html ?? outputs.html
  writeFileSync(mdPath, renderMarkdownFor(report), 'utf8')
  writeFileSync(htmlPath, renderHtmlFor(report), 'utf8')
  for (const warning of report.warnings) io.stderr(`提示：${warning}\n`)
  const count = kind === 'walk-forward' ? `${report.totalFolds} 折` : `${report.totalTrials} 组试验`
  io.stdout(`扫描报告已生成：${count}\n  ${mdPath}\n  ${htmlPath}\n`)
  return 0
}

const entry = process.argv[1]
if (entry !== undefined && resolve(entry) === fileURLToPath(import.meta.url)) {
  run(process.argv.slice(2)).then((code) => {
    process.exitCode = code
  })
}
