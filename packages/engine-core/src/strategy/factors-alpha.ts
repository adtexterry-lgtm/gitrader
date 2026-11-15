// SPDX-License-Identifier: CPAL-1.0
// Alpha158-style factors (Qlib, MIT; expressions re-implemented, not copied) — adapted for single-instrument causal series.
// 逐 K 线计算，输出与输入等长；预热期与不可算处为 null；第 i 项只用 <= i 的数据。
import { mean, quantile, stdev } from '@gitrader/stats'
import { rankPct } from './ta'
import type { Candle } from '../types'
import type { FactorDef } from './factors'

type Series = Array<number | null>
type BarField = 'c' | 'h' | 'l' | 'v'

const DEFAULT_WINDOW = 10

/** 空序列（全 null），长度与输入一致。 */
function emptySeries(length: number): Series {
  return new Array<number | null>(length).fill(null)
}

/** 非有限数转 null。 */
function finiteOrNull(value: number): number | null {
  return Number.isFinite(value) ? value : null
}

/**
 * 安全除法：分子分母非有限时返回 null。
 * 对齐 Qlib Alpha158：QD `_ratio` 为 denominator + 1e-12，故分母为 0 时返回 0（不再返回 null）；
 * 窗口不足仍返回 null —— 本管道用 null 表示缺数据，这一点与 QD 抛错不同。
 */
function safeRatio(numerator: number, denominator: number): number | null {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) return null
  if (denominator === 0) return 0
  return numerator / denominator
}

/** 解析窗口：period 或 n 覆盖缺省值；非整数、小于 2 或数据不足返回 null（不抛）。 */
function resolveWindow(
  length: number,
  params: Record<string, number> | undefined,
  fallback: number,
): number | null {
  const period = params?.period ?? params?.n ?? fallback
  if (!Number.isInteger(period) || period < 2) return null
  if (length < period) return null
  return period
}

/** 取窗口内某个字段的 n 个值（含当前）。 */
function windowValues(candles: readonly Candle[], end: number, n: number, field: BarField): number[] {
  const out: number[] = []
  for (let k = end - n + 1; k <= end; k++) out.push(candles[k]![field])
  return out
}

/**
 * 逐点计算：warmup = 'window' 时 i >= n-1，'delta' 时 i >= n（要用到前一根）。
 * evaluate 返回 null 表示该点不可算。
 */
function rollingSeries(
  candles: readonly Candle[],
  params: Record<string, number> | undefined,
  warmup: 'window' | 'delta',
  evaluate: (i: number, n: number) => number | null,
): Series {
  const out = emptySeries(candles.length)
  const n = resolveWindow(candles.length, params, DEFAULT_WINDOW)
  if (n === null) return out
  const start = warmup === 'window' ? n - 1 : n
  for (let i = start; i < candles.length; i++) {
    const value = evaluate(i, n)
    out[i] = value === null ? null : finiteOrNull(value)
  }
  return out
}

/** 无窗口的逐根 K 线因子。 */
function barSeries(evaluate: (bar: Candle) => number | null): FactorDef['compute'] {
  return (candles) => {
    const out = emptySeries(candles.length)
    for (let i = 0; i < candles.length; i++) {
      const value = evaluate(candles[i]!)
      out[i] = value === null ? null : finiteOrNull(value)
    }
    return out
  }
}

interface Regression {
  slope: number
  intercept: number
  rsqr: number | null
  residualLast: number
}

/** 最小二乘：ys 对 x = 0..n-1 回归；x 方差恒大于 0（n >= 2）。 */
function regress(ys: readonly number[]): Regression {
  const n = ys.length
  const xMean = (n - 1) / 2
  const yMean = mean([...ys])
  let sxx = 0
  let sxy = 0
  for (let k = 0; k < n; k++) {
    const dx = k - xMean
    sxx += dx * dx
    sxy += dx * (ys[k]! - yMean)
  }
  const slope = sxx === 0 ? 0 : sxy / sxx
  const intercept = yMean - slope * xMean
  let ssTot = 0
  let ssRes = 0
  for (let k = 0; k < n; k++) {
    const d = ys[k]! - yMean
    ssTot += d * d
    const r = ys[k]! - (intercept + slope * k)
    ssRes += r * r
  }
  const rsqr = ssTot === 0 ? null : 1 - ssRes / ssTot
  const residualLast = ys[n - 1]! - (intercept + slope * (n - 1))
  return { slope, intercept, rsqr, residualLast }
}

