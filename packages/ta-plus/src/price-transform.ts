// SPDX-License-Identifier: CPAL-1.0
// 价格变换类：TA-Lib 的 AVGPRICE / MEDPRICE / TYPPRICE / WCLPRICE（lookback 0，无预热期）。
// 口径出处：TA-Lib `include/ta_func.h` 中 TA_AVGPRICE / TA_MEDPRICE / TA_TYPPRICE / TA_WCLPRICE 定义；
//           与本包 `bop` 一样是逐 bar 变换，不做窗口、不产生 null。
import type { Bar, Series } from './types'
import { nullSeries } from './internal'

/** 均价：(open + high + low + close) / 4，逐 bar 输出。 */
export function avgPrice(bars: Bar[]): Series {
  const out = nullSeries(bars.length)
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i]!
    out[i] = (bar.o + bar.h + bar.l + bar.c) / 4
  }
  return out
}

/** 中价：(high + low) / 2，逐 bar 输出。 */
export function medPrice(bars: Bar[]): Series {
  const out = nullSeries(bars.length)
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i]!
    out[i] = (bar.h + bar.l) / 2
  }
  return out
}

/** 典型价：(high + low + close) / 3，逐 bar 输出。 */
export function typPrice(bars: Bar[]): Series {
  const out = nullSeries(bars.length)
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i]!
    out[i] = (bar.h + bar.l + bar.c) / 3
  }
  return out
}

/** 加权收盘价：(high + low + 2 × close) / 4，逐 bar 输出。 */
export function wclPrice(bars: Bar[]): Series {
  const out = nullSeries(bars.length)
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i]!
    out[i] = (bar.h + bar.l + 2 * bar.c) / 4
  }
  return out
}

