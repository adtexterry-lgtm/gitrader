// SPDX-License-Identifier: CPAL-1.0
// 撮合：八种订单形态逐档吃量、流动性消耗、部分成交、剩余挂单、撤单、停损触发的逐条断言。
import { describe, expect, it } from 'vitest'
import { fx } from '@gitrader/protocol/decimal'
import { SimBook } from '../src'
import type { LevelTuple, OrderRequest, SimBookOptions } from '../src'

let idSeq = 0
function newId(): string {
  idSeq += 1
  return `o-${idSeq}`
}

function sim(
  bids: LevelTuple[] = [['100', '10']],
  asks: LevelTuple[] = [['101', '10']],
  options: SimBookOptions = {},
): SimBook {
  const book = new SimBook({ instrument: 'BTCUSDT', ...options })
  book.apply({ type: 'book_snapshot', ts: 1, instrument: 'BTCUSDT', bids, asks })
  return book
}

function order(over: Partial<OrderRequest> & Pick<OrderRequest, 'side' | 'type' | 'qty'>): OrderRequest {
  return { id: newId(), ...over }
}

describe('市价单逐档吃量', () => {
  it('一笔市价买单按档位逐档吃，成交价取档位价', () => {
    const book = sim([['100', '10']], [['101', '1'], ['102', '2']])
    const report = book.submit(order({ side: 'buy', type: 'market', qty: '3' }), 2)
    expect(report.fills).toEqual([
      { price: '101', qty: '1', liquidity: 'taker' },
      { price: '102', qty: '2', liquidity: 'taker' },
    ])
    expect(report.status).toBe('filled')
    expect(report.filledQty).toBe('3')
    expect(report.remainingQty).toBe('0')
    expect(report.avgPrice).toBe('101.666666666666666666')
  })

  it('盘口不够吃时部分成交，剩余不挂簿', () => {
    const book = sim([['100', '10']], [['101', '3']])
    const report = book.submit(order({ side: 'buy', type: 'market', qty: '5' }), 2)
    expect(report.status).toBe('partially_filled')
    expect(report.filledQty).toBe('3')
    expect(report.remainingQty).toBe('2')
    expect(report.reason).toBe('insufficient_liquidity')
    expect(report.resting).toBe(false)
  })

  it('对手盘为空时市价单整单拒掉', () => {
    const book = sim([['100', '1']], [])
    const report = book.submit(order({ side: 'buy', type: 'market', qty: '1' }), 2)
    expect(report.status).toBe('rejected')
    expect(report.reason).toBe('no_liquidity')
    expect(report.fills).toEqual([])
    expect(book.hasOpenOrder(report.orderId)).toBe(false)
  })

  it('市价卖单吃买档，从高价往下吃', () => {
    const book = sim([['100', '1'], ['99', '3']], [['101', '10']])
    const report = book.submit(order({ side: 'sell', type: 'market', qty: '2' }), 2)
    expect(report.fills).toEqual([
      { price: '100', qty: '1', liquidity: 'taker' },
      { price: '99', qty: '1', liquidity: 'taker' },
    ])
    expect(report.avgPrice).toBe('99.5')
  })

  it('数量是小数时逐档吃量仍精确', () => {
    const book = sim([['100', '10']], [['101', '0.1'], ['102', '0.2']])
    const report = book.submit(order({ side: 'buy', type: 'market', qty: '0.3' }), 2)
    expect(report.fills.map((fill) => fill.qty)).toEqual(['0.1', '0.2'])
    expect(report.filledQty).toBe('0.3')
    expect(report.remainingQty).toBe('0')
  })
})

