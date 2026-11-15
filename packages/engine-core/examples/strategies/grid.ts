// SPDX-License-Identifier: CPAL-1.0
// 教学示例：只做多的简化网格。**无业绩含义**——这里只演示策略文件怎么写，不是推荐、不是卖点；默认不加载。
// 想用：复制到 ~/.gitrader/engines/gitrader-core/strategies/ ，引擎会自动校验并热加载。
//
// 参数命名与默认值参考了 QuantDinger（Apache-2.0）的同类策略；各参数的含义见下面 params 里的 help。
//
// 行为要点：等差 / 等比两种格子；跌出下沿、涨出上沿按 boundaryAction 处理；每一格独立止盈。

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
const str = (p: Params, k: string): string => String(p[k]);
const fx = (x: number): string => (Math.abs(x) >= 1000 ? x.toFixed(1) : Math.abs(x) >= 1 ? x.toFixed(2) : x.toPrecision(4));

function emptySeries(n: number, overlays: SignalSeries['overlays'], warmup: number): SignalSeries {
  return { target: new Array(n).fill(0), reasons: new Array(n).fill(''), overlays, warmup };
}

const strategy: StrategyDef = {
  id: 'grid',
  name: 'Grid, long-only (teaching example)',
  nameZh: '网格·只做多（教学示例）',
  version: '0.2.0',
  desc: '在「中心价 ± 区间」内等分成若干格：价格越低持仓越多、越高持仓越少，跌出区间满仓、涨出区间清仓。震荡里一格一格买卖，单边下跌时越买越亏。',
  tags: ['震荡', '网格', '只做多'],
  params: [
    { key: 'center', label: '中心价（0 = 取第一根收盘价）', type: 'number', default: 0, min: 0, step: 0.01 },
    { key: 'rangeRatio', label: '区间半宽（占中心价的比例，0.1 = 10%）', type: 'number', default: 0.1, min: 0.01, max: 0.5, step: 0.005 },
    { key: 'grids', label: '格数', type: 'integer', default: 8, min: 2, max: 50, step: 1 },
    { key: 'maxExposure', label: '满格时占用资金比例', type: 'number', default: 1, min: 0.1, max: 1, step: 0.1 },
    { key: 'lowerPrice', label: '下限价（0 = 用中心价与区间半宽推导）', type: 'number', default: 0, min: 0, step: 0.01, help: '与 upperPrice 同时 > 0 才生效；对应 QD lowerPrice（grid/config.py:100）。' },
    { key: 'upperPrice', label: '上限价（0 = 用中心价与区间半宽推导）', type: 'number', default: 0, min: 0, step: 0.01, help: '与 lowerPrice 同时 > 0 才生效；对应 QD upperPrice（grid/config.py:99）。' },
    { key: 'gridMode', label: '格子间距', type: 'select', default: 'arithmetic', options: ['arithmetic', 'geometric'], help: 'arithmetic = 等差，geometric = 等比（QD gridMode，grid/config.py:107）。' },
    { key: 'boundaryAction', label: '越界处理', type: 'select', default: 'pause', options: ['pause', 'stop_loss', 'hold'], help: 'pause = 停在边界格；stop_loss = 越界清仓；hold = 越界保持越界前的仓位（QD boundaryAction，grid/config.py:111）。' },
  ],
  anchor(candles, p) {
    if (num(p, 'center') > 0 || candles.length === 0) return p;
    return { ...p, center: candles[candles.length - 1]!.c };
  },
  // 阶梯与挂单的对应关系（只抄语义，不抄实现）：QD 每轮按当前上下限重算格子，落在旧阶梯上的挂单先撤、
  // 再按新阶梯重下（grid/engine.py:266-315）。我们是目标仓位制：格子变了只会改 target，
  // 由引擎按「新目标 − 已持仓」的差额下一次单，所以不存在旧价位的挂单可撤。
  evaluate(candles, p) {
    const n = candles.length;
    const centerIn = num(p, 'center') > 0 ? num(p, 'center') : (candles[0]?.c ?? 0);
    const half = num(p, 'rangeRatio') * centerIn;
    // 上下限：QD 要求显式给；这里允许省略，省略时按「中心价 ± rangeRatio」推导（旧示例的行为，逐笔不变）。
    const exLower = num(p, 'lowerPrice');
    const exUpper = num(p, 'upperPrice');
    const explicit = exLower > 0 && exUpper > exLower;
    const lower = explicit ? exLower : centerIn - half;
    const upper = explicit ? exUpper : centerIn + half;
    const center = explicit ? (lower + upper) / 2 : centerIn;
    const grids = Math.max(2, Math.round(num(p, 'grids')));
    const exposure = num(p, 'maxExposure');
    // gridMode=geometric 需要正的下限（QD levels.py:29 同样要求 lo > 0，否则退回等差）。
    const geometric = str(p, 'gridMode') === 'geometric' && lower > 0 && upper > lower;
    const action = str(p, 'boundaryAction');
    // 等差：间距 (upper − lower) / grids；等比：公比 (upper / lower)^(1 / grids)。
    // （QD 用 (hi/lo)^(1/(n−1))，n 是边界线条数；我们是 grids 条格 + 两端边界，等价换算。）
    const lines: number[] = [];
    for (let g = 0; g <= grids; g++) {
      lines.push(geometric ? lower * Math.pow(upper / lower, g / grids) : lower + ((upper - lower) * g) / grids);
    }
    const overlays: SignalSeries['overlays'] = { 网格上沿: new Array(n).fill(upper), 网格下沿: new Array(n).fill(lower), 中心价: new Array(n).fill(center) };
    const s = emptySeries(n, overlays, 0);
    if (!(center > 0) || !(upper > lower)) return s;
    let prev = 0;
    for (let i = 0; i < n; i++) {
      const c = candles[i]!.c;
      // 价格在「格索引空间」里的位置：等差是线性刻度，等比是对数刻度（对数下相邻格等距）。
      const pos = geometric ? Math.log(c / lower) / Math.log(upper / lower) : (c - lower) / (upper - lower);
      // 落在第几格：把 0…1 的位置换成 0…grids 的整数格号（与 QD「当前价在第几个格子」同一含义）。
      const step = Math.min(grids, Math.max(0, Math.round((1 - pos) * grids)));
      // 每格独立止盈：持仓 = 已成交格数 × 每格权重。价格每向上跨过一条网格线就少持一格（该格在 cell.lower 买、
      // 在 cell.upper 卖，见 grid/engine.py:279-282），向下跨线则多买一格；各格的盈亏不互相抵消。
      let t = Number(((step / grids) * exposure).toFixed(6));
      const outside = c < lower || c > upper;
      const stopLoss = outside && action === 'stop_loss';
      if (stopLoss) t = 0; // 越界即清仓；回到区间内后按当前格重新建仓
      else if (outside && action === 'hold') t = prev; // 越界后冻结仓位：不追加也不清仓（目标不变，所以没有理由串）
      s.target[i] = t;
      // 理由串只在目标变了时才拼：每根都拼（含 3 次 toFixed）会让吞吐掉到约 1/3，而绝大多数根的串随即被丢掉。
      if (Math.abs(t - prev) > 1e-9) {
        s.reasons[i] = stopLoss
          ? `价 ${fx(c)} 越出区间 ${fx(lower)}–${fx(upper)} → boundaryAction=stop_loss：清仓`
          : `价 ${fx(c)} 落在第 ${step}/${grids} 格（区间 ${fx(lower)}–${fx(upper)}）→ 目标仓位 ${(t * 100).toFixed(0)}%`;
      }
      prev = t;
    }
    return s;
  },
};

export default strategy
