// SPDX-License-Identifier: CPAL-1.0
// 测试夹具 + examples/workflows 的来源：五个策略改写成的工作流（保留原策略 id：meta.strategyId）。回测结果与原策略逐笔一致（test/flow.test.ts 验证）。
import type { FlowEdge, FlowNode, FlowParamDef, Workflow } from '../../src/flow/types';

type NP = FlowNode['params'];
const node = (id: string, type: string, x: number, y: number, params: NP = {}, label?: string): FlowNode => ({ id, type, params, position: { x, y }, ...(label ? { label } : {}) });
const edge = (from: string, to: string): FlowEdge => {
  const [fn, fp] = from.split('.');
  const [tn, tp] = to.split('.');
  return { from: { node: fn!, port: fp! }, to: { node: tn!, port: tp! } };
};
const pd = (key: string, label: string, def: number | boolean, extra: Partial<FlowParamDef> = {}): FlowParamDef => ({ key, label, type: typeof def === 'boolean' ? 'boolean' : Number.isInteger(def) ? 'integer' : 'number', default: def, ...extra });

const base = (id: string, strategyId: string, name: string, desc: string, tags: string[], params: Workflow['params'], paramDefs: FlowParamDef[], nodes: FlowNode[], edges: FlowEdge[]): Workflow => ({
  schema: 'gitrader-workflow/2', id, name, desc, version: 1, params, paramDefs, nodes, edges,
  meta: { source: { author: 'Gitrader', license: 'CPAL-1.0' }, builtin: true, strategyId, tags },
});

/** 公共尾巴：信号机 → 输出信号 → 仓位计算 → 风控预检 → 下单（实时运行时按权限执行；回测以「输出信号」为策略）。 */
const tail = (sigNode: string, y: number): { nodes: FlowNode[]; edges: FlowEdge[] } => ({
  nodes: [
    node('out_signal', 'act.signal', 760, y, {}, '输出信号'),
    node('size', 'risk.size', 760, y + 120, { allocRatio: 0.1, allocCapNotional: 500, leverage: 1 }, '仓位计算'),
    node('precheck', 'risk.precheck', 960, y + 120, {}, '风控预检'),
    node('place', 'act.order', 1160, y + 120, {}, '下单'),
  ],
  edges: [edge(`${sigNode}.signal`, 'out_signal.signal'), edge(`${sigNode}.signal`, 'size.signal'), edge('size.order', 'precheck.order'), edge('precheck.order', 'place.order')],
});

function emaTrend(): Workflow {
  const t = tail('sig', 40);
  return base('tpl.ema-trend', 'ema-trend', '均线趋势（教学示例）', '快线在慢线之上且价格在快线之上做多；快线在慢线之下做空；其余观望。', ['趋势', '多空', '入门'],
    { fast: 20, slow: 60, allowShort: true }, [pd('fast', '快线周期', 20, { min: 2, max: 200 }), pd('slow', '慢线周期', 60, { min: 5, max: 400 }), pd('allowShort', '允许做空', true)],
    [
      node('k', 'data.candles', 20, 120, {}, 'K 线'),
      node('ema_f', 'ind.ema', 240, 40, { period: '$fast' }, '快线'), node('ema_s', 'ind.ema', 240, 200, { period: '$slow' }, '慢线'),
      node('f_gt_s', 'cond.compare', 440, 20, { op: '>' }, '快 > 慢'), node('c_gt_f', 'cond.compare', 440, 120, { op: '>' }, '价 > 快'), node('long', 'cond.and', 600, 70, {}, '做多'),
      node('f_lt_s', 'cond.compare', 440, 240, { op: '<' }, '快 < 慢'),
      node('sig', 'sig.state', 760, 150, { mode: 'level', allowShort: '$allowShort' }, '均线趋势'), ...t.nodes.map((x) => ({ ...x, position: { x: x.position!.x, y: x.position!.y + 160 } })),
    ],
    [edge('k.close', 'ema_f.src'), edge('k.close', 'ema_s.src'), edge('ema_f.out', 'f_gt_s.a'), edge('ema_s.out', 'f_gt_s.b'), edge('k.close', 'c_gt_f.a'), edge('ema_f.out', 'c_gt_f.b'), edge('f_gt_s.out', 'long.a'), edge('c_gt_f.out', 'long.b'),
      edge('ema_f.out', 'f_lt_s.a'), edge('ema_s.out', 'f_lt_s.b'), edge('long.out', 'sig.enterLong'), edge('f_lt_s.out', 'sig.enterShort'), ...t.edges]);
}

