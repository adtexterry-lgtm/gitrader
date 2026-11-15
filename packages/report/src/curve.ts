// SPDX-License-Identifier: CPAL-1.0
// 曲线工具：长曲线降采样（保留端点、极值、最大回撤区间、资不抵债边界）、回撤序列、月度收益分桶。
import type { CurvePoint, MonthReturn } from './types'

/** 降采样允许的最小点数（照 QD 的下限）。 */
export const MIN_SAMPLE_LIMIT = 10

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/strategy_v2/curve_sampling.py:9-49; adapted.
// 改动：输入是数值数组（调用方已把 {t,v} 映射成 v），返回的是**下标**而不是子数组，
// 这样权益曲线与回撤曲线可以共用同一批下标、不会各采样一次导致错位；
// QD 的 drawdown 字段这里不存在（回撤由 drawdownSeries 从采样后的同一下标算）。
/**
 * 保留首尾、最高点、最低点、最大回撤的峰谷两点、以及首次 ≤0 的点（及其前一点），
 * 其余按等间距补齐到 limit 个下标。
 */
export function sampleCurveIndices(values: readonly number[], limit: number, initial: number): number[] {
  const n = values.length
  if (n <= limit) return values.map((_, i) => i)
  if (limit < MIN_SAMPLE_LIMIT) throw new RangeError(`curve sampling requires at least ${MIN_SAMPLE_LIMIT} points`)

  const required = new Set<number>([0, n - 1])
  let peak = initial
  let peakIndex = 0
  let worst = 0
  let worstPair: [number, number] = [0, 0]
  let low = Number.POSITIVE_INFINITY
  let high = Number.NEGATIVE_INFINITY
  let lowIndex = 0
  let highIndex = 0
  let firstInsolvent: number | null = null

  for (let index = 0; index < n; index++) {
    const value = values[index]!
    if (!Number.isFinite(value)) continue
    if (value < low) {
      low = value
      lowIndex = index
    }
    if (value > high) {
      high = value
      highIndex = index
    }
    if (peak <= 0 || value > peak) {
      peak = value
      peakIndex = index
    }
    const drawdown = peak > 0 ? (value / peak - 1) * 100 : 0
    if (drawdown < worst) {
      worst = drawdown
      worstPair = [peakIndex, index]
    }
    if (value <= 0 && firstInsolvent === null) firstInsolvent = index
  }

  required.add(worstPair[0])
  required.add(worstPair[1])
  required.add(lowIndex)
  required.add(highIndex)
  if (firstInsolvent !== null) {
    required.add(Math.max(0, firstInsolvent - 1))
    required.add(firstInsolvent)
  }

  const candidates: number[] = []
  for (let index = 0; index < n; index++) if (!required.has(index)) candidates.push(index)
  const slots = limit - required.size
  if (slots <= 1) return [...required].sort((a, b) => a - b)
  const step = (candidates.length - 1) / (slots - 1)
  for (let slot = 0; slot < slots; slot++) {
    const picked = candidates[Math.round(slot * step)]
    if (picked !== undefined) required.add(picked)
  }
  return [...required].sort((a, b) => a - b)
}

/** 降采样后的权益点（保序）。 */
export function sampleCurve(points: readonly CurvePoint[], limit: number, initial: number): CurvePoint[] {
  return sampleCurveIndices(points.map((p) => p.v), limit, initial).map((i) => points[i]!)
}

/** 逐点回撤（分数，≤0）。峰值从 initial 起算。 */
export function drawdownSeries(points: readonly CurvePoint[], initial: number): number[] {
  let peak = initial
  const out: number[] = []
  for (const p of points) {
    if (p.v > peak) peak = p.v
    out.push(peak > 0 ? p.v / peak - 1 : 0)
  }
  return out
}

/** UTC 月键。 */
export function monthKeyUtc(t: number): string {
  const d = new Date(t)
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  return `${y}-${m}`
}

/**
 * 月度收益分桶：每个月取该月最后一个权益点，ret = 当月最后 / 上月最后 - 1；
 * 第一个月的基数是曲线第一个点（起算权益）。中间缺月不补空桶（热力表留空格）。
 */
export function monthlyReturns(equity: readonly CurvePoint[]): MonthReturn[] {
  if (equity.length === 0) return []
  const last = new Map<string, CurvePoint>()
  const counts = new Map<string, number>()
  for (const p of equity) {
    if (!Number.isFinite(p.v) || !Number.isFinite(p.t)) continue
    const key = monthKeyUtc(p.t)
    last.set(key, p)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const keys = [...last.keys()].sort()
  const out: MonthReturn[] = []
  let base = equity[0]!.v
  for (const key of keys) {
    const point = last.get(key)!
    const ret = base > 0 ? point.v / base - 1 : 0
    const [yearText, monthText] = key.split('-')
    out.push({
      key,
      year: Number(yearText),
      month: Number(monthText),
      ret,
      points: counts.get(key) ?? 0,
    })
    base = point.v
  }
  return out
}
