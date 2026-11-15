// SPDX-License-Identifier: CPAL-1.0
// 回测证据统计附件：从权益曲线算每期收益，给出 Sharpe / PSR / DSR / 偏度峰度 / 自助法区间。纯函数，不碰 IO。
import { sharpe, annualizeSharpe, skewness, kurtosis, psr, dsr, circularBlockBootstrap } from '@gitrader/stats'

export interface EvidenceInput {
  /** 权益曲线（按 t 升序；与 BacktestResult.equity 同形）。 */
  equity: readonly { t: number; v: number }[]
  /** 为选出这条结果一共试了多少组参数；缺省 1（不去膨胀）。 */
  trialCount?: number
  /** 多试验时各试验每期 Sharpe 的横截面方差；缺省 0。 */
  trialVariance?: number
  /** 自助法随机种子；缺省 1。 */
  seed?: number
  /** 自助法重抽样次数；缺省 500。 */
  bootstrapSamples?: number
}

export interface EvidenceSummary {
  /** 收益期数 = periodReturns(equity).length。 */
  periods: number
  /** 期长（毫秒）= 相邻 equity 点时间差的中位数；少于 2 个点时为 0。 */
  periodMs: number
  /** = 365 * 86_400_000 / periodMs；periodMs 为 0 时为 0。 */
  periodsPerYear: number
  sharpe: number
  sharpeAnnualized: number
  psr: number | null
  dsr: number | null
  skewness: number
  kurtosis: number
  /** 每期 Sharpe 的 95% 循环块自助法区间；periods < 30 时为 null。 */
  sharpeCi95: [number, number] | null
  trialCount: number
  warnings: string[]
}

/** 每期简单收益 r_i = v_i / v_{i-1} - 1；v_{i-1} <= 0 或任一值非有限数的那一期跳过。 */
export function periodReturns(equity: readonly { t: number; v: number }[]): number[] {
  const returns: number[] = []
  for (let i = 1; i < equity.length; i++) {
    const prev = equity[i - 1]!
    const cur = equity[i]!
    if (!Number.isFinite(prev.v) || !Number.isFinite(cur.v)) continue
    if (prev.v <= 0) continue
    returns.push(cur.v / prev.v - 1)
  }
  return returns
}

function medianPeriodMs(equity: readonly { t: number; v: number }[]): number {
  const diffs: number[] = []
  for (let i = 1; i < equity.length; i++) {
    const dt = equity[i]!.t - equity[i - 1]!.t
    if (dt > 0) diffs.push(dt)
  }
  if (diffs.length === 0) return 0
  diffs.sort((a, b) => a - b)
  const mid = Math.floor(diffs.length / 2)
  if (diffs.length % 2 === 1) return diffs[mid]!
  return (diffs[mid - 1]! + diffs[mid]!) / 2
}

export function summarizeEvidence(input: EvidenceInput): EvidenceSummary {
  const returns = periodReturns(input.equity)
  const periods = returns.length
  const trialCount = Math.max(1, Math.floor(input.trialCount ?? 1))
  const periodMs = medianPeriodMs(input.equity)
  const periodsPerYear = periodMs > 0 ? (365 * 86_400_000) / periodMs : 0

  if (periods < 2) {
    return {
      periods,
      periodMs,
      periodsPerYear,
      sharpe: 0,
      sharpeAnnualized: 0,
      psr: null,
      dsr: null,
      skewness: 0,
      kurtosis: 0,
      sharpeCi95: null,
      trialCount,
      warnings: ['fewer than 2 returns'],
    }
  }

  const flat = returns.every((r) => r === returns[0])
  const sr = sharpe(returns)
  const skew = periods >= 3 ? skewness(returns) : 0
  // 统计包的 kurtosis 在少于四期时返回 0（不可用），这里退回正态值 3。
  const kurt = periods >= 4 ? kurtosis(returns) : 3
  const p = flat ? NaN : psr(sr, { n: periods, skew, kurt })
  const d =
    trialCount > 1
      ? flat
        ? NaN
        : dsr(sr, {
            n: periods,
            nTrials: trialCount,
            trialVariance: input.trialVariance ?? 0,
            skew,
            kurt,
          })
      : null
  const ciRaw =
    periods >= 30
      ? circularBlockBootstrap(returns, {
          blockLen: Math.max(2, Math.round(Math.cbrt(periods))),
          samples: input.bootstrapSamples ?? 500,
          seed: input.seed ?? 1,
          level: 0.95,
        }).ci
      : null

  const warnings: string[] = []
  const finiteNumber = (field: string, value: number): number => {
    if (Number.isFinite(value)) return value
    warnings.push(`${field} is not finite; set to 0`)
    return 0
  }
  const nullableNumber = (field: string, value: number | null): number | null => {
    if (value === null) return null
    if (Number.isFinite(value)) return value
    warnings.push(`${field} is not finite; set to null`)
    return null
  }

  const cleanSharpe = finiteNumber('sharpe', sr)
  const cleanPeriodsPerYear = finiteNumber('periodsPerYear', periodsPerYear)
  const cleanPsr = nullableNumber('psr', p)
  const cleanDsr = nullableNumber('dsr', d)
  let cleanCi: [number, number] | null = null
  if (ciRaw !== null) {
    if (Number.isFinite(ciRaw[0]) && Number.isFinite(ciRaw[1])) cleanCi = ciRaw
    else warnings.push('sharpeCi95 is not finite; set to null')
  }

  return {
    periods: finiteNumber('periods', periods),
    periodMs: finiteNumber('periodMs', periodMs),
    periodsPerYear: cleanPeriodsPerYear,
    sharpe: cleanSharpe,
    sharpeAnnualized: finiteNumber(
      'sharpeAnnualized',
      annualizeSharpe(cleanSharpe, cleanPeriodsPerYear),
    ),
    psr: cleanPsr,
    dsr: cleanDsr,
    skewness: finiteNumber('skewness', skew),
    kurtosis: finiteNumber('kurtosis', kurt),
    sharpeCi95: cleanCi,
    trialCount: finiteNumber('trialCount', trialCount),
    warnings,
  }
}
