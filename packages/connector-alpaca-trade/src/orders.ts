// SPDX-License-Identifier: CPAL-1.0
// OrderIntent → Alpaca `POST /v2/orders` 请求体（纯函数：无网络、无时钟副作用；单测直接断言 JSON 形状）。
// 官方请求字段出处（Trading API v2 · Orders）：symbol / qty / notional / side / type / time_in_force /
//   limit_price / stop_price / trail_price / trail_percent / extended_hours / client_order_id /
//   order_class(simple|bracket|oco|oto) / take_profit{limit_price} / stop_loss{stop_price, limit_price}。
// 美股八条逐条落在本文件：
//   #2 休市不排队：常规时段外的市价意图一律拒（INVALID_PARAMS + hint）；盘前盘后只有显式声明（构造参数
//      `extendedHours`，协议 OrderIntent 没有该字段——已在 REPORT 记为协议缺口）且只允许 limit + day；
//   #3 市价走价带：必须带 maxSlippageBps，发「参考价 ± 滑点」的限价 + IOC；没有参考价 → 拒，不退回裸市价；
//   #4 碎股：只有 fractionable 资产才收小数股，否则整数股，**不取整**；
//   #5 卖空：卖出超过本账户多头持仓的部分视为开空，要 shortable + borrow_status=easy_to_borrow + 账户 shorting_enabled；
//      借券状态拿不到（新字段旧字段都缺）一律拒开空（fail-closed）；
//   #6 账户限制：trading_blocked / account_blocked 为真时一律拒（不做绕开）；
//   #8 能力老实：take_market / take_limit / twap 在 Alpaca 没有对应单型 → 1004。
import { makeProblem, normalizeDecimal } from '@gitrader/protocol'
import type { Decimal, OrderIntent, Problem } from '@gitrader/protocol'
import { asDecimal } from '@gitrader/protocol'
import { div, fx, mul, str } from '@gitrader/protocol/decimal'
import type { AssetRecord } from './assets'
import { DEFAULT_REF_PRICE_MAX_AGE_MS } from './constants'
import { ProblemError } from './errors'
import { applyBps, isMultipleOf, isWholeQty, snapToTick, toFx, truncateToStep } from './precision'
import type { SessionState } from './sessions'

/** 参考价（买卖价 / 中间价）；陈旧时拒绝市价模拟。 */
export interface PriceRef {
  bid?: number
  ask?: number
  mid?: number
  ts?: number
  /** 报价年龄（毫秒）；有值时才按 refPriceMaxAgeMs 判陈旧。 */
  ageMs?: number
  stale?: boolean
  source?: string
}

export interface BuildContext {
  asset: AssetRecord
  /** 注入时钟判定出来的时段（sessions.sessionStateAt）。 */
  session: SessionState
  ref?: PriceRef
  /** 本账户该标的现在可卖的多头数量（股）；null = 查不到（卖单 fail closed）。 */
  heldLongQty: string | null
  /** 账户能否做空（/v2/account 的 shorting_enabled）。 */
  shortingEnabled: boolean
  /** 盘前盘后是否被显式允许（协议没有 per-intent 字段，用构造参数声明；见 REPORT）。 */
  extendedHoursAllowed: boolean
  /** 账户是否被冻结（trading_blocked / account_blocked）。 */
  accountBlocked?: boolean
  refPriceMaxAgeMs?: number
  now?: number
}

export type AlpacaOrderClass = 'simple' | 'bracket' | 'oco' | 'oto'
export type AlpacaTif = 'day' | 'gtc' | 'ioc' | 'fok'

export interface BuiltOrder {
  body: Record<string, unknown>
  clientOrderId: string
  orderClass: AlpacaOrderClass
  timeInForce: AlpacaTif
  /** true = 这张单的 tif 被改成 day（小数股 / 扩展时段，Alpaca 硬要求）。 */
  tifForcedDay: boolean
  /** 说明性告警（不含密钥）：tif 被改、价带被贴 tick 之类。 */
  warnings: string[]
}

export class OrderBuildError extends ProblemError {
  constructor(problem: Problem) {
    super(problem)
    this.name = 'OrderBuildError'
  }
}

