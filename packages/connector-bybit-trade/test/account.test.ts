// SPDX-License-Identifier: CPAL-1.0
// 账户 / 持仓 / 订单 / 成交 / 私有流的解析与读取器（离线，假服务器）。
// 教训 5（持仓走专用端点）、教训 10（成交号、执行类型、平仓行、可用余额字段）都在这里被钉住。
import { describe, expect, it } from 'vitest'
import {
  fillDedupeKey, isTradeExecution, mapOpenOrderType, parseAccountSnapshot, parseExecution, parseExecutions,
  parseOpenOrder, parseOrderStatusResult, parsePosition, parsePositions, parsePrivateMessage, remainingOf, vwapOf,
} from '../src/parse'
import { BybitAccounts, EXECUTION_PAGE_LIMIT } from '../src/account'
import { asProblem } from '../src/errors'
import { FakeBybitTrade, NOW, envelope } from './helpers/fake-bybit-trade'
import { account, instrumentOf, newHttp } from './helpers/harness'

const acc = 'acc_bybit_1' as Parameters<typeof parseAccountSnapshot>[1]
const rawWallet = () => ({
  accountType: 'UNIFIED',
  totalEquity: '1002.5',
  totalWalletBalance: '1000',
  totalMarginBalance: '1002.5',
  totalInitialMargin: '100',
  totalMaintenanceMargin: '10',
  totalAvailableBalance: '900',
  coin: [
    { coin: 'USDT', walletBalance: '1000', availableToWithdraw: '890', equity: '1002.5' },
    { coin: 'BTC', walletBalance: '0', availableToWithdraw: '0' },
  ],
})

describe('wallet-balance → AccountSnapshot', () => {
  it('可用余额取统一账户的 totalAvailableBalance（900），不是逐币 availableToWithdraw（890）', () => {
    const snap = parseAccountSnapshot(rawWallet(), acc, NOW)
    expect(String(snap.margin.available)).toBe('900')
    expect(String(snap.margin.equity)).toBe('1002.5')
  })

  it('保证金率 = 维持保证金 / 权益（10 / 1002.5）', () => {
    const snap = parseAccountSnapshot(rawWallet(), acc, NOW)
    // 10 / 1002.5 = 0.0099750623…，保留 8 位
    expect(String(snap.margin.marginRatio)).toBe('0.00997506')
  })

  it('余额行带 total / available / hold（1000 − 890 = 110）', () => {
    const snap = parseAccountSnapshot(rawWallet(), acc, NOW)
    const usdt = snap.balances.find((b) => b.asset === 'USDT')!
    expect([String(usdt.total), String(usdt.available), String(usdt.hold)]).toEqual(['1000', '890', '110'])
  })

  it('0 余额的币也保留（BTC 一行），但空 coin 名丢弃', () => {
    const snap = parseAccountSnapshot({ ...rawWallet(), coin: [...rawWallet().coin, { walletBalance: '1' }] }, acc, NOW)
    expect(snap.balances.map((b) => b.asset)).toEqual(['USDT', 'BTC'])
  })

  it('账户模型缺省 unified，valuationCcy 是 USDT，source 是 rest', () => {
    const snap = parseAccountSnapshot(rawWallet(), acc, NOW)
    expect(snap.accountModel).toBe('unified')
    expect(snap.margin.valuationCcy).toBe('USDT')
    expect(snap.source).toBe('rest')
    expect(snap.availableDeductsOpenOrders).toBe(true)
  })

  it('持仓不在这份快照里（由 position/list 单独取，教训 5）', () => {
    expect(parseAccountSnapshot(rawWallet(), acc, NOW).positions).toEqual([])
  })

  it('空响应也给出合法快照（不抛）', () => {
    const snap = parseAccountSnapshot({}, acc, NOW)
    expect(String(snap.margin.equity)).toBe('0')
    expect(snap.balances).toEqual([])
  })
})

