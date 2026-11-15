// SPDX-License-Identifier: CPAL-1.0
// 工作流 JSON 的实时运行（契约 §5.9）：校验 → 起实例 → 每次评估用同一份解释器算整张图，
// 取最后一根已收盘 K 线上的值；终点节点（act.* / out.*）只产出「意图」，意图经 host.order.place 交给运行者的授权书与风控闸。
// 运行权限不写在工作流里：纸面需 L1+、实盘需 L3+，授权级别不够时由宿主自动转提案（引擎只管提交意图）。
// 实时节点：data.quote / data.position 取宿主数据；model.decision 需要外部决策提供方——没有就让节点报错、本轮不动作（失败即停）。
import type { AccountId, AccountSnapshot, InstanceId, MarketContext, Origin, Quote } from '../proto'
import { rpcErr } from '../gep/peer'
import { INTERVAL_MS, type Candle } from '../types'
import { NODE_SPECS, evaluateWorkflow, validateWorkflow, type FlowOrderIntent, type LiveCtx, type SignalValue, type ValidationResult, type Value, type Workflow } from '../flow'
import type { EngineContext } from './context'
import { fingerprint, type InstanceManager, type InstanceRecord } from './instances'
import { buildIntent, capByExposure, planOrder, signedPosition, type Plan, type Sizing } from './planner'
import { newId } from '../util/hash'

export interface WorkflowInstanceData {
  wf: Workflow
  target: 'paper' | 'shadow' | 'live'
  validation: ValidationResult
  /** 最近一次评估各节点在最后一根已收盘 K 线上的值（运行时值）。 */
  lastValues: Record<string, Record<string, unknown>>
  lastIdx: number
  lastEvalErrors: { node: string; message: string }[]
}

export interface WorkflowRunRequest {
  workflow?: unknown
  version?: number
  target: 'paper' | 'shadow' | 'live'
  accountId: AccountId
  instrumentId: string
  interval?: string
  params?: Record<string, number | boolean | string>
  mandateId: string
  instanceId?: string
  sizing?: Partial<Sizing>
}

/** 外部决策提供方（§5.8 快决策插件）。没有提供方时 model.decision 节点报错。 */
export type DecisionProvider = (c: { node: string; params: Record<string, number | boolean | string>; candles: Candle[]; instrumentId: string; interval: string }) => Promise<{ signal: SignalValue; confidence: number[] }>

export class WorkflowRuntime {
  decisionProvider: DecisionProvider | null = null

  constructor(private readonly ctx: EngineContext, private readonly mgr: InstanceManager) {}

  /** 内联 JSON，合并运行参数，校验（含 schema 层）。引擎不带工作流库。 */
  resolve(req: { workflow?: unknown; version?: number; params?: Record<string, number | boolean | string> }): { wf: Workflow; validation: ValidationResult } {
    const raw: unknown = req.workflow
    if (raw === undefined) throw rpcErr('INVALID_PARAMS', 'workflow (the workflow JSON, inline) is required')
    const base = validateWorkflow(raw)
    if (!base.ok) throw rpcErr('INVALID_PARAMS', `invalid workflow: ${base.errors.map((e) => e.message).join('; ')}`)
    const wf = raw as Workflow
    if (req.version !== undefined && wf.version !== req.version) throw rpcErr('INVALID_PARAMS', `workflow version mismatch (have ${wf.version}, asked ${req.version})`)
    const merged: Workflow = { ...wf, params: { ...(wf.params ?? {}), ...(req.params ?? {}) } }
    const validation = validateWorkflow(merged)
    if (!validation.ok) throw rpcErr('INVALID_PARAMS', `invalid workflow params: ${validation.errors.map((e) => e.message).join('; ')}`)
    return { wf: merged, validation }
  }

  async start(req: WorkflowRunRequest, accountBound: (a: AccountId) => boolean): Promise<InstanceRecord> {
    if (!['paper', 'shadow', 'live'].includes(req.target)) throw rpcErr('INVALID_PARAMS', 'target must be paper, shadow or live')
    if (typeof req.instrumentId !== 'string') throw rpcErr('INVALID_PARAMS', 'instrumentId is required')
    const { wf, validation } = this.resolve(req)
    const base = await this.mgr.prepareStart({ ...(req.instanceId ? { instanceId: req.instanceId } : {}), accountId: req.accountId, instruments: [req.instrumentId], ...(req.interval ? { interval: req.interval } : {}), mandateId: req.mandateId, ...(req.sizing ? { sizing: req.sizing } : {}) }, accountBound)
    return this.mgr.register({
      ...base, kind: 'workflow', strategyId: `workflow:${wf.id}`, params: wf.params ?? {},
      workflow: { wf, target: req.target, validation, lastValues: {}, lastIdx: -1, lastEvalErrors: [] },
    })
  }