describe('限价单', () => {
  it('限价买只吃限价以内的档位，成交价不会高于限价', () => {
    const book = sim([['100', '10']], [['101', '1'], ['102', '2']])
    const report = book.submit(order({ side: 'buy', type: 'limit', qty: '5', price: '101.5' }), 2)
    expect(report.fills).toEqual([{ price: '101', qty: '1', liquidity: 'taker' }])
    expect(report.status).toBe('partially_filled')
    expect(report.remainingQty).toBe('4')
    expect(report.resting).toBe(true)
  })

  it('限价不穿越时整单挂簿，不产生成交', () => {
    const book = sim([['100', '10']], [['101', '10']])
    const report = book.submit(order({ side: 'buy', type: 'limit', qty: '2', price: '99' }), 2)
    expect(report.status).toBe('accepted')
    expect(report.fills).toEqual([])
    expect(report.resting).toBe(true)
    expect(book.openOrders().map((open) => open.orderId)).toEqual([report.orderId])
  })

  it('限价卖在买一之上挂簿，买一之下立即吃单', () => {
    const quiet = sim([['100', '5']], [['101', '5']])
    const resting = quiet.submit(order({ side: 'sell', type: 'limit', qty: '1', price: '101' }), 2)
    expect(resting.status).toBe('accepted')

    const aggressive = sim([['100', '5']], [['101', '5']])
    const taken = aggressive.submit(order({ side: 'sell', type: 'limit', qty: '1', price: '99' }), 2)
    expect(taken.status).toBe('filled')
    expect(taken.fills[0]).toEqual({ price: '100', qty: '1', liquidity: 'taker' })
  })
})

describe('post-only', () => {
  it('会吃单的 post-only 限价单整单拒绝', () => {
    const book = sim([['100', '5']], [['101', '5']])
    const report = book.submit(order({ side: 'buy', type: 'limit', qty: '1', price: '101', postOnly: true }), 2)
    expect(report.status).toBe('rejected')
    expect(report.reason).toBe('post_only_would_take')
    expect(report.fills).toEqual([])
  })

  it('不吃单的 post-only 限价单正常挂簿', () => {
    const book = sim([['100', '5']], [['101', '5']])
    const report = book.submit(order({ side: 'buy', type: 'limit', qty: '1', price: '100.5', postOnly: true }), 2)
    expect(report.status).toBe('accepted')
    expect(report.resting).toBe(true)
  })

  it('post-only 不能与 IOC 组合', () => {
    const book = sim()
    const report = book.submit(order({ side: 'buy', type: 'limit', qty: '1', price: '99', postOnly: true, tif: 'ioc' }), 2)
    expect(report.status).toBe('rejected')
    expect(report.reason).toBe('invalid_order')
  })

  it('post-only 只能用于限价类订单', () => {
    const book = sim()
    const report = book.submit(order({ side: 'buy', type: 'market', qty: '1', postOnly: true }), 2)
    expect(report.status).toBe('rejected')
    expect(report.reason).toBe('invalid_order')
  })
})

describe('IOC', () => {
  it('部分成交后剩余作废，不挂簿', () => {
    const book = sim([['100', '10']], [['101', '1'], ['102', '1']])
    const report = book.submit(order({ side: 'buy', type: 'limit', qty: '5', price: '102', tif: 'ioc' }), 2)
    expect(report.filledQty).toBe('2')
    expect(report.remainingQty).toBe('3')
    expect(report.status).toBe('partially_filled')
    expect(report.reason).toBe('ioc_remainder_void')
    expect(report.resting).toBe(false)
    expect(book.openOrders()).toEqual([])
  })

  it('全部成交时不带原因码', () => {
    const book = sim([['100', '10']], [['101', '5']])
    const report = book.submit(order({ side: 'buy', type: 'limit', qty: '1', price: '101', tif: 'ioc' }), 2)
    expect(report.status).toBe('filled')
    expect(report.reason).toBeUndefined()
  })

  it('不能成交时撤单，不吃不挂', () => {
    const book = sim([['100', '10']], [['101', '5']])
    const report = book.submit(order({ side: 'buy', type: 'limit', qty: '1', price: '99', tif: 'ioc' }), 2)
    expect(report.status).toBe('canceled')
    expect(report.reason).toBe('ioc_remainder_void')
    expect(report.fills).toEqual([])
  })
})

