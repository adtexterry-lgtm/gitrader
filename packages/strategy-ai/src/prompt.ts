// SPDX-License-Identifier: CPAL-1.0
// 提示词组装。规格来源是 engine-core 的 `strategy/ai-generation.ts`（角色 → 硬规则 → 接口契约 → 用户意图 → 禁止事项），
// 这里只在它后面追加两段本流水线自己的东西：
//   1. 「产出会被怎么检查」——静态校验 + 加载校验 + 合成数据冒烟，失败会把错误原样喂回；
//   2. 修复轮（`buildRepairPrompt`）——上一版代码 + 逐条失败原因。
//
// 为什么不复制 engine-core 的提示词：它是唯一规格来源，复制一份就会漂移。engine-core 的 `src/index.ts` 没有导出这个模块，
// 所以这里按仓库的源码直连方式（TS 源码、Bundler 解析）深路径 import 它，只读、不修改。
//
// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/ai_generation_contracts.py:113; adapted
// (QD appends its instrument-identity contract to the base prompt; we append our own pipeline-rules block to ours).
// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/indicator_ai_generation.py:94-109; adapted
// (QD re-sends "existing code is the source of truth" + the change request on every regeneration; we re-send the previous
// file plus the exact failures instead of a free-form change request).
import { buildStrategyPrompt } from '../../engine-core/src/strategy/ai-generation'
import type { StaticIssue, StrategySpec } from './types'

/**
 * 追加在 engine-core 提示词之后：让模型知道产出会被真跑一遍，以及修复轮长什么样。
 * 这段只描述检查项，不描述模型、不描述供应商、不给任何结果承诺。
 */
const PIPELINE_RULES = `# What happens to the file you return
- It is checked statically first: \`export default\`, \`evaluate()\`, no runtime import, no IO / randomness / wall clock, \`id\` / \`version\` / \`desc\`, parameter names, and parameter default / min / max / step consistency.
- It is then loaded by the Gitrader loader, which re-runs \`evaluate()\` on synthetic candles: empty input, 5 candles, 600 candles, every numeric parameter at its min and at its max, twice for determinism, and truncated histories to catch look-ahead. Then it is backtested on generated candles; the run must finish without throwing.
- If any check fails, the failures are sent back to you verbatim with the previous file and you are asked for one complete replacement file. Fix every listed failure and keep what already passes. Do not add prose, fences or a second file.`

/** 围栏去掉前后逐字比较用；与 engine-core `ai-generation.ts` 的同名逻辑一致。 */
// Ported from engine-core src/strategy/ai-generation.ts:106-118 (FENCE_OPEN / FENCE_CLOSE / stripFences); copied
// because that helper is module-private and is needed before validation runs.
const FENCE_OPEN = /^[ \t]*```[^\n]*\n/m
const FENCE_CLOSE = /^[ \t]*```[ \t]*$/m

/** 去掉 ``` 代码围栏；围栏内的内容原样保留。模型经常无视「不要围栏」，这里兜住。 */
export function stripCodeFences(text: string): string {
  const src = typeof text === 'string' ? text.replace(/^\uFEFF/, '') : ''
  if (!src.includes('```')) return src
  const open = FENCE_OPEN.exec(src)
  if (!open) return src
  const rest = src.slice(open.index + open[0].length)
  const close = FENCE_CLOSE.exec(rest)
  return close ? rest.slice(0, close.index) : rest
}

/** 给模型的完整提示词：engine-core 的规格 + 本流水线的检查说明。 */
export function buildPrompt(spec: StrategySpec): string {
  return `${buildStrategyPrompt(spec)}\n\n${PIPELINE_RULES}\n`
}

/** 失败清单的一行：规则名、行号（有的话）、原话。机器可读的规则名放在最前，方便模型对号入座。 */
function formatIssue(issue: StaticIssue): string {
  const where = issue.line === undefined ? '' : ` line ${issue.line}`
  return `- [${issue.rule}]${where}: ${issue.message}`
}

/**
 * 修复轮提示词：同一份规格 + 上一版完整代码 + 逐条失败原因。
 * 规格每次都带上——模型没有跨轮记忆，少给一段就会丢掉硬规则。
 */
export function buildRepairPrompt(
  spec: StrategySpec,
  code: string,
  issues: readonly StaticIssue[],
  round: number,
  maxRounds: number,
): string {
  const failures = issues.length === 0 ? ['- (no failure reported; return one complete replacement file that also passes the smoke run)'] : issues.map(formatIssue)
  return [
    buildPrompt(spec).trimEnd(),
    `# Repair round ${round} of ${maxRounds}`,
    'The previous file failed the automated checks listed below. Return one complete replacement strategy file: no prose, no fences, no second file. Keep everything that already passes.',
    '# Previous file',
    '```ts',
    code.trimEnd(),
    '```',
    '# Failures to fix',
    ...failures,
  ].join('\n\n') + '\n'
}