  // ---- 评估 ----------------------------------------------------------------------

  async evaluate(rec: InstanceRecord, instrumentId: string, candles: Candle[], g: { canOpen: boolean; canReduce: boolean }): Promise<void> {
    const data = rec.workflow!
    const ctx = this.ctx
    const step = INTERVAL_MS[rec.interval]!
    let idx = candles.length - 1
    if (idx >= 0 && candles[idx]!.t + step > ctx.now()) idx -= 1
    if (idx < 0) return
    const price = candles[idx]!.c
    const barT = candles[idx]!.t
    const fp = fingerprint(candles, idx)
    let snapP: Promise<AccountSnapshot> | null = null
    const snap = (): ReturnType<typeof ctx.host.accountSnapshot> => (snapP ??= ctx.host.accountSnapshot(rec.accountId))
    const origin = (nodeType: string, nodeId: string): Origin => ctx.origin(`node:${nodeType}`, { instanceId: rec.instanceId as InstanceId, workflowId: data.wf.id, nodeId })
    const live = this.hooks(rec, instrumentId, candles, idx, snap)
    const ev = await evaluateWorkflow(data.wf, candles, { mode: 'live', run: { instrumentId, interval: rec.interval }, live }, data.validation)
    data.lastEvalErrors = ev.errors
    data.lastIdx = idx
    data.lastValues = snapshotValues(ev.values, idx)
    if (ev.errors.length > 0) {
      // 失败即停：有节点出错，本轮所有终点都不动作
      ctx.log('warn', 'workflow evaluation had node errors; no actions taken', { instanceId: rec.instanceId, nodes: ev.errors.length })
      ctx.emit({ stream: 'strategy', type: 'strategy.error', accountId: rec.accountId, data: { instanceId: rec.instanceId, workflowId: data.wf.id, errors: ev.errors }, origin: origin('workflow', 'graph'), key: rec.instanceId })
      return
    }
    const per = rec.per.get(instrumentId) ?? {}
    rec.per.set(instrumentId, per)
    for (const id of ev.order) {
      const node = data.wf.nodes.find((n) => n.id === id)!
      const spec = NODE_SPECS[node.type]
      if (!spec?.sink) continue
      const inputs = (ev.values[id]?._in ?? {}) as unknown as Record<string, Value | undefined>
      switch (node.type) {
        case 'act.signal': {
          const sv = inputs.signal as SignalValue | undefined
          const target = sv?.target[idx]
          if (target === undefined || target === null) break
          per.lastSignal = { target, reason: sv!.reasons[idx] || '', asOf: barT }
          if (per.emittedTarget !== target && !(per.emittedTarget === undefined && target === 0)) {
            per.emittedTarget = target
            const o = origin(node.type, node.id)
            ctx.emit({ stream: 'signal', type: 'signal.created', accountId: rec.accountId, instrumentId, ts: barT + step, origin: o, causation: o.causation, data: { signalId: newId('sig'), ts: barT + step, instrumentId, kind: 'target', target, expiresAt: barT + 2 * step, reason: sv!.reasons[idx] || node.label || 'workflow signal', origin: o } })
          } else if (per.emittedTarget === undefined) per.emittedTarget = target
          break
        }
        case 'act.order':
        case 'act.propose': {
          const it = (inputs.order as Array<FlowOrderIntent | null> | undefined)?.[idx]
          if (it) await this.place(rec, instrumentId, it, { price, barT, fp, nodeId: node.id, nodeType: node.type, g, snap })
          break
        }
        case 'act.close': {
          const when = (inputs.when as boolean[] | undefined)?.[idx]
          if (!when) break
          const pos = signedPosition(await snap(), instrumentId)
          if (pos === 0) break
          const it: FlowOrderIntent = { instrumentId, side: pos > 0 ? 'sell' : 'buy', type: 'market', size: Math.abs(pos), reduceOnly: true, reason: `${node.label ?? '平仓'}：条件成立` }
          await this.place(rec, instrumentId, it, { price, barT, fp, nodeId: node.id, nodeType: node.type, g, snap })
          break
        }
        case 'out.log': {
          const v = inputs.value
          const x = Array.isArray(v) ? v[idx] : v
          ctx.log('info', `workflow log ${String(data.wf.nodes.find((n) => n.id === id)?.params.label ?? '')}`.trim(), { value: typeof x === 'number' || typeof x === 'string' || typeof x === 'boolean' ? x : null })
          break
        }
        case 'out.notify': {
          if ((inputs.when as boolean[] | undefined)?.[idx]) ctx.emit({ stream: 'strategy', type: 'strategy.notify', accountId: rec.accountId, instrumentId, data: { instanceId: rec.instanceId, workflowId: data.wf.id, nodeId: node.id, message: String(resolveParam(data.wf, node.params.message) ?? '') }, origin: origin(node.type, node.id) })
          break
        }
        default: break
      }
    }
  }

