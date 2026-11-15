// SPDX-License-Identifier: CPAL-1.0
// 线协议独立参照向量（审稿人手写，不从本包实现推导；施工方不得修改本文件）。
// 参照：ib_async @ ab629f34c1823ea4c1542f32f07377208a86bdfd（v2.1.0，BSD-2-Clause；只读源码，未安装、未执行、未复制代码）：
//   client.py:88-89 MinClientVersion 157 / MaxClientVersion 178；client.py:218-226 握手 b"API\0" + 长度前缀 b"v{min}..{max}"；
//   client.py:245-321 send：每个字段转文本后接 "\0"（int → str、bool → "1"/"0"、None 与 UNSET → ""）；client.py:353-355 长度前缀 >I；
//   client.py:357-394 收包：长度前缀 → 按 "\0" 切分、丢掉最后一个空串；首条 2 字段消息 = (serverVersion, connTime)；
//   client.py:443-467 reqMktData、472-712 placeOrder、714-718 cancelOrder、720-721 reqOpenOrders、726-738 reqExecutions、
//   743-757 reqContractDetails、796-797 reqAllOpenOrders、912-913 reqCurrentTime、980-981 reqGlobalCancel、986-996
//   reqPositions / reqAccountSummary / cancelAccountSummary / cancelPositions、1016-1017 startApi；
//   decoder.py:45-140 消息号表与 skip（skip=2 = 消息号 + 版本号；orderStatus skip=1 无版本号）、200-216 tickPrice / error、
//   255-344 contractDetails（serverVersion ≥ 164 无版本号）、426-475 execDetails（≥ 178 多 pendingPriceRevision）、
//   573-618 commissionReport / position、882-1147 openOrder（无版本号；< 177 才有 faProfile）；order.py:17-171 Order 缺省值；
//   contract.py:85-104 Contract 缺省值；util.py:27-28 UNSET_INTEGER = 2**31-1、UNSET_DOUBLE = sys.float_info.max。
// 本包取单一服务器版本 178（= ib_async MaxClientVersion）：握手只报 "v178..178"，服务器回别的版本即拒。
// 数值文本差异（语义等价，写明）：ib_async 用 Python str(float)（如 "0.0"、"10.0"），本包用规范十进制（"0"、"10"）。
import { describe, expect, it } from 'vitest'
import { asDecimal } from '@gitrader/protocol'
import * as M from '../src/messages'
import type { IbContract, IbOrder } from '../src/messages'
import { API_VERSION, FrameReader, encodeHandshake, encodeMessage, negotiateVersion, parseHandshakeReply } from '../src/wire'

/** 独立解帧：uint32BE 长度 + UTF-8 文本，每个字段以 \0 结尾。 */
function fieldsOf(buf: Buffer): string[] {
  expect(buf.length).toBeGreaterThanOrEqual(4)
  const len = buf.readUInt32BE(0)
  expect(len).toBe(buf.length - 4)
  const text = buf.subarray(4).toString('utf8')
  expect(text.endsWith('\0')).toBe(true)
  const fields = text.split('\0')
  fields.pop()
  return fields
}

/** 按参照字段表拼一帧（假 TWS 侧消息的独立构造，不经本包编码器）。 */
function frameOf(fields: string[]): Buffer {
  const payload = Buffer.from(fields.map((f) => `${f}\0`).join(''), 'utf8')
  const head = Buffer.alloc(4)
  head.writeUInt32BE(payload.length, 0)
  return Buffer.concat([head, payload])
}

const AAPL: IbContract = {
  conId: 265598,
  symbol: 'AAPL',
  secType: 'STK',
  lastTradeDate: '',
  strike: '0',
  right: '',
  multiplier: '',
  exchange: 'SMART',
  primaryExchange: 'NASDAQ',
  currency: 'USD',
  localSymbol: '',
  tradingClass: '',
}
const CONTRACT_12 = ['265598', 'AAPL', 'STK', '', '0', '', '', 'SMART', 'NASDAQ', 'USD', '', '']
const REF = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'

