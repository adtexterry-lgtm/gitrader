// SPDX-License-Identifier: CPAL-1.0
// IB socket 消息表 + 编解码（服务器版本固定 178）。
// 参照 ib_async client.py / decoder.py（BSD-2-Clause）的字段序；未复制源码。
// 十进制一律 Decimal 文本；未设置的价格用 undefined（线上空串）。
import { asDecimal } from '@gitrader/protocol'
import type { Decimal } from '@gitrader/protocol'
import { normalizeDecimal } from '@gitrader/protocol'
import { cmpDec } from '@gitrader/protocol/decimal'
import { encodeMessage } from './wire'

/** IB 的 UNSET_INTEGER（2^31-1）。 */
export const UNSET_INTEGER = 2147483647

export const OUT = {
  REQ_MKT_DATA: 1,
  PLACE_ORDER: 3,
  CANCEL_ORDER: 4,
  REQ_OPEN_ORDERS: 5,
  REQ_EXECUTIONS: 7,
  REQ_CONTRACT_DATA: 9,
  REQ_ALL_OPEN_ORDERS: 16,
  REQ_CURRENT_TIME: 49,
  REQ_GLOBAL_CANCEL: 58,
  REQ_POSITIONS: 61,
  REQ_ACCOUNT_SUMMARY: 62,
  CANCEL_ACCOUNT_SUMMARY: 63,
  CANCEL_POSITIONS: 64,
  START_API: 71,
} as const

export const IN = {
  TICK_PRICE: 1,
  TICK_SIZE: 2,
  ORDER_STATUS: 3,
  ERR_MSG: 4,
  OPEN_ORDER: 5,
  NEXT_VALID_ID: 9,
  CONTRACT_DATA: 10,
  EXECUTION_DATA: 11,
  MANAGED_ACCTS: 15,
  CONTRACT_DATA_END: 52,
  OPEN_ORDER_END: 53,
  EXECUTION_DATA_END: 55,
  TICK_SNAPSHOT_END: 57,
  COMMISSION_REPORT: 59,
  POSITION: 61,
  POSITION_END: 62,
  ACCOUNT_SUMMARY: 63,
  ACCOUNT_SUMMARY_END: 64,
  CURRENT_TIME: 49,
} as const

export const SEC_TYPE_STOCK = 'STK'
export const DEFAULT_EXCHANGE = 'SMART'
export const DEFAULT_CURRENCY = 'USD'

/** 读字段：入参是整帧字段数组；缺省 start = 1（跳过消息号）。 */
export class FieldReader {
  #at: number
  readonly #fields: readonly string[]

  constructor(fields: readonly string[], start = 1) {
    this.#fields = fields
    this.#at = start
  }