describe('position/list → Position', () => {
  const rows = {
    list: [
      { symbol: 'BTCUSDT', side: 'Buy', size: '0.01', avgPrice: '99000', markPrice: '100000', liqPrice: '0', leverage: '10', positionValue: '1000', unrealisedPnl: '10', cumRealisedPnl: '-1.2', tradeMode: 0, createdTime: String(NOW - 60_000), updatedTime: String(NOW - 2_000) },
      { symbol: 'ETHUSDT', side: 'Sell', size: '2.5', avgPrice: '3100', markPrice: '3000', liqPrice: '3900', leverage: '20', positionValue: '7500', unrealisedPnl: '250', cumRealisedPnl: '0', tradeMode: 1, createdTime: String(NOW - 120_000), updatedTime: String(NOW - 3_000) },
      { symbol: 'SOLUSDT', side: '', size: '0', avgPrice: '0', markPrice: '150', liqPrice: '0', leverage: '5', positionValue: '0' },
    ],
  }

  it('只返回非零仓位（零仓槽位丢弃）', () => {
    expect(parsePositions(rows, acc, NOW)).toHaveLength(2)
  })

  it('Buy = long / Sell = short', () => {
    const [long, short] = parsePositions(rows, acc, NOW)
    expect(long!.side).toBe('long')
    expect(short!.side).toBe('short')
  })

  it('size 是正数、notional 优先用 positionValue', () => {
    const [long] = parsePositions(rows, acc, NOW)
    expect(String(long!.size)).toBe('0.01')
    expect(String(long!.notional)).toBe('1000')
  })

  it('tradeMode 1 = isolated，0 = cross', () => {
    const [long, short] = parsePositions(rows, acc, NOW)
    expect(long!.marginMode).toBe('cross')
    expect(short!.marginMode).toBe('isolated')
  })

  it('liqPrice = 0 视为没有强平价（null）', () => {
    const [long, short] = parsePositions(rows, acc, NOW)
    expect(long!.liquidationPrice).toBeNull()
    expect(String(short!.liquidationPrice)).toBe('3900')
  })

  it('leverage / realizedPnl / openedAt / updatedAt 按上游填', () => {
    const [long] = parsePositions(rows, acc, NOW)
    expect(long!.leverage).toBe(10)
    expect(String(long!.realizedPnl)).toBe('-1.2')
    expect(long!.openedAt).toBe(NOW - 60_000)
    expect(long!.updatedAt).toBe(NOW - 2_000)
  })

  it('没有 positionValue 时按 size × markPrice 计算名义额', () => {
    const parsed = parsePosition({ symbol: 'BTCUSDT', side: 'Buy', size: '0.002', markPrice: '100000' }, acc, NOW)
    expect(String(parsed!.notional)).toBe('200')
  })

  it('side 为空但 size 为负 → short（交易所的兼容口径）', () => {
    expect(parsePosition({ symbol: 'BTCUSDT', side: '', size: '-1', markPrice: '100' }, acc, NOW)!.side).toBe('short')
  })

  it('缺 symbol → null；size 0 → null', () => {
    expect(parsePosition({ side: 'Buy', size: '1' }, acc, NOW)).toBeNull()
    expect(parsePosition({ symbol: 'BTCUSDT', side: 'Buy', size: '0' }, acc, NOW)).toBeNull()
  })
})

