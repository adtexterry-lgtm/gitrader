// SPDX-License-Identifier: CPAL-1.0
// OrderIntent → Binance USDⓈ-M 下单参数（纯函数：无网络、无签名，单测直接断言参数表）。
// 普通单走 `/fapi/v1/order`；五类触发单（STOP_MARKET / STOP / TAKE_PROFIT_MARKET / TAKE_PROFIT /
// TRAILING_STOP_MARKET）走 `/fapi/v1/algoOrder`（algoType=CONDITIONAL）。
// 口径来源：
//   QD live_trading/binance.py:779-1035（普通下单参数构造）、QD native_protection.py:108-148（algoOrder 的
//   algoType / triggerPrice / workingType=MARK_PRICE / clientAlgoId / callbackRate / activatePrice）；
//   QD contracts.py:16-127 与 signal_to_order_sides（side 与 positionSide 的翻译）。
// 三个关键差异，已在 README 写明：
//   1) 币安没有原生父子单 —— 本包只提供 buildProtectionOrders() 纯函数，submit 对带 tpsl 的意图返回 1004；
//   2) 数量一律「币数量」（venueSizeUnit = base），按 LOT_SIZE.stepSize 向零截断；
//   3) 触发单一律 workingType=MARK_PRICE（与 QD 一致），所以 triggerPriceTypes 只声明 ['mark']。
import { randomBytes } from 'node:crypto'
import { makeProblem } from '@gitrader/protocol'
import type { Decimal, OrderIntent, OrderType, Problem } from '@gitrader/protocol'
import { ProblemError } from './errors'
import { clampLimitPrice } from './limit-safety'
import { isMultipleOf, snapToTick, toFx, truncateToStep } from './precision'
import type { InstrumentRecord } from './parse'

/** 支持的协议订单类型 → Binance 类型。 */
export const ORDER_TYPE_MAP: Record<Exclude<OrderType, 'twap'>, string> = {
  market: 'MARKET',
  limit: 'LIMIT',
  stop_market: 'STOP_MARKET',
  stop_limit: 'STOP',
  take_market: 'TAKE_PROFIT_MARKET',
  take_limit: 'TAKE_PROFIT',
  trailing_stop: 'TRAILING_STOP_MARKET',
}

/** 协议 tif → Binance timeInForce（alo = post-only = GTX）。 */
export const TIF_MAP = { gtc: 'GTC', ioc: 'IOC', fok: 'FOK', alo: 'GTX' } as const

const TRIGGER_TYPES = new Set<string>(['stop_market', 'stop_limit', 'take_market', 'take_limit', 'trailing_stop'])
const PRICE_TYPES = new Set<string>(['limit', 'stop_limit', 'take_limit'])
/** 走 POST /fapi/v1/algoOrder 的订单类型（QD native_protection.py:108-148 的口径）。 */
export const ALGO_ORDER_TYPES = new Set<string>(TRIGGER_TYPES)

export const bad = (
  name: 'INSTRUMENT_UNKNOWN' | 'PRECISION' | 'MIN_NOTIONAL' | 'ORDER_TYPE_UNSUPPORTED' | 'INVALID_PARAMS' | 'STALE_PRICE',
  message: string,
  extra: Partial<Problem> = {},
): Problem => makeProblem(name, message, extra)

export class OrderBuildError extends ProblemError {
  constructor(problem: Problem) {
    super(problem)
    this.name = 'OrderBuildError'
  }
}

function fail(p: Problem): never {
  throw new OrderBuildError(p)
}

/** 新客户端订单号：`gt` + 24 hex（Binance 上限 36 字符，允许 [.A-Z:/a-z0-9_-]）。 */
export function newClientOrderId(): string {
  return `gt${randomBytes(12).toString('hex')}`
}

/** 只保留 Binance 允许的字符集并截到 36 字符。 */
export function sanitizeClientOrderId(id: string): string {
  const cleaned = id.replace(/[^.A-Z:/a-z0-9_-]/g, '').slice(0, 36)
  if (cleaned === '') fail(bad('INVALID_PARAMS', 'clientOrderId has no usable characters'))
  return cleaned
}

