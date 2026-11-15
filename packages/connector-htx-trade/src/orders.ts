// SPDX-License-Identifier: CPAL-1.0
// OrderIntent → HTX 下单请求体（纯函数：无网络、无签名，单测直接断言参数表）。
// 口径来源：
//   QD live_trading/htx_v5.py:240-289（v1 交叉保证金建单体：contract_code / volume / direction / lever_rate /
//   order_price_type / offset / reduce_only / price / client_order_id）、:318-367（V5 建单体：contract_code /
//   volume / side / type / margin_mode / position_side / reduce_only / price / client_order_id）、
//   :292-315（position_side 推导：single_side→both，dual_side 按 side+reduce_only 推 long/short）、
//   :473-484（撤单体）、:487-498（订单查询参数）、:501-506（杠杆体）；
//   QD live_trading/native_protection.py:325-352（HTX 止盈止损委托 swap_cross_tpsl_order 的字段与 optimal_5 价格类型）；
//   HTX 官方《USDT 本位永续 · 合约下单 / 撤单 / 止盈止损委托》的字段表。
// 四个关键决定（README 里也写）：
//   1) **市价意图不发市价**：HTX 的 market 单不带价，限不了滑点，所以一律发「参考价 ± maxSlippageBps 的限价 + IOC」
//      （照 HL orders.ts:122 与 limit-safety.ts），缺 maxSlippageBps 直接 INVALID_PARAMS；
//   2) HTX 永续按**张**下单：volume = 币数量 / 面值（BuildOptions.faceValue），v5 发字符串；
//      缺省 rounding=reject：不是面值整数倍直接 1002；passive 向下截到整张；
//   3) 触发单（stop_* / take_*）本包**不声明**：HTX 的「计划委托」端点不在 QD 的参照实现里，本包不凭记忆编端点，
//      能力声明里给 none，调用回 1004；保护腿走 buildTpslBody()（swap_cross_tpsl_order，QD 有实现）；
//   4) client_order_id 是 **int64**：本包把内核的字符串 id 做**确定性映射**（numericClientOrderId），
//      对账时用同一函数把内核 id 换成 int64 再与场所比（映射不可逆，见 README 的「已知限制」）。
import { createHash, randomBytes } from 'node:crypto'
import { makeProblem } from '@gitrader/protocol'
import type { Decimal, Instrument, OrderIntent, OrderType, Problem } from '@gitrader/protocol'
import { ProblemError } from './errors'
import { clampLimitPrice } from './limit-safety'
import { baseToContracts, contractsToBase, isMultipleOf, snapToTick, toFx } from './precision'

/** 本连接器实际发出的协议订单类型（触发单与 twap / 追踪不声明，见文件头 3)）。 */
export const SUPPORTED_ORDER_TYPES = ['market', 'limit'] as const
export const SUPPORTED_TIF = ['gtc', 'ioc', 'fok', 'alo'] as const
/** HTX 的触发价类型本包不用；保留常量供能力声明。 */
export const SUPPORTED_TRIGGER_TYPES = ['last'] as const

/** HTX v5 的 `type` / v1 的 `order_price_type`（同一个枚举的两套名字，QD htx_v5.py:167-187 有映射）。 */
export const ORDER_PRICE_TYPE = {
  limit: 'limit',
  ioc: 'ioc',
  fok: 'fok',
  post_only: 'post_only',
} as const

/** client_order_id 是 int64：QD 取十进制数字的最后 18 位（htx.py:77-84）。 */
export const CLIENT_ORDER_ID_MAX_DIGITS = 18

export type OrderFamily = 'v5' | 'v1'

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

/** 新客户端订单号：`gt` + 24 hex（内核侧的字符串 id；发给 HTX 时映射成 int64）。 */
export function newClientOrderId(): string {
  return `gt${randomBytes(12).toString('hex')}`
}

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/live_trading/htx.py:77-84; adapted.
/**
 * 字符串 clientOrderId → HTX 的 int64 文本（确定性、可重复：同一输入永远同一输出）。
 *   · 有十进制数字：取最后 18 位（QD 同向），去掉前导 0；
 *   · 没有数字：SHA-256 前 16 字节取模 2^62 再 +1（落在 int64 正区间，且不会为 0）。
 * 这个映射**不可逆**：对账时用同一函数把内核 id 换成 int64 再与场所的 client_order_id 比。
 */