/** Pearson 相关系数；任一序列方差为 0 时为 null。 */
function correlation(xs: readonly number[], ys: readonly number[]): number | null {
  const n = xs.length
  if (n === 0) return null
  const mx = mean([...xs])
  const my = mean([...ys])
  let sxx = 0
  let syy = 0
  let sxy = 0
  for (let k = 0; k < n; k++) {
    const dx = xs[k]! - mx
    const dy = ys[k]! - my
    sxx += dx * dx
    syy += dy * dy
    sxy += dx * dy
  }
  if (sxx === 0 || syy === 0) return null
  return sxy / Math.sqrt(sxx * syy)
}

/**
 * 窗口内极值距当前的根数。
 * 对齐 Qlib Alpha158：并列极值取最早出现（QD 用 np.nanargmax / np.nanargmin，返回首个下标）。
 */
function extremeDistance(
  candles: readonly Candle[],
  end: number,
  n: number,
  field: BarField,
  mode: 'max' | 'min',
): number {
  const start = end - n + 1
  let best = mode === 'max' ? -Infinity : Infinity
  for (let k = start; k <= end; k++) {
    const value = candles[k]![field]
    if (mode === 'max' ? value > best : value < best) best = value
  }
  for (let k = start; k <= end; k++) {
    if (candles[k]![field] === best) return end - k
  }
  return 0
}

/** 窗口内 size 个字段变动（需 size + 1 根 K 线）的涨跌分解。 */
interface ChangeSums {
  gain: number
  loss: number
  path: number
  up: number
  down: number
}

function changeSums(
  candles: readonly Candle[],
  end: number,
  size: number,
  field: BarField,
): ChangeSums {
  let gain = 0
  let loss = 0
  let path = 0
  let up = 0
  let down = 0
  for (let k = end - size + 1; k <= end; k++) {
    const delta = candles[k]![field] - candles[k - 1]![field]
    if (delta > 0) {
      gain += delta
      up++
    } else if (delta < 0) {
      loss += -delta
      down++
    }
    path += Math.abs(delta)
  }
  return { gain, loss, path, up, down }
}

/** 1 实体位置：(c - o) / o。 */
const kmid = barSeries((bar) => safeRatio(bar.c - bar.o, bar.o))
/** 2 K 线长度：(h - l) / o。 */
const klen = barSeries((bar) => safeRatio(bar.h - bar.l, bar.o))
/** 3 实体占振幅：(c - o) / (h - l)。 */
const kmid2 = barSeries((bar) => safeRatio(bar.c - bar.o, bar.h - bar.l))
/** 4 上影线：(h - max(o, c)) / o。 */
const kup = barSeries((bar) => safeRatio(bar.h - Math.max(bar.o, bar.c), bar.o))
/** 5 下影线：(min(o, c) - l) / o。 */
const klow = barSeries((bar) => safeRatio(Math.min(bar.o, bar.c) - bar.l, bar.o))
/** 6 收盘偏移：(2c - h - l) / o。 */
const ksft = barSeries((bar) => safeRatio(2 * bar.c - bar.h - bar.l, bar.o))
// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/factors/qlib_adapter.py:219-227; adapted.
/** 6b 上影线占振幅：(h - max(o, c)) / (h - l + 1e-12)。 */
const kup2 = barSeries((bar) => safeRatio(bar.h - Math.max(bar.o, bar.c), bar.h - bar.l + 1e-12))
/** 6c 下影线占振幅：(min(o, c) - l) / (h - l + 1e-12)。 */
const klow2 = barSeries((bar) => safeRatio(Math.min(bar.o, bar.c) - bar.l, bar.h - bar.l + 1e-12))
/** 6d 收盘偏移占振幅：(2c - h - l) / (h - l + 1e-12)。 */
const ksft2 = barSeries((bar) => safeRatio(2 * bar.c - bar.h - bar.l, bar.h - bar.l + 1e-12))

/** 7 滞后收盘比：c[i-n] / c[i]。 */
function rocFactor(candles: readonly Candle[], params?: Record<string, number>): Series {
  return rollingSeries(candles, params, 'delta', (i, n) => safeRatio(candles[i - n]!.c, candles[i]!.c))
}

/** 8 开盘比价：o / c。 */
const open0 = barSeries((bar) => safeRatio(bar.o, bar.c))
/** 9 最高比价：h / c。 */
const high0 = barSeries((bar) => safeRatio(bar.h, bar.c))
/** 10 最低比价：l / c。 */
const low0 = barSeries((bar) => safeRatio(bar.l, bar.c))

