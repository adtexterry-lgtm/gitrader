// SPDX-License-Identifier: CPAL-1.0
// 策略实例运行器（搬运 Demo app/server/strategies.mjs 的实例部分，改成 GEP 模式 A）。
// 实例 = 一个示例策略（或一张工作流）+ 账户 + 标的 + 周期 + 参数 + 授权书引用。可多个并行、可启停、可热改参数。
// 每次评估：取已收盘 K 线 → 求策略信号（signal 事件，带 origin 与理由）→ 按持仓差额出订单意图 → host.order.place。
//
// 触发：宿主推来的 market 流 K 线事件（用工作台行情）。引擎手里的行情 = 按开盘时间 t 为键的一组 K 线，
// 事件是对这组 K 线的更新：t 已有 → 替换，没有 → 插入。每次更新后，策略永远在「最新一根已收盘 K 线」上求信号：
//   · 出现新的一根、或某根已收盘 K 线被修订（内容变了）→ 立即评估；
//   · 同一根形成中 K 线的更新 → 只更新，不评估（closed = true 的除外）。
// 引擎不替宿主判断数据新不新——陈旧行情由宿主风控闸 fail-closed 拒单（契约 §1.4.10 failClosed）。
// 没有 push 时按 Demo 的节奏兜底轮询 host.market.history。
// 订单号 clientOrderId = hash(实例, 标的, 决策输入 K 线指纹, 动作, 方向, 数量)：同一份输入得出同一个决策 = 同一个单号（幂等）；
// 输入变了（新 K 线、旧 K 线被修订）就是新的决策、新的单号。
// 每个实例一条评估队列，串行执行；积压超过 200 条时丢弃中间的，只保留最新的（实盘不会积压，回灌历史时才会）。
import {
  PROBLEM_CODES, type AccountId, type Candle, type Instrument, type InstanceId, type InstrumentId, type Origin, type Problem, type StrategyInstance, type StrategyInstanceStatus,
} from '../proto'
import { rpcErr, RpcError } from '../gep/peer'
import { INTERVAL_MS } from '../types'
import { latestSignal } from '../strategy'
import { INSTANCE_SIZE_KEY, strategyOnlyParams, validateInstanceParams } from '../strategy/schema'
import type { Params, StrategyDef } from '../strategy/types'
import type { EngineContext } from './context'
import { OrderSubmitter, type SubmitOutcome } from './orders'
import { DEFAULT_SIZING, buildIntent, capByExposure, planOrder, signedPosition, type Sizing } from './planner'
import { candlesDigest, newId } from '../util/hash'
import { WorkflowRuntime, type WorkflowInstanceData } from './workflow-run'

export interface StartRequest {
  strategyId: string
  instanceId?: InstanceId
  accountId: AccountId
  instruments: InstrumentId[]
  interval?: string
  params?: Record<string, number | boolean | string>
  mandateId: string
  /** TODO(protocol): GEP strategy.start 没有仓位大小字段；这里作为追加的可选字段接收，缺省 = Demo 默认（权益 10% 或 500 封顶，1×）。 */
  sizing?: Partial<Sizing>
}

type Kind = 'strategy' | 'workflow'
type InstanceState = 'active' | 'halted' | 'host-lost'

interface EvalJob { instrumentId: InstrumentId; candles: Candle[] | null; trigger: string; done: () => void }

export interface InstanceRecord {
  instanceId: string
  kind: Kind
  /** 策略 id；工作流实例为 `workflow:<id>`。 */
  strategyId: string
  accountId: AccountId
  instruments: InstrumentId[]
  interval: string
  params: Params
  mandateId: string
  sizing: Sizing
  status: StrategyInstanceStatus
  startedAt: number
  stoppedAt?: number
  error?: Problem
  workflow?: WorkflowInstanceData
  /** 启动时钉住的策略定义：之后改策略文件不影响已在跑的实例，重启实例才用新版本。 */
  def?: StrategyDef
  /** 每个标的的运行状态。 */
  per: Map<InstrumentId, { emittedTarget?: number; lastSignal?: Record<string, unknown>; lastAction?: string }>
  evals: number
  skippedEvals: number
  lastEvalAt: number
  pushSeen: boolean
  queue: EvalJob[]
  draining: boolean
  lastAction?: string
}