describe('FOK', () => {
  it('吃不下就整单作废，且不留任何消耗', () => {
    const book = sim([['100', '10']], [['101', '2']])
    const fok = book.submit(order({ side: 'buy', type: 'limit', qty: '5', price: '102', tif: 'fok' }), 2)
    expect(fok.status).toBe('canceled')
    expect(fok.reason).toBe('fok_unfillable')
    expect(fok.fills).toEqual([])

    // 作废的 FOK 没吃掉流动性：后面的市价单仍能吃到 2。
    const after = book.submit(order({ side: 'buy', type: 'market', qty: '2' }), 2)
    expect(after.status).toBe('filled')
    expect(after.filledQty).toBe('2')
  })

  it('刚好吃得下时整单成交', () => {
    const book = sim([['100', '10']], [['101', '1'], ['102', '1']])
    const report = book.submit(order({ side: 'buy', type: 'limit', qty: '2', price: '102', tif: 'fok' }), 2)
    expect(report.status).toBe('filled')
    expect(report.filledQty).toBe('2')
  })

  it('FOK 成交后同样消耗流动性', () => {
    const book = sim([['100', '10']], [['101', '3']])
    const fok = book.submit(order({ side: 'buy', type: 'limit', qty: '1', price: '101', tif: 'fok' }), 2)
    expect(fok.status).toBe('filled')
    const after = book.submit(order({ side: 'buy', type: 'market', qty: '5' }), 3)
    expect(after.filledQty).toBe('2')
    expect(after.status).toBe('partially_filled')
  })

  it('限价不穿越时 FOK 直接作废', () => {
    const book = sim([['100', '10']], [['101', '5']])
    const report = book.submit(order({ side: 'buy', type: 'limit', qty: '1', price: '99', tif: 'fok' }), 2)
    expect(report.status).toBe('canceled')
    expect(report.reason).toBe('fok_unfillable')
  })
})

describe('流动性消耗：同一份量只能被吃一次', () => {
  it('同一时刻两张市价单不能吃同一份量', () => {
    const book = sim([['100', '10']], [['101', '3']])
    const first = book.submit(order({ side: 'buy', type: 'market', qty: '2' }), 5)
    const second = book.submit(order({ side: 'buy', type: 'market', qty: '2' }), 5)
    const third = book.submit(order({ side: 'buy', type: 'market', qty: '1' }), 5)

    expect(first.filledQty).toBe('2')
    expect(second.filledQty).toBe('1')
    expect(second.status).toBe('partially_filled')
    expect(third.status).toBe('rejected')
    expect(third.reason).toBe('no_liquidity')
  })

  it('两张限价单抢同一档，第二张只能等新数据', () => {
    const book = sim([['100', '10']], [['101', '1']])
    const first = book.submit(order({ side: 'buy', type: 'limit', qty: '1', price: '101' }), 5)
    const second = book.submit(order({ side: 'buy', type: 'limit', qty: '1', price: '101' }), 5)
    expect(first.status).toBe('filled')
    expect(second.status).toBe('accepted')
    expect(second.resting).toBe(true)
  })

  it('新数据刷新档位量之后可吃量恢复', () => {
    const book = sim([['100', '10']], [['101', '3']])
    book.submit(order({ side: 'buy', type: 'market', qty: '3' }), 5)
    book.apply({ type: 'book_delta', ts: 6, instrument: 'BTCUSDT', side: 'ask', action: 'update', price: '101', size: '3' })
    const report = book.submit(order({ side: 'buy', type: 'market', qty: '2' }), 7)
    expect(report.status).toBe('filled')
    expect(report.filledQty).toBe('2')
  })
})

