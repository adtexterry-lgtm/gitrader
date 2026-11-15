// SPDX-License-Identifier: CPAL-1.0
// 批 11 收口回归：
//   · 余额行币种为空串时必须跳过（不能被记成 USDT）；字段全缺时才按 USDT 缺省；
//   · decimalOf 收到 JSON 数字（官方样例的尘埃余额 5.49410817836e-7）时必须走定点文本，
//     不能因为 String() 的科学计数法把整次读账户炸掉。
import { describe, expect, it } from 'vitest'
import { decimalOf, parseAccountSnapshot } from '../src/parse'

const NOW = 1_700_000_000_000

describe('b11 balance row asset', () => {
  it('skips a row whose currency is the empty string', () => {
    const snap = parseAccountSnapshot({
      equity: '10',
      available_margin: '10',
      details: [
        { currency: '', equity: '3', available: '3' },
        { currency: 'USDT', equity: '10', available: '10' },
      ],
    }, 'acc_1' as never, NOW as never)
    expect(snap.balances.map((b) => b.asset)).toEqual(['USDT'])
    expect(snap.balances[0]!.total).toBe('10')
  })

  it('defaults to USDT when both currency fields are missing', () => {
    const snap = parseAccountSnapshot(
      [{ margin_balance: 2, withdraw_available: 1 }],
      'acc_1' as never,
      NOW as never,
      'standard',
    )
    expect(snap.balances[0]!.asset).toBe('USDT')
  })

  it('skips a row whose currency is an object', () => {
    const snap = parseAccountSnapshot({
      details: [{ currency: { x: 1 }, equity: '1', available: '1' }],
    }, 'acc_1' as never, NOW as never)
    expect(snap.balances).toEqual([])
  })
})

describe('b11 decimalOf on JSON numbers', () => {
  it('expands scientific notation from String(number)', () => {
    expect(decimalOf(0.000000549410817836)).toBe('0.000000549410817836')
    expect(decimalOf(-3e-7)).toBe('-0.0000003')
    expect(decimalOf(1e21)).toBe('1000000000000000000000')
    expect(decimalOf(57134.7)).toBe('57134.7')
    expect(decimalOf(Number.NaN)).toBe('0')
    expect(decimalOf('0.10')).toBe('0.1')
  })

  it('parses the official dust balance sample without throwing', () => {
    const snap = parseAccountSnapshot([{
      margin_mode: 'cross',
      margin_account: 'USDT',
      margin_asset: 'USDT',
      margin_balance: 0.000000549410817836,
      margin_static: 0.000000549410817836,
      margin_position: 0,
      margin_frozen: 0,
      profit_real: 0,
      profit_unreal: 0,
      withdraw_available: 0.000000549410817836,
      risk_rate: null,
    }], 'acc_1' as never, NOW as never, 'standard')
    const row = snap.balances[0]!
    expect(row.total).toBe('0.000000549410817836')
    expect(row.asset).toBe('USDT')
  })
})
