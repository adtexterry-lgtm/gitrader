// SPDX-License-Identifier: CPAL-1.0
// OrderIntent → OKX v5 下单参数（纯函数：无网络、无签名，单测直接断言参数表）。
// 口径来源：
//   QD live_trading/okx.py:774-846（place_market_order）、:848-919（place_limit_order）——tdMode / posSide /
//   ordType / sz / clOrdId / reduceOnly 的用法；:743-772（_resolve_pos_side：net_mode 用 net，long_short_mode
//   必须 long / short）；:214-267（_normalize_order_size：**sz 是张，币数量要先除以 ctVal 再按 lotSz 截断**）；
//   native_protection.py:152-187（_place_okx：条件单 / 保护单带 TriggerPxType = mark）；
//   okx.py:936-1079（算法挂单查询 / 撤单：orders-algo-pending、cancel-algos）。
// 四个关键差异，已在 README 写明：
//   1) 数量单位：协议 OrderIntent.size 是**币数量**，OKX `sz` 是**张** → contractsOf(size, ctVal, lotContracts)；
//   2) 触发单不是 /trade/order：stop / take 走 order-algo 的 `conditional`，两腿一起走 `oco`，
//      追踪止损走 `move_order_stop`；twap 不声明（1004）；
//   3) tif 在 OKX 是 ordType 的一部分：alo → post_only，ioc → ioc，fok → fok，gtc → limit；
//   4) 没有原生 attach 式 TP/SL：带 tpsl 的 submit 返回 1004，成交后由内核调 buildProtectionOrders()
//      —— 好消息是保护对在 OKX 上可以用**一条 OCO 算法单**表达（而不是两条独立单）。
import { randomBytes } from 'node:crypto'
import { makeProblem } from '@gitrader/protocol'
import { add, div, fx, mul, str, sub } from '@gitrader/protocol/decimal'
import type { Decimal, OrderIntent, OrderType, Problem } from '@gitrader/protocol'
import { ProblemError } from './errors'
import { baseOf, contractsOf, isMultipleOf, snapToTick, toFx } from './precision'
import type { InstrumentRecord } from './parse'

/** 协议订单类型 → OKX 的投递方式。 */
export const ORDER_TYPE_MAP: Record<Exclude<OrderType, 'twap'>, { channel: 'order' | 'algo'; ordType: string }> = {
  market: { channel: 'order', ordType: 'market' },
  limit: { channel: 'order', ordType: 'limit' },
  stop_market: { channel: 'algo', ordType: 'conditional' },
  stop_limit: { channel: 'algo', ordType: 'conditional' },
  take_market: { channel: 'algo', ordType: 'conditional' },
  take_limit: { channel: 'algo', ordType: 'conditional' },
  trailing_stop: { channel: 'algo', ordType: 'move_order_stop' },
}

export const ORDER_PATH = '/api/v5/trade/order'
export const ALGO_PATH = '/api/v5/trade/order-algo'

const PRICE_TYPES = new Set<string>(['limit', 'stop_limit', 'take_limit'])
const TRIGGER_TYPES = new Set<string>(['stop_market', 'stop_limit', 'take_market', 'take_limit'])
const TAKE_TYPES = new Set<string>(['take_market', 'take_limit'])

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

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/live_trading/okx.py:827-830 (clOrdId); adapted.
/** 新客户端订单号：`gt` + 24 hex。OKX 只接受大小写字母与数字，最长 32。 */
export function newClientOrderId(): string {
  return `gt${randomBytes(12).toString('hex')}`
}

/** 只保留 OKX 允许的字符集（字母数字）并截到 32 字符。 */
export function sanitizeClientOrderId(id: string): string {
  const cleaned = id.replace(/[^A-Za-z0-9]/g, '').slice(0, 32)
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
  /** oneWay（缺省，= OKX net_mode）发 posSide=net 并允许 reduceOnly；hedge（= long_short_mode）发 long / short。 */
  positionMode?: 'oneWay' | 'hedge'
  /** 显式指定持仓方向（hedge 模式下内核可覆盖）；缺省按 side + reduceOnly 推导。 */
  posSide?: 'net' | 'long' | 'short'
  ref?: PriceRef
}

