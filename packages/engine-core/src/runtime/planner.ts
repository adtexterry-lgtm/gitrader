// SPDX-License-Identifier: CPAL-1.0
// 目标仓位 → 订单意图（搬运 Demo app/server/strategies.mjs 的 evaluate 里「信号 → 目标名义 → 下单」那一段，改成纯函数）。
// 目标仓位 target ∈ [-1,1] 乘以「分配额」得到目标名义；与当前持仓比较，差额超过阈值才出单；方向反了先整笔平掉（反向开仓等下一轮仓位为 0 后再做）。
import { PROBLEM_CODES, type AccountId, type AccountSnapshot, type Instrument, type OrderIntent } from '../proto'
import { truncToStep, decimalOf } from '../util/decimal'
import { sha256Hex } from '../util/hash'
import type { EffectiveLimits } from './guard'

export interface Sizing {
  /** 占权益的比例（分数，0.1 = 10%）。 */
  allocRatio: number
  /** 单次目标名义上限（计价币）。 */
  allocCapNotional: number
  leverage: number
  /** 市价类允许的最大滑点（基点）。 */
  maxSlippageBps: number
  /** 低于此名义的调仓不做（计价币）。 */
  minStepNotional: number
}

export const DEFAULT_SIZING: Sizing = { allocRatio: 0.1, allocCapNotional: 500, leverage: 1, maxSlippageBps: 50, minStepNotional: 10 }

export type PlanAction = 'none' | 'flatten' | 'add' | 'cut'
export interface Plan {
  action: PlanAction
  side?: 'buy' | 'sell'
  /** 基础资产数量（reduceOnly 单用）。 */
  size?: number
  /** 名义（开仓 / 加仓单用，计价币）。 */
  notional?: number
  reduceOnly?: boolean
  reason: string
}

export interface PlanInput {
  target: number
  price: number
  equity: number
  /** 带符号的持仓数量（基础资产单位，多头为正）。 */
  position: number
  sizing: Sizing
  signalReason: string
  /** 策略自己的名义额上限（可选）；有时取 min(notionalCap, 原有基数)。 */
  notionalCap?: number
}

export function planOrder(i: PlanInput): Plan {
  const { target, price, equity, position, sizing } = i
  if (!(price > 0) || !(equity > 0)) return { action: 'none', reason: 'no price or equity' }
  let alloc = Math.min(sizing.allocCapNotional, equity * sizing.allocRatio)
  if (i.notionalCap !== undefined && i.notionalCap > 0) alloc = Math.min(alloc, i.notionalCap)
  const cur = position * price
  const want = target * alloc
  const threshold = Math.max(sizing.minStepNotional, alloc * 0.05)
  const why = i.signalReason || '目标仓位变化'
  if (cur !== 0 && Math.sign(want) !== Math.sign(cur)) {
    // 方向变了（含目标归零）：先整笔平掉
    return { action: 'flatten', side: position > 0 ? 'sell' : 'buy', size: Math.abs(position), reduceOnly: true, reason: `${why} → 平掉现有${position > 0 ? '多' : '空'}仓` }
  }
  if (Math.abs(want) - Math.abs(cur) > threshold) {
    const add = Math.abs(want) - Math.abs(cur)
    return { action: 'add', side: want > 0 ? 'buy' : 'sell', notional: add, reduceOnly: false, reason: `${why} → 加仓 ${add.toFixed(2)}` }
  }
  if (cur !== 0 && Math.abs(cur) - Math.abs(want) > threshold) {
    const cut = Math.abs(cur) - Math.abs(want)
    return { action: 'cut', side: position > 0 ? 'sell' : 'buy', size: Math.min(Math.abs(position), cut / price), reduceOnly: true, reason: `${why} → 减仓 ${cut.toFixed(2)}` }
  }
  return { action: 'none', reason: 'within threshold' }
}

export type IntentResult = { ok: true; intent: OrderIntent; notional: number; clamped?: string } | { ok: false; skip: string }