function lmtOrder(over: Partial<IbOrder> = {}): IbOrder {
  return {
    ...M.emptyOrder(101),
    action: 'BUY',
    totalQuantity: asDecimal('10'),
    orderType: 'LMT',
    lmtPrice: asDecimal('100.5'),
    tif: 'DAY',
    account: 'DU1234567',
    orderRef: REF,
    ...over,
  }
}

/** placeOrder @ v178 的参照字段表（client.py:486-712；非 BAG、无 deltaNeutral / scale / hedge / algo / 条件单、交易所非 IBKRATS）。 */
function placeOrderReference(o: {
  orderId: string
  action: string
  qty: string
  type: string
  lmt: string
  aux: string
  tif: string
  ref: string
  transmit: string
  parentId: string
  outsideRth: string
  gtd: string
  trailStop: string
  trailPct: string
}): string[] {
  return [
    '3', o.orderId, ...CONTRACT_12,
    '', '', // secIdType, secId
    o.action, o.qty, o.type, o.lmt, o.aux, o.tif,
    '', // ocaGroup
    'DU1234567', // account
    '', // openClose（机构专用字段，本包不填）
    '0', // origin
    o.ref, o.transmit, o.parentId,
    '0', '0', '0', '0', // blockOrder, sweepToFill, displaySize, triggerMethod
    o.outsideRth, '0', // outsideRth, hidden
    '', // 已废弃 sharesAllocation
    '0', '', o.gtd, '', '', '', // discretionaryAmt, goodAfterTime, goodTillDate, faGroup, faMethod, faPercentage（v178 无 faProfile）
    '', '0', '', '-1', '0', '', '', '0', '', '', // modelCode, shortSaleSlot, designatedLocation, exemptCode, ocaType, rule80A, settlingFirm, allOrNone, minQty, percentOffset
    '0', '0', '', '0', '', '', '', '', '', '0', // eTradeOnly, firmQuoteOnly, nbboPriceCap, auctionStrategy, startingPrice, stockRefPrice, delta, stockRangeLower, stockRangeUpper, overridePercentageConstraints
    '', '', '', '', // volatility, volatilityType, deltaNeutralOrderType, deltaNeutralAuxPrice
    '0', '', o.trailStop, o.trailPct, '', '', '', // continuousUpdate, referencePriceType, trailStopPrice, trailingPercent, scaleInitLevelSize, scaleSubsLevelSize, scalePriceIncrement
    '', '', '', '', // scaleTable, activeStartTime, activeStopTime, hedgeType
    '0', '', '', '0', // optOutSmartRouting, clearingAccount, clearingIntent, notHeld
    '0', // deltaNeutralContract 存在标志
    '', // algoStrategy
    '', '0', '', '0', '0', '0', // algoId, whatIf, orderMiscOptions, solicited, randomizeSize, randomizePrice
    '0', // conditions 个数
    '', '', '', '', '', '', '0', '', '', '', '', // adjustedOrderType, triggerPrice, lmtPriceOffset, adjustedStopPrice, adjustedStopLimitPrice, adjustedTrailingAmount, adjustableTrailingUnit, extOperator, softDollarTier.name, softDollarTier.val, cashQty
    '', '', '', '', // mifid2DecisionMaker, mifid2DecisionAlgo, mifid2ExecutionTrader, mifid2ExecutionAlgo
    '0', '0', '0', '0', // dontUseAutoPriceForHedge, isOmsContainer, discretionaryUpToLimitPrice, usePriceMgmtAlgo
    '', '', '0', '', '', // duration(≥158), postToAts(≥160), autoCancelParent(≥162), advancedErrorOverride(≥166), manualOrderTime(≥169)
  ]
}

const BASE = { orderId: '101', action: 'BUY', qty: '10', type: 'LMT', lmt: '100.5', aux: '', tif: 'DAY', ref: REF, transmit: '1', parentId: '0', outsideRth: '0', gtd: '', trailStop: '', trailPct: '' }

