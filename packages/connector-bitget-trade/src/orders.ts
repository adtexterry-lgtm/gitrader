// SPDX-License-Identifier: CPAL-1.0
// OrderIntent → Bitget v2 mix 线上请求体（纯函数，无网络、无签名；单测直接断言字节形状）。
// 口径来源：QD backend_api_python/app/services/live_trading/bitget.py
//   · 下单参数 :781-903（symbol / productType / marginCoin / marginMode / orderType / price / size / force / clientOid）；
//   · 持仓字段翻译 :404-442（hedge_mode 要 tradeSide=open|close 且 side 是持仓方向；one_way_mode 要 reduceOnly=YES|NO，
//     且**不能**发 tradeSide；holdSide 不是 place-order 的参数）；
//   · 保证金模式拼写 :177-196（cross → crossed）；
//   · 计划委托 / 位置级保护 :native_protection.py:190-229（triggerType=mark_price、executePrice=0、planType、
//     追踪 moving_plan + rangeRate）。
//   · place-plan-order 用官方 v2 字段（orderType / price / callbackRatio），QD 未调用该端点，未经真网核对。
// Gitrader 口径（工单通用教训 4）：**市价意图必须带 maxSlippageBps**，实际发「价带限价 + force=ioc」
// （照 packages/connector-hyperliquid/src/orders.ts:122 与 limit-safety.ts），所以能力声明里 market = emulated。
import { randomBytes } from 'node:crypto'
import { makeProblem } from '@gitrader/protocol'
import type { Decimal, OrderIntent, Problem } from '@gitrader/protocol'
import { asDecimal, normalizeDecimal } from '@gitrader/protocol'
import { div, fx, mul, str } from '@gitrader/protocol/decimal'
import { ProblemError } from './errors'
import type { InstrumentRecord } from './parse'
import { MARGIN_COIN, PRODUCT_TYPE } from './parse'
import { applyBps, snapToTick, toFx, truncateToStep } from './precision'

/** Bitget 的 `force`（QD bitget.py:893-897 用 gtc / post_only；ioc / fok 同一字段）。 */
export type BitgetForce = 'gtc' | 'ioc' | 'fok' | 'post_only'
export type PositionMode = 'oneWay' | 'hedge'

export interface BuildOptions {
  posMode?: PositionMode
  marginMode?: 'cross' | 'isolated'
  /** hedge 模式下的持仓方向（减仓 / 平仓要用）。 */
  holdSide?: 'long' | 'short'
  marginCoin?: string
  productType?: string
  /** 市价参考报价最大年龄，缺省 DEFAULT_REF_PRICE_MAX_AGE_MS。 */
  refPriceMaxAgeMs?: number
}

/** 市价参考报价最大年龄（毫秒），缺省 5 s；超过就直接拒单，不下单。 */
export const DEFAULT_REF_PRICE_MAX_AGE_MS = 5_000

/** 下单参考价（买卖价与中间价；陈旧时拒绝市价模拟）。 */
export interface PriceRef {
  bid?: number
  ask?: number
  mid?: number
  stale?: boolean
  /** 报价年龄（毫秒）；有值时才按 refPriceMaxAgeMs 判陈旧。 */
  ageMs?: number
}

export interface BuiltOrder {
  /** 普通委托走 place-order，计划委托（触发 / 追踪）走 place-plan-order。 */
  endpoint: 'order' | 'plan'
  body: Record<string, string>
  clientOrderId: string
  planType?: string
  reduceOnly: boolean
  /** 价格被规整（passive）时记录原值与新值，供回执展示。 */
  rounded?: { field: string; from: string; to: string }[]
}

export class OrderBuildError extends ProblemError {
  constructor(problem: Problem) {
    super(problem)
    this.name = 'OrderBuildError'
  }
}

const bad = (name: Parameters<typeof makeProblem>[0], message: string, extra: Partial<Problem> = {}): Problem => makeProblem(name, message, extra)
const fail = (p: Problem): never => {
  throw new OrderBuildError(p)
}

