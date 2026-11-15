// SPDX-License-Identifier: CPAL-1.0
// 静态校验：直接把 engine-core 的 `validateGeneratedStrategy` 拿来用（去围栏 → export default / evaluate →
// import / IO → id / version / desc / 参数名 / 参数质量），不重写、不改它、不执行代码。
//
// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/indicator_code_quality.py:444-549; adapted
// (QD returns a severity-tagged hint list; engine-core already returns rule-tagged issues with line numbers, so this
// module is a thin adapter that keeps the rule names stable for the repair loop).
import { validateGeneratedStrategy } from '../../engine-core/src/strategy/ai-generation'
import type { StaticIssue } from './types'

export interface ValidationResult {
  ok: boolean
  /** 去围栏后的源码：后续冒烟用这一份，保证喂给引擎的与校验的是同一段。 */
  source: string
  issues: StaticIssue[]
}

/** 纯静态校验，不联网、不加载、不执行。 */
export function validate(code: string): ValidationResult {
  const { source, issues } = validateGeneratedStrategy(typeof code === 'string' ? code : '')
  const normalized: StaticIssue[] = issues.map((i) => (i.line === undefined ? { rule: i.rule, message: i.message } : { rule: i.rule, message: i.message, line: i.line }))
  return { ok: normalized.length === 0, source, issues: normalized }
}
