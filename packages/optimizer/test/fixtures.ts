// SPDX-License-Identifier: CPAL-1.0
// 测试夹具：真实 engine-core 策略（SMA 双均线）+ 合成 K 线 + 手算收益矩阵。
// 手算矩阵的期望值来自独立实现（Python 按论文定义重算，见 REPORT.md「验证覆盖」）。
import { synthCandles, type Candle, type StrategyDef } from '@gitrader/engine-core'
import type { ParamSpace } from '../src/space'

export const simOptions = { initialCash: 10_000, leverage: 1, feeRate: 0.0005, slippageBps: 2 }

/** 确定性合成 K 线（engine-core 公开的 synthCandles，种子固定）。 */
export function bars(n = 200, seed = 7): Candle[] {
  return synthCandles({ n, seed, intervalMs: 3_600_000 })
}

function sma(values: readonly number[], period: number): number[] {
  const out: number[] = new Array(values.length).fill(Number.NaN)
  let sum = 0
  for (let i = 0; i < values.length; i++) {
    sum += values[i] ?? 0
    if (i >= period) sum -= values[i - period] ?? 0
    if (i >= period - 1) out[i] = sum / period
  }
  return out
}

/** 真策略：快慢均线交叉，warmup = slow。参数对收益有真实影响，供端到端用例用。 */
export const smaCross: StrategyDef = {
  id: 'sma-cross-fixture',
  name: 'SMA cross fixture',
  version: '1',
  desc: 'fixture only',
  tags: [],
  params: [
    { key: 'fast', label: 'fast', type: 'integer', default: 5, min: 2, max: 30, step: 1 },
    { key: 'slow', label: 'slow', type: 'integer', default: 20, min: 5, max: 60, step: 5 },
    { key: 'allowShort', label: 'short', type: 'boolean', default: false },
  ],
  defaults: { fast: 5, slow: 20, allowShort: false },
  evaluate(candles, params) {
    const fast = Math.max(2, Math.round(Number(params.fast ?? 5)))
    const slow = Math.max(fast + 1, Math.round(Number(params.slow ?? 20)))
    const allowShort = params.allowShort === true
    const closes = candles.map((candle) => candle.c)
    const fastMa = sma(closes, fast)
    const slowMa = sma(closes, slow)
    const target: number[] = []
    const reasons: string[] = []
    for (let i = 0; i < candles.length; i++) {
      const f = fastMa[i]
      const s = slowMa[i]
      let value = 0
      let reason = ''
      if (f !== undefined && s !== undefined && Number.isFinite(f) && Number.isFinite(s)) {
        if (f > s) {
          value = 1
          reason = 'fast>slow'
        } else if (allowShort) {
          value = -1
          reason = 'fast<=slow'
        }
      }
      target.push(value)
      reasons.push(reason)
    }
    return { target, reasons, overlays: {}, warmup: slow }
  },
}

/** 小空间：24 个网格组合，够端到端跑完整流程。 */
export const smaSpace: ParamSpace = {
  fast: { type: 'integer', min: 2, max: 8, step: 2 },
  slow: { type: 'integer', min: 10, max: 30, step: 10 },
  allowShort: { type: 'boolean' },
}

/** 搜索算法的纯目标：最优点 (3, 2)，分数 = 0。 */
export const quadSpace: ParamSpace = {
  x: { type: 'number', min: 0, max: 10, step: 1 },
  y: { type: 'integer', min: 0, max: 5, step: 1 },
}

export function quadObjective(params: { x?: number | boolean | string; y?: number | boolean | string }): number {
  const x = typeof params.x === 'number' ? params.x : Number(params.x ?? 0)
  const y = typeof params.y === 'number' ? params.y : Number(params.y ?? 0)
  return -((x - 3) ** 2) - ((y - 2) ** 2)
}

/** 算术平均（PBO 手算夹具的度量；刻意不用 @gitrader/stats 的 sharpe，避免自证）。 */
export function meanMetric(xs: number[]): number {
  let sum = 0
  for (const x of xs) sum += x
  return xs.length === 0 ? 0 : sum / xs.length
}

/** 8 期两策略：各半段一边倒，CSCV 两组合都翻车 → PBO = 1。 */
export const pboFlip: number[][] = [
  [0.02, 0.02, 0.02, 0.02, -0.01, -0.01, -0.01, -0.01],
  [-0.01, -0.01, -0.01, -0.01, 0.02, 0.02, 0.02, 0.02],
]

/** 8 期两策略：A 全程压过 B → PBO = 0。 */
export const pboStable: number[][] = [
  [0.02, 0.03, 0.02, 0.03, 0.02, 0.03, 0.02, 0.03],
  [0.01, 0.015, 0.011, 0.016, 0.012, 0.017, 0.013, 0.018],
]

/** 16 期三策略、4 块：按 Sharpe 度量 PBO = 2/3（独立 Python 实现算出的值见用例注释）。 */
export const pboMixed: number[][] = [
  [0.03, 0.031, 0.032, 0.033, 0.001, 0.002, 0.001, 0.002, 0.02, 0.021, 0.02, 0.021, 0, 0.001, 0, 0.001],
  [0.01, 0.011, 0.012, 0.013, 0.02, 0.021, 0.02, 0.021, 0.002, 0.001, 0.002, 0.001, 0.015, 0.016, 0.015, 0.016],
  [0.02, 0.019, 0.02, 0.019, 0.01, 0.009, 0.01, 0.009, 0.01, 0.011, 0.01, 0.011, 0.02, 0.021, 0.02, 0.021],
]

