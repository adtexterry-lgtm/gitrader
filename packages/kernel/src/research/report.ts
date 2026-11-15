// SPDX-License-Identifier: CPAL-1.0
// research.backtest_report：把一个已完成的回测作业写成报告。指标直接取回测结果自带的 stats（不重算、不四舍五入），
// Markdown 用 @gitrader/report 渲染；整个回包 ≤ 8000 字节，markdown ≤ 6000 字符，超出截断并置 truncated。
// 回测结果经 lab.forward('backtest.result') 取：Agent 只能看自己名下的回测，未完成回 BUSY，不存在的作业回错误，不回空报告。
import { computeReportMetrics, headlineMetrics, renderMarkdown } from '@gitrader/report'
import type { BacktestResult as ReportResult } from '@gitrader/report'
import { RESEARCH_LIMITS } from '../proto'
import type { Kernel } from '../kernel'
import type { ActorCtx } from '../trading'
import { bad, needString } from './args'

const METRIC_KEYS = ['sharpe', 'totalReturnRatio', 'maxDrawdownRatio', 'finalEquity', 'fills', 'feesPaid', 'annualizedRatio', 'winRatio', 'trades', 'sortino', 'profitFactor'] as const
const bytes = (v: unknown): number => Buffer.byteLength(JSON.stringify(v))

export async function backtestReport(k: Kernel, actor: ActorCtx, engineId: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const jobId = needString(args.jobId, 'jobId')
  const format = args.format === undefined ? 'md' : args.format
  if (format !== 'md' && format !== 'json') throw bad('format must be md or json')
  const res = (await k.lab.forward(engineId, 'backtest.result', { jobId }, actor)) as ReportResult & { stats?: Record<string, unknown> }
  if (!res || typeof res !== 'object' || !res.stats) throw bad(`job ${jobId} has no backtest result`)
  const metrics: Record<string, unknown> = {}
  for (const key of METRIC_KEYS) if (key in res.stats) metrics[key] = res.stats[key]
  let headline = `夏普 ${String(metrics.sharpe)}，总收益 ${String(metrics.totalReturnRatio)}，最大回撤 ${String(metrics.maxDrawdownRatio)}，成交 ${String(metrics.fills)} 笔`
  let markdown = ''
  try {
    const input = { result: res, title: `回测报告 ${jobId}`, generatedAt: k.clock.now() }
    const m = computeReportMetrics(input)
    const h = headlineMetrics(m)
    headline = `总收益 ${h.totalReturn}，最大回撤 ${h.maxDrawdown}，夏普 ${h.sharpe}，成交 ${h.trades} 笔`
    markdown = renderMarkdown(input, m)
  } catch {
    // 曲线 / 成交没有随结果内联（大结果走了 artifact）时报告库可能算不出完整版：给一份只含统计的简版，指标仍然完整
    markdown = `# 回测报告 ${jobId}\n\n${Object.entries(metrics).map(([key, value]) => `- ${key}: ${String(value)}`).join('\n')}\n`
  }
  const out: Record<string, unknown> = { jobId, headline, metrics, markdown: '', truncated: false, assumptions: res.assumptions ?? {} }
  if (format === 'json') return { ...out, markdown: undefined }
  markdown = markdown.trim()
  let md = markdown.slice(0, RESEARCH_LIMITS.reportMarkdownMaxChars)
  while (md.length > 0 && bytes({ ...out, markdown: md }) > RESEARCH_LIMITS.reportMaxBytes - 200) md = md.slice(0, Math.floor(md.length * 0.9))
  return { ...out, markdown: md, truncated: md.length < markdown.length }
}