export interface InstanceManagerOptions {
  maxInstances?: number
  candleWindow?: number
  /** 兜底轮询的最短间隔（毫秒），Demo 是 60 秒。 */
  pollMinMs?: number
  /** 评估队列积压上限。 */
  maxBacklog?: number
}

const CANDLE_KEEP = 800

interface Series { candles: Candle[]; interval: string }

export class InstanceManager {
  private readonly items = new Map<string, InstanceRecord>()
  private readonly series = new Map<string, Series>()
  private readonly rules = new Map<string, Instrument>()
  submitter: OrderSubmitter
  readonly workflows: WorkflowRuntime
  private readonly max: number
  private readonly window: number
  private readonly pollMin: number
  private readonly backlog: number

  constructor(private readonly ctx: EngineContext, opts: InstanceManagerOptions = {}) {
    this.max = opts.maxInstances ?? 20
    this.window = opts.candleWindow ?? 300
    this.pollMin = opts.pollMinMs ?? 60_000
    this.backlog = opts.maxBacklog ?? 200
    this.submitter = new OrderSubmitter(ctx)
    this.workflows = new WorkflowRuntime(ctx, this)
  }

  // ---- 查询 ---------------------------------------------------------------------

  get(id: string): InstanceRecord | undefined { return this.items.get(id) }
  all(): InstanceRecord[] { return [...this.items.values()] }
  runningCount(): number { return this.all().filter((i) => i.status === 'running').length }

  /** 新宿主会话开始：旧会话留下的实例、行情缓存、退避状态全部清掉（它们属于已经结束的会话）。 */
  reset(): void {
    for (const i of this.items.values()) { i.status = 'stopped'; i.queue.length = 0 }
    this.items.clear()
    this.series.clear()
    this.rules.clear()
    this.submitter = new OrderSubmitter(this.ctx)
  }

  /** 协议 StrategyInstance 视图（追加 x- 扩展字段：状态、最近信号 / 动作）。 */
  view(i: InstanceRecord): StrategyInstance {
    const state: InstanceState = this.ctx.guard.stateFor({ accountId: i.accountId, strategyId: i.strategyId }) === 'ACTIVE' ? 'active' : this.ctx.guard.hostLost && this.ctx.guard.activeTakeovers().length === 0 ? 'host-lost' : 'halted'
    const v: StrategyInstance & Record<string, unknown> = {
      instanceId: i.instanceId as InstanceId, strategyId: i.strategyId, status: i.status, accountId: i.accountId, instruments: i.instruments, interval: i.interval,
      params: i.params, mandateId: i.mandateId, startedAt: i.startedAt, ...(i.error ? { error: i.error } : {}),
    }
    v['x-kind'] = i.kind
    v['x-state'] = state
    v['x-evals'] = i.evals
    v['x-sizing'] = i.sizing
    if (i.skippedEvals > 0) v['x-skippedEvals'] = i.skippedEvals
    if (i.lastAction) v['x-lastAction'] = i.lastAction
    const sig: Record<string, unknown> = {}
    for (const [k, p] of i.per) if (p.lastSignal) sig[k] = p.lastSignal
    if (Object.keys(sig).length) v['x-lastSignal'] = sig
    return v
  }

  // ---- 启停与热改 -----------------------------------------------------------------

  async start(req: StartRequest, accountBound: (a: AccountId) => boolean): Promise<InstanceRecord> {
    const def = this.ctx.strategies.get(req.strategyId)
    if (!def) throw rpcErr('INVALID_PARAMS', `unknown strategyId (loaded: ${this.ctx.strategies.ids().join(', ') || 'none — put a strategy file in the strategies folder'})`)
    // 先调用策略的参数校验钩子（缺参或越界拒绝）
    if (def.validateParams) {
      try {
        def.validateParams(req.params ?? {})
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        throw rpcErr('INVALID_PARAMS', msg)
      }
    }
    const v = validateInstanceParams(def.params, req.params)
    if (!v.ok) throw rpcErr('INVALID_PARAMS', `invalid strategy params: ${v.errors.join('; ')}`)
    const base = await this.prepareStart(req, accountBound)
    let params = v.params
    if (def.anchor) {
      // 网格中心价 / 定投起点这类「锚点」参数在启动时固定下来
      const cs = await this.fetchCandles(base.instruments[0]!, base.interval)
      params = { ...def.anchor(cs.slice(-50), strategyOnlyParams(params)), ...(params[INSTANCE_SIZE_KEY] !== undefined ? { [INSTANCE_SIZE_KEY]: params[INSTANCE_SIZE_KEY] } : {}) }
    }
    return this.register({ ...base, kind: 'strategy', strategyId: def.id, params, def })
  }

