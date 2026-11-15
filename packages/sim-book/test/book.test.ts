// SPDX-License-Identifier: CPAL-1.0
// 盘口状态：快照 / 增量 / 逐笔成交落档，以及「同一档位可吃量只减一次」的流动性台账。
import { describe, expect, it } from 'vitest'
import { fx } from '@gitrader/protocol/decimal'
import { MarketBook } from '../src'
import type { BookLevel, DeltaRecord, LevelTuple, SnapshotRecord, TradeRecord } from '../src'

const P = fx

function snapshot(bids: LevelTuple[], asks: LevelTuple[], ts = 1): SnapshotRecord {
  return { type: 'book_snapshot', ts, instrument: 'BTCUSDT', bids, asks }
}

function delta(over: Partial<DeltaRecord> & Pick<DeltaRecord, 'side' | 'action'>): DeltaRecord {
  return { type: 'book_delta', ts: over.ts ?? 2, instrument: 'BTCUSDT', ...over } as DeltaRecord
}

function trade(price: string, size: string, aggressor: TradeRecord['aggressor'] = 'buy', ts = 3): TradeRecord {
  return { type: 'trade', ts, instrument: 'BTCUSDT', price, size, aggressor }
}

function bookWith(bids: LevelTuple[] = [['100', '5'], ['99', '5']], asks: LevelTuple[] = [['101', '5'], ['102', '5']]): MarketBook {
  const book = new MarketBook()
  book.applySnapshot(snapshot(bids, asks))
  return book
}

describe('快照落档', () => {
  it('买一取最高买价，卖一取最低卖价', () => {
    const book = bookWith()
    expect(book.bestBid()).toBe(P('100'))
    expect(book.bestAsk()).toBe(P('101'))
  })

  it('空卖档时卖一为 null', () => {
    const book = bookWith([['100', '1']], [])
    expect(book.bestAsk()).toBeNull()
    expect(book.isCrossed()).toBe(false)
  })

  it('档位顺序按盘口输出：买档从高到低，卖档从低到高', () => {
    const book = bookWith()
    expect(book.levels('bid').map((level) => level.price)).toEqual([P('100'), P('99')])
    expect(book.levels('ask').map((level) => level.price)).toEqual([P('101'), P('102')])
  })

  it('depth 输出规范十进制文本', () => {
    const book = bookWith([['100.50', '2.0']], [['101', '1']])
    expect(book.depth('bid')).toEqual([{ price: '100.5', size: '2' }])
  })

  it('交叉盘口快照抛 RangeError', () => {
    const book = new MarketBook()
    expect(() => book.applySnapshot(snapshot([['101', '1']], [['101', '1']]))).toThrow(RangeError)
  })

  it('标的与盘口不一致抛 RangeError', () => {
    const book = bookWith()
    expect(() => book.applySnapshot({ ...snapshot([['100', '1']], [['101', '1']]), instrument: 'ETHUSDT' })).toThrow(/标的/)
  })
})

describe('增量', () => {
  it('add 插到正确位置（买档按价格降序）', () => {
    const book = bookWith()
    book.applyDelta(delta({ side: 'bid', action: 'add', price: '99.5', size: '1' }))
    expect(book.levels('bid').map((level) => level.price)).toEqual([P('100'), P('99.5'), P('99')])
  })

  it('add 已存在档位抛 RangeError', () => {
    const book = bookWith()
    expect(() => book.applyDelta(delta({ side: 'bid', action: 'add', price: '100', size: '1' }))).toThrow(/已存在/)
  })

  it('update 改写档位量', () => {
    const book = bookWith()
    book.applyDelta(delta({ side: 'ask', action: 'update', price: '101', size: '9' }))
    expect(book.sizeAt('ask', P('101'))).toBe(P('9'))
  })

  it('update 不存在的档位抛 RangeError', () => {
    const book = bookWith()
    expect(() => book.applyDelta(delta({ side: 'ask', action: 'update', price: '103', size: '1' }))).toThrow(/不存在/)
  })

  it('delete 删档，之后 sizeAt 为 0', () => {
    const book = bookWith()
    book.applyDelta(delta({ side: 'ask', action: 'delete', price: '101' }))
    expect(book.sizeAt('ask', P('101'))).toBe(P('0'))
    expect(book.bestAsk()).toBe(P('102'))
  })

  it('delete 不存在的档位抛 RangeError', () => {
    const book = bookWith()
    expect(() => book.applyDelta(delta({ side: 'ask', action: 'delete', price: '103' }))).toThrow(/不存在/)
  })

  it('clear 清空该侧，另一侧不受影响', () => {
    const book = bookWith()
    book.applyDelta(delta({ side: 'bid', action: 'clear' }))
    expect(book.levels('bid')).toHaveLength(0)
    expect(book.levels('ask')).toHaveLength(2)
  })

  it('add 把新增档位做成交叉盘口时抛 RangeError', () => {
    const book = bookWith([['100', '1']], [['102', '1']])
    expect(() => book.applyDelta(delta({ side: 'ask', action: 'add', price: '100', size: '1' }))).toThrow(/交叉/)
  })
})