const fail = (p: Problem): never => {
  throw new OrderBuildError(p)
}
const bad = (name: Parameters<typeof makeProblem>[0], message: string, extra: Partial<Problem> = {}): Problem => makeProblem(name, message, extra)

/** 协议 TIF → Alpaca TIF；`alo` / `gtd` 没有对应物（1004）。 */
export function mapTif(intent: OrderIntent): AlpacaTif {
  const tif = intent.tif ?? 'gtc'
  if (tif === 'gtc' || tif === 'ioc' || tif === 'fok') return tif
  return fail(bad('ORDER_TYPE_UNSUPPORTED', `Alpaca has no ${tif} time-in-force in this connector (supported: gtc / ioc / fok); the protocol TIF enum has no "day" either — see REPORT`))
}

/** 会话时段的拒单 hint（同一句话给所有「现在不能下」的场景，便于用户看懂）。 */
export function sessionHint(state: SessionState): string {
  const next = state.nextOpenMs === null ? 'unknown (calendar snapshot has no later trading day)' : new Date(state.nextOpenMs).toISOString()
  return `now is ${state.phase} on ${state.date} in America/New_York; next regular open ${next}`
}

/** 市价意图的参考价：买用 ask（没有就 mid）、卖用 bid（没有就 mid）；全无 → 拒。 */
function referencePrice(ctx: BuildContext, side: 'buy' | 'sell'): { price: number; mid: number } {
  const ref = ctx.ref
  const maxAge = ctx.refPriceMaxAgeMs ?? DEFAULT_REF_PRICE_MAX_AGE_MS
  if (ref === undefined) {
    return fail(bad('STALE_PRICE', `no reference quote for ${ctx.asset.symbol}; refusing to send a bare market order (no price band to bound slippage)`, { retryAfterMs: 1_000 }))
  }
  if (ref.stale === true) {
    return fail(bad('STALE_PRICE', `reference quote for ${ctx.asset.symbol} is marked stale; refusing to emulate a market order`, { retryAfterMs: 1_000 }))
  }
  if (ref.ageMs !== undefined && ref.ageMs > maxAge) {
    return fail(bad('STALE_PRICE', `reference quote for ${ctx.asset.symbol} is ${ref.ageMs} ms old (max ${maxAge} ms); refresh before a market order`, { retryAfterMs: 1_000 }))
  }
  const mid = ref.mid ?? (ref.bid !== undefined && ref.ask !== undefined ? (ref.bid + ref.ask) / 2 : undefined)
  const price = side === 'buy' ? (ref.ask ?? mid ?? ref.bid) : (ref.bid ?? mid ?? ref.ask)
  if (price === undefined || !Number.isFinite(price) || price <= 0) {
    return fail(bad('STALE_PRICE', `reference quote for ${ctx.asset.symbol} has no usable price; refusing a market order`, { retryAfterMs: 1_000 }))
  }
  return { price, mid: mid !== undefined && mid > 0 ? mid : price }
}

/**
 * 数量：size 优先；否则 notional / 参考价折算。
 * size 是用户给的数量：**不取整**，不是 step 整数倍就 1002（取整就是改用户的数量）。
 * 只有 notional 折算出的数量允许向下截到 step（它不是用户给的数量）。
 */