  /** start 的公共校验：账户、标的、周期、实例上限、仓位设置。 */
  async prepareStart(req: { instanceId?: string; accountId: AccountId; instruments: InstrumentId[]; interval?: string; mandateId: string; sizing?: Partial<Sizing> }, accountBound: (a: AccountId) => boolean): Promise<{
    instanceId: string; accountId: AccountId; instruments: InstrumentId[]; interval: string; mandateId: string; sizing: Sizing
  }> {
    if (!req.accountId || typeof req.accountId !== 'string') throw rpcErr('INVALID_PARAMS', 'accountId is required')
    if (!accountBound(req.accountId)) throw rpcErr('ACCOUNT_NOT_BOUND', 'account is not bound to this engine (call engine.bind first)')
    if (!Array.isArray(req.instruments) || req.instruments.length === 0 || !req.instruments.every((x) => typeof x === 'string' && /^[a-z0-9][a-z0-9-]*:.+$/.test(x))) throw rpcErr('INVALID_PARAMS', 'instruments must be a non-empty array of instrumentId strings')
    if (typeof req.mandateId !== 'string' || req.mandateId === '') throw rpcErr('INVALID_PARAMS', 'mandateId is required')
    const interval = req.interval ?? '15m'
    if (!INTERVAL_MS[interval]) throw rpcErr('INVALID_PARAMS', `interval must be one of ${Object.keys(INTERVAL_MS).join(', ')}`)
    if (req.instanceId !== undefined && !/^inst_[0-9A-Za-z]{3,26}$/.test(req.instanceId)) throw rpcErr('INVALID_PARAMS', 'instanceId must look like inst_<ULID>')
    if (this.runningCount() >= this.max && !(req.instanceId && this.items.has(req.instanceId))) throw rpcErr('BUSY', `at most ${this.max} concurrent strategy instances`)
    const sizing: Sizing = { ...DEFAULT_SIZING, ...pickNumbers(req.sizing ?? {}) }
    if (!(sizing.allocRatio > 0 && sizing.allocRatio <= 1)) throw rpcErr('INVALID_PARAMS', 'sizing.allocRatio must be in (0, 1]')
    if (!(sizing.allocCapNotional > 0)) throw rpcErr('INVALID_PARAMS', 'sizing.allocCapNotional must be > 0')
    if (!(sizing.leverage >= 1 && sizing.leverage <= 50)) throw rpcErr('INVALID_PARAMS', 'sizing.leverage must be in [1, 50]')
    // 标的必须宿主认得（取不到合约表时不阻止启动，下单时宿主会拒）
    try {
      const found = await this.ctx.host.instruments(req.instruments)
      const known = new Set(found.map((x) => x.instrumentId))
      const missing = req.instruments.filter((x) => !known.has(x))
      if (missing.length) throw rpcErr('INSTRUMENT_UNKNOWN', `unknown instrument: ${missing.join(', ')}`)
      for (const r of found) this.rules.set(r.instrumentId, r)
    } catch (e) {
      if (e instanceof RpcError && e.problem.code === PROBLEM_CODES.INSTRUMENT_UNKNOWN.code) throw e
      this.ctx.log('warn', 'host.instruments unavailable; continuing without contract rules', { code: e instanceof RpcError ? e.problem.code : -1 })
    }
    return { instanceId: req.instanceId ?? newId('inst'), accountId: req.accountId, instruments: [...req.instruments], interval, mandateId: req.mandateId, sizing }
  }