/** 11 均值比：mean(c 窗口) / c。 */
function maFactor(candles: readonly Candle[], params?: Record<string, number>): Series {
  return rollingSeries(candles, params, 'window', (i, n) =>
    safeRatio(mean(windowValues(candles, i, n, 'c')), candles[i]!.c),
  )
}

/** 12 标准差比：stdev(c 窗口, ddof 1) / c。对齐 Qlib Alpha158：QD 用样本标准差（ddof = 1）。 */
function stdFactor(candles: readonly Candle[], params?: Record<string, number>): Series {
  return rollingSeries(candles, params, 'window', (i, n) =>
    safeRatio(stdev(windowValues(candles, i, n, 'c'), 1), candles[i]!.c),
  )
}

/** 13 回归斜率：c 对 0..n-1 的最小二乘斜率 / c。 */
function betaFactor(candles: readonly Candle[], params?: Record<string, number>): Series {
  return rollingSeries(candles, params, 'window', (i, n) =>
    safeRatio(regress(windowValues(candles, i, n, 'c')).slope, candles[i]!.c),
  )
}

/** 14 回归 R²；窗口收盘方差为 0 时为 null。 */
function rsqrFactor(candles: readonly Candle[], params?: Record<string, number>): Series {
  return rollingSeries(candles, params, 'window', (i, n) =>
    regress(windowValues(candles, i, n, 'c')).rsqr,
  )
}

/** 15 回归末点残差 / c。 */
function resiFactor(candles: readonly Candle[], params?: Record<string, number>): Series {
  return rollingSeries(candles, params, 'window', (i, n) =>
    safeRatio(regress(windowValues(candles, i, n, 'c')).residualLast, candles[i]!.c),
  )
}

/** 16 窗口最高价 / c。对齐 Qlib Alpha158：QD 取 Max($high)，不是收盘。 */
function maxFactor(candles: readonly Candle[], params?: Record<string, number>): Series {
  return rollingSeries(candles, params, 'window', (i, n) =>
    safeRatio(Math.max(...windowValues(candles, i, n, 'h')), candles[i]!.c),
  )
}

/** 17 窗口最低价 / c。对齐 Qlib Alpha158：QD 取 Min($low)，不是收盘。 */
function minFactor(candles: readonly Candle[], params?: Record<string, number>): Series {
  return rollingSeries(candles, params, 'window', (i, n) =>
    safeRatio(Math.min(...windowValues(candles, i, n, 'l')), candles[i]!.c),
  )
}

/** 18 上分位（80%）/ c。 */
function qtluFactor(candles: readonly Candle[], params?: Record<string, number>): Series {
  return rollingSeries(candles, params, 'window', (i, n) =>
    safeRatio(quantile(windowValues(candles, i, n, 'c').sort((a, b) => a - b), 0.8), candles[i]!.c),
  )
}

/** 19 下分位（20%）/ c。 */
function qtldFactor(candles: readonly Candle[], params?: Record<string, number>): Series {
  return rollingSeries(candles, params, 'window', (i, n) =>
    safeRatio(quantile(windowValues(candles, i, n, 'c').sort((a, b) => a - b), 0.2), candles[i]!.c),
  )
}

/**
 * 20 收盘分位秩：末值在窗口内的百分位。
 * 对齐 Qlib Alpha158：pandas rank(pct=True) 并列取平均名次，即 (less + (equal + 1) / 2) / n。
 */
function rankFactor(candles: readonly Candle[], params?: Record<string, number>): Series {
  return rollingSeries(candles, params, 'window', (i, n) =>
    rankPct(windowValues(candles, i, n, 'c'), n)[n - 1] ?? null,
  )
}

/** 21 RSV：(c - min(l 窗口)) / (max(h 窗口) - min(l 窗口))。 */
function rsvFactor(candles: readonly Candle[], params?: Record<string, number>): Series {
  return rollingSeries(candles, params, 'window', (i, n) => {
    const lows = windowValues(candles, i, n, 'l')
    const highs = windowValues(candles, i, n, 'h')
    return safeRatio(candles[i]!.c - Math.min(...lows), Math.max(...highs) - Math.min(...lows))
  })
}

/** 22 窗口最高价距今根数 / n。 */
function imaxFactor(candles: readonly Candle[], params?: Record<string, number>): Series {
  return rollingSeries(candles, params, 'window', (i, n) =>
    safeRatio(extremeDistance(candles, i, n, 'h', 'max'), n),
  )
}

