// SPDX-License-Identifier: CPAL-1.0
// 一次调用出齐「资金与资产」页需要的四块：估值、敞口、归因、集中度。
// 纯函数：同一输入永远同一输出，不读时钟、不读环境变量、不发网络请求。
import type { PortfolioInput, ValuationResult } from './types'
import type { ExposureReport } from './exposure'
import type { AttributionReport } from './attribution'
import type { ConcentrationAll } from './concentration'
import { valuePositions } from './valuation'
import { exposureOf } from './exposure'
import { attributionOf } from './attribution'
import { concentrationOf } from './concentration'

export interface PortfolioAnalysis {
  readonly valuation: ValuationResult
  readonly exposure: ExposureReport
  readonly attribution: AttributionReport
  readonly concentration: ConcentrationAll
}

/** 组合分析总入口：先估值（唯一的错误出口），再在估值结果上算三张报表。 */
export function analyzePortfolio(input: PortfolioInput): PortfolioAnalysis {
  const valuation = valuePositions(input)
  const positions = valuation.positions
  return {
    valuation,
    exposure: exposureOf(positions),
    attribution: attributionOf(positions),
    concentration: concentrationOf(positions),
  }
}
