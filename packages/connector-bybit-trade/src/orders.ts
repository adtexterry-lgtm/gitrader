// SPDX-License-Identifier: CPAL-1.0
// OrderIntent → Bybit v5 `/v5/order/create` 请求体（纯函数：无网络、无签名，单测直接断言参数表）。
// 口径来源：
//   QD live_trading/bybit.py:661-750（market / limit 的 category / symbol / side / orderType / qty /
//   timeInForce / positionIdx / reduceOnly / orderLinkId）、:752-761（cancel 的 POST 形状）、
//   native_protection.py:232-270（bybit 段：orderType=Market + triggerPrice + triggerBy=MarkPrice +
//   triggerDirection + reduceOnly + closeOnTrigger + tpslMode=Full 的 trading-stop）。
// 四个关键决定，README 里也写：
//   1) **市价意图不发 Market**：Bybit 的 Market 单不带价，限不了滑点，所以一律发「参考价 ± maxSlippageBps 的
//      Limit + IOC」（照 HL orders.ts:122 与 limit-safety.ts），缺 maxSlippageBps 直接 INVALID_PARAMS；
//   2) 触发单（stop_market / stop_limit / take_market / take_limit）走同一个 /v5/order/create，
//      必带 triggerBy + triggerDirection（线性建单不发 orderFilter，那是现货口径）；
//   3) **submit 不自动挂保护单**：本包 capabilities 里 tpsl.attachToOrder / positionLevel 均为 false，
//      带 tpsl 的意图回 1004；保护腿由 buildProtectionOrders()（每次成交后）或 buildTradingStop()
//      （持仓级 TP/SL/追踪）给出参数表，由内核在成交回报后调用；
//   4) 数量一律「标的币数量」（venueSizeUnit = base），按 lotSizeFilter.qtyStep 向零截断。
import { randomBytes } from 'node:crypto'
import { makeProblem } from '@gitrader/protocol'
import type { Decimal, Instrument, OrderIntent, OrderType, Problem } from '@gitrader/protocol'
import { ProblemError } from './errors'
import { clampLimitPrice } from './limit-safety'
import { isMultipleOf, snapToTick, toFx, truncateToStep } from './precision'

/** 支持的协议订单类型 → Bybit orderType（触发类同样是 Market / Limit，靠 triggerPrice + triggerDirection 区分）。 */
export const ORDER_TYPE_MAP: Record<Exclude<OrderType, 'twap' | 'trailing_stop'>, 'Market' | 'Limit'> = {
  market: 'Limit', // 市价意图发价带限价 + IOC（见文件头 1)）
  limit: 'Limit',
  stop_market: 'Market',
  stop_limit: 'Limit',
  take_market: 'Market',
  take_limit: 'Limit',
}

/** 协议 tif → Bybit timeInForce（alo = post-only = PostOnly；gtd 不声明）。 */
export const TIF_MAP = { gtc: 'GTC', ioc: 'IOC', fok: 'FOK', alo: 'PostOnly' } as const

/** 触发价参考口径：Bybit 用 MarkPrice / LastPrice / IndexPrice；协议 mark / last / index。 */
export const TRIGGER_BY = { mark: 'MarkPrice', last: 'LastPrice', index: 'IndexPrice' } as const

const TRIGGER_TYPES = new Set<string>(['stop_market', 'stop_limit', 'take_market', 'take_limit'])
const PRICE_TYPES = new Set<string>(['limit', 'stop_limit', 'take_limit'])
/** v5 条件单的 orderFilter 取值；线性建单不发（orderFilter 只对现货生效）。 */
export const STOP_ORDER_FILTER = 'StopOrder'
/** orderLinkId 上限 36 字符。 */
export const CLIENT_ORDER_ID_MAX = 36

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

/** 新客户端订单号：`gt` + 24 hex（Bybit orderLinkId 上限 36 字符、允许字母数字与 -_）。 */
export function newClientOrderId(): string {
  return `gt${randomBytes(12).toString('hex')}`
}

/** 只保留 Bybit 允许的字符集（字母 / 数字 / - / _）并截到 36 字符。 */
export function sanitizeClientOrderId(id: string): string {
  const cleaned = id.replace(/[^A-Za-z0-9_-]/g, '').slice(0, CLIENT_ORDER_ID_MAX)
  if (cleaned === '') fail(bad('INVALID_PARAMS', 'clientOrderId has no usable characters'))
  return cleaned
}

