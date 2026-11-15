// SPDX-License-Identifier: CPAL-1.0
// 工作流的校验 / 解释器 / 回测（搬运 Demo src/flow/graph.ts，改为 gitrader-workflow/2）。
// 同一份解释器既用于回测（对整段历史 K 线），也用于实时（对最近一段 K 线，取最后一根已收盘的值）。
// 校验分两层：先用协议的 JSON Schema（schemas/workflow.json，Ajv 2020-12）查结构，再做 schema 之外的语义检查
// （图无环、端口类型兼容、必填输入已连、"$名字" 参数引用能解析、含实时节点的图不能回测）。
import Ajv2020 from 'ajv/dist/2020'
import workflowSchema from '../../../protocol/schemas/workflow.json'
import type { Candle } from '../types'
import { simulateSeries, type BacktestRunOptions, type SimulationOutput } from '../strategy/backtest'
import type { SignalSeries } from '../strategy/types'
import { NODE_SPECS } from './nodes'
import type { ComputeCtx } from './nodes'
import type { EvalEnv, EvalResult, FlowNode, FlowParamDef, PortType, SignalValue, ValidationIssue, ValidationResult, Value, Workflow } from './types'

export const WORKFLOW_SCHEMA = 'gitrader-workflow/2' as const

// TODO(protocol): 协议包尚未导出工作流校验器，这里直接用它的 schema 文件；等 packages/protocol 导出 validateWorkflowSchema 后换掉。
const ajv = new (Ajv2020 as unknown as new (o: object) => import('ajv').default)({ allErrors: true, strict: false })
const checkSchema = ajv.compile(workflowSchema as object)

/** 端口类型兼容：相同类型；number 可广播成 series；any 收一切。 */
export function portCompatible(from: PortType, to: PortType): boolean {
  return from === to || to === 'any' || (from === 'number' && to === 'series')
}

/** 把节点 params 里的 "$名字" 换成工作流级 params，并按规格补默认值 / 转类型 / 夹范围。 */
export function resolveNodeParams(node: FlowNode, wfParams: NonNullable<Workflow['params']>): { params: Record<string, number | boolean | string>; problems: string[] } {
  const spec = NODE_SPECS[node.type]
  const out: Record<string, number | boolean | string> = {}
  const problems: string[] = []
  if (!spec) return { params: out, problems }
  for (const d of spec.params) {
    let raw: unknown = node.params?.[d.key]
    if (typeof raw === 'string' && raw.startsWith('$')) {
      const k = raw.slice(1)
      if (!(k in wfParams)) { problems.push(`参数 ${d.key} 引用了不存在的工作流参数 ${raw}`); raw = undefined } else raw = wfParams[k]
    }
    out[d.key] = coerce(d, raw)
  }
  return { params: out, problems }
}

function coerce(d: FlowParamDef, raw: unknown): number | boolean | string {
  if (raw === undefined || raw === null || raw === '') return d.default
  if (d.type === 'boolean') return raw === true || raw === 'true' || raw === 1
  if (d.type === 'string') return String(raw)
  if (d.type === 'select') return d.options?.includes(String(raw)) ? String(raw) : d.default
  const n = Number(raw)
  if (!Number.isFinite(n)) return d.default
  let x = d.type === 'integer' ? Math.round(n) : n
  if (d.min !== undefined) x = Math.max(d.min, x)
  if (d.max !== undefined) x = Math.min(d.max, x)
  return x
}

// ───────── 校验 ─────────
const PORT_TEXT: Record<PortType, string> = { series: '数值序列', number: '数值', bool: '真假', signal: '仓位信号', order: '订单意图', any: '任意类型' }