function meanReversion(): Workflow {
  const t = tail('sig', 60);
  return base('tpl.mean-reversion', 'mean-reversion', '均值回归·布林带（教学示例）', '价格跌破布林带下轨做多、突破上轨做空，回到中轨平仓。', ['震荡', '反转', '布林带'],
    { period: 20, k: 2, allowShort: true }, [pd('period', '布林周期', 20, { min: 5, max: 200 }), pd('k', '带宽 k', 2, { min: 0.5, max: 5, step: 0.1 }), pd('allowShort', '允许做空', true)],
    [
      node('k_', 'data.candles', 20, 140, {}, 'K 线'), node('bb', 'ind.bollinger', 240, 120, { period: '$period', k: '$k' }, '布林带'),
      node('c_lt_lo', 'cond.compare', 460, 40, { op: '<' }, '价 < 下轨'), node('c_gt_up', 'cond.compare', 460, 140, { op: '>' }, '价 > 上轨'),
      node('c_ge_mid', 'cond.compare', 460, 240, { op: '>=' }, '价 ≥ 中轨'), node('c_le_mid', 'cond.compare', 460, 340, { op: '<=' }, '价 ≤ 中轨'),
      node('sig', 'sig.state', 700, 180, { mode: 'latch', allowShort: '$allowShort' }, '均值回归'), ...t.nodes.map((x) => ({ ...x, position: { x: x.position!.x, y: x.position!.y + 200 } })),
    ],
    [edge('k_.close', 'bb.src'), edge('k_.close', 'c_lt_lo.a'), edge('bb.lower', 'c_lt_lo.b'), edge('k_.close', 'c_gt_up.a'), edge('bb.upper', 'c_gt_up.b'), edge('k_.close', 'c_ge_mid.a'), edge('bb.mid', 'c_ge_mid.b'),
      edge('k_.close', 'c_le_mid.a'), edge('bb.mid', 'c_le_mid.b'), edge('c_lt_lo.out', 'sig.enterLong'), edge('c_gt_up.out', 'sig.enterShort'), edge('c_ge_mid.out', 'sig.exitLong'), edge('c_le_mid.out', 'sig.exitShort'), ...t.edges]);
}

function breakout(): Workflow {
  const t = tail('sig', 60);
  return base('tpl.breakout', 'breakout', '突破·唐奇安通道（教学示例）', '收盘价突破前 N 根最高价做多、跌破前 N 根最低价做空，反向跌破较短通道离场。', ['趋势', '突破', '海龟'],
    { entry: 20, exit: 10, allowShort: true }, [pd('entry', '入场通道（根）', 20, { min: 5, max: 200 }), pd('exit', '离场通道（根）', 10, { min: 2, max: 100 }), pd('allowShort', '允许做空', true)],
    [
      node('k', 'data.candles', 20, 160, {}, 'K 线'),
      node('ch_in', 'ind.donchian', 240, 80, { period: '$entry' }, '入场通道'), node('ch_out', 'ind.donchian', 240, 240, { period: '$exit' }, '离场通道'),
      node('c_gt_hi', 'cond.compare', 460, 40, { op: '>' }, '收 > 入场上轨'), node('c_lt_lo', 'cond.compare', 460, 140, { op: '<' }, '收 < 入场下轨'),
      node('c_lt_xlo', 'cond.compare', 460, 240, { op: '<' }, '收 < 离场下轨'), node('c_gt_xhi', 'cond.compare', 460, 340, { op: '>' }, '收 > 离场上轨'),
      node('sig', 'sig.state', 700, 190, { mode: 'latch', allowShort: '$allowShort' }, '突破'), ...t.nodes.map((x) => ({ ...x, position: { x: x.position!.x, y: x.position!.y + 200 } })),
    ],
    [edge('k.high', 'ch_in.high'), edge('k.low', 'ch_in.low'), edge('k.high', 'ch_out.high'), edge('k.low', 'ch_out.low'), edge('k.close', 'c_gt_hi.a'), edge('ch_in.upper', 'c_gt_hi.b'), edge('k.close', 'c_lt_lo.a'), edge('ch_in.lower', 'c_lt_lo.b'),
      edge('k.close', 'c_lt_xlo.a'), edge('ch_out.lower', 'c_lt_xlo.b'), edge('k.close', 'c_gt_xhi.a'), edge('ch_out.upper', 'c_gt_xhi.b'),
      edge('c_gt_hi.out', 'sig.enterLong'), edge('c_lt_lo.out', 'sig.enterShort'), edge('c_lt_xlo.out', 'sig.exitLong'), edge('c_gt_xhi.out', 'sig.exitShort'), ...t.edges]);
}