export interface BuiltOrderParams {
  /** order = /api/v5/trade/order（market / limit）；algo = /api/v5/trade/order-algo。 */
  kind: 'order' | 'algo'
  path: string
  body: Record<string, string>
  clientOrderId: string
  posSide: 'net' | 'long' | 'short'
  /** 发出去的 sz（张）与折算后的币数量。 */
  contracts: Decimal
  baseSize: Decimal
  /** passive 取整时记录原值 / 新值，供回执展示。 */
  rounded: Array<{ field: string; from: string; to: string }>
}

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/live_trading/okx.py:743-772; adapted.
/**
 * 持仓方向：net_mode 一律 net；long_short_mode 开仓 buy→long / sell→short，平仓（reduceOnly）反过来。
 * QD 在 long_short_mode 下拒绝空 posSide，这里用同一规则推导而不是拒绝。
 */
export function resolvePosSide(
  side: 'buy' | 'sell',
  reduceOnly: boolean,
  mode: 'oneWay' | 'hedge',
  explicit?: 'net' | 'long' | 'short',
): 'net' | 'long' | 'short' {
  if (mode === 'oneWay') return 'net'
  if (explicit !== undefined && explicit !== 'net') return explicit
  if (reduceOnly) return side === 'sell' ? 'long' : 'short'
  return side === 'buy' ? 'long' : 'short'
}

function refPriceOf(ref: PriceRef | undefined): number | undefined {
  if (!ref) return undefined
  if (ref.mid !== undefined && Number.isFinite(ref.mid) && ref.mid > 0) return ref.mid
  if (ref.bid !== undefined && ref.ask !== undefined && ref.bid > 0 && ref.ask > 0) return (ref.bid + ref.ask) / 2
  if (ref.last !== undefined && Number.isFinite(ref.last) && ref.last > 0) return ref.last
  return undefined
}

/** 市价带价：中间价 ± bps，买单向下贴 tick、卖单向上贴 tick（只收紧）。 */
function marketLimitPrice(
  ref: PriceRef | undefined,
  bps: number,
  rec: InstrumentRecord,
  side: 'buy' | 'sell',
  rounded: BuiltOrderParams['rounded'],
): Decimal {
  const mid = refPriceOf(ref)
  if (mid === undefined) fail(bad('STALE_PRICE', `no reference price for a market order on ${rec.instrument.symbol}`, { retryAfterMs: 1_000 }))
  const midFx = fx(String(mid))
  const bpsFx = fx(String(bps))
  const delta = div(mul(midFx, bpsFx), fx('10000'))
  const raw = str(side === 'buy' ? add(midFx, delta) : sub(midFx, delta))
  const tick = rec.instrument.price.tick
  if (tick === undefined) return raw as Decimal
  const snapped = snapToTick(raw, tick, side === 'buy' ? 'down' : 'up')
  if (!(Number(snapped) > 0)) fail(bad('PRECISION', `market price ${raw} rounds to zero for ${rec.instrument.symbol}`))
  if (String(snapped) !== raw) rounded.push({ field: 'price', from: raw, to: String(snapped) })
  return snapped
}

function normalizePrice(
  field: string,
  raw: string,
  rec: InstrumentRecord,
  mode: 'reject' | 'passive',
  side: 'buy' | 'sell',
  rounded: BuiltOrderParams['rounded'],
): Decimal {
  const x = toFx(raw)
  if (x === undefined) fail(bad('INVALID_PARAMS', `${field} must be a positive decimal number: ${JSON.stringify(raw)}`))
  const tick = rec.instrument.price.tick
  if (tick === undefined) return raw as Decimal
  if (isMultipleOf(raw, tick)) return raw as Decimal
  if (mode === 'reject') {
    fail(bad('PRECISION', `${field} ${raw} is not a multiple of the tick size ${tick} for ${rec.instrument.symbol}`))
  }
  const snapped = snapToTick(raw, tick, side === 'buy' ? 'down' : 'up')
  if (!(Number(snapped) > 0)) fail(bad('PRECISION', `${field} ${raw} rounds to zero for ${rec.instrument.symbol}`))
  rounded.push({ field, from: raw, to: String(snapped) })
  return snapped
}