  register(r: Omit<InstanceRecord, 'status' | 'startedAt' | 'per' | 'evals' | 'skippedEvals' | 'lastEvalAt' | 'pushSeen' | 'queue' | 'draining'>): InstanceRecord {
    /** 同账户、标的有交集、正在跑的实例（任何策略 / 工作流 / 周期）= 目标仓位所有者。 */
    const ownerOf = (req: { instanceId: string; accountId: AccountId; instruments: InstrumentId[] }): InstanceRecord | undefined =>
      [...this.items.values()].find((o) => o.status === 'running' && o.instanceId !== req.instanceId && o.accountId === req.accountId && req.instruments.some((x) => o.instruments.includes(x)))
    const clash = (o: InstanceRecord, req: { strategyId: string; instanceId: string; instruments: InstrumentId[] }): never => {
      const shared = req.instruments.find((x) => o.instruments.includes(x))!
      throw rpcErr('INVALID_PARAMS', `${o.strategyId} (instance ${o.instanceId}) already owns the target position of ${shared} on this account; stop it before starting ${req.strategyId} — two strategies on one account and instrument fight over a single net position`)
    }

    const existing = this.items.get(r.instanceId)
    if (existing) {
      // 幂等：同一个 instanceId 带同样的配置重复 start，返回已有实例；配置不同则拒绝
      const same = existing.strategyId === r.strategyId && existing.accountId === r.accountId && existing.interval === r.interval &&
        JSON.stringify(existing.instruments) === JSON.stringify(r.instruments) && existing.mandateId === r.mandateId
      if (!same) throw rpcErr('INVALID_PARAMS', 'instanceId already exists with a different configuration')
      if (existing.status === 'stopped') {
        // 已停止的实例复位前，检查是否有别的实例占了位
        const o = ownerOf({ instanceId: r.instanceId, accountId: r.accountId, instruments: r.instruments })
        if (o) clash(o, r)
        existing.status = 'running'; delete existing.stoppedAt; existing.params = r.params; this.afterStart(existing)
      }
      return existing
    }
    // 净额制：同账户同标的只许一个目标仓位所有者（去掉 kind / strategyId / interval 限制）
    const o = ownerOf({ instanceId: r.instanceId, accountId: r.accountId, instruments: r.instruments })
    if (o) clash(o, r)

    const rec: InstanceRecord = { ...r, status: 'running', startedAt: this.ctx.now(), per: new Map(), evals: 0, skippedEvals: 0, lastEvalAt: 0, pushSeen: false, queue: [], draining: false }
    this.items.set(rec.instanceId, rec)
    this.afterStart(rec)
    return rec
  }

  private afterStart(rec: InstanceRecord): void {
    this.ctx.emit({
      stream: 'strategy', type: 'strategy.started', accountId: rec.accountId,
      data: { instanceId: rec.instanceId, strategyId: rec.strategyId, kind: rec.kind, instruments: rec.instruments, interval: rec.interval, params: rec.params, mandateId: rec.mandateId },
      origin: this.ctx.origin(`strategy:${rec.strategyId}`, { instanceId: rec.instanceId as InstanceId, strategyId: rec.strategyId, mandateId: rec.mandateId as never }),
    })
    // 订阅行情（用工作台行情）；失败不致命，兜底轮询会接手
    void this.ctx.host.call('host.market.subscribe', { channels: rec.instruments.map((instrumentId) => ({ type: 'candles' as const, instrumentId, interval: rec.interval })) }).catch(() => undefined)
    void this.evaluateNow(rec.instanceId, 'start')
  }

  stop(id: string): InstanceRecord {
    const rec = this.items.get(id)
    if (!rec) throw rpcErr('INVALID_PARAMS', 'unknown instanceId')
    if (rec.status === 'running') {
      rec.status = 'stopped'
      rec.stoppedAt = this.ctx.now()
      this.submitter.clearInstance(rec.instanceId)
      for (const j of rec.queue.splice(0)) j.done()
      this.ctx.emit({ stream: 'strategy', type: 'strategy.stopped', accountId: rec.accountId, data: { instanceId: rec.instanceId, strategyId: rec.strategyId, flattened: false }, origin: this.ctx.origin(`strategy:${rec.strategyId}`, { instanceId: rec.instanceId as InstanceId }) })
    }
    return rec
  }