function grid(): Workflow {
  return base('tpl.grid', 'grid', '网格·只做多（教学示例）', '在「中心价 ± 区间」内等分成若干格：价格越低持仓越多、越高持仓越少，只做多。', ['震荡', '网格', '只做多'],
    { center: 0, rangeRatio: 0.1, grids: 8, maxExposure: 1 }, [pd('center', '中心价（0 = 取第一根收盘价）', 0, { min: 0 }), pd('rangeRatio', '区间半宽（比例）', 0.1, { min: 0.01, max: 0.5, step: 0.005 }), pd('grids', '格数', 8, { min: 2, max: 50 }), pd('maxExposure', '满格占用比例', 1, { min: 0.1, max: 1, step: 0.1 })],
    [node('k', 'data.candles', 20, 80, {}, 'K 线'), node('g', 'ind.grid', 240, 80, { center: '$center', rangeRatio: '$rangeRatio', grids: '$grids', maxExposure: '$maxExposure' }, '网格仓位'), node('out_signal', 'act.signal', 480, 20, {}, '输出信号'),
      node('size', 'risk.size', 480, 140, { allocRatio: 0.1, allocCapNotional: 500, leverage: 1 }, '仓位计算'), node('precheck', 'risk.precheck', 680, 140, {}, '风控预检'), node('place', 'act.order', 880, 140, {}, '下单')],
    [edge('k.close', 'g.src'), edge('g.signal', 'out_signal.signal'), edge('g.signal', 'size.signal'), edge('size.order', 'precheck.order'), edge('precheck.order', 'place.order')]);
}

function dca(): Workflow {
  return base('tpl.dca', 'dca', '定投（教学示例）', '每隔固定根数买入一份，最多买满若干份；可设止盈线，到价整笔卖出后重新开始。只做多。', ['长期', '只做多', '定投'],
    { everyBars: 24, orders: 10, takeProfitRatio: 0, startTs: 0 }, [pd('everyBars', '每隔多少根买一次', 24, { min: 1, max: 1000 }), pd('orders', '最多买几次', 10, { min: 1, max: 100 }), pd('takeProfitRatio', '止盈线（比例，0 = 不止盈）', 0, { min: 0, max: 2, step: 0.005 })],
    [node('k', 'data.candles', 20, 80, {}, 'K 线'), node('d', 'ind.dca', 240, 80, { everyBars: '$everyBars', orders: '$orders', takeProfitRatio: '$takeProfitRatio', startTs: '$startTs' }, '定投仓位'), node('out_signal', 'act.signal', 480, 20, {}, '输出信号'),
      node('size', 'risk.size', 480, 140, { allocRatio: 0.1, allocCapNotional: 500, leverage: 1 }, '仓位计算'), node('precheck', 'risk.precheck', 680, 140, {}, '风控预检'), node('place', 'act.order', 880, 140, {}, '下单')],
    [edge('k.close', 'd.src'), edge('d.signal', 'out_signal.signal'), edge('d.signal', 'size.signal'), edge('size.order', 'precheck.order'), edge('precheck.order', 'place.order')]);
}

export const WORKFLOW_TEMPLATES: ReadonlyArray<Workflow> = [emaTrend(), meanReversion(), breakout(), grid(), dca()];
export const templateOf = (idOrStrategyId: string): Workflow | undefined => WORKFLOW_TEMPLATES.find((w) => w.id === idOrStrategyId || w.meta?.strategyId === idOrStrategyId);
