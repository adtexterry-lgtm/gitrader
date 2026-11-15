// SPDX-License-Identifier: CPAL-1.0
// 仓位保护：止损 / 止盈 / 移动止损 / 时限。输入一根 K 线，输出「应当出场」的判定与成交价；
// 只给出判定，不做任何可被策略覆盖的放宽（QD 的软约束语义不移植）。
import type { Bar } from './ta/types'

export interface ProtectionConfig {
  stopLossPct?: number
  takeProfitPct?: number
  trailing?: { activationPct: number; trailPct: number }
  maxHoldBars?: number
}

export interface ProtectionState {
  side: 'long' | 'short'
  entryPrice: number
  entryBar: number
  highestSinceEntry: number
  lowestSinceEntry: number
  trailingArmed: boolean
}

export type ExitReason = 'stop_loss' | 'take_profit' | 'trailing_stop' | 'time_limit'

type Raw = Record<string, unknown>

/** 空值（未提供）与 0 区分开：null / undefined / 空串都算未提供，0 是有效值。 */
function pick(raw: Raw, keys: string[]): unknown {
  for (const key of keys) {
    const value = raw[key]
    if (value === undefined || value === null) continue
    if (typeof value === 'string' && value.trim() === '') continue
    return value
  }
  return undefined
}

/**
 * 百分数与小数统一成小数比例。QD 的 _ratio 用「绝对值是否 > 1」区分两种写法，
 * 所以 2 → 0.02、0.02 → 0.02。本模块把边界收紧到「≥ 1 即按百分数」，因此 1 → 0.01；
 * 带 `%` 后缀的字符串按百分数解析（'5%' → 0.05），因为 QD 的 _float 不认后缀，这里按宽松输入的需求补齐。
 */
function ratio(value: unknown, field: string, maximum: number): number {
  let number = Number.NaN
  let explicitPercent = false
  if (typeof value === 'number') {
    number = value
  } else if (typeof value === 'string') {
    const text = value.trim()
    if (text.endsWith('%')) {
      explicitPercent = true
      number = Number(text.slice(0, -1))
    } else {
      number = Number(text)
    }
  }
  if (!Number.isFinite(number)) throw new RangeError(`${field}: not a finite number`)
  const out = explicitPercent || Math.abs(number) >= 1 ? number / 100 : number
  if (out < 0 || out > maximum) throw new RangeError(`${field}: out of range [0, ${maximum}]`)
  return out
}

/** 时限按整根 K 线计；负数或非有限值拒绝。 */
function integer(value: unknown, field: string): number {
  const number = typeof value === 'number' ? value : Number(String(value).trim())
  if (!Number.isFinite(number)) throw new RangeError(`${field}: not a finite number`)
  if (number < 0) throw new RangeError(`${field}: must be >= 0`)
  return Math.floor(number)
}

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/strategy_runtime/executors.py:71; adapted.
// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/strategy_v2/protection.py:49; adapted.
/** 宽松输入 → ProtectionConfig：百分比 / 小数、字符串、trailing 平铺字段或子对象都接受；非法值抛 RangeError。 */
export function normalizeProtection(raw: Record<string, unknown>): ProtectionConfig {
  const cfg: ProtectionConfig = {}

  const stopLoss = pick(raw, ['stopLossPct', 'stop_loss_pct'])
  // QD 的 ProtectionSpec 上限：stopLossPct / trailPct ≤ 1，takeProfitPct / activationPct ≤ 5。
  if (stopLoss !== undefined) cfg.stopLossPct = ratio(stopLoss, 'stopLossPct', 1)

  const takeProfit = pick(raw, ['takeProfitPct', 'take_profit_pct'])
  if (takeProfit !== undefined) cfg.takeProfitPct = ratio(takeProfit, 'takeProfitPct', 5)

  const maxHoldBars = pick(raw, ['maxHoldBars', 'max_hold_bars'])
  if (maxHoldBars !== undefined) cfg.maxHoldBars = integer(maxHoldBars, 'maxHoldBars')

  const nested = raw.trailing
  const trailingRaw: Raw | undefined = typeof nested === 'object' && nested !== null ? (nested as Raw) : undefined
  // 平铺字段优先于 trailing 子对象（QD 用 setdefault，平铺值不被覆盖）。
  const activation =
    pick(raw, ['trailingActivationPct', 'trailing_activation_pct']) ??
    (trailingRaw ? pick(trailingRaw, ['activationPct', 'activation_pct', 'activation']) : undefined)
  const trail =
    pick(raw, ['trailingTrailPct', 'trailing_trail_pct', 'trailingStopPct', 'trailing_stop_pct']) ??
    (trailingRaw ? pick(trailingRaw, ['trailPct', 'trail_pct', 'pct', 'stopPct', 'stop_pct']) : undefined)

  if (trail !== undefined) {
    // QD 允许只给 trailing_stop_pct，此时 trailing_activation_pct 默认 0（最高 / 最低价一到就激活）。
    const activationPct = activation !== undefined ? ratio(activation, 'trailingActivationPct', 5) : 0
    cfg.trailing = { activationPct, trailPct: ratio(trail, 'trailingTrailPct', 1) }
  } else if (activation !== undefined) {
    throw new RangeError('trailingTrailPct: trailing activation requires a trail distance')
  }
  return cfg
}

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/strategy_v2/protection.py:86; adapted.
/** 开仓即建立保护状态：最高 / 最低都从入场价起算，移动止损未激活。 */
export function openProtection(side: 'long' | 'short', entryPrice: number, entryBar: number): ProtectionState {
  return {
    side,
    entryPrice,
    entryBar,
    highestSinceEntry: entryPrice,
    lowestSinceEntry: entryPrice,
    trailingArmed: false,
  }
}

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/strategy_v2/protection.py:292; adapted.
/** 移动止损激活：多头看入场以来的最高价，空头看最低价。 */
function armTrailing(state: ProtectionState, cfg: ProtectionConfig): void {
  const trailing = cfg.trailing
  if (!trailing || trailing.trailPct <= 0 || state.trailingArmed) return
  if (state.side === 'long') {
    if (state.highestSinceEntry >= state.entryPrice * (1 + trailing.activationPct)) state.trailingArmed = true
    return
  }
  if (state.lowestSinceEntry <= state.entryPrice * (1 - trailing.activationPct)) state.trailingArmed = true
}

