// SPDX-License-Identifier: CPAL-1.0
// 延迟与「到达场所时刻才撮合」的整链行为：在途不吃流动性、延迟改变成交价、撤单 / 改单在途期间旧单仍然活着。
import { describe, expect, it } from 'vitest'
import { fx } from '@gitrader/protocol/decimal'
import { LatencyModel, SimBook } from '../src'
import type { LevelTuple, SimBookOptions } from '../src'

function sim(
  bids: LevelTuple[] = [['100', '10']],
  asks: LevelTuple[] = [['101', '10']],
  options: SimBookOptions = {},
): SimBook {
  const book = new SimBook({ instrument: 'BTCUSDT', ...options })
  book.apply({ type: 'book_snapshot', ts: 1, instrument: 'BTCUSDT', bids, asks })
  return book
}

describe('下单延迟', () => {
  it('在途订单不成交，回报说明延迟与预计到达时刻', () => {
    const book = sim([['100', '10']], [['101', '10']], { latency: { insertMs: 100 } })
    const report = book.submit({ id: 'a', side: 'buy', type: 'market', qty: '1' }, 10)
    expect(report.status).toBe('accepted')
    expect(report.filledQty).toBe('0')
    expect(report.resting).toBe(true)
    expect(book.arrivalOf('a')).toBe(110)
    expect(book.pendingCount).toBe(1)
    expect(report.notes.join(' ')).toContain('在途：下单延迟 100 ms，预计 110 到达场所')
  })

  it('到达时刻的记录一到就按那时的盘口撮合', () => {
    const book = sim([['100', '10']], [['101', '10']], { latency: { insertMs: 100 } })
    book.submit({ id: 'a', side: 'buy', type: 'market', qty: '1' }, 10)
    book.apply({ type: 'book_delta', ts: 110, instrument: 'BTCUSDT', side: 'bid', action: 'add', price: '99', size: '1' })
    expect(book.report('a')?.status).toBe('filled')
    expect(book.report('a')?.fills[0]).toEqual({ price: '101', qty: '1', liquidity: 'taker' })
    expect(book.arrivalOf('a')).toBeNull()
    expect(book.pendingCount).toBe(0)
  })

  it('延迟让成交价变差：盘口在途中移动，成交在移动后的价上', () => {
    const zero = sim([['100', '10']], [['101', '10']])
    zero.submit({ id: 'z', side: 'buy', type: 'market', qty: '1' }, 10)
    expect(zero.report('z')?.avgPrice).toBe('101')

    const slow = sim([['100', '10']], [['101', '10']], { latency: { insertMs: 60 } })
    slow.submit({ id: 's', side: 'buy', type: 'market', qty: '1' }, 10)
    slow.apply({ type: 'book_delta', ts: 40, instrument: 'BTCUSDT', side: 'ask', action: 'delete', price: '101' })
    slow.apply({ type: 'book_delta', ts: 40, instrument: 'BTCUSDT', side: 'ask', action: 'add', price: '105', size: '10' })
    expect(slow.report('s')?.filledQty).toBe('0')
    slow.apply({ type: 'book_delta', ts: 70, instrument: 'BTCUSDT', side: 'bid', action: 'add', price: '99', size: '1' })
    expect(slow.report('s')?.avgPrice).toBe('105')
  })

  it('到达时刻早于当前记录时，用当前记录之前的盘口（不偷看未来）', () => {
    const book = sim([['100', '10']], [['101', '10'], ['104', '10']], { latency: { insertMs: 35 } })
    book.submit({ id: 'early', side: 'buy', type: 'market', qty: '1' }, 10) // 到达 45
    book.apply({ type: 'book_delta', ts: 50, instrument: 'BTCUSDT', side: 'ask', action: 'delete', price: '101' })
    // 盘口到 50 才变差，订单在 45 到场所，成交价取 45 之前最后已知的卖一 101
    expect(book.report('early')?.filledQty).toBe('1')
    expect(book.report('early')?.avgPrice).toBe('101')
  })

  it('到达时刻早于当前记录时，不用这条记录改过的可吃量', () => {
    const book = sim([['100', '10']], [['101', '10']], { latency: { insertMs: 35 } })
    book.submit({ id: 'early-qty', side: 'buy', type: 'market', qty: '2' }, 10) // 到达 45
    book.apply({ type: 'book_delta', ts: 50, instrument: 'BTCUSDT', side: 'ask', action: 'update', price: '101', size: '1' })
    // 到达时卖一还有 10 手；50 的增量把可吃量改成 1，与 45 到场的单无关
    expect(book.report('early-qty')?.filledQty).toBe('2')
    expect(book.report('early-qty')?.avgPrice).toBe('101')
  })

  it('在途订单不吃流动性：途中盘口被吃掉，到达时没有量可吃', () => {
    const book = sim([['100', '10']], [['101', '1']], { latency: { insertMs: 100 } })
    book.submit({ id: 'slow', side: 'buy', type: 'market', qty: '1' }, 10) // 到达 110
    // 提交之后、到达之前：盘口可吃量没被动过（在途单不在簿上）
    expect(book.book.availableAt('ask', fx('101'))).toBe(fx('1'))
    // 途中卖一被撤走
    book.apply({ type: 'book_delta', ts: 20, instrument: 'BTCUSDT', side: 'ask', action: 'delete', price: '101' })
    book.apply({ type: 'book_delta', ts: 110, instrument: 'BTCUSDT', side: 'bid', action: 'add', price: '99', size: '1' })
    expect(book.report('slow')?.status).toBe('rejected')
    expect(book.report('slow')?.reason).toBe('no_liquidity')
  })

  it('停损单在到达时刻才判触发，按到达后的盘口成交', () => {
    const book = sim([['100', '10']], [['101', '10']], { latency: { insertMs: 50 } })
    book.submit({ id: 'st', side: 'buy', type: 'stop_market', qty: '1', triggerPrice: '101' }, 10) // 到达 60
    book.apply({ type: 'book_delta', ts: 20, instrument: 'BTCUSDT', side: 'ask', action: 'update', price: '101', size: '10' })
    book.apply({ type: 'book_delta', ts: 20, instrument: 'BTCUSDT', side: 'ask', action: 'add', price: '102', size: '10' })
    expect(book.report('st')?.filledQty).toBe('0')
    book.apply({ type: 'book_delta', ts: 60, instrument: 'BTCUSDT', side: 'bid', action: 'add', price: '99', size: '1' })
    // 到达时卖一还是 101，触发后按盘口逐档吃：101 一手
    expect(book.report('st')?.filledQty).toBe('1')
    expect(book.report('st')?.avgPrice).toBe('101')
  })

  it('撤单先于下单到场：按未知单拒绝，下单到场后照常成交', () => {
    const book = sim([['100', '10']], [['101', '10']], { latency: { insertMs: 100 } })
    book.submit({ id: 'gone', side: 'buy', type: 'market', qty: '1' }, 10)
    const canceled = book.cancel('gone', 11)
    expect(canceled.status).toBe('rejected')
    expect(canceled.reason).toBe('unknown_order')
    book.apply({ type: 'book_delta', ts: 200, instrument: 'BTCUSDT', side: 'bid', action: 'add', price: '99', size: '1' })
    expect(book.report('gone')?.status).toBe('filled')
    expect(book.report('gone')?.avgPrice).toBe('101')
  })

  it('改单先于下单到场：按未知单拒绝，订单按原参数挂簿', () => {
    const book = sim([['99', '5']], [['101', '5']], { latency: { insertMs: 100 } })
    book.submit({ id: 'm', side: 'buy', type: 'limit', qty: '1', price: '100' }, 10)
    const patched = book.modify('m', { price: '101' }, 20)
    expect(patched.status).toBe('rejected')
    expect(patched.reason).toBe('unknown_order')
    expect(book.report('m')?.filledQty).toBe('0')
    book.apply({ type: 'book_delta', ts: 150, instrument: 'BTCUSDT', side: 'bid', action: 'add', price: '98', size: '1' })
    expect(book.report('m')?.status).toBe('accepted')
    expect(book.report('m')?.resting).toBe(true)
    expect(book.report('m')?.filledQty).toBe('0')
  })

  it('有延迟的撤单也先于下单到场：按未知单拒绝，订单仍挂着', () => {
    const book = sim([['99', '5']], [['101', '5']], { latency: { insertMs: 100, cancelMs: 5 } })
    book.submit({ id: 'late-cancel', side: 'buy', type: 'limit', qty: '1', price: '99' }, 10)
    book.cancel('late-cancel', 20)
    book.flush(1_000)
    expect(book.hasOpenOrder('late-cancel')).toBe(true)
    expect(book.report('late-cancel')?.notes.join(' ')).toContain('先于下单到达场所')
  })

  it('撤单到场晚于下单到场：正常撤掉', () => {
    const book = sim([['99', '5']], [['101', '5']], { latency: { insertMs: 100, cancelMs: 200 } })
    book.submit({ id: 'after', side: 'buy', type: 'limit', qty: '1', price: '99' }, 10)
    book.cancel('after', 20)
    book.flush(1_000)
    expect(book.report('after')?.status).toBe('canceled')
  })

  it('flush 把在途命令按最后已知盘口走完', () => {
    const book = sim([['100', '10']], [['101', '10']], { latency: { insertMs: 100 } })
    book.submit({ id: 'tail', side: 'buy', type: 'market', qty: '1' }, 10)
    book.flush(1_000)
    expect(book.report('tail')?.status).toBe('filled')
    expect(book.pendingCount).toBe(0)
  })
})