/** 币数量（或名义额）→ 张。 */
function contractsFor(intent: OrderIntent, rec: InstrumentRecord, priceForNotional: number | undefined): Decimal {
  let base: string
  if (intent.size !== undefined) {
    base = String(intent.size)
  } else if (intent.notional !== undefined) {
    const px = priceForNotional
    if (px === undefined || !(px > 0)) {
      fail(bad('STALE_PRICE', `no reference price to convert notional into size for ${intent.instrumentId}`, { retryAfterMs: 1_000 }))
    }
    const notional = Number(intent.notional)
    if (!Number.isFinite(notional) || notional <= 0) fail(bad('INVALID_PARAMS', 'notional must be a positive number'))
    base = String(notional / (px as number))
  } else {
    return fail(bad('INVALID_PARAMS', 'order needs size or notional'))
  }
  if (toFx(base) === undefined) fail(bad('INVALID_PARAMS', `size is not a positive decimal number: ${JSON.stringify(base)}`))
  const contracts = contractsOf(base as Decimal, rec.ctVal, rec.lotContracts)
  if (!(Number(contracts) > 0)) {
    fail(bad('PRECISION', `size ${base} is below one contract for ${rec.instrument.symbol} (ctVal ${rec.ctVal})`))
  }
  const min = Number(rec.minContracts)
  if (Number.isFinite(min) && min > 0 && Number(contracts) < min) {
    fail(bad('PRECISION', `size ${contracts} contracts is below minSz ${rec.minContracts} for ${rec.instrument.symbol}`))
  }
  return contracts
}

/**
 * 单个 OrderIntent → OKX 下单参数（普通单或算法单）。无法构造时抛 OrderBuildError（带 Problem）。
 * 键顺序固定（instId, tdMode, side, posSide, ordType, sz, px, …），签名与测试断言都稳定。
 */
