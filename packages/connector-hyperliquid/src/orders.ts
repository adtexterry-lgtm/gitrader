// SPDX-License-Identifier: CPAL-1.0
// OrderIntent → Hyperliquid 线上订单（纯函数，无网络、无签名；单测直接断言线上字节形状）。
// 语义出处：知识库「订单类型与TP-SL语义」「API_info与exchange要点_速率限制」。
//   · 市价 = 带滑点上限的 IOC 限价（能力声明 market: emulated / ioc_limit）；
//   · TP/SL：以标记价触发；父子单（normalTpsl）父单部分成交后被撤则子单全撤，仓位级（positionTpsl）单独成组；
//   · 价格规则 ≤5 位有效数字且小数位 ≤ 6 − szDecimals；数量向零截断；签名前去尾随 0（wire() 即规范形）。
import { makeProblem } from '@gitrader/protocol'
import type { OrderIntent, Problem } from '@gitrader/protocol'
import { randomBytes } from 'node:crypto'
import { ProblemError } from './errors'
import { div, fx, mul, str } from '@gitrader/protocol/decimal'
import type { Fx } from '@gitrader/protocol/decimal'
import type { InstrumentRecord } from './parse'
import { MIN_ORDER_NOTIONAL } from './parse'
import { isValidPrice, maxPriceDecimals, snapPrice, truncSize, wire } from './precision'
import type { Hex } from '@gitrader/protocol/connector'

export type WireTif = 'Gtc' | 'Ioc' | 'Alo'
export interface WireOrder {
  a: number
  b: boolean
  p: string
  s: string
  r: boolean
  t: { limit: { tif: WireTif } } | { trigger: { isMarket: boolean; triggerPx: string; tpsl: 'tp' | 'sl' } }
  c?: Hex
}
export type WireGrouping = 'na' | 'normalTpsl' | 'positionTpsl'
export type OrderRole = 'parent' | 'tp' | 'sl'

export interface BuiltOrder {
  orders: WireOrder[]
  roles: OrderRole[]
  grouping: WireGrouping
  clientOrderId: string
  /** 价格被规整（passive）时记录原值与新值，供回执展示。 */
  rounded?: { field: string; from: string; to: string }[]
}

/** 官方：builder 费以十分之一个基点计，Gitrader 固定 1 bp = 10（= 0.01%）。 */
export const BUILDER_FEE_TENTH_BPS = 10
/** approveBuilderFee 的 maxFeeRate 是百分比字符串：10 / 1000 % = 0.01%。 */
export function builderMaxFeeRate(tenthBps: number = BUILDER_FEE_TENTH_BPS): string {
  return str(div(fx(tenthBps), fx(1000))) + '%'
}

const bad = (name: 'INSTRUMENT_UNKNOWN' | 'PRECISION' | 'MIN_NOTIONAL' | 'ORDER_TYPE_UNSUPPORTED' | 'INVALID_PARAMS' | 'STALE_PRICE', message: string, extra: Partial<Problem> = {}): Problem =>
  makeProblem(name, message, extra)

export class OrderBuildError extends ProblemError {
  constructor(problem: Problem) {
    super(problem)
    this.name = 'OrderBuildError'
  }
}
const fail = (p: Problem): never => { throw new OrderBuildError(p) }

export function newClientOrderId(): string {
  return randomBytes(16).toString('hex')
}
const cloidHex = (id: string): Hex => `0x${id.toLowerCase()}`

export interface PriceRef {
  /** 买一 / 卖一 / 中间价；市价类与按名义额折算数量需要。 */
  bid?: number
  ask?: number
  mid?: number
  stale?: boolean
}

function normalizePrice(label: string, raw: string, rec: InstrumentRecord, mode: 'reject' | 'passive', side: 'buy' | 'sell', rounded: BuiltOrder['rounded']): Fx {
  let p: Fx
  try { p = fx(raw) } catch { return fail(bad('INVALID_PARAMS', `${label} is not a decimal number: ${JSON.stringify(raw)}`)) }
  if (p <= 0n) fail(bad('INVALID_PARAMS', `${label} must be greater than zero`))
  if (isValidPrice(p, rec.szDecimals)) return p
  if (mode === 'reject') {
    fail(bad('PRECISION', `${label} ${raw} violates the tick rule for ${rec.instrument.symbol}: at most 5 significant figures and ${maxPriceDecimals(rec.szDecimals)} decimals (integers are always valid)`))
  }
  // passive：买单向下、卖单向上，永不朝成交方向取整
  const snapped = snapPrice(p, rec.szDecimals, side === 'buy' ? 'down' : 'up')
  if (snapped <= 0n) fail(bad('PRECISION', `${label} ${raw} rounds to zero for ${rec.instrument.symbol}`))
  rounded?.push({ field: label, from: raw, to: str(snapped) })
  return snapped
}

