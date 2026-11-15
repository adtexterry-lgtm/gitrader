// SPDX-License-Identifier: CPAL-1.0
// 波动与量能补充：归一化真实波幅 NATR、蔡金买卖量振荡 ADOSC。
// NATR 公式同 TA-Lib `ta_NATR.c`（= 100 × ATR ÷ close = 100 × atrPercent）；
// ATR 采用 engine-core / QD 口径：第 0 根 TR = h−l，首批 period 根取简单平均，首值在下标 period−1。
// 与 TA-Lib 的差异：`ta_NATR.c` 的 TR 从第 1 根算、首值在下标 period；本夹具 period 3 时 TA-Lib 的
//       natr[3] = 100·3/102 = 2.941176…，本包 natr[3] = 2.723311…。
// ADOSC 口径：TA-Lib `ta_ADOSC.c`（两条 EMA 都以上一根之前的第一个 A/D 值为种子，
//       输出 = EMA(A/D, fast) − EMA(A/D, slow)，与本包 `adOsc` 同序）。
import type { Bar, Series } from './types'
import { assertPeriod, nullSeries } from './internal'

function trueRanges(bars: Bar[]): number[] {
  const out: number[] = []
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i]!
    if (i === 0) {
      out.push(bar.h - bar.l)
      continue
    }
    const prev = bars[i - 1]!
    out.push(Math.max(bar.h - bar.l, Math.abs(bar.h - prev.c), Math.abs(bar.l - prev.c)))
  }
  return out
}

/** 归一化真实波幅：100 × ATR ÷ close（单位：百分比，例如 2.5 表示 2.5%）；close 为 0 处为 null。 */
export function natr(bars: Bar[], period = 14): Series {
  assertPeriod(period)
  const out = nullSeries(bars.length)
  if (bars.length < period) return out
  const ranges = trueRanges(bars)
  let seed = 0
  for (let i = 0; i < period; i++) seed += ranges[i]!
  let value = seed / period
  const close0 = bars[period - 1]!.c
  out[period - 1] = close0 === 0 ? null : (100 * value) / close0
  for (let i = period; i < bars.length; i++) {
    value = (value * (period - 1) + ranges[i]!) / period
    const close = bars[i]!.c
    out[i] = close === 0 ? null : (100 * value) / close
  }
  return out
}

/** 累积买卖量线 A/D（区间为 0 的 bar 不计入，与 TA-Lib 同）。 */
function adLine(bars: Bar[]): number[] {
  const out: number[] = []
  let cumulative = 0
  for (const bar of bars) {
    const range = bar.h - bar.l
    if (range !== 0) cumulative += (bar.v * (2 * bar.c - bar.h - bar.l)) / range
    out.push(cumulative)
  }
  return out
}

/**
 * 蔡金振荡：EMA(A/D, fastPeriod) − EMA(A/D, slowPeriod)，两条 EMA 都以第一个 A/D 值为种子、k = 2/(n+1)。
 * 首个非 null 位置为 max(fastPeriod, slowPeriod) − 1（与 TA-Lib lookback 一致）。
 */
export function adOsc(bars: Bar[], fastPeriod = 3, slowPeriod = 10): Series {
  assertPeriod(fastPeriod, 'fastPeriod')
  assertPeriod(slowPeriod, 'slowPeriod')
  const out = nullSeries(bars.length)
  if (bars.length === 0) return out
  const ad = adLine(bars)
  const fastK = 2 / (fastPeriod + 1)
  const slowK = 2 / (slowPeriod + 1)
  let fast = ad[0]!
  let slow = ad[0]!
  const start = Math.max(fastPeriod, slowPeriod) - 1
  for (let i = 1; i < ad.length; i++) {
    fast = ad[i]! * fastK + fast * (1 - fastK)
    slow = ad[i]! * slowK + slow * (1 - slowK)
    if (i >= start) out[i] = fast - slow
  }
  if (start === 0 && ad.length > 0) out[0] = 0
  return out
}