  private async place(rec: InstanceRecord, instrumentId: string, it: FlowOrderIntent, o: { price: number; barT: number; fp: string; nodeId: string; nodeType: string; g: { canOpen: boolean; canReduce: boolean }; snap: () => Promise<AccountSnapshot> }): Promise<void> {
    const ctx = this.ctx
    const reduceOnly = it.reduceOnly === true
    if (reduceOnly ? !o.g.canReduce : !o.g.canOpen) return
    const limits = ctx.guard.limitsFor({ accountId: rec.accountId, instrumentId, strategyId: rec.strategyId, mandateId: rec.mandateId })
    let plan: Plan = { action: reduceOnly ? 'flatten' : 'add', side: it.side, ...(it.size !== undefined ? { size: it.size } : {}), ...(it.notional !== undefined ? { notional: it.notional } : {}), reduceOnly, reason: it.reason }
    if (!reduceOnly) {
      const snap = await o.snap()
      plan = capByExposure(plan, { price: o.price, equity: Number(snap.margin.equity), snap, instrumentId, hasPosition: signedPosition(snap, instrumentId) !== 0, limits })
      if (plan.action === 'none') { rec.lastAction = `skip open: ${plan.reason}`; return }
    }
    const rules = await this.mgr.rulesFor(instrumentId)
    if (rec.status !== 'running') return
    const sizing = { ...rec.sizing, ...(it.leverage !== undefined ? { leverage: it.leverage } : {}) }
    const built = buildIntent(plan, { accountId: rec.accountId, instrumentId, price: o.price, rules, sizing, limits, reason: `${rec.strategyId}: ${it.reason}`, cidParts: [rec.instanceId, o.nodeId, instrumentId, o.barT, o.fp] })
    if (!built.ok) { rec.lastAction = `skip: ${built.skip}`; return }
    const coid = built.intent.clientOrderId as string
    const origin: Origin = ctx.origin(`node:${o.nodeType}`, { instanceId: rec.instanceId as InstanceId, workflowId: rec.workflow!.wf.id, nodeId: o.nodeId })
    const out = await this.mgr.submitter.submit({
      accountId: rec.accountId, instrumentId, intent: built.intent, kind: reduceOnly ? 'reduce' : 'open', strategyId: rec.strategyId, instanceId: rec.instanceId, mandateId: rec.mandateId,
      barKey: `${rec.instanceId}|${o.nodeId}|${o.barT}`, origin, invalidateRules: this.mgr.invalidateRules,
    })
    rec.lastAction = `${out.status}: ${out.note}`
    this.mgr.reportOrder(rec, instrumentId, origin, out, { clientOrderId: coid, side: built.intent.side, size: built.intent.size as string, reduceOnly, reason: it.reason, extra: { workflowId: rec.workflow!.wf.id, nodeId: o.nodeId } })
  }

  // ---- 实时节点 --------------------------------------------------------------------

