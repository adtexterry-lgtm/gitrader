// SPDX-License-Identifier: CPAL-1.0
// 成交累加器：量 / 额 / 加权均价 / 多币种费用 / 去重 / 满仓判定 / 剩余量。
import { describe, expect, it } from 'vitest'
import {
  addFill,
  emptyAccumulator,
  isComplete,
  remaining,
} from '../src/util/fill-accumulator'
import type { FillAccumulator, FillLike } from '../src/util/fill-accumulator'

function accumulate(fills: FillLike[]): FillAccumulator {
  return fills.reduce<FillAccumulator>(addFill, emptyAccumulator())
}

describe('addFill', () => {
  it('两笔成交累加量与额，均价按时加权', () => {
    const acc = accumulate([
      { size: '1', price: '100' },
      { size: '3', price: '104' },
    ])
    expect(acc.filledSize).toBe('4')
    expect(acc.notional).toBe('412')
    expect(acc.avgPrice).toBe('103')
    expect(acc.count).toBe(2)
    expect(acc.seen).toEqual([])
  })

  it('小数成交额与均价保持十进制精度', () => {
    const acc = accumulate([
      { size: '0.1', price: '0.3' },
      { size: '0.2', price: '0.6' },
    ])
    expect(acc.filledSize).toBe('0.3')
    expect(acc.notional).toBe('0.15')
    expect(acc.avgPrice).toBe('0.5')
  })

  it('费用按币种累计，无币种记 UNKNOWN', () => {
    const acc = accumulate([
      { size: '1', price: '100', fee: '0.1', feeCurrency: 'USDC' },
      { size: '1', price: '100', fee: '0.0001', feeCurrency: 'BTC' },
      { size: '1', price: '100', fee: '0.5' },
    ])
    expect(acc.fees).toEqual({ USDC: '0.1', BTC: '0.0001', UNKNOWN: '0.5' })
    expect(acc.count).toBe(3)
  })

  it('同币种费用相加', () => {
    const acc = accumulate([
      { size: '1', price: '100', fee: '0.1', feeCurrency: 'USDC' },
      { size: '1', price: '100', fee: '0.2', feeCurrency: 'usdc' },
    ])
    expect(acc.fees).toEqual({ USDC: '0.3' })
  })

  it('同 id 重复追加只计一次（返回原对象）', () => {
    const first = accumulate([{ size: '2', price: '100', id: 'f-1' }])
    const second = addFill(first, { size: '2', price: '100', id: 'f-1' })
    expect(second).toBe(first)
    expect(second.filledSize).toBe('2')
    expect(second.count).toBe(1)
    expect(second.seen).toEqual(['f-1'])
  })

  it('无 id 的两笔都计入', () => {
    const acc = accumulate([
      { size: '2', price: '100' },
      { size: '3', price: '100' },
    ])
    expect(acc.filledSize).toBe('5')
    expect(acc.count).toBe(2)
    expect(acc.seen).toEqual([])
  })

  it('不改入参：累加器与成交对象都保持原样，返回新对象', () => {
    const base = emptyAccumulator()
    const fill: FillLike = { size: '1', price: '100', fee: '0.1', feeCurrency: 'USDC', id: 'f-1' }
    const snapshot = JSON.parse(JSON.stringify(fill)) as FillLike
    const next = addFill(base, fill)
    expect(next).not.toBe(base)
    expect(fill).toEqual(snapshot)
    expect(base).toEqual(emptyAccumulator())
  })
})

describe('isComplete', () => {
  it('容差内视为满仓', () => {
    const acc = accumulate([{ size: '3.999999', price: '100' }])
    expect(isComplete(acc, '4')).toBe(true)
  })

  it('未达容差不算满仓', () => {
    const acc = accumulate([{ size: '3.99', price: '100' }])
    expect(isComplete(acc, '4')).toBe(false)
  })

  it('status 显式 filled 时直接为 true', () => {
    const acc = emptyAccumulator()
    expect(isComplete(acc, '4', { status: 'filled' })).toBe(true)
    expect(acc.filledSize).toBe('0')
  })

  it('无成交（均价 null）且无 status 为 false', () => {
    expect(isComplete(emptyAccumulator(), '4')).toBe(false)
  })

  it('自定义容差生效', () => {
    const acc = accumulate([{ size: '3.9', price: '100' }])
    expect(isComplete(acc, '4', { tolerance: '0.9' })).toBe(true)
    expect(isComplete(acc, '4', { tolerance: '0.99' })).toBe(false)
  })
})

describe('remaining', () => {
  it('未满时给出差额', () => {
    const acc = accumulate([{ size: '3', price: '100' }])
    expect(remaining(acc, '4')).toBe('1')
  })

  it('超出请求量时为 0', () => {
    const acc = accumulate([{ size: '5', price: '100' }])
    expect(remaining(acc, '4')).toBe('0')
  })
})

describe('非法成交', () => {
  it('size 为 0 抛错且不改累加器', () => {
    const acc = emptyAccumulator()
    expect(() => addFill(acc, { size: '0', price: '100' })).toThrow(Error)
    expect(acc).toEqual(emptyAccumulator())
  })

  it('price 为负抛错且不改入参对象', () => {
    const acc = emptyAccumulator()
    const fill: FillLike = { size: '1', price: '-1' }
    expect(() => addFill(acc, fill)).toThrow(Error)
    expect(fill).toEqual({ size: '1', price: '-1' })
    expect(acc).toEqual(emptyAccumulator())
  })

  it('size 非数值抛错且消息含字段名', () => {
    const acc = emptyAccumulator()
    expect(() => addFill(acc, { size: 'abc', price: '1' })).toThrow(/size/)
  })
})
