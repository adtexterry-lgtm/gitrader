// SPDX-License-Identifier: CPAL-1.0
// 教学示例：双均线交叉。**无业绩含义**——这里只演示策略文件怎么写，不是推荐、不是卖点；默认不加载。
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

/**
 * EMA：ema[0] = values[0]，ema[i] = values[i]·k + ema[i-1]·(1-k)，k = 2/(period+1)。
 * 画线只在 i >= period-1 的位置给值，前面填 null（均线还没「长」够 period 根）。
 */
function emaSeries(values: number[], period: number): Array<number | null> {
  const out: Array<number | null> = new Array(values.length).fill(null);
  if (values.length === 0) return out;
  const k = 2 / (period + 1);
  let e = values[0]!;
  for (let i = 0; i < values.length; i++) {
    if (i > 0) e = values[i]! * k + e * (1 - k);
    if (i >= period - 1) out[i] = e;
  }
  return out;
}

const num = (p: Params, k: string): number => p[k] as number;
const bool = (p: Params, k: string): boolean => p[k] as boolean;
const fx = (x: number): string => (Math.abs(x) >= 1000 ? x.toFixed(1) : Math.abs(x) >= 1 ? x.toFixed(2) : x.toPrecision(4));

function emptySeries(n: number, overlays: SignalSeries['overlays'], warmup: number): SignalSeries {
  return { target: new Array(n).fill(0), reasons: new Array(n).fill(''), overlays, warmup };
}

/** 一次目标变化的说明：交叉方向由两线当前高低决定，动作由「从哪来、到哪去」决定。 */
function reasonAt(fastN: number, slowN: number, f: number, s: number, prev: number, next: number): string {
  const cross = f > s ? '上穿' : '下穿';
  let act: string;
  if (next === 0) act = prev > 0 ? '平多' : '平空';
  else if (next === 1) act = prev === -1 ? '反手做多' : '做多';
  else act = prev === 1 ? '反手做空' : '做空';
  return `EMA${fastN} ${fx(f)} ${cross} EMA${slowN} ${fx(s)} → ${act}`;
}

const strategy: StrategyDef = {
  id: 'ema-cross',
  name: 'EMA cross (teaching example)',
  nameZh: '双均线交叉（教学示例）',
  version: '0.1.0',
  desc: '快线 EMA 上穿慢线 EMA 做多、下穿慢线做空（可关），交叉即反手。趋势行情里跟着均线持仓；横盘时两线反复交叉，会频繁进出。',
  tags: ['趋势', '均线'],
  params: [
    { key: 'fast', label: '快线周期', type: 'integer', default: 12, min: 2, max: 100, step: 1 },
    { key: 'slow', label: '慢线周期', type: 'integer', default: 26, min: 3, max: 400, step: 1 },
    { key: 'allowShort', label: '允许做空', type: 'boolean', default: true },
  ],
  evaluate(candles, p) {
    const closes = candles.map((c) => c.c);
    const fastN = num(p, 'fast');
    const slowN = Math.max(num(p, 'slow'), fastN + 1);
    const allowShort = bool(p, 'allowShort');
    const fastLine = emaSeries(closes, fastN);
    const slowLine = emaSeries(closes, slowN);
    const s = emptySeries(candles.length, { [`EMA${fastN}`]: fastLine, [`EMA${slowN}`]: slowLine }, slowN);
    let pos = 0;
    for (let i = slowN; i < candles.length; i++) {
      const f = fastLine[i];
      const sl = slowLine[i];
      if (f == null || sl == null) continue;
      let next: number;
      if (f > sl) next = 1;
      else if (f < sl) next = allowShort ? -1 : 0;
      else next = pos;
      s.target[i] = next;
      if (next !== pos) s.reasons[i] = reasonAt(fastN, slowN, f, sl, pos, next);
      pos = next;
    }
    return s;
  },
};

export default strategy