  /** 热改参数：不重启，状态（信号去重、锚点）保留。 */
  update(id: string, patch: Record<string, number | boolean | string>): InstanceRecord {
    const rec = this.items.get(id)
    if (!rec) throw rpcErr('INVALID_PARAMS', 'unknown instanceId')
    if (rec.kind !== 'strategy') throw rpcErr('INVALID_PARAMS', 'workflow instances are updated by restarting them with new params')
    const def = rec.def!
    const v = validateInstanceParams(def.params, { ...rec.params, ...patch })
    if (!v.ok) throw rpcErr('INVALID_PARAMS', `invalid strategy params: ${v.errors.join('; ')}`)
    rec.params = v.params
    this.ctx.emit({ stream: 'strategy', type: 'strategy.updated', accountId: rec.accountId, data: { instanceId: rec.instanceId, params: rec.params }, origin: this.ctx.origin(`strategy:${rec.strategyId}`, { instanceId: rec.instanceId as InstanceId }) })
    void this.evaluateNow(rec.instanceId, 'update')
    return rec
  }

  // ---- 数据 -----------------------------------------------------------------------

  private skey = (instrumentId: string, interval: string): string => `${instrumentId}|${interval}`

  private async fetchCandles(instrumentId: string, interval: string): Promise<Candle[]> {
    const r = await this.ctx.host.history(instrumentId, interval, { limit: this.window })
    const cs = r.candles.slice(-CANDLE_KEEP)
    this.series.set(this.skey(instrumentId, interval), { candles: cs, interval })
    return cs
  }

  async candlesFor(instrumentId: string, interval: string, refresh: boolean): Promise<Candle[]> {
    const s = this.series.get(this.skey(instrumentId, interval))
    if (s && !refresh && s.candles.length > 0) return s.candles
    return this.fetchCandles(instrumentId, interval)
  }

  async rulesFor(instrumentId: string): Promise<Instrument | undefined> {
    const hit = this.rules.get(instrumentId)
    if (hit) return hit
    try {
      const [r] = await this.ctx.host.instruments([instrumentId])
      if (r) this.rules.set(instrumentId, r)
      return r
    } catch { return undefined }
  }

  invalidateRules = (instrumentId: string): void => { this.rules.delete(instrumentId) }

  /**
   * 宿主推来的 market 流事件。约定（契约没写 market 流的 data 形状，见 TODO(protocol)）：
   * type = market.candle / market.candles，data = { interval, candle | candles[], closed? }。
   */
  onMarketEvent(instrumentId: string | undefined, data: Record<string, unknown>): void {
    // TODO(protocol): market 流事件的 data 形状契约没有规定。
    const interval = typeof data.interval === 'string' ? data.interval : undefined
    if (!instrumentId || !interval) return
    const incoming = (Array.isArray(data.candles) ? data.candles : data.candle ? [data.candle] : []).filter(isCandle)
    if (incoming.length === 0) return
    const key = this.skey(instrumentId, interval)
    // K 线就绪门 + 缺 bar 恢复（思路参照 QuantDinger v5.8.5 candle_readiness / bar_recovery）：
    // 历史没加载过、或推送与已有最后一根之间缺 bar，都不拿残缺序列出信号，改为丢弃序列、重拉历史（trigger 'recover'）。
    const step = INTERVAL_MS[interval]
    if (needsHistoryReload(this.series.get(key)?.candles, incoming, step)) {
      this.series.delete(key)
      for (const i of this.items.values()) {
        if (i.status !== 'running' || i.interval !== interval || !i.instruments.includes(instrumentId)) continue
        i.pushSeen = true
        this.enqueue(i, { instrumentId, candles: null, trigger: 'recover', done: () => undefined })
      }
      return
    }
    const s = this.series.get(key) ?? { candles: [], interval }
    let advanced = false
    for (const c of incoming) {
      const arr = s.candles
      const last = arr[arr.length - 1]
      if (!last || c.t > last.t) { arr.push(c); advanced = true; continue }
      // 在已有 K 线里按 t 找位置（二分）
      let lo = 0
      let hi = arr.length
      while (lo < hi) { const mid = (lo + hi) >>> 1; if (arr[mid]!.t < c.t) lo = mid + 1; else hi = mid }
      const hit = arr[lo]
      if (hit && hit.t === c.t) {
        const changed = hit.o !== c.o || hit.h !== c.h || hit.l !== c.l || hit.c !== c.c || hit.v !== c.v
        arr[lo] = c
        if (changed && lo < arr.length - 1) advanced = true // 已收盘的 K 线被修订
      } else { arr.splice(lo, 0, c); advanced = true }
    }
    if (s.candles.length > CANDLE_KEEP) s.candles.splice(0, s.candles.length - CANDLE_KEEP)
    this.series.set(key, s)
    const closed = data.closed === true
    for (const i of this.items.values()) {
      if (i.status !== 'running' || i.interval !== interval || !i.instruments.includes(instrumentId)) continue
      i.pushSeen = true
      if (advanced || closed) this.enqueue(i, { instrumentId, candles: s.candles.slice(), trigger: 'push', done: () => undefined })
    }
  }

