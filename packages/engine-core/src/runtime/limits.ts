// SPDX-License-Identifier: CPAL-1.0
// 各周期回测窗口上限：移植 QD 的按天窗口表（根数上限 = 天数 × 86_400_000 / 周期毫秒）；单页 history 上限（5000 根）与窗口脱钩，长窗口靠 HostApi.history 翻页。
import { CANDLE_INTERVALS, type CandleInterval } from '../proto'

export interface WindowLimit {
  interval: CandleInterval
  maxBars: number
  maxSpanMs: number
}

const MS_PER_DAY = 86_400_000

/** 各周期毫秒数；协议里 1M 是自然月，这里按 30 天计（书面约定，见 WINDOW_LIMITS 注释）。 */
const INTERVAL_MS: Record<CandleInterval, number> = {
  '1m': 60_000,
  '3m': 180_000,
  '5m': 300_000,
  '15m': 900_000,
  '30m': 1_800_000,
  '1h': 3_600_000,
  '2h': 7_200_000,
  '4h': 14_400_000,
  '8h': 28_800_000,
  '12h': 43_200_000,
  '1d': 86_400_000,
  '3d': 259_200_000,
  '1w': 604_800_000,
  '1M': 30 * MS_PER_DAY,
}

/**
 * QD v5.6.5 `_DEFAULT_LIMITS` 原值（天）：1m 30、3m 30、5m 180、15m 365、30m 365、
 * 1H 1095、4H 1095、1D 1095、1W 1095。协议多出的 2h / 8h / 12h / 3d / 1M 取相邻 QD 周期窗口：
 * 2h←1H、8h←4H、12h←1D、3d←1D、1M←1W（均 1095 天）。
 *
 * Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/backtest_limits.py:34; adapted.
 * maxBars = floor(天数 × 86_400_000 / 周期毫秒)，maxSpanMs = maxBars × 周期毫秒（R1-PERF-04：不再按单页 5000 根封顶）。
 */
const QD_MAX_DAYS: Record<CandleInterval, number> = {
  '1m': 30,
  '3m': 30,
  '5m': 180,
  '15m': 365,
  '30m': 365,
  '1h': 1_095,
  '2h': 1_095,
  '4h': 1_095,
  '8h': 1_095,
  '12h': 1_095,
  '1d': 1_095,
  '3d': 1_095,
  '1w': 1_095,
  '1M': 1_095,
}

export const WINDOW_LIMITS: readonly WindowLimit[] = CANDLE_INTERVALS.map((interval) => {
  const intervalMs = INTERVAL_MS[interval]
  const qdDays = QD_MAX_DAYS[interval]
  const maxBars = Math.floor((qdDays * MS_PER_DAY) / intervalMs)
  return { interval, maxBars, maxSpanMs: maxBars * intervalMs }
})

export function windowLimitFor(interval: string): WindowLimit | undefined {
  return WINDOW_LIMITS.find((limit) => limit.interval === interval)
}

/** 校验回测窗口：bars = (to − from)/intervalMs；超 maxBars 或超 maxSpanMs → ok false。 */
export function checkBacktestWindow(interval: string, from: number, to: number): { ok: boolean; bars?: number; reason?: string } {
  const limit = windowLimitFor(interval)
  if (!limit) return { ok: false, reason: `unknown interval: ${interval}` }
  if (!Number.isFinite(from) || !Number.isFinite(to)) return { ok: false, reason: 'from/to must be finite numbers' }
  if (to <= from) return { ok: false, reason: `to must be later than from (from=${from}, to=${to})` }
  const spanMs = to - from
  const bars = Math.floor(spanMs / INTERVAL_MS[limit.interval])
  if (bars > limit.maxBars) return { ok: false, bars, reason: `bars ${bars} exceeds maxBars ${limit.maxBars} for interval ${limit.interval}` }
  if (spanMs > limit.maxSpanMs) return { ok: false, bars, reason: `span ${spanMs}ms exceeds maxSpanMs ${limit.maxSpanMs} for interval ${limit.interval}` }
  return { ok: true, bars }
}
