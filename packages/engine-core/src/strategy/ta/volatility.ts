// SPDX-License-Identifier: CPAL-1.0
// 波动类技术指标：真实波幅 / ATR / 滚动标准差 / 布林带 / 肯特纳通道 / 唐奇安通道 / 对数收益 / 年化波动率。
// 约定：输出与输入等长，不可算处为 null，第 i 项只用 ≤ i 的数据。

import type { Bar, Series } from './types'

/** 周期参数校验：必须是 ≥ 1 的整数，否则抛 RangeError。 */
function assertPeriod(period: number, name: string): void {
  if (!Number.isInteger(period) || period < 1) {
    throw new RangeError(`${name} 必须是 ≥ 1 的整数，实际为 ${String(period)}`)
  }
}

/** 输入先拷成 Float64Array 再算：热循环只见一种元素类型，不受调用方传来的是 Smi 数组还是双精度数组影响（别的调用先喂过全零 / 整数数组，也不会拖慢后面的长序列）。 */
function toF64(values: number[]): Float64Array {
  const x = new Float64Array(values.length)
  for (let i = 0; i < x.length; i++) x[i] = values[i]!
  return x
}

/** Float64Array（NaN = 不可算）→ Series（null = 不可算）。内部先用 Float64Array 算，避免中间序列里逐项装箱。 */
function toSeries(a: Float64Array): Series {
  const out: Series = new Array<number | null>(a.length).fill(null)
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!
    if (x === x) out[i] = x
  }
  return out
}

/** 简单移动平均（NaN = 不可算）：前 period-1 项不可算。窗口内出现非有限值时该位置不可算（不进滚动和，离开窗口后恢复）。 */
function smaRaw(values: Float64Array, period: number): Float64Array {
  assertPeriod(period, 'period')
  const out = new Float64Array(values.length).fill(NaN)
  if (values.length < period) return out
  let sum = 0
  let bad = 0 // 窗口内非有限值个数（GQ-26：不进滚动和，离开窗口后均线恢复）
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!
    if (Number.isFinite(v)) sum += v
    else bad += 1
    if (i >= period) {
      const old = values[i - period]!
      if (Number.isFinite(old)) sum -= old
      else bad -= 1
    }
    if (i >= period - 1 && bad === 0) out[i] = sum / period
  }
  return out
}

/** 指数移动平均：种子为前 period 项的简单平均，k = 2 / (period + 1)。前 period-1 项为 null。 */
function ema(values: number[], period: number): Series {
  assertPeriod(period, 'emaPeriod')
  const out: Series = new Array<number | null>(values.length).fill(null)
  if (values.length < period) return out
  let seed = 0
  for (let i = 0; i < period; i++) seed += values[i]!
  let e = seed / period
  out[period - 1] = e
  const k = 2 / (period + 1)
  for (let i = period; i < values.length; i++) {
    e = values[i]! * k + e * (1 - k)
    out[i] = e
  }
  return out
}

/** 真实波幅：第 0 项 h - l，之后 max(h - l, |h - prevC|, |l - prevC|)。 */
export function trueRange(bars: Bar[]): Series {
  const out: Series = new Array<number | null>(bars.length).fill(null)
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i]!
    if (i === 0) {
      out[i] = bar.h - bar.l
      continue
    }
    const prev = bars[i - 1]!
    out[i] = Math.max(bar.h - bar.l, Math.abs(bar.h - prev.c), Math.abs(bar.l - prev.c))
  }
  return out
}

/** Wilder ATR：第 period-1 项为前 period 个 TR 的简单平均，之后递推；前 period-1 项为 null。 */
export function atr(bars: Bar[], period = 14): Series {
  assertPeriod(period, 'period')
  const out: Series = new Array<number | null>(bars.length).fill(null)
  if (bars.length < period) return out
  const tr = trueRange(bars)
  let seed = 0
  for (let i = 0; i < period; i++) seed += tr[i]!
  let value = seed / period
  out[period - 1] = value
  for (let i = period; i < bars.length; i++) {
    value = (value * (period - 1) + tr[i]!) / period
    out[i] = value
  }
  return out
}

/**
 * 滚动标准差（窗口含当前项，ddof 可调）；前 period-1 项为 null。
 * 逐窗口精确两遍法（与朴素实现逐位相同，tests 里有「逐位相同」的钉子）。R1-PERF-09：不再为每个窗口多扫一遍做有限性检查和缩放——
 * 整条序列只预扫一遍；全部有限且量级正常（最大绝对值 ≤ SAFE_MAX，非零值 ≥ SAFE_MIN）时直接走两遍快路径，
 * 否则逐窗口走 windowStd（窗口含 NaN / ±Infinity → null，不传染到后面的窗口；量级异常的窗口按 2 的幂缩放，GQ-26）。
 */
