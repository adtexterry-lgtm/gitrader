// SPDX-License-Identifier: CPAL-1.0
// 节点库：数据 · 指标 · 条件 · 模型 · 风控 · 动作 · 输出。纯计算节点的 compute 在这里（对整段 K 线一次算出序列，因果性：第 i 根只用 ≤ i 的数据）；
// 需要账户 / 模型 / 实时行情的节点只声明规格，由实时运行器通过 env.live 提供计算。
import type { Candle } from '../types';
import { emaSeries, priorExtreme, rollingMeanStd } from '../strategy/indicators';
import type { FlowNode, FlowParamDef, NodeSpec, PortSpec, SeriesValue, SignalValue, Value } from './types';

export interface ComputeCtx {
  n: number;
  candles: Candle[];
  node: FlowNode;
  params: Record<string, number | boolean | string>;
  inputs: Record<string, Value | undefined>;
  run: { instrumentId: string; interval: string };
}
type Out = Record<string, Value>;
type Spec = NodeSpec & { compute?: (c: ComputeCtx) => Out };

const P = (name: string, type: PortSpec['type'], label: string, required = true): PortSpec => ({ name, type, label, required });
const num = (key: string, label: string, def: number, min?: number, max?: number, step?: number, help?: string): FlowParamDef => ({ key, label, type: 'number', default: def, min, max, step, help });
const int = (key: string, label: string, def: number, min?: number, max?: number): FlowParamDef => ({ key, label, type: 'integer', default: def, min, max, step: 1 });
const bool = (key: string, label: string, def: boolean): FlowParamDef => ({ key, label, type: 'boolean', default: def });
const sel = (key: string, label: string, def: string, options: string[]): FlowParamDef => ({ key, label, type: 'select', default: def, options });
const str = (key: string, label: string, def = '', help?: string): FlowParamDef => ({ key, label, type: 'string', default: def, help });

// ───────── 取值小工具 ─────────
export const asSeries = (v: Value | undefined, n: number): SeriesValue => {
  if (typeof v === 'number') return new Array(n).fill(v);
  if (v === null || v === undefined) return new Array(n).fill(null);
  if (Array.isArray(v)) return (v as Array<unknown>).map((x) => (typeof x === 'number' ? x : typeof x === 'boolean' ? (x ? 1 : 0) : null));
  if (typeof v === 'object' && 'target' in v) return (v as SignalValue).target.slice();
  return new Array(n).fill(null);
};
const asBool = (v: Value | undefined, n: number): boolean[] => (Array.isArray(v) ? (v as Array<unknown>).map(Boolean) : new Array(n).fill(false));
const nullNum = (n: number): SeriesValue => new Array(n).fill(null);

function smaSeries(values: Array<number | null>, period: number): SeriesValue {
  const out = nullNum(values.length);
  let sum = 0;
  let cnt = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v == null) { sum = 0; cnt = 0; continue; }
    sum += v; cnt += 1;
    if (cnt > period) sum -= values[i - period]!;
    if (cnt >= period) out[i] = sum / period;
  }
  return out;
}
function rsiSeries(values: Array<number | null>, period: number): SeriesValue {
  const out = nullNum(values.length);
  let ag = 0, al = 0;
  for (let i = 1; i < values.length; i++) {
    const a = values[i], b = values[i - 1];
    if (a == null || b == null) continue;
    const d = a - b;
    const g = Math.max(d, 0), l = Math.max(-d, 0);
    if (i <= period) { ag += g / period; al += l / period; if (i === period) out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al); }
    else { ag = (ag * (period - 1) + g) / period; al = (al * (period - 1) + l) / period; out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al); }
  }
  return out;
}
function atrSeries(hi: Array<number | null>, lo: Array<number | null>, cl: Array<number | null>, period: number): SeriesValue {
  const out = nullNum(hi.length);
  let atr = 0;
  for (let i = 1; i < hi.length; i++) {
    const h = hi[i], l = lo[i], pc = cl[i - 1];
    if (h == null || l == null || pc == null) continue;
    const tr = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
    if (i <= period) { atr += tr / period; if (i === period) out[i] = atr; }
    else { atr = (atr * (period - 1) + tr) / period; out[i] = atr; }
  }
  return out;
}
const priorOf = (v: Array<number | null>, period: number, kind: 'max' | 'min'): SeriesValue => priorExtreme(v.map((x) => x ?? NaN), period, kind).map((x) => (x == null || Number.isNaN(x) ? null : x));
const fx = (x: number): string => (Math.abs(x) >= 1000 ? x.toFixed(1) : Math.abs(x) >= 1 ? x.toFixed(2) : x.toPrecision(4));