  // ---- 评估 -----------------------------------------------------------------------

  /** 轮询：到点的实例拉一次历史再评估。push 一直在来的实例按 K 线周期兜底，其余按 Demo 的节奏。 */
  async tick(): Promise<void> {
    const now = this.ctx.now()
    for (const i of this.items.values()) {
      if (i.status !== 'running') continue
      const step = INTERVAL_MS[i.interval] ?? 900_000
      const every = i.pushSeen ? step : Math.max(this.pollMin, step / 10)
      if (now - i.lastEvalAt >= every) await this.evaluateNow(i.instanceId, 'poll')
    }
  }

  /** 接管解除后：已经在跑的实例按最新行情重新对一次仓位（接管期间它们什么都没做）。 */
  onResume(): void {
    this.submitter.forgetDone()
    for (const i of this.items.values()) if (i.status === 'running') void this.evaluateNow(i.instanceId, 'update')
  }

  /** 立刻评估一次（拉最新历史）；队列处理完才返回。 */
  evaluateNow(id: string, trigger: 'start' | 'update' | 'poll' | 'manual'): Promise<void> {
    const rec = this.items.get(id)
    if (!rec || rec.status !== 'running') return Promise.resolve()
    rec.lastEvalAt = this.ctx.now()
    return Promise.all(rec.instruments.map((instrumentId) => new Promise<void>((done) => this.enqueue(rec, { instrumentId, candles: null, trigger, done })))).then(() => undefined)
  }

  private enqueue(rec: InstanceRecord, job: EvalJob): void {
    rec.queue.push(job)
    if (rec.queue.length > this.backlog) {
      // 积压：只保留最新的，中间的丢掉（回灌历史时才会发生）
      const drop = rec.queue.length - this.backlog
      for (const d of rec.queue.splice(0, drop)) d.done()
      rec.skippedEvals += drop
    }
    if (!rec.draining) void this.drain(rec)
  }

  private async drain(rec: InstanceRecord): Promise<void> {
    rec.draining = true
    try {
      while (rec.queue.length > 0) {
        const job = rec.queue.shift()!
        try { await this.evalOne(rec, job) } catch (e) { this.onEvalError(rec, e) } finally { job.done() }
      }
    } finally { rec.draining = false }
  }

  private onEvalError(rec: InstanceRecord, e: unknown): void {
    const p: Problem = e instanceof RpcError ? e.problem : { code: PROBLEM_CODES.STRATEGY_ERROR.code, name: 'STRATEGY_ERROR', category: 'ENGINE', message: e instanceof Error ? e.message : 'evaluation failed', retryable: true }
    rec.error = p
    rec.lastEvalAt = this.ctx.now()
    this.ctx.log('warn', 'instance evaluation failed', { instanceId: rec.instanceId, code: p.code })
    this.ctx.emit({ stream: 'strategy', type: 'strategy.error', accountId: rec.accountId, data: { instanceId: rec.instanceId, problem: p }, origin: this.ctx.origin(`strategy:${rec.strategyId}`, { instanceId: rec.instanceId as InstanceId }), key: rec.instanceId })
  }