describe('reference · 握手与帧（client.py:218-226 / 245-321 / 353-394）', () => {
  it('握手 = "API\\0" + uint32BE(9) + "v178..178"', () => {
    const hs = encodeHandshake()
    expect(hs.subarray(0, 4).toString('latin1')).toBe('API\0')
    expect(hs.readUInt32BE(4)).toBe(9)
    expect(hs.subarray(8).toString('latin1')).toBe('v178..178')
    expect(hs.length).toBe(17)
    expect(API_VERSION).toBe(178)
  })

  it('字段编码：整数 → 十进制文本，布尔 → "1"/"0"，null / undefined → ""，每个字段后接 \\0，整帧 uint32BE 长度前缀', () => {
    const buf = encodeMessage([71, 2, 7, '', true, false, null, undefined, 'x'])
    expect(buf.readUInt32BE(0)).toBe(buf.length - 4)
    expect(buf.subarray(4).toString('latin1')).toBe('71\x002\x007\x00\x001\x000\x00\x00\x00x\x00')
  })

  it('字段里出现 \\0 一律拒绝（否则会把后续字段整体错位）', () => {
    expect(() => encodeMessage(['a\0b'])).toThrow()
  })

  it('收包：长度前缀 → 按 \\0 切分、去掉末尾空串；分片与粘包都能还原', () => {
    const a = frameOf(['178', '20261021 09:30:00 EST'])
    const b = frameOf(['9', '1', '100'])
    const all = Buffer.concat([a, b])
    const reader = new FrameReader()
    const got: string[][] = []
    for (let i = 0; i < all.length; i += 3) got.push(...reader.push(all.subarray(i, i + 3)))
    expect(got).toEqual([['178', '20261021 09:30:00 EST'], ['9', '1', '100']])
  })

  it('握手回包是 2 字段消息 (serverVersion, connTime)；版本必须正好是 178', () => {
    expect(parseHandshakeReply(['178', '20261021 09:30:00 EST'])).toEqual({ serverVersion: 178, connectionTime: '20261021 09:30:00 EST' })
    expect(parseHandshakeReply(['9', '1', '100'])).toBeUndefined()
    expect(negotiateVersion(178).ok).toBe(true)
    expect(negotiateVersion(176).ok).toBe(false)
    expect(negotiateVersion(200).ok).toBe(false)
  })
})

