// SPDX-License-Identifier: CPAL-1.0
// 教学示例：变化率（ROC）动量。**无业绩含义**——这里只演示策略文件怎么写，不是推荐、不是卖点；默认不加载。
// 想用：复制到 ~/.gitrader/engines/gitrader-core/strategies/ ，引擎会自动校验并热加载。

// ── 接口（自包含：运行时不 import 任何东西；这些类型只给编辑器 / tsc 看，加载时会被擦掉）──
type Candle = { t: number; o: number; h: number; l: number; c: number; v: number } // t = 开盘时间 ms，已收盘的 K 线
type ParamValue = number | boolean | string
type Params = Record<string, ParamValue>
type ParamDef = { key: string; label: string; type: 'number' | 'integer' | 'boolean' | 'select'; default: ParamValue; min?: number; max?: number; step?: number; options?: string[]; help?: string; hidden?: boolean }
type SignalSeries = { target: number[]; reasons: string[]; overlays: Record<string, Array<number | null>>; warmup: number }
type StrategyDef = {
  id: string; name: string; nameZh?: string; version: string; desc: string; tags: string[]; params: ParamDef[]
  anchor?(candles: Candle[], params: Params): Params
  evaluate(candles: Candle[], params: Params): SignalSeries
}

const num = (p: Params, k: string): number => p[k] as number;
const bool = (p: Params, k: string): boolean => p[k] as boolean;

function emptySeries(n: number, overlays: SignalSeries['overlays'], warmup: number): SignalSeries {
  return { target: new Array(n).fill(0), reasons: new Array(n).fill(''), overlays, warmup };
}

const strategy: StrategyDef = {
  id: 'momentum-roc',
  name: 'Momentum, rate of change (teaching example)',
  nameZh: '动量·变化率（教学示例）',
  version: '0.1.0',
  desc: '收盘价相对 N 根之前的变化率高于阈值做多、低于负阈值做空，回到阈值内平仓。单边趋势里跟随方向；阈值附近来回波动时会反复开平、来回付出成本，横盘里尤其明显。',
  tags: ['动量', 'ROC'],
  params: [
    { key: 'lookback', label: '回看根数', type: 'integer', default: 20, min: 1, max: 400, step: 1 },
    { key: 'threshold', label: '触发阈值', type: 'number', default: 0.02, min: 0.001, max: 1, step: 0.001 },
    { key: 'allowShort', label: '允许做空', type: 'boolean', default: true },
  ],
  evaluate(candles, p) {
    const n = candles.length;
    const closes = candles.map((c) => c.c);
    const lookback = num(p, 'lookback');
    const threshold = num(p, 'threshold');
    const allowShort = bool(p, 'allowShort');
    const roc: Array<number | null> = new Array(n).fill(null);
    for (let i = lookback; i < n; i++) {
      const base = closes[i - lookback]!;
      if (base <= 0) continue;
      roc[i] = closes[i]! / base - 1;
    }
    const s = emptySeries(n, { ROC: roc }, lookback);
    let pos = 0;
    for (let i = 0; i < n; i++) {
      const r = roc[i];
      let next = 0;
      let why = '';
      if (r == null) {
        // 基准价 ≤ 0 时 ROC 不可用：目标回到 0，并给出理由（不能静默平仓）。
        if (next !== pos) why = `ROC${lookback} 不可用（基准价 ≤ 0）→ 平仓`;
      } else if (r > threshold) {
        next = 1;
        if (next !== pos) why = `ROC${lookback} ${(r * 100).toFixed(2)}% > ${(threshold * 100).toFixed(2)}% → 做多`;
      } else if (r < -threshold) {
        if (allowShort) {
          next = -1;
          if (next !== pos) why = `ROC${lookback} ${(r * 100).toFixed(2)}% < -${(threshold * 100).toFixed(2)}% → 做空`;
        } else {
          next = 0;
          if (next !== pos) why = `ROC${lookback} ${(r * 100).toFixed(2)}% < -${(threshold * 100).toFixed(2)}% → 平仓（不允许做空）`;
        }
      } else if (next !== pos) {
        why = `ROC${lookback} ${(r * 100).toFixed(2)}%，|ROC| ≤ ${(threshold * 100).toFixed(2)}% → 平仓`;
      }
      s.target[i] = next;
      if (next !== pos) s.reasons[i] = why;
      pos = next;
    }
    return s;
  },
};

export default strategy