describe('execution/list → VenueFill（成交号 / 执行类型 / 平仓行）', () => {
  const trade = {
    execId: 'exec-1', orderId: 'ord-1', orderLinkId: 'gt-1', symbol: 'BTCUSDT', side: 'Buy',
    execPrice: '100.1', execQty: '0.006', execFee: '0.0002', feeCurrency: 'USDT', execType: 'Trade',
    execPnl: '0.01', execTime: String(NOW - 500), isMaker: false, closedSize: '0', leavesQty: '0.004',
  }

  it('venueFillId 包含标的命名空间且仍用于去重', () => {
    const fill = parseExecution(trade, NOW)!
    expect(fill.venueFillId).toBe('BTCUSDT:exec-1')
    expect(fillDedupeKey(fill)).toBe('bybit|BTCUSDT:exec-1')
  })

  it('同一 execId 在不同标的上生成不同成交号', () => {
    const fills = ['btcusdt', 'ethusdt'].map((symbol) => parseExecution({ ...trade, symbol, execId: 'exec-shared' }, NOW)!)
    expect(fills.map((fill) => fill.venueFillId)).toEqual(['BTCUSDT:exec-shared', 'ETHUSDT:exec-shared'])
  })

  it('价格 / 数量 / 费用 / 币种 / 流动性 / 盈亏都对字段', () => {
    const fill = parseExecution(trade, NOW)!
    expect([String(fill.price), String(fill.size), String(fill.fee), fill.feeCcy]).toEqual(['100.1', '0.006', '0.0002', 'USDT'])
    expect(fill.liquidity).toBe('taker')
    expect(String(fill.realizedPnl)).toBe('0.01')
    expect(fill.clientOrderId).toBe('gt-1')
    expect(fill.ts).toBe(NOW - 500)
  })

  it('isMaker = true → maker', () => {
    expect(parseExecution({ ...trade, isMaker: true }, NOW)!.liquidity).toBe('maker')
  })

  it('execType = Funding 不是成交（丢弃）', () => {
    expect(parseExecution({ ...trade, execType: 'Funding' }, NOW)).toBeNull()
    expect(isTradeExecution({ execType: 'Funding' })).toBe(false)
  })

  it('execType 缺省按 Trade 处理；除 Funding 外都算成交，BustTrade / AdlTrade 标 liquidation', () => {
    expect(isTradeExecution({})).toBe(true)
    expect(isTradeExecution({ execType: 'AdlTrade' })).toBe(true)
    expect(isTradeExecution({ execType: 'busttrade' })).toBe(true)
    const bust = parseExecution({ ...trade, execType: 'BustTrade' }, NOW)
    expect(bust).not.toBeNull()
    expect(bust!.liquidation).toBe(true)
    const adl = parseExecution({ ...trade, execType: 'AdlTrade' }, NOW)
    expect(adl).not.toBeNull()
    expect(adl!.liquidation).toBe(true)
    expect('liquidation' in parseExecution(trade, NOW)!).toBe(false)
  })

  it('平仓行（closedSize > 0、leavesQty = 0）照样进 fills', () => {
    const closing = parseExecution({ ...trade, execId: 'exec-close', closedSize: '0.006', leavesQty: '0' }, NOW)
    expect(closing).not.toBeNull()
    expect(closing!.venueFillId).toBe('BTCUSDT:exec-close')
  })

  it('fee + extraFees 相加（0.0002 + 0.0001 = 0.0003）', () => {
    const fill = parseExecution({ ...trade, extraFees: [{ feeCoin: 'USDT', fee: '0.0001' }] }, NOW)!
    expect(String(fill.fee)).toBe('0.0003')
  })

  it('缺 execId → null（不合成近似 id）', () => {
    expect(parseExecution({ ...trade, execId: '' }, NOW)).toBeNull()
  })

  it('数量 0 → null', () => {
    expect(parseExecution({ ...trade, execQty: '0' }, NOW)).toBeNull()
  })

  it('execTime 缺失时回落注入时钟', () => {
    expect(parseExecution({ ...trade, execTime: '' }, NOW)!.ts).toBe(NOW)
  })

  it('parseExecutions 过滤 Funding 行并保留顺序', () => {
    const fills = parseExecutions({ list: [trade, { ...trade, execId: 'f-1', execType: 'Funding' }, { ...trade, execId: 'exec-2' }] }, NOW)
    expect(fills.map((f) => f.venueFillId)).toEqual(['BTCUSDT:exec-1', 'BTCUSDT:exec-2'])
  })
})

