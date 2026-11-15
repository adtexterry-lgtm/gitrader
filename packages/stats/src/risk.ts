// SPDX-License-Identifier: CPAL-1.0
// 风险指标纯函数：下行偏差、Sortino、最大回撤与恢复期、Calmar、历史法 VaR/CVaR。
// 思路参照 QuantDinger v5.7.3-v5.7.7 回测风险指标扩充；公式为通用定义，自行实现。
import { mean } from './dist'

// 下行偏差 = sqrt(mean(min(r - mar, 0)^2))，分母取全体样本数 n（Sortino & Price 1994）。
export function downsideDeviation(returns: number[], mar = 0): number {
  if (returns.length === 0) return NaN
  let s = 0
  for (const r of returns) {
    const d = Math.min(r - mar, 0)
    s += d * d
  }
  return Math.sqrt(s / returns.length)
}

// Sortino = (mean - mar) / 下行偏差；无下行（偏差 0）或空输入 -> null（未定义，不是 0）。
export function sortino(
  returns: number[],
  opts?: { mar?: number; periodsPerYear?: number },
): number | null {
  const mar = opts?.mar ?? 0
  const dd = downsideDeviation(returns, mar)
  if (!Number.isFinite(dd) || dd === 0) return null
  const v = (mean(returns) - mar) / dd
  return opts?.periodsPerYear === undefined ? v : v * Math.sqrt(opts.periodsPerYear)
}

export interface DrawdownStats {
  maxDrawdown: number // 正数比例，0.2 = 回撤 20%
  peakIndex: number // 最大回撤对应的前高下标
  troughIndex: number // 谷底下标
  recoveryIndex: number | null // 重新回到前高的下标；至今未恢复 -> null
  durationBars: number // 前高 -> 谷底 根数
  recoveryBars: number | null // 谷底 -> 恢复 根数；未恢复 -> null
}

// 从净值曲线算最大回撤及恢复期。净值需为正；空或单点回撤 0。
export function drawdownStats(equity: number[]): DrawdownStats {
  let peak = 0
  let peakIdx = 0
  let maxDd = 0
  let bp = 0
  let bt = 0
  for (let i = 0; i < equity.length; i++) {
    const v = equity[i]!
    if (v > equity[peakIdx]! || i === 0) { peakIdx = i; peak = v }
    const dd = peak > 0 ? (peak - v) / peak : 0
    if (dd > maxDd) { maxDd = dd; bp = peakIdx; bt = i }
  }
  let rec: number | null = null
  if (maxDd > 0) {
    for (let i = bt + 1; i < equity.length; i++) {
      if (equity[i]! >= equity[bp]!) { rec = i; break }
    }
  }
  return {
    maxDrawdown: maxDd,
    peakIndex: bp,
    troughIndex: bt,
    recoveryIndex: rec,
    durationBars: bt - bp,
    recoveryBars: rec === null ? null : rec - bt,
  }
}

// Calmar = 年化收益 / 最大回撤；回撤为 0 -> null。
export function calmar(annualReturn: number, maxDrawdown: number): number | null {
  if (!Number.isFinite(annualReturn) || !Number.isFinite(maxDrawdown) || maxDrawdown <= 0) return null
  return annualReturn / maxDrawdown
}

// 历史法 VaR/CVaR：返回正数损失。alpha=0.05 即 95% 置信。
// VaR = 第 alpha 分位收益的相反数（线性插值，与 bootstrap.quantile 无关，自带排序）；
// CVaR = 不优于该分位的收益均值的相反数。样本 < 1 -> null。
export function varCvar(returns: number[], alpha = 0.05): { var: number; cvar: number } | null {
  const n = returns.length
  if (n === 0 || !(alpha > 0 && alpha < 1)) return null
  const s = [...returns].sort((a, b) => a - b)
  const pos = alpha * (n - 1)
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  const q = s[lo]! + (s[hi]! - s[lo]!) * (pos - lo)
  const tail = s.filter((x) => x <= q)
  return { var: -q, cvar: -mean(tail) }
}
