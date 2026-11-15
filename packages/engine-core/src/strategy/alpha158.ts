// SPDX-License-Identifier: CPAL-1.0
// Alpha158 目录（Qlib 命名）：KBAR 9 + 价格 3 + 滚动 29 族 × 5 窗口 = 157 条。
// 逐条调用 factors-alpha.ts 里已有的因子函数计算；对齐 QD 的 features 命名（qlib_adapter.py:219-227, 298-328）。
import type { Candle } from '../types'
import { alphaFactorById } from './factors-alpha'

/** Qlib Alpha158 的滚动窗口集合（QD `ALPHA158_WINDOWS`）。 */
export const ALPHA158_WINDOWS = [5, 10, 20, 30, 60] as const

/** KBAR 9 条：[Qlib 名, 因子 id]；无窗口，period 记 1。 */
const KBAR_SPECS: ReadonlyArray<readonly [string, string]> = [
  ['KMID', 'kmid'],
  ['KLEN', 'klen'],
  ['KMID2', 'kmid2'],
  ['KUP', 'kup'],
  ['KUP2', 'kup2'],
  ['KLOW', 'klow'],
  ['KLOW2', 'klow2'],
  ['KSFT', 'ksft'],
  ['KSFT2', 'ksft2'],
]

/**
 * 价格 3 条：[Qlib 名, 因子 id]。
 * 不生成 VWAP0：Candle 只有 o/h/l/c/v，没有 vwap 字段（QD 的 Alpha158 有，故 158 - 1 = 157）。
 */
const PRICE_SPECS: ReadonlyArray<readonly [string, string]> = [
  ['OPEN0', 'open0'],
  ['HIGH0', 'high0'],
  ['LOW0', 'low0'],
]

/** 滚动 29 族：[Qlib 名前缀, 因子 id]。 */
const ROLLING_SPECS: ReadonlyArray<readonly [string, string]> = [
  ['ROC', 'roc_n'],
  ['MA', 'ma_n'],
  ['STD', 'std_n'],
  ['BETA', 'beta_n'],
  ['RSQR', 'rsqr_n'],
  ['RESI', 'resi_n'],
  ['MAX', 'max_n'],
  ['MIN', 'min_n'],
  ['QTLU', 'qtlu_n'],
  ['QTLD', 'qtld_n'],
  ['RANK', 'rank_n'],
  ['RSV', 'rsv_n'],
  ['IMAX', 'imax_n'],
  ['IMIN', 'imin_n'],
  ['IMXD', 'imxd_n'],
  ['CORR', 'corr_n'],
  ['CORD', 'cord_n'],
  ['CNTP', 'cntp_n'],
  ['CNTN', 'cntn_n'],
  ['CNTD', 'cntd_n'],
  ['SUMP', 'sump_n'],
  ['SUMN', 'sumn_n'],
  ['SUMD', 'sumd_n'],
  ['VMA', 'vma_n'],
  ['VSTD', 'vstd_n'],
  ['WVMA', 'wvma_n'],
  ['VSUMP', 'vsump_n'],
  ['VSUMN', 'vsumn_n'],
  ['VSUMD', 'vsumd_n'],
]

/**
 * 生成 Alpha158 目录：`name` 为 Qlib 风格名（如 `ROC5`、`VSUMD60`），
 * `factorId` 指向 factors-alpha.ts 的因子 id，`period` 为该条的窗口（KBAR / 价格为 1）。
 */
export function alpha158Catalog(): { name: string; factorId: string; period: number }[] {
  const out: { name: string; factorId: string; period: number }[] = []
  for (const [name, factorId] of KBAR_SPECS) out.push({ name, factorId, period: 1 })
  for (const [name, factorId] of PRICE_SPECS) out.push({ name, factorId, period: 1 })
  for (const window of ALPHA158_WINDOWS) {
    for (const [prefix, factorId] of ROLLING_SPECS) {
      out.push({ name: `${prefix}${window}`, factorId, period: window })
    }
  }
  return out
}

/** 按目录逐条计算，返回 `{ Qlib 名: 序列 }`；每列长度与 candles 一致。 */
export function computeAlpha158(candles: Candle[]): Record<string, (number | null)[]> {
  const out: Record<string, (number | null)[]> = {}
  for (const entry of alpha158Catalog()) {
    const def = alphaFactorById(entry.factorId)
    if (def === undefined) continue
    out[entry.name] = def.compute(candles, { period: entry.period })
  }
  return out
}