  private hooks(rec: InstanceRecord, instrumentId: string, candles: Candle[], idx: number, snap: () => Promise<AccountSnapshot>): Record<string, (c: LiveCtx) => Promise<Record<string, Value>> | Record<string, Value>> {
    const ctx = this.ctx
    const n = candles.length
    const nulls = (): Array<null> => new Array(n).fill(null)
    const barT = candles[idx]!.t
    const price = candles[idx]!.c
    return {
      'data.quote': async () => {
        const q = (await ctx.host.call('host.market.snapshot', { type: 'quote', instrumentId })) as Quote
        const c = (await ctx.host.call('host.market.snapshot', { type: 'context', instrumentId })) as MarketContext
        const mid = typeof q.bid === 'number' && typeof q.ask === 'number' && q.bid > 0 && q.ask > 0 ? (q.bid + q.ask) / 2 : q.last
        if (typeof mid !== 'number') throw new Error('quote unavailable')
        const prev = c.prevDayPrice
        const interval = c.fundingIntervalMs && c.fundingIntervalMs > 0 ? c.fundingIntervalMs : 3_600_000
        return { price: mid, change24hRatio: prev && prev > 0 && c.markPrice ? c.markPrice / prev - 1 : 0, fundingHourly: (c.fundingRate ?? 0) * (3_600_000 / interval) }
      },
      'data.position': async () => {
        const s = await snap()
        const p = s.positions.find((x) => x.instrumentId === instrumentId)
        const sign = !p ? 0 : p.side === 'long' ? 1 : -1
        const notional = p ? Math.abs(Number(p.notional)) : 0
        return { side: sign, notional, unrealizedRatio: p && notional > 0 ? Number(p.unrealizedPnl) / notional : 0 }
      },
      'risk.size': async (c) => {
        const sv = c.inputs.signal as SignalValue | undefined
        const target = sv?.target[idx]
        const out: Array<FlowOrderIntent | null> = nulls()
        if (target === undefined || !(price > 0)) return { order: out }
        const s = await snap()
        const sizing: Sizing = { ...rec.sizing, allocRatio: Number(c.params.allocRatio), allocCapNotional: Number(c.params.allocCapNotional), leverage: Number(c.params.leverage) }
        const plan = planOrder({ target, price, equity: Number(s.margin.equity), position: signedPosition(s, instrumentId), sizing, signalReason: sv!.reasons[idx] || '' })
        if (plan.action !== 'none' && plan.side) out[idx] = { instrumentId, side: plan.side, type: 'market', ...(plan.size !== undefined ? { size: plan.size } : {}), ...(plan.notional !== undefined ? { notional: plan.notional } : {}), reduceOnly: plan.reduceOnly ?? false, leverage: sizing.leverage, reason: plan.reason }
        return { order: out }
      },
      'risk.precheck': async (c) => {
        const it = (c.inputs.order as Array<FlowOrderIntent | null> | undefined)?.[idx]
        const order: Array<FlowOrderIntent | null> = nulls()
        const ok: boolean[] = new Array(n).fill(false)
        if (!it) return { order, ok }
        const rules = await this.mgr.rulesFor(instrumentId)
        const reduceOnly = it.reduceOnly === true
        const limits = ctx.guard.limitsFor({ accountId: rec.accountId, instrumentId, strategyId: rec.strategyId, mandateId: rec.mandateId })
        const plan: Plan = { action: reduceOnly ? 'flatten' : 'add', side: it.side, ...(it.size !== undefined ? { size: it.size } : {}), ...(it.notional !== undefined ? { notional: it.notional } : {}), reduceOnly, reason: it.reason }
        const built = buildIntent(plan, { accountId: rec.accountId, instrumentId, price, rules, sizing: rec.sizing, limits, reason: it.reason, cidParts: [rec.instanceId, 'precheck', instrumentId, barT] })
        if (!built.ok) return { order, ok }
        const r = await ctx.host.precheck(rec.accountId, built.intent)
        // review = 需要人批：照样往下走，下单时由宿主按授权书转提案；deny = 这一单不出
        if (r.verdict === 'deny') { rec.lastAction = `precheck deny: ${r.ruleHits.map((h) => h.message ?? h.code).join('; ')}`; return { order, ok } }
        order[idx] = it
        ok[idx] = true
        return { order, ok }
      },
      'model.decision': async (c) => {
        if (!this.decisionProvider) throw new Error('no decision provider configured (model.decision needs a decision-model plugin)')
        const r = await this.decisionProvider({ node: c.node.id, params: c.params, candles, instrumentId, interval: rec.interval })
        return { signal: r.signal, confidence: r.confidence }
      },
    }
  }
}

function resolveParam(wf: Workflow, v: unknown): unknown {
  return typeof v === 'string' && v.startsWith('$') ? (wf.params ?? {})[v.slice(1)] : v
}

/** 各节点输出在第 idx 根上的值（可 JSON 化）。 */
function snapshotValues(values: Record<string, Record<string, Value>>, idx: number): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {}
  for (const [id, ports] of Object.entries(values)) {
    const o: Record<string, unknown> = {}
    for (const [port, v] of Object.entries(ports)) {
      if (port === '_in') continue
      if (Array.isArray(v)) o[port] = v[idx] ?? null
      else if (v && typeof v === 'object' && 'target' in v) o[port] = { target: (v as SignalValue).target[idx] ?? null, reason: (v as SignalValue).reasons[idx] || '' }
      else o[port] = v ?? null
    }
    out[id] = o
  }
  return out
}
