// SPDX-License-Identifier: CPAL-1.0
// 批 11 收口回归：account/wallet-balance 的 coin[] 里混进空元素 / 非对象元素时，
// 解析必须只丢掉这些坏元素，不抛、也不把整页余额一起丢。
import { describe, expect, it } from 'vitest'
import { parseAccountSnapshot } from '../src/parse'

const NOW = 1_700_000_000_000

describe('b11 coin[] element guard', () => {
  it('skips null / non-object elements and keeps the valid row', () => {
    const snap = parseAccountSnapshot({
      coin: [null, 7, 'USDT', [], { coin: 'USDT', walletBalance: '5', availableToWithdraw: '4' }],
      totalEquity: '5',
    } as never, 'acc_1' as never, NOW as never)
    expect(snap.balances).toHaveLength(1)
    const row = snap.balances[0]!
    expect(row.asset).toBe('USDT')
    expect(row.total).toBe('5')
    expect(row.available).toBe('4')
    expect(row.hold).toBe('1')
  })

  it('returns an empty balance list when every element is null', () => {
    const snap = parseAccountSnapshot({ coin: [null] } as never, 'acc_1' as never, NOW as never)
    expect(snap.balances).toEqual([])
  })
})