/** 市价参考报价最大年龄（毫秒），缺省 5 s；超过就直接拒单，不下单。 */
export const DEFAULT_REF_PRICE_MAX_AGE_MS = 5_000

export interface PriceRef {
  bid?: number
  ask?: number
  last?: number
  mid?: number
  stale?: boolean
  /** 报价年龄（毫秒）；有值时才按 refPriceMaxAgeMs 判陈旧。 */
  ageMs?: number
}

export interface BuildOptions {
  /** oneWay（缺省）= 省略 positionSide 并发 reduceOnly；hedge = 发 positionSide、不发 reduceOnly。 */
  positionMode?: 'oneWay' | 'hedge'
  /** hedge 模式下内核可显式指定持仓方向；缺省按 side + reduceOnly 推导（同 QD _infer_position_side）。 */
  positionSide?: 'LONG' | 'SHORT'
  ref?: PriceRef
  /** 市价参考报价最大年龄，缺省 DEFAULT_REF_PRICE_MAX_AGE_MS。 */
  refPriceMaxAgeMs?: number
}

export interface BuiltOrderParams {
  params: Record<string, string>
  clientOrderId: string
  positionSide: 'LONG' | 'SHORT' | 'BOTH'
  /** passive 取整时记录原值 / 新值，供回执展示。 */
  rounded: Array<{ field: string; from: string; to: string }>
  /** 下单端点：触发类走 algo（/fapi/v1/algoOrder），其余走 /fapi/v1/order。 */
  endpoint: 'order' | 'algo'
}

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/live_trading/binance.py:606-629; adapted.
/** hedge 模式下的持仓方向推导：开仓 buy→LONG / sell→SHORT；平仓（reduceOnly）反过来。 */
export function inferPositionSide(side: 'buy' | 'sell', reduceOnly: boolean): 'LONG' | 'SHORT' {
  if (reduceOnly) return side === 'sell' ? 'LONG' : 'SHORT'
  return side === 'buy' ? 'LONG' : 'SHORT'
}

function refPriceOf(ref: PriceRef | undefined): number | undefined {
  if (!ref) return undefined
  if (ref.mid !== undefined && Number.isFinite(ref.mid) && ref.mid > 0) return ref.mid
  if (ref.bid !== undefined && ref.ask !== undefined && ref.bid > 0 && ref.ask > 0) return (ref.bid + ref.ask) / 2
  if (ref.last !== undefined && Number.isFinite(ref.last) && ref.last > 0) return ref.last
  return undefined
}

function normalizePrice(
  field: string,
  raw: string,
  rec: InstrumentRecord,
  mode: 'reject' | 'passive',
  side: 'buy' | 'sell',
  rounded: BuiltOrderParams['rounded'],
): Decimal {
  const tick = rec.instrument.price.tick
  if (tick === undefined) {
    // 没有 tick 信息时只做语法 / 正数校验，不猜精度
    const x = toFx(raw)
    if (x === undefined) fail(bad('INVALID_PARAMS', `${field} must be a positive decimal number: ${JSON.stringify(raw)}`))
    return raw as Decimal
  }
  const x = toFx(raw)
  if (x === undefined) fail(bad('INVALID_PARAMS', `${field} must be a positive decimal number: ${JSON.stringify(raw)}`))
  if (isMultipleOf(raw, tick)) return raw as Decimal
  if (mode === 'reject') {
    fail(bad('PRECISION', `${field} ${raw} is not a multiple of the tick size ${tick} for ${rec.instrument.symbol}`))
  }
  const snapped = snapToTick(raw, tick, side === 'buy' ? 'down' : 'up')
  const out = Number(snapped)
  if (!(out > 0)) fail(bad('PRECISION', `${field} ${raw} rounds to zero for ${rec.instrument.symbol}`))
  rounded.push({ field, from: raw, to: String(snapped) })
  return snapped
}

