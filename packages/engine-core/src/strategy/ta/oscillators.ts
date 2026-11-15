// SPDX-License-Identifier: CPAL-1.0
// 振荡与量能类技术指标：TRIX、终极振荡、动量震荡、PPO、Aroon、DPO、ADX、StochRSI、蔡金振荡、
// 力度指标、简易波动、Mass Index、溃疡指数、Vortex、震荡度、Elder Ray。
// 约定：输出与输入等长，不可算处为 null，第 i 项只用 ≤ i 的数据；参数非法时整条输出为 null，分母为 0 处为 null。

import type { Bar, Series } from './types'
import { ema as emaSeries, sma as smaSeries } from './trend'
import { rsi as rsiSeries } from './momentum'
import { trueRange } from './volatility'
import { adLine } from './volume'

/** 周期参数是否可用：≥ 1 的整数。不可用时调用方返回全 null，不抛错。 */
function isValidPeriod(period: number): boolean {
  return Number.isInteger(period) && period >= 1
}

/** 与输入等长的全 null 序列。 */
function nullSeries(length: number): Series {
  return new Array<number | null>(length).fill(null)
}

/** 取出序列中的非 null 项，交给 fn 计算后按原下标放回。 */
function remap(source: Series, fn: (values: number[]) => Series): Series {
  const indexes: number[] = []
  const values: number[] = []
  for (let i = 0; i < source.length; i += 1) {
    const v = source[i]
    if (v === null || v === undefined) continue
    indexes.push(i)
    values.push(v)
  }
  const mapped = fn(values)
  const out = nullSeries(source.length)
  for (let j = 0; j < indexes.length; j += 1) {
    const v = mapped[j]
    if (v === null || v === undefined) continue
    out[indexes[j]!] = v
  }
  return out
}

/** 序列中非 null 项组成的紧凑数组（保持顺序）。 */
function compact(source: Series): { indexes: number[]; values: number[] } {
  const indexes: number[] = []
  const values: number[] = []
  for (let i = 0; i < source.length; i += 1) {
    const v = source[i]
    if (v === null || v === undefined) continue
    indexes.push(i)
    values.push(v)
  }
  return { indexes, values }
}

/** TRIX：EMA 三次后再取 1 期变化率（×100）。 */
export function trix(values: number[], period = 15): Series {
  const out = nullSeries(values.length)
  if (!isValidPeriod(period)) return out
  const e1 = emaSeries(values, period)
  const e2 = remap(e1, (vs) => emaSeries(vs, period))
  const e3 = remap(e2, (vs) => emaSeries(vs, period))
  for (let i = 1; i < e3.length; i += 1) {
    const cur = e3[i]
    const prev = e3[i - 1]
    if (cur === null || cur === undefined || prev === null || prev === undefined) continue
    if (prev === 0) continue
    out[i] = (cur / prev - 1) * 100
  }
  return out
}

/** 终极振荡指标：按短中长三个窗口的买压 / 真实波幅比值加权。 */
export function ultimateOscillator(
  bars: Bar[],
  options: { short?: number; mid?: number; long?: number } = {},
): Series {
  const { short = 7, mid = 14, long = 28 } = options
  const out = nullSeries(bars.length)
  if (!isValidPeriod(short) || !isValidPeriod(mid) || !isValidPeriod(long)) return out
  const buyingPressure: number[] = new Array<number>(bars.length).fill(0)
  const range: number[] = new Array<number>(bars.length).fill(0)
  for (let i = 1; i < bars.length; i += 1) {
    const bar = bars[i]!
    const prev = bars[i - 1]!
    const lowest = Math.min(bar.l, prev.c)
    buyingPressure[i] = bar.c - lowest
    range[i] = Math.max(bar.h, prev.c) - lowest
  }
  const average = (i: number, n: number): number | null => {
    if (i - n + 1 < 1) return null
    let bpSum = 0
    let trSum = 0
    for (let j = i - n + 1; j <= i; j += 1) {
      bpSum += buyingPressure[j]!
      trSum += range[j]!
    }
    return trSum === 0 ? null : bpSum / trSum
  }
  for (let i = long; i < bars.length; i += 1) {
    const a1 = average(i, short)
    const a2 = average(i, mid)
    const a3 = average(i, long)
    if (a1 === null || a2 === null || a3 === null) continue
    out[i] = (100 * (4 * a1 + 2 * a2 + a3)) / 7
  }
  return out
}

