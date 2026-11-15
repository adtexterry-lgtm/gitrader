// SPDX-License-Identifier: CPAL-1.0
import { describe, expect, it } from 'vitest'
import { fx, str } from '@gitrader/protocol/decimal'
import { limitCrosses, walkBook } from '../src/book'

const book = { instrumentId: 'hyperliquid:BTC', ts: 1, bids: [{ price: 100, size: 1 }, { price: 99, size: 2 }], asks: [{ price: 101, size: 1 }, { price: 102, size: 2 }] }

describe('walkBook', () => {
  it('buys walk asks upward, sells walk bids downward, weighted average', () => {
    const b = walkBook('buy', fx('2'), book, fx('100.5'), { allowTail: true })
    expect(b.source).toBe('book')
    expect(str(b.filled)).toBe('2')
    expect(str(b.avgPx)).toBe('101.5')
    const s = walkBook('sell', fx('3'), book, fx('100.5'), { allowTail: true })
    expect(str(s.filled)).toBe('3')
    expect(str(s.avgPx, 6)).toBe('99.333333') // (100 + 99 + 99) / 3
  })

  it('shortfall uses last level +/- 0.1%, only for market-style orders', () => {
    const tail = walkBook('buy', fx('5'), book, fx('100.5'), { allowTail: true })
    expect(tail.source).toBe('book+tail')
    expect(str(tail.filled)).toBe('5')
    // 3 张按盘口 101 + 2 x 102 = 305；余 2 张 x 102 x 1.001 = 204.204 -> (305 + 204.204) / 5
    expect(str(tail.avgPx)).toBe('101.8408')
    const limit = walkBook('buy', fx('5'), book, fx('100.5'), { allowTail: false })
    expect(str(limit.filled)).toBe('3')
  })

  it('a price cap is never crossed, not even by the tail', () => {
    const w = walkBook('buy', fx('5'), book, fx('100.5'), { cap: fx('101'), allowTail: true })
    expect(str(w.filled)).toBe('1')
    expect(str(w.avgPx)).toBe('101')
    const none = walkBook('sell', fx('1'), book, fx('100.5'), { cap: fx('100.5'), allowTail: true })
    expect(none.filled).toBe(0n)
  })

  it('no book: mid +/- 5 bps for market orders, nothing for limit orders', () => {
    expect(str(walkBook('buy', fx('1'), undefined, fx('100'), { allowTail: true }).avgPx)).toBe('100.05')
    expect(str(walkBook('sell', fx('1'), undefined, fx('100'), { allowTail: true }).avgPx)).toBe('99.95')
    expect(walkBook('buy', fx('1'), undefined, fx('100'), { allowTail: false }).filled).toBe(0n)
  })

  it('limitCrosses', () => {
    expect(limitCrosses('buy', fx('101'), book)).toBe(true)
    expect(limitCrosses('buy', fx('100.9'), book)).toBe(false)
    expect(limitCrosses('sell', fx('100'), book)).toBe(true)
    expect(limitCrosses('sell', fx('100.1'), book)).toBe(false)
    expect(limitCrosses('buy', fx('1000'), undefined)).toBe(false)
  })
})