describe('reference · 出站消息字段序（v178）', () => {
  it('startApi = [71, 2, clientId, optCapab]（client.py:1016-1017）', () => {
    expect(fieldsOf(M.startApi(7))).toEqual(['71', '2', '7', ''])
  })

  it('placeOrder 限价单：114 个字段、无版本号（client.py:486-712）', () => {
    const f = fieldsOf(M.placeOrder(AAPL, lmtOrder()))
    expect(f).toEqual(placeOrderReference(BASE))
    expect(f).toHaveLength(114)
  })

  it('placeOrder 止损 / 止损限价 / 跟踪止损：价格落在 lmtPrice / auxPrice / trailingPercent 的位置，未设的价格为空串', () => {
    const stp = fieldsOf(M.placeOrder(AAPL, lmtOrder({ orderType: 'STP', lmtPrice: undefined, auxPrice: asDecimal('95') })))
    expect(stp).toEqual(placeOrderReference({ ...BASE, type: 'STP', lmt: '', aux: '95' }))
    const stpLmt = fieldsOf(M.placeOrder(AAPL, lmtOrder({ orderType: 'STP LMT', lmtPrice: asDecimal('94.5'), auxPrice: asDecimal('95') })))
    expect(stpLmt).toEqual(placeOrderReference({ ...BASE, type: 'STP LMT', lmt: '94.5', aux: '95' }))
    // 订单文档：trailingPercent 与跟踪金额（auxPrice）互斥，只能给一个。
    const trail = fieldsOf(M.placeOrder(AAPL, lmtOrder({ action: 'SELL', orderType: 'TRAIL', lmtPrice: undefined, trailingPercent: asDecimal('2') })))
    expect(trail).toEqual(placeOrderReference({ ...BASE, action: 'SELL', type: 'TRAIL', lmt: '', trailPct: '2' }))
  })

  it('placeOrder bracket 子单：parentId / transmit / GTC 落位；GTD 与 outsideRth 落位', () => {
    const child = fieldsOf(M.placeOrder(AAPL, lmtOrder({ orderId: 102, action: 'SELL', lmtPrice: asDecimal('110'), tif: 'GTC', parentId: 101, transmit: false, orderRef: `${REF}#tp` })))
    expect(child).toEqual(placeOrderReference({ ...BASE, orderId: '102', action: 'SELL', lmt: '110', tif: 'GTC', parentId: '101', transmit: '0', ref: `${REF}#tp` }))
    const gtd = fieldsOf(M.placeOrder(AAPL, lmtOrder({ tif: 'GTD', goodTillDate: '20261022-20:00:00', outsideRth: true })))
    expect(gtd).toEqual(placeOrderReference({ ...BASE, tif: 'GTD', gtd: '20261022-20:00:00', outsideRth: '1' }))
  })

  it('cancelOrder = [4, 1, orderId, manualCancelOrderTime]（client.py:714-718，≥ 169 带 manualCancelOrderTime）', () => {
    expect(fieldsOf(M.cancelOrder(101))).toEqual(['4', '1', '101', ''])
  })

  it('reqContractDetails = [9, 8, reqId, 合约 12 字段, includeExpired, secIdType, secId, issuerId]（client.py:743-757）', () => {
    expect(fieldsOf(M.reqContractDetails(1000001, M.stockContract('aapl')))).toEqual([
      '9', '8', '1000001', '0', 'AAPL', 'STK', '', '0', '', '', 'SMART', '', 'USD', '', '', '0', '', '', '',
    ])
  })

  it('reqMktData 快照 = [1, 11, tickerId, 合约, deltaNeutral 标志, genericTicks, snapshot, regulatorySnapshot, mktDataOptions]（client.py:443-467）', () => {
    expect(fieldsOf(M.reqMarketData(1000007, AAPL))).toEqual(['1', '11', '1000007', ...CONTRACT_12, '0', '', '1', '0', ''])
  })

  it('reqExecutions = [7, 3, reqId, clientId, acctCode, time, symbol, secType, exchange, side]（client.py:726-738）', () => {
    expect(fieldsOf(M.reqExecutions(1000002, 7, 'DU1234567', ''))).toEqual(['7', '3', '1000002', '7', 'DU1234567', '', '', '', '', ''])
  })

  it('无参请求与撤订阅（client.py:720-721 / 796-797 / 912-913 / 980-996）', () => {
    expect(fieldsOf(M.reqOpenOrders())).toEqual(['5', '1'])
    expect(fieldsOf(M.reqAllOpenOrders())).toEqual(['16', '1'])
    expect(fieldsOf(M.reqCurrentTime())).toEqual(['49', '1'])
    expect(fieldsOf(M.reqGlobalCancel())).toEqual(['58', '1'])
    expect(fieldsOf(M.reqPositions())).toEqual(['61', '1'])
    expect(fieldsOf(M.cancelPositions())).toEqual(['64', '1'])
    expect(fieldsOf(M.reqAccountSummary(1000003, 'All', 'NetLiquidation,AvailableFunds'))).toEqual(['62', '1', '1000003', 'All', 'NetLiquidation,AvailableFunds'])
    expect(fieldsOf(M.cancelAccountSummary(1000003))).toEqual(['63', '1', '1000003'])
  })

  it('账户摘要缺省标签只用 ib_async 标签表里有的（ib.py:2247-2259；没有 Currency / AccountReady）', () => {
    const tags = fieldsOf(M.reqAccountSummary(1))[4]!.split(',')
    expect(tags).not.toContain('Currency')
    expect(tags).not.toContain('AccountReady')
    expect(tags).toEqual(expect.arrayContaining(['NetLiquidation', 'AvailableFunds', 'BuyingPower', 'InitMarginReq', 'MaintMarginReq', 'DayTradesRemaining', 'Leverage']))
  })
})

