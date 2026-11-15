// SPDX-License-Identifier: CPAL-1.0
// factor-report.mjs 的类型声明：让 TypeScript（packages/cli 的研究作业）import 这份无构建的 .mjs 时有类型。
export interface FactorRolling {
  n: number
  mean: number
  std: number
  ir: number | null
  tStat: number | null
  positiveShare: number
  tMethod?: 'newey-west'
  tLags?: number
  nEff?: number | null
}
export interface FactorRow {
  name: string
  factorId: string
  label: string
  period: number
  ic: number | null
  rolling: FactorRolling
  spread: number | null
  monotonicity: number | null
  low: number | null
  high: number | null
}
export interface FactorReport {
  title: string
  bars: number
  horizon: number
  window: number
  quantiles: number
  top: number
  catalogSize: number
  withIc: number
  tMethod: 'newey-west'
  tLags: number
  /** 完整因子序列，按 |IC| 降序（IC 为 null 的排后面）。 */
  all: FactorRow[]
  /** 前 top 条。 */
  factors: FactorRow[]
  best: FactorRow | null
  warnings: string[]
}
export function buildFactorReport(input: {
  candles: readonly { t: number; o: number; h: number; l: number; c: number; v: number }[]
  horizon?: number
  window?: number
  quantiles?: number
  top?: number
  title?: string
}): FactorReport
