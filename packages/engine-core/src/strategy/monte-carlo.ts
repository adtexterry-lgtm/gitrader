// SPDX-License-Identifier: CPAL-1.0
// 蒙特卡洛：把逐笔成交盈亏重排或有放回重抽样，得到终值与最大回撤的路径分布。纯函数，不碰 IO。
import { mulberry32, quantile } from '@gitrader/stats'

export interface MonteCarloOptions {
  paths?: number            // 缺省 1000
  seed?: number             // 缺省 1
  mode?: 'permute' | 'bootstrap'   // 缺省 'permute'：无放回重排（每条路径是原序列的一个排列）；'bootstrap'：有放回重抽样，长度同原序列
  initialCash?: number      // 缺省 0（权益 = 累计盈亏；给了则权益 = initialCash + 累计盈亏，回撤按比例算）
  ruinDrawdown?: number     // 缺省 undefined；给了（如 0.5 或绝对金额，见下）则统计触及比例
}

export interface MonteCarloResult {
  paths: number
  mode: 'permute' | 'bootstrap'
  /** 每条路径的终值（累计盈亏，或 initialCash + 累计盈亏）。 */
  finalQuantiles: { q05: number; q25: number; q50: number; q75: number; q95: number }
  /** 每条路径的最大回撤：initialCash > 0 时为比例（峰值到谷值 / 峰值），否则为绝对金额（峰值 − 谷值）。 */
  maxDrawdownQuantiles: { q05: number; q25: number; q50: number; q75: number; q95: number }
  /** 终值 < initialCash（或 < 0）的路径占比。 */
  lossShare: number
  /** ruinDrawdown 给了时：最大回撤 ≥ ruinDrawdown 的路径占比；否则 null。 */
  ruinShare: number | null
  originalFinal: number
  originalMaxDrawdown: number
}

type QuantileSummary = { q05: number; q25: number; q50: number; q75: number; q95: number }

const ZERO_QUANTILES: QuantileSummary = { q05: 0, q25: 0, q50: 0, q75: 0, q95: 0 }

function summarize(values: readonly number[]): QuantileSummary {
  const sorted = values.slice().sort((a, b) => a - b)
  return {
    q05: quantile(sorted, 0.05),
    q25: quantile(sorted, 0.25),
    q50: quantile(sorted, 0.5),
    q75: quantile(sorted, 0.75),
    q95: quantile(sorted, 0.95),
  }
}

/** 沿路径累计权益，峰值取历史最高（起点 = initialCash 或 0），返回最大回撤。 */
function maxDrawdownOf(pnls: readonly number[], initialCash: number): number {
  let equity = initialCash
  let peak = initialCash
  let worst = 0
  for (const pnl of pnls) {
    equity += pnl
    if (equity > peak) peak = equity
    const drawdown = initialCash > 0 ? (peak - equity) / peak : peak - equity
    if (drawdown > worst) worst = drawdown
  }
  return worst
}

/** Fisher–Yates 无放回重排。 */
function permute(xs: readonly number[], rand: () => number): number[] {
  const arr = xs.slice()
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    const tmp = arr[i]!
    arr[i] = arr[j]!
    arr[j] = tmp
  }
  return arr
}

/** 有放回重抽样，长度同原序列。 */
function resample(xs: readonly number[], rand: () => number): number[] {
  const out: number[] = new Array<number>(xs.length)
  for (let i = 0; i < xs.length; i++) {
    out[i] = xs[Math.floor(rand() * xs.length)]!
  }
  return out
}

export function monteCarloTrades(pnls: readonly number[], opts: MonteCarloOptions = {}): MonteCarloResult {
  const paths = opts.paths ?? 1000
  const seed = opts.seed ?? 1
  const mode = opts.mode ?? 'permute'
  const initialCash = opts.initialCash ?? 0
  const ruinDrawdown = opts.ruinDrawdown
  const clean = pnls.filter((pnl) => Number.isFinite(pnl))

  if (clean.length === 0) {
    return {
      paths,
      mode,
      finalQuantiles: { ...ZERO_QUANTILES },
      maxDrawdownQuantiles: { ...ZERO_QUANTILES },
      lossShare: 0,
      ruinShare: ruinDrawdown === undefined ? null : 0,
      originalFinal: 0,
      originalMaxDrawdown: 0,
    }
  }

  const rand = mulberry32(seed)
  const finals: number[] = []
  const drawdowns: number[] = []

  for (let k = 0; k < paths; k++) {
    const sequence = mode === 'bootstrap' ? resample(clean, rand) : permute(clean, rand)
    let equity = initialCash
    for (const pnl of sequence) equity += pnl
    finals.push(equity)
    drawdowns.push(maxDrawdownOf(sequence, initialCash))
  }

  const lossThreshold = initialCash > 0 ? initialCash : 0
  let losses = 0
  for (const fin of finals) if (fin < lossThreshold) losses++
  let ruined = 0
  if (ruinDrawdown !== undefined) {
    for (const dd of drawdowns) if (dd >= ruinDrawdown) ruined++
  }

  let totalPnl = 0
  for (const pnl of clean) totalPnl += pnl

  return {
    paths,
    mode,
    finalQuantiles: summarize(finals),
    maxDrawdownQuantiles: summarize(drawdowns),
    lossShare: losses / paths,
    ruinShare: ruinDrawdown === undefined ? null : ruined / paths,
    originalFinal: initialCash + totalPnl,
    originalMaxDrawdown: maxDrawdownOf(clean, initialCash),
  }
}