/** 动量震荡（Awesome Oscillator）：中价短均线与长均线之差。 */
export function awesomeOscillator(
  bars: Bar[],
  options: { fast?: number; slow?: number } = {},
): Series {
  const { fast = 5, slow = 34 } = options
  const out = nullSeries(bars.length)
  if (!isValidPeriod(fast) || !isValidPeriod(slow)) return out
  const hl2: number[] = bars.map((bar) => (bar.h + bar.l) / 2)
  const fastSma = smaSeries(hl2, fast)
  const slowSma = smaSeries(hl2, slow)
  for (let i = 0; i < bars.length; i += 1) {
    const a = fastSma[i]
    const b = slowSma[i]
    if (a === null || a === undefined || b === null || b === undefined) continue
    out[i] = a - b
  }
  return out
}

/** 百分比价格振荡：EMA 快慢线差占慢线百分比，signal 为其 EMA（与 MACD 一致）。 */
export function ppo(
  values: number[],
  options: { fast?: number; slow?: number; signal?: number } = {},
): { ppo: Series; signal: Series; hist: Series } {
  const { fast = 12, slow = 26, signal = 9 } = options
  const ppoOut = nullSeries(values.length)
  const empty = nullSeries(values.length)
  if (!isValidPeriod(fast) || !isValidPeriod(slow) || !isValidPeriod(signal)) {
    return { ppo: ppoOut, signal: empty, hist: nullSeries(values.length) }
  }
  const fastEma = emaSeries(values, fast)
  const slowEma = emaSeries(values, slow)
  for (let i = 0; i < values.length; i += 1) {
    const f = fastEma[i]
    const s = slowEma[i]
    if (f === null || f === undefined || s === null || s === undefined) continue
    if (s === 0) continue
    ppoOut[i] = ((f - s) / s) * 100
  }
  const signalOut = remap(ppoOut, (vs) => emaSeries(vs, signal))
  const histOut = nullSeries(values.length)
  for (let i = 0; i < values.length; i += 1) {
    const p = ppoOut[i]
    const s = signalOut[i]
    if (p === null || p === undefined || s === null || s === undefined) continue
    histOut[i] = p - s
  }
  return { ppo: ppoOut, signal: signalOut, hist: histOut }
}

/** Aroon：距最近 period+1 根内最高价 / 最低价根数的百分比，并列时取最近的一根。 */
export function aroon(bars: Bar[], period = 25): { up: Series; down: Series; osc: Series } {
  const up = nullSeries(bars.length)
  const down = nullSeries(bars.length)
  const osc = nullSeries(bars.length)
  if (!isValidPeriod(period)) return { up, down, osc }
  const n = period
  for (let i = n; i < bars.length; i += 1) {
    let highest = -Infinity
    let highestIndex = i
    let lowest = Infinity
    let lowestIndex = i
    for (let j = i; j >= i - n; j -= 1) {
      const bar = bars[j]!
      if (bar.h > highest) {
        highest = bar.h
        highestIndex = j
      }
      if (bar.l < lowest) {
        lowest = bar.l
        lowestIndex = j
      }
    }
    const u = (100 * (n - (i - highestIndex))) / n
    const d = (100 * (n - (i - lowestIndex))) / n
    up[i] = u
    down[i] = d
    osc[i] = u - d
  }
  return { up, down, osc }
}

/** 去趋势价格振荡：n/2+1 根之前的收盘价减去当前 n 期均值（不前移）。 */
export function dpo(values: number[], period = 20): Series {
  const out = nullSeries(values.length)
  if (!isValidPeriod(period)) return out
  const average = smaSeries(values, period)
  const offset = Math.floor(period / 2) + 1
  for (let i = period; i < values.length; i += 1) {
    const base = values[i - offset]
    const mean = average[i]
    if (base === undefined || mean === null || mean === undefined) continue
    out[i] = base - mean
  }
  return out
}

