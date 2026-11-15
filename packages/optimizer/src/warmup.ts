// SPDX-License-Identifier: CPAL-1.0
// 测试窗预热（warm-up lookback）：每个参数组合先跑一段 K 线、这段时间的成绩不计分，
// 计分从预热之后开始。防的是「参数在数据早期占便宜」——指标还没齐的前几根里，
// 谁的仓位碰巧对着行情走，谁就在寻优里白拿一截分数。
// 参照 QuantDinger 的按参数推回看长度（backend_api_python/app/services/strategy_evolution/engine.py
// 第 524–533 行 `_parameter_lookback_bars`）：参数名里带 period / lookback / window / length / bars 的维度，
// 取其上界的最大值，当作「任何组合最长回看期」的上界；engine.py 第 76–79 行把
// 它和策略自报的 warmupBars 取 max 后交给 walk-forward 计划。本模块只做同一件事的形状推导，
// 代码不照抄（QD 那边按日期和金鱼数算，这里按 K 线下标算）。
import type { ParamSpace } from './space'

/** 参数名里出现这些词，就认为它的取值决定指标回看长度（与 QD 的 tokens 同一份）。 */
export const WARMUP_NAME_TOKENS = ['period', 'lookback', 'window', 'length', 'bars'] as const

/** 预热根数从哪来：调用方显式给 / 按参数名推 / 两者都没有。 */
export type WarmupSource = 'explicit' | 'params' | 'none'

export interface WarmupPlan {
  /** 计入成绩前先跑、不计分的 K 线根数。 */
  bars: number
  source: WarmupSource
}

/**
 * 按参数空间推预热根数：名字命中 {@link WARMUP_NAME_TOKENS} 的数值维度，取其上界的最大值（向上取整）；
 * 一个都没命中返回 0。这就是「同一份空间里最长的那条回看」的上界——所有组合都按它预热，没人更占便宜。
 */
export function parameterLookbackBars(space: ParamSpace): number {
  let max = 0
  for (const key of Object.keys(space)) {
    const spec = space[key]
    if (spec === undefined) continue
    if (spec.type !== 'number' && spec.type !== 'integer') continue
    const name = key.toLowerCase()
    if (!WARMUP_NAME_TOKENS.some((token) => name.includes(token))) continue
    const bound = Math.ceil(spec.max)
    if (Number.isFinite(bound) && bound > max) max = bound
  }
  return max
}

/**
 * 定下本次寻优的预热计划。显式值优先（≥0 的整数，别的直接抛 RangeError，不静默夹）；
 * 没给就按参数名推（QD `_parameter_lookback_bars` 同款），推不出来就是 0 并标 `none`。
 */
export function resolveWarmupBars(space: ParamSpace, explicit?: number): WarmupPlan {
  if (explicit !== undefined) {
    if (!Number.isInteger(explicit) || explicit < 0) {
      throw new RangeError(`warmupBars must be a non-negative integer; got ${String(explicit)}`)
    }
    return { bars: explicit, source: 'explicit' }
  }
  const bars = parameterLookbackBars(space)
  return bars > 0 ? { bars, source: 'params' } : { bars: 0, source: 'none' }
}

/**
 * 把预热根数夹到「还留得下一期成绩」的范围：K 线数 − 2（至少 1 期收益）。
 * 窗口比预热短时用它兜底，而不是抛错——短窗口的折不该让整次寻优失败。
 */
export function clampWarmupBars(bars: number, candleCount: number): number {
  if (!Number.isFinite(bars) || bars <= 0) return 0
  const limit = Math.max(0, Math.floor(candleCount) - 2)
  return Math.min(Math.floor(bars), limit)
}
