// SPDX-License-Identifier: CPAL-1.0
// 振荡类补充：Aroon 振荡器 AROONOSC（转发 engine-core）、快速随机指标 STOCHF（本包实现，与 engine-core 口径不同）。
// 口径出处：TA-Lib `ta_AROONOSC.c`（= AroonUp − AroonDown，窗口 period+1 根）、
//           `ta_STOCHF.c`（Fast-K = 100 × (close − LL) ÷ (HH − LL)，Fast-D = Fast-K 的简单平均）。
// 与 engine-core 的关系（批 9 收尾）：
//   - `aroonOsc` 与 engine-core `aroon().osc` 同口径同值（窗口 period+1 根、并列取最近一根），改为直接转发，
//     同值性由 test/engine-core-parity.test.ts 逐项比对；转发不继承它「非法周期返回全 null」的宽口径，仍先 assertPeriod。
//   - `stochF` 与 engine-core `stochastic()` **口径不同**，不转发也不删除，差异见 README「与 engine-core 的差异」：
//     区间为 0（HH = LL）时本包 K = 0（照 `ta_STOCHF.c`），engine-core 给 50；默认 kPeriod 本包 5、engine-core 14。
import { aroon } from '../../engine-core/src/strategy/ta/oscillators'
import type { Bar, Series } from './types'
import { assertPeriod, nullSeries, smaSeries } from './internal'

/**
 * Aroon 振荡：100 × (period − 距最高价根数)/period − 100 × (period − 距最低价根数)/period，范围 −100..100。
 * 首个非 null 位置为 period（窗口 period+1 根）。转发 engine-core `aroon().osc`（同口径同值）。
 */
export function aroonOsc(bars: Bar[], period = 25): Series {
  assertPeriod(period)
  return aroon(bars, period).osc
}

/**
 * 快速随机指标：K = 100 × (close − 窗口最低价) ÷ (窗口最高价 − 窗口最低价)，区间为 0 时 K = 0；
 * D = K 的 dPeriod 简单平均（对 K 的非 null 稠密段做 SMA 再对齐回时间轴）。
 */
export function stochF(bars: Bar[], kPeriod = 5, dPeriod = 3): { k: Series; d: Series } {
  assertPeriod(kPeriod)
  assertPeriod(dPeriod)
  const k = nullSeries(bars.length)
  for (let i = kPeriod - 1; i < bars.length; i++) {
    let highest = bars[i - kPeriod + 1]!.h
    let lowest = bars[i - kPeriod + 1]!.l
    for (let j = i - kPeriod + 2; j <= i; j++) {
      const bar = bars[j]!
      if (bar.h > highest) highest = bar.h
      if (bar.l < lowest) lowest = bar.l
    }
    const range = highest - lowest
    k[i] = range === 0 ? 0 : (100 * (bars[i]!.c - lowest)) / range
  }
  const dense: number[] = []
  for (const value of k) if (value !== null) dense.push(value)
  const smoothed = smaSeries(dense, dPeriod)
  const d = nullSeries(bars.length)
  const offset = kPeriod - 1
  for (let j = 0; j < smoothed.length; j++) {
    const value = smoothed[j]
    if (value === null || value === undefined) continue
    d[offset + j] = value
  }
  return { k, d }
}