function resolveQty(intent: OrderIntent, ctx: BuildContext, refMid: number): { qty: Decimal; fractional: boolean } {
  const step = ctx.asset.step
  let qty: Decimal
  if (intent.size !== undefined) {
    if (toFx(intent.size) === undefined) return fail(bad('INVALID_PARAMS', `size is not a decimal number: ${JSON.stringify(intent.size)}`))
    qty = asDecimal(normalizeDecimal(intent.size))
    if (!isMultipleOf(qty, step)) {
      return fail(bad('PRECISION', `size ${qty} is not a multiple of the ${ctx.asset.symbol} increment ${step}`))
    }
  } else if (intent.notional !== undefined) {
    if (toFx(intent.notional) === undefined) return fail(bad('INVALID_PARAMS', `notional is not a decimal number: ${JSON.stringify(intent.notional)}`))
    if (refMid <= 0) return fail(bad('STALE_PRICE', `no price to convert notional into shares for ${ctx.asset.symbol}`, { retryAfterMs: 1_000 }))
    const raw = asDecimal(str(div(fx(intent.notional), fx(refMid))))
    qty = truncateToStep(raw, step)
    if (qty === '0') {
      return fail(bad('PRECISION', `notional ${intent.notional} converts to less than the ${ctx.asset.symbol} increment ${step} (quantities truncate toward zero, never round up)`))
    }
  } else {
    return fail(bad('INVALID_PARAMS', 'order needs size or notional (Alpaca has no "default size")'))
  }
  if (toFx(qty) === undefined) return fail(bad('INVALID_PARAMS', 'size must be greater than zero'))
  const fractional = !isWholeQty(qty)
  if (!ctx.asset.fractionable && fractional) {
    return fail(bad('PRECISION', `${ctx.asset.symbol} is not fractionable (asset.fractionable=false); whole shares only — ${qty} shares is not an integer and this connector never rounds it`))
  }
  if (toFx(ctx.asset.minSize) !== undefined && fx(qty) < fx(ctx.asset.minSize)) {
    return fail(bad('PRECISION', `size ${qty} is below the venue minimum ${ctx.asset.minSize} for ${ctx.asset.symbol}`))
  }
  return { qty, fractional }
}

/** 卖空 / 平仓的归属判断（八条第 5 条 + QD live_trading/alpaca_ownership.py 的「先算自己在场内的多头」口径）。 */
function checkSellOwnership(intent: OrderIntent, ctx: BuildContext, qty: Decimal): void {
  if (intent.side !== 'sell') return
  if (ctx.heldLongQty === null) {
    // 查不到持仓就不卖：宁可拒单，也不把「平仓」发成「开空」。
    return fail(bad('VENUE_REJECTED', `cannot verify how many ${ctx.asset.symbol} shares this account holds; refusing to send a sell that could open a short position`, {
      venue: { id: 'alpaca', message: 'positions snapshot unavailable' },
    }))
  }
  const held = toFx(ctx.heldLongQty) ?? 0n
  const shortQty = fx(qty) > held ? fx(qty) - held : 0n
  if (intent.reduceOnly === true && shortQty > 0n) {
    return fail(bad('INVALID_PARAMS', `reduce-only sell of ${qty} ${ctx.asset.symbol} exceeds the ${ctx.heldLongQty} shares held; Alpaca has no reduce-only flag, so this connector will not let a close spill into a short`))
  }
  if (shortQty === 0n) return
  if (!ctx.asset.shortable) {
    return fail(bad('VENUE_REJECTED', `${ctx.asset.symbol} is not shortable (asset.shortable=false); selling ${qty} with only ${ctx.heldLongQty} shares held would open a short`, {
      venue: { id: 'alpaca', message: 'asset not shortable' },
    }))
  }
  if (!ctx.shortingEnabled) {
    return fail(bad('VENUE_REJECTED', `the account has shorting_enabled=false; opening a ${str(shortQty)} share short in ${ctx.asset.symbol} is not allowed`, {
      venue: { id: 'alpaca', message: 'account shorting disabled' },
    }))
  }
  if (ctx.asset.easyToBorrow !== true) {
    if (ctx.asset.borrowStatus === 'hard_to_borrow') {
      return fail(bad('VENUE_REJECTED', `${ctx.asset.symbol} is shortable but not easy_to_borrow (borrow_status=hard_to_borrow); borrow cost is unknown, so this connector refuses to open a short`, {
        venue: { id: 'alpaca', message: 'asset not easy to borrow' },
      }))
    }
    return fail(bad('VENUE_REJECTED', `${ctx.asset.symbol} borrow availability is unknown (the asset response has neither borrow_status nor easy_to_borrow); refusing to open a ${str(shortQty)} share short — re-fetch the asset, or sell no more than the ${ctx.heldLongQty} shares held`, {
      venue: { id: 'alpaca', message: 'borrow status unavailable' },
    }))
  }
}

interface TpslLeg { triggerPrice: Decimal; price?: Decimal }