export function buildOrderParams(intent: OrderIntent, rec: InstrumentRecord | undefined, opts: BuildOptions = {}): BuiltOrderParams {
  if (!rec) fail(bad('INSTRUMENT_UNKNOWN', `unknown instrument ${intent.instrumentId}`))
  if (rec.instrument.status === 'delisted') fail(bad('INSTRUMENT_UNKNOWN', `${intent.instrumentId} is delisted`))
  const type = intent.type
  if (type === 'twap') fail(bad('ORDER_TYPE_UNSUPPORTED', 'order type twap is not supported by this OKX connector'))
  if (intent.triggerType !== undefined && intent.triggerType !== 'mark') {
    fail(bad('ORDER_TYPE_UNSUPPORTED', `trigger price type ${intent.triggerType} is not supported (OKX trigger orders use mark price)`))
  }
  const mapping = ORDER_TYPE_MAP[type as Exclude<OrderType, 'twap'>]
  if (mapping === undefined) fail(bad('ORDER_TYPE_UNSUPPORTED', `order type ${type} is not supported`))

  const mode = intent.rounding ?? 'reject'
  const rounded: BuiltOrderParams['rounded'] = []
  const hasPrice = PRICE_TYPES.has(type)
  const isTrigger = TRIGGER_TYPES.has(type)
  const isTrailing = type === 'trailing_stop'

  if (type === 'market') {
    if (intent.maxSlippageBps === undefined) {
      fail(bad('INVALID_PARAMS', 'market orders need maxSlippageBps (no implicit default slippage)'))
    }
    if (!Number.isFinite(intent.maxSlippageBps) || intent.maxSlippageBps <= 0) {
      fail(bad('INVALID_PARAMS', 'maxSlippageBps must be a positive number'))
    }
    if (opts.ref === undefined || opts.ref.stale === true) {
      fail(bad('STALE_PRICE', `no fresh quote for a market order on ${rec.instrument.symbol}`, { retryAfterMs: 1_000 }))
    }
  }

  // ---- 价格 / 触发价 ----
  let price: Decimal | undefined
  let triggerPrice: Decimal | undefined
  if (hasPrice) {
    if (intent.price === undefined) fail(bad('INVALID_PARAMS', `${type} orders need price`))
    price = normalizePrice('price', String(intent.price), rec, mode, intent.side, rounded)
  }
  if (isTrigger) {
    if (intent.triggerPrice === undefined) fail(bad('INVALID_PARAMS', `${type} orders need triggerPrice`))
    triggerPrice = normalizePrice('triggerPrice', String(intent.triggerPrice), rec, mode, intent.side, rounded)
  } else if (!isTrailing && intent.triggerPrice !== undefined) {
    fail(bad('INVALID_PARAMS', `${type} orders do not take triggerPrice`))
  }
  if (intent.trailing !== undefined && !isTrailing) {
    fail(bad('INVALID_PARAMS', 'trailing parameters are only valid for trailing_stop orders'))
  }

  // ---- 数量（张） ----
  const priceForNotional = Number(triggerPrice ?? price ?? refPriceOf(opts.ref) ?? NaN)
  const contracts = contractsFor(intent, rec, Number.isFinite(priceForNotional) ? priceForNotional : undefined)
  const baseSize = baseOf(contracts, rec.ctVal)

  // ---- 最小名义额（OKX 只在标的给了 minNotional 时校验；reduceOnly 豁免）----
  const minNotional = Number(rec.instrument.minNotional ?? NaN)
  if (!intent.reduceOnly && Number.isFinite(minNotional) && minNotional > 0 && Number.isFinite(priceForNotional)) {
    const notional = Number(contracts) * Number(rec.ctVal) * priceForNotional
    if (notional < minNotional) {
      fail(bad('MIN_NOTIONAL', `order notional ${notional.toFixed(4)} is below the venue minimum ${minNotional} for ${rec.instrument.symbol}`))
    }
  }

  // ---- 头部字段 ----
  const modeOf = opts.positionMode ?? 'oneWay'
  const reduceOnly = intent.reduceOnly === true
  const posSide = resolvePosSide(intent.side, reduceOnly, modeOf, opts.posSide)
  const tdMode = intent.marginMode === 'isolated' || intent.marginMode === 'strictIsolated' || intent.marginMode === 'noCross'
    ? 'isolated'
    : 'cross'
  const body: Record<string, string> = {
    instId: rec.symbol,
    tdMode,
    side: intent.side,
    posSide,
  }
  // 平仓单在 net 模式下用 reduceOnly；long_short 模式下 side + posSide 本身就是平仓语义（QD okx.py:822-826 同口径）
  if (reduceOnly && posSide === 'net') body.reduceOnly = 'true'

  if (mapping.channel === 'order') {
    if (isTrailing) fail(bad('ORDER_TYPE_UNSUPPORTED', 'trailing_stop must go through order-algo'))
    if (type === 'market') {
      if (intent.tif !== undefined && intent.tif !== 'ioc') {
        fail(bad('ORDER_TYPE_UNSUPPORTED', `market orders cannot take time in force ${intent.tif}`))
      }
      if (intent.postOnly === true) fail(bad('ORDER_TYPE_UNSUPPORTED', 'postOnly needs a limit order'))
      body.ordType = 'ioc'
      body.sz = String(contracts)
      body.px = String(marketLimitPrice(opts.ref, intent.maxSlippageBps as number, rec, intent.side, rounded))
    } else {
      body.ordType = ordTypeOfLimit(intent)
      body.sz = String(contracts)
      if (price !== undefined) body.px = String(price)
    }
  } else if (isTrailing) {
    const ratio = intent.trailing?.callbackRatio
    if (ratio === undefined) fail(bad('INVALID_PARAMS', 'trailing_stop needs trailing.callbackRatio'))
    const value = Number(ratio)
    // OKX move_order_stop.callbackRatio 的取值范围是 0.01–1（1%–100%）；超界直接拒，不悄悄夹取
    if (!Number.isFinite(value) || value < 0.01 || value > 1) {
      fail(bad('INVALID_PARAMS', `callbackRatio ${String(ratio)} must be a ratio from 0.01 to 1 (OKX move_order_stop)`))
    }
    body.ordType = mapping.ordType
    body.sz = String(contracts)
    body.callbackRatio = String(ratio)
    const activation = intent.trailing?.activationPrice
    if (activation !== undefined) {
      body.activePx = String(normalizePrice('activationPrice', String(activation), rec, mode, intent.side, rounded))
    } else if (intent.trailing?.activationRatio !== undefined) {
      fail(bad('INVALID_PARAMS', 'activationRatio is not supported; pass trailing.activationPrice'))
    }
    if (intent.postOnly === true) fail(bad('ORDER_TYPE_UNSUPPORTED', 'postOnly needs a limit order'))
  } else {
    // conditional：stop 用 slTriggerPx，take 用 tpTriggerPx；市价触发把 ordPx 写成 -1
    body.ordType = mapping.ordType
    body.sz = String(contracts)
    const take = TAKE_TYPES.has(type)
    const prefix = take ? 'tp' : 'sl'
    body[`${prefix}TriggerPx`] = String(triggerPrice)
    body[`${prefix}OrdPx`] = price === undefined ? '-1' : String(price)
    body[`${prefix}TriggerPxType`] = 'mark'
  }

  const clientOrderId = sanitizeClientOrderId(intent.clientOrderId !== undefined ? String(intent.clientOrderId) : newClientOrderId())
  // 算法单用 algoClOrdId（QD exchange_close_history.py:308 也是读这个字段作为旁证）
  if (mapping.channel === 'algo') body.algoClOrdId = clientOrderId
  else body.clOrdId = clientOrderId

  return {
    kind: mapping.channel,
    path: mapping.channel === 'order' ? ORDER_PATH : ALGO_PATH,
    body,
    clientOrderId,
    posSide,
    contracts,
    baseSize,
    rounded,
  }
}