describe('撤单', () => {
  it('撤掉挂单后不再参与撮合', () => {
    const book = sim([['100', '10']], [['101', '10']])
    const report = book.submit(order({ side: 'buy', type: 'limit', qty: '2', price: '99' }), 2)
    const canceled = book.cancel(report.orderId, 3)
    expect(canceled.status).toBe('canceled')
    expect(canceled.remainingQty).toBe('2')
    expect(book.hasOpenOrder(report.orderId)).toBe(false)
    expect(book.openOrders()).toEqual([])
  })

  it('部分成交后撤单，保留已成交量', () => {
    const book = sim([['100', '10']], [['101', '2']])
    const report = book.submit(order({ side: 'buy', type: 'limit', qty: '5', price: '101' }), 2)
    expect(report.filledQty).toBe('2')
    const canceled = book.cancel(report.orderId, 3)
    expect(canceled.status).toBe('canceled')
    expect(canceled.filledQty).toBe('2')
    expect(canceled.remainingQty).toBe('3')
    expect(canceled.fills).toHaveLength(1)
  })

  it('撤未知单给 unknown_order', () => {
    const book = sim()
    const report = book.cancel('nope', 2)
    expect(report.status).toBe('rejected')
    expect(report.reason).toBe('unknown_order')
  })

  it('撤已终结的单给 already_terminal', () => {
    const book = sim([['100', '10']], [['101', '5']])
    const filled = book.submit(order({ side: 'buy', type: 'market', qty: '1' }), 2)
    const report = book.cancel(filled.orderId, 3)
    expect(report.status).toBe('rejected')
    expect(report.reason).toBe('already_terminal')
  })

  it('重复的订单 id 被拒', () => {
    const book = sim([['100', '10']], [['101', '10']])
    const request = order({ side: 'buy', type: 'limit', qty: '1', price: '99' })
    expect(book.submit(request, 2).status).toBe('accepted')
    const again = book.submit(request, 3)
    expect(again.status).toBe('rejected')
    expect(again.reason).toBe('duplicate_order_id')
  })
})

describe('停损单', () => {
  it('止损买单未触发时挂簿，最新价上穿后成交', () => {
    const book = sim([['100', '5']], [['101', '5']])
    const id = newId()
    const accepted = book.submit({ id, side: 'buy', type: 'stop_market', qty: '1', triggerPrice: '105' }, 2)
    expect(accepted.status).toBe('accepted')
    expect(accepted.resting).toBe(true)

    book.apply({ type: 'trade', ts: 3, instrument: 'BTCUSDT', price: '104', size: '1', aggressor: 'buy' })
    expect(book.report(id)?.status).toBe('accepted')

    book.apply({ type: 'trade', ts: 4, instrument: 'BTCUSDT', price: '105', size: '1', aggressor: 'buy' })
    const report = book.report(id)
    expect(report?.status).toBe('filled')
    expect(report?.fills[0]?.price).toBe('101')
  })

  it('止损卖单在最新价下穿时触发', () => {
    const book = sim([['100', '5']], [['101', '5']])
    const id = newId()
    book.submit({ id, side: 'sell', type: 'stop_market', qty: '1', triggerPrice: '95' }, 2)
    book.apply({ type: 'trade', ts: 3, instrument: 'BTCUSDT', price: '95', size: '1', aggressor: 'sell' })
    const report = book.report(id)
    expect(report?.status).toBe('filled')
    expect(report?.fills[0]?.price).toBe('100')
  })

  it('止损限价单触发后限价不穿越则转为挂单，等报价上来再成交', () => {
    const book = sim([['100', '5']], [['102', '5']])
    const id = newId()
    book.submit({ id, side: 'sell', type: 'stop_limit', qty: '1', triggerPrice: '95', price: '101' }, 2)
    book.apply({ type: 'trade', ts: 3, instrument: 'BTCUSDT', price: '95', size: '1', aggressor: 'sell' })
    expect(book.report(id)?.status).toBe('accepted')
    expect(book.hasOpenOrder(id)).toBe(true)

    book.apply({ type: 'book_delta', ts: 4, instrument: 'BTCUSDT', side: 'bid', action: 'add', price: '101', size: '1' })
    const report = book.report(id)
    expect(report?.status).toBe('filled')
    expect(report?.fills[0]?.price).toBe('101')
  })

  it('止损限价单触发时对手价更好，按对手价成交', () => {
    const book = sim([['100', '5']], [['101', '5']])
    const id = newId()
    book.submit({ id, side: 'sell', type: 'stop_limit', qty: '1', triggerPrice: '95', price: '99' }, 2)
    book.apply({ type: 'trade', ts: 3, instrument: 'BTCUSDT', price: '95', size: '1', aggressor: 'sell' })
    const report = book.report(id)
    expect(report?.status).toBe('filled')
    expect(report?.fills[0]?.price).toBe('100')
  })

  it('触发后盘口无对手量时市价单拒单', () => {
    const book = sim([['100', '5']], [])
    const id = newId()
    book.submit({ id, side: 'buy', type: 'stop_market', qty: '1', triggerPrice: '105' }, 2)
    book.apply({ type: 'trade', ts: 3, instrument: 'BTCUSDT', price: '106', size: '1', aggressor: 'buy' })
    const report = book.report(id)
    expect(report?.status).toBe('rejected')
    expect(report?.reason).toBe('no_liquidity')
  })
})