describe('撤单延迟', () => {
  it('撤单在途期间行情仍能成交这张单', () => {
    const book = sim([['100', '5'], ['99', '5']], [['101', '5']], { latency: { cancelMs: 30 } })
    book.submit({ id: 'live', side: 'buy', type: 'limit', qty: '1', price: '100' }, 2)
    const ack = book.cancel('live', 5)
    expect(ack.status).toBe('accepted')
    expect(ack.notes.join(' ')).toContain('在途：撤单延迟 30 ms')
    book.apply({ type: 'trade', ts: 10, instrument: 'BTCUSDT', price: '100', size: '1', aggressor: 'sell' })
    expect(book.report('live')?.status).toBe('filled')
    expect(book.report('live')?.filledQty).toBe('1')
    // 撤单到达时单已终结：不动它的回报
    book.apply({ type: 'book_delta', ts: 100, instrument: 'BTCUSDT', side: 'bid', action: 'add', price: '98', size: '1' })
    expect(book.report('live')?.status).toBe('filled')
  })

  it('撤单到达场所后撤掉剩余量', () => {
    const book = sim([['100', '5'], ['99', '5']], [['101', '5']], { latency: { cancelMs: 30 } })
    book.submit({ id: 'rest', side: 'buy', type: 'limit', qty: '1', price: '100' }, 2)
    book.cancel('rest', 5)
    book.apply({ type: 'book_delta', ts: 100, instrument: 'BTCUSDT', side: 'bid', action: 'add', price: '98', size: '1' })
    expect(book.report('rest')?.status).toBe('canceled')
    expect(book.hasOpenOrder('rest')).toBe(false)
  })
})

