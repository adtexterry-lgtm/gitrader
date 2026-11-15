// SPDX-License-Identifier: CPAL-1.0
import { formatPrice } from '@nktkas/hyperliquid/utils'
import { describe, expect, it } from 'vitest'
import { fx, str } from '@gitrader/protocol/decimal'
import { isValidPrice, maxPriceDecimals, snapPrice, truncSize } from '../src/precision'

describe('decimal helpers', () => {
  it('parses exponents and keeps canonical output', () => {
    expect(str(fx('1e-7'))).toBe('0.0000001')
    expect(str(fx('83064.50'))).toBe('83064.5')
    expect(str(fx(0.1 + 0.2), 8)).toBe('0.3')
    expect(str(fx('-0.0'))).toBe('0')
  })
})

describe('price rule: <=5 significant figures, <= 6 - szDecimals decimals, integers always valid', () => {
  it('examples (BTC szDecimals 5, ETH 4, DOGE 0)', () => {
    expect(maxPriceDecimals(5)).toBe(1)
    expect(isValidPrice(fx('83064'), 5)).toBe(true) // 整数
    expect(isValidPrice(fx('83064.5'), 5)).toBe(false) // 6 位有效数字
    expect(isValidPrice(fx('8306.4'), 5)).toBe(true)
    expect(isValidPrice(fx('3500.55'), 4)).toBe(false) // 6 位有效数字
    expect(isValidPrice(fx('3500.5'), 4)).toBe(true) // 5 位有效数字，1 位小数 <= 2
    expect(isValidPrice(fx('0.123456'), 0)).toBe(false) // 6 位有效数字
    expect(isValidPrice(fx('0.12345'), 0)).toBe(true)
    expect(isValidPrice(fx('0.1234567'), 0)).toBe(false) // 小数位 7 > 6
  })

  it('snapping matches the official SDK formatPrice (round down) for many random prices', () => {
    let seed = 12345
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
    for (let k = 0; k < 3000; k++) {
      const sz = Math.floor(rnd() * 6)
      const magnitude = 10 ** (Math.floor(rnd() * 9) - 3)
      const raw = (rnd() * magnitude).toFixed(8)
      if (Number(raw) === 0) continue
      let expected: string
      try { expected = formatPrice(raw, sz) } catch { continue }
      expect(str(snapPrice(fx(raw), sz, 'down')), `${raw} sz=${sz}`).toBe(expected)
    }
  })

  it('snapping up never lands below the input and is always a valid price', () => {
    let seed = 99
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
    for (let k = 0; k < 2000; k++) {
      const sz = Math.floor(rnd() * 6)
      const raw = (rnd() * 10 ** (Math.floor(rnd() * 7) - 2)).toFixed(8)
      const p = fx(raw)
      if (p <= 0n) continue
      const up = snapPrice(p, sz, 'up')
      const down = snapPrice(p, sz, 'down')
      if (down > 0n) expect(isValidPrice(down, sz), `down ${raw}`).toBe(true)
      expect(up >= p, `up ${raw} sz=${sz}`).toBe(true)
      expect(isValidPrice(up, sz), `up ${raw} sz=${sz} -> ${str(up)}`).toBe(true)
    }
  })

  it('truncates size toward zero to szDecimals', () => {
    expect(str(truncSize(fx('0.123456789'), 5))).toBe('0.12345')
    expect(str(truncSize(fx('1.999'), 0))).toBe('1')
    expect(str(truncSize(fx('0.000009'), 5))).toBe('0')
  })
})
