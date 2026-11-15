// SPDX-License-Identifier: CPAL-1.0
// 交易：submit / cancel / cancelAll / amend / 3006 对账 / 持仓闸门。全部经真 socket 打假 TWS。
import { afterEach, describe, expect, it } from 'vitest'
import { asDecimal } from '@gitrader/protocol'
import type { OrderIntent } from '@gitrader/protocol'
import { ackStatusOf } from '../src/trading'
import * as M from '../src/messages'
import type { IbOpenOrder } from '../src/messages'
import { makeHarness, tick } from './helpers/harness'
import type { Harness } from './helpers/harness'

let h: Harness | undefined

afterEach(async () => {
  if (h !== undefined) await h.close()
  h = undefined
})

function intent(over: Partial<OrderIntent> = {}): OrderIntent {
  return {
    accountId: 'acct_ibkr_paper' as OrderIntent['accountId'],
    instrumentId: 'ibkr:AAPL',
    side: 'buy',
    type: 'limit',
    size: asDecimal('10'),
    price: asDecimal('100.5'),
    clientOrderId: 'a1b2c3d4e5f60718293a4b5c6d7e8f90' as OrderIntent['clientOrderId'],
    ...over,
  }
}

function foreignOrder(over: Partial<IbOpenOrder> = {}): IbOpenOrder {
  return {
    orderId: 900,
    contract: M.stockContract('AAPL'),
    action: 'BUY',
    totalQuantity: asDecimal('10'),
    orderType: 'LMT',
    lmtPrice: asDecimal('100'),
    tif: 'DAY',
    ocaGroup: '',
    account: 'DU1234567',
    orderRef: 'manual-order',
    clientId: 0,
    permId: 9001,
    outsideRth: false,
    goodTillDate: '',
    parentId: 0,
    status: 'Submitted',
    warningText: '',
    ...over,
  }
}