function sizeOf(intent: OrderIntent, rec: InstrumentRecord, priceForNotional: number | undefined): Decimal {
  let raw: string
  if (intent.size !== undefined) {
    raw = String(intent.size)
  } else if (intent.notional !== undefined) {
    const px = priceForNotional
    if (px === undefined || !(px > 0)) {
      fail(bad('STALE_PRICE', `no reference price to convert notional into size for ${intent.instrumentId}`, { retryAfterMs: 1_000 }))
    }
    const notional = Number(intent.notional)
    if (!Number.isFinite(notional) || notional <= 0) fail(bad('INVALID_PARAMS', 'notional must be a positive number'))
    // 名义额 → 币数量：先用定点除法再按 step 截断（截断方向只会更小，不会超买）
    raw = String(notional / (px as number))
  } else {
    return fail(bad('INVALID_PARAMS', 'order needs size or notional'))
  }
  if (toFx(raw) === undefined) fail(bad('INVALID_PARAMS', `size is not a positive decimal number: ${JSON.stringify(raw)}`))
  const stepped = truncateToStep(raw, rec.instrument.size.step)
  const qty = Number(stepped)
  if (!(qty > 0)) {
    fail(bad('PRECISION', `size ${raw} is below the lot step ${rec.instrument.size.step} for ${rec.instrument.symbol}`))
  }
  const min = Number(rec.instrument.size.min)
  if (Number.isFinite(min) && min > 0 && qty < min) {
    fail(bad('PRECISION', `size ${stepped} is below minQty ${rec.instrument.size.min} for ${rec.instrument.symbol}`))
  }
  return stepped
}

/**
 * 单个 OrderIntent → `/fapi/v1/order` 参数表。无法构造时抛 OrderBuildError（带 Problem）。
 * 参数顺序固定（algoType, symbol, side, positionSide, type, timeInForce, quantity, price,
 * triggerPrice, workingType, …），签名对拍友好。
 */