/** 把计划变成协议 OrderIntent（十进制字符串、按合约精度向零截断、套用推送下来的限额）。 */
export function buildIntent(plan: Plan, o: {
  accountId: AccountId
  instrumentId: string
  price: number
  rules: Instrument | undefined
  sizing: Sizing
  limits: EffectiveLimits
  reason: string
  /** clientOrderId 的确定性来源（实例、标的、K 线时间等）；最终单号 = hash(来源 + 数量 + 方向)。 */
  cidParts: (string | number)[]
  /** 实例级「单笔数量上限」（基础资产单位）；只会让下单量变小。 */
  sizeCap?: number
}): IntentResult {
  if (plan.action === 'none' || !plan.side) return { ok: false, skip: 'no action' }
  const { rules, limits } = o
  if (rules && (rules.status === 'halted' || rules.status === 'delisted')) return { ok: false, skip: `instrument status ${rules.status}` }
  if (rules && rules.status === 'reduce_only' && !plan.reduceOnly) return { ok: false, skip: 'instrument is reduce_only' }
  let size = plan.size ?? (plan.notional ?? 0) / o.price
  let clamped: string | undefined
  // 推送限额只会让我们少下：单笔名义封顶
  if (limits.maxOrderNotional !== undefined && size * o.price > limits.maxOrderNotional) {
    size = limits.maxOrderNotional / o.price
    clamped = `maxOrderNotional ${limits.maxOrderNotional}`
  }
  if (o.sizeCap !== undefined && o.sizeCap > 0 && size > o.sizeCap) {
    size = o.sizeCap
    clamped = clamped ?? `size cap ${o.sizeCap}`
  }
  const step = rules?.size.step
  const sizeDec = step ? truncToStep(size, step) : decimalOf(size)
  const n = Number(sizeDec)
  if (!(n > 0)) return { ok: false, skip: 'size rounds to zero' }
  if (rules && n < Number(rules.size.min)) return { ok: false, skip: 'below min size' }
  const notional = n * o.price
  if (!plan.reduceOnly && rules?.minNotional !== undefined && notional < Number(rules.minNotional)) return { ok: false, skip: 'below min notional' }
  const slippage = Math.min(o.sizing.maxSlippageBps, limits.maxSlippageBps ?? Infinity)
  let leverage = Math.min(o.sizing.leverage, rules?.maxLeverage ?? Infinity)
  if (limits.maxLeverage !== undefined) leverage = Math.min(leverage, limits.maxLeverage)
  const intent: OrderIntent = {
    accountId: o.accountId,
    instrumentId: o.instrumentId,
    side: plan.side,
    type: 'market',
    size: sizeDec,
    tif: 'ioc',
    reduceOnly: plan.reduceOnly ?? false,
    ...(plan.reduceOnly ? {} : { leverage }),
    maxSlippageBps: slippage,
    rounding: 'reject',
    clientOrderId: deterministicClientOrderId([...o.cidParts, plan.side, plan.reduceOnly ? 'r' : 'o', sizeDec]),
    reason: o.reason.slice(0, 2000),
  }
  return { ok: true, intent, notional, ...(clamped ? { clamped } : {}) }
}

/** 幂等的 clientOrderId：同一实例、同一标的、同一根 K 线、同一动作永远得到同一个（32 位小写十六进制）。 */
export function deterministicClientOrderId(parts: (string | number)[]): string {
  return sha256Hex(parts.join('|')).slice(0, 32)
}

export const CODE_PRECISION = PROBLEM_CODES.PRECISION.code
export const CODE_OUTCOME_UNKNOWN = PROBLEM_CODES.VENUE_OUTCOME_UNKNOWN.code
export const CODE_RULE_DENIED = PROBLEM_CODES.RULE_DENIED.code

export function signedPosition(snap: AccountSnapshot, instrumentId: string): number {
  let sum = 0
  for (const p of snap.positions ?? []) if (p.instrumentId === instrumentId) sum += (p.side === 'long' ? 1 : -1) * Number(p.size)
  return sum
}

/** 推送下来的持仓占比限额：只会把开仓单缩小或取消。 */
export function capByExposure(plan: Plan, o: { price: number; equity: number; snap: AccountSnapshot; instrumentId: string; hasPosition: boolean; limits: { maxPositionNotionalRatio?: number; maxTotalNotionalRatio?: number; maxOpenPositions?: number } }): Plan {
  if (plan.notional === undefined) return plan
  let room = plan.notional
  const thisNotional = Math.abs(signedPosition(o.snap, o.instrumentId)) * o.price
  const total = (o.snap.positions ?? []).reduce((a, p) => a + Math.abs(Number(p.notional)), 0)
  if (o.limits.maxPositionNotionalRatio !== undefined) room = Math.min(room, o.limits.maxPositionNotionalRatio * o.equity - thisNotional)
  if (o.limits.maxTotalNotionalRatio !== undefined) room = Math.min(room, o.limits.maxTotalNotionalRatio * o.equity - total)
  if (o.limits.maxOpenPositions !== undefined && !o.hasPosition && (o.snap.positions ?? []).length >= o.limits.maxOpenPositions) return { action: 'none', reason: 'maxOpenPositions reached' }
  if (!(room > 0)) return { action: 'none', reason: 'pushed exposure limit reached' }
  return room < plan.notional ? { ...plan, notional: room } : plan
}