describe('order/realtime → VenueOpenOrder', () => {
  const limitOrder = {
    orderId: 'ord-2001', orderLinkId: 'gt-open-1', symbol: 'BTCUSDT', side: 'Buy', orderType: 'Limit',
    orderStatus: 'New', price: '99000', qty: '0.01', cumExecQty: '0.004', triggerPrice: '', triggerDirection: 0,
    orderFilter: 'Order', createdAt: NOW,
  }

  it('剩余量 = qty − cumExecQty（0.01 − 0.004 = 0.006）', () => {
    expect(String(parseOpenOrder(limitOrder)!.size)).toBe('0.006')
    expect(String(parseOpenOrder(limitOrder)!.origSize)).toBe('0.01')
  })

  it('限价单：price 有值、triggerPrice 为 null、isTrigger false', () => {
    const parsed = parseOpenOrder(limitOrder)!
    expect(parsed.type).toBe('limit')
    expect(String(parsed.price)).toBe('99000')
    expect(parsed.triggerPrice).toBeNull()
    expect(parsed.isTrigger).toBe(false)
  })

  it('触发单：isTrigger true、reduceOnly 认 closeOnTrigger', () => {
    const parsed = parseOpenOrder({
      orderId: 'ord-2002', symbol: 'ETHUSDT', side: 'Sell', orderType: 'Market', qty: '0.5', cumExecQty: '0',
      triggerPrice: '2800', triggerDirection: 2, orderFilter: 'StopOrder', reduceOnly: true, closeOnTrigger: true,
    })!
    expect(parsed.type).toBe('stop_market')
    expect(parsed.isTrigger).toBe(true)
    expect(parsed.reduceOnly).toBe(true)
    expect(String(parsed.triggerPrice)).toBe('2800')
  })

  it('缺 orderId / symbol → null', () => {
    expect(parseOpenOrder({ symbol: 'BTCUSDT' })).toBeNull()
    expect(parseOpenOrder({ orderId: 'x' })).toBeNull()
  })

  it('mapOpenOrderType：卖出涨破 = 止盈，卖出跌破 = 止损，买入相反', () => {
    expect(mapOpenOrderType('Market', true, 'Sell', 1)).toBe('take_market')
    expect(mapOpenOrderType('Market', true, 'Sell', 2)).toBe('stop_market')
    expect(mapOpenOrderType('Limit', true, 'Sell', 1)).toBe('take_limit')
    expect(mapOpenOrderType('Limit', true, 'Buy', 1)).toBe('stop_limit')
    expect(mapOpenOrderType('Market', true, 'Buy', 2)).toBe('take_market')
    expect(mapOpenOrderType('Limit', false, 'Buy', 0)).toBe('limit')
    expect(mapOpenOrderType('Market', false, 'Buy', 0)).toBe('unknown')
  })

  it('orderStatus 结果原样带上游字符串（不翻译）', () => {
    const status = parseOrderStatusResult({ orderId: 'ord-1', orderStatus: 'PartiallyFilled', cumExecQty: '0.006' })
    expect(status.found).toBe(true)
    expect(status.status).toBe('PartiallyFilled')
    expect(String(status.filledSize)).toBe('0.006')
  })

  it('空行 → found:false', () => {
    expect(parseOrderStatusResult(null).found).toBe(false)
    expect(parseOrderStatusResult({}).found).toBe(false)
  })
})