export function numericClientOrderId(clientOrderId: string): string {
  const digits = clientOrderId.replace(/\D/g, '')
  if (digits !== '') {
    const tail = digits.slice(-CLIENT_ORDER_ID_MAX_DIGITS).replace(/^0+/, '')
    if (tail !== '') return tail
  }
  const hash = createHash('sha256').update(clientOrderId, 'utf8').digest()
  const value = hash.readBigUInt64BE(0) & ((1n << 62n) - 1n)
  return (value + 1n).toString()
}

export interface PriceRef {
  bid?: number
  ask?: number
  last?: number
  mid?: number
  stale?: boolean
}

export interface BuildOptions {
  /** v5（缺省，多资产保证金账户）或 v1（交叉保证金账户）；签名与端点见 rest.ts。 */
  family?: OrderFamily
  /** 双向持仓（dual_side）账户：v5 发 long/short，v1 发 offset open/close。 */
  hedge?: boolean
  /** 双向模式下内核可显式指定持仓方向；缺省按 side + reduceOnly 推导（QD htx_v5.py:292-315）。 */
  posSide?: 'long' | 'short'
  /** 杠杆（v1 建单必填 lever_rate；v5 走 /v5/position/lever，不进建单体）。 */
  leverage?: number
  /** 保证金模式（v5 建单体必填）。 */
  marginMode?: 'cross' | 'isolated'
  /** 一张合约的面值（币，必填）：由连接器从市场表的私有面值表注入，缺 → INSTRUMENT_UNKNOWN。 */
  faceValue?: string
  ref?: PriceRef
  /** 主动成交（吃单）还是被动挂单：passive 时价格向不成交方向取整、数量向下截到整张。 */
  rounding?: 'reject' | 'passive'
}

export interface BuiltOrder {
  body: Record<string, unknown>
  /** 内核侧字符串 id（ack 用）。 */
  clientOrderId: string
  /** 发给场所的 int64 文本。 */
  venueClientOrderId: string
  /** 张数。 */
  volume: number
  family: OrderFamily
  /** passive 取整时记录原值 / 新值，供回执展示。 */
  rounded: Array<{ field: string; from: string; to: string }>
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
  if (toFx(raw) === undefined) fail(bad('INVALID_PARAMS', `${field} must be a positive decimal number: ${JSON.stringify(raw)}`))
  if (tick === undefined) return raw as Decimal // 没有 tick 信息时只做语法 / 正数校验，不猜精度
  if (isMultipleOf(raw, tick)) return raw as Decimal
  if (mode === 'reject') {
    fail(bad('PRECISION', `${field} ${raw} is not a multiple of the price tick ${tick} for ${instrument.symbol}`))
  }
  const snapped = snapToTick(raw, tick, side === 'buy' ? 'down' : 'up')
  if (!(Number(snapped) > 0)) fail(bad('PRECISION', `${field} ${raw} rounds to zero for ${instrument.symbol}`))
  rounded.push({ field, from: raw, to: String(snapped) })
  return snapped
}

function baseQtyOf(intent: OrderIntent, refPx: number | undefined): { qty: string; fromNotional: boolean } {
  if (intent.size !== undefined) return { qty: String(intent.size), fromNotional: false }
  if (intent.notional === undefined) return fail(bad('INVALID_PARAMS', 'order needs size or notional'))
  const notional = Number(intent.notional)
  if (!Number.isFinite(notional) || notional <= 0) fail(bad('INVALID_PARAMS', 'notional must be a positive number'))
  if (refPx === undefined || !(refPx > 0)) {
    fail(bad('STALE_PRICE', 'no reference price to convert notional into size', { retryAfterMs: 1_000 }))
  }
  // 名义额 → 币数量：先除再按张截断（截断只会更小，不会超买）
  return { qty: String(notional / (refPx as number)), fromNotional: true }
}

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/live_trading/htx_v5.py:292-315; adapted.
/**
 * 双向持仓模式下的 position_side / offset 推导：
 *   · 单向（single_side）：v5 `position_side=both`；v1 `offset=both` + reduce_only=1（平仓时）；
 *   · 双向（dual_side）：开多 buy→long / 开空 sell→short；平多 sell→long / 平空 buy→short；
 *     v1 对应 offset=open / close（不再发 reduce_only）。
 * 显式给了 posSide 就听内核的。
 */