/** clientOid 的字符集：字母 + 数字，1–64 位（Bitget 文档口径）。非字母数字一律剔除。 */
export function sanitizeClientOid(id: string, maxLength = 64): string {
  const cleaned = id.replace(/[^0-9A-Za-z]/g, '')
  if (cleaned === '') return `gt${randomBytes(8).toString('hex')}`.slice(0, maxLength)
  return cleaned.slice(0, maxLength)
}

export function newClientOrderId(): string {
  return randomBytes(16).toString('hex')
}

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/live_trading/bitget.py:177-196; adapted.
/** 保证金模式：cross → crossed，isolated → isolated；空值缺省 crossed。 */
export function normalizeMarginMode(mode: string | undefined): 'crossed' | 'isolated' {
  const m = (mode ?? '').trim().toLowerCase()
  if (m === 'isolated' || m === 'iso') return 'isolated'
  return 'crossed'
}

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/live_trading/bitget.py:404-442; adapted.
/**
 * 持仓字段翻译：
 *   · one_way_mode：`side` 就是买卖方向，`reduceOnly` 显式 YES / NO，**不发 tradeSide**（上游会拒）；
 *   · hedge_mode：`tradeSide` = open / close，`side` 表示持仓方向（开仓时等于买卖方向，平仓时相反）。
 */
export function positionFields(side: 'buy' | 'sell', reduceOnly: boolean, opts: BuildOptions = {}): Record<string, string> {
  if ((opts.posMode ?? 'oneWay') === 'hedge') {
    const hold = opts.holdSide
    const direction = hold === 'long' ? 'buy' : hold === 'short' ? 'sell' : (reduceOnly ? (side === 'buy' ? 'sell' : 'buy') : side)
    return { tradeSide: reduceOnly ? 'close' : 'open', side: direction }
  }
  return { side, reduceOnly: reduceOnly ? 'YES' : 'NO' }
}

/** 时效 → force。postOnly 优先；alo 等价 post_only（协议没有 post_only 枚举）。 */
export function forceOf(intent: OrderIntent): BitgetForce {
  if (intent.postOnly === true || intent.tif === 'alo') return 'post_only'
  const tif = intent.tif ?? 'gtc'
  if (tif === 'ioc') return 'ioc'
  if (tif === 'fok') return 'fok'
  return 'gtc'
}

function normalizePrice(label: string, raw: string, record: InstrumentRecord, mode: 'reject' | 'passive', side: 'buy' | 'sell', rounded: NonNullable<BuiltOrder['rounded']>): Decimal {
  if (toFx(raw) === undefined) return fail(bad('INVALID_PARAMS', `${label} is not a decimal number: ${JSON.stringify(raw)}`))
  const price = fx(raw)
  const tick = record.tick
  if (price % fx(tick) === 0n) return asDecimal(str(price))
  if (mode === 'reject') {
    return fail(bad('PRECISION', `${label} ${raw} is not a multiple of tick ${tick} for ${record.symbol} (set rounding: 'passive' to snap it)`))
  }
  // passive：买单向下、卖单向上，永不朝成交方向取整
  const snapped = snapToTick(str(price), tick, side === 'buy' ? 'down' : 'up')
  if (toFx(snapped) === undefined) return fail(bad('PRECISION', `${label} ${raw} rounds to zero for ${record.symbol}`))
  rounded.push({ field: label, from: raw, to: snapped })
  return snapped
}