export function buildOrderParams(intent: OrderIntent, rec: InstrumentRecord | undefined, opts: BuildOptions = {}): BuiltOrderParams {
  if (!rec) fail(bad('INSTRUMENT_UNKNOWN', `unknown instrument ${intent.instrumentId}`))
  if (rec.instrument.status === 'delisted') fail(bad('INSTRUMENT_UNKNOWN', `${intent.instrumentId} is delisted`))
  const type = intent.type
  if (type === 'twap') fail(bad('ORDER_TYPE_UNSUPPORTED', 'order type twap is not supported by Binance USDⓈ-M'))
  if (intent.triggerType !== undefined && intent.triggerType !== 'mark') {
    fail(bad('ORDER_TYPE_UNSUPPORTED', `trigger price type ${intent.triggerType} is not supported (workingType is always MARK_PRICE)`))
  }
  const venueType = ORDER_TYPE_MAP[type as Exclude<OrderType, 'twap'>]
  if (venueType === undefined) fail(bad('ORDER_TYPE_UNSUPPORTED', `order type ${type} is not supported`))

  const mode = intent.rounding ?? 'reject'
  const rounded: BuiltOrderParams['rounded'] = []
  const isTrigger = TRIGGER_TYPES.has(type)
  const hasPrice = PRICE_TYPES.has(type)
  const isMarket = type === 'market'
  const endpoint: 'order' | 'algo' = isTrigger ? 'algo' : 'order'

  // ---- 价格 / 触发价 ----
  let price: Decimal | undefined
  let triggerPrice: Decimal | undefined
  if (isTrigger) {
    if (type === 'trailing_stop') {
      // 追踪止损只有激活价（可选），没有 triggerPrice
      if (intent.triggerPrice !== undefined) fail(bad('INVALID_PARAMS', 'trailing_stop takes activationPrice, not triggerPrice'))
    } else {
      if (intent.triggerPrice === undefined) fail(bad('INVALID_PARAMS', `${type} orders need triggerPrice`))
      triggerPrice = normalizePrice('triggerPrice', String(intent.triggerPrice), rec, mode, intent.side, rounded)
    }
  } else if (intent.triggerPrice !== undefined) {
    fail(bad('INVALID_PARAMS', `${type} orders do not take triggerPrice`))
  }
  if (hasPrice) {
    if (intent.price === undefined) fail(bad('INVALID_PARAMS', `${type} orders need price`))
    price = normalizePrice('price', String(intent.price), rec, mode, intent.side, rounded)
  }
  if (intent.trailing !== undefined && type !== 'trailing_stop') {
    fail(bad('INVALID_PARAMS', 'trailing parameters are only valid for trailing_stop orders'))
  }
  if (intent.trailing?.activationRatio !== undefined && intent.trailing.activationPrice === undefined) {
    fail(bad('INVALID_PARAMS', 'activationRatio is not supported by this connector; pass trailing.activationPrice instead'))
  }

  // ---- 市价意图：参考价 ± maxSlippageBps 的 LIMIT + IOC（照 HL orders.ts:122 的做法）----
  // 参考价来源：market.quoteCached() 的盘口中间价（bid/ask），没有盘口时退到 last；两者都没有就 STALE_PRICE。
  if (isMarket) {
    if (intent.maxSlippageBps === undefined) {
      fail(bad('INVALID_PARAMS', 'market orders need maxSlippageBps (no implicit default slippage)'))
    }
    const bps = Number(intent.maxSlippageBps)
    if (!Number.isFinite(bps) || bps <= 0) fail(bad('INVALID_PARAMS', 'maxSlippageBps must be a positive number'))
    const refPx = refPriceOf(opts.ref)
    const maxAgeMs = opts.refPriceMaxAgeMs ?? DEFAULT_REF_PRICE_MAX_AGE_MS
    if (opts.ref?.ageMs !== undefined && opts.ref.ageMs > maxAgeMs) {
      fail(bad('INVALID_PARAMS', `reference price stale: quote is ${opts.ref.ageMs} ms old (max ${maxAgeMs} ms); refresh the quote before a market order`))
    }
    if (opts.ref?.stale === true || refPx === undefined) {
      fail(bad('STALE_PRICE', `no fresh reference price for ${intent.instrumentId}; cannot emulate a market order`, { retryAfterMs: 1_000 }))
    }
    const band = bps / 1e4
    const raw = intent.side === 'buy' ? refPx * (1 + band) : refPx * (1 - band)
    const { price: bounded } = clampLimitPrice(intent.side, raw, refPx, bps)
    // 买单向下取整、卖单向上取整（只收紧，不朝成交方向放宽）
    price = normalizePrice('price', String(bounded), rec, 'passive', intent.side, rounded)
  }

  // ---- 数量 ----
  const refForNotional = refPriceOf(opts.ref)
  const priceForNotional = Number(triggerPrice ?? (isMarket ? refForNotional : price) ?? refForNotional ?? NaN)
  const quantity = sizeOf(intent, rec, Number.isFinite(priceForNotional) ? priceForNotional : undefined)

  // ---- 最小名义额（reduceOnly 豁免，与 Binance 文档一致）----
  const minNotional = Number(rec.instrument.minNotional ?? NaN)
  if (!intent.reduceOnly && Number.isFinite(minNotional) && minNotional > 0 && Number.isFinite(priceForNotional)) {
    const notional = Number(quantity) * priceForNotional
    if (notional < minNotional) {
      fail(bad('MIN_NOTIONAL', `order notional ${notional.toFixed(4)} is below the venue minimum ${minNotional} for ${rec.instrument.symbol}`))
    }
  }

  // ---- 参数表 ----
  const params: Record<string, string> = {}
  // 触发类走 algo 端点：algoType=CONDITIONAL + triggerPrice + clientAlgoId（不用 stopPrice/newClientOrderId）。
  if (endpoint === 'algo') params.algoType = 'CONDITIONAL'
  params.symbol = rec.symbol
  params.side = intent.side === 'buy' ? 'BUY' : 'SELL'

  // ---- positionSide / reduceOnly（hedge 与 oneWay 互斥，混发会 -1106）----
  const hedge = opts.positionMode === 'hedge'
  const positionSide: 'LONG' | 'SHORT' | 'BOTH' = hedge
    ? (opts.positionSide ?? inferPositionSide(intent.side, intent.reduceOnly === true))
    : 'BOTH'
  if (hedge) params.positionSide = positionSide as 'LONG' | 'SHORT'

  // 市价意图发 LIMIT + IOC（Binance 的 MARKET 不带价，无法限滑点）
  params.type = isMarket ? 'LIMIT' : venueType

  if (isMarket) {
    if (intent.tif !== undefined && intent.tif !== 'ioc') {
      fail(bad('ORDER_TYPE_UNSUPPORTED', `market orders cannot take time in force ${intent.tif}`))
    }
    if (intent.postOnly === true) fail(bad('ORDER_TYPE_UNSUPPORTED', 'postOnly needs a limit order'))
    // 市价意图 = 带滑点上限的 LIMIT + IOC（Binance 的 MARKET 不带价，无法限滑点）。
    params.timeInForce = 'IOC'
    params.quantity = String(quantity)
    params.price = String(price)
  } else if (type === 'trailing_stop') {
    const ratio = intent.trailing?.callbackRatio
    if (ratio === undefined) fail(bad('INVALID_PARAMS', 'trailing_stop needs trailing.callbackRatio'))
    const pct = Number(ratio) * 100
    if (!Number.isFinite(pct) || pct <= 0) fail(bad('INVALID_PARAMS', `callbackRatio ${String(ratio)} must be a positive ratio`))
    // 官方范围 0.1%–10%（QD native_protection.py:138-139 同口径）：越界直接拒单，不夹取。
    if (pct < 0.1 || pct > 10) {
      fail(bad('INVALID_PARAMS', `callbackRatio ${String(ratio)} maps to callbackRate ${pct}%, outside the venue range 0.1–10%`))
    }
    params.quantity = String(quantity)
    params.callbackRate = String(Number(pct.toFixed(2)))
    const activation = intent.trailing?.activationPrice
    if (activation !== undefined) {
      params.activatePrice = String(normalizePrice('activationPrice', String(activation), rec, mode, intent.side, rounded))
    }
    params.workingType = 'MARK_PRICE'
  } else if (isTrigger) {
    // STOP / TAKE_PROFIT 限价触发单接受 timeInForce；纯触发市价单不接受
    if (hasPrice) {
      params.timeInForce = tifOf(intent, type)
    } else {
      if (intent.postOnly === true) fail(bad('ORDER_TYPE_UNSUPPORTED', 'postOnly needs a limit order'))
      if (intent.tif !== undefined && intent.tif !== 'gtc') {
        fail(bad('ORDER_TYPE_UNSUPPORTED', `${type} orders do not take time in force ${intent.tif}`))
      }
    }
    params.quantity = String(quantity)
    if (price !== undefined) params.price = String(price)
    params.triggerPrice = String(triggerPrice)
    params.workingType = 'MARK_PRICE'
  } else {
    params.timeInForce = tifOf(intent, type)
    params.quantity = String(quantity)
    params.price = String(price)
  }

  if (!hedge && intent.reduceOnly === true) params.reduceOnly = 'true'
  const clientOrderId = sanitizeClientOrderId(intent.clientOrderId !== undefined ? String(intent.clientOrderId) : newClientOrderId())
  if (endpoint === 'algo') params.clientAlgoId = clientOrderId
  else params.newClientOrderId = clientOrderId

  return { params, clientOrderId, positionSide, rounded, endpoint }
}