/** 23 窗口最低价距今根数 / n。 */
function iminFactor(candles: readonly Candle[], params?: Record<string, number>): Series {
  return rollingSeries(candles, params, 'window', (i, n) =>
    safeRatio(extremeDistance(candles, i, n, 'l', 'min'), n),
  )
}

/** 24 最高与最低点距离差（均已除 n）。 */
function imxdFactor(candles: readonly Candle[], params?: Record<string, number>): Series {
  return rollingSeries(candles, params, 'window', (i, n) => {
    const hi = extremeDistance(candles, i, n, 'h', 'max')
    const lo = extremeDistance(candles, i, n, 'l', 'min')
    return safeRatio(hi - lo, n)
  })
}

/** 25 窗口内上涨根数比例：c[k] > c[k-1]。 */
function cntpFactor(candles: readonly Candle[], params?: Record<string, number>): Series {
  return rollingSeries(candles, params, 'delta', (i, n) => {
    return changeSums(candles, i, n, 'c').up / n
  })
}

/** 26 窗口内下跌根数比例：c[k] < c[k-1]。 */
function cntnFactor(candles: readonly Candle[], params?: Record<string, number>): Series {
  return rollingSeries(candles, params, 'delta', (i, n) => {
    return changeSums(candles, i, n, 'c').down / n
  })
}

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/factors/qlib_adapter.py:298-328; adapted.
/** 26b 涨跌根数差：mean(up) - mean(down)（窗口取 size 个 Δ，即 size + 1 根）。 */
function cntdFactor(candles: readonly Candle[], params?: Record<string, number>): Series {
  return rollingSeries(candles, params, 'delta', (i, n) => {
    const sums = changeSums(candles, i, n, 'c')
    return (sums.up - sums.down) / n
  })
}

/** 27 上涨幅度占比：Σgain / Σ|Δc|。对齐 Qlib Alpha158：分母 0 时返回 0。 */
function sumpFactor(candles: readonly Candle[], params?: Record<string, number>): Series {
  return rollingSeries(candles, params, 'delta', (i, n) => {
    const sums = changeSums(candles, i, n, 'c')
    return safeRatio(sums.gain, sums.path)
  })
}

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/factors/qlib_adapter.py:298-330; adapted.
/** 27b 下跌幅度占比：Σloss / Σ|Δc|（分母 0 时返回 0）。 */
function sumnFactor(candles: readonly Candle[], params?: Record<string, number>): Series {
  return rollingSeries(candles, params, 'delta', (i, n) => {
    const sums = changeSums(candles, i, n, 'c')
    return safeRatio(sums.loss, sums.path)
  })
}

/** 27c 净涨跌幅占比：(Σgain - Σloss) / Σ|Δc|。 */
function sumdFactor(candles: readonly Candle[], params?: Record<string, number>): Series {
  return rollingSeries(candles, params, 'delta', (i, n) => {
    const sums = changeSums(candles, i, n, 'c')
    return safeRatio(sums.gain - sums.loss, sums.path)
  })
}

/** 28 成交量均值比：mean(v 窗口) / (v + 1e-12)。 */
function vmaFactor(candles: readonly Candle[], params?: Record<string, number>): Series {
  return rollingSeries(candles, params, 'window', (i, n) =>
    safeRatio(mean(windowValues(candles, i, n, 'v')), candles[i]!.v + 1e-12),
  )
}

/** 29 成交量标准差比：stdev(v 窗口, ddof 1) / (v + 1e-12)。对齐 Qlib Alpha158：QD 用样本标准差（ddof = 1）。 */
function vstdFactor(candles: readonly Candle[], params?: Record<string, number>): Series {
  return rollingSeries(candles, params, 'window', (i, n) =>
    safeRatio(stdev(windowValues(candles, i, n, 'v'), 1), candles[i]!.v + 1e-12),
  )
}

