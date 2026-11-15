// SPDX-License-Identifier: CPAL-1.0
// 流动性 / 相对位置：量比（相对前 N 根均量）与价格在近 N 根区间中的位置。
// 口径出处：QuantDinger app/services/market/technical_indicators.py:157-163（volume_ratio 明确用「前 20 根」做基线、
// 不含当根，注释说明了含当根会系统性压低比值）与同一文件的 price_position（165-168 行，0..100）。

import type { Bar, Series } from './types'
import { assertPeriod, nullSeries } from './internal'

/**
 * 量比：volume[i] / mean(volume[i−period .. i−1])，基线【不含当根】。
 * QD 的 factors/registry.py _volume_ratio 把当根算进均值（口径不同，见 README「口径差异」），
 * 本包采用 market/technical_indicators.py 的「前 period 根」口径。基线为 0 处为 null。
 */
export function volumeRatio(volumes: number[], period = 20): Series {
  assertPeriod(period)
  const out = nullSeries(volumes.length)
  for (let i = period; i < volumes.length; i++) {
    let sum = 0
    for (let j = i - period; j < i; j++) sum += volumes[j]!
    const average = sum / period
    out[i] = average === 0 ? null : volumes[i]! / average
  }
  return out
}

/**
 * 价格位置：窗口最高价 / 最低价之间的百分比位置，(close − low) / (high − low) × 100。
 * 区间高度为 0 时输出 50（中性）。QD 的 price_position 只在最后一窗给出，这里逐 bar 输出。
 */
export function pricePosition(bars: Bar[], period = 20): Series {
  assertPeriod(period)
  const out = nullSeries(bars.length)
  for (let i = period - 1; i < bars.length; i++) {
    let high = -Infinity
    let low = Infinity
    for (let j = i - period + 1; j <= i; j++) {
      const bar = bars[j]!
      if (bar.h > high) high = bar.h
      if (bar.l < low) low = bar.l
    }
    if (high === low) { out[i] = 50; continue }
    out[i] = ((bars[i]!.c - low) / (high - low)) * 100
  }
  return out
}
