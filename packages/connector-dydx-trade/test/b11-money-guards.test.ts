// SPDX-License-Identifier: CPAL-1.0
// 批 11 收口回归：dYdX 的 order status / fill 行里 id、status 被上游给成对象或数字时，
// 模型字段（venueOrderId / status）必须缺席而不是带着对象流到执行层；fill 退回合成键。
import { describe, expect, it } from 'vitest'
import { parseFills, statusOfOrder } from '../src/account'

describe('b11 order model field guards', () => {
  it('drops object-shaped id / status from the model', () => {
    const r = statusOfOrder({ id: { x: Number.NaN }, status: { s: 1 }, totalFilled: '0' } as never)
    expect('venueOrderId' in r).toBe(false)
    expect('status' in r).toBe(false)
    expect(r.found).toBe(true)
    expect(r.filledSize).toBe('0')
  })

  it('drops numeric id / status from the model', () => {
    const r = statusOfOrder({ id: 12345, status: 7, totalFilled: '0.5' } as never)
    expect('venueOrderId' in r).toBe(false)
    expect('status' in r).toBe(false)
    expect(r.filledSize).toBe('0.5')
  })

  it('keeps string id / status as given', () => {
    const r = statusOfOrder({ id: 'o1', status: 'OPEN', totalFilled: '0.5' } as never)
    expect(r.venueOrderId).toBe('o1')
    expect(r.status).toBe('OPEN')
  })

  it('falls back to a synthetic fill id when id / orderId are objects', () => {
    const fills = parseFills([{
      id: { bad: 1 },
      orderId: { bad: 2 },
      market: 'BTC-USD',
      side: 'BUY',
      liquidity: 'TAKER',
      price: '100',
      size: '1',
      fee: '0',
      createdAt: '2024-05-01T00:00:00.000Z',
      createdAtHeight: '10',
    }] as never)
    const fill = fills[0]!
    expect(fill.venueOrderId).toBe('')
    expect(typeof fill.venueFillId).toBe('string')
    expect(fill.venueFillId.endsWith(':10:1:100')).toBe(true)
  })
})
