// SPDX-License-Identifier: CPAL-1.0
// 挂单成交判定三档的差异：同一串行情下严格 / 队列位置 / 宽松给出不同的成交量；队列位置的递减与清零。
import { describe, expect, it } from 'vitest'
import { fx } from '@gitrader/protocol/decimal'
import { MakerFillJudge, SimBook } from '../src'
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

describe('三档判定：同价成交', () => {
  // 一个买单价 100，挂在买一档（该档显示量 5 = 我们前方的量）。
  function restingAt100(mode: 'conservative' | 'queue' | 'optimistic'): { book: SimBook; id: string } {
    const book = sim([['100', '5'], ['99', '5']], [['101', '5']], { fillModel: mode })
    const id = `m-${mode}`
    book.submit({ id, side: 'buy', type: 'limit', qty: '1', price: '100' }, 2)
    return { book, id }
  }

  it('宽松：同价成交即算成交（触价即成交）', () => {
    const { book, id } = restingAt100('optimistic')
    book.apply({ type: 'trade', ts: 3, instrument: 'BTCUSDT', price: '100', size: '1', aggressor: 'sell' })
    expect(book.report(id)?.filledQty).toBe('1')
    expect(book.report(id)?.fills[0]).toMatchObject({ price: '100', liquidity: 'maker' })
  })

  it('严格：同价成交不算成交，单继续挂着', () => {
    const { book, id } = restingAt100('conservative')
    book.apply({ type: 'trade', ts: 3, instrument: 'BTCUSDT', price: '100', size: '1', aggressor: 'sell' })
    expect(book.report(id)?.filledQty).toBe('0')
    expect(book.hasOpenOrder(id)).toBe(true)
  })

  it('队列位置：同价成交先扣前方 5 手，额度用完不成交', () => {
    const { book, id } = restingAt100('queue')
    expect(book.fillModel.aheadOf(id)).toBe(fx('5'))
    book.apply({ type: 'trade', ts: 3, instrument: 'BTCUSDT', price: '100', size: '3', aggressor: 'sell' })
    expect(book.report(id)?.filledQty).toBe('0')
    expect(book.fillModel.aheadOf(id)).toBe(fx('2'))
  })

  it('队列位置：前方量扣完后的剩余成交量才归我方', () => {
    const { book, id } = restingAt100('queue')
    // 第一笔 5 手刚好扣完前方量，我方仍未成交
    book.apply({ type: 'trade', ts: 3, instrument: 'BTCUSDT', price: '100', size: '5', aggressor: 'sell' })
    expect(book.report(id)?.filledQty).toBe('0')
    expect(book.fillModel.aheadOf(id)).toBe(fx('0'))
    // 第二笔 0.4 手排到队首，全部归我方
    book.apply({ type: 'trade', ts: 4, instrument: 'BTCUSDT', price: '100', size: '0.4', aggressor: 'sell' })
    expect(book.report(id)?.filledQty).toBe('0.4')
  })

  it('队列位置：一笔大成交扣完前方量后把余量给我方', () => {
    const { book, id } = restingAt100('queue')
    book.apply({ type: 'trade', ts: 3, instrument: 'BTCUSDT', price: '100', size: '7', aggressor: 'sell' })
    expect(book.report(id)?.filledQty).toBe('1')
    expect(book.report(id)?.status).toBe('filled')
  })

  it('三档对同一笔同价成交给出三种结果', () => {
    const results = (['conservative', 'queue', 'optimistic'] as const).map((mode) => {
      const { book, id } = restingAt100(mode)
      book.apply({ type: 'trade', ts: 3, instrument: 'BTCUSDT', price: '100', size: '6', aggressor: 'sell' })
      return book.report(id)?.filledQty
    })
    expect(results).toEqual(['0', '1', '1'])
  })
})

