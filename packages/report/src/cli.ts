// SPDX-License-Identifier: CPAL-1.0
// CLI 入口：report <result.json> [--md out.md] [--html out.html] [--title 标题]。
// 约定：返回 0 / 2，不调用 process.exit，stdout / stderr 可注入（测试离线跑）。
import { readFileSync, writeFileSync } from 'node:fs'
import { renderHtml } from './html'
import { renderMarkdown } from './markdown'
import { computeReportMetrics } from './metrics'
import type { BacktestResult, ReportInput, ReportMetric } from './types'

export interface CliIo {
  stdout(s: string): void
  stderr(s: string): void
}

export const USAGE = '用法：report <result.json> [--md out.md] [--html out.html] [--title 标题]'

export interface ReportArgs {
  file: string
  md?: string
  html?: string
  title?: string
}

export interface ArgsError {
  error: string
}

/** 解析参数；出错时返回 { error }（调用方写 stderr 并返回 2）。 */
export function parseArgs(argv: readonly string[]): ReportArgs | ArgsError {
  const rest = argv[0] === 'report' ? argv.slice(1) : [...argv]
  if (rest.length === 0 || rest[0] === '--help' || rest[0] === '-h' || rest[0] === 'help') return { error: USAGE }
  if (rest[0] === '--md' || rest[0] === '--html' || rest[0] === '--title') return { error: `缺少结果文件参数。${USAGE}` }
  const file = rest[0]!
  const args: ReportArgs = { file }
  for (let i = 1; i < rest.length; i++) {
    const flag = rest[i]!
    if (flag !== '--md' && flag !== '--html' && flag !== '--title') return { error: `未知参数 ${flag}。${USAGE}` }
    const value = rest[i + 1]
    if (value === undefined || value.startsWith('--')) return { error: `${flag} 缺少取值。${USAGE}` }
    if (flag === '--md') args.md = value
    else if (flag === '--html') args.html = value
    else args.title = value
    i += 1
  }
  return args
}

/** 最小形状校验：stats 是对象、equity 是数组；trades 缺省补空数组。 */
export function normalizeResult(raw: unknown): BacktestResult | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  const stats = record['stats']
  const equity = record['equity']
  if (stats === null || typeof stats !== 'object' || Array.isArray(stats)) return null
  if (!Array.isArray(equity)) return null
  const trades = Array.isArray(record['trades']) ? (record['trades'] as BacktestResult['trades']) : []
  return { ...(record as unknown as BacktestResult), stats: stats as BacktestResult['stats'], equity: equity as BacktestResult['equity'], trades }
}

const defaultIo: CliIo = {
  stdout: (s) => {
    process.stdout.write(s)
  },
  stderr: (s) => {
    process.stderr.write(s)
  },
}

/** 从文件路径读结果 → 渲染 → 写盘（或打到 stdout）。返回 0 / 2。 */
export async function run(argv: string[], io: CliIo = defaultIo): Promise<number> {
  const parsed = parseArgs(argv)
  if ('error' in parsed) {
    io.stderr(`${parsed.error}\n`)
    return 2
  }

  let text: string
  try {
    text = readFileSync(parsed.file, 'utf8')
  } catch {
    io.stderr(`无法读取结果文件：${parsed.file}\n`)
    return 2
  }

  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    io.stderr(`结果文件不是合法 JSON：${parsed.file}\n`)
    return 2
  }

  const result = normalizeResult(raw)
  if (result === null) {
    io.stderr(`结果文件缺少 stats 对象或 equity 数组：${parsed.file}\n`)
    return 2
  }

  const input: ReportInput = { result, generatedAt: Date.now() }
  if (parsed.title !== undefined) input.title = parsed.title

  const metrics = computeReportMetrics(input)
  const markdown = renderMarkdown(input, metrics)
  const html = renderHtml(input, metrics)

  if (parsed.md === undefined && parsed.html === undefined) {
    io.stdout(markdown.endsWith('\n') ? markdown : `${markdown}\n`)
    return 0
  }

  try {
    if (parsed.md !== undefined) {
      writeFileSync(parsed.md, markdown, 'utf8')
      io.stdout(`已写入 Markdown：${parsed.md}\n`)
    }
    if (parsed.html !== undefined) {
      writeFileSync(parsed.html, html, 'utf8')
      io.stdout(`已写入 HTML：${parsed.html}\n`)
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    io.stderr(`写入报告失败：${reason}\n`)
    return 2
  }

  if (metrics.warnings.length > 0) io.stderr(`指标告警：${metrics.warnings.join('；')}\n`)
  return 0
}

/** 供外部按 key 读一行指标（CLI / 上层展示用）。 */
export function metricValue(rows: readonly ReportMetric[], key: string): string {
  return rows.find((r) => r.key === key)?.value ?? '—'
}