/** 保护腿 → Alpaca 原生结构（bracket / oto 的 take_profit / stop_loss）。 */
function tpslFields(tpsl: NonNullable<OrderIntent['tpsl']>): { takeProfit?: Record<string, string>; stopLoss?: Record<string, string> } {
  const tp: TpslLeg | undefined = tpsl.takeProfit
  const sl: TpslLeg | undefined = tpsl.stopLoss
  const out: { takeProfit?: Record<string, string>; stopLoss?: Record<string, string> } = {}
  if (tp !== undefined) {
    // Alpaca 的 take_profit 只有 limit_price（触发价 = 限价）。
    out.takeProfit = { limit_price: normalizeDecimal(tp.price ?? tp.triggerPrice) }
  }
  if (sl !== undefined) {
    out.stopLoss = { stop_price: normalizeDecimal(sl.triggerPrice) }
    if (sl.price !== undefined) out.stopLoss['limit_price'] = normalizeDecimal(sl.price)
  }
  return out
}

/**
 * 单个 OrderIntent → Alpaca 下单请求体。无法构造时抛 OrderBuildError（带 Problem）。
 * 注意：本函数**不发请求**，也不改任何状态；所有「不做」都在这里拒。
 */
export function buildOrder(intent: OrderIntent, ctx: BuildContext): BuiltOrder {
  const asset = ctx.asset
  const symbol = asset.symbol
  const warnings: string[] = []

  // ---- 账户限制（八条 #6）：冻结就一律拒，不做绕开 ----
  if (ctx.accountBlocked === true) {
    return fail(bad('VENUE_REJECTED', 'the account is blocked at the venue (trading_blocked / account_blocked); no order will be sent', {
      venue: { id: 'alpaca', message: 'account blocked' },
    }))
  }
  if (!asset.tradable || asset.instrument.status !== 'trading') {
    return fail(bad('INSTRUMENT_UNKNOWN', `${symbol} is not tradable right now (asset.status=${asset.status}, tradable=${asset.tradable})`))
  }

  // ---- 单型能力（八条 #8）----
  const type = intent.type
  if (type === 'take_market' || type === 'take_limit') {
    return fail(bad('ORDER_TYPE_UNSUPPORTED', `Alpaca has no standalone ${type} order; express take-profit as intent.tpsl.takeProfit (native bracket / oto) or as a limit order`))
  }
  if (type === 'twap') {
    return fail(bad('ORDER_TYPE_UNSUPPORTED', 'twap is not implemented for Alpaca (no native algo order in this connector)'))
  }
  if (!(asset.instrument.orderTypes as string[]).includes(type)) {
    return fail(bad('ORDER_TYPE_UNSUPPORTED', `order type ${type} is not supported by this connector for ${symbol}`))
  }

  // ---- 保护单（tpsl，八条 #8 的「如实声明」）----
  let orderClass: AlpacaOrderClass = 'simple'
  let tpFields: Record<string, string> | undefined
  let slFields: Record<string, string> | undefined
  if (intent.tpsl !== undefined) {
    if (intent.tpsl.grouping === 'position') {
      return fail(bad('ORDER_TYPE_UNSUPPORTED', 'position-level tpsl is not an attach-to-order form on Alpaca; submit the entry alone and place an OCO close with placeProtection() after the fill'))
    }
    const legs = tpslFields(intent.tpsl)
    tpFields = legs.takeProfit
    slFields = legs.stopLoss
    if (tpFields === undefined && slFields === undefined) {
      return fail(bad('INVALID_PARAMS', 'tpsl needs takeProfit or stopLoss'))
    }
    orderClass = tpFields !== undefined && slFields !== undefined ? 'bracket' : 'oto'
  }
  if (type === 'market' && orderClass !== 'simple') {
    return fail(bad('INVALID_PARAMS', `${symbol}: Alpaca bracket / oto orders only accept day or gtc, but this market intent would be sent as a price-band IOC; use a limit entry when the order carries protection`))
  }

  // ---- 时段（八条 #1 / #2）----
  const phase = ctx.session.phase
  const extended = phase === 'pre' || phase === 'post'
  if (phase === 'closed') {
    return fail(bad('INVALID_PARAMS', `${symbol}: the market is closed (${sessionHint(ctx.session)}); this connector never queues an order for the next open`))
  }
  let extendedHours = false
  if (extended) {
    if (type === 'market') {
      return fail(bad('INVALID_PARAMS', `${symbol}: market intent outside regular hours (${phase}); it would fill at an unknown extended-hours price — use a limit order${ctx.extendedHoursAllowed ? '' : ' and declare extendedHours: true'} (${sessionHint(ctx.session)})`))
    }
    if (type !== 'limit') {
      return fail(bad('INVALID_PARAMS', `${symbol}: ${type} is not accepted outside regular hours; Alpaca's extended-hours session takes limit orders only (${sessionHint(ctx.session)})`))
    }
    if (!ctx.extendedHoursAllowed) {
      return fail(bad('INVALID_PARAMS', `${symbol}: the session is ${phase} and this connector was not told to trade extended hours; pass extendedHours: true at construction to allow limit+day orders there (${sessionHint(ctx.session)})`))
    }
    extendedHours = true
  }
  if (extendedHours && orderClass !== 'simple') {
    return fail(bad('INVALID_PARAMS', `${symbol}: Alpaca does not accept bracket / oto orders in extended hours; place the entry alone and protect it after the fill`))
  }

  // ---- 价格 ----
  let limitPrice: Decimal | undefined
  let stopPrice: Decimal | undefined
  let trailPercent: Decimal | undefined
  let refMid = 0
  let refPrice = 0
  const needsRef = type === 'market' || intent.notional !== undefined
  if (needsRef) {
    const ref = referencePrice(ctx, intent.side)
    // 价带基准用「这一侧的真实成交价」（买 ask / 卖 bid），notional 折算用中间价。
    refPrice = ref.price
    refMid = ref.mid
  }
  if (type === 'market') {
    // 八条 #3：市价意图必须自带滑点上限，实际发「价带限价 + IOC」。
    if (intent.maxSlippageBps === undefined) {
      return fail(bad('INVALID_PARAMS', `${symbol}: market orders need maxSlippageBps (no implicit default); this connector sends a price-band limit + IOC instead of a bare market order`))
    }
    const bps = Number(intent.maxSlippageBps)
    if (!Number.isFinite(bps) || bps <= 0) return fail(bad('INVALID_PARAMS', 'maxSlippageBps must be a positive number'))
    if (bps > 2_000) return fail(bad('INVALID_PARAMS', `maxSlippageBps=${bps} is above the 2000 bps (20%) sanity ceiling; refusing to send it`))
    const band = applyBps(str(fx(refPrice)), bps, intent.side === 'buy' ? 'up' : 'down')
    // 买单向下贴 tick、卖单向上贴 tick：永不朝成交方向放宽（limit-safety 口径）。
    limitPrice = snapToTick(band, asset.tick, intent.side === 'buy' ? 'down' : 'up')
    if (limitPrice === '0') return fail(bad('PRECISION', `price band for ${symbol} rounds to zero at tick ${asset.tick}`))
  } else if (type === 'limit' || type === 'stop_limit') {
    if (intent.price === undefined) return fail(bad('INVALID_PARAMS', `${type} orders need price`))
    if (toFx(intent.price) === undefined) return fail(bad('INVALID_PARAMS', `price is not a decimal number: ${JSON.stringify(intent.price)}`))
    const snapped = snapPrice(intent.price, asset.tick, intent.rounding, intent.side, 'price')
    limitPrice = snapped
  }
  if (type === 'stop_market' || type === 'stop_limit') {
    if (intent.triggerPrice === undefined) return fail(bad('INVALID_PARAMS', `${type} orders need triggerPrice`))
    stopPrice = snapPrice(intent.triggerPrice, asset.tick, intent.rounding, intent.side, 'triggerPrice')
  }
  if (type === 'trailing_stop') {
    if (intent.trailing === undefined) return fail(bad('INVALID_PARAMS', 'trailing_stop orders need trailing.callbackRatio'))
    if (intent.trailing.activationPrice !== undefined || intent.trailing.activationRatio !== undefined) {
      return fail(bad('INVALID_PARAMS', 'Alpaca trailing_stop has no activation price / ratio; drop trailing.activationPrice and send the trail alone'))
    }
    const ratio = intent.trailing.callbackRatio
    if (toFx(ratio) === undefined) return fail(bad('INVALID_PARAMS', 'trailing.callbackRatio must be a positive decimal'))
    // callbackRatio 是比例（0.02 = 2%），Alpaca 要 trail_percent。
    trailPercent = asDecimal(str(mul(fx(ratio), fx('100'))))
  }
  if (intent.triggerType !== undefined && intent.triggerType !== 'last') {
    return fail(bad('ORDER_TYPE_UNSUPPORTED', `trigger price type ${intent.triggerType} is not available on Alpaca (stops trigger on the last trade price)`))
  }

  // ---- 数量 ----
  const { qty, fractional } = resolveQty(intent, ctx, refMid)
  if (type === 'market' && fractional) {
    return fail(bad('INVALID_PARAMS', `${symbol}: Alpaca fractional orders are DAY-only; a price-band IOC cannot be sent — use whole shares or a limit order`))
  }
  if (orderClass !== 'simple' && fractional) {
    return fail(bad('PRECISION', `${symbol}: Alpaca does not accept bracket / oto orders on fractional shares; use whole shares for a protected entry (this connector will not round ${qty} up)`))
  }
  if (orderClass !== 'simple' && (intent.tif === 'ioc' || intent.tif === 'fok')) {
    return fail(bad('INVALID_PARAMS', `${symbol}: bracket / oto orders must use day or gtc; ${intent.tif} is not accepted`))
  }
  checkSellOwnership(intent, ctx, qty)

  // ---- 时效（协议没有 day：小数股与扩展时段是场所硬要求）----
  const wanted = mapTif(intent)
  let tif = wanted
  let forcedDay = false
  if (extendedHours || fractional) {
    if (wanted === 'ioc' || wanted === 'fok') {
      return fail(bad('INVALID_PARAMS', `${symbol}: Alpaca requires time_in_force=day for ${fractional ? 'fractional shares' : 'extended hours'}; ${wanted} cannot be used here`))
    }
    if (wanted !== 'day') {
      tif = 'day'
      forcedDay = true
      warnings.push(
        `time_in_force ${wanted} → day: Alpaca requires DAY for ${fractional ? 'fractional shares' : 'extended hours'}; `
        + 'the protocol TIF enum has no "day" value (see REPORT) and DAY is strictly shorter than GTC',
      )
    }
  }

  // ---- 组装 ----
  const body: Record<string, unknown> = {
    symbol,
    qty: normalizeDecimal(qty),
    side: intent.side,
    type: type === 'market' ? 'limit' : type === 'stop_market' ? 'stop' : type,
    time_in_force: tif,
    client_order_id: String(intent.clientOrderId ?? ''),
  }
  if (intent.clientOrderId === undefined || String(intent.clientOrderId) === '') delete body['client_order_id']
  if (limitPrice !== undefined) body['limit_price'] = normalizeDecimal(limitPrice)
  if (stopPrice !== undefined) body['stop_price'] = normalizeDecimal(stopPrice)
  if (trailPercent !== undefined) body['trail_percent'] = normalizeDecimal(trailPercent)
  if (extendedHours) body['extended_hours'] = true
  if (orderClass !== 'simple') {
    body['order_class'] = orderClass
    if (tpFields !== undefined) body['take_profit'] = tpFields
    if (slFields !== undefined) body['stop_loss'] = slFields
  }
  // 市价意图的价带限价是 IOC（八条 #3）；其余按用户 TIF。
  if (type === 'market') body['time_in_force'] = 'ioc'
  if (intent.reduceOnly === true) {
    // Alpaca 没有 reduceOnly 字段：靠 checkSellOwnership 保证不外溢，这里只留告警便于审计。
    warnings.push('reduce-only is enforced by the connector (owned-share check), not by an Alpaca order field')
  }
  if (toFx(qty) !== undefined && intent.reduceOnly !== true && !asset.marginable) {
    // 保证金要求只是说明：新字段 margin_requirement_long，旧字段回落，都没有就明说「不可得」，告警本身不因字段缺失而消失。
    const requirement = asset.marginRequirementLong !== undefined
      ? `margin_requirement_long=${asset.marginRequirementLong}`
      : asset.maintenanceMarginRequirement !== undefined
        ? `maintenance_margin_requirement=${asset.maintenanceMarginRequirement}`
        : 'margin requirement unavailable from Alpaca'
    warnings.push(`${symbol} is not marginable (${requirement}); it needs cash`)
  }

  return {
    body,
    clientOrderId: String(intent.clientOrderId ?? ''),
    orderClass,
    timeInForce: (body['time_in_force'] as AlpacaTif) ?? tif,
    tifForcedDay: forcedDay,
    warnings,
  }
}