/** 平均趋向指标：Wilder 平滑的方向运动、方向指标与 ADX。 */
export function adx(bars: Bar[], period = 14): { plusDi: Series; minusDi: Series; adx: Series } {
  const plusDi = nullSeries(bars.length)
  const minusDi = nullSeries(bars.length)
  const adxOut = nullSeries(bars.length)
  if (!isValidPeriod(period)) return { plusDi, minusDi, adx: adxOut }
  const n = period
  const length = bars.length
  if (length <= n) return { plusDi, minusDi, adx: adxOut }

  const range = trueRange(bars)
  const plusDm: number[] = new Array<number>(length).fill(0)
  const minusDm: number[] = new Array<number>(length).fill(0)
  for (let i = 1; i < length; i += 1) {
    const bar = bars[i]!
    const prev = bars[i - 1]!
    const upMove = bar.h - prev.h
    const downMove = prev.l - bar.l
    if (upMove > downMove && upMove > 0) plusDm[i] = upMove
    else if (downMove > upMove && downMove > 0) minusDm[i] = downMove
  }

  let trSum = 0
  let plusSum = 0
  let minusSum = 0
  for (let i = 1; i <= n; i += 1) {
    trSum += range[i]!
    plusSum += plusDm[i]!
    minusSum += minusDm[i]!
  }

  const dxValues: number[] = []
  const dxIndexes: number[] = []
  const record = (i: number): void => {
    if (trSum === 0) return
    const p = (100 * plusSum) / trSum
    const m = (100 * minusSum) / trSum
    plusDi[i] = p
    minusDi[i] = m
    const total = p + m
    if (total === 0) return
    dxValues.push((100 * Math.abs(p - m)) / total)
    dxIndexes.push(i)
  }
  record(n)
  for (let i = n + 1; i < length; i += 1) {
    trSum = trSum - trSum / n + range[i]!
    plusSum = plusSum - plusSum / n + plusDm[i]!
    minusSum = minusSum - minusSum / n + minusDm[i]!
    record(i)
  }

  if (dxValues.length < n) return { plusDi, minusDi, adx: adxOut }
  let acc = 0
  for (let j = 0; j < n; j += 1) acc += dxValues[j]!
  let adxValue = acc / n
  adxOut[dxIndexes[n - 1]!] = adxValue
  for (let j = n; j < dxValues.length; j += 1) {
    adxValue = (adxValue * (n - 1) + dxValues[j]!) / n
    adxOut[dxIndexes[j]!] = adxValue
  }
  return { plusDi, minusDi, adx: adxOut }
}

/** 随机相对强弱：RSI 在自身窗口内的位置（0..1），再做 K、D 平滑。 */
export function stochRsi(
  values: number[],
  options: { rsiPeriod?: number; stochPeriod?: number; k?: number; d?: number } = {},
): { k: Series; d: Series } {
  const { rsiPeriod = 14, stochPeriod = 14, k: kPeriod = 3, d: dPeriod = 3 } = options
  if (
    !isValidPeriod(rsiPeriod) ||
    !isValidPeriod(stochPeriod) ||
    !isValidPeriod(kPeriod) ||
    !isValidPeriod(dPeriod)
  ) {
    return { k: nullSeries(values.length), d: nullSeries(values.length) }
  }
  const rsiValues = rsiSeries(values, rsiPeriod)
  const { indexes, values: compactRsi } = compact(rsiValues)
  const raw = nullSeries(values.length)
  for (let j = stochPeriod - 1; j < compactRsi.length; j += 1) {
    let lowest = Infinity
    let highest = -Infinity
    for (let q = j - stochPeriod + 1; q <= j; q += 1) {
      const v = compactRsi[q]!
      if (v < lowest) lowest = v
      if (v > highest) highest = v
    }
    if (highest === lowest) continue
    raw[indexes[j]!] = (compactRsi[j]! - lowest) / (highest - lowest)
  }
  const kOut = remap(raw, (vs) => smaSeries(vs, kPeriod))
  const dOut = remap(kOut, (vs) => smaSeries(vs, dPeriod))
  return { k: kOut, d: dOut }
}

