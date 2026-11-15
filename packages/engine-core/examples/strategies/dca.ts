// SPDX-License-Identifier: CPAL-1.0
// 教学示例：定投。**无业绩含义**——这里只演示策略文件怎么写，不是推荐、不是卖点；默认不加载。
// 想用：复制到 ~/.gitrader/engines/gitrader-core/strategies/ ，引擎会自动校验并热加载。
//
// 参数命名与默认值参考了 QuantDinger（Apache-2.0）的同类策略；各参数的含义见下面 params 里的 help。
//
// 行为要点：固定周期 + 固定金额（每份 = 总预算 / 份数）；份数上限 = 总额上限；只做多，不择时；
// 设了止盈线就到价整笔卖出并把计数归零，重新开始。

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
  id: 'dca',
  name: 'DCA (teaching example)',
  nameZh: '定投（教学示例）',
  version: '0.2.0',
  desc: '每隔固定根数买入一份，最多买满若干份；可设置止盈线，到价整笔卖出后重新开始。只做多，不择时。',
  tags: ['长期', '只做多', '定投'],
  params: [
    { key: 'everyBars', label: '每隔多少根买一次', type: 'integer', default: 24, min: 1, max: 1000, step: 1 },
    { key: 'orders', label: '最多买几次', type: 'integer', default: 10, min: 1, max: 100, step: 1 },
    { key: 'totalBudgetPct', label: '总预算（占资金比例，100 = 全部）', type: 'number', default: 100, min: 1, max: 100, step: 1, help: '每份 = 总预算 / 最多买几次；对应 QD dca_total_budget_pct（parameter_space.py:59）。' },
    { key: 'takeProfitRatio', label: '止盈线（相对持仓均价的涨幅，0.2 = 20%，0 = 不止盈）', type: 'number', default: 0, min: 0, max: 2, step: 0.005 },
    { key: 'startTs', label: '起始时间（内部，实例启动时自动填，0 = 从第一根开始）', type: 'number', default: 0, min: 0, hidden: true },
  ],
  anchor(candles, p) {
    if (num(p, 'startTs') > 0 || candles.length === 0) return p;
    return { ...p, startTs: candles[candles.length - 1]!.t };
  },
  evaluate(candles, p) {
    const n = candles.length;
    const every = num(p, 'everyBars');
    const orders = num(p, 'orders');
    // 总预算（UI 百分比 → 0–1）。QD 的总额上限就是这样约束的：份数 × 每份 ≤ 总预算（parameter_space.py:129-130）。
    const budgetIn = num(p, 'totalBudgetPct');
    const budget = Number.isFinite(budgetIn) ? Math.min(1, Math.max(0, budgetIn / 100)) : 1;
    const tp = num(p, 'takeProfitRatio');
    const s = emptySeries(n, {}, 0);
    let k = 0;            // 已买份数
    let invSum = 0;       // Σ 1/价格
    let sinceBuy = every; // 第一根就买
    let prev = 0;
    const avg: Array<number | null> = new Array(n).fill(null);
    const startTs = num(p, 'startTs');
    for (let i = 0; i < n; i++) {
      const c = candles[i]!.c;
      let why = '';
      if (candles[i]!.t < startTs) continue; // 实例启动之前的 K 线不参与（target 保持 0）
      if (k > 0 && tp > 0 && c >= (k / invSum) * (1 + tp)) {
        why = `价 ${fx(c)} 达到止盈线（均价 ${fx(k / invSum)} × ${(1 + tp).toFixed(3)}）→ 全部卖出，重新开始`;
        k = 0;
        invSum = 0;
        sinceBuy = every;
      } else if (k < orders && sinceBuy >= every) {
        k += 1;
        invSum += 1 / c;
        sinceBuy = 0;
        why = `第 ${k}/${orders} 次定投，价 ${fx(c)}，每份占总预算的 ${(100 / orders).toFixed(1)}%`;
      }
      sinceBuy += 1;
      // 目标仓位 = 已买份数 / 总份数 × 总预算：固定周期、固定金额，份数买满即停在总额上限。
      const t = Number(((k / orders) * budget).toFixed(6));
      s.target[i] = t;
      avg[i] = k > 0 ? k / invSum : null;
      if (Math.abs(t - prev) > 1e-9) s.reasons[i] = why;
      prev = t;
    }
    s.overlays['持仓均价'] = avg;
    return s;
  },
};

export default strategy