export function positionSideOf(
  side: 'buy' | 'sell',
  reduceOnly: boolean,
  hedge: boolean,
  posSide?: 'long' | 'short',
): 'long' | 'short' | 'both' {
  if (!hedge) return 'both'
  if (posSide === 'long' || posSide === 'short') return posSide
  if (reduceOnly) return side === 'sell' ? 'long' : 'short'
  return side === 'buy' ? 'long' : 'short'
}

/** v1 的 direction 字段就是协议 side。 */
export function directionOf(side: 'buy' | 'sell'): 'buy' | 'sell' {
  return side
}

/**
 * 单个 OrderIntent → 下单请求体（v5 或 v1）。无法构造时抛 OrderBuildError（带 Problem）。
 * 键顺序固定（contract_code, volume, side|direction, type|order_price_type, margin_mode, position_side|offset,
 * price, reduce_only, client_order_id），签名对拍友好。
 */
export function buildOrderBody(intent: OrderIntent, instrument: Instrument | undefined, opts: BuildOptions = {}): BuiltOrder {
  if (!instrument) fail(bad('INSTRUMENT_UNKNOWN', `unknown instrument ${intent.instrumentId}`))
  if (instrument.status === 'delisted') fail(bad('INSTRUMENT_UNKNOWN', `${intent.instrumentId} is delisted`))
  const family: OrderFamily = opts.family ?? 'v5'
  const type = intent.type
  if (type === 'twap') fail(bad('ORDER_TYPE_UNSUPPORTED', 'order type twap is not supported by this connector'))
  if (type === 'trailing_stop') fail(bad('ORDER_TYPE_UNSUPPORTED', 'HTX has no trailing order on the order endpoint; the kernel keeps trailing stops'))
  if (type !== 'market' && type !== 'limit') {
    fail(bad('ORDER_TYPE_UNSUPPORTED', `order type ${type} needs a trigger-order endpoint that this connector does not claim (capabilities: none)`))
  }
  if (intent.triggerPrice !== undefined && type !== 'market' && type !== 'limit') {
    fail(bad('INVALID_PARAMS', `${type} orders do not take triggerPrice`))
  }

  const mode = opts.rounding ?? intent.rounding ?? 'reject'
  const rounded: BuiltOrder['rounded'] = []
  const isMarketIntent = type === 'market'

  // ---- 价格 ----
  let price: Decimal | undefined
  let refPx: number | undefined
  if (isMarketIntent) {
    if (intent.maxSlippageBps === undefined) {
      fail(bad('INVALID_PARAMS', 'market orders need maxSlippageBps (no implicit default slippage)'))
    }
    const bps = Number(intent.maxSlippageBps)
    if (!Number.isFinite(bps) || bps <= 0) fail(bad('INVALID_PARAMS', 'maxSlippageBps must be a positive number'))
    if (intent.tif !== undefined && intent.tif !== 'ioc') {
      fail(bad('ORDER_TYPE_UNSUPPORTED', `market orders cannot take time in force ${intent.tif}`))
    }
    if (intent.postOnly === true) fail(bad('ORDER_TYPE_UNSUPPORTED', 'postOnly needs a limit order'))
    refPx = refPriceOf(opts.ref)
    if (opts.ref?.stale === true || refPx === undefined) {
      fail(bad('STALE_PRICE', `no fresh reference price for ${intent.instrumentId}; cannot emulate a market order`, { retryAfterMs: 1_000 }))
    }
    const band = bps / 1e4
    const raw = intent.side === 'buy' ? refPx * (1 + band) : refPx * (1 - band)
    const { price: bounded } = clampLimitPrice(intent.side, raw, refPx, bps)
    // 浮点数可能落成科学计数法：这里改成无指数的十进制文本再贴 tick。
    const text = bounded.toFixed(20).replace(/0+$/, '').replace(/\.$/, '')
    price = normalizePrice('price', text, instrument, 'passive', intent.side, rounded)
  } else {
    if (intent.price === undefined) fail(bad('INVALID_PARAMS', 'limit orders need price'))
    price = normalizePrice('price', String(intent.price), instrument, mode, intent.side, rounded)
    refPx = refPriceOf(opts.ref)
  }

  // ---- 数量：币数量 → 整数张；面值只从 opts.faceValue 取（不从 instrument.contractSize 猜） ----
  const faceRaw = opts.faceValue
  if (faceRaw === undefined || toFx(faceRaw) === undefined) {
    fail(bad('INSTRUMENT_UNKNOWN', `contract size unknown for ${instrument.symbol}; call start() first`))
  }
  const faceValue = String(faceRaw)
  const { qty: baseQty, fromNotional } = baseQtyOf(intent, Number(price ?? refPx ?? NaN) > 0 ? Number(price ?? refPx) : undefined)
  if (toFx(baseQty) === undefined) fail(bad('INVALID_PARAMS', `size is not a positive decimal number: ${JSON.stringify(baseQty)}`))
  const volume = baseToContracts(baseQty, faceValue)
  if (!isMultipleOf(baseQty, faceValue)) {
    // 名义额换算出来的数量永远向下截到整张；只有内核明确给 size 时才按 rounding 处理。
    if (!fromNotional && mode === 'reject') {
      fail(bad('PRECISION', `size ${baseQty} is not a multiple of the contract face value ${faceValue} for ${instrument.symbol}`))
    }
    rounded.push({ field: 'size', from: baseQty, to: String(contractsToBase(volume, faceValue)) })
  }
  if (volume < 1) {
    fail(bad('PRECISION', `size ${baseQty} is below one contract (face value ${faceValue}) for ${instrument.symbol}`))
  }
  // 最小名义额 = 张数 × 面值 × 价（reduce-only 平仓豁免）
  const minNotional = Number(instrument.minNotional ?? NaN)
  if (intent.reduceOnly !== true && Number.isFinite(minNotional) && minNotional > 0 && Number.isFinite(Number(price ?? refPx))) {
    const notional = volume * Number(faceValue) * Number(price ?? refPx)
    if (notional < minNotional) {
      fail(bad('MIN_NOTIONAL', `order notional ${notional.toFixed(4)} is below the venue minimum ${minNotional} for ${instrument.symbol}`))
    }
  }

  // ---- order price type：v1 用 order_price_type；v5 的 type 只有 limit / post_only，IOC/FOK 走 time_in_force ----
  let priceType: string
  if (isMarketIntent) {
    priceType = ORDER_PRICE_TYPE.ioc
  } else if (intent.postOnly === true) {
    if (intent.tif !== undefined && intent.tif !== 'alo' && intent.tif !== 'gtc') {
      fail(bad('ORDER_TYPE_UNSUPPORTED', `postOnly cannot be combined with tif ${intent.tif}`))
    }
    priceType = ORDER_PRICE_TYPE.post_only
  } else {
    const tif = intent.tif ?? 'gtc'
    if (tif === 'gtc') priceType = ORDER_PRICE_TYPE.limit
    else if (tif === 'ioc') priceType = ORDER_PRICE_TYPE.ioc
    else if (tif === 'fok') priceType = ORDER_PRICE_TYPE.fok
    else if (tif === 'alo') priceType = ORDER_PRICE_TYPE.post_only
    else fail(bad('ORDER_TYPE_UNSUPPORTED', `time in force ${tif} is not supported (gtc / ioc / fok / alo)`))
  }

  const hedge = opts.hedge === true
  const reduceOnly = intent.reduceOnly === true
  const clientOrderId = intent.clientOrderId !== undefined ? String(intent.clientOrderId) : newClientOrderId()
  const venueClientOrderId = numericClientOrderId(clientOrderId)
  const body: Record<string, unknown> = {
    contract_code: instrument.symbol,
    volume: family === 'v5' ? String(volume) : volume,
  }
  if (family === 'v5') {
    body.side = intent.side
    if (isMarketIntent) {
      body.type = ORDER_PRICE_TYPE.limit
      body.time_in_force = ORDER_PRICE_TYPE.ioc
    } else if (priceType === ORDER_PRICE_TYPE.post_only) {
      body.type = ORDER_PRICE_TYPE.post_only
    } else {
      body.type = ORDER_PRICE_TYPE.limit
      body.time_in_force = intent.tif ?? 'gtc'
    }
    body.margin_mode = opts.marginMode ?? 'cross'
    body.position_side = positionSideOf(intent.side, reduceOnly, hedge, opts.posSide)
    if (price !== undefined) body.price = String(price)
    if (reduceOnly) body.reduce_only = 1
  } else {
    if ((opts.marginMode ?? 'cross') !== 'cross') {
      fail(bad('INVALID_PARAMS', 'v1 accounts are cross-margin only; isolated margin is not available on this family'))
    }
    const lever = opts.leverage ?? intent.leverage
    if (lever === undefined) {
      fail(bad('INVALID_PARAMS', 'v1 orders carry lever_rate; call setLeverage first or pass intent.leverage — the connector does not guess it'))
    }
    if (!Number.isInteger(lever) || lever < 1) {
      fail(bad('INVALID_PARAMS', 'leverage must be a positive integer'))
    }
    body.direction = directionOf(intent.side)
    body.offset = hedge ? (reduceOnly ? 'close' : 'open') : 'both'
    body.lever_rate = lever
    body.order_price_type = priceType
    if (price !== undefined) body.price = String(price)
    if (reduceOnly && !hedge) body.reduce_only = 1
  }
  body.client_order_id = venueClientOrderId
  return { body, clientOrderId, venueClientOrderId, volume, family, rounded }
}

