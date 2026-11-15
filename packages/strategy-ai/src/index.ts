// SPDX-License-Identifier: CPAL-1.0
// @gitrader/strategy-ai：AI 生成策略的离线闭环——提示词 → 生成 → 静态校验 → 冒烟回测 → 有界修复 → 可读报告。
// 模型只从 `Llm` 注入；本包不读密钥、不联网、不打印请求内容。
export { buildPrompt, buildRepairPrompt, stripCodeFences } from './prompt'
export { generate, GenerationError } from './generate'
export type { GenerateOutput } from './generate'
export { validate } from './validate'
export type { ValidationResult } from './validate'
export { smoke, defaultSmokeCandles } from './smoke'
export type { SmokeOptions } from './smoke'
export { repairLoop, DEFAULT_MAX_ROUNDS } from './repair'
export type { RepairOptions } from './repair'
export { explain } from './explain'
export type { GenerationResult, Llm, RepairAttempt, SmokeSummary, StaticIssue, StopReason, StrategySpec } from './types'