/** 30 量价相关：corr(c, log(v + 1))；任一序列方差为 0 时为 null。 */
function corrFactor(candles: readonly Candle[], params?: Record<string, number>): Series {
  return rollingSeries(candles, params, 'window', (i, n) => {
    const closes = windowValues(candles, i, n, 'c')
    const volumes = windowValues(candles, i, n, 'v').map((value) => Math.log(value + 1))
    return correlation(closes, volumes)
  })
}

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/factors/qlib_adapter.py:256-258, 298-330; adapted.
/** 30b 变动量价相关：corr(c/c[-1], ln(v/v[-1] + 1))，窗口取 size 个比值（size + 1 根）。 */
function cordFactor(candles: readonly Candle[], params?: Record<string, number>): Series {
  return rollingSeries(candles, params, 'delta', (i, n) => {
    const priceRatios: number[] = []
    const volumeRatios: number[] = []
    for (let k = i - n + 1; k <= i; k++) {
      const prevClose = candles[k - 1]!.c
      const prevVolume = candles[k - 1]!.v
      if (prevClose === 0 || prevVolume === 0) return null
      priceRatios.push(candles[k]!.c / prevClose)
      volumeRatios.push(Math.log(candles[k]!.v / prevVolume + 1))
    }
    return correlation(priceRatios, volumeRatios)
  })
}

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/factors/qlib_adapter.py:298-330; adapted.
/** 30c 加权波动：std(|ret| * v, ddof 1) / mean(|ret| * v)，ret = pct_change(c)。 */
function wvmaFactor(candles: readonly Candle[], params?: Record<string, number>): Series {
  return rollingSeries(candles, params, 'delta', (i, n) => {
    const weighted: number[] = []
    for (let k = i - n + 1; k <= i; k++) {
      const prevClose = candles[k - 1]!.c
      if (prevClose === 0) return null
      weighted.push(Math.abs(candles[k]!.c / prevClose - 1) * candles[k]!.v)
    }
    return safeRatio(stdev(weighted, 1), mean([...weighted]))
  })
}

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/factors/qlib_adapter.py:298-330; adapted.
/** 30d 成交量上涨占比：Σmax(Δv, 0) / Σ|Δv|。 */
function vsumpFactor(candles: readonly Candle[], params?: Record<string, number>): Series {
  return rollingSeries(candles, params, 'delta', (i, n) => {
    const sums = changeSums(candles, i, n, 'v')
    return safeRatio(sums.gain, sums.path)
  })
}

/** 30e 成交量下跌占比：Σmax(-Δv, 0) / Σ|Δv|。 */
function vsumnFactor(candles: readonly Candle[], params?: Record<string, number>): Series {
  return rollingSeries(candles, params, 'delta', (i, n) => {
    const sums = changeSums(candles, i, n, 'v')
    return safeRatio(sums.loss, sums.path)
  })
}

/** 30f 成交量净变化占比：(Σgain - Σloss) / Σ|Δv|。 */
function vsumdFactor(candles: readonly Candle[], params?: Record<string, number>): Series {
  return rollingSeries(candles, params, 'delta', (i, n) => {
    const sums = changeSums(candles, i, n, 'v')
    return safeRatio(sums.gain - sums.loss, sums.path)
  })
}