describe('reference · 入站消息解码（decoder.py，v178）', () => {
  it('orderStatus = [3, orderId, status, filled, remaining, avgFillPrice, permId, parentId, lastFillPrice, clientId, whyHeld, mktCapPrice]（无版本号）', () => {
    const s = M.decodeOrderStatus(['3', '101', 'PreSubmitted', '0', '10', '0', '5001', '0', '0', '7', 'locate', '0'])
    expect(s).toMatchObject({ orderId: 101, status: 'PreSubmitted', filled: '0', remaining: '10', permId: 5001, parentId: 0, clientId: 7, whyHeld: 'locate' })
  })

  it('error = [4, 版本, reqId, code, message, advancedOrderRejectJson]（decoder.py:208-216）', () => {
    expect(M.decodeError(['4', '2', '101', '201', 'Order rejected - reason:no buying power', ''])).toEqual({
      reqId: 101,
      code: 201,
      message: 'Order rejected - reason:no buying power',
      advanced: '',
    })
  })

  it('execDetails：orderId 在合约之前、合约 11 字段（无 primaryExchange）、orderRef 在 avgPrice 之后（decoder.py:426-475）', () => {
    const x = M.decodeExecDetails([
      '11', '1000002', '101',
      '265598', 'AAPL', 'STK', '', '0', '', '', 'ISLAND', 'USD', 'AAPL', 'NMS',
      '0000e1a7.6713b2c4.01.01', '20261021 10:00:00 US/Eastern', 'DU1234567', 'ISLAND', 'BOT', '10', '100.5', '5001', '7', '0', '10', '100.5',
      REF, '', '', '', '2', '0',
    ])
    expect(x).toMatchObject({
      reqId: 1000002,
      orderId: 101,
      execId: '0000e1a7.6713b2c4.01.01',
      time: '20261021 10:00:00 US/Eastern',
      acctNumber: 'DU1234567',
      side: 'BOT',
      shares: '10',
      price: '100.5',
      permId: 5001,
      clientId: 7,
      cumQty: '10',
      orderRef: REF,
      lastLiquidity: 2,
    })
    expect(x.contract).toMatchObject({ conId: 265598, symbol: 'AAPL', exchange: 'ISLAND', currency: 'USD' })
  })

  it('commissionReport：Double.MAX（未设置）当「没有」，不当数值（decoder.py:573-594；util.py:28）', () => {
    const r = M.decodeCommissionReport(['59', '1', '0000e1a7.6713b2c4.01.01', '1.0', 'USD', '1.7976931348623157E308', '1.7976931348623157E308', '0'])
    expect(r.execId).toBe('0000e1a7.6713b2c4.01.01')
    expect(r.commission).toBe('1')
    expect(r.currency).toBe('USD')
    expect(r.realizedPnl).toBeUndefined()
  })

  it('position = [61, 版本, account, 合约 11 字段, position, avgCost]（decoder.py:596-618）', () => {
    const p = M.decodePosition(['61', '3', 'DU1234567', '265598', 'AAPL', 'STK', '', '0', '', '', 'NASDAQ', 'USD', 'AAPL', 'NMS', '100', '150.25'])
    expect(p).toMatchObject({ account: 'DU1234567', position: '100', avgCost: '150.25' })
    expect(p.contract).toMatchObject({ conId: 265598, symbol: 'AAPL' })
  })

  it('accountSummary = [63, 版本, reqId, account, tag, value, currency]', () => {
    expect(M.decodeAccountSummary(['63', '1', '1000003', 'DU1234567', 'NetLiquidation', '100000.00', 'USD'])).toEqual({
      reqId: 1000003,
      account: 'DU1234567',
      tag: 'NetLiquidation',
      value: '100000.00',
      currency: 'USD',
    })
  })

  it('contractDetails（≥ 164 无版本号；symbol 在前、conId 在第 12 位；科学计数法 minTick；尾部多余字段忽略）（decoder.py:255-344）', () => {
    const hours = '20261021:0400-20261021:2000;20261024:CLOSED'
    const cd = M.decodeContractDetails([
      '10', '1000001', 'AAPL', 'STK', '', '0', '', 'SMART', 'USD', 'AAPL', 'NMS', 'NMS', '265598', '1.0E-4', '',
      'ACTIVETIM,LMT,MKT,STP,STPLMT,TRAIL', 'SMART,NASDAQ,ISLAND', '1', '0', 'APPLE INC', 'NASDAQ', '', 'Technology', 'Computers', 'Computers',
      'US/Eastern', hours, '20261021:0930-20261021:1600;20261024:CLOSED', '', '',
      '1', 'ISIN', 'US0378331005',
      '1', '', '', '26,26', '', 'COMMON', '0.0001', '0.0001', '100',
      'extra-1', 'extra-2',
    ])
    expect(cd.reqId).toBe(1000001)
    expect(cd.contract).toMatchObject({ conId: 265598, symbol: 'AAPL', secType: 'STK', exchange: 'SMART', primaryExchange: 'NASDAQ', currency: 'USD' })
    expect(cd.minTick).toBe('0.0001')
    expect(cd.longName).toBe('APPLE INC')
    expect(cd.timeZoneId).toBe('US/Eastern')
    expect(cd.tradingHours).toBe(hours)
    expect(cd.orderTypes).toContain('TRAIL')
    expect(cd.stockType).toBe('COMMON')
  })

  it('openOrder（无版本号、合约 11 字段、v178 无 faProfile；状态在 algo 段之后；未设价格 Double.MAX → 没有）（decoder.py:882-1147）', () => {
    const fields = [
      '5', '101', '265598', 'AAPL', 'STK', '', '0', '', '', 'SMART', 'USD', 'AAPL', 'NMS',
      'SELL', '10', 'TRAIL', '1.7976931348623157E308', '1.7976931348623157E308', 'GTC', '', 'DU1234567', '', '0', REF, '7', '5001', '0', '0', '0', '', '', '', '', '',
      '', '20261022-20:00:00', '', '', '', '0', '', '-1', '0', '', '', '', '', '', '0', '0', '0', '0', '', '0', '0', '0', '', '0', '0', '', '', '', '',
      '0', '', '99.5', '2', '', '', '', '0', '0', '0', '', '', '',
      '', '0', '', '', '0', '0',
      'Adaptive', '1', 'adaptivePriority', 'Normal',
      '0', '0', 'PreSubmitted', '', '', '', '', '', '', '', '', '', '', '', '', 'USD', '', '0', '0',
      '0', '', '', '99.5', '', '', '', '', '0', '', '', '', '', '0', '0', '0', '0', '', '', '0', '', '', '', '', '',
    ]
    const o = M.decodeOpenOrder(fields)
    expect(o).toMatchObject({
      orderId: 101,
      action: 'SELL',
      totalQuantity: '10',
      orderType: 'TRAIL',
      tif: 'GTC',
      account: 'DU1234567',
      orderRef: REF,
      clientId: 7,
      permId: 5001,
      outsideRth: false,
      goodTillDate: '20261022-20:00:00',
      parentId: 0,
      trailStopPrice: '99.5',
      trailingPercent: '2',
      status: 'PreSubmitted',
    })
    expect(o.lmtPrice).toBeUndefined()
    expect(o.auxPrice).toBeUndefined()
    expect(o.contract).toMatchObject({ conId: 265598, symbol: 'AAPL', exchange: 'SMART' })
  })

  it('tickPrice = [1, 版本, tickerId, tickType, price, size, attrMask]；price -1 = 没有报价', () => {
    expect(M.decodeTickPrice(['1', '6', '1000007', '1', '100.01', '300', '0'])).toMatchObject({ tickerId: 1000007, tickType: 1, price: '100.01' })
    expect(M.decodeTickPrice(['1', '6', '1000007', '2', '-1', '0', '0']).price).toBeUndefined()
  })
})