  str(): string {
    if (this.#at >= this.#fields.length) throw new RangeError(`wire field ${String(this.#at)} is missing`)
    const value = this.#fields[this.#at]!
    this.#at += 1
    return value
  }

  int(): number {
    const text = this.str()
    if (text === '') return 0
    if (!/^[+-]?\d+$/.test(text)) throw new RangeError(`wire field is not an integer: ${JSON.stringify(text)}`)
    return Number(text)
  }

  bool(): boolean {
    const text = this.str()
    if (text === '') return false
    return Number(text) !== 0
  }

  dec(): Decimal | undefined {
    const text = this.str()
    if (text === '' || text === 'Infinite' || text === 'Infinity') return undefined
    if (Number(text) >= 1e300) return undefined
    try {
      return normalizeDecimal(text)
    } catch {
      throw new RangeError(`wire field is not a decimal: ${JSON.stringify(text)}`)
    }
  }

  dec0(): Decimal {
    return this.dec() ?? asDecimal('0')
  }

  skip(n: number): void {
    if (n < 0) throw new RangeError('skip count must be non-negative')
    if (this.#at + n > this.#fields.length) throw new RangeError(`wire needs ${String(n)} more fields at ${String(this.#at)}`)
    this.#at += n
  }

  get remaining(): number {
    return this.#fields.length - this.#at
  }
}

/** Decimal → 线上文本（undefined 写成空串）。 */
export function decText(d: Decimal | undefined): string {
  return d === undefined ? '' : d
}

// ---- 结构 ---------------------------------------------------------------------------

export interface IbContract {
  conId: number
  symbol: string
  secType: string
  lastTradeDate: string
  strike: string
  right: string
  multiplier: string
  exchange: string
  primaryExchange: string
  currency: string
  localSymbol: string
  tradingClass: string
}

export function stockContract(symbol: string, exchange = DEFAULT_EXCHANGE, currency = DEFAULT_CURRENCY): IbContract {
  return {
    conId: 0,
    symbol: symbol.trim().toUpperCase(),
    secType: SEC_TYPE_STOCK,
    lastTradeDate: '',
    strike: '0',
    right: '',
    multiplier: '',
    exchange,
    primaryExchange: '',
    currency,
    localSymbol: '',
    tradingClass: '',
  }
}

function contractFields(c: IbContract): Array<string | number> {
  return [
    c.conId,
    c.symbol,
    c.secType,
    c.lastTradeDate,
    c.strike,
    c.right,
    c.multiplier,
    c.exchange,
    c.primaryExchange,
    c.currency,
    c.localSymbol,
    c.tradingClass,
  ]
}

/** 入站消息的合约只有 11 个字段（没有 primaryExchange）。 */
function contractFields11(c: IbContract): Array<string | number> {
  return [c.conId, c.symbol, c.secType, c.lastTradeDate, c.strike, c.right, c.multiplier, c.exchange, c.currency, c.localSymbol, c.tradingClass]
}

function readContract11(r: FieldReader): IbContract {
  return {
    conId: r.int(),
    symbol: r.str(),
    secType: r.str(),
    lastTradeDate: r.str(),
    strike: r.str(),
    right: r.str(),
    multiplier: r.str(),
    exchange: r.str(),
    currency: r.str(),
    localSymbol: r.str(),
    tradingClass: r.str(),
    primaryExchange: '',
  }
}

export interface IbOrder {
  orderId: number
  action: 'BUY' | 'SELL'
  totalQuantity: Decimal
  orderType: string
  lmtPrice?: Decimal
  auxPrice?: Decimal
  tif: string
  ocaGroup: string
  account: string
  orderRef: string
  transmit: boolean
  parentId: number
  outsideRth: boolean
  goodTillDate: string
  trailStopPrice?: Decimal
  trailingPercent?: Decimal
}

export function emptyOrder(orderId: number): IbOrder {
  return {
    orderId,
    action: 'BUY',
    totalQuantity: asDecimal('0'),
    orderType: 'LMT',
    tif: 'DAY',
    ocaGroup: '',
    account: '',
    orderRef: '',
    transmit: true,
    parentId: 0,
    outsideRth: false,
    goodTillDate: '',
  }
}

export interface IbOrderStatus {
  orderId: number
  status: string
  filled: Decimal
  remaining: Decimal
  avgFillPrice?: Decimal
  permId: number
  parentId: number
  lastFillPrice?: Decimal
  clientId: number
  whyHeld: string
  mktCapPrice?: Decimal
}

export interface IbOpenOrder {
  orderId: number
  contract: IbContract
  action: string
  totalQuantity: Decimal
  orderType: string
  lmtPrice?: Decimal
  auxPrice?: Decimal
  tif: string
  ocaGroup: string
  account: string
  orderRef: string
  clientId: number
  permId: number
  outsideRth: boolean
  goodTillDate: string
  parentId: number
  trailStopPrice?: Decimal
  trailingPercent?: Decimal
  status: string
  warningText: string
}

export interface IbExecution {
  reqId: number
  orderId: number
  contract: IbContract
  execId: string
  time: string
  acctNumber: string
  exchange: string
  side: string
  shares: Decimal
  price: Decimal
  permId: number
  clientId: number
  liquidation: number
  cumQty: Decimal
  avgPrice: Decimal
  orderRef: string
  lastLiquidity: number
}

export interface IbCommissionReport {
  execId: string
  commission?: Decimal
  currency: string
  realizedPnl?: Decimal
}

export interface IbPosition {
  account: string
  contract: IbContract
  position: Decimal
  avgCost: Decimal
}

export interface IbAccountSummary {
  reqId: number
  account: string
  tag: string
  value: string
  currency: string
}

export interface IbContractDetails {
  reqId: number
  contract: IbContract
  marketName: string
  minTick: Decimal
  orderTypes: string
  validExchanges: string
  longName: string
  industry: string
  category: string
  timeZoneId: string
  tradingHours: string
  liquidHours: string
  stockType: string
  marketRuleIds?: string
  minSize?: Decimal
  sizeIncrement?: Decimal
}

export interface IbErrorMsg {
  reqId: number
  code: number
  message: string
  advanced: string
}

export interface IbTick {
  tickerId: number
  tickType: number
  price?: Decimal
}

// ---- 出站请求 -----------------------------------------------------------------------

export function startApi(clientId: number): Buffer {
  return encodeMessage([OUT.START_API, 2, clientId, ''])
}

export function reqMarketData(tickerId: number, contract: IbContract, genericTicks = '', snapshot = true): Buffer {
  return encodeMessage([OUT.REQ_MKT_DATA, 11, tickerId, ...contractFields(contract), false, genericTicks, snapshot, false, ''])
}

export function cancelOrder(orderId: number): Buffer {
  return encodeMessage([OUT.CANCEL_ORDER, 1, orderId, ''])
}

export function reqOpenOrders(): Buffer {
  return encodeMessage([OUT.REQ_OPEN_ORDERS, 1])
}

export function reqAllOpenOrders(): Buffer {
  return encodeMessage([OUT.REQ_ALL_OPEN_ORDERS, 1])
}

export function reqExecutions(reqId: number, clientId: number, account = '', time = ''): Buffer {
  return encodeMessage([OUT.REQ_EXECUTIONS, 3, reqId, clientId, account, time, '', '', '', ''])
}

export function reqContractDetails(reqId: number, contract: IbContract): Buffer {
  return encodeMessage([OUT.REQ_CONTRACT_DATA, 8, reqId, ...contractFields(contract), false, '', '', ''])
}

export function reqCurrentTime(): Buffer {
  return encodeMessage([OUT.REQ_CURRENT_TIME, 1])
}

export function reqGlobalCancel(): Buffer {
  return encodeMessage([OUT.REQ_GLOBAL_CANCEL, 1])
}

export function reqPositions(): Buffer {
  return encodeMessage([OUT.REQ_POSITIONS, 1])
}

export function cancelPositions(): Buffer {
  return encodeMessage([OUT.CANCEL_POSITIONS, 1])
}

export const DEFAULT_SUMMARY_TAGS =
  'AccountType,NetLiquidation,TotalCashValue,AvailableFunds,BuyingPower,GrossPositionValue,InitMarginReq,MaintMarginReq,ExcessLiquidity,Cushion,DayTradesRemaining,Leverage'

export function reqAccountSummary(reqId: number, group = 'All', tags = DEFAULT_SUMMARY_TAGS): Buffer {
  return encodeMessage([OUT.REQ_ACCOUNT_SUMMARY, 1, reqId, group, tags])
}

export function cancelAccountSummary(reqId: number): Buffer {
  return encodeMessage([OUT.CANCEL_ACCOUNT_SUMMARY, 1, reqId])
}

/** placeOrder @ v178：114 个字段（顺序与 ib_async 的 v178 字段表一致）。 */
export function placeOrder(contract: IbContract, o: IbOrder): Buffer {
  return encodeMessage([
    OUT.PLACE_ORDER, o.orderId, ...contractFields(contract),
    '', '', // secIdType, secId
    o.action, o.totalQuantity, o.orderType, decText(o.lmtPrice), decText(o.auxPrice), o.tif,
    o.ocaGroup,
    o.account,
    '', // openClose：机构专用，本包永远发空
    0, // origin
    o.orderRef, o.transmit, o.parentId,
    false, false, 0, 0, // blockOrder, sweepToFill, displaySize, triggerMethod
    o.outsideRth, false, // outsideRth, hidden
    '', // sharesAllocation
    '0', '', o.goodTillDate, '', '', '', // discretionaryAmt, goodAfterTime, goodTillDate, faGroup, faMethod, faPercentage
    '', 0, '', -1, 0, '', '', false, '', '', // modelCode, shortSaleSlot, designatedLocation, exemptCode, ocaType, rule80A, settlingFirm, allOrNone, minQty, percentOffset
    false, false, '', 0, '', '', '', '', '', false, // eTradeOnly, firmQuoteOnly, nbboPriceCap, auctionStrategy, startingPrice, stockRefPrice, delta, stockRangeLower, stockRangeUpper, overridePercentageConstraints
    '', '', '', '', // volatility, volatilityType, deltaNeutralOrderType, deltaNeutralAuxPrice
    false, '', decText(o.trailStopPrice), decText(o.trailingPercent), '', '', '', // continuousUpdate, referencePriceType, trailStopPrice, trailingPercent, scaleInitLevelSize, scaleSubsLevelSize, scalePriceIncrement
    '', '', '', '', // scaleTable, activeStartTime, activeStopTime, hedgeType
    false, '', '', false, // optOutSmartRouting, clearingAccount, clearingIntent, notHeld
    false, // deltaNeutralContract 存在标志
    '', // algoStrategy
    '', false, '', false, false, false, // algoId, whatIf, orderMiscOptions, solicited, randomizeSize, randomizePrice
    0, // conditions 个数
    '', '', '', '', '', '', 0, '', '', '', '', // adjustedOrderType, triggerPrice, lmtPriceOffset, adjustedStopPrice, adjustedStopLimitPrice, adjustedTrailingAmount, adjustableTrailingUnit, extOperator, softDollarTier.name, softDollarTier.val, cashQty
    '', '', '', '', // mifid2 四个
    false, false, false, false, // dontUseAutoPriceForHedge, isOmsContainer, discretionaryUpToLimitPrice, usePriceMgmtAlgo
    '', '', false, '', '', // duration, postToAts, autoCancelParent, advancedErrorOverride, manualOrderTime
  ])
}

// ---- 入站解码 -----------------------------------------------------------------------

export function decodeOrderStatus(fields: readonly string[]): IbOrderStatus {
  const r = new FieldReader(fields)
  return {
    orderId: r.int(),
    status: r.str(),
    filled: r.dec0(),
    remaining: r.dec0(),
    avgFillPrice: r.dec(),
    permId: r.int(),
    parentId: r.int(),
    lastFillPrice: r.dec(),
    clientId: r.int(),
    whyHeld: r.str(),
    mktCapPrice: r.dec(),
  }
}

export function decodeError(fields: readonly string[]): IbErrorMsg {
  const r = new FieldReader(fields, 2)
  return { reqId: r.int(), code: r.int(), message: r.str(), advanced: r.str() }
}

export function decodeOpenOrder(fields: readonly string[]): IbOpenOrder {
  const r = new FieldReader(fields)
  const orderId = r.int()
  const contract = readContract11(r)
  const action = r.str()
  const totalQuantity = r.dec0()
  const orderType = r.str()
  const lmtPrice = r.dec()
  const auxPrice = r.dec()
  const tif = r.str()
  const ocaGroup = r.str()
  const account = r.str()
  r.skip(1) // openClose
  r.skip(1) // origin
  const orderRef = r.str()
  const clientId = r.int()
  const permId = r.int()
  const outsideRth = r.bool()
  r.skip(1) // hidden
  r.skip(1) // discretionaryAmt
  r.skip(1) // goodAfterTime
  r.skip(1) // sharesAllocation
  r.skip(1) // faGroup
  r.skip(1) // faMethod
  r.skip(1) // faPercentage
  r.skip(1) // modelCode
  const goodTillDate = r.str()
  r.skip(1) // rule80A
  r.skip(1) // percentOffset
  r.skip(1) // settlingFirm
  r.skip(1) // shortSaleSlot
  r.skip(1) // designatedLocation
  r.skip(1) // exemptCode
  r.skip(1) // auctionStrategy
  r.skip(1) // startingPrice
  r.skip(1) // stockRefPrice
  r.skip(1) // delta
  r.skip(1) // stockRangeLower
  r.skip(1) // stockRangeUpper
  r.skip(1) // displaySize
  r.skip(1) // blockOrder
  r.skip(1) // sweepToFill
  r.skip(1) // allOrNone
  r.skip(1) // minQty
  r.skip(1) // ocaType
  r.skip(1) // eTradeOnly
  r.skip(1) // firmQuoteOnly
  r.skip(1) // nbboPriceCap
  const parentId = r.int()
  r.skip(1) // triggerMethod
  r.skip(1) // volatility
  r.skip(1) // volatilityType
  const deltaNeutralOrderType = r.str()
  r.skip(1) // deltaNeutralAuxPrice
  if (deltaNeutralOrderType !== '') r.skip(8)
  r.skip(1) // continuousUpdate
  r.skip(1) // referencePriceType
  const trailStopPrice = r.dec()
  const trailingPercent = r.dec()
  r.skip(1) // basisPoints
  r.skip(1) // basisPointsType
  r.skip(1) // comboLegsDescrip
  const numLegs = r.int()
  r.skip(numLegs * 8)
  const numOrderLegs = r.int()
  r.skip(numOrderLegs)
  const numSmartComboParams = r.int()
  r.skip(numSmartComboParams * 2)
  r.skip(1) // scaleInitLevelSize
  r.skip(1) // scaleSubsLevelSize
  const scalePriceIncrement = r.str()
  if (scalePriceIncrement !== '' && Number(scalePriceIncrement) > 0 && Number(scalePriceIncrement) < 1e300) r.skip(7)
  const hedgeType = r.str()
  if (hedgeType !== '') r.skip(1)
  r.skip(1) // optOutSmartRouting
  r.skip(1) // clearingAccount
  r.skip(1) // clearingIntent
  r.skip(1) // notHeld
  const dncPresent = r.int()
  if (dncPresent !== 0) r.skip(3)
  const algoStrategy = r.str()
  if (algoStrategy !== '') {
    const n = r.int()
    r.skip(n * 2)
  }
  r.skip(1) // solicited
  r.skip(1) // whatIf
  const status = r.str()
  r.skip(13) // 9 个 margin 字段 + commission / minCommission / maxCommission / commissionCurrency
  const warningText = r.str()
  return {
    orderId,
    contract,
    action,
    totalQuantity,
    orderType,
    lmtPrice,
    auxPrice,
    tif,
    ocaGroup,
    account,
    orderRef,
    clientId,
    permId,
    outsideRth,
    goodTillDate,
    parentId,
    trailStopPrice,
    trailingPercent,
    status,
    warningText,
  }
}

export function decodeContractDetails(fields: readonly string[]): IbContractDetails {
  const r = new FieldReader(fields)
  const reqId = r.int()
  const symbol = r.str()
  const secType = r.str()
  const lastTimes = r.str()
  const strike = r.str()
  const right = r.str()
  const exchange = r.str()
  const currency = r.str()
  const localSymbol = r.str()
  const marketName = r.str()
  const tradingClass = r.str()
  const conId = r.int()
  const minTick = r.dec0()
  const multiplier = r.str()
  const orderTypes = r.str()
  const validExchanges = r.str()
  r.skip(1) // priceMagnifier
  r.skip(1) // underConId
  const longName = r.str()
  const primaryExchange = r.str()
  r.skip(1) // contractMonth
  const industry = r.str()
  const category = r.str()
  r.skip(1) // subcategory
  const timeZoneId = r.str()
  const tradingHours = r.str()
  const liquidHours = r.str()
  r.skip(1) // evRule
  r.skip(1) // evMultiplier
  const numSecIds = r.int()
  r.skip(numSecIds * 2)
  r.skip(1) // aggGroup
  r.skip(1) // underSymbol
  r.skip(1) // underSecType
  const marketRuleIds = r.str()
  r.skip(1) // realExpirationDate
  const stockType = r.str()
  const minSize = r.dec()
  const sizeIncrement = r.dec()
  void multiplier
  const lastTradeDate = lastTimes.split(/[- ]/)[0] ?? ''
  return {
    reqId,
    contract: { conId, symbol, secType, lastTradeDate, strike, right, multiplier, exchange, primaryExchange, currency, localSymbol, tradingClass },
    marketName,
    minTick,
    orderTypes,
    validExchanges,
    longName,
    industry,
    category,
    timeZoneId,
    tradingHours,
    liquidHours,
    stockType,
    marketRuleIds,
    minSize,
    sizeIncrement,
  }
}

export function decodeExecDetails(fields: readonly string[]): IbExecution {
  const r = new FieldReader(fields)
  const reqId = r.int()
  const orderId = r.int()
  const contract = readContract11(r)
  const execId = r.str()
  const time = r.str()
  const acctNumber = r.str()
  const exchange = r.str()
  const side = r.str()
  const shares = r.dec0()
  const price = r.dec0()
  const permId = r.int()
  const clientId = r.int()
  const liquidation = r.int()
  const cumQty = r.dec0()
  const avgPrice = r.dec0()
  const orderRef = r.str()
  r.skip(1) // evRule
  r.skip(1) // evMultiplier
  r.skip(1) // modelCode
  const lastLiquidity = r.int()
  return { reqId, orderId, contract, execId, time, acctNumber, exchange, side, shares, price, permId, clientId, liquidation, cumQty, avgPrice, orderRef, lastLiquidity }
}

export function decodeCommissionReport(fields: readonly string[]): IbCommissionReport {
  const r = new FieldReader(fields, 2)
  const execId = r.str()
  const commission = r.dec()
  const currency = r.str()
  const realizedPnl = r.dec()
  r.skip(2) // yield, yieldRedemptionDate
  return { execId, commission, currency, realizedPnl }
}

export function decodePosition(fields: readonly string[]): IbPosition {
  const r = new FieldReader(fields, 2)
  const account = r.str()
  const contract = readContract11(r)
  return { account, contract, position: r.dec0(), avgCost: r.dec0() }
}

export function decodeAccountSummary(fields: readonly string[]): IbAccountSummary {
  const r = new FieldReader(fields, 2)
  return { reqId: r.int(), account: r.str(), tag: r.str(), value: r.str(), currency: r.str() }
}

export function decodeTickPrice(fields: readonly string[]): IbTick {
  const r = new FieldReader(fields, 2)
  const tickerId = r.int()
  const tickType = r.int()
  const price = r.dec()
  return { tickerId, tickType, ...(price !== undefined && cmpDec(price, '0') > 0 ? { price } : {}) }
}

// ---- 入站编码器（假 TWS 与单测共用）-------------------------------------------------

const UNSET_DOUBLE_TEXT = '1.7976931348623157E308'

export function handshakeReply(serverVersion: number, time: string): Buffer {
  return encodeMessage([serverVersion, time])
}

export function errMsg(reqId: number, code: number, message: string, advanced = ''): Buffer {
  return encodeMessage([IN.ERR_MSG, 2, reqId, code, message, advanced])
}

export function nextValidId(orderId: number): Buffer {
  return encodeMessage([IN.NEXT_VALID_ID, 1, orderId])
}

export function managedAccounts(accounts: string): Buffer {
  return encodeMessage([IN.MANAGED_ACCTS, 1, accounts])
}

export function orderStatusMessage(s: IbOrderStatus): Buffer {
  return encodeMessage([
    IN.ORDER_STATUS,
    s.orderId,
    s.status,
    s.filled,
    s.remaining,
    decText(s.avgFillPrice),
    s.permId,
    s.parentId,
    decText(s.lastFillPrice),
    s.clientId,
    s.whyHeld,
    decText(s.mktCapPrice),
  ])
}

export function openOrderMessage(o: IbOpenOrder): Buffer {
  return encodeMessage([
    IN.OPEN_ORDER, o.orderId, ...contractFields11(o.contract),
    o.action, o.totalQuantity, o.orderType, decText(o.lmtPrice), decText(o.auxPrice), o.tif,
    o.ocaGroup, o.account, '', 0, o.orderRef, o.clientId, o.permId,
    o.outsideRth, false, // outsideRth, hidden
    '0', '', '', '', '', '', // discretionaryAmt, goodAfterTime, sharesAllocation, faGroup, faMethod, faPercentage
    '', o.goodTillDate, '', '', '', // modelCode, goodTillDate, rule80A, percentOffset, settlingFirm
    '0', '', '-1', '0', // shortSaleSlot, designatedLocation, exemptCode, auctionStrategy
    '', '', '', '', '', // startingPrice, stockRefPrice, delta, stockRangeLower, stockRangeUpper
    '', '0', '0', '0', '', '0', '0', '0', '', // displaySize, blockOrder, sweepToFill, allOrNone, minQty, ocaType, eTradeOnly, firmQuoteOnly, nbboPriceCap
    o.parentId, '0', '0', '', // parentId, triggerMethod, volatility, volatilityType
    '', '', // deltaNeutralOrderType, deltaNeutralAuxPrice
    '0', '', // continuousUpdate, referencePriceType
    decText(o.trailStopPrice), decText(o.trailingPercent), '', '', '', // trailStopPrice, trailingPercent, basisPoints, basisPointsType, comboLegsDescrip
    '0', '0', '0', // numLegs, numOrderLegs, numSmartComboParams
    '', '', '', // scaleInitLevelSize, scaleSubsLevelSize, scalePriceIncrement
    '', // hedgeType
    '0', '', '', '0', '0', // optOutSmartRouting, clearingAccount, clearingIntent, notHeld, dncPresent
    '', // algoStrategy
    '0', '0', o.status, // solicited, whatIf, status
    '', '', '', '', '', '', '', '', '', // 9 个 margin 字段
    '', '', '', 'USD', o.warningText, // commission, minCommission, maxCommission, commissionCurrency, warningText
    '0', '0', '0', '', '', decText(o.trailStopPrice), '', '', '', '', '0', '', '', '', '', '0', '0', '0', '0', '', '', '0', '', '', '', '', '',
  ])
}

export function contractDataMessage(cd: IbContractDetails): Buffer {
  return encodeMessage([
    IN.CONTRACT_DATA, cd.reqId,
    cd.contract.symbol, cd.contract.secType, cd.contract.lastTradeDate, cd.contract.strike, cd.contract.right,
    cd.contract.exchange, cd.contract.currency, cd.contract.localSymbol, cd.marketName, cd.contract.tradingClass,
    cd.contract.conId, cd.minTick, cd.contract.multiplier, cd.orderTypes, cd.validExchanges,
    '1', '0', // priceMagnifier, underConId
    cd.longName, cd.contract.primaryExchange, '', cd.industry, cd.category, '',
    cd.timeZoneId, cd.tradingHours, cd.liquidHours,
    '', '', // evRule, evMultiplier
    0, // numSecIds
    '1', '', '', // aggGroup, underSymbol, underSecType
    cd.marketRuleIds ?? '', '', cd.stockType, decText(cd.minSize), decText(cd.sizeIncrement), '',
  ])
}

export function contractDataEnd(reqId: number): Buffer {
  return encodeMessage([IN.CONTRACT_DATA_END, 1, reqId])
}

export function executionDataMessage(x: IbExecution): Buffer {
  return encodeMessage([
    IN.EXECUTION_DATA, x.reqId, x.orderId, ...contractFields11(x.contract),
    x.execId, x.time, x.acctNumber, x.exchange, x.side, x.shares, x.price,
    x.permId, x.clientId, x.liquidation, x.cumQty, x.avgPrice, x.orderRef,
    '', '', '', x.lastLiquidity, '0', // evRule, evMultiplier, modelCode, lastLiquidity, pendingPriceRevision
  ])
}

export function executionDataEnd(reqId: number): Buffer {
  return encodeMessage([IN.EXECUTION_DATA_END, 1, reqId])
}

export function commissionReportMessage(r: IbCommissionReport): Buffer {
  return encodeMessage([
    IN.COMMISSION_REPORT, 1, r.execId,
    decText(r.commission), r.currency,
    r.realizedPnl === undefined ? UNSET_DOUBLE_TEXT : r.realizedPnl,
    UNSET_DOUBLE_TEXT, 0,
  ])
}

export function positionMessage(p: IbPosition): Buffer {
  return encodeMessage([IN.POSITION, 3, p.account, ...contractFields11(p.contract), p.position, p.avgCost])
}

export function positionEnd(): Buffer {
  return encodeMessage([IN.POSITION_END, 1])
}

export function accountSummaryMessage(s: IbAccountSummary): Buffer {
  return encodeMessage([IN.ACCOUNT_SUMMARY, 1, s.reqId, s.account, s.tag, s.value, s.currency])
}

export function accountSummaryEnd(reqId: number): Buffer {
  return encodeMessage([IN.ACCOUNT_SUMMARY_END, 1, reqId])
}

export function tickPrice(tickerId: number, tickType: number, price: string, size: string): Buffer {
  return encodeMessage([IN.TICK_PRICE, 6, tickerId, tickType, price, size, '0'])
}

export function tickSize(tickerId: number, tickType: number, size: string): Buffer {
  return encodeMessage([IN.TICK_SIZE, 6, tickerId, tickType, size])
}

export function tickSnapshotEnd(tickerId: number): Buffer {
  return encodeMessage([IN.TICK_SNAPSHOT_END, 1, tickerId])
}

export function openOrderEnd(): Buffer {
  return encodeMessage([IN.OPEN_ORDER_END, 1])
}

export function currentTime(epochSec: number): Buffer {
  return encodeMessage([IN.CURRENT_TIME, 1, epochSec])
}

/** tickType 常量（IB 文档）：1 bid / 2 ask / 4 last / 9 close；tickSize 0 bidSize / 3 askSize。 */
export const TICK = { BID: 1, ASK: 2, LAST: 4, CLOSE: 9, BID_SIZE: 0, ASK_SIZE: 3 } as const