/** 蔡金振荡：累积/派发线快慢 EMA 之差。 */
export function chaikinOscillator(
  bars: Bar[],
  options: { fast?: number; slow?: number } = {},
): Series {
  const { fast = 3, slow = 10 } = options
  const out = nullSeries(bars.length)
  if (!isValidPeriod(fast) || !isValidPeriod(slow)) return out
  const ad = adLine(bars)
  const adValues: number[] = []
  for (let i = 0; i < ad.length; i += 1) {
    const v = ad[i]
    adValues.push(v === null || v === undefined ? 0 : v)
  }
  const fastEma = emaSeries(adValues, fast)
  const slowEma = emaSeries(adValues, slow)
  for (let i = 0; i < bars.length; i += 1) {
    const f = fastEma[i]
    const s = slowEma[i]
    if (f === null || f === undefined || s === null || s === undefined) continue
    out[i] = f - s
  }
  return out
}

/** 力度指标：收盘价变动乘成交量的 EMA。 */
export function forceIndex(bars: Bar[], period = 13): Series {
  const out = nullSeries(bars.length)
  if (!isValidPeriod(period)) return out
  const raw = nullSeries(bars.length)
  for (let i = 1; i < bars.length; i += 1) {
    const bar = bars[i]!
    raw[i] = (bar.c - bars[i - 1]!.c) * bar.v
  }
  return remap(raw, (vs) => emaSeries(vs, period))
}

/** 简易波动：中价位移除以箱体比率，再取 n 期简单平均。 */
export function easeOfMovement(bars: Bar[], period = 14): Series {
  const out = nullSeries(bars.length)
  if (!isValidPeriod(period)) return out
  const raw = nullSeries(bars.length)
  for (let i = 1; i < bars.length; i += 1) {
    const bar = bars[i]!
    const prev = bars[i - 1]!
    const range = bar.h - bar.l
    if (range === 0) continue
    const distance = (bar.h + bar.l) / 2 - (prev.h + prev.l) / 2
    const boxRatio = bar.v / 1e8 / range
    if (boxRatio === 0) continue
    raw[i] = distance / boxRatio
  }
  return remap(raw, (vs) => smaSeries(vs, period))
}

/** Mass Index：高低价差单 EMA 与双 EMA 之比在 n 期内的和。 */
export function massIndex(
  bars: Bar[],
  options: { ema?: number; sum?: number } = {},
): Series {
  const { ema: emaPeriod = 9, sum: sumPeriod = 25 } = options
  const out = nullSeries(bars.length)
  if (!isValidPeriod(emaPeriod) || !isValidPeriod(sumPeriod)) return out
  const spread: number[] = bars.map((bar) => bar.h - bar.l)
  const single = emaSeries(spread, emaPeriod)
  const double = remap(single, (vs) => emaSeries(vs, emaPeriod))
  const ratio = nullSeries(bars.length)
  for (let i = 0; i < bars.length; i += 1) {
    const s = single[i]
    const d = double[i]
    if (s === null || s === undefined || d === null || d === undefined) continue
    if (d === 0) continue
    ratio[i] = s / d
  }
  const { indexes, values } = compact(ratio)
  if (values.length < sumPeriod) return out
  let acc = 0
  for (let j = 0; j < values.length; j += 1) {
    acc += values[j]!
    if (j >= sumPeriod) acc -= values[j - sumPeriod]!
    if (j >= sumPeriod - 1) out[indexes[j]!] = acc
  }
  return out
}

/** 溃疡指数：窗口内相对最高点的回撤百分比平方平均再开方。 */
export function ulcerIndex(values: number[], period = 14): Series {
  const out = nullSeries(values.length)
  if (!isValidPeriod(period)) return out
  for (let i = period - 1; i < values.length; i += 1) {
    let squares = 0
    let peak = -Infinity
    let ok = true
    for (let j = i - period + 1; j <= i; j += 1) {
      const v = values[j]!
      if (v > peak) peak = v
      if (peak === 0) {
        ok = false
        break
      }
      const drawdown = (100 * (v - peak)) / peak
      squares += drawdown * drawdown
    }
    if (!ok) continue
    out[i] = Math.sqrt(squares / period)
  }
  return out
}

