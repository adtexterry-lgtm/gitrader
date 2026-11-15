// SPDX-License-Identifier: Apache-2.0
// 指标块示例的纯逻辑：EMA（指数移动平均）与行情载荷解析。没有依赖、没有 DOM，单测直接跑。
// 公式：前 period 根收盘价的简单平均当种子，之后 ema = ema + k * (收盘 - ema)，k = 2 / (period + 1)。
// 想用现成库（例如 trading-signals 的 EMA）：装进插件自己的依赖，把这个文件里的 ema() 换成库调用，其余不用动。

export interface Candle { t: number; o: number; h: number; l: number; c: number; v: number }

/** 最后一根的 EMA；收盘价不够 period 根返回 null。 */
export function ema(closes: readonly number[], period: number): number | null {
  const s = emaSeries(closes, period)
  return s.length ? (s[s.length - 1] ?? null) : null
}

/** 每根 K 线对应的 EMA（前 period - 1 根是 null）。 */
export function emaSeries(closes: readonly number[], period: number): Array<number | null> {
  if (!Number.isInteger(period) || period < 1) throw new RangeError('period 必须是正整数')
  const out: Array<number | null> = []
  const k = 2 / (period + 1)
  let prev: number | null = null
  let sum = 0
  closes.forEach((c, i) => {
    if (!Number.isFinite(c)) { out.push(prev); return }
    if (i < period - 1) { sum += c; out.push(null); return }
    if (i === period - 1) { prev = (sum + c) / period; out.push(prev); return }
    prev = (prev as number) + k * (c - (prev as number))
    out.push(prev)
  })
  return out
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null)

function asCandle(v: unknown): Candle | null {
  if (typeof v !== 'object' || v === null) return null
  const r = v as Record<string, unknown>
  const t = num(r.t)
  const c = num(r.c)
  if (t === null || c === null) return null
  return { t, o: num(r.o) ?? c, h: num(r.h) ?? c, l: num(r.l) ?? c, c, v: num(r.v) ?? 0 }
}

/** 行情载荷 → K 线列表。认几种形状：单根 K 线、{candle}、{candles:[…]}，以及 K 线数组（查询的返回）。 */
export function candlesOf(data: unknown): Candle[] {
  if (Array.isArray(data)) return data.map(asCandle).filter((x): x is Candle => x !== null)
  if (typeof data !== 'object' || data === null) return []
  const r = data as Record<string, unknown>
  if (Array.isArray(r.candles)) return candlesOf(r.candles)
  const one = asCandle(r.candle ?? r)
  return one ? [one] : []
}

/** 收盘价缓冲：同一根 K 线（同 t）的更新覆盖，新 K 线追加，最多留 max 根，按时间升序。 */
export class CloseBuffer {
  private bars: Candle[] = []
  constructor(readonly max = 500) {}
  push(cs: readonly Candle[]): void {
    for (const c of cs) {
      const i = this.bars.findIndex((b) => b.t === c.t)
      if (i >= 0) this.bars[i] = c
      else this.bars.push(c)
    }
    this.bars.sort((a, b) => a.t - b.t)
    if (this.bars.length > this.max) this.bars.splice(0, this.bars.length - this.max)
  }
  clear(): void { this.bars = [] }
  get closes(): number[] { return this.bars.map((b) => b.c) }
  get size(): number { return this.bars.length }
}

export interface Reading {
  period: number
  ema: number | null
  last: number | null
  /** 收盘价相对 EMA 的偏离（百分数）。 */
  diffPct: number | null
  trend: 'up' | 'down' | 'flat' | null
  bars: number
}

export function reading(closes: readonly number[], period: number): Reading {
  const e = ema(closes, period)
  const last = closes.length ? (closes[closes.length - 1] ?? null) : null
  const diffPct = e !== null && last !== null && e !== 0 ? ((last - e) / e) * 100 : null
  const trend = diffPct === null ? null : Math.abs(diffPct) < 0.005 ? 'flat' : diffPct > 0 ? 'up' : 'down'
  return { period, ema: e, last, diffPct, trend, bars: closes.length }
}