describe('三档判定：穿价成交', () => {
  function restingAt100(mode: 'conservative' | 'queue' | 'optimistic'): { book: SimBook; id: string } {
    const book = sim([['100', '5'], ['99', '5']], [['101', '5']], { fillModel: mode })
    const id = `t-${mode}`
    book.submit({ id, side: 'buy', type: 'limit', qty: '1', price: '100' }, 2)
    return { book, id }
  }

  it('严格：成交价穿过限价（99 < 100）才成交，成交价仍是自己的限价', () => {
    const { book, id } = restingAt100('conservative')
    book.apply({ type: 'trade', ts: 3, instrument: 'BTCUSDT', price: '99', size: '1', aggressor: 'sell' })
    expect(book.report(id)?.filledQty).toBe('1')
    expect(book.report(id)?.fills[0]).toMatchObject({ price: '100', qty: '1', liquidity: 'maker' })
  })

  it('队列位置：穿价把前方量清零，同笔成交按剩余额度成交', () => {
    const { book, id } = restingAt100('queue')
    expect(book.fillModel.aheadOf(id)).toBe(fx('5'))
    book.apply({ type: 'trade', ts: 3, instrument: 'BTCUSDT', price: '99', size: '0.6', aggressor: 'sell' })
    expect(book.report(id)?.filledQty).toBe('0.6')
    expect(book.fillModel.aheadOf(id)).toBe(fx('0'))
  })

  it('宽松：穿价当然成交', () => {
    const { book, id } = restingAt100('optimistic')
    book.apply({ type: 'trade', ts: 3, instrument: 'BTCUSDT', price: '98.5', size: '0.3', aggressor: 'sell' })
    expect(book.report(id)?.filledQty).toBe('0.3')
  })

  it('卖单方向对称：卖价 101 挂在卖一，穿价 102 才成交', () => {
    const book = sim([['100', '5']], [['101', '4'], ['102', '5']], { fillModel: 'conservative' })
    book.submit({ id: 'sell-1', side: 'sell', type: 'limit', qty: '1', price: '101' }, 2)
    book.apply({ type: 'trade', ts: 3, instrument: 'BTCUSDT', price: '101', size: '1', aggressor: 'buy' })
    expect(book.report('sell-1')?.filledQty).toBe('0')
    book.apply({ type: 'trade', ts: 4, instrument: 'BTCUSDT', price: '102', size: '1', aggressor: 'buy' })
    expect(book.report('sell-1')?.filledQty).toBe('1')
  })

  it('卖单队列位置：卖一档前方 4 手，同价成交 2 手先扣前方量', () => {
    const book = sim([['100', '5']], [['101', '4'], ['102', '5']], { fillModel: 'queue' })
    book.submit({ id: 'sell-2', side: 'sell', type: 'limit', qty: '1', price: '101' }, 2)
    expect(book.fillModel.aheadOf('sell-2')).toBe(fx('4'))
    book.apply({ type: 'trade', ts: 3, instrument: 'BTCUSDT', price: '101', size: '2', aggressor: 'buy' })
    expect(book.report('sell-2')?.filledQty).toBe('0')
    expect(book.fillModel.aheadOf('sell-2')).toBe(fx('2'))
  })
})

