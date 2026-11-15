// SPDX-License-Identifier: CPAL-1.0
// 网格工具：等差 / 等比格点、边界线与单元格、整篮止盈价、网格 / DCA / 马丁默认参数表。

/** 价位保留 8 位小数（与 QD 的 round(..., 8) 一致）。 */
function round8(value: number): number {
  return Math.round(value * 1e8) / 1e8;
}

/**
 * 生成 count 个价位（含两端），升序返回。
 * count < 2、lower >= upper、任一参数非有限 → RangeError。
 */
// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/grid/levels.py:18; adapted.
// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/strategy_runtime/executors.py:245; adapted.
export function gridLevels(opts: {
  lower: number;
  upper: number;
  count: number;
  mode: 'arithmetic' | 'geometric';
}): number[] {
  const { lower, upper, count, mode } = opts;
  if (!Number.isFinite(lower) || !Number.isFinite(upper) || !Number.isFinite(count)) {
    throw new RangeError('gridLevels: 参数必须是有限数');
  }
  if (!Number.isInteger(count) || count < 2) {
    throw new RangeError('gridLevels: count 必须是不小于 2 的整数');
  }
  if (lower >= upper) {
    throw new RangeError('gridLevels: lower 必须小于 upper');
  }
  const steps = count - 1;
  const out: number[] = [];
  if (mode === 'geometric' && lower > 0) {
    const ratio = Math.pow(upper / lower, 1 / steps);
    for (let i = 0; i < count; i++) out.push(round8(lower * Math.pow(ratio, i)));
  } else {
    const step = (upper - lower) / steps;
    for (let i = 0; i < count; i++) out.push(round8(lower + step * i));
  }
  out[0] = round8(lower);
  out[count - 1] = round8(upper);
  return out;
}

export interface GridCell {
  index: number;
  buy: number;
  sell: number;
}

/** 相邻两个价位构成一个单元：buy = 下边界，sell = 上边界；n 个价位 → n−1 个单元。 */
// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/grid/levels.py:43; adapted.
export function gridCells(levels: number[]): GridCell[] {
  const out: GridCell[] = [];
  for (let i = 0; i + 1 < levels.length; i++) {
    out.push({ index: i, buy: levels[i]!, sell: levels[i + 1]! });
  }
  return out;
}

/**
 * price 所在的单元索引（区间 [buy, sell)，左闭右开：价格正好等于上格价时归下一格）；越界返回 null。
 *
 * 区间取左闭右开与 QD `grid/levels.py` 的 (lower, upper] 不同，理由：本实现的
 * `gridLevels` 升序返回价位，且下一格的 buy 等于本格的 sell，左闭右开可让每个价位
 * 只归属一个单元而不重不漏。此差异仅记录约定，不改变行为。
 */
// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/grid/levels.py:43; adapted.
export function cellIndexFor(price: number, levels: number[]): number | null {
  if (!Number.isFinite(price)) return null;
  for (let i = 0; i + 1 < levels.length; i++) {
    const buy = levels[i]!;
    const sell = levels[i + 1]!;
    if (price >= buy && price < sell) return i;
  }
  return null;
}

/** 整篮止盈价：持仓明细 {size, price} 的加权均价 × (1 + pct)；总量 0 → null。 */
// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/strategy_runtime/executors.py:260; adapted.
export function basketTakeProfit(
  positions: { size: number; price: number }[],
  pct: number,
): number | null {
  let totalSize = 0;
  let totalQuote = 0;
  for (const position of positions) {
    const size = position.size;
    if (!Number.isFinite(size) || !Number.isFinite(position.price)) continue;
    totalSize += size;
    totalQuote += size * position.price;
  }
  if (totalSize === 0) return null;
  return (totalQuote / totalSize) * (1 + pct);
}