function triggerExecutionPrice(trigger: Fx, side: 'buy' | 'sell', maxSlippageBps: number | undefined, rec: InstrumentRecord): Fx {
  if (maxSlippageBps === undefined) return trigger
  const slip = div(fx(maxSlippageBps), fx(10000))
  const target = side === 'buy' ? trigger + mul(trigger, slip) : trigger - mul(trigger, slip)
  const snapped = snapPrice(target, rec.szDecimals, side === 'buy' ? 'down' : 'up')
  if (side === 'buy' && snapped < trigger) return trigger
  if (side === 'sell' && snapped > trigger) return trigger
  return snapped
}

/** 单个 OrderIntent → 线上订单（含 TP/SL 子单）。无法构造时抛 OrderBuildError（带 Problem）。 */
export function buildOrder(intent: OrderIntent, rec: InstrumentRecord | undefined, ref: PriceRef = {}): BuiltOrder {
  if (!rec) return fail(bad('INSTRUMENT_UNKNOWN', `unknown instrument ${intent.instrumentId}`))
  if (rec.instrument.status === 'delisted') return fail(bad('INSTRUMENT_UNKNOWN', `${intent.instrumentId} is delisted`))
  const type = intent.type
  if (!['market', 'limit', 'stop_market', 'stop_limit', 'take_market', 'take_limit'].includes(type)) {
    fail(bad('ORDER_TYPE_UNSUPPORTED', `order type ${type} is not supported by this connector`))
  }
  if (intent.triggerType && intent.triggerType !== 'mark') {
    fail(bad('ORDER_TYPE_UNSUPPORTED', `trigger price type ${intent.triggerType} is not supported (venue triggers on mark price)`))
  }
  const mode = intent.rounding ?? 'reject'
  const rounded: NonNullable<BuiltOrder['rounded']> = []
  const isBuy = intent.side === 'buy'
  const trigger = type === 'stop_market' || type === 'stop_limit' || type === 'take_market' || type === 'take_limit'

  // ---- tif ----
  let tif: WireTif
  if (type === 'market') {
    tif = 'Ioc'
  } else if (intent.postOnly || intent.tif === 'alo') {
    if (intent.tif === 'ioc') fail(bad('ORDER_TYPE_UNSUPPORTED', 'postOnly cannot be combined with tif ioc'))
    tif = 'Alo'
  } else {
    const t = intent.tif ?? 'gtc'
    if (t === 'gtc') tif = 'Gtc'
    else if (t === 'ioc') tif = 'Ioc'
    else return fail(bad('ORDER_TYPE_UNSUPPORTED', `time in force ${t} is not supported (venue supports gtc / ioc / alo)`))
  }
  if (trigger && (intent.tif && intent.tif !== 'gtc')) fail(bad('ORDER_TYPE_UNSUPPORTED', 'trigger orders do not take a time in force'))

  // ---- 价格 ----
  let price: Fx
  let triggerPx: Fx | undefined
  const mid = ref.mid ?? (ref.bid && ref.ask ? (ref.bid + ref.ask) / 2 : undefined)
  if (type === 'market') {
    if (intent.maxSlippageBps === undefined) fail(bad('INVALID_PARAMS', 'market orders need maxSlippageBps (no implicit default slippage)'))
    if (mid === undefined || ref.stale) fail(bad('STALE_PRICE', `no fresh price for ${intent.instrumentId}; cannot emulate a market order`, { retryAfterMs: 1000 }))
    const m = fx(mid!)
    const slip = div(fx(intent.maxSlippageBps!), fx(10000))
    // 滑点上限：买单价格取不超过上限的刻度（向下），卖单取不低于下限的刻度（向上）
    const target = isBuy ? m + mul(m, slip) : m - mul(m, slip)
    price = snapPrice(target, rec.szDecimals, isBuy ? 'down' : 'up')
  } else if (type === 'limit' || type === 'stop_limit' || type === 'take_limit') {
    if (intent.price === undefined) fail(bad('INVALID_PARAMS', `${type} orders need price`))
    price = normalizePrice('price', intent.price!, rec, mode, intent.side, rounded)
  } else {
    // stop_market / take_market：p 取（给了就用）价格，否则触发价本身
    price = 0n
  }
  if (trigger) {
    if (intent.triggerPrice === undefined) fail(bad('INVALID_PARAMS', `${type} orders need triggerPrice`))
    triggerPx = normalizePrice('triggerPrice', intent.triggerPrice!, rec, mode, intent.side, rounded)
    if (type === 'stop_market' || type === 'take_market') {
      price = intent.price !== undefined
        ? normalizePrice('price', intent.price, rec, mode, intent.side, rounded)
        : triggerExecutionPrice(triggerPx, intent.side, intent.maxSlippageBps, rec)
    }
  }

  // ---- 数量 ----
  const priceForNotional = trigger ? (triggerPx as Fx) : price
  let size: Fx
  if (intent.size !== undefined) {
    try { size = fx(intent.size) } catch { return fail(bad('INVALID_PARAMS', `size is not a decimal number: ${JSON.stringify(intent.size)}`)) }
  } else if (intent.notional !== undefined) {
    const ref0 = mid !== undefined ? fx(mid) : priceForNotional
    if (ref0 <= 0n) return fail(bad('STALE_PRICE', `no price to convert notional for ${intent.instrumentId}`, { retryAfterMs: 1000 }))
    size = div(fx(intent.notional), ref0)
  } else {
    return fail(bad('INVALID_PARAMS', 'order needs size or notional'))
  }
  if (size <= 0n) fail(bad('INVALID_PARAMS', 'size must be greater than zero'))
  const sz = truncSize(size, rec.szDecimals)
  if (sz <= 0n) {
    fail(bad('PRECISION', `size ${str(size)} is below the lot step 1e-${rec.szDecimals} for ${rec.instrument.symbol} (sizes truncate toward zero)`))
  }
  const notional = mul(sz, priceForNotional)
  if (!intent.reduceOnly && notional < fx(MIN_ORDER_NOTIONAL)) {
    fail(bad('MIN_NOTIONAL', `order value ${str(notional, 4)} is below the venue minimum of ${MIN_ORDER_NOTIONAL} USDC (reduce-only orders are exempt)`))
  }

  const clientOrderId = intent.clientOrderId ?? newClientOrderId()
  const parent: WireOrder = {
    a: rec.assetId,
    b: isBuy,
    p: wire(price),
    s: wire(sz),
    r: !!intent.reduceOnly,
    t: trigger
      ? { trigger: { isMarket: type === 'stop_market' || type === 'take_market', triggerPx: wire(triggerPx as Fx), tpsl: type.startsWith('stop') ? 'sl' : 'tp' } }
      : { limit: { tif } },
    c: cloidHex(clientOrderId),
  }
  const orders: WireOrder[] = [parent]
  const roles: OrderRole[] = ['parent']
  let grouping: WireGrouping = 'na'

  if (intent.tpsl) {
    if (trigger) fail(bad('ORDER_TYPE_UNSUPPORTED', 'tpsl cannot be attached to a trigger order'))
    grouping = intent.tpsl.grouping === 'position' ? 'positionTpsl' : 'normalTpsl'
    const child = (role: 'tp' | 'sl', leg: { triggerPrice: string; price?: string }): WireOrder => {
      const legSide = isBuy ? 'sell' : 'buy'
      const tpx = normalizePrice(`${role === 'tp' ? 'takeProfit' : 'stopLoss'}.triggerPrice`, leg.triggerPrice, rec, mode, legSide, rounded)
      const px = leg.price !== undefined
        ? normalizePrice(`${role === 'tp' ? 'takeProfit' : 'stopLoss'}.price`, leg.price, rec, mode, legSide, rounded)
        : triggerExecutionPrice(tpx, legSide, intent.maxSlippageBps, rec)
      return { a: rec.assetId, b: !isBuy, p: wire(px), s: wire(sz), r: true, t: { trigger: { isMarket: leg.price === undefined, triggerPx: wire(tpx), tpsl: role } } }
    }
    if (intent.tpsl.takeProfit) { orders.push(child('tp', intent.tpsl.takeProfit)); roles.push('tp') }
    if (intent.tpsl.stopLoss) { orders.push(child('sl', intent.tpsl.stopLoss)); roles.push('sl') }
    if (orders.length === 1) grouping = 'na'
  }
  return { orders, roles, grouping, clientOrderId, ...(rounded.length ? { rounded } : {}) }
}