/** 撤单体：contract_code + （order_id 或 client_order_id 之一）。 */
export function buildCancelBody(
  contractCode: string,
  key: { venueOrderId?: string; clientOrderId?: string },
): Record<string, unknown> {
  const body: Record<string, unknown> = { contract_code: contractCode }
  if (key.venueOrderId !== undefined && key.venueOrderId !== '') {
    body.order_id = String(key.venueOrderId)
  } else if (key.clientOrderId !== undefined && key.clientOrderId !== '') {
    // 场所的 client_order_id 是 int64：内核字符串先过确定性映射（若调用方已给纯数字则原样）。
    const raw = String(key.clientOrderId)
    body.client_order_id = /^\d+$/.test(raw) ? raw : numericClientOrderId(raw)
  } else {
    fail(bad('INVALID_PARAMS', 'cancel needs venueOrderId or clientOrderId'))
  }
  return body
}

/** 全撤体：不给 contractCode 就是该账户的全部合约（官方 direction / offset 可选，本包不发）。 */
export function buildCancelAllBody(contractCode?: string): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  if (contractCode !== undefined && contractCode !== '') body.contract_code = contractCode
  return body
}

/** 订单查询参数（contract_code + order_id / client_order_id）。 */
export function buildOrderQueryParams(
  contractCode: string,
  key: { venueOrderId?: string; clientOrderId?: string },
): Record<string, string> {
  const params: Record<string, string> = { contract_code: contractCode }
  if (key.venueOrderId !== undefined && key.venueOrderId !== '') params.order_id = String(key.venueOrderId)
  else if (key.clientOrderId !== undefined && key.clientOrderId !== '') {
    const raw = String(key.clientOrderId)
    params.client_order_id = /^\d+$/.test(raw) ? raw : numericClientOrderId(raw)
  } else fail(bad('INVALID_PARAMS', 'order query needs venueOrderId or clientOrderId'))
  return params
}