export function validateWorkflow(input: unknown): ValidationResult {
  const errors: ValidationIssue[] = []
  const warnings: ValidationIssue[] = []
  const err = (message: string, extra: Partial<ValidationIssue> = {}): void => { errors.push({ level: 'error', levelText: '错误', message, ...extra }) }
  const warn = (message: string, extra: Partial<ValidationIssue> = {}): void => { warnings.push({ level: 'warning', levelText: '警告', message, ...extra }) }
  const failed = (): ValidationResult => ({ ok: false, errors, warnings, backtestable: false, backtestBlockers: [], primarySignal: null, order: [] })

  if (!input || typeof input !== 'object' || Array.isArray(input)) { err('工作流必须是对象'); return failed() }
  // 第一层：JSON Schema（结构、字段类型、长度、id / 类型名格式）
  if (!checkSchema(input)) {
    for (const e of checkSchema.errors ?? []) err(`${e.instancePath || '(根)'} ${e.message ?? 'invalid'}${e.params && 'additionalProperty' in e.params ? `：${String(e.params.additionalProperty)}` : ''}`)
    return failed()
  }
  const wf = input as Workflow
  const wfParams = wf.params ?? {}

  // 第二层：语义
  const labelOf = (id: string, port: string, dir: 'inputs' | 'outputs'): string => {
    const n = wf.nodes.find((x) => x.id === id)
    const spec = n ? NODE_SPECS[n.type] : undefined
    const p = spec?.[dir].find((q) => q.name === port)
    return `${n?.label ?? spec?.name ?? id}.${p?.label ?? port}`
  }
  const decorate = (list: ValidationIssue[]): ValidationIssue[] => list.map((i) => {
    const m = i.edge?.match(/^(.+?)\.([^.\s]+) → (.+?)\.([^.\s]+)$/)
    return m ? { ...i, edgeText: `${labelOf(m[1]!, m[2]!, 'outputs')} → ${labelOf(m[3]!, m[4]!, 'inputs')}` } : i
  })

  const byId = new Map<string, FlowNode>()
  for (const n of wf.nodes) {
    if (byId.has(n.id)) { err(`节点 id ${n.id} 重复`, { node: n.id }); continue }
    byId.set(n.id, n)
    const spec = NODE_SPECS[n.type]
    if (!spec) {
      err(n.type.startsWith('plugin:') ? `节点 ${n.id} 的类型 ${n.type} 是插件节点，本引擎没有加载它` : n.type === 'model.research' ? `节点 ${n.id} 的类型 model.research 在 gitrader-workflow/2 里已删除（工作流不调用 LLM）` : `节点 ${n.id} 的类型 ${n.type} 不存在`, { node: n.id })
      continue
    }
    const { problems } = resolveNodeParams(n, wfParams)
    for (const p of problems) err(`节点 ${n.id}：${p}`, { node: n.id })
  }

  const inEdge = new Map<string, number>()
  for (const e of wf.edges) {
    const tag = `${e.from.node}.${e.from.port} → ${e.to.node}.${e.to.port}`
    const a = byId.get(e.from.node)
    const b = byId.get(e.to.node)
    if (!a || !b) { err(`连线 ${tag}：两端必须是已有节点`, { edge: tag }); continue }
    const sa = NODE_SPECS[a.type]
    const sb = NODE_SPECS[b.type]
    if (!sa || !sb) continue
    const po = sa.outputs.find((p) => p.name === e.from.port)
    const pi = sb.inputs.find((p) => p.name === e.to.port)
    if (!po) { err(`连线 ${tag}：节点 ${a.id}（${sa.name}）没有输出端口 ${e.from.port}`, { edge: tag }); continue }
    if (!pi) { err(`连线 ${tag}：节点 ${b.id}（${sb.name}）没有输入端口 ${e.to.port}`, { edge: tag }); continue }
    if (!portCompatible(po.type, pi.type)) err(`连线 ${tag}：端口类型不匹配（${PORT_TEXT[po.type]} 不能接到 ${PORT_TEXT[pi.type]}）`, { edge: tag })
    const key = `${b.id}.${pi.name}`
    inEdge.set(key, (inEdge.get(key) ?? 0) + 1)
    if (inEdge.get(key)! > 1) err(`节点 ${b.id} 的输入端口 ${pi.name} 接了多条线（一个输入只能接一条）`, { edge: tag })
    if (a.id === b.id) err(`连线 ${tag}：不能连自己`, { edge: tag })
  }
  for (const n of byId.values()) {
    const spec = NODE_SPECS[n.type]
    if (!spec) continue
    for (const p of spec.inputs) if (p.required !== false && !inEdge.has(`${n.id}.${p.name}`)) err(`节点 ${n.id}（${spec.name}）的必填输入 ${p.name}（${p.label}）没有接线`, { node: n.id })
  }

  // 拓扑序 + 环检测（Kahn）
  const indeg = new Map<string, number>([...byId.keys()].map((i) => [i, 0]))
  for (const e of wf.edges) if (byId.has(e.from.node) && byId.has(e.to.node)) indeg.set(e.to.node, indeg.get(e.to.node)! + 1)
  const q = [...indeg].filter(([, d]) => d === 0).map(([i]) => i)
  const order: string[] = []
  while (q.length) {
    const i = q.shift()!
    order.push(i)
    for (const e of wf.edges) if (e.from.node === i && indeg.has(e.to.node)) { indeg.set(e.to.node, indeg.get(e.to.node)! - 1); if (indeg.get(e.to.node) === 0) q.push(e.to.node) }
  }
  if (order.length < byId.size) err('连线形成了环：工作流必须是有向无环图（DAG）')

  // 警告 / 回测能力
  const used = new Set(wf.edges.map((e) => `${e.from.node}.${e.from.port}`))
  for (const n of byId.values()) {
    const spec = NODE_SPECS[n.type]
    if (spec && !spec.sink) for (const o of spec.outputs) if (!used.has(`${n.id}.${o.name}`) && spec.group !== 'data') warn(`节点 ${n.id}（${spec.name}）的输出 ${o.name} 没有接到任何地方`, { node: n.id })
  }
  if (![...byId.values()].some((n) => NODE_SPECS[n.type]?.sink)) warn('没有任何「动作 / 输出」节点：这张图只能看数值，不会产生信号或订单')
  const blockers: string[] = []
  for (const n of byId.values()) if (NODE_SPECS[n.type]?.realtimeOnly) blockers.push(`节点 ${n.id}（${NODE_SPECS[n.type]!.name}）是实时节点，没有历史可重放`)
  const dataSyms = [...byId.values()].filter((n) => n.type === 'data.candles' && typeof n.params.instrumentId === 'string' && n.params.instrumentId !== '')
  if (new Set(dataSyms.map((n) => n.params.instrumentId)).size > 1) blockers.push('一个工作流只支持一个标的（多个 K 线节点指定了不同标的）')
  let primary: ValidationResult['primarySignal'] = null
  const edgeInto = (node: string, port: string): Workflow['edges'][number] | undefined => wf.edges.find((e) => e.to.node === node && e.to.port === port)
  for (const kind of ['act.signal', 'risk.size']) {
    const sink = [...byId.values()].find((n) => n.type === kind)
    const e = sink ? edgeInto(sink.id, 'signal') : undefined
    if (e) { primary = { node: e.from.node, port: e.from.port }; break }
  }
  if (!primary) blockers.push('没有「输出信号」或「仓位计算」节点接着一个信号：回测不知道该以哪个信号为策略')
  return { ok: errors.length === 0, errors: decorate(errors), warnings: decorate(warnings), backtestable: errors.length === 0 && blockers.length === 0, backtestBlockers: blockers, primarySignal: primary, order }
}