describe('减仓单', () => {
  it('减仓买单按空头持仓截断', () => {
    const book = sim([['100', '10']], [['101', '10']])
    const report = book.submit(order({ side: 'buy', type: 'market', qty: '5', reduceOnly: true }), 2, {
      position: { side: 'short', qty: '2' },
    })
    expect(report.status).toBe('filled')
    expect(report.filledQty).toBe('2')
    expect(report.fills[0]?.qty).toBe('2')
    expect(report.notes.join()).toMatch(/截断/)
  })

  it('减仓卖单按多头持仓截断', () => {
    const book = sim([['100', '10']], [['101', '10']])
    const report = book.submit(order({ side: 'sell', type: 'market', qty: '5', reduceOnly: true }), 2, {
      position: { side: 'long', qty: '1.5' },
    })
    expect(report.filledQty).toBe('1.5')
  })

  it('没有持仓的减仓单拒单', () => {
    const book = sim()
    const report = book.submit(order({ side: 'sell', type: 'market', qty: '1', reduceOnly: true }), 2, {
      position: { side: 'flat', qty: '0' },
    })
    expect(report.status).toBe('rejected')
    expect(report.reason).toBe('reduce_only_no_position')
  })

  it('与持仓同向的减仓单拒单', () => {
    const book = sim()
    const report = book.submit(order({ side: 'buy', type: 'market', qty: '1', reduceOnly: true }), 2, {
      position: { side: 'long', qty: '3' },
    })
    expect(report.status).toBe('rejected')
    expect(report.reason).toBe('reduce_only_no_position')
  })
})

