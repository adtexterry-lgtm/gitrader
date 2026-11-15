// SPDX-License-Identifier: CPAL-1.0
// 意图 → IB 订单：单型映射、价带、整数股、bracket（父子单）、orderRef 确定性客户端单号。
// 参照 ib_async client.py / decoder.py（BSD-2-Clause）的字段语义；未复制源码。
// 与原生 MKT 的差别：市价意图不发 MKT，而发参考价 ± 滑点的 LMT + IOC（八条 3）。
import type { Decimal, OrderIntent, OrderType } from '@gitrader/protocol'
import { asDecimal } from '@gitrader/protocol'
import { mulDec, str, fx, subDec } from '@gitrader/protocol/decimal'
import { assertSellReducesOnly, assertSessionAllows, assertTriggerType, assertWholeShares, assertAccountCanTrade, marketBandPrice } from './compliance'
import type { Restrictions } from './compliance'
import type { InstrumentRecord } from './contracts'
import { SUPPORTED_ORDER_TYPES } from './contracts'
import { IbError } from './errors'
import * as M from './messages'
import type { IbOrder } from './messages'

/** IB orderRef 的最大长度（本包按 64 截断）。 */
export const ORDER_REF_MAX = 64
const REF_BODY = /^[A-Za-z0-9._:-]{1,56}$/

export type LegRole = 'parent' | 'tp' | 'sl'

/** clientOrderId → 确定性 orderRef：同一客户端单号永远得到同一 orderRef（重连 / 重启后可对账）。 */
export function orderRefOf(clientOrderId: string, role: LegRole = 'parent'): string {
  if (!REF_BODY.test(clientOrderId)) {
    throw IbError.of(
      'INVALID_PARAMS',
      `clientOrderId ${JSON.stringify(clientOrderId)} cannot be used as an IB orderRef`,
      'IB 的 orderRef 只接受 [A-Za-z0-9._:-] 且 ≤ 56 字符（本包再加 #tp / #sl 后缀），换一个合规的单号',
    )
  }
  const ref = role === 'parent' ? clientOrderId : `${clientOrderId}#${role}`
  return ref.length <= ORDER_REF_MAX ? ref : ref.slice(0, ORDER_REF_MAX)
}

/** orderRef → clientOrderId（去掉本包加的 #tp / #sl 后缀；外来单原样返回）。 */
export function clientOrderIdFromOrderRef(ref: string): string {
  const m = /^(.*)#(tp|sl)$/.exec(ref)
  return m === null ? ref : m[1]!
}

/** IB 的 tif：协议只有 gtc/ioc/fok/alo/gtd；映射不出来的拒单（不悄悄换成 DAY）。 */
export function tifOf(intent: OrderIntent): string {
  switch (intent.tif) {
    case undefined:
      return 'DAY'
    case 'gtc':
      return 'GTC'
    case 'ioc':
      return 'IOC'
    case 'gtd':
      return 'GTD'
    case 'fok':
      throw IbError.of('ORDER_TYPE_UNSUPPORTED', 'IBKR cash equities do not accept FOK in this connector', '美股只用 DAY / GTC / IOC / GTD')
    case 'alo':
      throw IbError.of('ORDER_TYPE_UNSUPPORTED', 'IBKR has no post-only (ALO) order for cash equities', '去掉 postOnly / alo：IB 现金股票不支持只做 maker')
    default:
      throw IbError.of('ORDER_TYPE_UNSUPPORTED', `unsupported tif ${String(intent.tif)}`, '美股只用 DAY / GTC / IOC / GTD')
  }
}

export interface BuildContext {
  record: InstrumentRecord
  now: number
  account: string
  clientId: number
  referencePrice?: number | undefined
  marketErrorCode?: number | undefined
  /** 可卖量（多头 − 本账户在场 SELL 剩余 − 本次已发 SELL）。 */
  positionSize?: Decimal | undefined
  /** 本账户空头数量（reduceOnly 买入用）。 */
  shortPositionSize?: Decimal | undefined
  allowExtendedHours?: boolean
  restrictions: Restrictions
  /** 由会话的 nextValidId 发号（IB 的规则：服务端给号，客户端不自己编）。 */
  nextOrderId: () => number
  /** 内核没给客户端单号时用它生成。 */
  newClientOrderId: () => string
  /** 显式允许自定义端口（假服务器 / 隧道）。 */
  allowCustomPort?: boolean
}

