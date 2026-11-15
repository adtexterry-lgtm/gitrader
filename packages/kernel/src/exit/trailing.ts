// SPDX-License-Identifier: CPAL-1.0
// 本地出场状态机（纯函数）：固定止损 / 固定止盈 / 追踪止损 / 持仓时限。
// 价格与比例全部走十进制定点工具，不碰浮点；不做任何 I/O，状态可 JSON 往返。
import * as d from '../util/dec'

export type ExitSide = 'long' | 'short'

export interface TrailingSpec {
  side: ExitSide
  entryPrice: string
  callbackRatio: string
  activationRatio?: string
  activationPrice?: string
  stopLossPrice?: string
  takeProfitPrice?: string
  timeLimitMs?: number
  openedAt: number
}

export type ExitReason = 'stop_loss' | 'time_limit' | 'trailing' | 'take_profit'

export interface ExitHit { reason: ExitReason; price: string; ts: number }

export interface TrailingState {
  active: boolean
  extreme: string
  lastPrice?: string
  lastTs?: number
  fired?: ExitHit
}

interface ParsedSpec {
  entry: d.Dec
  callbackRatio: d.Dec
  activation?: d.Dec
  stopLoss?: d.Dec
  takeProfit?: d.Dec
}

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/strategy_v2/protection.py:11-30; adapted (decimal strings, no clamping).
function parseDec(field: string, value: string): d.Dec {
  try {
    return d.D(value)
  } catch {
    throw new Error(`invalid ${field}: ${value}`)
  }
}

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/live_trading/native_protection.py:56-70; adapted (explicit activation price wins over ratio).
function parseSpec(spec: TrailingSpec): ParsedSpec {
  const entry = parseDec('entryPrice', spec.entryPrice)
  const callbackRatio = parseDec('callbackRatio', spec.callbackRatio)
  if (!d.gt(callbackRatio, d.ZERO)) throw new Error('invalid callbackRatio: must be > 0')
  const parsed: ParsedSpec = { entry, callbackRatio }
  if (spec.activationPrice !== undefined) {
    parsed.activation = parseDec('activationPrice', spec.activationPrice)
  } else if (spec.activationRatio !== undefined) {
    const ratio = parseDec('activationRatio', spec.activationRatio)
    const delta = d.mul(entry, ratio)
    parsed.activation = spec.side === 'long' ? d.add(entry, delta) : d.sub(entry, delta)
  }
  if (spec.stopLossPrice !== undefined) parsed.stopLoss = parseDec('stopLossPrice', spec.stopLossPrice)
  if (spec.takeProfitPrice !== undefined) parsed.takeProfit = parseDec('takeProfitPrice', spec.takeProfitPrice)
  return parsed
}