/** 价格贴 tick：reject 模式要求正好在 tick 上；passive 模式永不朝成交方向放宽。 */
function snapPrice(raw: string, tick: string, rounding: OrderIntent['rounding'], side: 'buy' | 'sell', field: string): Decimal {
  if (toFx(raw) === undefined) return fail(bad('INVALID_PARAMS', `${field} is not a decimal number: ${JSON.stringify(raw)}`))
  const price = fx(raw)
  if (price % fx(tick) === 0n) return asDecimal(str(price))
  if ((rounding ?? 'reject') === 'reject') {
    return fail(bad('PRECISION', `${field} ${raw} is not a multiple of tick ${tick} (set rounding: 'passive' to snap it; this connector never silently moves a price toward the market)`))
  }
  const snapped = snapToTick(str(price), tick, side === 'buy' ? 'down' : 'up')
  if (toFx(snapped) === undefined) return fail(bad('PRECISION', `${field} ${raw} rounds to zero at tick ${tick}`))
  return snapped
}

// ---- 成交后 / 持仓的保护单（OCO，位置级）------------------------------------

export interface ProtectionRequest {
  symbol: string
  /** 要保护的数量（股；与持仓同口径）。 */
  qty: string
  takeProfitPrice?: string
  stopLossPrice?: string
  clientOrderId?: string
}