export interface BuiltLeg {
  order: IbOrder
  clientOrderId: string
  role: LegRole
}

export interface BuiltOrders {
  clientOrderId: string
  legs: BuiltLeg[]
  /** 本次发出的 IB 订单里最后一张（transmit=true）。 */
  lastOrderId: number
}

/** 数量：size 优先；notional 按参考价折算成整数股（向下取整，不四舍五入）。 */
export function resolveSize(intent: OrderIntent, reference: number | string | undefined, symbol: string): Decimal {
  if (intent.size !== undefined) {
    if (fx(intent.size) <= 0n) throw IbError.of('INVALID_PARAMS', 'size must be positive', '数量必须大于 0')
    assertWholeShares(asDecimal(str(fx(intent.size))), symbol)
    return asDecimal(str(fx(intent.size)))
  }
  if (intent.notional !== undefined) {
    if (reference === undefined) {
      throw IbError.of('STALE_PRICE', `no reference price to convert notional for ${symbol}`, '按名义额下单需要参考价：先 refreshQuote()；无行情权限时改用 size（整数股）', { retryAfterMs: 1000 })
    }
    const ref = fx(String(reference))
    if (ref <= 0n) {
      throw IbError.of('STALE_PRICE', `no reference price to convert notional for ${symbol}`, '按名义额下单需要参考价：先 refreshQuote()；无行情权限时改用 size（整数股）', { retryAfterMs: 1000 })
    }
    const shares = fx(intent.notional) / ref
    if (shares < 1n) {
      throw IbError.of('PRECISION', `notional ${intent.notional} is below one share of ${symbol}`, '名义额不足一股：改成整数股 size 或提高名义额')
    }
    return asDecimal(String(shares))
  }
  throw IbError.of('INVALID_PARAMS', 'order needs size or notional', '订单必须给整数股 size 或 notional')
}

/** 价格必须是正数且是 tick 的整数倍；不替用户改价。 */
export function priceGuard(label: string, value: Decimal | undefined, record: InstrumentRecord): Decimal {
  if (value === undefined) throw IbError.of('INVALID_PARAMS', `${label} is required for this order type`, `该单型必须带 ${label}`)
  if (fx(value) <= 0n) throw IbError.of('INVALID_PARAMS', `${label} must be positive (got ${value})`, '价格必须大于 0')
  if (fx(value) % fx(record.tick) !== 0n) {
    throw IbError.of(
      'PRECISION',
      `${label} ${value} is not a multiple of tick ${record.tick} for ${record.instrument.symbol}`,
      '按合同最小变动价位（minTick）规整后再发：本包不替用户改价（改价会改变成交条件）',
    )
  }
  return value
}

/** 单型 → IB orderType（不支持的回 1004）。 */
export function orderTypeOf(type: OrderType): { type: string; kind: 'market' | 'non_market' } {
  switch (type) {
    case 'market':
      return { type: 'LMT', kind: 'market' }
    case 'limit':
      return { type: 'LMT', kind: 'non_market' }
    case 'stop_market':
      return { type: 'STP', kind: 'non_market' }
    case 'stop_limit':
      return { type: 'STP LMT', kind: 'non_market' }
    case 'trailing_stop':
      return { type: 'TRAIL', kind: 'non_market' }
    default:
      throw IbError.of(
        'ORDER_TYPE_UNSUPPORTED',
        `order type ${type} is not supported by the IBKR trade connector`,
        `IB 最小子集只支持 ${SUPPORTED_ORDER_TYPES.join(' / ')}；止盈类单型请用 tpsl（场所原生 bracket）`,
      )
  }
}