/** 数量：给了 size 用 size，否则按 notional / 参考价折算；一律向零截断到 step。 */
function resolveSize(intent: OrderIntent, record: InstrumentRecord, priceForNotional: Decimal, ref: PriceRef): Decimal {
  let raw: Decimal
  if (intent.size !== undefined) {
    if (toFx(intent.size) === undefined) return fail(bad('INVALID_PARAMS', `size is not a decimal number: ${JSON.stringify(intent.size)}`))
    raw = asDecimal(normalizeDecimal(intent.size))
  } else if (intent.notional !== undefined) {
    const mid = ref.mid
    const base = mid !== undefined && mid > 0 ? str(fx(mid)) : priceForNotional
    if (toFx(base) === undefined) return fail(bad('STALE_PRICE', `no price to convert notional for ${intent.instrumentId}`, { retryAfterMs: 1_000 }))
    raw = asDecimal(str(div(fx(intent.notional), fx(base))))
  } else {
    return fail(bad('INVALID_PARAMS', 'order needs size or notional'))
  }
  if (toFx(raw) === undefined) return fail(bad('INVALID_PARAMS', 'size must be greater than zero'))
  const size = truncateToStep(raw, record.step)
  if (size === '0') {
    return fail(bad('PRECISION', `size ${raw} is below the lot step ${record.step} for ${record.symbol} (sizes truncate toward zero)`))
  }
  if (toFx(record.minSize) !== undefined && (fx(size) < fx(record.minSize))) {
    return fail(bad('PRECISION', `size ${size} is below the venue minimum ${record.minSize} for ${record.symbol}`))
  }
  return size
}

/**
 * 单个 OrderIntent → 线上请求体。无法构造时抛 OrderBuildError（带 Problem）。
 * `force` 只在普通委托上发（计划委托的触发后执行价由 executePrice 决定）。
 */