function tifOf(intent: OrderIntent, type: string): string {
  if (intent.postOnly === true) {
    if (intent.tif !== undefined && intent.tif !== 'alo' && intent.tif !== 'gtc') {
      fail(bad('ORDER_TYPE_UNSUPPORTED', `postOnly cannot be combined with tif ${intent.tif}`))
    }
    if (type !== 'limit' && type !== 'stop_limit' && type !== 'take_limit') {
      fail(bad('ORDER_TYPE_UNSUPPORTED', 'postOnly needs a limit order'))
    }
    return 'GTX'
  }
  const tif = intent.tif ?? 'gtc'
  const mapped = (TIF_MAP as Record<string, string | undefined>)[tif]
  if (mapped === undefined) {
    fail(bad('ORDER_TYPE_UNSUPPORTED', `time in force ${String(tif)} is not supported (gtc / ioc / fok / alo)`))
  }
  return mapped
}

export interface ProtectionOrder {
  params: Record<string, string>
  clientOrderId: string
  /** 保护腿一律走 algo 端点（POST /fapi/v1/algoOrder）。 */
  endpoint: 'algo'
}

export interface ProtectionOrders {
  stopLoss?: ProtectionOrder
  takeProfit?: ProtectionOrder
}

/**
 * 成交后补挂的 reduce-only 保护单（纯函数，不联网）：Binance 没有原生父子单，QD 的做法是父单成交后
 * 按成交数量补挂 STOP_MARKET / TAKE_PROFIT_MARKET（native_protection.py:124-148）。
 *   · 走 algo 端点（algoType=CONDITIONAL / triggerPrice / workingType=MARK_PRICE / clientAlgoId）；
 *   · 数量 = 本次成交数量（delta），按 stepSize 截断；
 *   · 方向 = 父单反向；
 *   · reduceOnly = true（oneWay）或 positionSide = 父单持仓方向（hedge）；
 *   · leg 里给了 price 就用 STOP / TAKE_PROFIT 限价触发单。
 * 由内核在成交回报后调用；本连接器的 submit 不自动挂（带 tpsl 的意图直接 1004）。
 */