describe('挂单被行情推动', () => {
  it('逐笔成交穿过挂单价时按挂单价成交（maker）', () => {
    const book = sim([['99', '5']], [['101', '5']])
    const id = newId()
    book.submit({ id, side: 'buy', type: 'limit', qty: '0.5', price: '100' }, 2)
    book.apply({ type: 'trade', ts: 3, instrument: 'BTCUSDT', price: '100', size: '0.5', aggressor: 'sell' })
    const report = book.report(id)
    expect(report?.status).toBe('filled')
    expect(report?.fills[0]).toEqual({ price: '100', qty: '0.5', liquidity: 'maker' })
  })

  it('同一笔成交量只够一张挂单：第二张继续挂着', () => {
    const book = sim([['99', '5']], [['101', '5']])
    const firstId = newId()
    const secondId = newId()
    book.submit({ id: firstId, side: 'buy', type: 'limit', qty: '1', price: '100' }, 2)
    book.submit({ id: secondId, side: 'buy', type: 'limit', qty: '1', price: '100' }, 2)
    book.apply({ type: 'trade', ts: 3, instrument: 'BTCUSDT', price: '100', size: '1', aggressor: 'sell' })
    expect(book.report(firstId)?.filledQty).toBe('1')
    expect(book.report(secondId)?.filledQty).toBe('0')
    expect(book.hasOpenOrder(secondId)).toBe(true)
  })

  it('新报价穿越挂单价时按自己的限价成交（maker）', () => {
    const book = sim([['99', '5']], [['101', '5']])
    const id = newId()
    book.submit({ id, side: 'buy', type: 'limit', qty: '1', price: '100' }, 2)
    book.apply({ type: 'book_delta', ts: 3, instrument: 'BTCUSDT', side: 'ask', action: 'add', price: '100', size: '1' })
    const report = book.report(id)
    expect(report?.status).toBe('filled')
    expect(report?.fills[0]).toEqual({ price: '100', qty: '1', liquidity: 'maker' })
  })

  it('对手价压到自己限价之下：按自己的限价成交（maker），不是档位价', () => {
    const book = sim([['99', '5']], [['101', '5']])
    const id = newId()
    book.submit({ id, side: 'buy', type: 'limit', qty: '1', price: '100' }, 2)
    book.apply({ type: 'book_delta', ts: 3, instrument: 'BTCUSDT', side: 'ask', action: 'add', price: '99.5', size: '3' })
    const report = book.report(id)
    expect(report?.fills).toEqual([{ price: '100', qty: '1', liquidity: 'maker' }])
    expect(book.book.availableAt('ask', fx('99.5'))).toBe(fx('2'))
  })

  it('post-only 挂卖被买价穿越：按自己的限价成交（maker）', () => {
    const book = sim([['99', '5']], [['101', '5']])
    const id = newId()
    book.submit({ id, side: 'sell', type: 'limit', qty: '1', price: '100.5', postOnly: true }, 2)
    book.apply({ type: 'book_delta', ts: 3, instrument: 'BTCUSDT', side: 'bid', action: 'add', price: '100.8', size: '2' })
    const report = book.report(id)
    expect(report?.fills).toEqual([{ price: '100.5', qty: '1', liquidity: 'maker' }])
  })

  it('挂单被穿越的成交按 maker 费率计费', () => {
    const book = sim([['99', '5']], [['101', '5']], { fees: { maker: '0.0001', taker: '0.001' } })
    const id = newId()
    book.submit({ id, side: 'buy', type: 'limit', qty: '1', price: '100' }, 2)
    book.apply({ type: 'book_delta', ts: 3, instrument: 'BTCUSDT', side: 'ask', action: 'add', price: '99.5', size: '3' })
    // 100 × 1 × 0.0001 = 0.01（maker），taker 为 0
    expect(book.feesOf(id).maker).toBe('0.01')
    expect(book.feesOf(id).taker).toBe('0')
  })

  it('刚触发的止损限价单仍是 taker：按档位价吃盘口', () => {
    const book = sim([['100', '5']], [['101', '5']])
    const id = newId()
    book.submit({ id, side: 'buy', type: 'stop_limit', qty: '1', triggerPrice: '102', price: '103' }, 2)
    book.apply({
      type: 'book_snapshot',
      ts: 4,
      instrument: 'BTCUSDT',
      bids: [['101.5', '5']],
      asks: [['102.5', '5']],
    })
    book.apply({ type: 'trade', ts: 5, instrument: 'BTCUSDT', price: '102', size: '1', aggressor: 'buy' })
    expect(book.report(id)?.fills[0]).toEqual({ price: '102.5', qty: '1', liquidity: 'taker' })
  })

  it('买方主动的成交不会打到我的买单挂单', () => {
    const book = sim([['99', '5']], [['101', '5']])
    const id = newId()
    book.submit({ id, side: 'buy', type: 'limit', qty: '1', price: '100' }, 2)
    book.apply({ type: 'trade', ts: 3, instrument: 'BTCUSDT', price: '100', size: '1', aggressor: 'buy' })
    expect(book.report(id)?.filledQty).toBe('0')
    expect(book.hasOpenOrder(id)).toBe(true)
  })

  it('方向未知的成交仍可推动挂单成交', () => {
    const book = sim([['99', '5']], [['101', '5']])
    const id = newId()
    book.submit({ id, side: 'buy', type: 'limit', qty: '1', price: '100' }, 2)
    book.apply({ type: 'trade', ts: 3, instrument: 'BTCUSDT', price: '100', size: '1', aggressor: 'unknown' })
    expect(book.report(id)?.filledQty).toBe('1')
  })

  it('查不存在的订单回报得到 undefined', () => {
    const book = sim()
    expect(book.report('missing')).toBeUndefined()
  })

  it('挂单成交不吃盘口台账（成交量另算）', () => {
    const book = sim([['99', '5']], [['101', '5']])
    book.submit(order({ side: 'buy', type: 'limit', qty: '1', price: '100' }), 2)
    book.apply({ type: 'trade', ts: 3, instrument: 'BTCUSDT', price: '100', size: '1', aggressor: 'sell' })
    expect(book.book.availableAt('ask', fx('101'))).toBe(fx('5'))
  })
})