describe('私有流归一（execId / execType / 平仓行都不丢）', () => {
  const frame = {
    topic: 'execution',
    data: [
      { category: 'linear', symbol: 'BTCUSDT', execId: 'e-1', orderId: 'o-1', orderLinkId: 'gt-1', side: 'Buy', execPrice: '100', execQty: '0.1', execFee: '0.01', execType: 'Trade', execTime: String(NOW), closedSize: '0', leavesQty: '0.9' },
      { category: 'linear', symbol: 'BTCUSDT', execId: 'e-2', orderId: 'o-2', orderLinkId: 'gt-2', side: 'Sell', execPrice: '101', execQty: '0.1', execFee: '0.01', execType: 'Trade', execTime: String(NOW), closedSize: '0.1', leavesQty: '0' },
      { category: 'linear', symbol: 'BTCUSDT', execId: 'e-3', execType: 'Funding', execFee: '-0.02', execTime: String(NOW) },
    ],
  }

  it('两笔 Trade 成交进 fill，Funding 进 unknown（不混进成交）', () => {
    const events = parsePrivateMessage(frame, NOW)
    expect(events.filter((e) => e.kind === 'fill')).toHaveLength(2)
    expect(events.filter((e) => e.kind === 'unknown')).toHaveLength(1)
  })

  it('fill 保留 execType，并标出平仓行', () => {
    const fills = parsePrivateMessage(frame, NOW).filter((e) => e.kind === 'fill') as Array<{ fill: { execType: string; closing: boolean; venueFillId: string } }>
    expect(fills[0]!.fill.execType).toBe('Trade')
    expect(fills[0]!.fill.closing).toBe(false)
    expect(fills[1]!.fill.closing).toBe(true)
    expect(fills[1]!.fill.venueFillId).toBe('BTCUSDT:e-2')
  })

  it('私有流的 BustTrade 帧进 fill，保留 execType 并标 closing / liquidation', () => {
    const events = parsePrivateMessage({
      topic: 'execution',
      data: [{
        category: 'linear', symbol: 'BTCUSDT', execId: 'e-bust', orderId: 'o-3', orderLinkId: 'gt-3',
        side: 'Sell', execPrice: '90', execQty: '0.1', execFee: '0.01', execType: 'BustTrade',
        execTime: String(NOW), closedSize: '0.1', leavesQty: '0',
      }],
    }, NOW)
    expect(events).toHaveLength(1)
    const fill = events[0] as { kind: string; fill: { execType: string; closing: boolean; liquidation?: boolean } }
    expect(fill.kind).toBe('fill')
    expect(fill.fill.execType).toBe('BustTrade')
    expect(fill.fill.closing).toBe(true)
    expect(fill.fill.liquidation).toBe(true)
  })

  it('私有流按 category 过滤：spot / option 的整行跳过，linear 与缺省照常', () => {
    const tradeRow = { symbol: 'BTCUSDT', execId: 'e-cat', orderId: 'o-1', side: 'Buy', execPrice: '100', execQty: '0.1', execFee: '0', execType: 'Trade', execTime: String(NOW) }
    expect(parsePrivateMessage({ topic: 'execution', data: [{ category: 'spot', ...tradeRow }] }, NOW)).toEqual([])
    expect(parsePrivateMessage({ topic: 'execution', data: [{ category: 'linear', ...tradeRow }] }, NOW)[0]).toMatchObject({ kind: 'fill' })
    expect(parsePrivateMessage({ topic: 'order', data: [{ category: 'option', symbol: 'BTC-27DEC24-80000-C', orderId: 'x' }] }, NOW)).toEqual([])
    expect(parsePrivateMessage({ topic: 'position', data: [{ category: 'option', symbol: 'BTC-27DEC24-80000-C', size: '1' }] }, NOW)).toEqual([])
  })

  it('order 主题 → 订单状态更新', () => {
    const events = parsePrivateMessage({ topic: 'order', data: [{ symbol: 'BTCUSDT', orderId: 'o-9', orderLinkId: 'gt-9', orderStatus: 'Filled', updatedTime: String(NOW) }] }, NOW)
    expect(events[0]).toEqual({ kind: 'order', update: { venueOrderId: 'o-9', clientOrderId: 'gt-9', instrumentId: 'bybit:BTCUSDT', status: 'Filled', ts: NOW } })
  })

  it('position 主题 → 持仓事件（side / size 均为绝对量）', () => {
    const events = parsePrivateMessage({ topic: 'position', data: [{ symbol: 'ETHUSDT', side: 'Sell', size: '-2.5', updatedTime: String(NOW) }] }, NOW)
    expect(events[0]).toMatchObject({ kind: 'position', instrumentId: 'bybit:ETHUSDT', side: 'short' })
  })

  it('wallet 主题 → wallet 事件', () => {
    const events = parsePrivateMessage({ topic: 'wallet', data: [{ accountType: 'UNIFIED' }] }, NOW)
    expect(events[0]).toMatchObject({ kind: 'wallet', accountType: 'UNIFIED' })
  })

  it('pong / auth / subscribe 的 ack 各归各类', () => {
    expect(parsePrivateMessage({ op: 'pong' }, NOW)[0]).toEqual({ kind: 'pong' })
    expect(parsePrivateMessage({ op: 'auth', success: true }, NOW)[0]).toMatchObject({ kind: 'subscribed', topic: 'auth' })
    expect(parsePrivateMessage({ op: 'subscribe', success: false }, NOW)[0]).toMatchObject({ kind: 'subscribed', success: false })
  })

  it('未知主题 / 非对象输入都回 unknown 或空数组（不抛）', () => {
    expect(parsePrivateMessage({ topic: 'weird', data: [] }, NOW)[0]).toMatchObject({ kind: 'unknown' })
    expect(parsePrivateMessage(null, NOW)).toEqual([])
    expect(parsePrivateMessage('x', NOW)).toEqual([])
  })
})