export function rollingStd(values: number[], period: number, ddof = 0): Series {
  return toSeries(rollingStdRaw(toF64(values), period, ddof))
}

/** rollingStd 的内部形态：Float64Array，NaN = 不可算。 */
function rollingStdRaw(values: Float64Array, period: number, ddof: number): Float64Array {
  assertPeriod(period, 'period')
  if (period <= ddof) {
    throw new RangeError(`period 必须大于 ddof，实际为 period=${String(period)} ddof=${String(ddof)}`)
  }
  const n = values.length
  const out = new Float64Array(n).fill(NaN)
  if (n < period) return out
  const div = period - ddof
  let safe = true
  for (let i = 0; i < n; i++) {
    const v = values[i]!
    const a = v < 0 ? -v : v
    if (!(a <= SAFE_MAX && (a >= SAFE_MIN || a === 0))) { safe = false; break } // NaN / ±Infinity 也落在这里
  }
  if (!safe) {
    for (let i = period - 1; i < n; i++) out[i] = windowStd(values, i - period + 1, i, period, ddof)
    return out
  }
  for (let i = period - 1; i < n; i++) {
    const start = i - period + 1
    let sum = 0
    for (let j = start; j <= i; j++) sum += values[j]!
    const mean = sum / period
    let squares = 0
    for (let j = start; j <= i; j++) {
      const d = values[j]! - mean
      squares += d * d
    }
    out[i] = Math.sqrt(squares / div)
  }
  return out
}

/** 预扫「安全」的量级区间：平方与求和不会上溢，也不会掉进非正规数。 */
const SAFE_MAX = 1e140
const SAFE_MIN = 1e-100

/** 单个窗口 [start, end] 的标准差（NaN = 不可算）：窗口含 NaN / ±Infinity → NaN；否则按 2 的幂缩放后两遍法（GQ-26：1e300 量级的平方不上溢、1e-300 量级不下溢）。 */
function windowStd(values: Float64Array, start: number, end: number, period: number, ddof: number): number {
  let max = 0
  for (let j = start; j <= end; j++) {
    const v = values[j]!
    if (!Number.isFinite(v)) return NaN
    const a = Math.abs(v)
    if (a > max) max = a
  }
  if (max === 0) return 0
  // 除以 2 的幂是精确运算，正常量级下与不缩放逐位相同
  const scale = 2 ** Math.floor(Math.log2(max))
  let sum = 0
  for (let j = start; j <= end; j++) sum += values[j]! / scale
  const mean = sum / period
  let squares = 0
  for (let j = start; j <= end; j++) {
    const d = values[j]! / scale - mean
    squares += d * d
  }
  return Math.sqrt(squares / (period - ddof)) * scale
}

/** 布林带：middle 为 sma，上下轨为 middle ± k·滚动总体标准差。 */
export function bollinger(
  values: number[],
  period = 20,
  k = 2,
): { middle: Series; upper: Series; lower: Series; bandwidth: Series; percentB: Series } {
  const x = toF64(values)
  const mids = smaRaw(x, period)
  const stds = rollingStdRaw(x, period, 0)
  const n = values.length
  const middle: Series = new Array<number | null>(n).fill(null)
  const upper: Series = new Array<number | null>(n).fill(null)
  const lower: Series = new Array<number | null>(n).fill(null)
  const bandwidth: Series = new Array<number | null>(n).fill(null)
  const percentB: Series = new Array<number | null>(n).fill(null)
  for (let i = 0; i < n; i++) {
    const mid = mids[i]!
    if (mid !== mid) continue
    middle[i] = mid
    const sd = stds[i]!
    if (sd !== sd) continue
    const up = mid + k * sd
    const lo = mid - k * sd
    if (up - up !== 0 || lo - lo !== 0) continue // 极端量级下 mid ± k·sd 自己也可能溢出，留 null
    upper[i] = up
    lower[i] = lo
    if (mid !== 0) {
      const bw = (up - lo) / mid
      if (bw - bw === 0) bandwidth[i] = bw
    }
    const span = up - lo
    if (span !== 0) {
      const pb = (x[i]! - lo) / span
      if (pb - pb === 0) percentB[i] = pb
    }
  }
  return { middle, upper, lower, bandwidth, percentB }
}

/** 肯特纳通道：middle 为收盘价 ema，上下轨为 middle ± k·atr。 */
export function keltner(
  bars: Bar[],
  emaPeriod = 20,
  atrPeriod = 10,
  k = 2,
): { middle: Series; upper: Series; lower: Series } {
  const middle = ema(
    bars.map((bar) => bar.c),
    emaPeriod,
  )
  const width = atr(bars, atrPeriod)
  const n = bars.length
  const upper: Series = new Array<number | null>(n).fill(null)
  const lower: Series = new Array<number | null>(n).fill(null)
  for (let i = 0; i < n; i++) {
    const mid = middle[i]
    const w = width[i]
    if (mid === null || mid === undefined || w === null || w === undefined) continue
    upper[i] = mid + k * w
    lower[i] = mid - k * w
  }
  return { middle, upper, lower }
}

