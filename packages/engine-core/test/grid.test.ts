// SPDX-License-Identifier: CPAL-1.0
// grid.ts 的单元测试：等差 / 等比格点、单元格与单元格定位、整篮止盈价、三张默认参数表。
import { describe, expect, it } from 'vitest'
import {
  DCA_DEFAULTS,
  GRID_DEFAULTS,
  MARTINGALE_DEFAULTS,
  basketTakeProfit,
  cellIndexFor,
  gridCells,
  gridLevels,
} from '../src/strategy/grid'

const LEVELS = [100, 125, 150, 175, 200]

describe('gridLevels', () => {
  it('等差 100..200 共 5 个价位', () => {
    expect(gridLevels({ lower: 100, upper: 200, count: 5, mode: 'arithmetic' })).toEqual([100, 125, 150, 175, 200])
  })

  it('等比 100..1600 共 5 个价位', () => {
    const levels = gridLevels({ lower: 100, upper: 1600, count: 5, mode: 'geometric' })
    expect(levels.length).toBe(5)
    const expected = [100, 200, 400, 800, 1600]
    for (let i = 0; i < expected.length; i++) {
      expect(levels[i]!).toBeCloseTo(expected[i]!, 8)
    }
  })

  it('count 小于 2 抛 RangeError', () => {
    expect(() => gridLevels({ lower: 100, upper: 200, count: 1, mode: 'arithmetic' })).toThrow(RangeError)
  })

  it('lower 不小于 upper 抛 RangeError', () => {
    expect(() => gridLevels({ lower: 200, upper: 200, count: 5, mode: 'arithmetic' })).toThrow(RangeError)
    expect(() => gridLevels({ lower: 300, upper: 200, count: 5, mode: 'geometric' })).toThrow(RangeError)
  })

  it('非有限参数抛 RangeError', () => {
    expect(() => gridLevels({ lower: Number.NaN, upper: 200, count: 5, mode: 'arithmetic' })).toThrow(RangeError)
    expect(() => gridLevels({ lower: 100, upper: Number.POSITIVE_INFINITY, count: 5, mode: 'arithmetic' })).toThrow(
      RangeError,
    )
  })
})

describe('gridCells', () => {
  it('5 个价位得到 4 个单元', () => {
    const cells = gridCells(LEVELS)
    expect(cells.length).toBe(4)
    expect(cells[0]).toEqual({ index: 0, buy: 100, sell: 125 })
    expect(cells[1]).toEqual({ index: 1, buy: 125, sell: 150 })
    expect(cells[2]).toEqual({ index: 2, buy: 150, sell: 175 })
    expect(cells[3]).toEqual({ index: 3, buy: 175, sell: 200 })
  })
})

describe('cellIndexFor', () => {
  it('落在第二格返回 1', () => {
    expect(cellIndexFor(130, LEVELS)).toBe(1)
  })

  it('上界不含，返回 null', () => {
    expect(cellIndexFor(200, LEVELS)).toBeNull()
  })

  it('低于下界返回 null', () => {
    expect(cellIndexFor(99, LEVELS)).toBeNull()
  })

  it('恰好等于下界返回 0', () => {
    expect(cellIndexFor(100, LEVELS)).toBe(0)
  })
})

describe('basketTakeProfit', () => {
  it('两笔等量持仓按均价加价', () => {
    const tp = basketTakeProfit(
      [
        { size: 1, price: 100 },
        { size: 1, price: 120 },
      ],
      0.05,
    )
    expect(tp).not.toBeNull()
    expect(tp!).toBeCloseTo(115.5, 10)
  })

  it('空数组返回 null', () => {
    expect(basketTakeProfit([], 0.05)).toBeNull()
  })
})

describe('默认参数表', () => {
  const tables: Array<[string, Record<string, number | string | boolean>]> = [
    ['GRID_DEFAULTS', GRID_DEFAULTS],
    ['DCA_DEFAULTS', DCA_DEFAULTS],
    ['MARTINGALE_DEFAULTS', MARTINGALE_DEFAULTS],
  ]

  for (const [name, table] of tables) {
    it(`${name} 键数不少于 3 且值类型合法`, () => {
      const keys = Object.keys(table)
      expect(keys.length).toBeGreaterThanOrEqual(3)
      for (const key of keys) {
        const value = table[key]!
        expect(['number', 'string', 'boolean']).toContain(typeof value)
      }
    })
  }
})
