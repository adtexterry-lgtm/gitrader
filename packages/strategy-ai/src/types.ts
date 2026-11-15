// SPDX-License-Identifier: CPAL-1.0
// 流水线的公共类型。这一层不认识任何模型供应商：模型只从 `Llm` 注入（调用方自己构造，库里不读密钥、不落盘、不打印）。

/** 用户想要什么。字段与 engine-core 的 `GenerationSpec` 逐字一致，便于直接喂给它的提示词函数。 */
export interface StrategySpec {
  intent: string
  instrumentHint?: string
  interval?: string
  style?: 'trend' | 'mean-reversion' | 'breakout' | 'grid' | 'dca' | 'custom'
  constraints?: string[]
  idHint?: string
}

/**
 * 唯一的模型出口。实现方自己持有凭据；本包只调用 `complete`，不碰密钥、不记录 prompt 之外的内容。
 * 抛错或返回空串都算一次失败，由修复循环记进结果。
 */
export interface Llm {
  complete(prompt: string): Promise<string>
}

/** 静态检查 / 加载检查的一条问题（rule 稳定，可被调用方按规则分流）。 */
export interface StaticIssue {
  rule: string
  message: string
  line?: number
}

/** 一次冒烟回测的摘要：全部是历史数据上的既成事实，不含任何推断。 */
export interface SmokeSummary {
  ok: boolean
  bars: number
  trades: number
  fills: number
  finalEquity: number
  maxDrawdownRatio: number
  feesPaid: number
  liquidations: number
  unfilledShare: number
  issues: StaticIssue[]
  warnings: string[]
}

/** 一轮产出：round 0 是首次生成，1..N 是修复轮。 */
export interface RepairAttempt {
  round: number
  code: string
  issues: StaticIssue[]
  smoke?: SmokeSummary
  ok: boolean
}

export type StopReason = 'passed' | 'exhausted' | 'llm-error'

/** 修复循环的最终结果：解释器与调用方都只读这一个对象。 */
export interface GenerationResult {
  ok: boolean
  spec: StrategySpec
  code: string
  attempts: RepairAttempt[]
  /** 实际用掉的修复轮数（首次生成不计）。 */
  rounds: number
  /** 允许的修复轮数上限。 */
  maxRounds: number
  stopped: StopReason
  error?: string
  final: { issues: StaticIssue[]; smoke?: SmokeSummary }
}
