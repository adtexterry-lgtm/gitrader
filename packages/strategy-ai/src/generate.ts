// SPDX-License-Identifier: CPAL-1.0
// 一次生成：组装提示词 → 调注入的 llm → 去围栏。不做校验、不重试（那是 repairLoop 的事）。
import { buildPrompt, stripCodeFences } from './prompt'
import type { Llm, StrategySpec } from './types'

/** 调用方给的 client 没给出可用文本时抛这个：修复循环把它记成 `llm-error`，不当成「代码不合格」。 */
export class GenerationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GenerationError'
  }
}

export interface GenerateOutput {
  /** 去掉围栏、未做任何改写的候选源码。 */
  code: string
  /** 实际发出去的提示词（调用方审计 / 复现用；不含密钥，因为本包从不接触密钥）。 */
  prompt: string
}

/** 单次生成。抛出只发生在 client 抛错 / 返回非字符串 / 返回空白时。 */
export async function generate(spec: StrategySpec, llm: Llm): Promise<GenerateOutput> {
  const prompt = buildPrompt(spec)
  const raw: unknown = await llm.complete(prompt)
  if (typeof raw !== 'string') throw new GenerationError('the llm client returned a non-string completion')
  const code = stripCodeFences(raw)
  if (code.trim() === '') throw new GenerationError('the llm client returned an empty completion')
  return { code, prompt }
}