/** limit 类的 ordType：OKX 把 tif 编码进 ordType（post_only / ioc / fok / limit）。 */
function ordTypeOfLimit(intent: OrderIntent): string {
  if (intent.postOnly === true) {
    if (intent.tif !== undefined && intent.tif !== 'alo' && intent.tif !== 'gtc') {
      fail(bad('ORDER_TYPE_UNSUPPORTED', `postOnly cannot be combined with tif ${intent.tif}`))
    }
    return 'post_only'
  }
  const tif = intent.tif ?? 'gtc'
  switch (tif) {
    case 'gtc': return 'limit'
    case 'alo': return 'post_only'
    case 'ioc': return 'ioc'
    case 'fok': return 'fok'
    default:
      return fail(bad('ORDER_TYPE_UNSUPPORTED', `time in force ${String(tif)} is not supported (gtc / ioc / fok / alo)`))
  }
}

export interface ProtectionOrder {
  kind: 'algo'
  path: string
  body: Record<string, string>
  clientOrderId: string
  /** 这条单覆盖哪几腿（oco 两条都有）。 */
  covers: Array<'tp' | 'sl'>
}

export interface ProtectionOrders {
  /** 两腿都给 = 一条原生 OCO 算法单；只有一腿 = 一条 conditional 算法单。 */
  mode: 'oco' | 'conditional'
  orders: ProtectionOrder[]
}