describe('reference · 假 TWS 侧编码器按参照布局出帧（不许与客户端一起错）', () => {
  it('小消息：nextValidId / managedAccounts / error / *End', () => {
    expect(fieldsOf(M.nextValidId(100))).toEqual(['9', '1', '100'])
    expect(fieldsOf(M.managedAccounts('DU1234567'))).toEqual(['15', '1', 'DU1234567'])
    expect(fieldsOf(M.errMsg(101, 202, 'Order Canceled - reason:'))).toEqual(['4', '2', '101', '202', 'Order Canceled - reason:', ''])
    expect(fieldsOf(M.contractDataEnd(5))).toEqual(['52', '1', '5'])
    expect(fieldsOf(M.openOrderEnd())).toEqual(['53', '1'])
    expect(fieldsOf(M.executionDataEnd(5))).toEqual(['55', '1', '5'])
    expect(fieldsOf(M.tickSnapshotEnd(7))).toEqual(['57', '1', '7'])
    expect(fieldsOf(M.positionEnd())).toEqual(['62', '1'])
    expect(fieldsOf(M.accountSummaryEnd(5))).toEqual(['64', '1', '5'])
    expect(fieldsOf(M.handshakeReply(178, '20261021 09:30:00 EST'))).toEqual(['178', '20261021 09:30:00 EST'])
  })

  it('orderStatus 编码 12 字段、无版本号', () => {
    const f = fieldsOf(M.orderStatusMessage({ orderId: 101, status: 'Submitted', filled: asDecimal('0'), remaining: asDecimal('10'), permId: 5001, parentId: 0, clientId: 7, whyHeld: '' }))
    expect(f).toHaveLength(12)
    expect(f.slice(0, 5)).toEqual(['3', '101', 'Submitted', '0', '10'])
    expect(f[6]).toBe('5001')
    expect(f[9]).toBe('7')
  })

  it('openOrder 编码（无 deltaNeutral / 组合腿 / scale / hedge / algo / 条件）共 127 字段，关键字段落在参照下标', () => {
    const f = fieldsOf(
      M.openOrderMessage({
        orderId: 101,
        contract: AAPL,
        action: 'BUY',
        totalQuantity: asDecimal('10'),
        orderType: 'LMT',
        lmtPrice: asDecimal('100.5'),
        tif: 'DAY',
        ocaGroup: '',
        account: 'DU1234567',
        orderRef: REF,
        clientId: 7,
        permId: 5001,
        outsideRth: false,
        goodTillDate: '',
        parentId: 0,
        status: 'Submitted',
        warningText: '',
      }),
    )
    expect(f).toHaveLength(127)
    expect(f[0]).toBe('5')
    expect(f[1]).toBe('101')
    expect(f.slice(2, 13)).toEqual(['265598', 'AAPL', 'STK', '', '0', '', '', 'SMART', 'USD', '', ''])
    expect(f.slice(13, 19)).toEqual(['BUY', '10', 'LMT', '100.5', '', 'DAY'])
    expect(f[20]).toBe('DU1234567')
    expect(f[23]).toBe(REF)
    expect(f[24]).toBe('7')
    expect(f[25]).toBe('5001')
    expect(f[57]).toBe('0') // parentId
    expect(f[82]).toBe('') // algoStrategy
    expect(f[85]).toBe('Submitted') // status
  })

  it('execDetails 编码 32 字段（v178 含 pendingPriceRevision）、contractDetails 编码按参照下标', () => {
    const x = fieldsOf(
      M.executionDataMessage({
        reqId: 5,
        orderId: 101,
        contract: AAPL,
        execId: 'e1',
        time: '20261021 10:00:00 US/Eastern',
        acctNumber: 'DU1234567',
        exchange: 'ISLAND',
        side: 'BOT',
        shares: asDecimal('10'),
        price: asDecimal('100.5'),
        permId: 5001,
        clientId: 7,
        liquidation: 0,
        cumQty: asDecimal('10'),
        avgPrice: asDecimal('100.5'),
        orderRef: REF,
        lastLiquidity: 1,
      }),
    )
    expect(x).toHaveLength(32)
    expect(x.slice(0, 5)).toEqual(['11', '5', '101', '265598', 'AAPL'])
    expect(x[14]).toBe('e1')
    expect(x[18]).toBe('BOT')
    expect(x[26]).toBe(REF)
    const cd = fieldsOf(
      M.contractDataMessage({
        reqId: 9,
        contract: AAPL,
        marketName: 'NMS',
        minTick: asDecimal('0.01'),
        orderTypes: 'LMT,STP',
        validExchanges: 'SMART',
        longName: 'APPLE INC',
        industry: '',
        category: '',
        timeZoneId: 'US/Eastern',
        tradingHours: 'T',
        liquidHours: 'L',
        stockType: 'COMMON',
      }),
    )
    expect(cd.slice(0, 4)).toEqual(['10', '9', 'AAPL', 'STK'])
    expect(cd[7]).toBe('SMART')
    expect(cd[12]).toBe('265598')
    expect(cd[13]).toBe('0.01')
    expect(cd[19]).toBe('APPLE INC')
    expect(cd[20]).toBe('NASDAQ')
    expect(cd.slice(25, 28)).toEqual(['US/Eastern', 'T', 'L'])
    expect(cd[30]).toBe('0') // secIdList 个数
  })
})