export interface ProtectionOrder {
  body: Record<string, unknown>
  role: 'oco'
  clientOrderId: string
}

/**
 * 位置级保护：Alpaca 的 `order_class=oco` 是「对已有持仓挂两条平仓单」的原生形式
 * （官方 Orders 文档的 OCO 段；QD 的 native_protection 没有 Alpaca 分支，见 README）。
 * 只平多（side=sell）：本连接器不支持融券做空的保护单（不在本批次范围，README 写明）。
 */
export function buildProtectionOrder(req: ProtectionRequest): ProtectionOrder {
  const tp = req.takeProfitPrice !== undefined ? toFx(req.takeProfitPrice) : undefined
  const sl = req.stopLossPrice !== undefined ? toFx(req.stopLossPrice) : undefined
  if (tp === undefined || sl === undefined) {
    throw new OrderBuildError(bad('INVALID_PARAMS', 'OCO needs both legs; protect with a plain stop order instead'))
  }
  const qty = toFx(req.qty)
  if (qty === undefined) throw new OrderBuildError(bad('INVALID_PARAMS', `protection qty must be positive: ${JSON.stringify(req.qty)}`))
  // 官方 OCO：两层腿都在 take_profit / stop_loss 里，没有顶层 limit_price。
  const body: Record<string, unknown> = {
    symbol: req.symbol.trim().toUpperCase(),
    qty: normalizeDecimal(req.qty),
    side: 'sell',
    type: 'limit',
    time_in_force: 'gtc',
    order_class: 'oco',
    take_profit: { limit_price: normalizeDecimal(str(tp)) },
    stop_loss: { stop_price: normalizeDecimal(str(sl)) },
  }
  if (req.clientOrderId !== undefined && req.clientOrderId !== '') body['client_order_id'] = req.clientOrderId
  return { body, role: 'oco', clientOrderId: String(req.clientOrderId ?? '') }
}