export function buildOrder(intent: OrderIntent, record: InstrumentRecord | undefined, ref: PriceRef = {}, opts: BuildOptions = {}): BuiltOrder {
  if (!record) return fail(bad('INSTRUMENT_UNKNOWN', `unknown instrument ${intent.instrumentId}`))
  if (record.instrument.status === 'delisted') return fail(bad('INSTRUMENT_UNKNOWN', `${intent.instrumentId} is delisted`))
  const type = intent.type
  if (!(record.instrument.orderTypes as string[]).includes(type)) {
    return fail(bad('ORDER_TYPE_UNSUPPORTED', `order type ${type} is not supported by this connector`))
  }
  if (intent.triggerType !== undefined && intent.triggerType !== 'mark') {
    return fail(bad('ORDER_TYPE_UNSUPPORTED', `trigger price type ${intent.triggerType} is not supported (Bitget mix triggers on mark price)`))
  }
  if (intent.tpsl !== undefined) {
    // 父单 + 保护单不是一次请求能表达的：保护单由 buildProtectionOrders() 在成交后补挂。
    return fail(bad('ORDER_TYPE_UNSUPPORTED', 'Bitget has no native parent-child order call in this connector; submit the parent alone and call buildProtectionOrders() after the fill'))
  }

  const isBuy = intent.side === 'buy'
  const isTrigger = type === 'stop_market' || type === 'stop_limit' || type === 'take_market' || type === 'take_limit'
  const isTrailing = type === 'trailing_stop'
  const mode = intent.rounding ?? 'reject'
  const rounded: NonNullable<BuiltOrder['rounded']> = []
  const marginCoin = opts.marginCoin ?? MARGIN_COIN
  const productType = opts.productType ?? PRODUCT_TYPE

  // ---- 价格 ----
  let price: Decimal | undefined
  let triggerPrice: Decimal | undefined
  if (type === 'market') {
    // 教训 4：市价意图必须带 maxSlippageBps；实际发价带限价 + force=ioc。
    if (intent.maxSlippageBps === undefined) {
      return fail(bad('INVALID_PARAMS', 'market orders need maxSlippageBps (no implicit default slippage)'))
    }
    const bps = Number(intent.maxSlippageBps)
    if (!Number.isFinite(bps) || bps <= 0) return fail(bad('INVALID_PARAMS', 'maxSlippageBps must be a positive number'))
    const maxAgeMs = opts.refPriceMaxAgeMs ?? DEFAULT_REF_PRICE_MAX_AGE_MS
    if (ref.ageMs !== undefined && ref.ageMs > maxAgeMs) {
      return fail(bad('STALE_PRICE', `reference price is ${ref.ageMs} ms old (max ${maxAgeMs} ms); refresh the quote before a market order`, { retryAfterMs: 1_000 }))
    }
    const mid = ref.mid ?? (ref.bid !== undefined && ref.ask !== undefined ? (ref.bid + ref.ask) / 2 : undefined)
    if (mid === undefined || mid <= 0 || ref.stale === true) {
      return fail(bad('STALE_PRICE', `no fresh price for ${intent.instrumentId}; cannot emulate a market order`, { retryAfterMs: 1_000 }))
    }
    const band = applyBps(str(fx(mid)), bps, isBuy ? 'up' : 'down')
    price = snapToTick(band, record.tick, isBuy ? 'down' : 'up')
    if (price === '0') return fail(bad('PRECISION', `market price band for ${intent.instrumentId} rounds to zero`))
  } else if (type === 'limit' || type === 'stop_limit' || type === 'take_limit') {
    if (intent.price === undefined) return fail(bad('INVALID_PARAMS', `${type} orders need price`))
    price = normalizePrice('price', intent.price, record, mode, intent.side, rounded)
  }
  if (isTrigger || isTrailing) {
    if (intent.triggerPrice === undefined) return fail(bad('INVALID_PARAMS', `${type} orders need triggerPrice`))
    triggerPrice = normalizePrice('triggerPrice', intent.triggerPrice, record, mode, intent.side, rounded)
  }
  if (isTrailing && intent.trailing === undefined) {
    return fail(bad('INVALID_PARAMS', 'trailing_stop orders need trailing.callbackRatio'))
  }
  if (isTrigger && type !== 'stop_market' && type !== 'take_market' && price === undefined) {
    return fail(bad('INVALID_PARAMS', `${type} orders need price`))
  }

  // ---- 数量 ----
  const priceForNotional = price ?? triggerPrice ?? asDecimal('0')
  const size = resolveSize(intent, record, priceForNotional, ref)
  if (intent.reduceOnly !== true && record.minNotional !== undefined && priceForNotional !== '0') {
    const notional = mul(fx(size), fx(priceForNotional))
    if (notional < fx(record.minNotional)) {
      fail(bad('MIN_NOTIONAL', `order value ${str(notional)} is below the venue minimum ${record.minNotional} ${marginCoin} (reduce-only orders are exempt)`))
    }
  }

  const clientOrderId = sanitizeClientOid(intent.clientOrderId ?? newClientOrderId())
  const body: Record<string, string> = {
    symbol: record.symbol,
    productType,
    marginCoin,
    marginMode: normalizeMarginMode(intent.marginMode ?? opts.marginMode),
    size,
    ...positionFields(intent.side, intent.reduceOnly === true, opts),
    clientOid: clientOrderId,
  }

  if (isTrigger || isTrailing) {
    // 计划委托：官方 v2 字段（QD 未调用 place-plan-order），未经真网核对。
    // executePrice / rangeRate 只属于 place-tpsl-order（QD native_protection.py:200-225），这里不发。
    body['planType'] = isTrailing ? 'track_plan' : 'normal_plan'
    body['triggerType'] = 'mark_price'
    body['triggerPrice'] = triggerPrice!
    if (isTrailing) {
      body['orderType'] = 'market'
      body['callbackRatio'] = str(mul(fx(String(intent.trailing!.callbackRatio)), fx('100')))
    } else if (type === 'stop_market' || type === 'take_market') {
      body['orderType'] = 'market'
    } else {
      body['orderType'] = 'limit'
      body['price'] = price!
    }
    return {
      endpoint: 'plan',
      body,
      clientOrderId,
      planType: body['planType']!,
      reduceOnly: intent.reduceOnly === true,
      ...(rounded.length > 0 ? { rounded } : {}),
    }
  }

  body['orderType'] = 'limit'
  body['price'] = price!
  body['force'] = type === 'market' ? 'ioc' : forceOf(intent)
  return {
    endpoint: 'order',
    body,
    clientOrderId,
    reduceOnly: intent.reduceOnly === true,
    ...(rounded.length > 0 ? { rounded } : {}),
  }
}

// ---- 成交后补挂的保护单（位置级 TP / SL / 追踪） -----------------------------

