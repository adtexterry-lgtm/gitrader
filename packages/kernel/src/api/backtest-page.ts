// SPDX-License-Identifier: CPAL-1.0
// Agent 回测结果的分页（R1-PERF-02）：`result` 默认只回摘要（去掉 equity / trades / funding 三个大数组，改给 counts），
// 三个序列按 part + cursor + limit 分页，且每页序列化后的字符数有上限——任何窗口的任何一次回答都不会撞上 MCP 的单次结果上限。
// 分页在内核这一层做：lab 里记的完整结果不变；两种引擎（gitrader-core / python-engine）、内联交付与经 host.artifact.put 交付都走同一条路。
import type { LabArtifacts } from '../lab/artifacts'
import { KernelError } from '../util/errors'
import { makeProblem } from '../proto'

type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
export const BACKTEST_PARTS = ['summary', 'equity', 'trades', 'funding'] as const
type SeriesPart = Exclude<(typeof BACKTEST_PARTS)[number], 'summary'>
const DEFAULT_LIMIT = 500
const MAX_LIMIT = 1000
/** 一页 items 序列化后的字符预算。MCP 单次结果上限是 60,000 字符，这里留出 total / next 等字段和信封的余量。 */
const PAGE_CHAR_BUDGET = 48_000

/** 摘要里的翻页说明：工具定义里没有 part / limit / cursor（改定义要重生成 BUDGET.md），所以在结果里告诉 Agent 怎么取序列。 */
const SERIES_HINT = 'equity / trades / funding are not inline: call result again with part = equity | trades | funding (limit 1..1000, cursor = the "next" of the previous page)'

const bad = (message: string): KernelError => new KernelError(makeProblem('INVALID_PARAMS', message))

/** 一次回测的完整结果 + 已展开的序列（内联为空时从 artifact 读出来，只解析一次）。 */
export interface Entry { full: Json; series: Partial<Record<SeriesPart, unknown[]>> }
const cache = new WeakMap<object, Map<string, Entry>>()
const KEEP = 4

/**
 * 取完整结果：同一把钥匙、同一个作业的结果（完成后不可变）在内核进程里留最近几份，翻页时不必每页都向引擎要一遍完整结果。
 * 缓存键带授权书编号：别的授权书拿不到别人的结果，也不绕过 lab 里「只能看自己的运行」的检查（未命中缓存才走 fetch）。
 */
export async function loadBacktestResult(owner: object, key: string, fetch: () => Promise<unknown>): Promise<Entry> {
  let m = cache.get(owner)
  if (!m) cache.set(owner, (m = new Map()))
  const hit = m.get(key)
  if (hit) { m.delete(key); m.set(key, hit); return hit }
  const full = await fetch()
  if (full === null || typeof full !== 'object' || Array.isArray(full)) return { full: full as Json, series: {} }
  const entry: Entry = { full: full as Json, series: {} }
  m.set(key, entry)
  while (m.size > KEEP) m.delete(m.keys().next().value as string)
  return entry
}

function seriesOf(e: Entry, part: SeriesPart, artifacts: Pick<LabArtifacts, 'read'>): unknown[] {
  const known = e.series[part]
  if (known) return known
  const inline = e.full[part]
  let rows: unknown[] = Array.isArray(inline) ? inline : []
  if (rows.length === 0 && part !== 'funding') {
    // 结果超过 1 MB 时引擎把 equity / trades 交给 host.artifact.put，内联数组是空的：从 artifact 取回完整序列
    const ref = (Array.isArray(e.full.artifacts) ? e.full.artifacts : []).find((a: Json) => a?.kind === part)
    if (ref && typeof ref.artifactId === 'string') {
      const parsed: unknown = JSON.parse(artifacts.read(ref.artifactId).toString('utf8'))
      if (Array.isArray(parsed)) rows = parsed
    }
  }
  e.series[part] = rows
  return rows
}

/** `result` 动作的回答。args 里 part / cursor / limit 都可省略。 */
export function backtestResultPart(e: Entry, args: Json, artifacts: Pick<LabArtifacts, 'read'>): unknown {
  const part = args.part === undefined ? 'summary' : args.part
  if (typeof part !== 'string' || !(BACKTEST_PARTS as readonly string[]).includes(part)) throw bad(`part must be one of ${BACKTEST_PARTS.join(' | ')}`)
  const full = e.full
  if (full === null || typeof full !== 'object') return full
  if (part === 'summary') {
    const { equity: _e, trades: _t, funding: _f, ...rest } = full // eslint-disable-line @typescript-eslint/no-unused-vars
    return {
      ...rest,
      counts: { equity: seriesOf(e, 'equity', artifacts).length, trades: seriesOf(e, 'trades', artifacts).length, funding: seriesOf(e, 'funding', artifacts).length },
      hint: SERIES_HINT,
      // 引擎没带偏差检查（Python 引擎）：如实写「没跑」，摘要里总有这一项，Agent 不必猜
      ...(rest.biasChecks === undefined ? { biasChecks: { lookahead: 'not_run', recursive: 'not_run', trialCount: typeof rest.trialCount === 'number' ? rest.trialCount : 1 } } : {}),
    }
  }
  const limit = args.limit === undefined ? DEFAULT_LIMIT : typeof args.limit === 'string' && /^[0-9]+$/.test(args.limit) ? Number(args.limit) : args.limit
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw bad(`limit must be an integer in 1..${MAX_LIMIT}`)
  let offset = 0
  if (args.cursor !== undefined) {
    if (typeof args.cursor !== 'string' || !/^\d{1,12}$/.test(args.cursor)) throw bad('cursor must be the "next" value of a previous page')
    offset = Number(args.cursor)
  }
  const rows = seriesOf(e, part as SeriesPart, artifacts)
  const items: unknown[] = []
  let chars = 0
  for (let i = offset; i < rows.length && items.length < limit; i++) {
    const len = JSON.stringify(rows[i]).length + 1
    if (items.length > 0 && chars + len > PAGE_CHAR_BUDGET) break // 少给几条，带 next，不截断
    items.push(rows[i])
    chars += len
  }
  const end = offset + items.length
  return { items, total: rows.length, ...(end < rows.length ? { next: String(end) } : {}) }
}
