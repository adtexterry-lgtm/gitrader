// SPDX-License-Identifier: CPAL-1.0
// 成交去重键：稳定、冲突边界、成交号路径与合成路径的分工。
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { fillDedupeKey } from '../src'

const base = { venue: 'binance', orderId: 'oid-1', ts: 1760000000000, size: '0.5', price: '100.25' }

describe('fillDedupeKey', () => {
  it('输出 64 位小写十六进制', () => {
    expect(fillDedupeKey({ ...base, tradeId: 't-1' })).toMatch(/^[0-9a-f]{64}$/)
  })

  it('同输入重复调用同键', () => {
    expect(fillDedupeKey({ ...base, tradeId: 't-1' })).toBe(fillDedupeKey({ ...base, tradeId: 't-1' }))
  })

  it('venue 大小写与空格归一后同键', () => {
    expect(fillDedupeKey({ ...base, tradeId: 't-1', venue: 'BINANCE ' })).toBe(
      fillDedupeKey({ ...base, tradeId: 't-1' }),
    )
  })

  it('数量写法不同但数值相同 → 同键（0.50 与 0.5）', () => {
    const a = fillDedupeKey({ ...base, tradeId: undefined, size: '0.50' })
    const b = fillDedupeKey({ ...base, size: '0.5' })
    expect(a).toBe(b)
  })

  it('数量不同 → 不同键（合成路径吃数量）', () => {
    expect(fillDedupeKey({ ...base, size: '0.5' })).not.toBe(fillDedupeKey({ ...base, size: '0.6' }))
  })

  it('时间不同 → 不同键', () => {
    expect(fillDedupeKey(base)).not.toBe(fillDedupeKey({ ...base, ts: base.ts + 1 }))
  })

  it('成交号不同 → 不同键', () => {
    expect(fillDedupeKey({ ...base, tradeId: 't-1' })).not.toBe(fillDedupeKey({ ...base, tradeId: 't-2' }))
  })

  it('成交号路径不吃数量 / 价格（同一笔成交从三条路径报来也要合并）', () => {
    expect(fillDedupeKey({ ...base, tradeId: 't-1', size: '0.9', price: '1' })).toBe(
      fillDedupeKey({ ...base, tradeId: 't-1' }),
    )
  })

  it('同成交号不同 venue → 不同键', () => {
    expect(fillDedupeKey({ ...base, tradeId: 't-1' })).not.toBe(
      fillDedupeKey({ ...base, tradeId: 't-1', venue: 'okx' }),
    )
  })

  it('键就是 v1|venue|orderId|tradeId 的 sha256，可与外部对账', () => {
    const expected = createHash('sha256')
      .update(JSON.stringify(['v1', 'binance', 'oid-1', 't-1']), 'utf8')
      .digest('hex')
    expect(fillDedupeKey({ ...base, tradeId: 't-1' })).toBe(expected)
  })

  it('缺 venue / 订单号、时间非有限都抛 RangeError', () => {
    expect(() => fillDedupeKey({ ...base, venue: ' ' })).toThrow(RangeError)
    expect(() => fillDedupeKey({ ...base, orderId: '' })).toThrow(RangeError)
    expect(() => fillDedupeKey({ ...base, ts: Number.NaN })).toThrow(RangeError)
  })
})