  private async evalOne(rec: InstanceRecord, job: EvalJob): Promise<void> {
    if (rec.status !== 'running') return
    const ctx = this.ctx
    const { instrumentId } = job
    const gctx = { accountId: rec.accountId, instrumentId, strategyId: rec.strategyId, mandateId: rec.mandateId }
    // 接管（cancel_all / flatten_all）期间引擎什么都不发：连行情都不用拉
    const canOpen = ctx.guard.gate(gctx, 'open').ok
    const canReduce = ctx.guard.gate(gctx, 'reduce').ok
    rec.lastEvalAt = ctx.now()
    if (!canOpen && !canReduce) return
    const candles = job.candles ?? await this.candlesFor(instrumentId, rec.interval, job.trigger !== 'manual')
    rec.evals += 1
    rec.error = undefined
    if (rec.kind === 'workflow') {
      await this.workflows.evaluate(rec, instrumentId, candles, { canOpen, canReduce })
      return
    }
    const def = rec.def as StrategyDef
    const step = INTERVAL_MS[rec.interval]!
    const sig = latestSignal(def, candles, strategyOnlyParams(rec.params), step, ctx.now())
    const per = rec.per.get(instrumentId) ?? {}
    rec.per.set(instrumentId, per)
    if (!sig) { per.lastSignal = { warmup: true, reason: 'not enough bars; indicators still warming up' }; return }
    const reason = sig.reason || sig.lastChange || '目标仓位变化'
    per.lastSignal = { target: sig.target, reason, asOf: sig.t, price: sig.price }
    // 目标仓位变化 = 一条新信号
    if (per.emittedTarget !== sig.target && !(per.emittedTarget === undefined && sig.target === 0)) {
      per.emittedTarget = sig.target
      const origin = ctx.origin(`strategy:${rec.strategyId}`, { instanceId: rec.instanceId as InstanceId, strategyId: rec.strategyId })
      ctx.emit({
        stream: 'signal', type: 'signal.created', accountId: rec.accountId, instrumentId, ts: sig.t + step, origin, causation: origin.causation,
        data: { signalId: newId('sig'), ts: sig.t + step, instrumentId, kind: 'target', target: sig.target, expiresAt: sig.t + 2 * step, reason, origin },
      })
    } else if (per.emittedTarget === undefined) per.emittedTarget = sig.target
    await this.act(rec, instrumentId, { target: sig.target, price: sig.price, barT: sig.t, reason, fp: fingerprint(candles, sig.index) }, { canOpen, canReduce })
  }

  /** 信号 → 持仓差额 → 订单意图 → host.order.place。 */
  async act(rec: InstanceRecord, instrumentId: string, s: { target: number; price: number; barT: number; reason: string; fp: string }, g: { canOpen: boolean; canReduce: boolean }, tool?: string, sizingOverride?: Partial<Sizing>): Promise<void> {
    const ctx = this.ctx
    const snap = await ctx.host.accountSnapshot(rec.accountId)
    if (rec.status !== 'running') return // 等快照期间实例被停了 / 会话换了：不再出单
    const equity = Number(snap.margin.equity)
    const pos = signedPosition(snap, instrumentId)
    const sizing = { ...rec.sizing, ...(sizingOverride ?? {}) }
    const def = rec.def as StrategyDef
    const cap = def.notionalCap ? def.notionalCap(strategyOnlyParams(rec.params)) : undefined
    let plan = planOrder({ target: s.target, price: s.price, equity, position: pos, sizing, signalReason: s.reason, notionalCap: cap })
    if (plan.action === 'none') return
    const limits = ctx.guard.limitsFor({ accountId: rec.accountId, instrumentId, strategyId: rec.strategyId, mandateId: rec.mandateId })
    if (!plan.reduceOnly) {
      if (!g.canOpen) { this.note(rec, instrumentId, `skip open: ${ctx.guard.gate({ accountId: rec.accountId, instrumentId }, 'open').why ?? 'blocked'}`); return }
      plan = capByExposure(plan, { price: s.price, equity, snap, instrumentId, hasPosition: pos !== 0, limits })
      if (plan.action === 'none') { this.note(rec, instrumentId, `skip open: ${plan.reason}`); return }
    } else if (!g.canReduce) return
    const rules = await this.rulesFor(instrumentId)
    if (rec.status !== 'running') return
    const sizeCap = typeof rec.params[INSTANCE_SIZE_KEY] === 'string' ? Number(rec.params[INSTANCE_SIZE_KEY]) : undefined
    const built = buildIntent(plan, {
      accountId: rec.accountId, instrumentId, price: s.price, rules, sizing, limits, reason: `${rec.strategyId}: ${plan.reason}`,
      cidParts: [rec.instanceId, instrumentId, s.barT, s.fp, plan.action], ...(sizeCap !== undefined ? { sizeCap } : {}),
    })
    if (!built.ok) { this.note(rec, instrumentId, `skip: ${built.skip}`); return }
    const coid = built.intent.clientOrderId as string
    const origin: Origin = ctx.origin(tool ?? `strategy:${rec.strategyId}`, { instanceId: rec.instanceId as InstanceId, strategyId: rec.strategyId, mandateId: rec.mandateId as never })
    const out = await this.submitter.submit({
      accountId: rec.accountId, instrumentId, intent: built.intent, kind: plan.reduceOnly ? 'reduce' : 'open', strategyId: rec.strategyId, instanceId: rec.instanceId,
      mandateId: rec.mandateId, barKey: `${rec.instanceId}|${instrumentId}|${s.barT}`, origin, invalidateRules: this.invalidateRules,
    })
    this.note(rec, instrumentId, `${out.status}: ${out.note}`)
    this.reportOrder(rec, instrumentId, origin, out, { clientOrderId: coid, side: built.intent.side, size: built.intent.size as string, reduceOnly: built.intent.reduceOnly ?? false, reason: plan.reason })
  }