// ───────── 解释器 ─────────
export async function evaluateWorkflow(wf: Workflow, candles: Candle[], env: EvalEnv, validation?: ValidationResult): Promise<EvalResult> {
  const v = validation ?? validateWorkflow(wf)
  if (!v.ok) throw new Error(`工作流不合法：${v.errors.map((e) => e.message).join('；')}`)
  const n = candles.length
  const wfParams = wf.params ?? {}
  const byId = new Map(wf.nodes.map((x) => [x.id, x]))
  const values: Record<string, Record<string, Value>> = {}
  const errors: EvalResult['errors'] = []
  for (const id of v.order) {
    const node = byId.get(id)!
    const spec = NODE_SPECS[node.type]!
    const { params } = resolveNodeParams(node, wfParams)
    const inputs: Record<string, Value | undefined> = {}
    for (const e of wf.edges) if (e.to.node === id) inputs[e.to.port] = values[e.from.node]?.[e.from.port]
    const ctx: ComputeCtx = { n, candles, node, params, inputs, run: env.run }
    try {
      let out: Record<string, Value> = {}
      if (spec.liveHook) {
        const hook = env.live?.[spec.kind]
        if (hook) out = await hook({ node, params, n, candles, inputs, run: env.run })
        else if (spec.realtimeOnly) throw new Error('实时节点：回测里没有历史可重放')
        else out = Object.fromEntries(spec.outputs.map((o) => [o.name, o.type === 'bool' ? new Array(n).fill(false) : new Array(n).fill(null)])) as Record<string, Value>
      } else if (spec.compute) out = spec.compute(ctx)
      else if (spec.sink) out = {}
      if (spec.sink) out = { ...out, _in: inputs as unknown as Value }
      values[id] = out
    } catch (e) {
      errors.push({ node: id, message: e instanceof Error ? e.message : String(e) })
      values[id] = Object.fromEntries(spec.outputs.map((o) => [o.name, o.type === 'bool' ? new Array(n).fill(false) : o.type === 'signal' ? { target: new Array(n).fill(0), reasons: new Array(n).fill('') } : new Array(n).fill(null)])) as Record<string, Value>
    }
  }
  return { values, errors, order: v.order, n }
}