describe('流动性台账', () => {
  it('吃掉一部分后该档可吃量按差额减少', () => {
    const book = bookWith([['100', '5']], [['101', '5']])
    expect(book.consume('ask', P('101'), P('2'))).toBe(P('2'))
    expect(book.availableAt('ask', P('101'))).toBe(P('3'))
    expect(book.consumedAt('ask', P('101'))).toBe(P('2'))
  })

  it('吃掉超过可吃量只吃到上限', () => {
    const book = bookWith([['100', '1']], [['101', '1']])
    expect(book.consume('ask', P('101'), P('10'))).toBe(P('1'))
    expect(book.availableAt('ask', P('101'))).toBe(P('0'))
    expect(book.consume('ask', P('101'), P('1'))).toBe(P('0'))
  })

  it('两次吃同一档的消耗累加', () => {
    const book = bookWith([['100', '1']], [['101', '1']])
    book.consume('ask', P('101'), P('0.4'))
    book.consume('ask', P('101'), P('0.4'))
    expect(book.availableAt('ask', P('101'))).toBe(P('0.2'))
  })

  it('小数记账精确（0.1 + 0.2 不产生浮点误差）', () => {
    const book = bookWith([['100', '0.3']], [['101', '1']])
    book.consume('bid', P('100'), P('0.1'))
    book.consume('bid', P('100'), P('0.2'))
    expect(book.availableAt('bid', P('100'))).toBe(P('0'))
  })

  it('价格写法不同但同值（100 与 100.0）共用同一份台账', () => {
    const book = bookWith([['100', '2']], [['101', '1']])
    book.consume('bid', P('100'), P('1'))
    expect(book.availableAt('bid', P('100.0'))).toBe(P('1'))
  })

  it('新快照清空台账（重新报的档位量算新的可吃量）', () => {
    const book = bookWith([['100', '2']], [['101', '1']])
    book.consume('bid', P('100'), P('2'))
    expect(book.availableAt('bid', P('100'))).toBe(P('0'))
    book.applySnapshot(snapshot([['100', '2']], [['101', '1']], 5))
    expect(book.availableAt('bid', P('100'))).toBe(P('2'))
  })

  it('档位量被增量改写后该档台账清零', () => {
    const book = bookWith([['100', '2']], [['101', '1']])
    book.consume('bid', P('100'), P('2'))
    book.applyDelta(delta({ side: 'bid', action: 'update', price: '100', size: '2' }))
    expect(book.availableAt('bid', P('100'))).toBe(P('2'))
  })

  it('delete 掉档位后台账条目一并消失', () => {
    const book = bookWith([['100', '2']], [['101', '1']])
    book.consume('bid', P('100'), P('1'))
    book.applyDelta(delta({ side: 'bid', action: 'delete', price: '100' }))
    expect(book.consumedAt('bid', P('100'))).toBe(P('0'))
  })

  it('resetConsumption 手工清账', () => {
    const book = bookWith()
    book.consume('ask', P('101'), P('1'))
    book.resetConsumption()
    expect(book.availableAt('ask', P('101'))).toBe(P('5'))
  })
})

describe('逐笔成交', () => {
  it('主动买吃掉卖档同价位的挂单量', () => {
    const book = bookWith([['100', '5']], [['101', '5']])
    const result = book.applyTrade(trade('101', '2', 'buy'))
    expect(result.side).toBe('ask')
    expect(result.consumed).toBe(P('2'))
    expect(book.availableAt('ask', P('101'))).toBe(P('3'))
  })

  it('主动卖吃掉买档同价位的挂单量', () => {
    const book = bookWith([['100', '5']], [['101', '5']])
    const result = book.applyTrade(trade('100', '1.5', 'sell'))
    expect(result.side).toBe('bid')
    expect(book.availableAt('bid', P('100'))).toBe(P('3.5'))
  })

  it('成交价没有对应档位时不动台账', () => {
    const book = bookWith()
    expect(book.applyTrade(trade('100.5', '1', 'buy')).consumed).toBe(P('0'))
  })

  it('方向未知时只更新最新价', () => {
    const book = bookWith()
    const result = book.applyTrade(trade('101', '1', 'unknown'))
    expect(result.side).toBeNull()
    expect(book.lastTrade?.price).toBe(P('101'))
    expect(book.availableAt('ask', P('101'))).toBe(P('5'))
  })

  it('最新价与时间戳都记下来', () => {
    const book = bookWith()
    book.applyTrade(trade('101', '1', 'buy', 42))
    expect(book.lastTrade).toEqual({ price: P('101'), size: P('1'), ts: 42, aggressor: 'buy' })
    expect(book.ts).toBe(42)
  })
})

describe('只读视图', () => {
  it('levels 返回副本，外部改动不影响盘口', () => {
    const book = bookWith()
    const levels = book.levels('bid') as BookLevel[]
    levels.pop()
    expect(book.levels('bid')).toHaveLength(2)
  })

  it('hasLevel 判断档位存在', () => {
    const book = bookWith()
    expect(book.hasLevel('ask', P('101'))).toBe(true)
    expect(book.hasLevel('ask', P('103'))).toBe(false)
  })
})
