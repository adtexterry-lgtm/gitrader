// SPDX-License-Identifier: CPAL-1.0
// 单标的因子库：逐 K 线计算，输出与输入等长，预热期与不可算处为 null。
// 因果约定：第 i 项只用 <= i 的数据；非有限数一律记为 null。
import { skewness, stdev } from '@gitrader/stats'
import type { Candle } from '../types'
import { rsi } from './ta/momentum'
import { sma } from './ta/trend'

export interface FactorDef {
  id: string
  label: string
  params: Record<string, number>
  compute(candles: readonly Candle[], params?: Record<string, number>): Array<number | null>
}

/** 空序列（全 null），长度与输入一致。 */
function emptySeries(length: number): Array<number | null> {
  return new Array<number | null>(length).fill(null)
}

/** 非有限数转 null。 */
function finiteOrNull(value: number): number | null {
  return Number.isFinite(value) ? value : null
}

/**
 * 解析窗口长度：参数 period 覆盖缺省值。
 * 非整数、小于 2 或数据不足时返回 null（调用方输出全 null，不抛）。
 */
function resolveWindow(
  length: number,
  params: Record<string, number> | undefined,
  fallback: number,
): number | null {
  const period = params?.period ?? fallback
  if (!Number.isInteger(period) || period < 2) return null
  if (length < period) return null
  return period
}

function closesOf(candles: readonly Candle[]): number[] {
  return candles.map((candle) => candle.c)
}

/** 1 动量：c[i] / c[i-n] - 1。 */
function momentumFactor(candles: readonly Candle[], params?: Record<string, number>): Array<number | null> {
  const out = emptySeries(candles.length)
  const n = resolveWindow(candles.length, params, 20)
  if (n === null) return out
  for (let i = n; i < candles.length; i++) {
    const base = candles[i - n]!.c
    if (base === 0) continue
    out[i] = finiteOrNull(candles[i]!.c / base - 1)
  }
  return out
}

/** 2 波动率：最近 n 个对数收益的样本标准差（ddof 1）。 */
function volatilityFactor(candles: readonly Candle[], params?: Record<string, number>): Array<number | null> {
  const out = emptySeries(candles.length)
  const n = resolveWindow(candles.length, params, 20)
  if (n === null) return out
  for (let i = n; i < candles.length; i++) {
    const returns: number[] = []
    let valid = true
    for (let k = i - n + 1; k <= i; k++) {
      const cur = candles[k]!.c
      const prev = candles[k - 1]!.c
      if (!(cur > 0) || !(prev > 0)) {
        valid = false
        break
      }
      returns.push(Math.log(cur / prev))
    }
    if (!valid) continue
    out[i] = finiteOrNull(stdev(returns, 1))
  }
  return out
}

/** 3 RSI：复用技术指标库的 Wilder RSI。 */
function rsiFactor(candles: readonly Candle[], params?: Record<string, number>): Array<number | null> {
  const out = emptySeries(candles.length)
  const n = resolveWindow(candles.length, params, 14)
  if (n === null) return out
  const series = rsi(closesOf(candles), n)
  for (let i = 0; i < series.length; i++) {
    const value = series[i]
    if (value === null || value === undefined) continue
    out[i] = finiteOrNull(value)
  }
  return out
}

/** 4 量比：v[i] / mean(v[i-n..i-1])；均值为 0 时为 null。 */
function volumeRatioFactor(candles: readonly Candle[], params?: Record<string, number>): Array<number | null> {
  const out = emptySeries(candles.length)
  const n = resolveWindow(candles.length, params, 20)
  if (n === null) return out
  for (let i = n; i < candles.length; i++) {
    let sum = 0
    for (let k = i - n; k < i; k++) sum += candles[k]!.v
    const avg = sum / n
    if (avg === 0) continue
    out[i] = finiteOrNull(candles[i]!.v / avg)
  }
  return out
}

/** 5 振幅：(max(h[i-n+1..i]) - min(l[i-n+1..i])) / c[i]。 */
function rangeFactor(candles: readonly Candle[], params?: Record<string, number>): Array<number | null> {
  const out = emptySeries(candles.length)
  const n = resolveWindow(candles.length, params, 20)
  if (n === null) return out
  for (let i = n - 1; i < candles.length; i++) {
    let hi = -Infinity
    let lo = Infinity
    for (let k = i - n + 1; k <= i; k++) {
      const bar = candles[k]!
      if (bar.h > hi) hi = bar.h
      if (bar.l < lo) lo = bar.l
    }
    const close = candles[i]!.c
    if (close === 0) continue
    out[i] = finiteOrNull((hi - lo) / close)
  }
  return out
}

/** 6 标准化：(c[i] - sma_n) / stdev_n；stdev 为 0 时为 null。 */
function zscoreFactor(candles: readonly Candle[], params?: Record<string, number>): Array<number | null> {
  const out = emptySeries(candles.length)
  const n = resolveWindow(candles.length, params, 20)
  if (n === null) return out
  const closes = closesOf(candles)
  const avg = sma(closes, n)
  for (let i = n - 1; i < candles.length; i++) {
    const mu = avg[i]
    if (mu === null || mu === undefined) continue
    const sd = stdev(closes.slice(i - n + 1, i + 1), 1)
    if (sd === 0) continue
    out[i] = finiteOrNull((closes[i]! - mu) / sd)
  }
  return out
}