/** Alpha158 风格因子清单（单标的、逐 K 线；窗口缺省 10，params.period 覆盖）。 */
export const ALPHA_FACTORS: FactorDef[] = [
  { id: 'kmid', label: '实体位置', params: { period: DEFAULT_WINDOW }, compute: kmid },
  { id: 'klen', label: 'K 线长度', params: { period: DEFAULT_WINDOW }, compute: klen },
  { id: 'kmid2', label: '实体占振幅', params: { period: DEFAULT_WINDOW }, compute: kmid2 },
  { id: 'kup', label: '上影线', params: { period: DEFAULT_WINDOW }, compute: kup },
  { id: 'klow', label: '下影线', params: { period: DEFAULT_WINDOW }, compute: klow },
  { id: 'ksft', label: '收盘偏移', params: { period: DEFAULT_WINDOW }, compute: ksft },
  { id: 'kup2', label: '上影线占振幅', params: { period: DEFAULT_WINDOW }, compute: kup2 },
  { id: 'klow2', label: '下影线占振幅', params: { period: DEFAULT_WINDOW }, compute: klow2 },
  { id: 'ksft2', label: '收盘偏移占振幅', params: { period: DEFAULT_WINDOW }, compute: ksft2 },
  { id: 'roc_n', label: '滞后收盘比', params: { period: DEFAULT_WINDOW }, compute: rocFactor },
  { id: 'open0', label: '开盘比价', params: { period: DEFAULT_WINDOW }, compute: open0 },
  { id: 'high0', label: '最高比价', params: { period: DEFAULT_WINDOW }, compute: high0 },
  { id: 'low0', label: '最低比价', params: { period: DEFAULT_WINDOW }, compute: low0 },
  { id: 'ma_n', label: '均值比', params: { period: DEFAULT_WINDOW }, compute: maFactor },
  { id: 'std_n', label: '标准差比', params: { period: DEFAULT_WINDOW }, compute: stdFactor },
  { id: 'beta_n', label: '回归斜率', params: { period: DEFAULT_WINDOW }, compute: betaFactor },
  { id: 'rsqr_n', label: '回归决定系数', params: { period: DEFAULT_WINDOW }, compute: rsqrFactor },
  { id: 'resi_n', label: '回归末点残差', params: { period: DEFAULT_WINDOW }, compute: resiFactor },
  { id: 'max_n', label: '最高价比', params: { period: DEFAULT_WINDOW }, compute: maxFactor },
  { id: 'min_n', label: '最低价比', params: { period: DEFAULT_WINDOW }, compute: minFactor },
  { id: 'qtlu_n', label: '上分位比', params: { period: DEFAULT_WINDOW }, compute: qtluFactor },
  { id: 'qtld_n', label: '下分位比', params: { period: DEFAULT_WINDOW }, compute: qtldFactor },
  { id: 'rank_n', label: '收盘分位秩', params: { period: DEFAULT_WINDOW }, compute: rankFactor },
  { id: 'rsv_n', label: '随机指标 RSV', params: { period: DEFAULT_WINDOW }, compute: rsvFactor },
  { id: 'imax_n', label: '高点距今年限', params: { period: DEFAULT_WINDOW }, compute: imaxFactor },
  { id: 'imin_n', label: '低点距今年限', params: { period: DEFAULT_WINDOW }, compute: iminFactor },
  { id: 'imxd_n', label: '高低点距离差', params: { period: DEFAULT_WINDOW }, compute: imxdFactor },
  { id: 'cntp_n', label: '上涨根数占比', params: { period: DEFAULT_WINDOW }, compute: cntpFactor },
  { id: 'cntn_n', label: '下跌根数占比', params: { period: DEFAULT_WINDOW }, compute: cntnFactor },
  { id: 'cntd_n', label: '涨跌根数差', params: { period: DEFAULT_WINDOW }, compute: cntdFactor },
  { id: 'sump_n', label: '上涨幅度占比', params: { period: DEFAULT_WINDOW }, compute: sumpFactor },
  { id: 'sumn_n', label: '下跌幅度占比', params: { period: DEFAULT_WINDOW }, compute: sumnFactor },
  { id: 'sumd_n', label: '净涨跌幅占比', params: { period: DEFAULT_WINDOW }, compute: sumdFactor },
  { id: 'vma_n', label: '成交量均值比', params: { period: DEFAULT_WINDOW }, compute: vmaFactor },
  { id: 'vstd_n', label: '成交量波动比', params: { period: DEFAULT_WINDOW }, compute: vstdFactor },
  { id: 'corr_n', label: '量价相关性', params: { period: DEFAULT_WINDOW }, compute: corrFactor },
  { id: 'cord_n', label: '变动量价相关性', params: { period: DEFAULT_WINDOW }, compute: cordFactor },
  { id: 'wvma_n', label: '加权波动', params: { period: DEFAULT_WINDOW }, compute: wvmaFactor },
  { id: 'vsump_n', label: '成交量上涨占比', params: { period: DEFAULT_WINDOW }, compute: vsumpFactor },
  { id: 'vsumn_n', label: '成交量下跌占比', params: { period: DEFAULT_WINDOW }, compute: vsumnFactor },
  { id: 'vsumd_n', label: '成交量净变化占比', params: { period: DEFAULT_WINDOW }, compute: vsumdFactor },
]

/** 按 id 取因子定义；不存在返回 undefined。 */
export function alphaFactorById(id: string): FactorDef | undefined {
  return ALPHA_FACTORS.find((def) => def.id === id)
}

/** 批量计算 Alpha 因子；ids 缺省为全部，params 按 id 提供覆盖。 */
export function computeAlphaFactors(
  candles: readonly Candle[],
  ids?: string[],
  params?: Record<string, Record<string, number>>,
): Record<string, Series> {
  const wanted = ids ?? ALPHA_FACTORS.map((def) => def.id)
  const out: Record<string, Series> = {}
  for (const id of wanted) {
    const def = alphaFactorById(id)
    if (def === undefined) continue
    out[id] = def.compute(candles, params?.[id])
  }
  return out
}