/** 网格机器人默认参数（QD 键名 grid_mode → gridMode，其余同名 camelCase 化）。 */
// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/strategy_runtime/executors.py:439; adapted.
export const GRID_DEFAULTS: Record<string, number | string | boolean> = {
  side: 'long', // side
  marketType: 'swap', // market_type
  timeframe: '1m', // timeframe
  dynamicAnchor: true, // dynamic_anchor
  startPrice: 0.98, // start_price
  endPrice: 1.02, // end_price
  limitPrice: 0.97, // limit_price
  gridCount: 8, // grid_count
  totalAmountQuote: 8, // total_amount_quote
  initialPositionPct: 0.6, // initial_position_pct
  equityTakeProfitPct: 0.1, // equity_take_profit_pct
  equityStopLossPct: 0.06, // equity_stop_loss_pct
  equityTrailingEnabled: true, // equity_trailing_enabled
  equityTrailingActivationPct: 0.05, // equity_trailing_activation_pct
  equityTrailingCallbackPct: 0.03, // equity_trailing_callback_pct
  maxOpenOrders: 4, // max_open_orders
  gridMode: 'arithmetic', // grid_mode
  minSpreadBetweenOrders: 0.0005, // min_spread_between_orders
};

/** DCA 机器人默认参数。 */
// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/strategy_runtime/executors.py:473; adapted.
export const DCA_DEFAULTS: Record<string, number | string | boolean> = {
  side: 'long', // side
  marketType: 'spot', // market_type
  timeframe: '1H', // timeframe
  dynamicAnchor: true, // dynamic_anchor
  entryPrice: 1, // entry_price
  dcaIntervalMinutes: 1440, // dca_interval_minutes
  dcaMaxOrders: 5, // dca_max_orders
  dcaTotalBudgetPct: 0.95, // dca_total_budget_pct
  dcaPriceFilterEnabled: false, // dca_price_filter_enabled
  dcaMaxAdversePricePct: 0.05, // dca_max_adverse_price_pct
  takeProfitPct: 0.006, // take_profit_pct
  trailingTakeProfitEnabled: true, // trailing_take_profit_enabled
  trailingActivationPct: 0.006, // trailing_activation_pct
  trailingCallbackPct: 0.002, // trailing_callback_pct
  hardStopPct: 0.12, // hard_stop_pct
  equityTakeProfitPct: 0.1, // equity_take_profit_pct
  equityStopLossPct: 0.06, // equity_stop_loss_pct
  equityTrailingEnabled: true, // equity_trailing_enabled
  equityTrailingActivationPct: 0.05, // equity_trailing_activation_pct
  equityTrailingCallbackPct: 0.03, // equity_trailing_callback_pct
  maxEntryDriftPct: 0.03, // max_entry_drift_pct
};

/** 马丁机器人默认参数。 */
// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/strategy_runtime/executors.py:509; adapted.
export const MARTINGALE_DEFAULTS: Record<string, number | string | boolean> = {
  side: 'long', // side
  marketType: 'swap', // market_type
  timeframe: '1m', // timeframe
  dynamicAnchor: true, // dynamic_anchor
  entryPrice: 1, // entry_price
  baseOrderSize: 0.8, // base_order_size
  safetyOrderSize: 1, // safety_order_size
  priceDeviationPct: 0.012, // price_deviation_pct
  stepMultiplier: 1.4, // step_multiplier
  volumeMultiplier: 1.6, // volume_multiplier
  maxLayers: 5, // max_layers
  takeProfitPct: 0.005, // take_profit_pct
  trailingTakeProfitEnabled: true, // trailing_take_profit_enabled
  trailingActivationPct: 0.005, // trailing_activation_pct
  trailingCallbackPct: 0.002, // trailing_callback_pct
  hardStopPct: 0.12, // hard_stop_pct
  equityTakeProfitPct: 0.1, // equity_take_profit_pct
  equityStopLossPct: 0.06, // equity_stop_loss_pct
  equityTrailingEnabled: true, // equity_trailing_enabled
  equityTrailingActivationPct: 0.05, // equity_trailing_activation_pct
  equityTrailingCallbackPct: 0.03, // equity_trailing_callback_pct
  maxEntryDriftPct: 0.03, // max_entry_drift_pct
  restartAfterStop: false, // restart_after_stop
  finalLevelUsesRemainingBudget: true, // final_level_uses_remaining_budget
};
