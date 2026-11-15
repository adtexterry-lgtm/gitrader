// SPDX-License-Identifier: CPAL-1.0
// 教学示例：RSI 均值回归。**无业绩含义**——这里只演示策略文件怎么写，不是推荐、不是卖点；默认不加载。
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

/** RSI 值：平均跌幅为 0 记 100，平均涨幅为 0 记 0，否则用标准公式。 */
function rsiOf(avgGain: number, avgLoss: number): number {
  if (avgLoss === 0) return 100;
  if (avgGain === 0) return 0;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

/** Wilder RSI：首个均值取前 period 根涨跌的算术平均，之后用递推平滑；index < period 为 null。 */
function wilderRsi(closes: number[], period: number): Array<number | null> {
  const out: Array<number | null> = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const change = closes[i]! - closes[i - 1]!;
    avgGain += Math.max(change, 0);
    avgLoss += Math.max(-change, 0);
  }
  avgGain /= period;
  avgLoss /= period;
  out[period] = rsiOf(avgGain, avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i]! - closes[i - 1]!;
    avgGain = (avgGain * (period - 1) + Math.max(change, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-change, 0)) / period;
    out[i] = rsiOf(avgGain, avgLoss);
  }
  return out;
}

const num = (p: Params, k: string): number => p[k] as number;
const bool = (p: Params, k: string): boolean => p[k] as boolean;

function emptySeries(n: number, overlays: SignalSeries['overlays'], warmup: number): SignalSeries {
  return { target: new Array(n).fill(0), reasons: new Array(n).fill(''), overlays, warmup };
}

const strategy: StrategyDef = {
  id: 'rsi-reversion',
  name: 'RSI mean reversion (teaching example)',
  nameZh: 'RSI 均值回归（教学示例）',
  version: '0.1.0',
  desc: 'Wilder RSI 跌破下阈值做多、升破上阈值做空，回到离场线平仓。适合区间震荡；单边趋势里超卖会持续更久，逆势入场容易连续失手。',
  tags: ['均值回归', 'RSI'],
  params: [
    { key: 'period', label: 'RSI 周期', type: 'integer', default: 14, min: 2, max: 100, step: 1 },
    { key: 'lower', label: '做多阈值', type: 'number', default: 30, min: 1, max: 49, step: 1 },
    { key: 'upper', label: '做空阈值', type: 'number', default: 70, min: 51, max: 99, step: 1 },
    { key: 'exitLevel', label: '离场线', type: 'number', default: 50, min: 1, max: 99, step: 1 },
    { key: 'allowShort', label: '允许做空', type: 'boolean', default: true },
  ],
  evaluate(candles, p) {
    const closes = candles.map((c) => c.c);
    const period = num(p, 'period');
    const lower = num(p, 'lower');
    const upper = num(p, 'upper');
    const exitLevel = num(p, 'exitLevel');
    const RSI = wilderRsi(closes, period);
    const s = emptySeries(candles.length, { RSI }, period);
    let pos = 0;
    for (let i = 0; i < candles.length; i++) {
      const r = RSI[i];
      if (i < period || r == null) continue;
      let next = pos;
      let why = '';
      if (pos === 0) {
        if (r < lower) { next = 1; why = `RSI${period} ${r.toFixed(1)} < ${lower} → 做多`; }
        else if (r > upper && bool(p, 'allowShort')) { next = -1; why = `RSI${period} ${r.toFixed(1)} > ${upper} → 做空`; }
      } else if (pos > 0 && r >= exitLevel) { next = 0; why = `RSI${period} ${r.toFixed(1)} ≥ ${exitLevel} → 平多`; }
      else if (pos < 0 && r <= exitLevel) { next = 0; why = `RSI${period} ${r.toFixed(1)} ≤ ${exitLevel} → 平空`; }
      s.target[i] = next;
      if (next !== pos) s.reasons[i] = why;
      pos = next;
    }
    return s;
  },
};

export default strategy