export interface PriceRef {
  bid?: number
  ask?: number
  last?: number
  mid?: number
  stale?: boolean
}

export interface BuildOptions {
  /** oneWay（缺省）= positionIdx 0；hedge = positionIdx 1/2。两种模式都发 reduceOnly（true 时）。 */
  positionMode?: 'oneWay' | 'hedge'
  /** hedge 模式下内核可显式指定持仓方向；缺省按 side + reduceOnly 推导。 */
  posSide?: 'long' | 'short'
  /** 同一父单多次部分成交逐笔补挂保护腿时传递增的 legSeq，避免后一组与前一组撞 orderLinkId。 */
  legSeq?: number
  ref?: PriceRef
}

export interface BuiltOrder {
  body: Record<string, unknown>
  clientOrderId: string
  /** oneWay = 0；hedge = 1（long 槽）/ 2（short 槽）。 */
  positionIdx: number
  /** passive 取整时记录原值 / 新值，供回执展示。 */
  rounded: Array<{ field: string; from: string; to: string }>
}

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/live_trading/bybit.py:255-271; adapted.
/**
 * hedge 模式下的 positionIdx：开仓 buy → 1（long 槽）/ sell → 2（short 槽）；平仓（reduceOnly）反过来。
 * oneWay 恒为 0（QD `_resolve_position_idx` 同口径）。
 */
export function inferPositionIdx(side: 'buy' | 'sell', reduceOnly: boolean, hedge: boolean): number {
  if (!hedge) return 0
  const posSide = reduceOnly ? (side === 'sell' ? 'long' : 'short') : side === 'buy' ? 'long' : 'short'
  return posSide === 'long' ? 1 : 2
}

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/live_trading/native_protection.py:246-259; adapted.
/**
 * 触发方向：1 = 价格涨破触发，2 = 价格跌破触发（Bybit triggerDirection）。
 * 止损（stop_*）：卖出止损在下方 → 2；买入止损在上方 → 1。
 * 止盈（take_*）：卖出止盈在上方 → 1；买入止盈在下方 → 2。
 */
export function triggerDirectionOf(type: 'stop_market' | 'stop_limit' | 'take_market' | 'take_limit', side: 'buy' | 'sell'): 1 | 2 {
  const take = type === 'take_market' || type === 'take_limit'
  const sell = side === 'sell'
  if (take) return sell ? 1 : 2
  return sell ? 2 : 1
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
  instrument: Instrument,
  mode: 'reject' | 'passive',
  side: 'buy' | 'sell',
  rounded: BuiltOrder['rounded'],
): Decimal {
  const tick = instrument.price.tick
  const x = toFx(raw)
  if (x === undefined) fail(bad('INVALID_PARAMS', `${field} must be a positive decimal number: ${JSON.stringify(raw)}`))
  if (tick === undefined) return raw as Decimal // 没有 tick 信息时只做语法 / 正数校验，不猜精度
  if (isMultipleOf(raw, tick)) return raw as Decimal
  if (mode === 'reject') {
    fail(bad('PRECISION', `${field} ${raw} is not a multiple of the tick size ${tick} for ${instrument.symbol}`))
  }
  const snapped = snapToTick(raw, tick, side === 'buy' ? 'down' : 'up')
  if (!(Number(snapped) > 0)) fail(bad('PRECISION', `${field} ${raw} rounds to zero for ${instrument.symbol}`))
  rounded.push({ field, from: raw, to: String(snapped) })
  return snapped
}

function sizeOf(intent: OrderIntent, instrument: Instrument, priceForNotional: number | undefined): Decimal {
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
    // 名义额 → 币数量：先除再按 step 截断（截断方向只会更小，不会超买）
    raw = String(notional / (px as number))
  } else {
    return fail(bad('INVALID_PARAMS', 'order needs size or notional'))
  }
  if (toFx(raw) === undefined) fail(bad('INVALID_PARAMS', `size is not a positive decimal number: ${JSON.stringify(raw)}`))
  const stepped = truncateToStep(raw, instrument.size.step)
  const qty = Number(stepped)
  if (!(qty > 0)) fail(bad('PRECISION', `size ${raw} is below the lot step ${instrument.size.step} for ${instrument.symbol}`))
  const min = Number(instrument.size.min)
  if (Number.isFinite(min) && min > 0 && qty < min) {
    fail(bad('PRECISION', `size ${stepped} is below minOrderQty ${instrument.size.min} for ${instrument.symbol}`))
  }
  return stepped
}