describe('改单', () => {
  it('改单延迟期间旧价格仍然有效（按旧价成交）', () => {
    const book = sim([['99', '5']], [['101', '5']], { latency: { updateMs: 20 } })
    book.submit({ id: 'mv', side: 'buy', type: 'limit', qty: '1', price: '100' }, 2)
    const ack = book.modify('mv', { price: '99' }, 5)
    expect(ack.notes.join(' ')).toContain('在途：改单延迟 20 ms')
    book.apply({ type: 'trade', ts: 10, instrument: 'BTCUSDT', price: '100', size: '1', aggressor: 'sell' })
    expect(book.report('mv')?.fills[0]).toEqual({ price: '100', qty: '1', liquidity: 'maker' })
  })

  it('零延迟改价后被穿越：按新价撮合', () => {
    const book = sim([['98', '5']], [['101', '5']])
    book.submit({ id: 're', side: 'buy', type: 'limit', qty: '1', price: '99' }, 2)
    const report = book.modify('re', { price: '101' }, 3)
    expect(report.status).toBe('filled')
    expect(report.fills[0]).toEqual({ price: '101', qty: '1', liquidity: 'taker' })
  })

  it('改单数量：可以减量，不能小于已成交量', () => {
    const book = sim([['99', '5']], [['101', '5']])
    book.submit({ id: 'q', side: 'buy', type: 'limit', qty: '2', price: '100' }, 2)
    book.apply({ type: 'trade', ts: 3, instrument: 'BTCUSDT', price: '100', size: '1', aggressor: 'sell' })
    const bad = book.modify('q', { qty: '0.5' }, 4)
    expect(bad.reason).toBe('invalid_order')
    const ok = book.modify('q', { qty: '1.5' }, 5)
    expect(ok.remainingQty).toBe('0.5')
    expect(ok.filledQty).toBe('1')
  })

  it('改单校验：未知单 / 空补丁 / 市价单改价都被拒', () => {
    const book = sim([['99', '5']], [['101', '5']])
    expect(book.modify('nope', { price: '100' }, 2).reason).toBe('unknown_order')
    book.submit({ id: 'lim', side: 'buy', type: 'limit', qty: '1', price: '100' }, 2)
    expect(book.modify('lim', {}, 3).reason).toBe('invalid_order')
    book.submit({ id: 'mkt', side: 'buy', type: 'market', qty: '1' }, 4)
    expect(book.modify('mkt', { price: '100' }, 5).reason).toBe('already_terminal')
  })

  it('改价重置队列位置：按新盘口的显示量重记前方量', () => {
    const book = sim([['100', '4'], ['99', '5']], [['101', '5']], { fillModel: 'queue' })
    book.submit({ id: 'q2', side: 'buy', type: 'limit', qty: '1', price: '100' }, 2)
    expect(book.fillModel.aheadOf('q2')).toBe(fx('4'))
    book.modify('q2', { price: '99' }, 3)
    expect(book.fillModel.aheadOf('q2')).toBe(fx('5'))
  })
})

