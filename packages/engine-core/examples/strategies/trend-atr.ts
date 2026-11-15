// SPDX-License-Identifier: CPAL-1.0
// 教学示例：均线趋势过滤 + ATR 移动止损。**无业绩含义**——这里只演示策略文件怎么写，不是推荐、不是卖点；默认不加载。
// 想用：复制到 ~/.gitrader/engines/gitrader-core/strategies/ ，引擎会自动校验并热加载。
//
// 参数命名与默认值参考了 QuantDinger（Apache-2.0）的同类策略；各参数的含义见下面 params 里的 help。
//
// 行为要点：快慢 EMA 交叉定方向；开仓时按 收盘 ∓ ATR×倍数 设初始止损，之后止损线单向移动（只朝有利方向走）；
// 收盘触及止损线即离场；离场后要等快慢线方向翻转才允许再进（避免同一段趋势里反复被扫）。

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

/** EMA：k = 2 / (n + 1)，首根直接取值；长度与输入相同。 */
function ema(values: number[], period: number): number[] {
  const out: number[] = [];
  const k = 2 / (period + 1);
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    out.push(i === 0 ? v : out[i - 1]! + k * (v - out[i - 1]!));
  }
  return out;
}

/** 真实波幅：首根为 h − l，之后取 h − l 与相对前收的两个跳空幅度的最大值。 */
function trueRanges(candles: Candle[]): number[] {
  return candles.map((c, i) => {
    const prevC = i === 0 ? c.c : candles[i - 1]!.c;
    return i === 0 ? c.h - c.l : Math.max(c.h - c.l, Math.abs(c.h - prevC), Math.abs(c.l - prevC));
  });
}

/** ATR：第 period − 1 根取前 period 个 TR 的均值，之后 Wilder 平滑；更早的为 null。 */
function atr(tr: number[], period: number): Array<number | null> {
  const out: Array<number | null> = new Array(tr.length).fill(null);
  if (tr.length < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += tr[i]!;
  out[period - 1] = sum / period;
  for (let i = period; i < tr.length; i++) out[i] = (out[i - 1]! * (period - 1) + tr[i]!) / period;
  return out;
}

const num = (p: Params, k: string): number => p[k] as number;
const bool = (p: Params, k: string): boolean => p[k] as boolean;
const fx = (x: number): string => (Math.abs(x) >= 1000 ? x.toFixed(1) : Math.abs(x) >= 1 ? x.toFixed(2) : x.toPrecision(4));

function emptySeries(n: number, overlays: SignalSeries['overlays'], warmup: number): SignalSeries {
  return { target: new Array(n).fill(0), reasons: new Array(n).fill(''), overlays, warmup };
}

const strategy: StrategyDef = {
  id: 'trend-atr',
  name: 'Trend filter with ATR trailing stop (teaching example)',
  nameZh: '均线趋势 + ATR 移动止损（教学示例）',
  version: '0.2.0',
  desc: '快慢 EMA 定方向，顺方向开仓；持仓后按 收盘 ∓ ATR×倍数 单向移动止损，收盘触及止损线即离场，之后要等快慢线方向翻转才允许再进。横盘里快慢线来回交叉、价格反复扫过止损线，会被连续小亏打掉；ATR 变大时止损距离变宽，单笔亏损也随之放大。',
  tags: ['趋势', 'ATR', '移动止损'],
  params: [
    { key: 'emaFast', label: '快线周期（根）', type: 'integer', default: 20, min: 2, max: 200, step: 1 },
    { key: 'emaSlow', label: '慢线周期（根）', type: 'integer', default: 50, min: 3, max: 400, step: 1 },
    { key: 'atrPeriod', label: 'ATR 周期（根）', type: 'integer', default: 14, min: 2, max: 100, step: 1 },
    { key: 'atrMultiple', label: 'ATR 止损倍数', type: 'number', default: 3, min: 0.5, max: 10, step: 0.5 },
    { key: 'allowShort', label: '允许做空', type: 'boolean', default: true },
  ],
  evaluate(candles, p) {
    const closes = candles.map((c) => c.c);
    const fast = num(p, 'emaFast');
    const slowN = Math.max(num(p, 'emaSlow'), fast + 1);
    const period = num(p, 'atrPeriod');
    const mult = num(p, 'atrMultiple');
    const allowShort = bool(p, 'allowShort');
    const emaFastSeries = ema(closes, fast);
    const emaSlowSeries = ema(closes, slowN);
    const atrSeries = atr(trueRanges(candles), period);
    const stopLine: Array<number | null> = new Array(candles.length).fill(null);
    const warmup = Math.max(slowN, period);
    const s = emptySeries(candles.length, { EMA快: emaFastSeries, EMA慢: emaSlowSeries, 止损线: stopLine }, warmup);
    let pos = 0; // 0 = 空仓，+1 = 持多，−1 = 持空
    let stop = 0; // 移动止损价
    let armed = true; // 趋势是否「新鲜」：止损出场后要等快慢线翻转才重新置 true
    let rearm = 0; // 需要看到的方向：+1 = 快线回到慢线上方，−1 = 快线回到慢线下方，0 = 无需翻转
    for (let i = warmup; i < candles.length; i++) {
      const c = closes[i]!;
      const atrNow = atrSeries[i]!;
      // 追踪距离 = atrMultiple × 当前 ATR（对应 QD trailingTpCallbackPct 的位置，但用波动率尺度而不是固定百分比）。
      const dist = mult * atrNow;
      const up = emaFastSeries[i]! > emaSlowSeries[i]!;
      const down = emaFastSeries[i]! < emaSlowSeries[i]!;
      let next = pos;
      let why = '';
      if (pos > 0) {
        // 移动止损只朝有利方向走：多头取 max(旧止损, 收盘 − dist)。
        stop = Math.max(stop, c - dist);
        if (c < stop) {
          next = 0;
          why = `收盘 ${fx(c)} 跌破移动止损 ${fx(stop)} → 平多`;
          armed = false;
          rearm = -1;
        }
      } else if (pos < 0) {
        stop = Math.min(stop, c + dist);
        if (c > stop) {
          next = 0;
          why = `收盘 ${fx(c)} 突破移动止损 ${fx(stop)} → 平空`;
          armed = false;
          rearm = 1;
        }
      } else {
        if (!armed && ((rearm > 0 && up) || (rearm < 0 && down))) {
          armed = true;
          rearm = 0;
        }
        if (armed && up) {
          next = 1;
          stop = c - dist; // 开仓即带初始止损（QD trailingTpActivationPct 的「先盈利再激活」我们不做）
          why = `EMA${fast} > EMA${slowN}，进多，止损 ${fx(stop)}`;
        } else if (armed && down && allowShort) {
          next = -1;
          stop = c + dist;
          why = `EMA${fast} < EMA${slowN}，进空，止损 ${fx(stop)}`;
        }
      }
      s.target[i] = next;
      if (next !== pos) s.reasons[i] = why;
      pos = next;
      stopLine[i] = pos === 0 ? null : stop;
    }
    return s;
  },
};

export default strategy