/**
 * 单个 OrderIntent → `/v5/order/create` 请求体。无法构造时抛 OrderBuildError（带 Problem）。
 * 键顺序固定（category, symbol, side, orderType, qty, price, timeInForce, reduceOnly, closeOnTrigger,
 * triggerPrice, triggerBy, triggerDirection, positionIdx, orderLinkId），签名对拍友好。
 */
export function buildOrderParams(intent: OrderIntent, instrument: Instrument | undefined, opts: BuildOptions = {}): BuiltOrder {
  if (!instrument) fail(bad('INSTRUMENT_UNKNOWN', `unknown instrument ${intent.instrumentId}`))
  if (instrument.status === 'delisted') fail(bad('INSTRUMENT_UNKNOWN', `${intent.instrumentId} is delisted`))
  const type = intent.type
  if (type === 'twap') fail(bad('ORDER_TYPE_UNSUPPORTED', 'order type twap is not supported by this connector'))
  if (type === 'trailing_stop') {
    fail(bad('ORDER_TYPE_UNSUPPORTED', 'Bybit has no trailing order type on /v5/order/create; use buildTradingStop() for position-level trailing'))
  }
  const triggerType = intent.triggerType ?? 'mark'
  if (triggerType !== 'mark' && triggerType !== 'last') {
    fail(bad('ORDER_TYPE_UNSUPPORTED', `trigger price type ${triggerType} is not supported (mark / last)`))
  }

  const mode = intent.rounding ?? 'reject'
  const rounded: BuiltOrder['rounded'] = []
  const isTrigger = TRIGGER_TYPES.has(type)
  const hasPrice = PRICE_TYPES.has(type)
  const isMarketIntent = type === 'market'

  // ---- 价格 / 触发价 ----
  let price: Decimal | undefined
  let triggerPrice: Decimal | undefined
  if (isTrigger) {
    if (intent.triggerPrice === undefined) fail(bad('INVALID_PARAMS', `${type} orders need triggerPrice`))
    triggerPrice = normalizePrice('triggerPrice', String(intent.triggerPrice), instrument, mode, intent.side, rounded)
  } else if (intent.triggerPrice !== undefined) {
    fail(bad('INVALID_PARAMS', `${type} orders do not take triggerPrice`))
  }
  if (hasPrice) {
    if (intent.price === undefined) fail(bad('INVALID_PARAMS', `${type} orders need price`))
    price = normalizePrice('price', String(intent.price), instrument, mode, intent.side, rounded)
  }

  // ---- 市价意图：参考价 ± maxSlippageBps 的 Limit + IOC（只收紧，不朝成交方向放宽）----
  let refPx: number | undefined
  if (isMarketIntent) {
    if (intent.maxSlippageBps === undefined) {
      fail(bad('INVALID_PARAMS', 'market orders need maxSlippageBps (no implicit default slippage)'))
    }
    const bps = Number(intent.maxSlippageBps)
    if (!Number.isFinite(bps) || bps <= 0) fail(bad('INVALID_PARAMS', 'maxSlippageBps must be a positive number'))
    refPx = refPriceOf(opts.ref)
    if (opts.ref?.stale === true || refPx === undefined) {
      fail(bad('STALE_PRICE', `no fresh reference price for ${intent.instrumentId}; cannot emulate a market order`, { retryAfterMs: 1_000 }))
    }
    const band = bps / 1e4
    const raw = intent.side === 'buy' ? refPx * (1 + band) : refPx * (1 - band)
    const { price: bounded } = clampLimitPrice(intent.side, raw, refPx, bps)
    price = normalizePrice('price', String(bounded), instrument, 'passive', intent.side, rounded)
    if (intent.tif !== undefined && intent.tif !== 'ioc') {
      fail(bad('ORDER_TYPE_UNSUPPORTED', `market orders cannot take time in force ${intent.tif}`))
    }
    if (intent.postOnly === true) fail(bad('ORDER_TYPE_UNSUPPORTED', 'postOnly needs a limit order'))
  }

  // ---- 触发价落在参考价的哪一侧：与本包的触发方向推导对不上就拒（不猜）----
  if (triggerPrice !== undefined) {
    refPx = refPx ?? refPriceOf(opts.ref)
    const dir = triggerDirectionOf(type as 'stop_market' | 'stop_limit' | 'take_market' | 'take_limit', intent.side)
    if (refPx !== undefined && opts.ref?.stale !== true) {
      const trig = Number(triggerPrice)
      if (dir === 1 && trig < refPx) {
        fail(bad('INVALID_PARAMS', `${type} ${intent.side} triggers on a rise (triggerPrice >= reference ${refPx}), got ${String(triggerPrice)}`))
      }
      if (dir === 2 && trig > refPx) {
        fail(bad('INVALID_PARAMS', `${type} ${intent.side} triggers on a fall (triggerPrice <= reference ${refPx}), got ${String(triggerPrice)}`))
      }
    }
  }

  // ---- 数量 ----
  const refForNotional = refPx ?? refPriceOf(opts.ref)
  const priceForNotional = Number(triggerPrice ?? (isMarketIntent ? refForNotional : price) ?? refForNotional ?? NaN)
  const quantity = sizeOf(intent, instrument, Number.isFinite(priceForNotional) ? priceForNotional : undefined)

  // ---- 最小名义额（reduceOnly / closeOnTrigger 豁免，与 Bybit 文档一致）----
  const minNotional = Number(instrument.minNotional ?? NaN)
  if (!intent.reduceOnly && Number.isFinite(minNotional) && minNotional > 0 && Number.isFinite(priceForNotional)) {
    const notional = Number(quantity) * priceForNotional
    if (notional < minNotional) {
      fail(bad('MIN_NOTIONAL', `order notional ${notional.toFixed(4)} is below the venue minimum ${minNotional} for ${instrument.symbol}`))
    }
  }

  // ---- 参数表 ----
  const hedge = opts.positionMode === 'hedge'
  // hedge 模式：显式给了 posSide 就用它，否则按 side + reduceOnly 推导（QD `_resolve_position_idx`）。
  const positionIdx = !hedge
    ? 0
    : opts.posSide === 'long'
      ? 1
      : opts.posSide === 'short'
        ? 2
        : inferPositionIdx(intent.side, intent.reduceOnly === true, true)
  const body: Record<string, unknown> = {
    category: 'linear',
    symbol: instrument.symbol,
    side: intent.side === 'buy' ? 'Buy' : 'Sell',
  }
  // 市价意图也发 Limit（价带 + IOC）；触发类按 _market → Market / _limit → Limit。
  body.orderType = isMarketIntent ? 'Limit' : ORDER_TYPE_MAP[type as Exclude<OrderType, 'twap' | 'trailing_stop'>]
  body.qty = String(quantity)
  if (price !== undefined) body.price = String(price)

  if (isMarketIntent) {
    body.timeInForce = 'IOC'
  } else if (!isTrigger) {
    body.timeInForce = tifOf(intent, type)
  } else if (hasPrice) {
    // stop_limit / take_limit：Bybit 接受 GTC / IOC / FOK / PostOnly
    body.timeInForce = tifOf(intent, type)
  } else {
    if (intent.postOnly === true) fail(bad('ORDER_TYPE_UNSUPPORTED', 'postOnly needs a limit order'))
    if (intent.tif !== undefined && intent.tif !== 'gtc') {
      fail(bad('ORDER_TYPE_UNSUPPORTED', `${type} orders do not take time in force ${intent.tif}`))
    }
  }

  if (isTrigger) {
    body.triggerPrice = String(triggerPrice)
    body.triggerBy = TRIGGER_BY[triggerType]
    body.triggerDirection = triggerDirectionOf(type as 'stop_market' | 'stop_limit' | 'take_market' | 'take_limit', intent.side)
  }

  // 两种持仓模式都发 reduceOnly（QD bybit.py:691-694 / :741-744）；hedge 靠 positionIdx 定位槽位。
  if (intent.reduceOnly === true) body.reduceOnly = true
  body.positionIdx = positionIdx

  const clientOrderId = sanitizeClientOrderId(intent.clientOrderId !== undefined ? String(intent.clientOrderId) : newClientOrderId())
  body.orderLinkId = clientOrderId

  return { body, clientOrderId, positionIdx, rounded }
}