describe('延迟抖动可复现', () => {
  const run = (): { arrivals: Array<number | null>; json: string } => {
    const book = sim([['100', '10']], [['101', '10']], {
      latency: new LatencyModel({ baseMs: 5, insertMs: 20, jitterMs: 10, seed: 424242 }),
    })
    const ids: string[] = []
    for (let i = 0; i < 5; i += 1) {
      const id = `j-${i}`
      ids.push(id)
      book.submit({ id, side: 'buy', type: 'limit', qty: '1', price: '99' }, 10 * (i + 1))
    }
    book.flush(10_000)
    return { arrivals: ids.map((id) => book.arrivalOf(id)), json: JSON.stringify(ids.map((id) => book.report(id))) }
  }

  it('同种子两次跑出同一串到达时刻与同一串回报', () => {
    const a = run()
    const b = run()
    expect(a.arrivals).toEqual(b.arrivals)
    expect(a.json).toBe(b.json)
  })

  it('抖动确实让到达时刻晚于固定延迟', () => {
    const book = sim([['100', '10']], [['101', '10']], { latency: { insertMs: 20, jitterMs: 10, seed: 7 } })
    const offsets: number[] = []
    for (let i = 0; i < 5; i += 1) {
      const id = `j-${i}`
      const ts = 100 * (i + 1)
      book.submit({ id, side: 'buy', type: 'limit', qty: '1', price: '99' }, ts)
      const at = book.arrivalOf(id)
      expect(at).not.toBeNull()
      offsets.push((at as number) - ts)
    }
    for (const offset of offsets) {
      expect(offset).toBeGreaterThanOrEqual(20)
      expect(offset).toBeLessThanOrEqual(30)
    }
    expect(new Set(offsets).size).toBeGreaterThan(1)
  })
})
