// SPDX-License-Identifier: CPAL-1.0
// 执行对账纯函数包：输入本地视图 + 场所视图，输出差异分类与处理建议。
//
// 红线：本包没有任何写入口。它不改账本、不下单、不撤单、不发请求，
// 只产出 Finding（差异 + 建议动作 + 证据）。改账由内核按人定的规则执行。
export * from './types'
export { ADVICE, SEVERITY, adviceFor, severityFor } from './advice'
export {
  addDecimal, absDecimal, commonScaled, compareDecimal, decimalAtScale, equalDecimal, isDecimalString, isZeroDecimal, maxDecimal,
  minDecimal, negateDecimal, normalizeDecimal, parseDecimal, signDecimal, subtractDecimal, sumDecimal, withinTolerance,
} from './decimal'
export { buildLinkIndex, linkIsUnreliable, venueIdsOf } from './links'
export type { LinkIndex } from './links'
export { classifyOrders } from './orders'
export type { OrderClassificationResult, OrderCoverage } from './orders'
export {
  classifyFills, dedupeFills, describeGap, fillKeyFor, inferredFillsForOrder, inferredSizeByInstrument, localFilledSum,
  venueFilledSizeOf,
} from './fills'
export type { FillClassificationResult, FillCoverage } from './fills'
export { classifyPositions } from './positions'
export type { InferredNet } from './positions'
export { evidenceOf, findingsByCode, reconcile, validateInput } from './reconcile'
export { renderReport } from './render'
export type { RenderOptions } from './render'
export { classifyVenueStatus, isVenueStatusLive, isVenueStatusTerminal } from './status'
export type { VenueStatusClass } from './status'
export {
  DEFAULT_CLOCK_SKEW_MS, DEFAULT_FILL_LOOKBACK_MS, DEFAULT_PRICE_TOLERANCE_BPS, DEFAULT_STALE_AFTER_MS,
  DEFAULT_VENUE_LATENCY_MS, describeDelta, driftBps, inFlightWindowMs, isBeforeLookback, isBeyondClockSkew, isEarlierBeyondSkew,
  isStale, isWithinLatency, msDistance, priceDriftBeyondBps, resolveOptions, sizeEqual,
} from './tolerance'
export type { ResolvedOptions } from './tolerance'