/** 唐奇安通道：含当前 bar 的最近 period 根的最高 h / 最低 l，middle 为两者平均。 */
export function donchian(bars: Bar[], period = 20): { upper: Series; lower: Series; middle: Series } {
  assertPeriod(period, 'period')
  const n = bars.length
  const upper: Series = new Array<number | null>(n).fill(null)
  const lower: Series = new Array<number | null>(n).fill(null)
  const middle: Series = new Array<number | null>(n).fill(null)
  for (let i = period - 1; i < n; i++) {
    let hi = -Infinity
    let lo = Infinity
    for (let j = i - period + 1; j <= i; j++) {
      const bar = bars[j]!
      if (bar.h > hi) hi = bar.h
      if (bar.l < lo) lo = bar.l
    }
    upper[i] = hi
    lower[i] = lo
    middle[i] = (hi + lo) / 2
  }
  return { upper, lower, middle }
}

/** 对数收益 ln(v[i] / v[i-1])：第 0 项 null，任一端值 ≤ 0 时该项为 null。 */
export function logReturns(values: number[]): Series {
  const out: Series = new Array<number | null>(values.length).fill(null)
  for (let i = 1; i < values.length; i++) {
    const cur = values[i]!
    const prev = values[i - 1]!
    if (!(cur > 0) || !(prev > 0)) continue
    out[i] = Math.log(cur / prev)
  }
  return out
}

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/factors/registry.py:1060; adapted.
/** Parkinson 年化波动：sqrt(Σ ln(h/l)² / (4·n·ln2)) · sqrt(periodsPerYear)；周期非法或窗口内价格非正时该位置为 null。 */
export function parkinsonVol(bars: Bar[], period: number, periodsPerYear = 365): Series {
  const out: Series = new Array<number | null>(bars.length).fill(null)
  if (!Number.isInteger(period) || period < 1) return out
  const denominator = 4 * period * Math.LN2
  const scale = Math.sqrt(periodsPerYear)
  for (let i = period - 1; i < bars.length; i++) {
    let sum = 0
    let ok = true
    for (let j = i - period + 1; j <= i; j++) {
      const bar = bars[j]!
      if (!(bar.h > 0) || !(bar.l > 0)) {
        ok = false
        break
      }
      const ratio = Math.log(bar.h / bar.l)
      sum += ratio * ratio
    }
    if (!ok) continue
    out[i] = Math.sqrt(sum / denominator) * scale
  }
  return out
}

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/factors/registry.py:1068; adapted.
/** Garman-Klass 年化波动：窗口均值 ½ln(h/l)² − (2ln2−1)ln(c/o)² 开方后乘 sqrt(periodsPerYear)；均值为负时 null。 */
export function garmanKlassVol(bars: Bar[], period: number, periodsPerYear = 365): Series {
  const out: Series = new Array<number | null>(bars.length).fill(null)
  if (!Number.isInteger(period) || period < 1) return out
  const coefficient = 2 * Math.LN2 - 1
  const scale = Math.sqrt(periodsPerYear)
  for (let i = period - 1; i < bars.length; i++) {
    let sum = 0
    let ok = true
    for (let j = i - period + 1; j <= i; j++) {
      const bar = bars[j]!
      if (!(bar.h > 0) || !(bar.l > 0) || !(bar.o > 0) || !(bar.c > 0)) {
        ok = false
        break
      }
      const range = Math.log(bar.h / bar.l)
      const gap = Math.log(bar.c / bar.o)
      sum += 0.5 * range * range - coefficient * gap * gap
    }
    if (!ok) continue
    const variance = sum / period
    if (variance < 0) continue
    out[i] = Math.sqrt(variance) * scale
  }
  return out
}

/** 年化波动率：对数收益非 null 子序列的 rollingStd(period, ddof 1) 乘 sqrt(periodsPerYear)，按原位置放回。 */
export function annualizedVol(values: number[], period: number, periodsPerYear: number): Series {
  const out: Series = new Array<number | null>(values.length).fill(null)
  const returns = logReturns(values)
  const positions: number[] = []
  const compact: number[] = []
  for (let i = 0; i < values.length; i++) {
    const r = returns[i]
    if (r === null || r === undefined) continue
    positions.push(i)
    compact.push(r)
  }
  const std = rollingStd(compact, period, 1)
  const scale = Math.sqrt(periodsPerYear)
  for (let j = 0; j < compact.length; j++) {
    const s = std[j]
    if (s === null || s === undefined) continue
    out[positions[j]!] = s * scale
  }
  return out
}