function tifOf(intent: OrderIntent, type: string): string {
  if (intent.postOnly === true) {
    if (intent.tif !== undefined && intent.tif !== 'alo' && intent.tif !== 'gtc') {
      fail(bad('ORDER_TYPE_UNSUPPORTED', `postOnly cannot be combined with tif ${intent.tif}`))
    }
    if (type !== 'limit' && type !== 'stop_limit' && type !== 'take_limit') {
      fail(bad('ORDER_TYPE_UNSUPPORTED', 'postOnly needs a limit order'))
    }
    return 'PostOnly'
  }
  const tif = intent.tif ?? 'gtc'
  const mapped = (TIF_MAP as Record<string, string | undefined>)[tif]
  if (mapped === undefined) {
    fail(bad('ORDER_TYPE_UNSUPPORTED', `time in force ${String(tif)} is not supported (gtc / ioc / fok / alo)`))
  }
  return mapped
}

export interface ProtectionOrder {
  body: Record<string, unknown>
  clientOrderId: string
}

export interface ProtectionOrders {
  stopLoss?: ProtectionOrder
  takeProfit?: ProtectionOrder
}

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/live_trading/native_protection.py:232-259; adapted.
/**
 * 成交后补挂的 reduce-only 保护单（纯函数，不联网；QD bybit 段同形状）：
 *   · 每次成交后按**本次成交数量**补挂，方向 = 父单反向，triggerBy = MarkPrice；
 *   · reduceOnly = true + closeOnTrigger = true（平仓不被新仓位吃掉）；
 *   · leg 里给了 price 就发 Limit 触发单（stop_limit / take_limit），否则 Market 触发单；
 *   · orderLinkId = `${父单 clientOrderId}-sl|-tp`，给了 legSeq 就是 `-sl<n>` / `-tp<n>`，超 36 字符就地截断。
 *     同一父单多次部分成交逐笔补挂时，传递增的 legSeq，否则后一组保护腿与前一组撞 orderLinkId 被 110072 拒。
 * 由内核在成交回报后调用；本连接器的 submit 不自动挂（带 tpsl 的意图直接 1004）。
 */