/** DSR 手算夹具：两条 4 期收益，Sharpe 恰为 √3/2 与 √3，横截面方差恰为 0.375。 */
export const dsrBest = [0.01, 0.03, 0.01, 0.03]
export const dsrOther = [0.02, 0, 0.02, 0]

/** 预热夹具用的前段长度：这一段行情是「诱饵」，预热 20 根之后才计分。 */
export const PROBE_WARMUP = 20

/**
 * 前 24 根单边上涨 1%、之后 ±0.6% 来回的确定性 K 线。
 * 用途：让「只在早段持仓」的组合在不预热时拿到漂亮分数，预热之后一分都拿不到。
 */
export function rampCandles(n = 200, rampBars = 24): Candle[] {
  const out: Candle[] = []
  const t0 = Date.UTC(2026, 0, 1)
  let price = 100
  for (let i = 0; i < n; i++) {
    const open = price
    const ret = i < rampBars ? 0.01 : i % 2 === 0 ? 0.006 : -0.005
    price = Math.round(open * (1 + ret) * 100) / 100
    out.push({
      t: t0 + i * 3_600_000,
      o: open,
      h: Number((Math.max(open, price) * 1.001).toFixed(4)),
      l: Number((Math.min(open, price) * 0.999).toFixed(4)),
      c: price,
      v: 10,
    })
  }
  return out
}

/** 把 [from, to) 的行情整体放大 factor 倍（改的是数据本身，不动长度与时间戳）。 */
export function poisonCandles(candles: readonly Candle[], from: number, to: number, factor = 40): Candle[] {
  return candles.map((candle, index) => {
    if (index < from || index >= to) return { ...candle }
    const o = candle.o * factor
    const c = candle.c * factor
    return { ...candle, o, c, h: Math.max(o, c) * 1.002, l: Math.min(o, c) * 0.998, v: candle.v * factor }
  })
}

/**
 * 预热探针：仓位只由「第几根 K 线」决定，与价格无关。
 * - `early`：只在预热段（前 {@link PROBE_WARMUP} 根）持仓 —— 不预热时靠早段行情拿分，预热后就该归零。
 * - `late`：预热段空仓，之后隔根多空对翻（在这个来回市里持续亏手续费与逆势）—— 预热段的行情怎么改都影响不到它。
 * - `none`：全程空仓。
 */
export const scheduleProbe: StrategyDef = {
  id: 'warmup-schedule-probe',
  name: 'Warmup schedule probe',
  version: '1',
  desc: 'fixture only',
  tags: [],
  params: [{ key: 'mode', label: 'mode', type: 'select', options: ['early', 'late', 'none'], default: 'late' }],
  defaults: { mode: 'late' },
  evaluate(candles, params) {
    const mode = String(params.mode ?? 'late')
    const target: number[] = []
    const reasons: string[] = []
    for (let i = 0; i < candles.length; i++) {
      let value = 0
      if (mode === 'early' && i < PROBE_WARMUP) value = 1
      else if (mode === 'late' && i >= PROBE_WARMUP) value = i % 2 === 0 ? 1 : -1
      target.push(value)
      reasons.push(value === 0 ? 'flat' : 'probe')
    }
    return { target, reasons, overlays: {}, warmup: 0 }
  },
}

/** 探针空间：三个 mode，够一次网格跑完。 */
export const probeSpace: ParamSpace = {
  mode: { type: 'select', options: ['early', 'late', 'none'] },
}

/** 回看探针要的历史根数：本地下标不满这么多根就不出信号（模拟指标没齐）。 */
export const LOOKBACK_BARS = 30

/**
 * 回看探针：只有拿到 {@link LOOKBACK_BARS} 根本地历史之后才开仓。
 * 用途是钉住「测试窗也预热」：20 根长的测试窗自己凑不出 30 根历史 → 空仓 0 分；
 * 前面借 30 根预热之后再评估 → 窗口内立刻有信号。只认本地下标，与价格无关。
 */
export const lookbackProbe: StrategyDef = {
  id: 'warmup-lookback-probe',
  name: 'Warmup lookback probe',
  version: '1',
  desc: 'fixture only',
  tags: [],
  params: [{ key: 'mode', label: 'mode', type: 'select', options: ['on'], default: 'on' }],
  defaults: { mode: 'on' },
  evaluate(candles) {
    const target: number[] = []
    const reasons: string[] = []
    for (let i = 0; i < candles.length; i++) {
      const value = i >= LOOKBACK_BARS ? (i % 2 === 0 ? 1 : -1) : 0
      target.push(value)
      reasons.push(value === 0 ? 'warming' : 'probe')
    }
    return { target, reasons, overlays: {}, warmup: 0 }
  },
}

/** 回看探针的空格（只有一个取值，寻优只为把它跑起来）。 */
export const lookbackSpace: ParamSpace = {
  mode: { type: 'select', options: ['on'] },
}