const isLong = (spec: TrailingSpec): boolean => spec.side === 'long'

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/strategy_v2/protection.py:95-111; adapted (entry-only initial state).
export function initTrailing(spec: TrailingSpec): TrailingState {
  const parsed = parseSpec(spec)
  // 没给激活条件 = 立即激活；显式激活价优先于比例。
  const immediate = parsed.activation === undefined
  return { active: immediate, extreme: d.str(parsed.entry) }
}

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/strategy_v2/protection.py:210-316; adapted (single tick, immutable state).
export function stepTrailing(spec: TrailingSpec, state: TrailingState, price: string, ts: number): { state: TrailingState; fire?: ExitHit } {
  const tick = parseDec('price', price)
  // QD protection.py:214-217 对 price ≤ 0 返回 None 跳过；这里改为显式拒绝。
  if (!d.gt(tick, d.ZERO)) throw new Error(`invalid price: must be > 0: ${price}`)
  if (state.fired) return { state }
  const parsed = parseSpec(spec)
  const tickStr = d.str(tick)
  const long = isLong(spec)

  let active = state.active
  let extreme = d.D(state.extreme)
  // QD protection.py:209-226 在激活前也更新极值；这里按工单要求激活后才跟踪。
  // 逐 tick 推进时两者结果等价：激活那一 tick 的价格即成为新极值（未激活时 extreme 保持 entryPrice）。
  if (!active) {
    if (parsed.activation === undefined) active = true
    else if (long ? d.gte(tick, parsed.activation) : d.lte(tick, parsed.activation)) active = true
  }
  if (active) extreme = long ? d.max(extreme, tick) : d.min(extreme, tick)
  const extremeStr = d.str(extreme)

  const hits: ExitHit[] = []
  if (parsed.stopLoss && (long ? d.lte(tick, parsed.stopLoss) : d.gte(tick, parsed.stopLoss))) {
    hits.push({ reason: 'stop_loss', price: tickStr, ts })
  }
  if (active) {
    const stop = long
      ? d.mul(extreme, d.sub(d.ONE, parsed.callbackRatio))
      : d.mul(extreme, d.add(d.ONE, parsed.callbackRatio))
    if (long ? d.lte(tick, stop) : d.gte(tick, stop)) hits.push({ reason: 'trailing', price: tickStr, ts })
  }
  if (parsed.takeProfit && (long ? d.gte(tick, parsed.takeProfit) : d.lte(tick, parsed.takeProfit))) {
    hits.push({ reason: 'take_profit', price: tickStr, ts })
  }
  if (spec.timeLimitMs !== undefined && spec.timeLimitMs > 0 && ts - spec.openedAt >= spec.timeLimitMs) {
    hits.push({ reason: 'time_limit', price: tickStr, ts })
  }

  const fire = chooseExit(hits)
  const next: TrailingState = { ...state, active, extreme: extremeStr, lastPrice: tickStr, lastTs: ts }
  if (fire) next.fired = fire
  return fire ? { state: next, fire } : { state: next }
}

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/strategy_v2/protection.py:295-316; adapted (returns undefined while inactive).
export function trailingStopPrice(spec: TrailingSpec, state: TrailingState): string | undefined {
  if (!state.active) return undefined
  const parsed = parseSpec(spec)
  const extreme = parseDec('extreme', state.extreme)
  const stop = isLong(spec)
    ? d.mul(extreme, d.sub(d.ONE, parsed.callbackRatio))
    : d.mul(extreme, d.add(d.ONE, parsed.callbackRatio))
  return d.str(stop)
}

// QD 默认 intrabar 模式 _choose 的优先级：stop_loss > trailing_stop > time_limit > take_profit
// （protection.py:333-334；aggressive/balanced 模式另算，这里只移植默认模式）。同优先级时保留入参顺序。
const PRIORITY: Readonly<Record<ExitReason, number>> = {
  stop_loss: 0,
  trailing: 1,
  time_limit: 2,
  take_profit: 3,
}

export function chooseExit(hits: ExitHit[]): ExitHit | undefined {
  let best: ExitHit | undefined
  let bestRank = Number.POSITIVE_INFINITY
  for (const hit of hits) {
    const rank = PRIORITY[hit.reason] ?? 9
    if (rank < bestRank) {
      best = hit
      bestRank = rank
    }
  }
  return best
}

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/live_trading/native_protection.py:37-71; adapted (sl adverse, tp favorable).
export function pctToPrice(entryPrice: string, side: ExitSide, pct: string, kind: 'sl' | 'tp'): string {
  const entry = parseDec('entryPrice', entryPrice)
  const ratio = parseDec('pct', pct)
  // QD native_protection.py:358-363 对非法入参返回 0 作哨兵；这里改为抛错。
  if (!d.gt(entry, d.ZERO)) throw new Error(`invalid entryPrice: must be > 0: ${entryPrice}`)
  if (!d.gt(ratio, d.ZERO)) throw new Error(`invalid pct: must be > 0: ${pct}`)
  const delta = d.mul(entry, ratio)
  const value = side === 'long'
    ? (kind === 'sl' ? d.sub(entry, delta) : d.add(entry, delta))
    : (kind === 'sl' ? d.add(entry, delta) : d.sub(entry, delta))
  return d.str(value)
}

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/live_trading/native_protection.py:358-363; adapted (decimal strings).
export function activationPriceFor(entryPrice: string, side: ExitSide, activationRatio: string): string {
  const entry = parseDec('entryPrice', entryPrice)
  const ratio = parseDec('activationRatio', activationRatio)
  // QD native_protection.py:358-363 对非法入参返回 0 作哨兵；这里改为抛错。
  if (!d.gt(entry, d.ZERO)) throw new Error(`invalid entryPrice: must be > 0: ${entryPrice}`)
  if (!d.gt(ratio, d.ZERO)) throw new Error(`invalid activationRatio: must be > 0: ${activationRatio}`)
  const delta = d.mul(entry, ratio)
  return d.str(side === 'long' ? d.add(entry, delta) : d.sub(entry, delta))
}
