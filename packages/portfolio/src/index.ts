// SPDX-License-Identifier: CPAL-1.0
// @gitrader/portfolio 入口：组合分析纯函数（跨场所汇总 / 注入定价 / 敞口 / 盈亏归因 / 集中度）。
// 记账一律十进制字符串（协议 Decimal，18 位定点内部算，8 位对外）；不碰浮点。
export { valuePositions, fxRate, resolveStrategy } from './valuation'
export { exposureOf, exposureByAsset, exposureByVenue, exposureByInstrument, exposureByDirection, exposureTotals } from './exposure'
export type { ExposureBucket, ExposureDirection, ExposureReport } from './exposure'
export { attributionOf, attributionByStrategy, attributionByVenue, attributionByInstrument, attributionTotals } from './attribution'
export type { AttributionReport, PnlBucket } from './attribution'
export { concentration, concentrationOf } from './concentration'
export type { ConcentrationAll, ConcentrationBucket, ConcentrationDimension, ConcentrationReport } from './concentration'
export { analyzePortfolio } from './analysis'
export type { PortfolioAnalysis } from './analysis'
export { staticPriceSource, PortfolioError } from './types'
export type {
  FxTable,
  MissingPriceMode,
  PortfolioErrorCode,
  PortfolioInput,
  PriceSource,
  ValuedPosition,
  ValuationResult,
} from './types'
export { LEDGER_DP, share } from './decimal'