/**
 * 成交后补挂的 reduce-only 保护单（纯函数，不联网）。
 * OKX 没有 attach 式 TP/SL，但**两腿可以合成一条 OCO 算法单**（native_protection.py:152-187 的 _place_okx）：
 *   · 数量 = 本次成交数量（delta）折成张，按 lotSz 截断；
 *   · 方向 = 父单反向；net 模式带 reduceOnly，long_short 模式靠 posSide；
 *   · 市价触发写 ordPx = '-1'，给了 leg.price 就写限价；触发价类型固定 mark。
 * 由内核在成交回报后调用；本连接器的 submit 不自动挂（带 tpsl 的意图直接 1004）。
 */
export function buildProtectionOrders(
  parentIntent: OrderIntent,
  /** 本次成交的币数量（Decimal 或普通字符串都接受，内部按定点处理）。 */
  filledSize: string,
  rec: InstrumentRecord | undefined,
  opts: BuildOptions & { clientOrderId?: string } = {},
): ProtectionOrders {
  if (!parentIntent.tpsl) fail(bad('INVALID_PARAMS', 'buildProtectionOrders needs an intent with tpsl'))
  if (!rec) fail(bad('INSTRUMENT_UNKNOWN', `unknown instrument ${parentIntent.instrumentId}`))
  const tpsl = parentIntent.tpsl
  if (!tpsl.takeProfit && !tpsl.stopLoss) fail(bad('INVALID_PARAMS', 'tpsl has neither takeProfit nor stopLoss'))
  if (toFx(String(filledSize)) === undefined) fail(bad('INVALID_PARAMS', 'filledSize must be a positive number'))
  const contracts = contractsOf(filledSize as Decimal, rec.ctVal, rec.lotContracts)
  if (!(Number(contracts) > 0)) fail(bad('PRECISION', `filledSize ${String(filledSize)} is below one contract for ${rec.instrument.symbol}`))

  const closeSide: 'buy' | 'sell' = parentIntent.side === 'buy' ? 'sell' : 'buy'
  const modeOf = opts.positionMode ?? 'oneWay'
  const posSide = resolvePosSide(closeSide, true, modeOf)
  const rounded: BuiltOrderParams['rounded'] = []
  const isolated = parentIntent.marginMode === 'isolated'
    || parentIntent.marginMode === 'strictIsolated'
    || parentIntent.marginMode === 'noCross'
  const body: Record<string, string> = {
    instId: rec.symbol,
    tdMode: isolated ? 'isolated' : 'cross',
    side: closeSide,
    posSide,
    ordType: 'conditional',
    sz: String(contracts),
  }
  if (posSide === 'net') body.reduceOnly = 'true'

  const covers: Array<'tp' | 'sl'> = []
  const stopLoss = tpsl.stopLoss
  const takeProfit = tpsl.takeProfit
  if (stopLoss) {
    body.slTriggerPx = String(normalizePrice('sl.triggerPrice', String(stopLoss.triggerPrice), rec, 'reject', closeSide, rounded))
    body.slOrdPx = stopLoss.price === undefined ? '-1' : String(normalizePrice('sl.price', String(stopLoss.price), rec, 'reject', closeSide, rounded))
    body.slTriggerPxType = 'mark'
    covers.push('sl')
  }
  if (takeProfit) {
    body.tpTriggerPx = String(normalizePrice('tp.triggerPrice', String(takeProfit.triggerPrice), rec, 'reject', closeSide, rounded))
    body.tpOrdPx = takeProfit.price === undefined ? '-1' : String(normalizePrice('tp.price', String(takeProfit.price), rec, 'reject', closeSide, rounded))
    body.tpTriggerPxType = 'mark'
    covers.push('tp')
  }
  const mode: 'oco' | 'conditional' = covers.length === 2 ? 'oco' : 'conditional'
  if (mode === 'oco') body.ordType = 'oco'
  const prefix = mode === 'oco' ? 'oco' : covers[0] === 'tp' ? 'tp' : 'sl'
  const generated = opts.clientOrderId ?? `${prefix}${randomBytes(12).toString('hex')}`
  const clientOrderId = sanitizeClientOrderId(generated)
  body.algoClOrdId = clientOrderId
  return { mode, orders: [{ kind: 'algo', path: ALGO_PATH, body, clientOrderId, covers }] }
}
