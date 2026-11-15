// SPDX-License-Identifier: Apache-2.0
// 契约 §2.4 BacktestSpec / BacktestResult（比例一律分数，Ratio 后缀）。
import type { Decimal, Ms } from '../model/decimal'
import type { InstrumentId, Sha256Digest } from '../model/ids'
import type { BacktestAssumptions, BiasCheckResult } from '../model/signal'
import type { EvidencePackDraft } from '../model/experiment'

export interface BacktestSubject {
  strategy?: { id: string; version: string; params: Record<string, number | boolean | string> }
  workflow?: { id: string; version: number | string; json?: unknown }
}

export interface BacktestSpec {
  subject: BacktestSubject
  instruments: InstrumentId[]
  interval: string
  from: Ms
  to: Ms
  data: {
    source: 'host' | 'engine' | 'files'
    files?: {
      path: string; sha256: Sha256Digest; format: 'parquet' | 'csv' | 'json'
      /** 缺省 candles；funding 文件含 t、rate 与可选 premium。 */
      kind?: 'candles' | 'funding'
    }[]
  }
  account: {
    initialBalance: Decimal; ccy: string; leverage?: number
    /** 维持保证金比例（分数）；缺省 0.5 / leverage。 */
    maintenanceMarginRatio?: number
  }
  assumptions: BacktestAssumptions
  seed: number
}

/** 回测结果属分析级数据（§1.3：分析级数据可用浮点），数值用 JSON number；比例一律分数。 */
export interface BacktestStats {
  totalReturnRatio: number
  annualizedRatio: number
  maxDrawdownRatio: number
  sharpe: number
  sortino?: number
  winRatio: number
  profitFactor: number | null
  trades: number
  fills: number
  avgHoldBars: number
  spanDays: number
  finalEquity: number
  /** 正数为净资金费支出。 */
  fundingPaid?: number
  feesPaid?: number
  liquidations?: number
  /** 因成交量上限未成交的名义占比（0–1）。 */
  unfilledShare?: number
}

/** reason 约定值 liquidation 表示强平；资金费单独记入 BacktestResult.funding，不进入 trades。 */
export interface BacktestTrade { t: Ms; side: 'buy' | 'sell'; price: number; size: number; pnl: number; fee: number; reason: string }

export interface BacktestResult {
  jobId: string
  specDigest: Sha256Digest
  /** 实际采用值，必填：费、滑点、成交模型（K 线内顺序）、资金费、强平五项齐全。 */
  assumptions: BacktestAssumptions
  stats: BacktestStats
  equity: { t: Ms; v: number }[]
  trades: BacktestTrade[]
  openPosition: Record<string, unknown> | null
  biasChecks?: { lookahead: BiasCheckResult; recursive: BiasCheckResult; trialCount: number }
  trialCount?: number
  artifacts: { artifactId: string; kind: string }[]
  warnings: string[]
  engine: { id: string; version: string }
  dataDigest: Sha256Digest
  pack?: EvidencePackDraft
  strategySha256?: Sha256Digest
  /** 分析级资金费明细；paid 正数为支出。 */
  funding?: { t: Ms; rate: number; notional: number; paid: number }[]
}

export type BacktestState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled'
export const BACKTEST_STATES: readonly BacktestState[] = ['queued', 'running', 'done', 'failed', 'cancelled']

/** O3：回测假设五项（费、滑点、K 线内顺序、资金费、强平）必须齐全。返回缺失项。 */
export function missingBacktestAssumptions(a: Partial<BacktestAssumptions> | undefined): string[] {
  const missing: string[] = []
  if (!a) return ['fees', 'slippageBps', 'fillModel', 'funding', 'liquidation']
  if (a.fees === undefined) missing.push('fees')
  if (a.slippageBps === undefined) missing.push('slippageBps')
  if (a.fillModel === undefined) missing.push('fillModel')
  if (a.funding === undefined) missing.push('funding')
  if (a.liquidation === undefined) missing.push('liquidation')
  return missing
}
