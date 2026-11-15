// SPDX-License-Identifier: CPAL-1.0
// 教学示例：马丁加倍（只做多）。**无业绩含义**——这里只演示策略文件怎么写，不是推荐、不是卖点；默认不加载。
// 想用：复制到 ~/.gitrader/engines/gitrader-core/strategies/ ，引擎会自动校验并热加载。
//
// 参数命名与默认值参考了 QuantDinger（Apache-2.0）的同类策略；各参数的含义见下面 params 里的 help。
//
// 行为要点：亏损 → 层数 +1、下一轮按 multiplier 加倍进场；盈利 → 层数归零；层数封顶 maxDoublings；
// 止盈止损都对「本轮入场价」算。连续亏损时仓位指数放大，回撤风险同样指数放大。

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
const fx = (x: number): string => (Math.abs(x) >= 1000 ? x.toFixed(1) : Math.abs(x) >= 1 ? x.toFixed(2) : x.toPrecision(4));

function emptySeries(n: number, overlays: SignalSeries['overlays'], warmup: number): SignalSeries {
  return { target: new Array(n).fill(0), reasons: new Array(n).fill(''), overlays, warmup };
}

const strategy: StrategyDef = {
  id: 'martingale',
  name: 'Martingale, long only (teaching example)',
  nameZh: '马丁加倍·只做多（教学示例）',
  version: '0.2.0',
  desc: '只做多的马丁加倍：每根 K 线空仓就按当前加倍层进场，持仓到止盈线则清仓并把层数归零，持仓到止损线则清仓并把层数加一，下一根按更重的仓位再进。连续亏损时仓位随层数指数放大，回撤与爆仓风险也随之指数放大；这是教学用的反面教材级风险示例，不构成任何收益承诺，请勿照此实盘。',
  tags: ['马丁', '加倍', '高风险'],
  params: [
    { key: 'baseSize', label: '基础仓位（第 0 层）', type: 'number', default: 0.1, min: 0.01, max: 1, step: 0.01 },
    { key: 'multiplier', label: '加倍倍数（每层的加仓倍数）', type: 'number', default: 2, min: 1.1, max: 3, step: 0.1, help: '对应 QD multiplier（strategy_bot_recommend.py:245，默认 2，范围 1.1–3）。' },
    { key: 'maxDoublings', label: '最多加倍层数（封顶）', type: 'integer', default: 3, min: 0, max: 6, step: 1 },
    { key: 'takeProfitPct', label: '止盈线（相对本轮入场价的涨幅，0.01 = 1%）', type: 'number', default: 0.01, min: 0.001, max: 0.5, step: 0.001 },
    { key: 'stopLossPct', label: '止损线（相对本轮入场价的跌幅，0.02 = 2%）', type: 'number', default: 0.02, min: 0.001, max: 0.5, step: 0.001 },
  ],
  evaluate(candles, p) {
    const n = candles.length;
    const base = num(p, 'baseSize');
    // multiplier 缺省按 QD 的默认值 2 处理（直接调 evaluate 传了半个参数对象时不至于算成 NaN）。
    const multIn = num(p, 'multiplier');
    const mult = Number.isFinite(multIn) ? Math.max(1, multIn) : 2;
    const maxDoublings = num(p, 'maxDoublings');
    const tp = num(p, 'takeProfitPct');
    const sl = num(p, 'stopLossPct');
    const entryAt: Array<number | null> = new Array(n).fill(null);
    const tpAt: Array<number | null> = new Array(n).fill(null);
    const slAt: Array<number | null> = new Array(n).fill(null);
    const s = emptySeries(n, { 入场价: entryAt, 止盈价: tpAt, 止损价: slAt }, 1);
    let level = 0;      // 当前加倍层，从 0 起
    let entry = 0;      // 持仓参考价：入场那根的收盘价（教学简化，真实成交在下一根开盘）
    let inPos = false;
    let cur = 0;        // 当前目标仓位
    // 与 QD 的差异（有意保留）：QD 的 layered martingale 在同一个持仓里按 priceDropPct 的跌幅逐层加仓
    // （每层数量 × multiplier），整篮按均价做整体止盈 / 整体止损；本示例是「一层一进、离场后再加倍重进」，
    // 层数只在止损后前进。两者都以 multiplier 指数放大仓位，风险结构相同，结算路径不同。
    for (let i = 1; i < n; i++) {
      const c = candles[i]!.c;
      let next = cur;
      let why = '';
      if (!inPos) {
        // 加仓数量随层数指数递增：baseSize × multiplier^level，封顶 1（满仓）。
        const size = Math.min(1, base * Math.pow(mult, level));
        next = size;
        entry = c;
        inPos = true;
        why = `第 ${level} 层进场 ${fx(size)}，参考价 ${fx(c)}`;
      } else if (c >= entry * (1 + tp)) {
        next = 0;
        inPos = false;
        why = `收盘 ${fx(c)} ≥ 止盈价 ${fx(entry * (1 + tp))} → 止盈，层数归零`;
        level = 0;
      } else if (c <= entry * (1 - sl)) {
        next = 0;
        inPos = false;
        why = `收盘 ${fx(c)} ≤ 止损价 ${fx(entry * (1 - sl))} → 止损，下一轮第 ${Math.min(level + 1, maxDoublings)} 层`;
        level = Math.min(level + 1, maxDoublings);
      }
      s.target[i] = next;
      if (next !== cur) s.reasons[i] = why;
      cur = next;
      if (inPos) {
        entryAt[i] = entry;
        tpAt[i] = entry * (1 + tp);
        slAt[i] = entry * (1 - sl);
      }
    }
    return s;
  },
};

export default strategy