describe('入参校验', () => {
  it('市价单带价格被拒', () => {
    const book = sim()
    const report = book.submit(order({ side: 'buy', type: 'market', qty: '1', price: '100' }), 2)
    expect(report.reason).toBe('invalid_order')
  })

  it('限价单缺价格被拒', () => {
    const book = sim()
    const report = book.submit(order({ side: 'buy', type: 'limit', qty: '1' }), 2)
    expect(report.reason).toBe('invalid_order')
  })

  it('停损单缺触发价被拒', () => {
    const book = sim()
    const report = book.submit(order({ side: 'buy', type: 'stop_market', qty: '1' }), 2)
    expect(report.reason).toBe('invalid_order')
  })

  it('止损限价单缺价格被拒', () => {
    const book = sim()
    const report = book.submit(order({ side: 'buy', type: 'stop_limit', qty: '1', triggerPrice: '105' }), 2)
    expect(report.status).toBe('rejected')
    expect(report.reason).toBe('invalid_order')
  })

  it('止损限价单缺触发价被拒', () => {
    const book = sim()
    const report = book.submit(order({ side: 'buy', type: 'stop_limit', qty: '1', price: '105' }), 2)
    expect(report.status).toBe('rejected')
    expect(report.reason).toBe('invalid_order')
  })

  it('数量写成指数形式被拒', () => {
    const book = sim()
    const report = book.submit(order({ side: 'buy', type: 'market', qty: '1e-8' }), 2)
    expect(report.reason).toBe('invalid_order')
  })

  it('数量为 0 被拒', () => {
    const book = sim()
    const report = book.submit(order({ side: 'buy', type: 'market', qty: '0' }), 2)
    expect(report.reason).toBe('invalid_order')
  })

  it('未知方向被拒', () => {
    const book = sim()
    const report = book.submit({ id: newId(), side: 'hold' as never, type: 'market', qty: '1' }, 2)
    expect(report.reason).toBe('invalid_order')
  })
})

describe('挂单列表与确定性', () => {
  it('openOrders 按提交顺序返回', () => {
    const book = sim([['100', '10']], [['101', '10']])
    const first = book.submit(order({ side: 'buy', type: 'limit', qty: '1', price: '99' }), 2)
    const second = book.submit(order({ side: 'sell', type: 'limit', qty: '1', price: '102' }), 3)
    expect(book.openOrders().map((open) => open.orderId)).toEqual([first.orderId, second.orderId])
  })

  it('同一串输入跑两遍得到完全相同的回报序列', () => {
    const run = (): string[] => {
      const book = sim([['100', '10']], [['101', '2'], ['102', '3']])
      const reports = [
        book.submit({ id: 'a', side: 'buy', type: 'market', qty: '2' }, 2),
        book.submit({ id: 'b', side: 'buy', type: 'limit', qty: '3', price: '102' }, 2),
        book.submit({ id: 'c', side: 'sell', type: 'stop_market', qty: '1', triggerPrice: '99' }, 3),
      ]
      book.apply({ type: 'trade', ts: 4, instrument: 'BTCUSDT', price: '99', size: '1', aggressor: 'sell' })
      return reports.map((report) => JSON.stringify(report))
    }
    expect(run()).toEqual(run())
  })
})
