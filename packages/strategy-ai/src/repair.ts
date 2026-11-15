// SPDX-License-Identifier: CPAL-1.0
// 修复循环：生成 → 静态校验 → 冒烟（必要时）→ 把失败原样喂回模型重来，最多 N 轮（缺省 2）。
// 每一轮都记进结果（代码、失败清单、冒烟摘要），`explain` 只读这个对象就能写出一份可核对的报告。
//
// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/indicator_ai_generation.py:60-194; adapted
// (QD allows exactly one fallback — model patch → full regeneration — and records the executor in a plan dict; here the
// same "failure goes back to the generator, the successful path is kept" flow is generalized to N configurable rounds
// and the per-round outcome is kept as data instead of a log line).
// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/ai_code_edits.py:56-113; not applied
// (QD applies bounded exact-replacement edits to an existing file; we always ask for one complete replacement file so the
// static rules are re-checked against a self-contained candidate).
import type { Candle } from '@gitrader/engine-core'
import { GenerationError, generate } from './generate'
import { buildRepairPrompt, stripCodeFences } from './prompt'
import { defaultSmokeCandles, smoke } from './smoke'
import type { GenerationResult, Llm, RepairAttempt, SmokeSummary, StaticIssue, StrategySpec } from './types'
import { validate } from './validate'

/** 缺省修复轮数：首次生成之后最多再问两次。 */
export const DEFAULT_MAX_ROUNDS = 2
/** 上限只是防止调用方误传大数把账单拉长，不是推荐值。 */
const HARD_ROUND_CAP = 8

export interface RepairOptions {
  /** 修复轮数上限（首次生成不计）。缺省 2，允许 0（只生成一次，不修）。 */
  maxRounds?: number
  /** 冒烟用的 K 线；缺省用 engine-core 的合成序列（固定 seed）。 */
  candles?: readonly Candle[]
  /** 冒烟参数；缺省用策略声明的默认值。 */
  params?: Record<string, unknown>
  initialCash?: number
  intervalMs?: number
  /** 加载校验预算（毫秒）。 */
  budgetMs?: number
}

function normalizeRounds(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_MAX_ROUNDS
  const n = Math.floor(value)
  return n < 0 ? 0 : n > HARD_ROUND_CAP ? HARD_ROUND_CAP : n
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function smokeOptions(opts: RepairOptions): { params?: Record<string, unknown>; initialCash?: number; intervalMs?: number; budgetMs?: number } {
  const out: { params?: Record<string, unknown>; initialCash?: number; intervalMs?: number; budgetMs?: number } = {}
  if (opts.params !== undefined) out.params = opts.params
  if (opts.initialCash !== undefined) out.initialCash = opts.initialCash
  if (opts.intervalMs !== undefined) out.intervalMs = opts.intervalMs
  if (opts.budgetMs !== undefined) out.budgetMs = opts.budgetMs
  return out
}

/** 跑完整闭环。返回结构化结果，不抛错（client 抛错记成 `llm-error`）。 */
export async function repairLoop(spec: StrategySpec, llm: Llm, opts: RepairOptions = {}): Promise<GenerationResult> {
  const maxRounds = normalizeRounds(opts.maxRounds)
  const candles: readonly Candle[] = opts.candles ?? defaultSmokeCandles()
  const smokeOpts = smokeOptions(opts)
  const attempts: RepairAttempt[] = []

  let code: string
  try {
    code = (await generate(spec, llm)).code
  } catch (e) {
    return { ok: false, spec, code: '', attempts, rounds: 0, maxRounds, stopped: 'llm-error', error: messageOf(e), final: { issues: [] } }
  }

  for (let round = 0; round <= maxRounds; round++) {
    const checked = validate(code)
    let issues: StaticIssue[] = checked.issues
    let smokeSummary: SmokeSummary | undefined
    if (issues.length === 0) {
      smokeSummary = await smoke(checked.source, candles, smokeOpts)
      if (!smokeSummary.ok) issues = smokeSummary.issues
    }
    const ok = issues.length === 0 && smokeSummary?.ok === true
    attempts.push({ round, code: checked.source, issues, ...(smokeSummary === undefined ? {} : { smoke: smokeSummary }), ok })
    if (ok) {
      return { ok: true, spec, code: checked.source, attempts, rounds: round, maxRounds, stopped: 'passed', final: { issues: [], ...(smokeSummary === undefined ? {} : { smoke: smokeSummary }) } }
    }
    if (round === maxRounds) break

    const repairPrompt = buildRepairPrompt(spec, checked.source, issues.length > 0 ? issues : [{ rule: 'smoke', message: 'the smoke run failed' }], round + 1, maxRounds)
    try {
      const raw: unknown = await llm.complete(repairPrompt)
      if (typeof raw !== 'string') throw new GenerationError('the llm client returned a non-string completion')
      code = stripCodeFences(raw)
      if (code.trim() === '') throw new GenerationError('the llm client returned an empty completion')
    } catch (e) {
      return {
        ok: false, spec, code: checked.source, attempts, rounds: round, maxRounds, stopped: 'llm-error', error: messageOf(e),
        final: { issues, ...(smokeSummary === undefined ? {} : { smoke: smokeSummary }) },
      }
    }
  }

  const last = attempts[attempts.length - 1]
  const finalIssues = last?.issues ?? [{ rule: 'smoke', message: 'no attempt completed' }]
  return {
    ok: false, spec, code: last?.code ?? '', attempts, rounds: attempts.length - 1, maxRounds, stopped: 'exhausted',
    final: { issues: finalIssues, ...(last?.smoke === undefined ? {} : { smoke: last.smoke }) },
  }
}