  /** 下单结果入事件流（strategy 流，无损）。被本地闸挡下的（blocked）只记在实例上，不刷事件。 */
  reportOrder(rec: InstanceRecord, instrumentId: string, origin: Origin, out: SubmitOutcome, d: { clientOrderId: string; side: string; size: string; reduceOnly: boolean; reason: string; extra?: Record<string, unknown> }): void {
    if (out.status === 'blocked') return
    this.ctx.emit({
      stream: 'strategy', type: `strategy.order_${out.status}`, accountId: rec.accountId, instrumentId, origin, causation: origin.causation,
      data: { instanceId: rec.instanceId, ...(d.extra ?? {}), clientOrderId: d.clientOrderId, side: d.side, size: d.size, reduceOnly: d.reduceOnly, reason: d.reason, outcome: out.status, ...(out.orderId ? { orderId: out.orderId } : {}), ...(out.problem ? { problem: out.problem } : {}) },
    })
  }

  private note(rec: InstanceRecord, instrumentId: string, text: string): void {
    rec.lastAction = text
    const per = rec.per.get(instrumentId)
    if (per) per.lastAction = text
  }
}

// ---- 小工具 -------------------------------------------------------------------------

/** 决策输入指纹：到第 idx 根（含）为止最近 400 根已收盘 K 线的摘要。输入不变则不变。 */
/** 推送的 K 线该不该放弃增量、改拉全量历史：序列未就绪（空），或首根新 K 线与最后一根之间隔了不止一个周期。 */
export function needsHistoryReload(have: readonly Candle[] | undefined, incoming: readonly Candle[], stepMs: number | undefined): boolean {
  const last = have?.[have.length - 1]
  if (!last) return true
  if (!stepMs) return false
  const firstNew = incoming.find((c) => c.t > last.t)
  return !!firstNew && firstNew.t - last.t > stepMs
}

export function fingerprint(candles: readonly Candle[], idx: number): string {
  return candlesDigest(candles.slice(Math.max(0, idx - 399), idx + 1)).slice(7, 23)
}

function isCandle(c: unknown): c is Candle {
  if (!c || typeof c !== 'object') return false
  const o = c as Record<string, unknown>
  return ['t', 'o', 'h', 'l', 'c'].every((k) => typeof o[k] === 'number' && Number.isFinite(o[k] as number))
}

function pickNumbers(o: Partial<Sizing>): Partial<Sizing> {
  const out: Partial<Sizing> = {}
  for (const k of ['allocRatio', 'allocCapNotional', 'leverage', 'maxSlippageBps', 'minStepNotional'] as const) {
    const v = (o as Record<string, unknown>)[k]
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v
  }
  return out
}