/** 杠杆体：v5 带 margin_mode；v1 官方字段只有 contract_code / lever_rate（没有 margin_mode）。 */
export function buildLeverBody(
  contractCode: string,
  leverage: number,
  marginMode: 'cross' | 'isolated' = 'cross',
  family: OrderFamily = 'v5',
): Record<string, unknown> {
  if (!Number.isInteger(leverage) || leverage < 1 || leverage > 125) {
    fail(bad('INVALID_PARAMS', 'leverage must be an integer from 1 to 125'))
  }
  if (family === 'v1') {
    if (marginMode !== 'cross') fail(bad('INVALID_PARAMS', 'v1 accounts are cross-margin only; isolated leverage is not available on this family'))
    return { contract_code: contractCode, lever_rate: leverage }
  }
  return { contract_code: contractCode, lever_rate: leverage, margin_mode: marginMode }
}

export interface TpslLeg {
  triggerPrice: Decimal
  /** 触发后下的委托价；不给就用对手价 5 档（optimal_5，QD native_protection.py:335-341）。 */
  price?: Decimal
}

export interface TpslSpec {
  contractCode: string
  /** 平仓方向：平多 = sell，平空 = buy。 */
  direction: 'buy' | 'sell'
  /** 张数（整数）。 */
  volume: number
  takeProfit?: TpslLeg
  stopLoss?: TpslLeg
  /** 触发后的价格类型标签（缺省 optimal_5）。 */
  priceType?: 'optimal_5' | 'optimal_10' | 'optimal_20' | 'limit'
}

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/live_trading/native_protection.py:325-352; adapted.
/**
 * 止盈止损委托体（POST /linear-swap-api/v1/swap_cross_tpsl_order）：
 *   contract_code / direction / volume + tp_trigger_price / tp_order_price* / sl_trigger_price / sl_order_price*。
 * 这是**仓位级**保护（覆盖该合约已有的止盈止损单），纯函数、不联网；由内核在成交后调用。
 */
