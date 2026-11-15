// SPDX-License-Identifier: CPAL-1.0
// 测试夹具：ema-cross 的副本，只改 id 为 ema-trend-b，用于测试同账户同标的冲突检查。

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

function emaSeries(values: number[], period: number): Array<number | null> {
  const out: Array<number | null> = new Array(values.length).fill(null);
  if (period < 1 || values.length < period) return out;
  const k = 2 / (period + 1);
  let e = 0;
  for (let i = 0; i < period; i++) e += values[i]!;
  e /= period;
  out[period - 1] = e;
  for (let i = period; i < values.length; i++) {
    e = values[i]! * k + e * (1 - k);
    out[i] = e;
  }
  return out;
}


const num = (p: Params, k: string): number => p[k] as number;
const bool = (p: Params, k: string): boolean => p[k] as boolean;
const fx = (x: number): string => (Math.abs(x) >= 1000 ? x.toFixed(1) : Math.abs(x) >= 1 ? x.toFixed(2) : x.toPrecision(4));

function emptySeries(n: number, overlays: SignalSeries['overlays'], warmup: number): SignalSeries {
  return { target: new Array(n).fill(0), reasons: new Array(n).fill(''), overlays, warmup };
}

const strategy: StrategyDef = {
  id: 'ema-trend-b',
  name: 'EMA cross B (test fixture)',
  nameZh: '均线交叉 B（测试夹具）',
  version: '0.1.0',
  desc: '快线在慢线之上且价格在快线之上做多；快线在慢线之下做空；其余观望。趋势行情里表现好，震荡行情里来回被打脸。',
  tags: ['趋势', '多空', '入门'],
  params: [
    { key: 'fast', label: '快线周期', type: 'integer', default: 20, min: 2, max: 200, step: 1 },
    { key: 'slow', label: '慢线周期', type: 'integer', default: 60, min: 5, max: 400, step: 1 },
    { key: 'allowShort', label: '允许做空', type: 'boolean', default: true },
  ],
  evaluate(candles, p) {
    const closes = candles.map((c) => c.c);
    const fastN = num(p, 'fast');
    const slowN = Math.max(num(p, 'slow'), fastN + 1);
    const fast = emaSeries(closes, fastN);
    const slow = emaSeries(closes, slowN);
    const s = emptySeries(candles.length, { [`EMA${fastN}`]: fast, [`EMA${slowN}`]: slow }, slowN - 1);
    let prev = 0;
    for (let i = 0; i < candles.length; i++) {
      const f = fast[i];
      const sl = slow[i];
      if (f == null || sl == null) continue;
      const c = closes[i]!;
      let t = 0;
      let why = '';
      if (f > sl && c > f) { t = 1; why = `EMA${fastN} ${fx(f)} 在 EMA${slowN} ${fx(sl)} 之上，价 ${fx(c)} 在快线之上 → 做多`; }
      else if (f < sl && bool(p, 'allowShort')) { t = -1; why = `EMA${fastN} ${fx(f)} 在 EMA${slowN} ${fx(sl)} 之下 → 做空`; }
      else why = f > sl ? `快线仍在慢线之上，但价 ${fx(c)} 回落到快线之下 → 观望` : `快线在慢线之下（不做空）→ 观望`;
      s.target[i] = t;
      if (t !== prev) s.reasons[i] = why;
      prev = t;
    }
    return s;
  },
};

export default strategy