const cmpOps: Record<string, (a: number, b: number) => boolean> = { '>': (a, b) => a > b, '>=': (a, b) => a >= b, '<': (a, b) => a < b, '<=': (a, b) => a <= b, '==': (a, b) => a === b, '!=': (a, b) => a !== b };

// ───────── 节点规格 ─────────
export const NODE_LIST: Spec[] = [
  // 数据
  {
    kind: 'data.candles', group: 'data', name: 'K 线', desc: '运行标的的 K 线（开 / 高 / 低 / 收 / 量）。instrumentId 留空 = 运行时的标的；周期由运行参数决定。',
    inputs: [], outputs: [P('open', 'series', '开'), P('high', 'series', '高'), P('low', 'series', '低'), P('close', 'series', '收'), P('volume', 'series', '量')], params: [str('instrumentId', '标的（留空 = 运行标的）', '', '一个工作流 v1 只支持一个标的')],
    compute: ({ candles }) => ({ open: candles.map((c) => c.o), high: candles.map((c) => c.h), low: candles.map((c) => c.l), close: candles.map((c) => c.c), volume: candles.map((c) => c.v) }),
  },
  { kind: 'data.quote', group: 'data', name: '实时行情', desc: '当前中间价 / 24h 涨跌 / 小时资金费（实时节点，不能回测）。', inputs: [], outputs: [P('price', 'number', '现价'), P('change24hRatio', 'number', '24h 涨跌（比例）'), P('fundingHourly', 'number', '小时资金费')], params: [], realtimeOnly: true, liveHook: true },
  { kind: 'data.position', group: 'data', name: '持仓', desc: '当前账户在运行标的上的持仓（实时节点，不能回测）：方向 -1/0/1、名义、未实现盈亏占名义的比例。', inputs: [], outputs: [P('side', 'number', '方向'), P('notional', 'number', '名义'), P('unrealizedRatio', 'number', '未实现盈亏比例')], params: [], realtimeOnly: true, liveHook: true },
  // 指标
  { kind: 'math.const', group: 'indicator', name: '常数', desc: '一个固定数值。', inputs: [], outputs: [P('value', 'number', '值')], params: [num('value', '数值', 0)], compute: ({ params }) => ({ value: Number(params.value) }) },
  {
    kind: 'math.op', group: 'indicator', name: '算术', desc: 'a 与 b 逐根做 + − × ÷。', inputs: [P('a', 'series', 'a'), P('b', 'series', 'b')], outputs: [P('out', 'series', '结果')], params: [sel('op', '运算', '+', ['+', '-', '*', '/'])],
    compute: ({ n, params, inputs }) => { const a = asSeries(inputs.a, n), b = asSeries(inputs.b, n); const op = String(params.op); return { out: a.map((x, i) => { const y = b[i]; if (x == null || y == null) return null; return op === '+' ? x + y : op === '-' ? x - y : op === '*' ? x * y : y === 0 ? null : x / y; }) }; },
  },
  { kind: 'ind.ema', group: 'indicator', name: 'EMA', desc: '指数均线。', inputs: [P('src', 'series', '输入')], outputs: [P('out', 'series', 'EMA')], params: [int('period', '周期', 20, 1, 400)], overlay: ['out'], compute: ({ n, params, inputs }) => ({ out: emaSeries(asSeries(inputs.src, n).map((x) => x ?? NaN), Number(params.period)).map((x) => (x == null || Number.isNaN(x) ? null : x)) }) },
  { kind: 'ind.sma', group: 'indicator', name: 'SMA', desc: '简单均线。', inputs: [P('src', 'series', '输入')], outputs: [P('out', 'series', 'SMA')], params: [int('period', '周期', 20, 1, 400)], overlay: ['out'], compute: ({ n, params, inputs }) => ({ out: smaSeries(asSeries(inputs.src, n), Number(params.period)) }) },
  { kind: 'ind.rsi', group: 'indicator', name: 'RSI', desc: '相对强弱指数（Wilder 平滑），0–100。', inputs: [P('src', 'series', '输入')], outputs: [P('out', 'series', 'RSI')], params: [int('period', '周期', 14, 2, 200)], compute: ({ n, params, inputs }) => ({ out: rsiSeries(asSeries(inputs.src, n), Number(params.period)) }) },
  {
    kind: 'ind.bollinger', group: 'indicator', name: '布林带', desc: '中轨 = 均线，上下轨 = 中轨 ± k 倍 σ。', inputs: [P('src', 'series', '输入')], outputs: [P('mid', 'series', '中轨'), P('upper', 'series', '上轨'), P('lower', 'series', '下轨')], params: [int('period', '周期', 20, 2, 400), num('k', '带宽 k', 2, 0.1, 6, 0.1)], overlay: ['mid', 'upper', 'lower'],
    compute: ({ n, params, inputs }) => { const { mean, std } = rollingMeanStd(asSeries(inputs.src, n).map((x) => x ?? 0), Number(params.period)); const k = Number(params.k); return { mid: mean, upper: mean.map((m, i) => (m == null ? null : m + k * std[i]!)), lower: mean.map((m, i) => (m == null ? null : m - k * std[i]!)) }; },
  },
  {
    kind: 'ind.donchian', group: 'indicator', name: '唐奇安通道', desc: '前 N 根（不含当前根）的最高价 / 最低价。', inputs: [P('high', 'series', '高'), P('low', 'series', '低')], outputs: [P('upper', 'series', '上轨'), P('lower', 'series', '下轨')], params: [int('period', '周期', 20, 2, 400)], overlay: ['upper', 'lower'],
    compute: ({ n, params, inputs }) => ({ upper: priorOf(asSeries(inputs.high, n), Number(params.period), 'max'), lower: priorOf(asSeries(inputs.low, n), Number(params.period), 'min') }),
  },
  { kind: 'ind.atr', group: 'indicator', name: 'ATR', desc: '平均真实波幅（Wilder 平滑）。', inputs: [P('high', 'series', '高'), P('low', 'series', '低'), P('close', 'series', '收')], outputs: [P('out', 'series', 'ATR')], params: [int('period', '周期', 14, 2, 200)], compute: ({ n, params, inputs }) => ({ out: atrSeries(asSeries(inputs.high, n), asSeries(inputs.low, n), asSeries(inputs.close, n), Number(params.period)) }) },
  {
    kind: 'ind.grid', group: 'indicator', name: '网格仓位', desc: '把价格映射成目标仓位：在「中心价 ± 区间」内分成若干格，价格越低仓位越大，跌出区间满仓、涨出区间清仓（只做多）。输出信号。',
    inputs: [P('src', 'series', '价格')], outputs: [P('signal', 'signal', '目标仓位')], params: [num('center', '中心价（0 = 第一根收盘价）', 0, 0), num('rangeRatio', '区间半宽（比例）', 0.1, 0.01, 0.5, 0.005), int('grids', '格数', 8, 2, 50), num('maxExposure', '满格占用比例', 1, 0.1, 1, 0.1)],
    compute: ({ n, params, inputs }) => {
      const src = asSeries(inputs.src, n);
      const first = src.find((x) => x != null) ?? 0;
      const center = Number(params.center) > 0 ? Number(params.center) : first;
      const half = Number(params.rangeRatio) * center, lo = center - half, hi = center + half, g = Number(params.grids), ex = Number(params.maxExposure);
      const target = new Array(n).fill(0) as number[], reasons = new Array(n).fill('') as string[];
      if (!(center > 0)) return { signal: { target, reasons } };
      let prev = 0;
      for (let i = 0; i < n; i++) {
        const c = src[i]; if (c == null) continue;
        const p = (c - lo) / (hi - lo);
        const held = Math.min(1, Math.max(0, Math.round((1 - p) * g) / g));
        const t = Number((held * ex).toFixed(6));
        target[i] = t;
        if (Math.abs(t - prev) > 1e-9) reasons[i] = `价 ${fx(c)} 落在第 ${Math.min(g, Math.max(0, Math.round((1 - p) * g)))}/${g} 格（区间 ${fx(lo)}–${fx(hi)}）→ 目标仓位 ${(t * 100).toFixed(0)}%`;
        prev = t;
      }
      return { signal: { target, reasons } };
    },
  },
  {
    kind: 'ind.dca', group: 'indicator', name: '定投仓位', desc: '每隔固定根数买入一份，最多若干份；可设止盈线，到价整笔卖出重来（只做多）。输出信号。',
    inputs: [P('src', 'series', '价格')], outputs: [P('signal', 'signal', '目标仓位')], params: [int('everyBars', '每隔多少根买一次', 24, 1, 1000), int('orders', '最多买几次', 10, 1, 100), num('takeProfitRatio', '止盈线（比例，0 = 不止盈）', 0, 0, 2, 0.005), num('startTs', '起始时间 ms（0 = 从第一根开始）', 0, 0)],
    compute: ({ n, params, inputs, candles }) => {
      const src = asSeries(inputs.src, n);
      const every = Number(params.everyBars), orders = Number(params.orders), tp = Number(params.takeProfitRatio), startTs = Number(params.startTs);
      const target = new Array(n).fill(0) as number[], reasons = new Array(n).fill('') as string[];
      let k = 0, invSum = 0, since = every, prev = 0;
      for (let i = 0; i < n; i++) {
        const c = src[i]; if (c == null) continue;
        if (candles[i]!.t < startTs) continue;
        let why = '';
        if (k > 0 && tp > 0 && c >= (k / invSum) * (1 + tp)) { why = `价 ${fx(c)} 达到止盈线（均价 ${fx(k / invSum)} × ${(1 + tp).toFixed(3)}）→ 全部卖出，重新开始`; k = 0; invSum = 0; since = every; }
        else if (k < orders && since >= every) { k += 1; invSum += 1 / c; since = 0; why = `第 ${k}/${orders} 次定投，价 ${fx(c)}`; }
        since += 1;
        const t = Number((k / orders).toFixed(6));
        target[i] = t;
        if (Math.abs(t - prev) > 1e-9) reasons[i] = why;
        prev = t;
      }
      return { signal: { target, reasons } };
    },
  },
  // 条件
  {
    kind: 'cond.compare', group: 'condition', name: '比较', desc: 'a 与 b 逐根比较；任一为空（指标还没预热）则为否。', inputs: [P('a', 'series', 'a'), P('b', 'series', 'b')], outputs: [P('out', 'bool', '结果')], params: [sel('op', '比较', '>', Object.keys(cmpOps))],
    compute: ({ n, params, inputs }) => { const a = asSeries(inputs.a, n), b = asSeries(inputs.b, n); const f = cmpOps[String(params.op)]!; return { out: a.map((x, i) => (x == null || b[i] == null ? false : f(x, b[i]!))) }; },
  },
  {
    kind: 'cond.cross', group: 'condition', name: '交叉', desc: 'a 上穿 / 下穿 b（上一根在另一侧，这一根越过）。', inputs: [P('a', 'series', 'a'), P('b', 'series', 'b')], outputs: [P('up', 'bool', '上穿'), P('down', 'bool', '下穿')], params: [],
    compute: ({ n, inputs }) => { const a = asSeries(inputs.a, n), b = asSeries(inputs.b, n); const up = new Array(n).fill(false) as boolean[], down = new Array(n).fill(false) as boolean[]; for (let i = 1; i < n; i++) { const a0 = a[i - 1], b0 = b[i - 1], a1 = a[i], b1 = b[i]; if (a0 == null || b0 == null || a1 == null || b1 == null) continue; up[i] = a0 <= b0 && a1 > b1; down[i] = a0 >= b0 && a1 < b1; } return { up, down }; },
  },
  { kind: 'cond.and', group: 'condition', name: '且', desc: '两个条件同时成立。', inputs: [P('a', 'bool', 'a'), P('b', 'bool', 'b')], outputs: [P('out', 'bool', '结果')], params: [], compute: ({ n, inputs }) => { const a = asBool(inputs.a, n), b = asBool(inputs.b, n); return { out: a.map((x, i) => x && b[i]!) }; } },
  { kind: 'cond.or', group: 'condition', name: '或', desc: '两个条件任一成立。', inputs: [P('a', 'bool', 'a'), P('b', 'bool', 'b')], outputs: [P('out', 'bool', '结果')], params: [], compute: ({ n, inputs }) => { const a = asBool(inputs.a, n), b = asBool(inputs.b, n); return { out: a.map((x, i) => x || b[i]!) }; } },
  { kind: 'cond.not', group: 'condition', name: '非', desc: '取反。', inputs: [P('a', 'bool', 'a')], outputs: [P('out', 'bool', '结果')], params: [], compute: ({ n, inputs }) => ({ out: asBool(inputs.a, n).map((x) => !x) }) },
  {
    kind: 'cond.window', group: 'condition', name: '时间窗', desc: 'K 线开盘时间（UTC 小时）落在 [from, to) 内为真；from > to 表示跨零点。', inputs: [], outputs: [P('out', 'bool', '在窗内')], params: [int('fromHour', '起（UTC 小时）', 0, 0, 23), int('toHour', '止（UTC 小时）', 24, 1, 24)],
    compute: ({ candles, params }) => { const f = Number(params.fromHour), t = Number(params.toHour); return { out: candles.map((c) => { const h = new Date(c.t).getUTCHours(); return f <= t ? h >= f && h < t : h >= f || h < t; }) }; },
  },
  {
    kind: 'sig.state', group: 'condition', name: '信号机', desc: '把进场 / 出场条件变成目标仓位信号。level：每根按条件直接给仓位（做多条件成立 = +1，否则做空条件成立 = −1，否则 0）；latch：进场后保持，直到出场条件成立（空仓时才进场，出场那根不再进场）。',
    inputs: [P('enterLong', 'bool', '做多条件', false), P('enterShort', 'bool', '做空条件', false), P('exit', 'bool', '平仓条件', false), P('exitLong', 'bool', '平多条件', false), P('exitShort', 'bool', '平空条件', false)],
    outputs: [P('signal', 'signal', '目标仓位')], params: [sel('mode', '模式', 'level', ['level', 'latch']), bool('allowShort', '允许做空', true)],
    compute: ({ n, params, inputs, node }) => {
      const L = asBool(inputs.enterLong, n), S = asBool(inputs.enterShort, n), X = asBool(inputs.exit, n), XL = asBool(inputs.exitLong, n), XS = asBool(inputs.exitShort, n);
      const allowShort = params.allowShort !== false, latch = params.mode === 'latch';
      const name = node.label ?? '信号机';
      const target = new Array(n).fill(0) as number[], reasons = new Array(n).fill('') as string[];
      let pos = 0;
      for (let i = 0; i < n; i++) {
        let next = pos;
        if (!latch) next = L[i] ? 1 : S[i] && allowShort ? -1 : 0;
        else if (pos !== 0) { if (X[i] || (pos > 0 && XL[i]) || (pos < 0 && XS[i])) next = 0; }
        else if (L[i]) next = 1;
        else if (S[i] && allowShort) next = -1;
        target[i] = next;
        if (next !== pos) reasons[i] = `${name}：${next > 0 ? '做多' : next < 0 ? '做空' : '平仓'}`;
        pos = next;
      }
      return { signal: { target, reasons } };
    },
  },
  // 模型（实时；决策插件只产出决策，不下单）
  { kind: 'model.decision', group: 'model', name: '快速决策模型', desc: '把当前状态问一次快速决策模型，得到 long / short / flat 与置信度（不产文本）。没配置提供方时不产出任何东西。实时节点，不能回测。', inputs: [], outputs: [P('signal', 'signal', '方向'), P('confidence', 'number', '置信度')], params: [sel('provider', '提供方', 'openai-json', ['typesafe-jev', 'openai-json', 'local-laya']), sel('questionType', '问题类型', 'choice', ['choice', 'score', 'noul']), num('minConfidence', '最低置信度', 0.6, 0, 1, 0.05), num('latencyBudgetMs', '延迟预算 ms（0 = 不限）', 0, 0)], realtimeOnly: true, liveHook: true },
  // 风控
  { kind: 'risk.size', group: 'risk', name: '仓位计算', desc: '把目标仓位信号折算成订单意图：目标 × min(权益 × allocRatio, allocCapNotional) 与当前持仓比较，差额超过阈值才出单；方向反了先出平仓单。', inputs: [P('signal', 'signal', '目标仓位')], outputs: [P('order', 'order', '订单意图')], params: [num('allocRatio', '占权益比例', 0.1, 0.001, 1, 0.005), num('allocCapNotional', '单次名义上限', 500, 1), num('leverage', '杠杆', 1, 1, 50)], liveHook: true, sink: false },
  { kind: 'risk.precheck', group: 'risk', name: '风控预检', desc: '用账户的确定性风控闸预检订单意图（不下单）：通过则原样输出，不通过则不输出并记录原因。', inputs: [P('order', 'order', '订单意图')], outputs: [P('order', 'order', '通过的订单'), P('ok', 'bool', '是否通过')], params: [], liveHook: true },
  // 动作
  { kind: 'act.signal', group: 'action', name: '输出信号', desc: '把目标仓位信号写进信号流（目标变化时写一条）。回测以它的输入为策略。', inputs: [P('signal', 'signal', '目标仓位')], outputs: [], params: [str('label', '标签', '')], sink: true },
  { kind: 'act.propose', group: 'action', name: '生成提案', desc: '把订单意图交给宿主作为待批提案（由人批准后才下单）。', inputs: [P('order', 'order', '订单意图')], outputs: [], params: [], sink: true },
  { kind: 'act.order', group: 'action', name: '下单', desc: '提交订单意图。意图照样走运行者的授权书与风控闸：授权级别不够（纸面需 L1+、实盘需 L3+）时由宿主自动转提案，被风控拒绝时不下单。', inputs: [P('order', 'order', '订单意图')], outputs: [], params: [], sink: true },
  { kind: 'act.close', group: 'action', name: '平仓', desc: '条件成立时平掉运行标的的持仓（同样走运行者的授权书与风控闸）。', inputs: [P('when', 'bool', '触发条件')], outputs: [], params: [], sink: true },
  // 输出
  { kind: 'out.log', group: 'output', name: '记录', desc: '把输入的最新值记到运行时记录里。', inputs: [P('value', 'any', '值')], outputs: [], params: [str('label', '标签', '')], sink: true },
  { kind: 'out.notify', group: 'output', name: '通知', desc: '输入为真的那一根，在活动流 / 流水线里记一条通知。', inputs: [P('when', 'bool', '触发条件')], outputs: [], params: [str('message', '通知内容', '工作流触发')], sink: true },
];

export const NODE_SPECS: Record<string, Spec> = Object.fromEntries(NODE_LIST.map((s) => [s.kind, s]));

/** 对外展示用的规格（不含函数）。 */
export function nodeCatalog(): NodeSpec[] {
  return NODE_LIST.map(({ compute: _c, ...rest }) => rest);
}
