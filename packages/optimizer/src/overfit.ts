// SPDX-License-Identifier: CPAL-1.0
// 过拟合指标：每次寻优都算，不给「只有样本内好看」留余地。
// - 试验次数：本次寻优真正回测过的参数组合数（去重后）。
// - PBO：CSCV 组合对称交叉验证的过拟合概率（@gitrader/stats cscvPbo，Bailey–Borwein–López de Prado–Zhu 2014）。
// - DSR：最优试验的去膨胀 Sharpe（@gitrader/stats dsr，Bailey & López de Prado 2014）。
// 算不出来时字段为 null 且 missing 里写明原因——不填 0，不让「不可算」看起来像「没问题」。
import { cscvPbo, dsr, expectedMaxSharpe, kurtosis, sharpe, sharpeOfTrials, skewness } from '@gitrader/stats'

/** CSCV 缺省块数：C(8,4) = 70 组合，短序列也能算，代价可控。 */
export const DEFAULT_PBO_BLOCKS = 8

export interface TrialReturns {
  returns: number[]
}

export interface OverfitReport {
  /** 试验次数（强制字段，永远有值）。 */
  trials: number
  /** 每个试验的收益期数。 */
  periods: number
  pbo: number | null
  pboBlocks: number | null
  pboCombos: number | null
  oosRankMean: number | null
  probLossOos: number | null
  dsr: number | null
  bestSharpe: number
  trialVariance: number
  /** DSR 的基准：N 次试验下的期望最大 Sharpe。 */
  deflatedBenchmark: number | null
  /** 为什么某个指标是 null。 */
  missing: string[]
}

/** 取不超过 cap 且不超过周期数的最大偶数块；不足 2 返回 null。 */
function evenBlocks(periods: number, requested?: number): number | null {
  const cap = requested ?? DEFAULT_PBO_BLOCKS
  if (!Number.isFinite(cap)) return null
  const limit = Math.min(Math.floor(cap), periods)
  const even = limit % 2 === 0 ? limit : limit - 1
  return even >= 2 ? even : null
}

function finiteOrZero(value: number): number {
  return Number.isFinite(value) ? value : 0
}

/**
 * 由各试验的收益序列算过拟合指标。收益矩阵按「周期 × 试验」喂给 CSCV：
 * 行的顺序就是时间顺序，块划分才有意义。
 */
export function overfitReport(
  trials: readonly TrialReturns[],
  bestIndex: number,
  opts?: { blocks?: number; metric?: (xs: number[]) => number },
): OverfitReport {
  if (trials.length === 0) throw new RangeError('overfitReport needs at least one trial')
  if (!Number.isInteger(bestIndex) || bestIndex < 0 || bestIndex >= trials.length) {
    throw new RangeError(`bestIndex out of range: ${bestIndex}`)
  }
  const count = trials.length
  const periods = trials[0]?.returns.length ?? 0
  for (let i = 1; i < count; i++) {
    if ((trials[i]?.returns.length ?? 0) !== periods) {
      throw new RangeError('all trials must have equal return length for PBO')
    }
  }

  const missing: string[] = []
  const best = trials[bestIndex]
  const bestSharpe = best === undefined ? 0 : finiteOrZero(sharpe(best.returns))

  // ---- PBO ----
  let pbo: number | null = null
  let pboBlocks: number | null = null
  let pboCombos: number | null = null
  let oosRankMean: number | null = null
  let probLossOos: number | null = null
  const blocks = evenBlocks(periods, opts?.blocks)
  if (count < 2) {
    missing.push('PBO 需要至少 2 个试验')
  } else if (blocks === null) {
    missing.push(`PBO 需要至少 2 个收益周期（当前 ${periods}）`)
  } else {
    const matrix: number[][] = []
    for (let t = 0; t < periods; t++) {
      const row = new Array<number>(count)
      for (let j = 0; j < count; j++) row[j] = trials[j]?.returns[t] ?? 0
      matrix.push(row)
    }
    const result = cscvPbo(matrix, { blocks, metric: opts?.metric })
    pbo = result.pbo
    pboBlocks = blocks
    pboCombos = result.combos
    oosRankMean = result.oosRankMean
    probLossOos = result.probLossOos
  }

  // ---- DSR ----
  let dsrValue: number | null = null
  let trialVariance = 0
  let deflatedBenchmark: number | null = null
  if (count < 2 || best === undefined) {
    missing.push('DSR 需要至少 2 个试验')
  } else {
    trialVariance = finiteOrZero(sharpeOfTrials(trials.map((trial) => trial.returns)).variance)
    const n = best.returns.length
    const skew = n >= 3 ? skewness(best.returns) : 0
    const kurt = n >= 4 ? kurtosis(best.returns) : 3
    deflatedBenchmark = expectedMaxSharpe(count, trialVariance)
    const value = dsr(bestSharpe, { n, nTrials: count, trialVariance, skew, kurt })
    if (Number.isFinite(value)) dsrValue = value
    else missing.push('DSR 不可计算（周期不足或收益退化）')
  }

  return {
    trials: count,
    periods,
    pbo,
    pboBlocks,
    pboCombos,
    oosRankMean,
    probLossOos,
    dsr: dsrValue,
    bestSharpe,
    trialVariance,
    deflatedBenchmark,
    missing,
  }
}

function num(value: number | null, digits = 4): string {
  return value === null ? '不适用' : value.toFixed(digits)
}

/** 一行一行写清三个强制指标；报告首屏与命中控制台共用这段话。 */
export function describeOverfit(report: OverfitReport): string {
  const lines = [
    `试验次数: ${report.trials}`,
    `PBO: ${num(report.pbo)}${report.pboBlocks === null ? '' : `（CSCV 块数 ${report.pboBlocks}，组合 ${report.pboCombos ?? 0}，样本外平均排名 ${num(report.oosRankMean)}，样本外亏损概率 ${num(report.probLossOos)}）`}`,
    `DSR: ${num(report.dsr)}（最优每期 Sharpe ${report.bestSharpe.toFixed(4)}，试验夏普方差 ${report.trialVariance.toFixed(4)}，去膨胀基准 ${num(report.deflatedBenchmark)}）`,
  ]
  if (report.missing.length > 0) lines.push(`指标缺口: ${report.missing.join('；')}`)
  return lines.join('\n')
}