/** 诊断：把 body 的键排序（日志 / 断言用，不改请求）。对象值按 JSON 原样显示。 */
export function describeBody(body: Record<string, unknown>): string {
  return Object.keys(body).sort().map((k) => `${k}=${typeof body[k] === 'object' ? JSON.stringify(body[k]) : String(body[k])}`).join('&')
}

// ---- 改单（PATCH /v2/orders/{order_id}）-------------------------------------

/** 改单上下文：只带 Alpaca 允许改的字段所需的信息。 */
export interface AmendContext {
  asset: AssetRecord
  /** 原单的 order_class（bracket / oco / oto 的腿不能改）。 */
  orderClass: string
  heldLongQty: string | null
  shortingEnabled: boolean
  session: SessionState
  ref?: PriceRef
  refPriceMaxAgeMs?: number
  accountBlocked?: boolean
}

export interface BuiltAmend {
  body: Record<string, unknown>
  warnings: string[]
}

/**
 * 改单：官方 `PATCH /v2/orders/{order_id}` 只接受 qty / time_in_force / limit_price / stop_price / trail
 * （**不能**改 symbol / side / type / order_class；下单 POST 才用 trail_percent）。所以：
 *   · bracket / oco / oto（含任何腿）→ 1004：Alpaca 不支持替换带腿的单，改单会让内核按原 clientOrderId 追踪落空；
 *   · 市价意图（已转价带限价）→ 1004：价带是一次性的滑点边界，改它等于换一张单；要改就撤单重下；
 *   · 其余按类型补齐必填价格字段，数量走同一套碎股规则（不取整）。
 */
