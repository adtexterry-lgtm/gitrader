// SPDX-License-Identifier: CPAL-1.0
// 教学示例：布林带均值回归。**无业绩含义**——这里只演示策略文件怎么写，不是推荐、不是卖点；默认不加载。
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

function rollingMeanStd(values: number[], period: number): { mean: Array<number | null>; std: Array<number | null> } {
  const mean: Array<number | null> = new Array(values.length).fill(null);
  const std: Array<number | null> = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += values[j]!;
    const m = sum / period;
    let v = 0;
    for (let j = i - period + 1; j <= i; j++) v += (values[j]! - m) ** 2;
    mean[i] = m;
    std[i] = Math.sqrt(v / period);
  }
  return { mean, std };
}


const num = (p: Params, k: string): number => p[k] as number;
const bool = (p: Params, k: string): boolean => p[k] as boolean;
const fx = (x: number): string => (Math.abs(x) >= 1000 ? x.toFixed(1) : Math.abs(x) >= 1 ? x.toFixed(2) : x.toPrecision(4));

function emptySeries(n: number, overlays: SignalSeries['overlays'], warmup: number): SignalSeries {
  return { target: new Array(n).fill(0), reasons: new Array(n).fill(''), overlays, warmup };
}

const strategy: StrategyDef = {
  id: 'mean-reversion',
  name: 'Mean reversion, Bollinger (teaching example)',
  nameZh: '均值回归·布林带（教学示例）',
  version: '0.1.0',
  desc: '价格跌破布林带下轨做多、突破上轨做空，回到中轨平仓。适合区间震荡，单边行情里会逆势亏损。',
  tags: ['震荡', '反转', '布林带'],
  params: [
    { key: 'period', label: '布林周期', type: 'integer', default: 20, min: 5, max: 200, step: 1 },
    { key: 'k', label: '带宽（σ 倍数）', type: 'number', default: 2, min: 0.5, max: 5, step: 0.1 },
    { key: 'allowShort', label: '允许做空', type: 'boolean', default: true },
  ],
  evaluate(candles, p) {
    const closes = candles.map((c) => c.c);
    const period = num(p, 'period');
    const k = num(p, 'k');
    const { mean, std } = rollingMeanStd(closes, period);
    const upper = mean.map((m, i) => (m == null ? null : m + k * std[i]!));
    const lower = mean.map((m, i) => (m == null ? null : m - k * std[i]!));
    const s = emptySeries(candles.length, { 上轨: upper, 中轨: mean, 下轨: lower }, period - 1);
    let pos = 0;
    for (let i = 0; i < candles.length; i++) {
      const m = mean[i];
      if (m == null) continue;
      const c = closes[i]!;
      const up = upper[i]!;
      const lo = lower[i]!;
      let next = pos;
      let why = '';
      if (pos === 0) {
        if (c < lo) { next = 1; why = `价 ${fx(c)} 跌破下轨 ${fx(lo)} → 做多（等回归中轨 ${fx(m)}）`; }
        else if (c > up && bool(p, 'allowShort')) { next = -1; why = `价 ${fx(c)} 突破上轨 ${fx(up)} → 做空（等回归中轨 ${fx(m)}）`; }
      } else if (pos > 0 && c >= m) { next = 0; why = `价 ${fx(c)} 回到中轨 ${fx(m)} → 平多`; }
      else if (pos < 0 && c <= m) { next = 0; why = `价 ${fx(c)} 回到中轨 ${fx(m)} → 平空`; }
      s.target[i] = next;
      if (next !== pos) s.reasons[i] = why;
      pos = next;
    }
    return s;
  },
};

export default strategy
