// SPDX-License-Identifier: CPAL-1.0
// 量价类指标：OBV、VWAP、MFI、CMF 与 AD 线，输出与输入等长，不可算处为 null。

import type { Bar, Series } from './types'

/** 周期参数校验：必须为正整数，否则抛 RangeError。 */
function assertPeriod(period: number): void {
  if (!Number.isInteger(period) || period < 1) {
    throw new RangeError(`period 必须是正整数，收到 ${String(period)}`)
  }
}

/** 典型价 (h + l + c) / 3。 */
function typicalPrice(bar: Bar): number {
  return (bar.h + bar.l + bar.c) / 3
}

/** 资金流乘数：h == l 时取 0。 */
function moneyFlowMultiplier(bar: Bar): number {
  const range = bar.h - bar.l
  if (range === 0) return 0
  return (bar.c - bar.l - (bar.h - bar.c)) / range
}

/** 单根 K 线的资金流量 mfm · v。 */
function moneyFlowVolume(bar: Bar): number {
  return moneyFlowMultiplier(bar) * bar.v
}

/** 能量潮：第 0 项为 0，之后按收盘价涨跌累加或累减成交量。 */
export function obv(bars: Bar[]): Series {
  const out: Series = new Array<number | null>(bars.length).fill(null)
  if (bars.length === 0) return out
  let acc = 0
  out[0] = acc
  for (let i = 1; i < bars.length; i++) {
    const cur = bars[i]!
    const prev = bars[i - 1]!
    if (cur.c > prev.c) acc += cur.v
    else if (cur.c < prev.c) acc -= cur.v
    out[i] = acc
  }
  return out
}

/** 成交量加权均价：不传 period 为累计口径，传 period 为含当前的滚动窗口。 */
export function vwap(bars: Bar[], period?: number): Series {
  const out: Series = new Array<number | null>(bars.length).fill(null)
  if (period !== undefined) assertPeriod(period)
  let pv = 0
  let vol = 0
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i]!
    pv += typicalPrice(bar) * bar.v
    vol += bar.v
    if (period === undefined) {
      out[i] = vol === 0 ? null : pv / vol
      continue
    }
    if (i >= period) {
      const dropped = bars[i - period]!
      pv -= typicalPrice(dropped) * dropped.v
      vol -= dropped.v
    }
    out[i] = i < period - 1 || vol === 0 ? null : pv / vol
  }
  return out
}

/** 资金流量指标（0–100）：按典型价涨跌划分正负资金流，取最近 period 个流。 */
export function mfi(bars: Bar[], period = 14): Series {
  assertPeriod(period)
  const out: Series = new Array<number | null>(bars.length).fill(null)
  const positive: number[] = new Array<number>(bars.length).fill(0)
  const negative: number[] = new Array<number>(bars.length).fill(0)
  for (let i = 1; i < bars.length; i++) {
    const bar = bars[i]!
    const tp = typicalPrice(bar)
    const tpPrev = typicalPrice(bars[i - 1]!)
    const flow = tp * bar.v
    if (tp > tpPrev) positive[i] = flow
    else if (tp < tpPrev) negative[i] = flow
  }
  for (let i = period; i < bars.length; i++) {
    let pos = 0
    let neg = 0
    for (let j = i - period + 1; j <= i; j++) {
      pos += positive[j]!
      neg += negative[j]!
    }
    out[i] = neg === 0 ? (pos === 0 ? 50 : 100) : 100 - 100 / (1 + pos / neg)
  }
  return out
}

/** 蔡金资金流量：最近 period 根（含当前）的资金流量之和除以成交量之和。 */
export function cmf(bars: Bar[], period = 20): Series {
  assertPeriod(period)
  const out: Series = new Array<number | null>(bars.length).fill(null)
  const flows: number[] = bars.map((bar) => moneyFlowVolume(bar))
  for (let i = period - 1; i < bars.length; i++) {
    let sum = 0
    let vol = 0
    for (let j = i - period + 1; j <= i; j++) {
      sum += flows[j]!
      vol += bars[j]!.v
    }
    out[i] = vol === 0 ? null : sum / vol
  }
  return out
}

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/factors/registry.py:399; adapted.
/** 成交额代理：最近 period 根（含当前）close · volume 的算术平均。 */
export function turnoverProxy(bars: Bar[], period: number): Series {
  const out: Series = new Array<number | null>(bars.length).fill(null)
  if (!Number.isInteger(period) || period < 1) return out
  for (let i = period - 1; i < bars.length; i++) {
    let sum = 0
    for (let j = i - period + 1; j <= i; j++) {
      const bar = bars[j]!
      sum += bar.c * bar.v
    }
    out[i] = sum / period
  }
  return out
}

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/factors/registry.py:389; adapted.
/** 成交量 z 分数：最新一根相对最近 period 根均值，除以样本标准差（ddof 1）；标准差为 0 或周期 < 2 时 null。 */
export function volumeZscore(bars: Bar[], period: number): Series {
  const out: Series = new Array<number | null>(bars.length).fill(null)
  if (!Number.isInteger(period) || period < 2) return out
  for (let i = period - 1; i < bars.length; i++) {
    const start = i - period + 1
    let sum = 0
    for (let j = start; j <= i; j++) sum += bars[j]!.v
    const mean = sum / period
    let squares = 0
    for (let j = start; j <= i; j++) {
      const d = bars[j]!.v - mean
      squares += d * d
    }
    const std = Math.sqrt(squares / (period - 1))
    if (std === 0) continue
    out[i] = (bars[i]!.v - mean) / std
  }
  return out
}

/** 累积/派发线：从第 0 根起累加资金流量。 */
export function adLine(bars: Bar[]): Series {
  const out: Series = new Array<number | null>(bars.length).fill(null)
  let acc = 0
  for (let i = 0; i < bars.length; i++) {
    acc += moneyFlowVolume(bars[i]!)
    out[i] = acc
  }
  return out
}
