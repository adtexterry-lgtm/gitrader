// SPDX-License-Identifier: CPAL-1.0
// 价位估计：支撑 / 阻力合成（枢轴 + 摆动区间 + 布林带均值）。
// 口径出处：QuantDinger `backend_api_python/app/services/market/technical_indicators.py:106-152`（Apache-2.0），
//           本包按该文件的定义独立实现；这些是**启发式估计**（QD 自己也标 `kind: heuristic_estimate`），
//           不是价格预测，也不构成交易建议。差异：QD 在样本不足时用若干兜底常量，本包改为抛错；
//           QD 内部 round 到 6 位仅用于展示，本包返回原始浮点，舍入交给调用方。
// 批 9 裁定：`tradingLevels`（建议止损 / 止盈）已按主会话决定删除——它带策略语义，不属于指标库；
//           需要时由策略层基于本包的 `levels` 与 engine-core `atr()` 自行组合。
import type { Bar } from './types'
import { assertFinite, assertPeriod } from './internal'

export interface LevelsOptions {
  /** 布林带与摆动区间的窗口（QD 默认 20）。 */
  period?: number
  /** 布林带标准差倍数（QD 默认 2）。 */
  multiplier?: number
}

export interface LevelsEstimate {
  /** (s1 + swingLow + bbLower) / 3 */
  support: number
  /** (r1 + swingHigh + bbUpper) / 3 */
  resistance: number
  /** 上一根的枢轴价 (prevH + prevL + prevC) / 3 */
  pivot: number
  s1: number
  s2: number
  r1: number
  r2: number
  swingHigh: number
  swingLow: number
  bbUpper: number
  bbLower: number
  /** 方法标识，便于调用方判断这些数是怎么来的。 */
  method: 'pivot_swing_bb_avg'
  /** 恒为 true：这些是估计值，不是观测值。 */
  isEstimate: true
}

/**
 * 支撑 / 阻力合成：把「枢轴 S1/R1」「近 period 根摆动高低点」「布林带上下轨」三者取平均。
 * 至少需要 period + 1 根（枢轴要用上一根），不足时抛 RangeError。
 */
export function levels(bars: Bar[], options: LevelsOptions = {}): LevelsEstimate {
  const period = options.period ?? 20
  const multiplier = options.multiplier ?? 2
  assertPeriod(period)
  assertFinite(multiplier, 'multiplier')
  if (multiplier <= 0) throw new RangeError(`multiplier 必须 > 0，实际为 ${String(multiplier)}`)
  if (bars.length < period + 1) {
    throw new RangeError(`levels 需要至少 period + 1 根 K 线，实际为 ${String(bars.length)} 根`)
  }
  const prev = bars[bars.length - 2]!

  let sumClose = 0
  let swingHigh = -Infinity
  let swingLow = Infinity
  for (let i = bars.length - period; i < bars.length; i++) {
    const bar = bars[i]!
    sumClose += bar.c
    if (bar.h > swingHigh) swingHigh = bar.h
    if (bar.l < swingLow) swingLow = bar.l
  }
  const middle = sumClose / period
  let squares = 0
  for (let i = bars.length - period; i < bars.length; i++) {
    const d = bars[i]!.c - middle
    squares += d * d
  }
  const deviation = Math.sqrt(squares / period)
  const bbUpper = middle + multiplier * deviation
  const bbLower = middle - multiplier * deviation

  const pivot = (prev.h + prev.l + prev.c) / 3
  const r1 = 2 * pivot - prev.l
  const s1 = 2 * pivot - prev.h
  const r2 = pivot + (prev.h - prev.l)
  const s2 = pivot - (prev.h - prev.l)

  return {
    support: (s1 + swingLow + bbLower) / 3,
    resistance: (r1 + swingHigh + bbUpper) / 3,
    pivot,
    s1,
    s2,
    r1,
    r2,
    swingHigh,
    swingLow,
    bbUpper,
    bbLower,
    method: 'pivot_swing_bb_avg',
    isEstimate: true,
  }
}