/** 7 效率系数：净位移 / 路径长度；分母为 0 时为 null。 */
function efficiencyRatioFactor(candles: readonly Candle[], params?: Record<string, number>): Array<number | null> {
  const out = emptySeries(candles.length)
  const n = resolveWindow(candles.length, params, 10)
  if (n === null) return out
  for (let i = n; i < candles.length; i++) {
    let path = 0
    for (let k = i - n + 1; k <= i; k++) {
      path += Math.abs(candles[k]!.c - candles[k - 1]!.c)
    }
    if (path === 0) continue
    out[i] = finiteOrNull(Math.abs(candles[i]!.c - candles[i - n]!.c) / path)
  }
  return out
}

/** 8 偏度：最近 n 个简单收益的偏度。 */
function skewFactor(candles: readonly Candle[], params?: Record<string, number>): Array<number | null> {
  const out = emptySeries(candles.length)
  const n = resolveWindow(candles.length, params, 20)
  if (n === null) return out
  for (let i = n; i < candles.length; i++) {
    const returns: number[] = []
    let valid = true
    for (let k = i - n + 1; k <= i; k++) {
      const prev = candles[k - 1]!.c
      if (prev === 0) {
        valid = false
        break
      }
      returns.push(candles[k]!.c / prev - 1)
    }
    if (!valid) continue
    out[i] = finiteOrNull(skewness(returns))
  }
  return out
}

/** 9 最大回撤：最近 n 根收盘的峰值到谷值回撤比例（正数）。 */
function maxDrawdownFactor(candles: readonly Candle[], params?: Record<string, number>): Array<number | null> {
  const out = emptySeries(candles.length)
  const n = resolveWindow(candles.length, params, 20)
  if (n === null) return out
  for (let i = n - 1; i < candles.length; i++) {
    let peak = -Infinity
    let drawdown = 0
    let valid = true
    for (let k = i - n + 1; k <= i; k++) {
      const close = candles[k]!.c
      if (!Number.isFinite(close)) {
        valid = false
        break
      }
      if (close > peak) peak = close
      if (peak > 0) {
        const dd = (peak - close) / peak
        if (dd > drawdown) drawdown = dd
      }
    }
    if (!valid) continue
    out[i] = finiteOrNull(drawdown)
  }
  return out
}

/** 10 Amihud：mean(|r_k| / (c[k] * v[k]))；c*v 为 0 的项跳过。 */
function amihudFactor(candles: readonly Candle[], params?: Record<string, number>): Array<number | null> {
  const out = emptySeries(candles.length)
  const n = resolveWindow(candles.length, params, 20)
  if (n === null) return out
  for (let i = n; i < candles.length; i++) {
    let sum = 0
    let count = 0
    for (let k = i - n + 1; k <= i; k++) {
      const close = candles[k]!.c
      const volume = candles[k]!.v
      const denom = close * volume
      if (denom === 0 || !Number.isFinite(denom)) continue
      const prev = candles[k - 1]!.c
      if (prev === 0) continue
      const ret = close / prev - 1
      const term = Math.abs(ret) / denom
      if (!Number.isFinite(term)) continue
      sum += term
      count++
    }
    if (count === 0) continue
    out[i] = finiteOrNull(sum / count)
  }
  return out
}

/** 内置因子（单标的、逐 K 线；预热期内为 null；n 为参数 period，缺省见各项）。 */
export const FACTORS: FactorDef[] = [
  { id: 'momentum', label: '动量', params: { period: 20 }, compute: momentumFactor },
  { id: 'volatility', label: '波动率', params: { period: 20 }, compute: volatilityFactor },
  { id: 'rsi', label: '相对强弱', params: { period: 14 }, compute: rsiFactor },
  { id: 'volume_ratio', label: '量比', params: { period: 20 }, compute: volumeRatioFactor },
  { id: 'range', label: '振幅', params: { period: 20 }, compute: rangeFactor },
  { id: 'zscore', label: '标准化收盘', params: { period: 20 }, compute: zscoreFactor },
  { id: 'efficiency_ratio', label: '效率系数', params: { period: 10 }, compute: efficiencyRatioFactor },
  { id: 'skew', label: '收益偏度', params: { period: 20 }, compute: skewFactor },
  { id: 'max_drawdown', label: '最大回撤', params: { period: 20 }, compute: maxDrawdownFactor },
  { id: 'amihud', label: 'Amihud 非流动性', params: { period: 20 }, compute: amihudFactor },
]

/** 按 id 取因子定义；不存在返回 undefined。 */
export function factorById(id: string): FactorDef | undefined {
  return FACTORS.find((def) => def.id === id)
}

/** 批量计算因子；ids 缺省为全部内置因子，params 按 id 提供覆盖。 */
export function computeFactors(
  candles: readonly Candle[],
  ids?: string[],
  params?: Record<string, Record<string, number>>,
): Record<string, Array<number | null>> {
  const wanted = ids ?? FACTORS.map((def) => def.id)
  const out: Record<string, Array<number | null>> = {}
  for (const id of wanted) {
    const def = factorById(id)
    if (def === undefined) continue
    out[id] = def.compute(candles, params?.[id])
  }
  return out
}