describe('trading · 下单回执', () => {
  it('限价单：ack=open，带 permId；发出去的是 LMT / DAY / 整数股 / 确定 orderRef', async () => {
    h = await makeHarness()
    const res = await h.connector.submit(h.ctx, [intent()])
    expect(res.acks).toHaveLength(1)
    const ack = res.acks[0]!
    expect(ack.status).toBe('open')
    expect(ack.clientOrderId).toBe('a1b2c3d4e5f60718293a4b5c6d7e8f90')
    expect(ack.venueOrderId).not.toBeNull()
    expect(ack.filledSize).toBe('0')
    expect(ack.avgFillPrice).toBeNull()
    expect(res.receiptHash).toMatch(/^[0-9a-f]{64}$/)
    const sent = h.tws.ordersReceived()[0]!
    expect(sent.orderType).toBe('LMT')
    expect(sent.tif).toBe('DAY')
    expect(sent.totalQuantity).toBe('10')
    expect(sent.orderRef).toBe('a1b2c3d4e5f60718293a4b5c6d7e8f90')
    expect(sent.account).toBe('DU1234567')
    expect(sent.transmit).toBe(true)
  })

  it('成交回执：status=filled，带成交量与均价', async () => {
    h = await makeHarness({ tws: { orderBehaviour: 'fill' } })
    const res = await h.connector.submit(h.ctx, [intent()])
    const ack = res.acks[0]!
    expect(ack.status).toBe('filled')
    expect(ack.filledSize).toBe('10')
    expect(ack.avgFillPrice).toBe('100.5')
  })

  it('场所拒单（201）：ack=rejected + Problem 3001 + IB 原文', async () => {
    h = await makeHarness({ tws: { orderBehaviour: 'reject', rejectReason: 'Order rejected - reason:no buying power' } })
    const res = await h.connector.submit(h.ctx, [intent()])
    const ack = res.acks[0]!
    expect(ack.status).toBe('rejected')
    expect(ack.problem?.code).toBe(3001)
    expect(ack.problem?.venue?.code).toBe(201)
    expect(ack.problem?.venue?.message).toContain('no buying power')
  })

  it('本地裁定不过（碎股）：不发任何下单帧，ack=rejected 1002', async () => {
    h = await makeHarness()
    const res = await h.connector.submit(h.ctx, [intent({ size: asDecimal('1.5') })])
    expect(res.acks[0]!.status).toBe('rejected')
    expect(res.acks[0]!.problem?.code).toBe(1002)
    expect(h.tws.frames(M.OUT.PLACE_ORDER)).toHaveLength(0)
  })

  it('市价意图：发 LMT + IOC，价格 = 参考价 + 滑点（裸市价从不发出）', async () => {
    h = await makeHarness({ tws: { quote: { bid: 100, ask: 100, last: 100 } } })
    await h.connector.refreshQuote('ibkr:AAPL')
    const res = await h.connector.submit(h.ctx, [intent({ type: 'market', price: undefined, maxSlippageBps: 50 })])
    expect(res.acks[0]!.status).toBe('open')
    const sent = h.tws.ordersReceived()[0]!
    expect(sent.orderType).toBe('LMT')
    expect(sent.tif).toBe('IOC')
    expect(sent.lmtPrice).toBe('100.5')
  })

  it('无行情权限的市价意图：不到场所，直接拒单（2007）', async () => {
    h = await makeHarness({ tws: { quote: null } })
    const q = await h.connector.refreshQuote('ibkr:AAPL')
    expect(q).toBeUndefined()
    const res = await h.connector.submit(h.ctx, [intent({ type: 'market', price: undefined, maxSlippageBps: 50 })])
    expect(res.acks[0]!.status).toBe('rejected')
    expect(res.acks[0]!.problem?.code).toBe(2007)
    expect(h.tws.frames(M.OUT.PLACE_ORDER)).toHaveLength(0)
  })

  it('STP 回 PreSubmitted → ack=open（不是 3006）', async () => {
    h = await makeHarness()
    const res = await h.connector.submit(h.ctx, [intent({ type: 'stop_market', price: undefined, triggerPrice: asDecimal('95') })])
    expect(res.acks[0]!.status).toBe('open')
    expect(res.acks[0]!.problem).toBeUndefined()
  })

  it('IOC 部分成交后 Cancelled → ack=open 且 filledSize 带上', async () => {
    h = await makeHarness({ tws: { orderBehaviour: 'partial-cancel' } })
    const res = await h.connector.submit(h.ctx, [intent({ tif: 'ioc' })])
    expect(res.acks[0]!.status).toBe('open')
    expect(res.acks[0]!.filledSize).toBe('1')
  })

  it('IOC 部分成交（同一包 status Cancelled + error 202）→ ack=open 且 filledSize=一半', async () => {
    h = await makeHarness({ tws: { orderBehaviour: 'ioc-partial', quote: { bid: 100, ask: 100, last: 100 } } })
    await h.connector.refreshQuote('ibkr:AAPL')
    const res = await h.connector.submit(h.ctx, [intent({ type: 'market', price: undefined, maxSlippageBps: 50 })])
    expect(res.acks[0]!.status).toBe('open')
    expect(res.acks[0]!.filledSize).toBe('5')
    expect(res.acks[0]!.problem).toBeUndefined()
  })

  it('警告类 2109 / 404 推到正在等回执的单：不判 3006，单正常 open', async () => {
    h = await makeHarness({ tws: { warningsBeforeAck: [2109, 404] } })
    const res = await h.connector.submit(h.ctx, [intent()])
    expect(res.acks[0]!.status).toBe('open')
    expect(res.acks[0]!.problem).toBeUndefined()
  })

  it('bracket：父 + 止盈 + 止损三腿，父单不发、最后一张子单才 transmit', async () => {
    h = await makeHarness()
    const res = await h.connector.submit(h.ctx, [
      intent({
        tpsl: { takeProfit: { triggerPrice: asDecimal('120'), price: asDecimal('120') }, stopLoss: { triggerPrice: asDecimal('90') }, grouping: 'order' },
      }),
    ])
    expect(res.acks.map((a) => a.role)).toEqual(['parent', 'tp', 'sl'])
    expect(res.acks[0]!.status).toBe('open')
    expect(res.acks[1]!.status).toBe('untriggered')
    expect(res.acks[2]!.status).toBe('untriggered')
    expect(res.acks[1]!.venueOrderId).not.toBeNull()
    expect(res.acks[2]!.venueOrderId).not.toBeNull()
    expect(res.acks[1]!.clientOrderId).toBe(res.acks[0]!.clientOrderId)
    const sent = h.tws.ordersReceived()
    expect(sent).toHaveLength(3)
    expect(sent[0]!.transmit).toBe(false)
    expect(sent[1]!.transmit).toBe(false)
    expect(sent[2]!.transmit).toBe(true)
    expect(sent[1]!.parentId).toBe(sent[0]!.orderId)
    expect(sent[1]!.orderRef.endsWith('#tp')).toBe(true)
    expect(sent[2]!.orderRef.endsWith('#sl')).toBe(true)
  })

  it('bracket 三腿 orderId 为 N / N+1 / N+2，子单 parentId = N', async () => {
    h = await makeHarness({ tws: { startOrderId: 700 } })
    await h.connector.submit(h.ctx, [
      intent({ tpsl: { takeProfit: { triggerPrice: asDecimal('120'), price: asDecimal('120') }, stopLoss: { triggerPrice: asDecimal('90') }, grouping: 'order' } }),
    ])
    const sent = h.tws.ordersReceived()
    expect(sent.map((o) => o.orderId)).toEqual([700, 701, 702])
    expect(sent.map((o) => o.parentId)).toEqual([0, 700, 700])
  })

  it('bracket 子单不回执（silentChildren）：父 open，子 untriggered + venueOrderId null，无 3006', async () => {
    h = await makeHarness({ connector: { ackTimeoutMs: 300 }, tws: { silentChildren: true } })
    const res = await h.connector.submit(h.ctx, [
      intent({ tpsl: { takeProfit: { triggerPrice: asDecimal('120'), price: asDecimal('120') }, stopLoss: { triggerPrice: asDecimal('90') }, grouping: 'order' } }),
    ])
    expect(res.acks[0]!.status).toBe('open')
    expect(res.acks[1]!.status).toBe('untriggered')
    expect(res.acks[1]!.venueOrderId).toBeNull()
    expect(res.acks[2]!.status).toBe('untriggered')
    expect(res.acks[2]!.venueOrderId).toBeNull()
    expect(h.connector.trading.unknownOrders()).toHaveLength(0)
  })

  it('同一次 submit 的两张意图号不重叠；假 TWS 收到的 orderId 全不相同', async () => {
    h = await makeHarness({ tws: { startOrderId: 700 } })
    await h.connector.submit(h.ctx, [
      intent({ tpsl: { takeProfit: { triggerPrice: asDecimal('120'), price: asDecimal('120') }, stopLoss: { triggerPrice: asDecimal('90') }, grouping: 'order' } }),
      intent({ clientOrderId: 'ffeeddccbbaa99887766554433221100' as OrderIntent['clientOrderId'] }),
    ])
    const ids = h.tws.ordersReceived().map((o) => o.orderId)
    expect(ids).toEqual([700, 701, 702, 703])
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('两张意图一次提交：各自 ack，索引正确', async () => {
    h = await makeHarness()
    const res = await h.connector.submit(h.ctx, [intent(), intent({ side: 'buy', price: asDecimal('101'), clientOrderId: 'b1b2c3d4e5f60718293a4b5c6d7e8f90' as OrderIntent['clientOrderId'] })])
    expect(res.acks.map((a) => a.intentIndex)).toEqual([0, 1])
    expect(h.tws.frames(M.OUT.PLACE_ORDER)).toHaveLength(2)
  })

  it('orderId 由服务端 nextValidId 发号（客户端不自己编号）', async () => {
    h = await makeHarness({ tws: { startOrderId: 700 } })
    await h.connector.submit(h.ctx, [intent()])
    expect(h.tws.ordersReceived()[0]!.orderId).toBe(700)
    await h.connector.submit(h.ctx, [intent({ clientOrderId: 'ffeeddccbbaa99887766554433221100' as OrderIntent['clientOrderId'] })])
    expect(h.tws.ordersReceived()[1]!.orderId).toBe(701)
  })
})

describe('trading · 持仓闸门（不用缓存）', () => {
  it('持仓 100、先卖 100（accept 不成交）、再卖 100 → 第二张拒', async () => {
    h = await makeHarness({ tws: { positions: [{ symbol: 'AAPL', position: 100, avgCost: 90 }] } })
    const first = await h.connector.submit(h.ctx, [intent({ side: 'sell', size: asDecimal('100'), price: asDecimal('101') })])
    expect(first.acks[0]!.status).toBe('open')
    const second = await h.connector.submit(h.ctx, [intent({ side: 'sell', size: asDecimal('100'), price: asDecimal('101'), clientOrderId: 'c1b2c3d4e5f60718293a4b5c6d7e8f90' as OrderIntent['clientOrderId'] })])
    expect(second.acks[0]!.status).toBe('rejected')
    expect(h.tws.frames(M.OUT.PLACE_ORDER)).toHaveLength(1)
  })

  it('挂单列表在途时提交卖单：串行化后仍看到在场 SELL，第二张拒', async () => {
    h = await makeHarness({ tws: { positions: [{ symbol: 'AAPL', position: 100, avgCost: 90 }], openOrdersDelayMs: 80 } })
    const first = await h.connector.submit(h.ctx, [intent({ side: 'sell', size: asDecimal('100'), price: asDecimal('101') })])
    expect(first.acks[0]!.status).toBe('open')
    await h.connector.submit(h.ctx, [intent({ side: 'buy', size: asDecimal('10'), price: asDecimal('99'), clientOrderId: 'b1b2c3d4e5f60718293a4b5c6d7e8f90' as OrderIntent['clientOrderId'] })])
    const pending = h.connector.openOrders(h.ref)
    await tick(20)
    const second = await h.connector.submit(h.ctx, [intent({ side: 'sell', size: asDecimal('100'), price: asDecimal('101'), clientOrderId: 'c1b2c3d4e5f60718293a4b5c6d7e8f90' as OrderIntent['clientOrderId'] })])
    expect(second.acks[0]!.status).toBe('rejected')
    await pending
  })

  it('持仓 100、卖 60 再卖 40 → 都过', async () => {
    h = await makeHarness({ tws: { positions: [{ symbol: 'AAPL', position: 100, avgCost: 90 }] } })
    const a = await h.connector.submit(h.ctx, [intent({ side: 'sell', size: asDecimal('60'), price: asDecimal('101') })])
    const b = await h.connector.submit(h.ctx, [intent({ side: 'sell', size: asDecimal('40'), price: asDecimal('101'), clientOrderId: 'd1b2c3d4e5f60718293a4b5c6d7e8f90' as OrderIntent['clientOrderId'] })])
    expect(a.acks[0]!.status).toBe('open')
    expect(b.acks[0]!.status).toBe('open')
    expect(h.tws.frames(M.OUT.PLACE_ORDER)).toHaveLength(2)
  })

  it('零持仓 reduceOnly 卖 → 拒且不发帧', async () => {
    h = await makeHarness()
    const res = await h.connector.submit(h.ctx, [intent({ side: 'sell', reduceOnly: true })])
    expect(res.acks[0]!.status).toBe('rejected')
    expect(res.acks[0]!.problem?.code).toBe(-32602)
    expect(h.tws.frames(M.OUT.PLACE_ORDER)).toHaveLength(0)
  })

  it('持仓 100 reduceOnly 卖 100 → 发出且 openClose 字段为空', async () => {
    h = await makeHarness({ tws: { positions: [{ symbol: 'AAPL', position: 100, avgCost: 90 }] } })
    const res = await h.connector.submit(h.ctx, [intent({ side: 'sell', size: asDecimal('100'), reduceOnly: true, price: asDecimal('101') })])
    expect(res.acks[0]!.status).toBe('open')
    expect(h.tws.frames(M.OUT.PLACE_ORDER)[0]!.fields[24]).toBe('')
  })

  it('另一账户的持仓不能给本账户的卖出放行', async () => {
    h = await makeHarness({
      connector: { account: 'DU1' },
      tws: { accounts: ['DU1', 'DU2'], positions: [{ symbol: 'AAPL', position: 100, avgCost: 90, account: 'DU2' }] },
    })
    const res = await h.connector.submit(h.ctx, [intent({ side: 'sell', size: asDecimal('100') })])
    expect(res.acks[0]!.status).toBe('rejected')
    expect(h.tws.frames(M.OUT.PLACE_ORDER)).toHaveLength(0)
  })
})

describe('trading · 「结果未知」（3006）与对账', () => {
  it('发出了但没有任何状态 → ack=unknown + 3006（不可重试）', async () => {
    h = await makeHarness({ tws: { orderBehaviour: 'silent' } })
    const res = await h.connector.submit(h.ctx, [intent()])
    const ack = res.acks[0]!
    expect(ack.status).toBe('unknown')
    expect(ack.problem?.code).toBe(3006)
    expect(ack.problem?.retryable).toBe(false)
    expect(ack.problem?.message).toContain('orderRef')
    expect(h.connector.trading.unknownOrders()).toHaveLength(1)
    expect(h.tws.frames(M.OUT.PLACE_ORDER)).toHaveLength(1)
  })

  it('3006 后按 orderRef 经挂单 + 成交查询对账（不重发）', async () => {
    h = await makeHarness({ tws: { orderBehaviour: 'silent' } })
    await h.connector.submit(h.ctx, [intent()])
    const r = await h.connector.reconcile('a1b2c3d4e5f60718293a4b5c6d7e8f90', h.ref)
    expect(r.found).toBe(true)
    expect(r.status).toBe('Submitted')
    expect(r.venueOrderId).toBeDefined()
    expect(h.connector.trading.unknownOrders()).toHaveLength(0)
    expect(h.tws.frames(M.OUT.PLACE_ORDER)).toHaveLength(1)
  })

  it('下单后连接断开（没有任何状态）→ ack=unknown + 3006', async () => {
    h = await makeHarness({ tws: { orderBehaviour: 'drop-after-order' } })
    const res = await h.connector.submit(h.ctx, [intent()])
    expect(res.acks[0]!.status).toBe('unknown')
    expect(res.acks[0]!.problem?.code).toBe(3006)
    expect(h.connector.session.connected).toBe(false)
  })

  it('对账查不到 → found:false（不编状态）', async () => {
    h = await makeHarness()
    const r = await h.connector.reconcile('ffffffffffffffffffffffffffffffff', h.ref)
    expect(r.found).toBe(false)
  })

  it('reconcileUnknown 把在册的未知单全部跑一遍', async () => {
    h = await makeHarness({ tws: { orderBehaviour: 'silent' } })
    await h.connector.submit(h.ctx, [intent()])
    const list = await h.connector.reconcileUnknown(h.ref)
    expect(list).toHaveLength(1)
    expect(list[0]!.found).toBe(true)
  })
})

describe('trading · 撤单 / 全撤 / 改单', () => {
  it('按 clientOrderId 撤单 → ok，场所收到 CANCEL_ORDER，先 status 后 202', async () => {
    h = await makeHarness()
    await h.connector.submit(h.ctx, [intent()])
    const acks = await h.connector.cancel(h.ctx, [{ instrumentId: 'ibkr:AAPL', clientOrderId: 'a1b2c3d4e5f60718293a4b5c6d7e8f90' as never }])
    expect(acks[0]!.ok).toBe(true)
    expect(h.tws.frames(M.OUT.CANCEL_ORDER)).toHaveLength(1)
    expect(h.tws.cancelled).toHaveLength(1)
  })

  it('撤一张本进程不认识的单 → ok:false + 3001（说明查不到）', async () => {
    h = await makeHarness()
    const acks = await h.connector.cancel(h.ctx, [{ instrumentId: 'ibkr:AAPL', clientOrderId: '00000000000000000000000000000000' as never }])
    expect(acks[0]!.ok).toBe(false)
    expect(acks[0]!.problem?.code).toBe(3001)
    expect(h.tws.frames(M.OUT.CANCEL_ORDER)).toHaveLength(0)
  })

  it('撤单回 135（场所已找不到）→ ok:true', async () => {
    h = await makeHarness({ tws: { orderBehaviour: 'fill' } })
    await h.connector.submit(h.ctx, [intent()])
    const acks = await h.connector.cancel(h.ctx, [{ instrumentId: 'ibkr:AAPL', clientOrderId: 'a1b2c3d4e5f60718293a4b5c6d7e8f90' as never }])
    expect(acks[0]!.ok).toBe(true)
  })

  it('撤单回 10148（已成交 / 已撤）→ ok:true', async () => {
    h = await makeHarness({ tws: { cancelError: { code: 10148, message: 'OrderId that needs to be cancelled is not found' } } })
    await h.connector.submit(h.ctx, [intent()])
    const acks = await h.connector.cancel(h.ctx, [{ instrumentId: 'ibkr:AAPL', clientOrderId: 'a1b2c3d4e5f60718293a4b5c6d7e8f90' as never }])
    expect(acks[0]!.ok).toBe(true)
  })

  it('撤单回 161（不可撤状态）→ ok:false', async () => {
    h = await makeHarness({ tws: { cancelError: { code: 161, message: 'Cancel attempted when order is not in a cancellable state' } } })
    await h.connector.submit(h.ctx, [intent()])
    const acks = await h.connector.cancel(h.ctx, [{ instrumentId: 'ibkr:AAPL', clientOrderId: 'a1b2c3d4e5f60718293a4b5c6d7e8f90' as never }])
    expect(acks[0]!.ok).toBe(false)
    expect(acks[0]!.problem?.venue?.code).toBe(161)
  })

  it('撤单超时无任何回执 → ok:false + VENUE_UNAVAILABLE', async () => {
    h = await makeHarness({ connector: { ackTimeoutMs: 200 }, tws: { cancelSilent: true } })
    await h.connector.submit(h.ctx, [intent()])
    const acks = await h.connector.cancel(h.ctx, [{ instrumentId: 'ibkr:AAPL', clientOrderId: 'a1b2c3d4e5f60718293a4b5c6d7e8f90' as never }])
    expect(acks[0]!.ok).toBe(false)
    expect(acks[0]!.problem?.code).toBe(3003)
    expect(acks[0]!.problem?.message).toContain('no cancel confirmation')
  })

  it('全撤：只撤本连接 clientId 的单；按标的过滤后 MSFT 仍在，globalCancelCount=0', async () => {
    h = await makeHarness({ symbols: ['AAPL', 'MSFT'] })
    await h.connector.submit(h.ctx, [intent()])
    await h.connector.submit(h.ctx, [intent({ instrumentId: 'ibkr:MSFT', clientOrderId: 'e1b2c3d4e5f60718293a4b5c6d7e8f90' as OrderIntent['clientOrderId'], price: asDecimal('300') })])
    const acks = await h.connector.cancelAll(h.ctx, 'ibkr:AAPL')
    await tick(50)
    expect(h.tws.globalCancelCount).toBe(0)
    expect(acks).toHaveLength(1)
    expect(acks[0]!.ok).toBe(true)
    expect(acks[0]!.target.instrumentId).toBe('ibkr:AAPL')
    const remaining = await h.connector.openOrders(h.ref)
    expect(remaining.map((o) => o.instrumentId)).toEqual(['ibkr:MSFT'])
  })

  it('手动单（clientId 0）不能代撤 → ok:false + VENUE_REJECTED', async () => {
    h = await makeHarness()
    h.tws.addForeignOrder(foreignOrder())
    const acks = await h.connector.cancelAll(h.ctx)
    expect(acks).toHaveLength(1)
    expect(acks[0]!.ok).toBe(false)
    expect(acks[0]!.problem?.code).toBe(3001)
    expect(acks[0]!.problem?.message).toContain('clientId 0')
    expect(h.tws.frames(M.OUT.CANCEL_ORDER)).toHaveLength(0)
  })

  it('bracket 下单后 cancelAll：三张单按各自 orderId 撤（3 个不同值）', async () => {
    h = await makeHarness({ tws: { startOrderId: 700 } })
    await h.connector.submit(h.ctx, [
      intent({ tpsl: { takeProfit: { triggerPrice: asDecimal('120'), price: asDecimal('120') }, stopLoss: { triggerPrice: asDecimal('90') }, grouping: 'order' } }),
    ])
    const sent = h.tws.ordersReceived().map((o) => o.orderId)
    const acks = await h.connector.cancelAll(h.ctx)
    expect(acks).toHaveLength(3)
    expect(acks.every((a) => a.ok)).toBe(true)
    const cancelled = h.tws.frames(M.OUT.CANCEL_ORDER).map((f) => Number(f.fields[2]))
    expect(cancelled).toHaveLength(3)
    expect(new Set(cancelled).size).toBe(3)
    expect([...cancelled].sort((a, b) => a - b)).toEqual([...sent].sort((a, b) => a - b))
  })

  it('clientOrderId 给父单、venueOrderId 给子单 permId → 撤的是子单', async () => {
    h = await makeHarness({ tws: { startOrderId: 700 } })
    const res = await h.connector.submit(h.ctx, [
      intent({ tpsl: { takeProfit: { triggerPrice: asDecimal('120'), price: asDecimal('120') }, stopLoss: { triggerPrice: asDecimal('90') }, grouping: 'order' } }),
    ])
    const childOrderId = h.tws.ordersReceived()[1]!.orderId
    const childPerm = res.acks[1]!.venueOrderId!
    const acks = await h.connector.cancel(h.ctx, [
      { instrumentId: 'ibkr:AAPL', clientOrderId: 'a1b2c3d4e5f60718293a4b5c6d7e8f90' as never, venueOrderId: childPerm },
    ])
    expect(acks[0]!.ok).toBe(true)
    expect(h.tws.cancelled).toEqual([childOrderId])
  })

  it('撤单的 202 确认不进 onWarn', async () => {
    const warns: string[] = []
    h = await makeHarness({ connector: { onWarn: (m) => warns.push(m) } })
    await h.connector.submit(h.ctx, [intent()])
    await h.connector.cancel(h.ctx, [{ instrumentId: 'ibkr:AAPL', clientOrderId: 'a1b2c3d4e5f60718293a4b5c6d7e8f90' as never }])
    await tick(30)
    expect(warns.filter((w) => w.includes('202'))).toHaveLength(0)
  })

  it('全撤没有挂单时给一条 ok（instrumentId 为空串）', async () => {
    h = await makeHarness()
    const acks = await h.connector.cancelAll(h.ctx)
    expect(acks).toHaveLength(1)
    expect(acks[0]!.ok).toBe(true)
    expect(acks[0]!.target.instrumentId).toBe('')
    expect(h.tws.globalCancelCount).toBe(0)
  })

  it('改单一律 1004（IB 无原生改单，撤旧挂新会换号）', async () => {
    h = await makeHarness()
    const res = await h.connector.amend(h.ctx, { instrumentId: 'ibkr:AAPL', clientOrderId: 'a1b2c3d4e5f60718293a4b5c6d7e8f90' as never, order: intent() })
    expect(res.acks[0]!.status).toBe('rejected')
    expect(res.acks[0]!.problem?.code).toBe(1004)
  })

  it('IB 状态 → ack 状态的映射（PreSubmitted / ApiCancelled / Inactive）', () => {
    expect(ackStatusOf('PreSubmitted')).toBe('open')
    expect(ackStatusOf('Submitted')).toBe('open')
    expect(ackStatusOf('Filled')).toBe('filled')
    expect(ackStatusOf('ApiCancelled')).toBe('rejected')
    expect(ackStatusOf('Inactive')).toBe('rejected')
  })
})