describe('辅助：剩余量与加权均价', () => {
  it('remainingOf 走定点减法（0.01 − 0.004 = 0.006）', () => {
    expect(String(remainingOf('0.01', '0.004'))).toBe('0.006')
  })

  it('已成交量超过委托量时按 0 处理（不出现负数）', () => {
    expect(Number(remainingOf('0.01', '0.02'))).toBeLessThanOrEqual(0.01)
  })

  it('vwapOf：0.006@100 + 0.004@200 = 140', () => {
    expect(String(vwapOf([{ price: '100', size: '0.006' }, { price: '200', size: '0.004' }]))).toBe('140')
  })

  it('vwapOf 空数组 → null', () => {
    expect(vwapOf([])).toBeNull()
  })
})

describe('BybitAccounts 读取器（对假服务器）', () => {
  const reader = (fake: FakeBybitTrade) =>
    new BybitAccounts({ http: newHttp(fake), clock: () => NOW, instrumentOf: (id) => instrumentOf(id) })

  it('accountState 合并 wallet 与 position/list', async () => {
    const fake = new FakeBybitTrade()
    const snap = await reader(fake).accountState(account())
    expect(String(snap.margin.available)).toBe('900')
    expect(snap.positions).toHaveLength(2)
    expect(fake.callsTo('/v5/position/list')[0]!.params.get('settleCoin')).toBe('USDT')
  })

  it('positions 可按 instrumentId 过滤（走 symbol 参数）', async () => {
    const fake = new FakeBybitTrade()
    const positions = await reader(fake).positions(account(), 'bybit:BTCUSDT')
    expect(positions).toHaveLength(1)
    expect(fake.last()!.params.get('symbol')).toBe('BTCUSDT')
  })

  it('openOrders 不给标的时按 settleCoin 拉全量', async () => {
    const fake = new FakeBybitTrade()
    const orders = await reader(fake).openOrders(account())
    expect(orders.length).toBe(2)
    expect(fake.last()!.params.get('settleCoin')).toBe('USDT')
  })

  it('openOrders 给标的时按 symbol 拉', async () => {
    const fake = new FakeBybitTrade()
    const orders = await reader(fake).openOrders(account(), 'bybit:ETHUSDT')
    expect(orders.every((o) => o.instrumentId === 'bybit:ETHUSDT')).toBe(true)
    expect(fake.last()!.params.get('symbol')).toBe('ETHUSDT')
  })

  it('openOrders 按 orderId 去重（游标回同一页不会出现两张）', async () => {
    const fake = new FakeBybitTrade()
    fake.failWith.set('GET /v5/order/realtime', () => envelope({
      list: [{
        orderId: 'dup-1', orderLinkId: 'gt-dup-1', symbol: 'BTCUSDT', side: 'Buy', orderType: 'Limit',
        orderStatus: 'New', price: '100', qty: '0.1', createdTime: String(NOW), updatedTime: String(NOW),
      }],
      nextPageCursor: 'same',
    }))
    const orders = await reader(fake).openOrders(account())
    expect(orders).toHaveLength(1)
    expect(fake.callsTo('/v5/order/realtime')).toHaveLength(2)
  })

  it('orderStatus 不给 symbol 时按 settleCoin 查，不再用 defaultSymbol', async () => {
    const fake = new FakeBybitTrade()
    fake.realtimeOrders = [{ orderId: 'ord-eth', orderLinkId: 'gt-eth-1', symbol: 'ETHUSDT', orderStatus: 'New' }]
    const readerWithDefault = new BybitAccounts({
      http: newHttp(fake), clock: () => NOW, instrumentOf: (id) => instrumentOf(id),
      options: { defaultSymbol: 'BTCUSDT' },
    })
    const status = await readerWithDefault.orderStatus(account(), { clientOrderId: 'gt-eth-1' })
    expect(status.found).toBe(true)
    const params = fake.callsTo('/v5/order/realtime')[0]!.params
    expect(params.get('settleCoin')).toBe('USDT')
    expect(params.has('symbol')).toBe(false)
  })

  it('orderStatus 先打 realtime，命中即返回', async () => {
    const fake = new FakeBybitTrade()
    const status = await reader(fake).orderStatus(account(), { clientOrderId: 'gt-query' }, { symbol: 'BTCUSDT' })
    expect(status.found).toBe(true)
    expect(fake.callsTo('/v5/order/history')).toHaveLength(0)
  })

  it('orderStatus 在 realtime 空结果时回退 history（照 QD）', async () => {
    const fake = new FakeBybitTrade()
    fake.historyOrders = [{ orderId: 'ord-old', orderLinkId: 'gt-old', symbol: 'BTCUSDT', orderStatus: 'Filled', cumExecQty: '0.1' }]
    const status = await reader(fake).orderStatus(account(), { clientOrderId: 'gt-old' }, { symbol: 'BTCUSDT' })
    expect(status.found).toBe(true)
    expect(status.status).toBe('Filled')
    expect(fake.callsTo('/v5/order/history')).toHaveLength(1)
  })

  it('orderStatus 两处都没找到 → found:false（不是错误）', async () => {
    const fake = new FakeBybitTrade()
    const status = await reader(fake).orderStatus(account(), { venueOrderId: 'ord-missing' }, { symbol: 'BTCUSDT' })
    expect(status.found).toBe(false)
  })

  it('orderStatus 两个 id 都没给 → INVALID_PARAMS', async () => {
    const fake = new FakeBybitTrade()
    const err = await reader(fake).orderStatus(account(), {}).catch((e: unknown) => e)
    expect(asProblem(err).name).toBe('INVALID_PARAMS')
  })

  it('fills 走 execution/list，Funding 行被过滤、按 execId 去重', async () => {
    const fake = new FakeBybitTrade()
    const fills = await reader(fake).fills(account(), NOW - 60_000)
    expect(fills.map((f) => f.venueFillId)).toEqual(['BTCUSDT:exec-1', 'BTCUSDT:exec-2', 'BTCUSDT:exec-3'])
    expect(fake.last()!.params.get('limit')).toBe(String(EXECUTION_PAGE_LIMIT))
  })

  it('fills 按游标翻页并去重（第二页与第一页重叠）', async () => {
    const fake = new FakeBybitTrade()
    const first = fake.executions.slice(0, 2)
    fake.executionPages = [
      { list: first, nextPageCursor: 'page-2' },
      { list: [first[1], fake.executions[2]], nextPageCursor: '' },
    ]
    const fills = await reader(fake).fills(account(), NOW - 60_000)
    expect(fills.map((f) => f.venueFillId)).toEqual(['BTCUSDT:exec-1', 'BTCUSDT:exec-2', 'BTCUSDT:exec-3'])
    expect(fake.callsTo('/v5/execution/list')).toHaveLength(2)
  })

  it('fills 带 startTime / endTime / symbol 参数', async () => {
    const fake = new FakeBybitTrade()
    await reader(fake).fills(account(), NOW - 1_000, { symbol: 'ethusdt', limit: 20 })
    const params = fake.last()!.params
    expect(params.get('symbol')).toBe('ETHUSDT')
    expect(params.get('startTime')).toBe(String(NOW - 1_000))
    expect(params.get('endTime')).toBe(String(NOW))
    expect(params.get('limit')).toBe('20')
  })

  it('fills 按 7 天窗口切开：回看 10 天 = 两个请求', async () => {
    const fake = new FakeBybitTrade()
    const tenDays = 10 * 86_400_000
    await reader(fake).fills(account(), NOW - tenDays)
    const calls = fake.callsTo('/v5/execution/list')
    expect(calls).toHaveLength(2)
    expect(calls[0]!.params.get('startTime')).toBe(String(NOW - tenDays))
    expect(calls[0]!.params.get('endTime')).toBe(String(NOW - 3 * 86_400_000))
    expect(calls[1]!.params.get('startTime')).toBe(String(NOW - 3 * 86_400_000))
    expect(calls[1]!.params.get('endTime')).toBe(String(NOW))
  })

  it('fills 超过 13 周 → INVALID_PARAMS；startupSnapshot 只标 truncated', async () => {
    const fake = new FakeBybitTrade()
    const tooOld = NOW - 100 * 86_400_000
    const err = await reader(fake).fills(account(), tooOld).catch((e: unknown) => e)
    expect(asProblem(err).name).toBe('INVALID_PARAMS')
    const snap = await reader(fake).startupSnapshot(account(), tooOld)
    expect(snap.truncated).toBe(true)
  })

  it('挂单翻页：25 张 + pageSize 10 → 3 次请求、limit=50、合并 25 张', async () => {
    const fake = new FakeBybitTrade()
    fake.openOrders = Array.from({ length: 25 }, (_, i) => ({
      orderId: `ord-page-${i}`, orderLinkId: `gt-page-${i}`, symbol: 'BTCUSDT', side: 'Buy', orderType: 'Limit',
      orderStatus: 'New', price: '99000', qty: '0.01', cumExecQty: '0', createdTime: String(NOW),
    }))
    fake.pageSize = 10
    const orders = await reader(fake).openOrders(account())
    const calls = fake.callsTo('/v5/order/realtime')
    expect(orders).toHaveLength(25)
    expect(calls).toHaveLength(3)
    expect(calls[0]!.params.get('limit')).toBe('50')
  })

  it('持仓翻页：3 条非零 + pageSize 2 → 合并 3 条、limit=200', async () => {
    const fake = new FakeBybitTrade()
    fake.positions = {
      category: 'linear',
      list: [
        { symbol: 'BTCUSDT', side: 'Buy', size: '0.01', markPrice: '100000', leverage: '10', tradeMode: 0 },
        { symbol: 'ETHUSDT', side: 'Sell', size: '2.5', markPrice: '3000', leverage: '20', tradeMode: 1 },
        { symbol: 'SOLUSDT', side: 'Buy', size: '3', markPrice: '150', leverage: '5', tradeMode: 0 },
      ],
    }
    fake.pageSize = 2
    const positions = await reader(fake).positions(account())
    const calls = fake.callsTo('/v5/position/list')
    expect(positions).toHaveLength(3)
    expect(calls[0]!.params.get('limit')).toBe('200')
  })

  it('翻页超过 20 页仍有游标 → VENUE_UNAVAILABLE，不交半张清单', async () => {
    const fake = new FakeBybitTrade()
    fake.openOrders = Array.from({ length: 25 }, (_, i) => ({
      orderId: `ord-many-${i}`, orderLinkId: `gt-many-${i}`, symbol: 'BTCUSDT', side: 'Buy', orderType: 'Limit',
      orderStatus: 'New', price: '99000', qty: '0.01', cumExecQty: '0', createdTime: String(NOW),
    }))
    fake.pageSize = 1
    const err = await reader(fake).openOrders(account()).catch((e: unknown) => e)
    const problem = asProblem(err)
    expect(problem.code).toBe(3003)
    expect(problem.retryable).toBe(false)
  })

  it('startupSnapshot = 账户 + 挂单 + 成交（按持仓 ∪ 挂单的标的逐个拉）', async () => {
    const fake = new FakeBybitTrade()
    const snap = await reader(fake).startupSnapshot(account(), NOW - 60_000)
    expect(snap.account.positions).toHaveLength(2)
    expect(snap.openOrders.length).toBe(2)
    expect(snap.fills.length).toBeGreaterThan(0)
    expect(snap.fillsSince).toBe(NOW - 60_000)
    expect(snap.truncated).toBe(false)
    expect(fake.callsTo('/v5/execution/list').length).toBeGreaterThanOrEqual(2)
  })

  it('knows / instrument 走本地标的记录（不发请求）', () => {
    const fake = new FakeBybitTrade()
    const r = reader(fake)
    expect(r.knows('bybit:BTCUSDT')).toBe(true)
    expect(r.knows('bybit:NOPE')).toBe(false)
    expect(fake.calls).toHaveLength(0)
  })

  it('wallet 读失败 → ProblemError（带 Problem，不吞）', async () => {
    const fake = new FakeBybitTrade()
    fake.fail('GET', '/v5/account/wallet-balance', 10005, 'permission denied')
    const err = await reader(fake).accountState(account()).catch((e: unknown) => e)
    expect(asProblem(err).code).toBe(3005)
  })
})