export function buildAmendBody(order: OrderIntent, ctx: AmendContext): BuiltAmend {
  const asset = ctx.asset
  const symbol = asset.symbol
  const warnings: string[] = []
  if (ctx.accountBlocked === true) {
    return fail(bad('VENUE_REJECTED', 'the account is blocked at the venue (trading_blocked / account_blocked); no amend will be sent', {
      venue: { id: 'alpaca', message: 'account blocked' },
    }))
  }
  if (ctx.orderClass !== 'simple') {
    return fail(bad('ORDER_TYPE_UNSUPPORTED', `Alpaca cannot replace an order that has legs (order_class=${ctx.orderClass}); cancel it and re-submit the parent with new levels`))
  }
  if (order.type === 'market') {
    return fail(bad('ORDER_TYPE_UNSUPPORTED', 'this connector sends market intent as a price-band limit + IOC; that band cannot be amended — cancel and re-submit with a new maxSlippageBps'))
  }
  const base: BuildContext = {
    asset,
    session: ctx.session,
    heldLongQty: ctx.heldLongQty,
    shortingEnabled: ctx.shortingEnabled,
    extendedHoursAllowed: false,
    ...(ctx.accountBlocked !== undefined ? { accountBlocked: ctx.accountBlocked } : {}),
    ...(ctx.ref !== undefined ? { ref: ctx.ref } : {}),
    ...(ctx.refPriceMaxAgeMs !== undefined ? { refPriceMaxAgeMs: ctx.refPriceMaxAgeMs } : {}),
  }
  const refMid = ctx.ref?.mid ?? ctx.ref?.ask ?? ctx.ref?.bid ?? 0
  const { qty, fractional } = resolveQty(order, base, refMid)
  const body: Record<string, unknown> = { qty: normalizeDecimal(qty) }
  if (order.type === 'limit' || order.type === 'stop_limit') {
    if (order.price === undefined) return fail(bad('INVALID_PARAMS', `${order.type} amends need price`))
    body['limit_price'] = normalizeDecimal(snapPrice(order.price, asset.tick, order.rounding, order.side, 'price'))
  }
  if (order.type === 'stop_market' || order.type === 'stop_limit') {
    if (order.triggerPrice === undefined) return fail(bad('INVALID_PARAMS', `${order.type} amends need triggerPrice`))
    body['stop_price'] = normalizeDecimal(snapPrice(order.triggerPrice, asset.tick, order.rounding, order.side, 'triggerPrice'))
  }
  if (order.type === 'trailing_stop') {
    if (order.trailing === undefined) return fail(bad('INVALID_PARAMS', 'trailing_stop amends need trailing.callbackRatio'))
    // PATCH 的官方字段是 trail（百分比），不是下单用的 trail_percent。
    body['trail'] = normalizeDecimal(str(mul(fx(order.trailing.callbackRatio), fx('100'))))
  }
  const wanted = mapTif(order)
  if (fractional) {
    if (wanted === 'ioc' || wanted === 'fok') {
      return fail(bad('INVALID_PARAMS', `${symbol}: Alpaca requires time_in_force=day for fractional shares; ${wanted} cannot be used here`))
    }
    body['time_in_force'] = 'day'
    if (wanted !== 'day') warnings.push(`time_in_force ${wanted} → day on amend (Alpaca requires DAY for fractional shares)`)
  } else {
    body['time_in_force'] = wanted
  }
  // 改单也不能把数量改成「卖出超过持仓」的样子：沿用同一条归属判断。
  checkSellOwnership(order, base, qty)
  return { body, warnings }
}