/** 激活后的回撤触发价；未激活则没有触发价。 */
function trailingTrigger(state: ProtectionState, cfg: ProtectionConfig): number | undefined {
  const trailing = cfg.trailing
  if (!trailing || trailing.trailPct <= 0 || !state.trailingArmed) return undefined
  return state.side === 'long'
    ? state.highestSinceEntry * (1 - trailing.trailPct)
    : state.lowestSinceEntry * (1 + trailing.trailPct)
}

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/strategy_v2/protection.py:319; adapted.
/**
 * 同根 K 线同时触及多个保护条件时的优先级，照 QD 的默认 intrabar 档位：
 * stop_loss(0) → trailing_stop(1) → time_limit(2) → take_profit(3)。
 * 即同一根里既打止损又打止盈时，判定为止损。
 */
const PRIORITY: Record<ExitReason, number> = {
  stop_loss: 0,
  trailing_stop: 1,
  time_limit: 2,
  take_profit: 3,
}

function choose(candidates: Array<{ reason: ExitReason; price: number }>): { reason: ExitReason; price: number } | null {
  let best: { reason: ExitReason; price: number } | null = null
  for (const candidate of candidates) {
    if (best === null || PRIORITY[candidate.reason] < PRIORITY[best.reason]) best = candidate
  }
  return best
}

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/strategy_v2/protection.py:189; adapted.
// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/strategy_v2/protection.py:231; adapted.
/**
 * 用一根 K 线检查保护条件：
 * 1) 先处理跳空——开盘价已越过触发价时按开盘价成交，否则按触发价成交；
 * 2) 再按盘中优先级在候选里挑一个（见 PRIORITY）；
 * 3) 无出场时更新最高 / 最低，并按收盘后的极值刷新移动止损激活标记。
 * QD 的时限在 bar 层用开盘价成交，这里按本模块约定改用收盘价。
 */
export function evaluateProtection(
  state: ProtectionState,
  bar: Bar & { index: number },
  cfg: ProtectionConfig,
): { exit: { reason: ExitReason; price: number } | null; state: ProtectionState } {
  const next: ProtectionState = { ...state }
  const open = bar.o
  const high = Math.max(open, bar.h)
  const low = Math.min(open, bar.l)
  const isLong = next.side === 'long'
  const candidates: Array<{ reason: ExitReason; price: number }> = []

  const stopLossPct = cfg.stopLossPct
  if (stopLossPct !== undefined && stopLossPct > 0) {
    const trigger = next.entryPrice * (isLong ? 1 - stopLossPct : 1 + stopLossPct)
    const touched = isLong ? low <= trigger : high >= trigger
    if (touched) {
      const gapped = isLong ? open <= trigger : open >= trigger
      candidates.push({ reason: 'stop_loss', price: gapped ? open : trigger })
    }
  }

  armTrailing(next, cfg)
  const trail = trailingTrigger(next, cfg)
  if (trail !== undefined) {
    const touched = isLong ? low <= trail : high >= trail
    if (touched) {
      const gapped = isLong ? open <= trail : open >= trail
      candidates.push({ reason: 'trailing_stop', price: gapped ? open : trail })
    }
  }

  const takeProfitPct = cfg.takeProfitPct
  if (takeProfitPct !== undefined && takeProfitPct > 0) {
    const trigger = next.entryPrice * (isLong ? 1 + takeProfitPct : 1 - takeProfitPct)
    const touched = isLong ? high >= trigger : low <= trigger
    if (touched) {
      const gapped = isLong ? open >= trigger : open <= trigger
      candidates.push({ reason: 'take_profit', price: gapped ? open : trigger })
    }
  }

  const maxHoldBars = cfg.maxHoldBars
  if (maxHoldBars !== undefined && maxHoldBars > 0 && bar.index - next.entryBar >= maxHoldBars) {
    candidates.push({ reason: 'time_limit', price: bar.c })
  }

  const exit = choose(candidates)
  if (exit !== null) return { exit, state: next }

  next.highestSinceEntry = Math.max(next.highestSinceEntry, high)
  next.lowestSinceEntry = Math.min(next.lowestSinceEntry, low)
  armTrailing(next, cfg)
  return { exit: null, state: next }
}
