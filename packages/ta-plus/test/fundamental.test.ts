// SPDX-License-Identifier: CPAL-1.0
// 基本面比率的独立参照值：每条都是【定义 + 手算算术】，输入取自可整除的小整数，期望值可当场心算核对。
// 定义出处：QuantDinger app/services/factors/registry.py:255-261（earnings_yield / book_to_price / return_on_equity /
// debt_to_equity / free_cash_flow_yield / revenue_growth 都是最新一期两个字段的比率），
// 以及这些比率的教科书定义（Graham 的市盈率倒数、账面市值比、ROE、D/E、FCF yield、YoY 增长率）。
// 注意：参照值不来自本包实现，也不来自任何移植代码的输出。
import { describe, expect, it } from 'vitest'
import {
  bookToPrice,
  debtToEquity,
  earningsYield,
  freeCashFlowYield,
  returnOnEquity,
  revenueGrowth,
} from '../src/index'

describe('基本面比率', () => {
  it('earningsYield：净利润 100 / 市值 2500 = 0.04（4% 盈利收益率）', () => {
    expect(earningsYield(100, 2500)).toBeCloseTo(0.04, 12)
  })

  it('bookToPrice：股东权益 500 / 市值 2500 = 0.2', () => {
    expect(bookToPrice(500, 2500)).toBeCloseTo(0.2, 12)
  })

  it('returnOnEquity：净利润 100 / 股东权益 400 = 0.25', () => {
    expect(returnOnEquity(100, 400)).toBeCloseTo(0.25, 12)
  })

  it('debtToEquity：总负债 300 / 股东权益 400 = 0.75', () => {
    expect(debtToEquity(300, 400)).toBeCloseTo(0.75, 12)
  })

  it('freeCashFlowYield：自由现金流 60 / 市值 2500 = 0.024', () => {
    expect(freeCashFlowYield(60, 2500)).toBeCloseTo(0.024, 12)
  })

  it('revenueGrowth：110/100 − 1 = 0.1；90/100 − 1 = −0.1', () => {
    expect(revenueGrowth(110, 100)).toBeCloseTo(0.1, 12)
    expect(revenueGrowth(90, 100)).toBeCloseTo(-0.1, 12)
  })

  it('净资产为负时 ROE 仍按定义给出负值（−100/400 = −0.25）', () => {
    expect(returnOnEquity(-100, 400)).toBeCloseTo(-0.25, 12)
  })

  it('分母为 0 抛 RangeError（而不是返回 Infinity 静默扩散）', () => {
    expect(() => earningsYield(100, 0)).toThrow(RangeError)
    expect(() => returnOnEquity(100, 0)).toThrow(RangeError)
  })

  it('上期营收 ≤ 0 时增长率无定义，抛 RangeError', () => {
    expect(() => revenueGrowth(100, 0)).toThrow(RangeError)
    expect(() => revenueGrowth(100, -50)).toThrow(RangeError)
  })

  it('非有限输入抛 RangeError（NaN 不得静默进因子）', () => {
    expect(() => earningsYield(Number.NaN, 2500)).toThrow(RangeError)
    expect(() => bookToPrice(500, Number.POSITIVE_INFINITY)).toThrow(RangeError)
  })
})