export function buildProtectionOrders(
  parentIntent: OrderIntent,
  filledSize: Decimal,
  instrument: Instrument | undefined,
  opts: BuildOptions = {},
): ProtectionOrders {
  if (!parentIntent.tpsl) fail(bad('INVALID_PARAMS', 'buildProtectionOrders needs an intent with tpsl'))
  if (!instrument) fail(bad('INSTRUMENT_UNKNOWN', `unknown instrument ${parentIntent.instrumentId}`))
  const tpsl = parentIntent.tpsl
  if (!tpsl.takeProfit && !tpsl.stopLoss) fail(bad('INVALID_PARAMS', 'tpsl has neither takeProfit nor stopLoss'))
  const closeSide: 'buy' | 'sell' = parentIntent.side === 'buy' ? 'sell' : 'buy'
  if (toFx(String(filledSize)) === undefined) fail(bad('INVALID_PARAMS', 'filledSize must be a positive number'))
  if (opts.legSeq !== undefined && (!Number.isInteger(opts.legSeq) || opts.legSeq < 0)) {
    fail(bad('INVALID_PARAMS', 'legSeq must be a non-negative integer'))
  }
  const quantity = truncateToStep(String(filledSize), instrument.size.step)
  if (!(Number(quantity) > 0)) fail(bad('PRECISION', `filledSize ${String(filledSize)} is below the lot step for ${instrument.symbol}`))
  const hedge = opts.positionMode === 'hedge'
  const positionIdx = hedge ? (parentIntent.side === 'buy' ? 1 : 2) : 0
  const rounded: BuiltOrder['rounded'] = []
  const one = (leg: { triggerPrice: Decimal; price?: Decimal }, role: 'sl' | 'tp'): ProtectionOrder => {
    const limit = leg.price !== undefined
    const body: Record<string, unknown> = {
      category: 'linear',
      symbol: instrument.symbol,
      side: closeSide === 'buy' ? 'Buy' : 'Sell',
      orderType: limit ? 'Limit' : 'Market',
      qty: String(quantity),
    }
    if (limit) {
      body.price = String(normalizePrice(`${role}.price`, String(leg.price), instrument, 'reject', closeSide, rounded))
      body.timeInForce = 'GTC'
    }
    body.triggerPrice = String(normalizePrice(`${role}.triggerPrice`, String(leg.triggerPrice), instrument, 'reject', closeSide, rounded))
    body.triggerBy = 'MarkPrice'
    body.triggerDirection = triggerDirectionOf(role === 'sl' ? 'stop_market' : 'take_market', closeSide)
    body.reduceOnly = true
    body.closeOnTrigger = true
    body.positionIdx = positionIdx
    // 父单号可能已经占满 36 字符：先给 `-sl` / `-tp`（或 `-sl<n>`）留位，再清洗。
    const suffix = opts.legSeq === undefined ? role : `${role}${opts.legSeq}`
    const rawBase = parentIntent.clientOrderId !== undefined ? String(parentIntent.clientOrderId) : newClientOrderId()
    const base = rawBase.slice(0, CLIENT_ORDER_ID_MAX - 1 - suffix.length)
    const clientOrderId = sanitizeClientOrderId(`${base}-${suffix}`)
    body.orderLinkId = clientOrderId
    return { body, clientOrderId }
  }
  return {
    ...(tpsl.stopLoss ? { stopLoss: one(tpsl.stopLoss, 'sl') } : {}),
    ...(tpsl.takeProfit ? { takeProfit: one(tpsl.takeProfit, 'tp') } : {}),
  }
}