export interface ProtectionRequest {
  symbol: string
  /** 持仓方向决定 holdSide；保护单永远是平仓方向。 */
  holdSide: 'long' | 'short'
  /** 币数量（与开仓同口径）。 */
  size: string
  productType?: string
  marginCoin?: string
  stopLossPrice?: string
  takeProfitPrice?: string
  /** 0.02 = 2%（不是 bps）。 */
  trailingPercent?: number
  activationPrice?: string
  entryPrice?: string
  clientOrderId?: string
}

export interface ProtectionOrder {
  role: 'tp' | 'sl' | 'trail'
  body: Record<string, string>
  /** 逐条回报：成功 / 失败不互相掩盖（由 placeProtection 填）。 */
  ok?: boolean
  venueOrderId?: string
  problem?: Problem
}

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/live_trading/native_protection.py:190-229; adapted.
/**
 * 位置级保护单（POST /api/v2/mix/order/place-tpsl-order）：
 *   · SL → planType=loss_plan，TP → profit_plan，追踪 → moving_plan + rangeRate（QD :206-228）；
 *   · triggerType 固定 mark_price，executePrice=0（市价执行）；追踪单不带 executePrice（QD :225）；
 *   · clientOid 由父单 id 加 `-sl` / `-tp` / `-trail` 后缀并截到 64 位（QD :213-214）。
 */
export function buildProtectionOrders(req: ProtectionRequest, record?: InstrumentRecord): ProtectionOrder[] {
  const marginCoin = req.marginCoin ?? MARGIN_COIN
  const productType = req.productType ?? PRODUCT_TYPE
  const size = record ? truncateToStep(req.size, record.step) : asDecimal(normalizeDecimal(req.size))
  if (toFx(size) === undefined) throw new OrderBuildError(bad('PRECISION', `protection size ${req.size} is below the lot step`))
  const base: Record<string, string> = {
    marginCoin,
    productType,
    symbol: req.symbol,
    triggerType: 'mark_price',
    executePrice: '0',
    holdSide: req.holdSide,
    size,
  }
  const out: ProtectionOrder[] = []
  const suffixOf = (suffix: string): string | undefined =>
    req.clientOrderId === undefined ? undefined : sanitizeClientOid(`${req.clientOrderId}${suffix}`, 64)
  if (req.stopLossPrice !== undefined && toFx(req.stopLossPrice) !== undefined) {
    const body: Record<string, string> = { ...base, planType: 'loss_plan', triggerPrice: asDecimal(normalizeDecimal(req.stopLossPrice)) }
    const oid = suffixOf('-sl')
    if (oid !== undefined) body['clientOid'] = oid
    out.push({ role: 'sl', body })
  }
  if (req.takeProfitPrice !== undefined && toFx(req.takeProfitPrice) !== undefined) {
    const body: Record<string, string> = { ...base, planType: 'profit_plan', triggerPrice: asDecimal(normalizeDecimal(req.takeProfitPrice)) }
    const oid = suffixOf('-tp')
    if (oid !== undefined) body['clientOid'] = oid
    out.push({ role: 'tp', body })
  }
  if (req.trailingPercent !== undefined && req.trailingPercent > 0) {
    const activation = req.activationPrice ?? req.entryPrice
    if (activation === undefined || toFx(activation) === undefined) {
      throw new OrderBuildError(bad('INVALID_PARAMS', 'trailing protection needs activationPrice or entryPrice'))
    }
    const body: Record<string, string> = {
      ...base,
      planType: 'moving_plan',
      triggerPrice: asDecimal(normalizeDecimal(activation)),
      rangeRate: str(mul(fx(String(req.trailingPercent)), fx('100'))),
    }
    delete body['executePrice']
    const oid = suffixOf('-trail')
    if (oid !== undefined) body['clientOid'] = oid
    out.push({ role: 'trail', body })
  }
  return out
}

/** 诊断：把 BuiltOrder 的 body 键排序（日志 / 断言用，不改请求）。 */
export function describeBody(body: Record<string, string>): string {
  return Object.keys(body).sort().map((k) => `${k}=${body[k]}`).join('&')
}
