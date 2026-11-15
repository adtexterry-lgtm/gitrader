// SPDX-License-Identifier: CPAL-1.0
// Gitrader 工作流引擎（内部代号 Flow）——类型。契约 §5.9：工作流 JSON（gitrader-workflow/2）是一等接口。
// 工作流 = 节点（nodes）+ 连线（edges）+ 参数（params）+ 元信息（meta）。节点有类型化的端口（ports）；同一张图既能逐根 K 线回测，也能实时运行（runtime）。

/** 端口类型：series 逐根数值序列 · number 标量 · bool 逐根布尔 · signal 目标仓位信号(-1..1) · order 订单意图 · any 仅供记录类节点接收任意类型。 */
export type PortType = 'series' | 'number' | 'bool' | 'signal' | 'order' | 'any';

export type NodeGroup = 'data' | 'indicator' | 'condition' | 'model' | 'risk' | 'action' | 'output';
export const NODE_GROUPS: ReadonlyArray<{ id: NodeGroup; name: string }> = [
  { id: 'data', name: '数据' }, { id: 'indicator', name: '指标' }, { id: 'condition', name: '条件' }, { id: 'model', name: '模型' },
  { id: 'risk', name: '风控' }, { id: 'action', name: '动作' }, { id: 'output', name: '输出' },
];

export interface PortSpec { name: string; type: PortType; label: string; required?: boolean }
export interface FlowParamDef {
  key: string; label: string; type: 'number' | 'integer' | 'boolean' | 'select' | 'string'; default: number | boolean | string;
  min?: number; max?: number; step?: number; options?: string[]; help?: string;
}

export interface NodeSpec {
  kind: string;
  group: NodeGroup;
  name: string;
  desc: string;
  inputs: PortSpec[];
  outputs: PortSpec[];
  params: FlowParamDef[];
  /** 只能实时运行（回测里没有历史可重放：实时行情 / 持仓 / 模型）。含这类节点的工作流不能回测。 */
  realtimeOnly?: boolean;
  /** 有副作用的终点（信号 / 提案 / 下单 / 平仓 / 记录 / 通知）。回测里被忽略，实时运行时才真正执行。 */
  sink?: boolean;
  /** 由实时运行器计算（需要账户 / 模型），回测里输出空值。 */
  liveHook?: boolean;
  /** 输出端口里与价格同量纲、可叠加到价格图上的那些。 */
  overlay?: string[];
}

export interface FlowNode {
  id: string;
  type: string;                                   // 节点类型 id，见 NodeSpec.kind
  label?: string;
  params: Record<string, number | boolean | string>; // 值为 "$名字" 的字符串表示引用工作流级 params
  position?: { x: number; y: number };
}
export interface FlowEdge { from: { node: string; port: string }; to: { node: string; port: string } }

/** 钉死的插件 / 引擎版本与哈希（requires）。 */
export interface FlowPin { kind: 'plugin' | 'engine'; id: string; version: string; sha256: string }
export interface FlowSource { author: string; license: string; inspiredBy?: string; sha256?: string }

export interface Workflow {
  schema: 'gitrader-workflow/2';
  id: string;
  name: string;
  desc?: string;
  version: number;
  params?: Record<string, number | boolean | string>;
  paramDefs?: FlowParamDef[];                     // 工作流级参数的说明（界面生成表单用）
  requires?: FlowPin[];
  nodes: FlowNode[];
  edges: FlowEdge[];
  meta?: { source?: FlowSource; tags?: string[]; builtin?: boolean; strategyId?: string };
}

/** 工作流里「订单意图」端口的值（引擎运行时再翻译成协议的 OrderIntent，十进制字符串）。 */
export interface FlowOrderIntent {
  instrumentId: string; side: 'buy' | 'sell'; type: 'market'; notional?: number; size?: number; reduceOnly?: boolean; leverage?: number; reason: string;
}

export interface SignalValue { target: number[]; reasons: string[] }
export type SeriesValue = Array<number | null>;
export type Value = SeriesValue | boolean[] | SignalValue | Array<FlowOrderIntent | null> | number | null;

export interface ValidationIssue { level: 'error' | 'warning'; node?: string; edge?: string; message: string; /** 追加：中文显示字段（原字段不变） */ levelText?: string; edgeText?: string }
export interface ValidationResult {
  ok: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  backtestable: boolean;
  backtestBlockers: string[];
  primarySignal: { node: string; port: string } | null;
  order: string[];            // 拓扑序
}

export interface EvalEnv {
  mode: 'backtest' | 'live';
  run: { instrumentId: string; interval: string };
  /** 实时节点 / 副作用相关的计算钩子（kind → 函数），回测里不提供。 */
  live?: Record<string, (ctx: LiveCtx) => Promise<Record<string, Value>> | Record<string, Value>>;
}
export interface LiveCtx { node: FlowNode; params: Record<string, number | boolean | string>; n: number; candles: import('../types').Candle[]; inputs: Record<string, Value | undefined>; run: { instrumentId: string; interval: string } }

export interface EvalResult {
  /** nodeId → port → 值（整段序列） */
  values: Record<string, Record<string, Value>>;
  errors: Array<{ node: string; message: string }>;
  order: string[];
  n: number;
}