/** 涡旋指标：正负方向运动之和占真实波幅之和的比例。 */
export function vortex(bars: Bar[], period = 14): { plus: Series; minus: Series } {
  const plus = nullSeries(bars.length)
  const minus = nullSeries(bars.length)
  if (!isValidPeriod(period)) return { plus, minus }
  const n = period
  const range = trueRange(bars)
  for (let i = n; i < bars.length; i += 1) {
    let plusSum = 0
    let minusSum = 0
    let trSum = 0
    for (let j = i - n + 1; j <= i; j += 1) {
      const bar = bars[j]!
      const prev = bars[j - 1]!
      plusSum += Math.abs(bar.h - prev.l)
      minusSum += Math.abs(bar.l - prev.h)
      trSum += range[j]!
    }
    if (trSum === 0) continue
    plus[i] = plusSum / trSum
    minus[i] = minusSum / trSum
  }
  return { plus, minus }
}

/** 震荡度：真实波幅之和与价格区间之比的常用对数，按周期对数归一化。 */
export function choppiness(bars: Bar[], period = 14): Series {
  const out = nullSeries(bars.length)
  if (!isValidPeriod(period) || period < 2) return out
  const range = trueRange(bars)
  const denominator = Math.log10(period)
  for (let i = period - 1; i < bars.length; i += 1) {
    let trSum = 0
    let highest = -Infinity
    let lowest = Infinity
    for (let j = i - period + 1; j <= i; j += 1) {
      trSum += range[j]!
      const bar = bars[j]!
      if (bar.h > highest) highest = bar.h
      if (bar.l < lowest) lowest = bar.l
    }
    const span = highest - lowest
    if (span === 0 || trSum <= 0) continue
    out[i] = (100 * Math.log10(trSum / span)) / denominator
  }
  return out
}

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/utils/technical_indicators.py:84; adapted.
/** KDJ：n 期 RSV 经 K、D 两重回溯平滑（种子 50），J = 3K − 2D；max = min 时 RSV 取 50。 */
export function kdj(
  bars: Bar[],
  options: { n?: number; k?: number; d?: number } = {},
): { k: Series; d: Series; j: Series } {
  const { n = 9, k: kSmooth = 3, d: dSmooth = 3 } = options
  const kOut = nullSeries(bars.length)
  const dOut = nullSeries(bars.length)
  const jOut = nullSeries(bars.length)
  if (!isValidPeriod(n) || !isValidPeriod(kSmooth) || !isValidPeriod(dSmooth)) {
    return { k: kOut, d: dOut, j: jOut }
  }
  let kPrev = 50
  let dPrev = 50
  for (let i = n - 1; i < bars.length; i += 1) {
    let lowest = Infinity
    let highest = -Infinity
    for (let q = i - n + 1; q <= i; q += 1) {
      const bar = bars[q]!
      if (bar.l < lowest) lowest = bar.l
      if (bar.h > highest) highest = bar.h
    }
    const span = highest - lowest
    // QD 用 replace(0, NaN).fillna(50) 处理区间为 0 的窗口，故 RSV 取 50。
    const rsv = span === 0 ? 50 : ((bars[i]!.c - lowest) / span) * 100
    kPrev = ((kSmooth - 1) * kPrev + rsv) / kSmooth
    dPrev = ((dSmooth - 1) * dPrev + kPrev) / dSmooth
    kOut[i] = kPrev
    dOut[i] = dPrev
    jOut[i] = 3 * kPrev - 2 * dPrev
  }
  return { k: kOut, d: dOut, j: jOut }
}

/** Elder Ray：最高价、最低价相对收盘价 EMA 的偏离。 */
export function elderRay(bars: Bar[], period = 13): { bull: Series; bear: Series } {
  const bull = nullSeries(bars.length)
  const bear = nullSeries(bars.length)
  if (!isValidPeriod(period)) return { bull, bear }
  const average = emaSeries(
    bars.map((bar) => bar.c),
    period,
  )
  for (let i = 0; i < bars.length; i += 1) {
    const mid = average[i]
    if (mid === null || mid === undefined) continue
    bull[i] = bars[i]!.h - mid
    bear[i] = bars[i]!.l - mid
  }
  return { bull, bear }
}
