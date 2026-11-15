// SPDX-License-Identifier: CPAL-1.0
// 教学示例：唐奇安通道突破。**无业绩含义**——这里只演示策略文件怎么写，不是推荐、不是卖点；默认不加载。
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

function priorExtreme(values: number[], period: number, kind: 'max' | 'min'): Array<number | null> {
  const out: Array<number | null> = new Array(values.length).fill(null);
  for (let i = period; i < values.length; i++) {
    let x = values[i - period]!;
    for (let j = i - period + 1; j < i; j++) x = kind === 'max' ? Math.max(x, values[j]!) : Math.min(x, values[j]!);
    out[i] = x;
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
  id: 'breakout',
  name: 'Breakout, Donchian (teaching example)',
  nameZh: '突破·唐奇安通道（教学示例）',
  version: '0.1.0',
  desc: '收盘价突破前 N 根最高价做多、跌破前 N 根最低价做空，反向跌破较短通道离场。经典海龟式趋势跟随。',
  tags: ['趋势', '突破', '海龟'],
  params: [
    { key: 'entry', label: '入场通道（根）', type: 'integer', default: 20, min: 5, max: 200, step: 1 },
    { key: 'exit', label: '离场通道（根）', type: 'integer', default: 10, min: 2, max: 100, step: 1 },
    { key: 'allowShort', label: '允许做空', type: 'boolean', default: true },
  ],
  evaluate(candles, p) {
    const closes = candles.map((c) => c.c);
    const highs = candles.map((c) => c.h);
    const lows = candles.map((c) => c.l);
    const entry = num(p, 'entry');
    const exit = Math.min(num(p, 'exit'), entry);
    const hiE = priorExtreme(highs, entry, 'max');
    const loE = priorExtreme(lows, entry, 'min');
    const hiX = priorExtreme(highs, exit, 'max');
    const loX = priorExtreme(lows, exit, 'min');
    const s = emptySeries(candles.length, { 入场上轨: hiE, 入场下轨: loE, 离场上轨: hiX, 离场下轨: loX }, entry);
    let pos = 0;
    for (let i = 0; i < candles.length; i++) {
      if (hiE[i] == null || loE[i] == null || hiX[i] == null || loX[i] == null) continue;
      const c = closes[i]!;
      let next = pos;
      let why = '';
      if (pos === 0) {
        if (c > hiE[i]!) { next = 1; why = `收盘 ${fx(c)} 突破前 ${entry} 根最高 ${fx(hiE[i]!)} → 做多`; }
        else if (c < loE[i]! && bool(p, 'allowShort')) { next = -1; why = `收盘 ${fx(c)} 跌破前 ${entry} 根最低 ${fx(loE[i]!)} → 做空`; }
      } else if (pos > 0 && c < loX[i]!) { next = 0; why = `收盘 ${fx(c)} 跌破前 ${exit} 根最低 ${fx(loX[i]!)} → 平多`; }
      else if (pos < 0 && c > hiX[i]!) { next = 0; why = `收盘 ${fx(c)} 突破前 ${exit} 根最高 ${fx(hiX[i]!)} → 平空`; }
      s.target[i] = next;
      if (next !== pos) s.reasons[i] = why;
      pos = next;
    }
    return s;
  },
};

export default strategy
