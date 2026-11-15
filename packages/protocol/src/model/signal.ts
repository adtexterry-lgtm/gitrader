// SPDX-License-Identifier: Apache-2.0
// 契约 §1.4.11 Signal、§1.4.12 Experiment、§5.8 DecisionRecord（分析级数值允许 number）。
import type { Decimal, Ms } from './decimal'
import type { AccountId, DecisionId, ExperimentId, InstrumentId, JobId, MandateId, SignalId, Sha256Digest } from './ids'
import type { Origin } from './origin'
import type { BaselineRef, EvidencePackRef, ExperimentExecutor, ExperimentLlm, ExperimentOwner, ForwardStats, Window } from './experiment'
export * from './experiment'

export const SIGNAL_KINDS = ['target', 'entry', 'exit', 'alert'] as const
export type SignalKind = (typeof SIGNAL_KINDS)[number]

export interface EvidenceRef { type: 'signal' | 'decision' | 'note' | 'backtest' | 'experiment'; id: string }

export interface Signal {
  signalId: SignalId
  ts: Ms
  instrumentId: InstrumentId
  kind: SignalKind
  /** −1..1；kind=target 必填。 */
  target?: number
  /** 0..1；只有声明了评分方法（method）才允许出现。 */
  strength?: number
  confidence?: number
  method?: string
  /** 信号必须有过期窗口。 */
  expiresAt: Ms
  reason: string
  evidence?: EvidenceRef[]
  origin: Origin
}

// ---- Experiment -----------------------------------------------------------------

/**
 * 前六个是 v0.1.1 原值；v0.1.3 追加 hypothesis / holdout / shadow / live / retired（枚举只追加）。
 * 合伙人流程对应：hypothesis → backtest → holdout → shadow → live_small（小额实盘）→ live → retired；paper 与 review / closed 保留。
 */
export const EXPERIMENT_STAGES = ['draft', 'backtest', 'paper', 'live_small', 'review', 'closed', 'hypothesis', 'holdout', 'shadow', 'live', 'retired'] as const
export type ExperimentStage = (typeof EXPERIMENT_STAGES)[number]

/** 钉死的版本与哈希。 */
export interface Pin { kind: string; id: string; version: string; sha256: Sha256Digest }

export type BiasCheckResult = 'pass' | 'fail' | 'not_run'

export interface BacktestAssumptions {
  fees: { maker: Decimal; taker: Decimal } | 'venue'
  slippageBps: number
  /** 成交模型，如 next-bar-open。 */
  fillModel: string
  funding: boolean
  liquidation: boolean
  latencyMs?: number
  /** 单根 K 线可成交量比例（0–1）；缺省不限。 */
  maxVolumeShare?: number
  /** 强平时额外扣除维持保证金的比例（分数）；缺省 0。 */
  liquidationPenaltyRatio?: number
  [extension: `x-${string}`]: unknown
}

export interface ExperimentRun {
  stage: ExperimentStage
  jobId?: JobId
  accountId?: AccountId
  mandateId?: MandateId
  from: Ms
  to: Ms | null
  runId?: string
  attachedAt?: Ms
  executor?: ExperimentExecutor
  ledgerRange?: { fromSeq: number; toSeq: number }
}

export interface Experiment {
  experimentId: ExperimentId
  title: string
  hypothesis: string
  stage: ExperimentStage
  subject: { strategy?: Pin; workflow?: Pin; params: Record<string, number | boolean | string> }
  data?: { source: string; range: string; sha256: Sha256Digest }[]
  /** backtest 阶段必填。 */
  assumptions?: BacktestAssumptions
  biasChecks?: { lookahead: BiasCheckResult; recursive: BiasCheckResult; trialCount: number }
  runs?: ExperimentRun[]
  /** 三级口径分开存、分开展示，不合并。 */
  metrics?: { backtest?: Record<string, unknown>; paper?: Record<string, unknown>; live?: Record<string, unknown> }
  conclusion?: { text: string; origin: Origin; at: Ms }
  origin: Origin
  createdAt: Ms
  updatedAt: Ms
  version?: number
  owner?: ExperimentOwner
  subjectKey?: Sha256Digest | null
  executorKind?: 'engine' | 'agent' | null
  frozen?: { hypothesis: boolean; subject: boolean; holdout: boolean }
  holdoutWindow?: Window | null
  holdoutRunId?: string | null
  packs?: EvidencePackRef[]
  forward?: ForwardStats | null
  baseline?: BaselineRef | null
  llm?: ExperimentLlm
  stageEnteredAt?: Ms
  reviewFrom?: ExperimentStage | null
  conclusions?: { text: string; origin: Origin; at: Ms; version: number }[]
  lineage?: { parentExperimentId?: ExperimentId; reason?: string }
  notes?: { text: string; origin: Origin; at: Ms }[]
}

// ---- DecisionRecord（快决策模型决策日志）-------------------------------------------

export interface DecisionRecord {
  decisionId: DecisionId
  ts: Ms
  plugin: { id: string; version: string; sha256: Sha256Digest }
  /** 只记主机名，不记 Key。 */
  endpoint: { configId: string; host: string }
  /** System One 原语（choice / score 等）。 */
  primitive: string
  input: { digest: Sha256Digest; refs: string[] }
  output: { choice?: string; probabilities?: Record<string, number>; score?: number; confidence?: number }
  latencyMs: number
  latencyBudgetMs: number
  /** v0.1.3：本次决策所用分类模型的版本（滚动训练时每次重训版本不同，插件包版本不变）。 */
  modelVersion?: string
  /** 超出预算的决策不得用于下单。 */
  withinBudget: boolean
  status: 'ok' | 'timeout' | 'error'
  cost?: { amount: Decimal; ccy: string }
  /** 事后补：写成单独的 decision.resolved 账本条目。 */
  outcome?: { resolvedAt: Ms; label?: string; realizedReturnRatio?: Decimal; used: boolean }
  origin: Origin
}

// ---- 亏损分解（v0.1.3）---------------------------------------------------------------------

/**
 * 放在 `Experiment.metrics.{backtest|paper|live}.lossAttribution`，不进账本头部、不入哈希链作为事实（归因是派生的分析结论）。
 * 各项为十进制字符串（现金流符号，亏损为负）；要求 earlyExit + lateExit + violation + overtrading + residual = totalLoss。
 */
export interface LossAttribution {
  totalLoss: Decimal
  earlyExit: Decimal
  lateExit: Decimal
  violation: Decimal
  overtrading: Decimal
  residual: Decimal
  method: string
  /** 被分析的账本区间。 */
  basis: { fromSeq: number; toSeq: number }
}

const dscale = (s: string): { n: bigint; frac: number } => {
  const neg = s.startsWith('-')
  const [i, f = ''] = (neg ? s.slice(1) : s).split('.')
  const n = BigInt(`${i}${f}`) * (neg ? -1n : 1n)
  return { n, frac: f.length }
}

/** 检查分解各项之和等于 totalLoss（精确十进制，不走浮点）。返回问题列表，空 = 通过。 */
export function checkLossAttribution(a: LossAttribution): string[] {
  const parts = [a.earlyExit, a.lateExit, a.violation, a.overtrading, a.residual].map(dscale)
  const total = dscale(a.totalLoss)
  const frac = Math.max(total.frac, ...parts.map((p) => p.frac))
  const up = (x: { n: bigint; frac: number }): bigint => x.n * 10n ** BigInt(frac - x.frac)
  const sum = parts.reduce((s, p) => s + up(p), 0n)
  return sum === up(total) ? [] : [`lossAttribution parts do not add up to totalLoss (${a.totalLoss})`]
}