export interface TradingStopSpec {
  symbol: string
  positionIdx?: number
  tpslMode?: 'Full' | 'Partial'
  /** 绝对价（Bybit 收 absolute price，不收百分比）。 */
  stopLoss?: string
  takeProfit?: string
  /** 追踪距离（价差，不是比例；QD 用 entry × trailing_stop_pct 折算）。 */
  trailingStop?: string
  activePrice?: string
  triggerBy?: 'MarkPrice' | 'LastPrice' | 'IndexPrice'
}

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/live_trading/native_protection.py:260-269; adapted.
/**
 * 持仓级 TP / SL / 追踪止损的请求体（POST /v5/position/trading-stop，tpslMode 缺省 Full）。
 * 只做参数构造：这是**仓位级**设置，会覆盖该槽位已有的 TP/SL，内核要知道自己在覆盖什么。
 */
export function buildTradingStop(spec: TradingStopSpec): Record<string, unknown> {
  if (spec.stopLoss === undefined && spec.takeProfit === undefined && spec.trailingStop === undefined) {
    fail(bad('INVALID_PARAMS', 'trading-stop needs stopLoss, takeProfit or trailingStop'))
  }
  for (const [field, value] of [['stopLoss', spec.stopLoss], ['takeProfit', spec.takeProfit], ['trailingStop', spec.trailingStop], ['activePrice', spec.activePrice]] as const) {
    if (value === undefined) continue
    if (toFx(String(value)) === undefined) fail(bad('INVALID_PARAMS', `${field} must be a positive decimal number`))
  }
  const body: Record<string, unknown> = {
    category: 'linear',
    symbol: spec.symbol.trim().toUpperCase(),
    tpslMode: spec.tpslMode ?? 'Full',
    positionIdx: spec.positionIdx ?? 0,
  }
  if (spec.takeProfit !== undefined) body.takeProfit = String(spec.takeProfit)
  if (spec.stopLoss !== undefined) body.stopLoss = String(spec.stopLoss)
  if (spec.trailingStop !== undefined) body.trailingStop = String(spec.trailingStop)
  if (spec.activePrice !== undefined) body.activePrice = String(spec.activePrice)
  body.tpTriggerBy = spec.triggerBy ?? 'MarkPrice'
  body.slTriggerBy = spec.triggerBy ?? 'MarkPrice'
  return body
}