describe('队列位置估计的边界', () => {
  it('挂单价格不在簿上时前方量为 0：一有同价成交就轮到我方', () => {
    const book = sim([['99', '5']], [['101', '5']], { fillModel: 'queue' })
    book.submit({ id: 'below', side: 'buy', type: 'limit', qty: '1', price: '98' }, 2)
    expect(book.fillModel.aheadOf('below')).toBe(fx('0'))
    book.apply({ type: 'trade', ts: 3, instrument: 'BTCUSDT', price: '98', size: '1', aggressor: 'sell' })
    expect(book.report('below')?.filledQty).toBe('1')
  })

  it('成交价没到我们的价：三档都不成交，前方量也不动', () => {
    const book = sim([['100', '5'], ['99', '5']], [['101', '5']], { fillModel: 'queue' })
    book.submit({ id: 'bid-100', side: 'buy', type: 'limit', qty: '1', price: '100' }, 2)
    book.apply({ type: 'trade', ts: 3, instrument: 'BTCUSDT', price: '100.5', size: '2', aggressor: 'sell' })
    expect(book.report('bid-100')?.filledQty).toBe('0')
    expect(book.fillModel.aheadOf('bid-100')).toBe(fx('5'))
  })

  it('同侧主动成交不吃自己的挂单', () => {
    const book = sim([['100', '5'], ['99', '5']], [['101', '5']], { fillModel: 'optimistic' })
    book.submit({ id: 'buy-1', side: 'buy', type: 'limit', qty: '1', price: '100' }, 2)
    book.apply({ type: 'trade', ts: 3, instrument: 'BTCUSDT', price: '100', size: '1', aggressor: 'buy' })
    expect(book.report('buy-1')?.filledQty).toBe('0')
  })

  it('同价两张我方挂单各自按显示量估前方量（重复计前方量，偏悲观）', () => {
    const sim2 = sim([['100', '1'], ['99', '5']], [['101', '5']], { fillModel: 'queue' })
    sim2.submit({ id: 'a', side: 'buy', type: 'limit', qty: '1', price: '100' }, 2)
    sim2.submit({ id: 'b', side: 'buy', type: 'limit', qty: '1', price: '100' }, 2)
    // 3 手：a 先用 1 手扣掉自己估的前方量、再拿 1 手；b 拿到 1 手额度后仍要先扣自己估的 1 手前方量 → 0
    sim2.apply({ type: 'trade', ts: 3, instrument: 'BTCUSDT', price: '100', size: '3', aggressor: 'sell' })
    expect(sim2.report('a')?.filledQty).toBe('1')
    expect(sim2.report('b')?.filledQty).toBe('0')
    expect(sim2.hasOpenOrder('b')).toBe(true)
  })

  it('订单终结后队列估计被清掉', () => {
    const book = sim([['100', '5'], ['99', '5']], [['101', '5']], { fillModel: 'queue' })
    book.submit({ id: 'gone', side: 'buy', type: 'limit', qty: '1', price: '100' }, 2)
    expect(book.fillModel.tracked).toBe(1)
    book.cancel('gone', 3)
    expect(book.fillModel.tracked).toBe(0)
  })
})

describe('判定器单元测试', () => {
  const base = { orderId: 'x', side: 'buy' as const, limit: fx('100'), leaves: fx('1'), budget: fx('1'), tradePrice: fx('100'), tradeSize: fx('1') }

  it('剩余量或额度为 0 时一律不成交', () => {
    const judge = new MakerFillJudge('optimistic')
    expect(judge.judge({ ...base, leaves: fx('0') })).toEqual({ qty: fx('0'), budgetUsed: fx('0') })
    expect(judge.judge({ ...base, budget: fx('0') })).toEqual({ qty: fx('0'), budgetUsed: fx('0') })
  })

  it('未知档位报错', () => {
    expect(() => new MakerFillJudge('aggressive' as never)).toThrow(/未知挂单判定档位/)
  })

  it('队列档位：前方量大于额度时只扣额度，成交为 0', () => {
    const judge = new MakerFillJudge('queue')
    judge.join('x', fx('10'))
    expect(judge.judge({ ...base, budget: fx('0.5') })).toEqual({ qty: fx('0'), budgetUsed: fx('0.5') })
    expect(judge.aheadOf('x')).toBe(fx('9.5'))
  })

  it('严格档位不维护前方量，forget 后仍为 0', () => {
    const judge = new MakerFillJudge('conservative')
    judge.join('x', fx('3'))
    judge.judge({ ...base, tradePrice: fx('99') })
    expect(judge.aheadOf('x')).toBe(fx('3'))
    judge.forget('x')
    expect(judge.aheadOf('x')).toBe(fx('0'))
  })

  it('宽松档位不因前方量而推迟成交', () => {
    const judge = new MakerFillJudge('optimistic')
    judge.join('x', fx('1000'))
    expect(judge.judge(base)).toEqual({ qty: fx('1'), budgetUsed: fx('1') })
  })

  it('卖单判定镜像：成交价 101 触及卖价 101 在宽松档成交、严格档不成交', () => {
    const sellBase = { orderId: 's', side: 'sell' as const, limit: fx('101'), leaves: fx('1'), budget: fx('1'), tradePrice: fx('101'), tradeSize: fx('1') }
    expect(new MakerFillJudge('optimistic').judge(sellBase).qty).toBe(fx('1'))
    expect(new MakerFillJudge('conservative').judge(sellBase).qty).toBe(fx('0'))
  })
})
