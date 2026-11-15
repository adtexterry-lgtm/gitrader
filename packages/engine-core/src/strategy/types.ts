// SPDX-License-Identifier: CPAL-1.0
// 策略与回测的类型。策略 = 纯函数：evaluate(candles, params) → 每根 K 线收盘时的「目标仓位」序列。
// 目标仓位 target ∈ [-1, 1]：+1 = 满额做多，-1 = 满额做空，0 = 空仓，0.5 = 半额做多。回测与实例运行器都按「目标仓位变化」下单。
import type { Candle } from '../types';

export type ParamValue = number | boolean | string;
export type Params = Record<string, ParamValue>;

export interface ParamDef {
  key: string;
  label: string;
  type: 'number' | 'integer' | 'boolean' | 'select';
  default: ParamValue;
  min?: number;
  max?: number;
  step?: number;
  options?: string[];   // type = select
  help?: string;
  hidden?: boolean;     // 内部参数，界面不展示
}

/** 策略输出：与 candles 等长。 */
export interface SignalSeries {
  /** target[i] = 第 i 根 K 线收盘时的目标仓位（-1..1）。 */
  target: number[];
  /** reasons[i] = 第 i 根 K 线目标仓位发生变化时的说明（没变化为 ''）。 */
  reasons: string[];
  /** 叠加到价格图上的线（均线 / 布林带 / 通道 / 网格线），与 candles 等长，数据不足为 null。 */
  overlays: Record<string, Array<number | null>>;
  /** 第一根有效信号的下标（之前是指标预热，target 恒为 0）。 */
  warmup: number;
}

/** 内部的策略定义。策略文件导出的对象经 loader 校验后补上 defaults 与来源文件，变成它。 */
export interface StrategyDef {
  id: string;
  name: string;
  nameZh?: string;
  version: string;
  desc: string;
  tags: string[];
  params: ParamDef[];
  /** 由 params 的 default 派生（策略文件里不用写）。 */
  defaults: Params;
  /** 起一个实例（或回测）前，把「锚点」参数固定下来（如网格中心价）。返回补全后的参数；没有锚点的策略不实现。 */
  anchor?(candles: Candle[], params: Params): Params;
  evaluate(candles: Candle[], params: Params): SignalSeries;
  /** 名义额上限（可选）：返回策略自己的硬上限（如机器人的 maxExposureNotional）。引擎换算时用 min(notionalCap, 原有基数)。 */
  notionalCap?(params: Params): number;
  /** 参数校验（可选）：在回测和起实例前调用，raw 是用户传入的原始参数（未合并默认值）。抛错会映射成 INVALID_PARAMS。 */
  validateParams?(raw: Params): void;
  /** 来自哪个策略文件（文件名，不含目录）。 */
  file?: string;
}

export interface BacktestTrade {
  t: number;               // 成交所在 K 线的开盘时间 ms（下一根开盘价成交）
  side: 'buy' | 'sell';
  price: number;
  size: number;            // 币数量
  pnl: number;             // 这笔成交实现的盈亏（已扣本笔手续费）；纯开仓为 -手续费
  fee: number;
  reason: string;
}