// ───────── 回测 ─────────
export interface WorkflowBacktestOutput { validation: ValidationResult; result: SimulationOutput; series: SignalSeries; params: NonNullable<Workflow['params']> }

/** 只算信号序列（不撮合）：回测与前视偏差自检共用。 */
export async function workflowSignalSeries(wf: Workflow, candles: Candle[], opts: { params?: Record<string, number | boolean | string>; instrumentId?: string; interval?: string } = {}): Promise<{ series: SignalSeries; validation: ValidationResult; params: NonNullable<Workflow['params']> }> {
  const merged: Workflow = { ...wf, params: { ...(wf.params ?? {}), ...(opts.params ?? {}) } }
  const validation = validateWorkflow(merged)
  if (!validation.ok) throw new Error(`工作流不合法：${validation.errors.map((e) => e.message).join('；')}`)
  if (!validation.backtestable) throw new Error(`这张工作流不能回测：${validation.backtestBlockers.join('；')}`)
  const ev = await evaluateWorkflow(merged, candles, { mode: 'backtest', run: { instrumentId: opts.instrumentId ?? '', interval: opts.interval ?? '' } }, validation)
  if (ev.errors.length) throw new Error(`节点运行出错：${ev.errors.map((e) => `${e.node}：${e.message}`).join('；')}`)
  const p = validation.primarySignal!
  const sig = ev.values[p.node]?.[p.port] as SignalValue | undefined
  if (!sig || !Array.isArray(sig.target)) throw new Error(`节点 ${p.node} 的端口 ${p.port} 没有产出信号`)
  // 叠加线与预热
  const overlays: SignalSeries['overlays'] = {}
  let warmup = 0
  const used = new Set<string>()
  for (const node of merged.nodes) {
    const spec = NODE_SPECS[node.type]!
    if (spec.group !== 'indicator' || spec.kind === 'ind.grid' || spec.kind === 'ind.dca' || spec.kind.startsWith('math.')) continue
    for (const o of spec.outputs) {
      const arr = ev.values[node.id]?.[o.name]
      if (!Array.isArray(arr)) continue
      const first = (arr as Array<number | null>).findIndex((x) => x !== null && x !== undefined)
      warmup = Math.max(warmup, first < 0 ? candles.length : first)
      if (spec.overlay?.includes(o.name)) {
        const resolved = resolveNodeParams(node, merged.params!).params
        let name = `${node.label ?? spec.name}${resolved.period !== undefined ? `(${resolved.period})` : ''}${spec.outputs.length > 1 ? '·' + o.label : ''}`
        if (used.has(name)) name = `${name}#${node.id}`
        used.add(name)
        overlays[name] = arr as Array<number | null>
      }
    }
  }
  // grid / dca 在图里的网格线 / 持仓均价没有单独输出，回测价格图上不叠加
  return { series: { target: sig.target, reasons: sig.reasons, overlays, warmup }, validation, params: merged.params! }
}

export async function backtestWorkflow(wf: Workflow, candles: Candle[], opts: BacktestRunOptions & { params?: Record<string, number | boolean | string>; instrumentId?: string; interval?: string } = {}): Promise<WorkflowBacktestOutput> {
  const { series, validation, params } = await workflowSignalSeries(wf, candles, opts)
  return { validation, result: simulateSeries(series, candles, opts), series, params }
}