export function buildTpslBody(spec: TpslSpec): Record<string, unknown> {
  if (spec.takeProfit === undefined && spec.stopLoss === undefined) {
    fail(bad('INVALID_PARAMS', 'tpsl needs takeProfit or stopLoss'))
  }
  if (!Number.isInteger(spec.volume) || spec.volume < 1) {
    fail(bad('PRECISION', `tpsl volume must be a positive integer number of contracts, got ${String(spec.volume)}`))
  }
  if (spec.direction !== 'buy' && spec.direction !== 'sell') fail(bad('INVALID_PARAMS', 'tpsl direction must be buy or sell'))
  const priceType = spec.priceType ?? 'optimal_5'
  const body: Record<string, unknown> = {
    contract_code: spec.contractCode,
    direction: spec.direction,
    volume: spec.volume,
  }
  const leg = (prefix: 'tp' | 'sl', part: TpslLeg): void => {
    if (toFx(String(part.triggerPrice)) === undefined) fail(bad('INVALID_PARAMS', `${prefix}_trigger_price must be a positive decimal number`))
    body[`${prefix}_trigger_price`] = String(part.triggerPrice)
    if (part.price !== undefined) {
      if (toFx(String(part.price)) === undefined) fail(bad('INVALID_PARAMS', `${prefix}_order_price must be a positive decimal number`))
      body[`${prefix}_order_price`] = String(part.price)
      body[`${prefix}_order_price_type`] = 'limit'
    } else {
      body[`${prefix}_order_price_type`] = priceType
    }
  }
  if (spec.takeProfit !== undefined) leg('tp', spec.takeProfit)
  if (spec.stopLoss !== undefined) leg('sl', spec.stopLoss)
  return body
}

/** 触发价相对平仓方向的合法性（止盈在有利侧、止损在不利侧）；拿不到参考价就只做正数校验。 */
export function tpslSideOk(kind: 'tp' | 'sl', direction: 'buy' | 'sell', triggerPrice: number, refPrice: number): boolean {
  if (!Number.isFinite(triggerPrice) || triggerPrice <= 0 || !Number.isFinite(refPrice) || refPrice <= 0) return false
  if (kind === 'tp') return direction === 'sell' ? triggerPrice > refPrice : triggerPrice < refPrice
  return direction === 'sell' ? triggerPrice < refPrice : triggerPrice > refPrice
}

/** 订单类型声明（能力表与测试共用）。 */
export const ORDER_TYPE_SUPPORT: Record<OrderType, 'native' | 'emulated' | 'none'> = {
  market: 'emulated',
  limit: 'native',
  stop_market: 'none',
  stop_limit: 'none',
  take_market: 'none',
  take_limit: 'none',
  trailing_stop: 'none',
  twap: 'none',
}