export function buildProtectionOrders(
  parentIntent: OrderIntent,
  filledSize: Decimal,
  rec: InstrumentRecord | undefined,
  opts: BuildOptions = {},
): ProtectionOrders {
  if (!parentIntent.tpsl) fail(bad('INVALID_PARAMS', 'buildProtectionOrders needs an intent with tpsl'))
  if (!rec) fail(bad('INSTRUMENT_UNKNOWN', `unknown instrument ${parentIntent.instrumentId}`))
  const tpsl = parentIntent.tpsl
  if (!tpsl.takeProfit && !tpsl.stopLoss) fail(bad('INVALID_PARAMS', 'tpsl has neither takeProfit nor stopLoss'))
  const closeSide: 'buy' | 'sell' = parentIntent.side === 'buy' ? 'sell' : 'buy'
  if (toFx(String(filledSize)) === undefined) fail(bad('INVALID_PARAMS', 'filledSize must be a positive number'))
  const quantity = truncateToStep(String(filledSize), rec.instrument.size.step)
  if (!(Number(quantity) > 0)) fail(bad('PRECISION', `filledSize ${String(filledSize)} is below the lot step for ${rec.instrument.symbol}`))
  const hedge = opts.positionMode === 'hedge'
  const positionSide: 'LONG' | 'SHORT' = inferPositionSide(closeSide, true)
  const rounded: BuiltOrderParams['rounded'] = []
  const one = (leg: { triggerPrice: Decimal; price?: Decimal }, role: 'sl' | 'tp'): ProtectionOrder => {
    const limit = leg.price !== undefined
    const venueType = role === 'sl' ? (limit ? 'STOP' : 'STOP_MARKET') : limit ? 'TAKE_PROFIT' : 'TAKE_PROFIT_MARKET'
    const params: Record<string, string> = {
      algoType: 'CONDITIONAL',
      symbol: rec.symbol,
      side: closeSide === 'buy' ? 'BUY' : 'SELL',
    }
    if (hedge) params.positionSide = positionSide
    params.type = venueType
    if (limit) {
      params.timeInForce = 'GTC'
      params.price = String(normalizePrice(`${role}.price`, String(leg.price), rec, 'reject', closeSide, rounded))
    }
    params.quantity = String(quantity)
    params.triggerPrice = String(normalizePrice(`${role}.triggerPrice`, String(leg.triggerPrice), rec, 'reject', closeSide, rounded))
    params.workingType = 'MARK_PRICE'
    if (!hedge) params.reduceOnly = 'true'
    const clientOrderId = sanitizeClientOrderId(`${parentIntent.clientOrderId !== undefined ? String(parentIntent.clientOrderId) : newClientOrderId()}-${role}`)
    params.clientAlgoId = clientOrderId
    return { params, clientOrderId, endpoint: 'algo' as const }
  }
  return {
    ...(tpsl.stopLoss ? { stopLoss: one(tpsl.stopLoss, 'sl') } : {}),
    ...(tpsl.takeProfit ? { takeProfit: one(tpsl.takeProfit, 'tp') } : {}),
  }
}
