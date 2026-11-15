// SPDX-License-Identifier: CPAL-1.0
// 精度 / 张数换算（纯函数）：tick 贴价、步长截断、币数量 ↔ 张数、份额化合约的 X-Gate-Size-Decimal 判定。
import { describe, expect, it } from 'vitest'
import {
  applyBps, contractsToBase, decimalsOf, fxOf, isMultipleOf, signedContracts, snapToTick, toFx, trimZeros, truncateToStep,
} from '../src/precision'
import { clampLimitPrice } from '../src/limit-safety'

describe('tick / 步长', () => {
  it('1. decimalsOf 数小数位', () => {
    expect(decimalsOf('0.1')).toBe(1)
    expect(decimalsOf('1')).toBe(0)
    expect(decimalsOf('0.0001')).toBe(4)
  })

  it('2. truncateToStep 向零截断（0.19 / 0.1 → 0.1）', () => {
    expect(truncateToStep('0.19', '0.1')).toBe('0.1')
    expect(truncateToStep('0.0019', '0.0001')).toBe('0.0019')
    expect(truncateToStep('3', '0.5')).toBe('3')
    expect(truncateToStep('3.7', '0.5')).toBe('3.5')
  })

  it('3. truncateToStep 拒绝非正输入', () => {
    expect(() => truncateToStep('0', '0.1')).toThrow(RangeError)
    expect(() => truncateToStep('1', '0')).toThrow(RangeError)
  })

  it('4. isMultipleOf 认步长整数倍', () => {
    expect(isMultipleOf('0.3', '0.1')).toBe(true)
    expect(isMultipleOf('0.35', '0.1')).toBe(false)
    expect(isMultipleOf('abc', '0.1')).toBe(false)
  })

  it('5. snapToTick down / up 双向（0.15 tick 0.1）', () => {
    expect(snapToTick('0.15', '0.1', 'down')).toBe('0.1')
    expect(snapToTick('0.15', '0.1', 'up')).toBe('0.2')
    expect(snapToTick('0.2', '0.1', 'up')).toBe('0.2')
    expect(snapToTick('0.2', '0.1', 'down')).toBe('0.2')
  })

  it('6. applyBps 上下浮（手算：100 @ 50bps → +0.5）', () => {
    expect(applyBps('100', 50, 'up')).toBe('100.5')
    expect(applyBps('100', 50, 'down')).toBe('99.5')
    expect(applyBps('100', 0, 'up')).toBe('100')
    expect(applyBps('0.0001', 100, 'down')).toBe('0.000099')
  })

  it('7. toFx / fxOf 只认可解析的数', () => {
    expect(toFx('1.5')).not.toBeUndefined()
    expect(toFx('0')).toBeUndefined()
    expect(toFx('-1')).toBeUndefined()
    expect(toFx('')).toBeUndefined()
    expect(toFx(undefined)).toBeUndefined()
    expect(fxOf('-1')).not.toBeUndefined()
    expect(fxOf('x')).toBeUndefined()
  })

  it('8. trimZeros 去尾随 0 与孤立小数点', () => {
    expect(trimZeros('0.100000')).toBe('0.1')
    expect(trimZeros('100')).toBe('100')
    expect(trimZeros('0.000000')).toBe('0')
  })
})

describe('张数换算（QD gate.py:730-782）', () => {
  const btc = { contractSize: '0.0001', orderSizeMin: '1' }

  it('9. 整数张合约：0.01 BTC ÷ 0.0001 = 100 张，不带头', () => {
    expect(signedContracts('0.01', 'buy', btc)).toEqual({ size: '100', decimalHeader: false })
  })

  it('10. 卖方向为负张数（Gate 用 size 符号表示方向）', () => {
    expect(signedContracts('0.01', 'sell', btc)).toEqual({ size: '-100', decimalHeader: false })
  })

  it('11. 不足一张：0.00005 BTC → 0（不发 0 张给场所）', () => {
    expect(signedContracts('0.00005', 'buy', btc)).toEqual({ size: '0', decimalHeader: false })
  })

  it('12. 份额化合约（order_size_min=0.1）：0.5 ETH ÷ 0.01 = 50 张，但仍带小数精度头', () => {
    const eth = { contractSize: '0.01', orderSizeMin: '0.1' }
    expect(signedContracts('0.5', 'buy', eth)).toEqual({ size: '50', decimalHeader: true })
  })

  it('13. 份额化：0.005 ETH = 0.5 张（保留 1 位小数）', () => {
    const eth = { contractSize: '0.01', orderSizeMin: '0.1' }
    expect(signedContracts('0.005', 'buy', eth)).toEqual({ size: '0.5', decimalHeader: true })
  })

  it('14. 份额化：0.0035 ETH 截到 0.3 张（向零）', () => {
    const eth = { contractSize: '0.01', orderSizeMin: '0.1' }
    expect(signedContracts('0.0035', 'buy', eth)).toEqual({ size: '0.3', decimalHeader: true })
  })

  it('15. contractsToBase 反算：100 张 × 0.0001 = 0.01 BTC', () => {
    expect(contractsToBase('100', '0.0001')).toBe('0.01')
    expect(contractsToBase('-250', '0.01')).toBe('-2.5')
  })

  it('16. 双向往返：signedContracts → contractsToBase 回到原量', () => {
    const { size } = signedContracts('0.01', 'buy', btc)
    expect(contractsToBase(size, btc.contractSize)).toBe('0.01')
  })

  it('17. quanto_multiplier 缺失时抛 RangeError（不静默按 1 处理）', () => {
    expect(() => signedContracts('1', 'buy', { contractSize: '0', orderSizeMin: '1' })).toThrow(RangeError)
    expect(() => contractsToBase('1', 'abc')).toThrow(RangeError)
  })
})

describe('可成交限价夹取（HL 包同一函数）', () => {
  it('18. 买单只往下夹（ref 100，band 10bps → 上限 100.1）', () => {
    expect(clampLimitPrice('buy', 101, 100, 10)).toEqual({ price: 100.1, clamped: true })
    expect(clampLimitPrice('buy', 99, 100, 10)).toEqual({ price: 99, clamped: false })
  })

  it('19. 卖单只往上夹（下限 99.9）', () => {
    expect(clampLimitPrice('sell', 98, 100, 10)).toEqual({ price: 99.9, clamped: true })
    expect(clampLimitPrice('sell', 101, 100, 10)).toEqual({ price: 101, clamped: false })
  })

  it('20. ref 非正 / 非有限时原价不动（不猜）', () => {
    expect(clampLimitPrice('buy', 5, 0, 10)).toEqual({ price: 5, clamped: false })
    expect(clampLimitPrice('buy', 5, Number.NaN, 10)).toEqual({ price: 5, clamped: false })
    expect(clampLimitPrice('buy', Number.NaN, 100, 10).clamped).toBe(false)
  })
})
