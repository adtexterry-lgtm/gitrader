// SPDX-License-Identifier: CPAL-1.0
// 基本面比率：口径对齐 QuantDinger 因子目录（services/factors/registry.py:255-261 的 _ratio_last / _last_value），
// 但输入是最新一期的标量（由调用方从财报字段取），输出是纯数值，不做单位换算、不做年化。
// 与 engine-core 的 ta/ 不同：这里没有「序列」，一个函数一次算一个比率，便于直接做因子打分。

import { assertFinite } from './internal'

/** 比率型函数的分母校验：分母为 0 或非有限数则抛 RangeError（负数分母合法，例如净资产为负）。 */
function ratio(numerator: number, denominator: number, label: string): number {
  assertFinite(numerator, `${label}.numerator`)
  assertFinite(denominator, `${label}.denominator`)
  if (denominator === 0) throw new RangeError(`${label}: 分母不能为 0`)
  return numerator / denominator
}

/** 盈利收益率 = 净利润 / 市值（QD: earnings_yield，registry.py:256）。 */
export function earningsYield(netIncome: number, marketCap: number): number {
  return ratio(netIncome, marketCap, 'earningsYield')
}

/** 账面市值比 = 股东权益 / 市值（QD: book_to_price，registry.py:257）。 */
export function bookToPrice(shareholderEquity: number, marketCap: number): number {
  return ratio(shareholderEquity, marketCap, 'bookToPrice')
}

/** 净资产收益率 = 净利润 / 股东权益（QD: return_on_equity，registry.py:258）。 */
export function returnOnEquity(netIncome: number, shareholderEquity: number): number {
  return ratio(netIncome, shareholderEquity, 'returnOnEquity')
}

/** 产权比率 = 总负债 / 股东权益（QD: debt_to_equity，registry.py:260）。 */
export function debtToEquity(totalDebt: number, shareholderEquity: number): number {
  return ratio(totalDebt, shareholderEquity, 'debtToEquity')
}

/** 自由现金流收益率 = 自由现金流 / 市值（QD: free_cash_flow_yield，registry.py:261）。 */
export function freeCashFlowYield(freeCashFlow: number, marketCap: number): number {
  return ratio(freeCashFlow, marketCap, 'freeCashFlowYield')
}

/**
 * 营业收入增长率 = 本期 / 上期 - 1（QD: revenue_growth，registry.py:259 取最新的 revenue_growth 字段）。
 * 上期营收必须为正：基期为负或零时增长率没有定义，抛 RangeError 而不是返回一个误导性的数。
 */
export function revenueGrowth(revenue: number, revenuePrior: number): number {
  assertFinite(revenue, 'revenueGrowth.revenue')
  assertFinite(revenuePrior, 'revenueGrowth.revenuePrior')
  if (revenuePrior <= 0) throw new RangeError(`revenueGrowth: 上期营收必须为正，实际为 ${String(revenuePrior)}`)
  return revenue / revenuePrior - 1
}
