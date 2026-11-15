// SPDX-License-Identifier: CPAL-1.0
// 教学示例：ATR 通道趋势跟随（Supertrend）。**无业绩含义**——这里只演示策略文件怎么写，不是推荐、不是卖点；默认不加载。
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
const fx = (x: number): string => (Math.abs(x) >= 1000 ? x.toFixed(1) : Math.abs(x) >= 1 ? x.toFixed(2) : x.toPrecision(4));

function emptySeries(n: number, overlays: SignalSeries['overlays'], warmup: number): SignalSeries {
  return { target: new Array(n).fill(0), reasons: new Array(n).fill(''), overlays, warmup };
}

const strategy: StrategyDef = {
  id: 'supertrend',
  name: 'Supertrend, ATR channel (teaching example)',
  nameZh: '超级趋势·ATR 通道（教学示例）',
  version: '0.1.0',
  desc: '以 (最高价 + 最低价) / 2 为中线、ATR 的倍数做通道：收盘站上上轨视为上升趋势做多，跌破下轨视为下降趋势做空（可关闭）。通道随趋势单向收缩，直到被收盘价突破才翻转。失效场景：震荡市里价格反复穿越通道，会频繁翻转并累积手续费损耗。',
  tags: ['趋势', 'ATR', '通道'],
  params: [
    { key: 'period', label: 'ATR 周期', type: 'integer', default: 10, min: 2, max: 100, step: 1 },
    { key: 'multiplier', label: '通道半宽（ATR 倍数）', type: 'number', default: 3, min: 0.5, max: 10, step: 0.5 },
    { key: 'allowShort', label: '允许做空', type: 'boolean', default: true },
  ],
  evaluate(candles, p) {
    const n = candles.length;
    const period = num(p, 'period');
    const multiplier = num(p, 'multiplier');
    const allowShort = bool(p, 'allowShort');
    const upper: Array<number | null> = new Array(n).fill(null);
    const lower: Array<number | null> = new Array(n).fill(null);
    const s = emptySeries(n, { 上轨: upper, 下轨: lower }, period - 1);
    if (n < period) return s;

    // 真实波幅 TR：第一根用当根振幅，之后带上与前收盘的跳空。
    const tr: number[] = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      if (i === 0) { tr[0] = candles[0]!.h - candles[0]!.l; continue; }
      const h = candles[i]!.h;
      const l = candles[i]!.l;
      const pc = candles[i - 1]!.c;
      tr[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
    }

    // ATR：前 period 根取算术平均，之后用 Wilder 平滑。
    const atr: Array<number | null> = new Array(n).fill(null);
    let sum = 0;
    for (let j = 0; j < period; j++) sum += tr[j]!;
    atr[period - 1] = sum / period;
    for (let i = period; i < n; i++) atr[i] = (atr[i - 1]! * (period - 1) + tr[i]!) / period;

    const v = period - 1;
    let prevUpper = 0;
    let prevLower = 0;
    let trendUp = false;
    for (let i = v; i < n; i++) {
      const c = candles[i]!.c;
      const hl2 = (candles[i]!.h + candles[i]!.l) / 2;
      const at = atr[i]!;
      const basicUpper = hl2 + multiplier * at;
      const basicLower = hl2 - multiplier * at;
      let finalUpper = basicUpper;
      let finalLower = basicLower;
      let up: boolean;
      if (i === v) {
        up = c > basicUpper;
      } else {
        const pc = candles[i - 1]!.c;
        finalUpper = basicUpper < prevUpper || pc > prevUpper ? basicUpper : prevUpper;
        finalLower = basicLower > prevLower || pc < prevLower ? basicLower : prevLower;
        up = trendUp ? c >= finalLower : c > finalUpper;
      }
      upper[i] = finalUpper;
      lower[i] = finalLower;
      s.target[i] = up ? 1 : allowShort ? -1 : 0;
      if (i === v) s.reasons[i] = up ? '初始趋势向上' : '初始趋势向下';
      else if (up !== trendUp) {
        s.reasons[i] = up
          ? `收盘 ${fx(c)} 上破上轨 ${fx(finalUpper)} → ${allowShort ? '反手做多' : '做多'}`
          : allowShort
            ? `收盘 ${fx(c)} 下破下轨 ${fx(finalLower)} → 反手做空`
            : `收盘 ${fx(c)} 下破下轨 ${fx(finalLower)} → 平多`;
      }
      prevUpper = finalUpper;
      prevLower = finalLower;
      trendUp = up;
    }
    return s;
  },
};

export default strategy