/**
 * 构建订单（含 bracket 三腿）。任何不合规都在这里拒，绝不发出去再指望场所回错。
 * 顺序即裁定顺序：账户限制 → 时段 → 单型 → 数量 → 价格 / 价带 → 卖空 → 触发价 → 父单 / 子单。
 */
export function buildOrders(intent: OrderIntent, ctx: BuildContext): BuiltOrders {
  const record = ctx.record
  const symbol = record.instrument.symbol
  assertAccountCanTrade(ctx.restrictions)
  const mapped = orderTypeOf(intent.type)
  const tif = tifOf(intent)
  const session = assertSessionAllows({
    record,
    now: ctx.now,
    kind: mapped.kind,
    ...(ctx.allowExtendedHours !== undefined ? { allowExtendedHours: ctx.allowExtendedHours } : {}),
    tif: intent.tif,
  })
  const outsideRth = session.state === 'extended'
  assertTriggerType(intent.triggerType)
  if (intent.leverage !== undefined && intent.leverage > 1) {
    throw IbError.of(
      'CAPABILITY_UNSUPPORTED',
      `IBKR cash-equity accounts have no per-order leverage (got ${String(intent.leverage)}x)`,
      'IB 的融资倍数由账户（保证金账户）决定，不能按单设置；去掉 leverage / marginMode',
    )
  }
  if (intent.postOnly === true) {
    throw IbError.of('ORDER_TYPE_UNSUPPORTED', 'postOnly is not available for IBKR cash equities', '去掉 postOnly（IB 现金股票没有只做 maker 的单型）')
  }
  const size = resolveSize(intent, ctx.referencePrice, symbol)
  assertSellReducesOnly({
    side: intent.side,
    size,
    ...(ctx.positionSize !== undefined ? { positionSize: ctx.positionSize } : {}),
    ...(ctx.shortPositionSize !== undefined ? { shortPositionSize: ctx.shortPositionSize } : {}),
    reduceOnly: intent.reduceOnly,
    symbol,
  })

  const clientOrderId = intent.clientOrderId ?? ctx.newClientOrderId()
  const action = intent.side === 'buy' ? 'BUY' : 'SELL'
  const parentId = ctx.nextOrderId()
  const parent = M.emptyOrder(parentId)
  parent.action = action
  parent.totalQuantity = size
  parent.orderType = mapped.type
  parent.tif = tif
  parent.account = ctx.account
  parent.orderRef = orderRefOf(clientOrderId, 'parent')
  parent.outsideRth = outsideRth
  parent.transmit = intent.tpsl === undefined
  if (intent.tif === 'gtd') {
    const expires = intent.expiresAt
    if (expires === undefined) {
      throw IbError.of('INVALID_PARAMS', 'gtd orders need expiresAt', 'GTD 必须带 expiresAt（IB 的 goodTillDate）')
    }
    parent.goodTillDate = formatGtd(expires)
  }

  switch (intent.type) {
    case 'market': {
      const band = marketBandPrice({
        symbol,
        side: intent.side,
        reference: ctx.referencePrice,
        maxSlippageBps: intent.maxSlippageBps,
        tick: record.tick,
        marketErrorCode: ctx.marketErrorCode,
      })
      parent.orderType = 'LMT'
      parent.lmtPrice = band.price
      parent.tif = 'IOC'
      break
    }
    case 'limit':
      parent.lmtPrice = priceGuard('price', intent.price, record)
      break
    case 'stop_market':
      parent.auxPrice = priceGuard('triggerPrice', intent.triggerPrice, record)
      break
    case 'stop_limit':
      parent.lmtPrice = priceGuard('price', intent.price, record)
      parent.auxPrice = priceGuard('triggerPrice', intent.triggerPrice, record)
      break
    case 'trailing_stop': {
      const trailing = intent.trailing
      if (trailing === undefined) {
        throw IbError.of('INVALID_PARAMS', 'trailing_stop needs trailing.callbackRatio', '跟踪止损必须给 callbackRatio（比例，如 0.02 = 2%）')
      }
      if (trailing.activationPrice !== undefined || trailing.activationRatio !== undefined) {
        throw IbError.of(
          'ORDER_TYPE_UNSUPPORTED',
          'trailing-stop activation price is not supported by this connector',
          'IB 的 TRAIL 单一旦激活就按回调比例跟踪；带激活条件的版本需要额外字段（本包未建模），请改成普通 TRAIL 或止损单',
        )
      }
      const ratio = trailing.callbackRatio
      if (fx(ratio) <= 0n || fx(ratio) >= fx('1')) {
        throw IbError.of('INVALID_PARAMS', `callbackRatio must be in (0, 1) (got ${ratio})`, '回调比例是比例值（0.02 = 2%），不是百分数')
      }
      parent.trailingPercent = mulDec(ratio, '100')
      break
    }
    default:
      throw IbError.of('ORDER_TYPE_UNSUPPORTED', `order type ${intent.type} is not supported`, '本包只做 US 现金股票的最小单型集')
  }

  const legs: BuiltLeg[] = [{ order: parent, clientOrderId, role: 'parent' }]
  const tpsl = intent.tpsl
  if (tpsl !== undefined) {
    if (tpsl.grouping !== 'order') {
      throw IbError.of(
        'CAPABILITY_UNSUPPORTED',
        'position-level tpsl is not supported (IBKR bracket is per-order)',
        'IB 的保护单是随父单提交的 bracket（order 级）；position 级需要另发反向单，本包未建模',
      )
    }
    const exitAction = action === 'BUY' ? 'SELL' : 'BUY'
    const children: Array<{ role: 'tp' | 'sl'; price: Decimal; type: string; trigger?: Decimal }> = []
    if (tpsl.takeProfit !== undefined) {
      const tp = tpsl.takeProfit
      if (tp.price === undefined) {
        throw IbError.of('ORDER_TYPE_UNSUPPORTED', 'take-profit leg needs a limit price on IBKR', 'IB 的止盈腿是限价单：给 tpsl.takeProfit.price')
      }
      children.push({ role: 'tp', price: priceGuard('tpsl.takeProfit.price', tp.price, record), type: 'LMT' })
    }
    if (tpsl.stopLoss !== undefined) {
      const sl = tpsl.stopLoss
      const trigger = priceGuard('tpsl.stopLoss.triggerPrice', sl.triggerPrice, record)
      if (sl.price !== undefined) children.push({ role: 'sl', price: priceGuard('tpsl.stopLoss.price', sl.price, record), type: 'STP LMT', trigger })
      else children.push({ role: 'sl', price: trigger, type: 'STP', trigger })
    }
    if (children.length === 0) {
      throw IbError.of('INVALID_PARAMS', 'tpsl given without takeProfit or stopLoss', '给出 tpsl 时至少要有止盈或止损一腿')
    }
    children.forEach((child, i) => {
      const id = ctx.nextOrderId()
      const o = M.emptyOrder(id)
      o.action = exitAction
      o.totalQuantity = size
      o.orderType = child.type
      o.tif = 'GTC'
      o.account = ctx.account
      o.parentId = parentId
      o.orderRef = orderRefOf(clientOrderId, child.role)
      o.outsideRth = outsideRth
      if (child.type === 'LMT') o.lmtPrice = child.price
      else if (child.type === 'STP') o.auxPrice = child.trigger ?? child.price
      else {
        o.lmtPrice = child.price
        o.auxPrice = child.trigger ?? child.price
      }
      // 最后一张子单才 transmit：否则父单会被单独送出，失去原子性。
      o.transmit = i === children.length - 1
      legs.push({ order: o, clientOrderId, role: child.role })
    })
  }
  return { clientOrderId, legs, lastOrderId: legs[legs.length - 1]!.order.orderId }
}

/** GTD 的 goodTillDate：IB Order 文档的 UTC 写法 `yyyyMMdd-HH:mm:ss`。 */
export function formatGtd(ms: number): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  const d = new Date(ms)
  return `${String(d.getUTCFullYear())}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
}

/** 保证金 / 名义额估算（诊断用；不参与风控裁定）。 */
export function notionalOf(size: Decimal, price: number): Decimal {
  return mulDec(size, asDecimal(String(price)), 2)
}

export { subDec }
