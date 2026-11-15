// SPDX-License-Identifier: CPAL-1.0
// EngineCore：GEP 服务端的核心（与传输无关）。持有会话、绑定、风控推送、接管、实例、回测任务与回放，
// 把 JSON-RPC 方法表映射到它们身上。传输层（WS / stdio）只负责把帧送进 connect() 返回的连接对象。
//
// 模式 A（经工作台连接器下单）：引擎不直连场所，不持有任何密钥；订单意图经 host.order.place 交给宿主。
// 风控：risk.policy.push 只会让引擎少做点；risk.precheck 由宿主侧实现，引擎可预览；engine.halt 在时限内停止新动作并确认。
import { timingSafeEqual } from 'node:crypto'
import {
  GEP_LIMITS, GEP_METHODS, GEP_STREAM_NAMES, RESEARCH_CAPABILITY, TAKEOVER_LEVELS, engineMethodSupported, findSecretFields, negotiateVersion,
  type Binding, type EngineDescribe, type GepEvent, type GepStream, type JsonRpcId, type Origin, type Problem, type RiskPolicy, type TakeoverScope,
} from '../proto'
import { RpcError, RpcPeer, rpcErr } from '../gep/peer'
import { Session, type EventDraft, type SessionOptions } from '../gep/session'
import { nodeCatalog, NODE_GROUPS, BLANK_WORKFLOW, validateWorkflow } from '../flow'
import { StrategyFolder, StrategyRegistry, type FileReport, type StrategyDef } from '../strategy'
import { getStrategySha256 } from '../strategy/loader'
import { defaultsOf, instanceParamsSchema } from '../strategy/schema'
import { sha256Hex, newRequestId } from '../util/hash'
import { redact } from '../util/redact'
import { BacktestJobs, type JobsOptions } from './backtest-jobs'
import type { EngineContext, LogLevel } from './context'
import { buildDescribe, ENGINE_ID, ENGINE_VERSION } from './describe'
import { LocalGuard } from './guard'
import { HostApi, type HostLink } from './host-api'
import { InstanceManager, type InstanceManagerOptions } from './instances'
import { ReplayManager, type ReplayOptions } from './replay'
import { ResearchJobs, type ResearchProvider } from './research'

export interface EngineCoreOptions {
  /** 一次性令牌（宿主经 GITRADER_GEP_TOKEN 交给自启引擎）；hello 必须带它。 */
  token: string
  now?: () => number
  /** 心跳周期（毫秒，≤ 5000）。 */
  heartbeatMs?: number
  session?: SessionOptions
  instances?: InstanceManagerOptions
  jobs?: JobsOptions
  replay?: ReplayOptions
  /** 引擎自己的日志出口（stderr）。 */
  logSink?: (line: string) => void
  /** engine.shutdown 响应发出后调用（进程入口在这里退出）。 */
  onShutdown?: () => void
  /** 策略文件夹（通常是 ~/.gitrader/engines/gitrader-core/strategies，由内核配置交给引擎）。不给 = 不加载任何策略。 */
  strategiesDir?: string
  /** 兜底轮询与失联检查的节拍（毫秒）；测试里调小。 */
  tickMs?: number
  /** 内置策略（产品层装配时注入，默认空）。 */
  builtinStrategies?: StrategyDef[]
  /** 研究作业的计算提供者（产品层装配时注入：寻优 / 因子报告）。不给 = 引擎不声明 x-gitrader.research，相关方法回 5002。 */
  research?: ResearchProvider
}

export interface Conn {
  readonly id: number
  readonly kind: 'ws' | 'stdio' | 'memory'
  readonly peer: RpcPeer
  authed: boolean
  session: Session | null
  lastHeartbeat: number
  heartbeatMs: number
  hb: NodeJS.Timeout | null
  closeTransport(): void
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const invalid = (msg: string): never => { throw rpcErr('INVALID_PARAMS', msg) }

export class EngineCore implements EngineContext {
  readonly engineId = ENGINE_ID
  readonly version = ENGINE_VERSION
  readonly guard: LocalGuard
  readonly strategies = new StrategyRegistry()
  readonly strategyFolder: StrategyFolder | null
  readonly host: HostApi
  readonly instances: InstanceManager
  readonly jobs: BacktestJobs
  readonly replays: ReplayManager
  readonly research: ResearchJobs | null

  private active: Conn | null = null
  private session: Session | null = null
  private connSeq = 0
  private readonly bindings = new Map<string, Binding>()
  private readonly seenHostEvents = new Set<string>()
  private readonly hostOrders = new Map<string, Record<string, unknown>>()
  private lastHostSeq = 0
  private hostAckPending = 0
  private hostAckTimer: NodeJS.Timeout | null = null
  private timer: NodeJS.Timeout | null = null
  private shuttingDown = false
  private readonly startedAt: number
  private readonly o: EngineCoreOptions
  private readonly tokenDigest: Buffer

  constructor(opts: EngineCoreOptions) {
    this.o = opts
    this.tokenDigest = Buffer.from(sha256Hex(opts.token), 'hex')
    this.startedAt = this.now()
    this.guard = new LocalGuard(() => this.now())
    this.guard.hostLost = true // 还没有宿主连上
    this.host = new HostApi(() => this.link())
    this.instances = new InstanceManager(this, opts.instances)
    this.jobs = new BacktestJobs(this, opts.jobs)
    this.replays = new ReplayManager(this, opts.replay)
    this.research = opts.research ? new ResearchJobs(this, { provider: opts.research }, { maxBars: this.jobs.maxBars }) : null
    // 注册内置策略（产品层注入）
    for (const def of opts.builtinStrategies ?? []) this.strategies.set(def)
    this.strategyFolder = opts.strategiesDir
      ? new StrategyFolder(opts.strategiesDir, this.strategies, { now: () => this.now(), log: (l, m, f) => this.log(l, m, f), onChange: (r) => this.onStrategyFile(r) })
      : null
    this.timer = setInterval(() => void this.tickOnce(), opts.tickMs ?? 250)
    this.timer.unref?.()
    this.ready = this.strategyFolder ? this.strategyFolder.start() : Promise.resolve()
  }

  /** 策略文件夹第一次扫描完成。 */
  readonly ready: Promise<void>

  get describe(): EngineDescribe {
    const d = buildDescribe({ maxBars: this.jobs.maxBars, maxConcurrentBacktests: this.o.jobs?.maxConcurrent ?? 2, maxInstances: this.o.instances?.maxInstances ?? 20 }, this.strategies)
    return this.research ? { ...d, capabilities: { ...d.capabilities, [RESEARCH_CAPABILITY]: true } } : d
  }

  private onStrategyFile(r: FileReport): void {
    // 策略 流（无损）：Agent 订阅它就能看到「文件 -> 校验结果」
    this.emit({
      stream: 'strategy', type: r.status === 'loaded' ? 'strategy.loaded' : r.status === 'removed' ? 'strategy.unloaded' : 'strategy.load_failed',
      data: { file: r.file, ...(r.id ? { id: r.id } : {}), ...(r.version ? { version: r.version } : {}), errors: r.errors, warnings: r.warnings }, origin: this.origin('strategy-folder'),
    })
  }

  // ---- EngineContext --------------------------------------------------------------

  now(): number { return (this.o.now ?? Date.now)() }

  emit(d: EventDraft): void { this.session?.emit(d) }

  log(level: LogLevel, message: string, fields: Record<string, string | number | boolean | null> = {}): void {
    const safe: Record<string, string | number | boolean | null> = {}
    for (const [k, v] of Object.entries(fields)) safe[k] = typeof v === 'string' ? redact(v) : v
    const msg = redact(message)
    this.o.logSink?.(`${new Date(this.now()).toISOString()} ${level} ${msg}${Object.keys(safe).length ? ' ' + JSON.stringify(safe) : ''}`)
    if (level !== 'debug') this.session?.emit({ stream: 'log', type: 'log.line', data: { level, message: msg, fields: safe } })
  }

  origin(tool: string, causation?: Origin['causation']): Origin {
    return { actor: `engine:${this.engineId}`, actorType: 'engine', tool, requestId: newRequestId(), via: 'gep', ...(causation ? { causation } : {}) }
  }

  private link(): HostLink | null {
    const c = this.active
    return c && c.authed && !c.peer.isClosed ? { call: (m, p, t) => c.peer.call(m, p, t), notify: (m, p) => c.peer.notify(m, p) } : null
  }

  // ---- 连接 -------------------------------------------------------------------------

  connect(t: { kind: Conn['kind']; send(text: string): void; closeTransport(): void; maxFrameBytes: number }): Conn {
    const conn: Conn = {
      id: ++this.connSeq, kind: t.kind, authed: false, session: null, lastHeartbeat: this.now(), heartbeatMs: this.o.heartbeatMs ?? GEP_LIMITS.heartbeatIntervalMs, hb: null, closeTransport: t.closeTransport,
      peer: new RpcPeer({
        send: t.send, maxFrameBytes: t.maxFrameBytes,
        handle: (method, params, id) => this.handle(conn, method, params, id),
        onNotify: (method, params) => this.onNotify(conn, method, params),
        onInternalError: (method, err) => this.log('error', `internal error in ${method}`, { error: err instanceof Error ? err.name : 'unknown' }),
      }),
    }
    return conn
  }

  disconnect(conn: Conn): void {
    conn.peer.close()
    if (conn.hb) { clearInterval(conn.hb); conn.hb = null }
    if (conn.session && this.active === conn) conn.session.detach()
    if (this.active === conn) {
      this.active = null
      this.markHostLost('connection closed')
    }
  }

  private markHostLost(why: string): void {
    if (this.guard.hostLost) return
    this.guard.hostLost = true
    this.emit({ stream: 'strategy', type: 'strategy.host_lost', data: { reason: why }, origin: this.origin('engine') })
    this.log('warn', 'host lost; no new opening orders until it is back', { reason: why })
  }

  private markHostBack(): void {
    if (!this.guard.hostLost) return
    this.guard.hostLost = false
    this.emit({ stream: 'strategy', type: 'strategy.host_restored', data: {}, origin: this.origin('engine') })
  }

  // ---- 周期任务 ---------------------------------------------------------------------

  private async tickOnce(): Promise<void> {
    const c = this.active
    if (c && c.authed) {
      // 连续 3 个周期收不到宿主心跳 → 判定失联（略早于 15 s，宁早勿晚）
      const timeout = Math.max(500, 3 * c.heartbeatMs - 750)
      if (this.now() - c.lastHeartbeat > timeout) this.markHostLost('heartbeat timeout')
    }
    // 保留窗过期的断线会话丢弃
    const s = this.session
    if (s && s.detachedAt !== null && this.now() - s.detachedAt > (this.o.session?.retentionMinMs ?? GEP_LIMITS.retentionMinMs)) { s.dispose(); this.session = null }
    try { await this.instances.tick() } catch (e) { this.log('error', 'instance tick failed', { error: e instanceof Error ? e.name : 'unknown' }) }
  }

  close(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
    this.strategyFolder?.stop()
    this.research?.close()
    if (this.hostAckTimer) { clearTimeout(this.hostAckTimer); this.hostAckTimer = null }
    this.session?.dispose()
  }

  // ---- 方法分发 ---------------------------------------------------------------------

  /** 请求入口：鉴权闸 → 秘密字段扫描 → 能力闸 → 方法实现。 */
  private async handle(conn: Conn, method: string, params: unknown, id: JsonRpcId): Promise<unknown> {
    void id
    if (method === 'gep.hello') return this.hello(conn, params)
    if (!conn.authed) throw rpcErr('AUTH_FAILED', 'send gep.hello with a valid token first')
    // S1：协议里不存在传递密钥明文的字段。BacktestSpec.seed 是确定性种子（整数），不是密钥，只放过 spec.seed 这一处。
    let scan: unknown = params
    if ((method === 'backtest.run' || method === 'replay.start') && isObj(params) && isObj(params.spec)) {
      const { seed: _seed, ...specRest } = params.spec
      scan = { ...params, spec: specRest }
    }
    const hits = findSecretFields(scan)
    if (hits.length > 0) throw rpcErr('SECRET_FIELD_REJECTED', `secret-like field rejected: ${hits.join(', ')}`)
    const p = isObj(params) ? params : {}
    switch (method) {
      case 'engine.describe': return this.describe
      case 'engine.bind': return this.bind(p)
      case 'engine.health': return this.health()
      case 'engine.snapshot': return this.snapshot(p)
      case 'engine.halt': return this.halt(p)
      case 'engine.resume': return this.resume(p)
      case 'engine.shutdown': return this.shutdown(p)
      case 'events.subscribe': return this.subscribe(conn, p)
      case 'events.unsubscribe': {
        const ok = typeof p.subscriptionId === 'string' && !!conn.session?.unsubscribe(p.subscriptionId)
        if (!ok) invalid('unknown subscriptionId')
        return { ok: true }
      }
      case 'risk.policy.push': return this.pushPolicy(p)
      case 'strategy.list': return this.strategyList()
      case 'strategy.params': return this.strategyParams(p)
      case 'strategy.start': return this.strategyStart(p)
      case 'strategy.stop': return this.strategyStop(p)
      case 'strategy.update': return this.strategyUpdate(p)
      case 'strategy.status': return this.strategyStatus(p)
      case 'backtest.run': return { jobId: this.jobs.submit(p.spec) }
      case 'backtest.status': return this.jobs.status(p.jobId)
      case 'backtest.result': return this.jobs.result(p.jobId)
      case 'backtest.cancel': return this.jobs.cancel(p.jobId)
      case 'replay.start': return { replayId: this.replays.start(p.spec) }
      case 'replay.stop': return this.replays.stop(p.replayId)
      case 'replay.status': return this.replays.status(p.replayId)
      case 'x-gitrader.workflow.nodes': return this.workflowNodes()
      case 'x-gitrader.workflow.blank': return { workflow: BLANK_WORKFLOW }
      case 'x-gitrader.strategy.files': return this.strategyFiles()
      case 'x-gitrader.research.run': return this.researchOf().submit(p.kind, p.spec)
      case 'x-gitrader.research.status': return this.researchOf().status(p.jobId)
      case 'x-gitrader.research.result': return this.researchOf().result(p.jobId, p.part, p.limit, p.cursor)
      case 'x-gitrader.research.cancel': return this.researchOf().cancel(p.jobId)
      case 'x-gitrader.workflow.validate': return this.workflowValidate(p)
      case 'x-gitrader.workflow.run': return this.workflowRun(p)
      case 'x-gitrader.workflow.values': return this.workflowValues(p)
      default: break
    }
    // 契约里有、但本引擎没声明的可选方法 → 5002；其它一律 -32601
    if (method in GEP_METHODS && GEP_METHODS[method as keyof typeof GEP_METHODS].side === 'engine' && !GEP_METHODS[method as keyof typeof GEP_METHODS].notification) {
      if (!engineMethodSupported(method as never, this.describe.capabilities)) throw rpcErr('CAPABILITY_UNSUPPORTED', `${method} is not declared in engine.describe`)
    }
    throw rpcErr('METHOD_NOT_FOUND', 'method not found')
  }

  /** 研究作业表；产品层没注入 provider 时按「能力位未声明」回 5002。 */
  private researchOf(): ResearchJobs {
    if (!this.research) throw rpcErr('CAPABILITY_UNSUPPORTED', `${RESEARCH_CAPABILITY} is not declared in engine.describe`)
    return this.research
  }

  // ---- 握手 -------------------------------------------------------------------------

  private hello(conn: Conn, params: unknown): unknown {
    const p = isObj(params) ? params : {}
    if (p.protocol !== 'gep' || !Array.isArray(p.versions) || !p.versions.every((v) => typeof v === 'string')) invalid('gep.hello needs { protocol: "gep", versions: string[], host, auth }')
    const token = isObj(p.auth) && typeof p.auth.token === 'string' ? p.auth.token : ''
    const given = Buffer.from(sha256Hex(token), 'hex')
    if (!timingSafeEqual(given, this.tokenDigest)) {
      // 错误令牌：回 5003，随后断开（1 s 内）
      setTimeout(() => { conn.peer.close(); conn.closeTransport() }, 50).unref?.()
      throw rpcErr('AUTH_FAILED', 'authentication failed')
    }
    const version = negotiateVersion(p.versions as string[])
    if (!version) throw rpcErr('VERSION_UNSUPPORTED', 'no common GEP version (this engine supports 0.1)')
    // 新宿主连接顶替旧连接（同一个宿主重连）
    if (this.active && this.active !== conn) {
      const old = this.active
      this.active = null
      if (old.hb) { clearInterval(old.hb); old.hb = null }
      old.session?.detach()
      old.peer.close()
      old.closeTransport()
    }
    conn.authed = true
    this.active = conn
    conn.lastHeartbeat = this.now()
    const bindHb = (): void => {
      if (conn.hb) clearInterval(conn.hb)
      conn.hb = setInterval(() => conn.peer.notify('gep.heartbeat', { ts: this.now(), ...(conn.session ? { seq: conn.session.seq } : {}) }), conn.heartbeatMs)
      conn.hb.unref?.()
    }
    const resume = isObj(p.resume) && typeof p.resume.sessionId === 'string' && Number.isInteger(p.resume.lastSeq) ? { sessionId: p.resume.sessionId, lastSeq: p.resume.lastSeq as number } : null
    const engine = { id: this.engineId, version: this.version }
    let problem: Problem | null = null
    let resumed = false
    let fromSeq: number | undefined
    if (resume) {
      const s = this.session
      if (!s || s.id !== resume.sessionId) problem = rpcErr('SESSION_GAP', 'unknown or expired session; call engine.snapshot to realign').problem
      else {
        const verdict = s.canResumeFrom(resume.lastSeq)
        if (verdict === 'future') throw rpcErr('SEQUENCE_ERROR', 'lastSeq is ahead of the session')
        if (verdict === 'gap') problem = rpcErr('SESSION_GAP', 'events after lastSeq are no longer retained; call engine.snapshot to realign').problem
        else {
          resumed = true
          fromSeq = resume.lastSeq + 1
          s.rewindTo(resume.lastSeq)
          s.attach((m, pr) => conn.peer.notify(m, pr))
          conn.session = s
        }
      }
    }
    if (!resumed) {
      // 全新会话（或续传失败后的新会话）；旧会话的事件宿主不再要了
      // 没有要求续传 = 宿主重新开始：旧会话留下的实例、绑定、接管、风控推送都属于已结束的会话，清掉。
      // 续传失败（5004）不清，宿主要用 engine.snapshot 对齐现状。
      if (!resume) this.resetForFreshSession()
      this.session?.dispose()
      const s = new Session({ ...(this.o.session ?? {}), ...(this.o.now ? { now: this.o.now } : {}) })
      s.attach((m, pr) => conn.peer.notify(m, pr))
      this.session = s
      conn.session = s
    }
    bindHb()
    this.markHostBack()
    // 握手完成后补订阅宿主数据（宿主需要先收到 hello 的响应，所以放到下一个宏任务）
    setImmediate(() => this.resubscribe())
    if (problem) {
      // 5004：连接仍然有效（令牌已验证），宿主可以直接调用 engine.snapshot 对齐
      throw new RpcError(problem)
    }
    return { version, sessionId: conn.session!.id, resumed, ...(fromSeq !== undefined ? { fromSeq } : {}), engine }
  }

  /** 新宿主会话：丢弃上一个会话的运行状态。 */
  private resetForFreshSession(): void {
    this.instances.reset()
    this.bindings.clear()
    this.guard.reset()
    this.seenHostEvents.clear()
    this.hostOrders.clear()
    this.lastHostSeq = 0
    this.hostAckPending = 0
  }

  /** 订阅宿主事件与行情（重连后也要重订）。宿主没实现这些方法就算了。 */
  private resubscribe(): void {
    const accounts = [...new Set([...this.bindings.values()].flatMap((b) => b.accounts.map((a) => a.accountId)))]
    if (accounts.length > 0) {
      void this.host.call('host.events.subscribe', { streams: ['order', 'fill', 'position', 'funding', 'account', 'takeover', 'policy'], accountIds: accounts }).catch(() => undefined)
    }
    for (const i of this.instances.all()) {
      if (i.status !== 'running') continue
      void this.host.call('host.market.subscribe', { channels: i.instruments.map((instrumentId) => ({ type: 'candles' as const, instrumentId, interval: i.interval })) }).catch(() => undefined)
    }
  }

  // ---- 绑定 / 事件 / 风控 / 接管 ---------------------------------------------------------

  private async bind(p: Record<string, unknown>): Promise<unknown> {
    const b = p as unknown as Binding
    if (typeof b.bindingId !== 'string' || !Array.isArray(b.accounts)) invalid('engine.bind needs { bindingId, accounts[], data, policies, heartbeatMs }')
    const warnings: string[] = []
    for (const a of b.accounts) {
      if (!isObj(a) || typeof a.accountId !== 'string' || typeof a.mandateId !== 'string') invalid('each binding account needs { accountId, mode, mandateId }')
      if (a.mode === 'B') throw rpcErr('CAPABILITY_UNSUPPORTED', 'execution.modeB is not declared in engine.describe; bind this account with mode "A"')
      if (a.mode !== 'A') invalid('binding account mode must be "A" or "B"')
    }
    const dataSource = isObj(b.data) ? b.data.source : undefined
    if (dataSource === 'engine') throw rpcErr('CAPABILITY_UNSUPPORTED', 'market.own is not declared in engine.describe; use data.source "host"')
    if (dataSource !== undefined && dataSource !== 'host') invalid('binding data.source must be "host"')
    // 账户必须是宿主已绑定的账户（1005）。宿主没实现 host.describe 时放行并给警告。
    try {
      const d = await this.host.call('host.describe', {})
      const known = new Set(d.accounts.map((x) => x.accountId))
      const unknown = b.accounts.filter((a) => !known.has(a.accountId)).map((a) => a.accountId)
      if (unknown.length) throw rpcErr('ACCOUNT_NOT_BOUND', `account not known to the host: ${unknown.join(', ')}`)
    } catch (e) {
      if (e instanceof RpcError && e.problem.code === 1005) throw e
      warnings.push('host.describe unavailable: account existence was not verified')
    }
    const effective: Binding = {
      bindingId: b.bindingId, accounts: b.accounts.map((a) => ({ accountId: a.accountId, mode: 'A', mandateId: a.mandateId })),
      data: { source: 'host', instruments: Array.isArray(b.data?.instruments) ? b.data.instruments.filter((x): x is string => typeof x === 'string') : [] },
      policies: Array.isArray(b.policies) ? b.policies : [],
      builder: { attachedBy: 'host' },
      heartbeatMs: Math.min(GEP_LIMITS.heartbeatIntervalMs, Math.max(250, Number.isFinite(b.heartbeatMs) ? Number(b.heartbeatMs) : GEP_LIMITS.heartbeatIntervalMs)),
    }
    if (b.builder?.attachedBy === 'engine') warnings.push('builder.attach is not supported: the host attaches the builder (effective builder.attachedBy = "host")')
    this.bindings.set(b.bindingId, effective)
    if (this.active) {
      this.active.heartbeatMs = effective.heartbeatMs
      if (this.active.hb) { clearInterval(this.active.hb); const c = this.active; c.hb = setInterval(() => c.peer.notify('gep.heartbeat', { ts: this.now(), ...(c.session ? { seq: c.session.seq } : {}) }), c.heartbeatMs); c.hb.unref?.() }
    }
    setImmediate(() => this.resubscribe())
    return { bindingId: b.bindingId, effective, warnings }
  }

  accountBound = (accountId: string): boolean => [...this.bindings.values()].some((b) => b.accounts.some((a) => a.accountId === accountId))

  private subscribe(conn: Conn, p: Record<string, unknown>): unknown {
    const s = conn.session
    if (!s) throw rpcErr('AUTH_FAILED', 'no session')
    if (!Array.isArray(p.streams) || p.streams.length === 0 || !p.streams.every((x) => typeof x === 'string' && (GEP_STREAM_NAMES as readonly string[]).includes(x))) invalid(`streams must be a non-empty array of: ${GEP_STREAM_NAMES.join(', ')}`)
    const accountIds = Array.isArray(p.accountIds) ? p.accountIds.filter((x): x is string => typeof x === 'string') : undefined
    const fromSeq = typeof p.fromSeq === 'number' && Number.isInteger(p.fromSeq) ? p.fromSeq : undefined
    return s.subscribe(p.streams as GepStream[], accountIds, fromSeq)
  }

  private pushPolicy(p: Record<string, unknown>): unknown {
    if (!Array.isArray(p.policies)) invalid('risk.policy.push needs { policies: RiskPolicy[], effectiveAt }')
    for (const x of p.policies as unknown[]) {
      if (!isObj(x) || typeof x.policyId !== 'string' || !Number.isInteger(x.version) || !isObj(x.scope) || typeof x.scope.type !== 'string' || typeof x.scope.id !== 'string' || !isObj(x.limits)) invalid('each policy needs { policyId, version, scope: {type, id}, limits }')
    }
    const effectiveAt = typeof p.effectiveAt === 'number' ? p.effectiveAt : this.now()
    const accepted = this.guard.acceptPolicies(p.policies as RiskPolicy[], effectiveAt)
    this.log('info', 'risk policies applied (tighten-only)', { count: accepted.length, version: this.guard.policyVersion() })
    return { acceptedVersions: accepted }
  }

  private halt(p: Record<string, unknown>): unknown {
    if (typeof p.takeoverId !== 'string' || typeof p.reason !== 'string' || !isObj(p.scope) || typeof p.deadlineMs !== 'number') invalid('engine.halt needs { takeoverId, level, scope, reason, deadlineMs }')
    if (!(TAKEOVER_LEVELS as readonly string[]).includes(p.level as string)) invalid(`level must be one of ${TAKEOVER_LEVELS.join(', ')}`)
    const t = { takeoverId: p.takeoverId as string, level: p.level as (typeof TAKEOVER_LEVELS)[number], scope: p.scope as TakeoverScope, reason: p.reason as string, at: this.now(), deadlineMs: p.deadlineMs as number }
    this.guard.halt(t)
    for (const i of this.instances.all()) {
      if (i.status !== 'running') continue
      if (this.guard.stateFor({ accountId: i.accountId, strategyId: i.strategyId, instrumentId: i.instruments[0]! }) !== 'ACTIVE') {
        this.emit({ stream: 'strategy', type: 'strategy.halted', accountId: i.accountId, data: { instanceId: i.instanceId, takeoverId: t.takeoverId, level: t.level }, origin: this.origin('engine', { instanceId: i.instanceId as never }) })
      }
    }
    return { ack: true, appliedAt: this.now() }
  }

  private resume(p: Record<string, unknown>): unknown {
    if (typeof p.takeoverId !== 'string' || typeof p.approvedBy !== 'string' || p.approvedBy === '') invalid('engine.resume needs { takeoverId, scope, approvedBy }')
    const lifted = this.guard.resume(p.takeoverId as string)
    if (lifted.length === 0) invalid('unknown takeoverId (nothing to resume)')
    this.instances.onResume()
    for (const t of lifted) this.emit({ stream: 'strategy', type: 'strategy.resumed', data: { takeoverId: t.takeoverId, approvedBy: p.approvedBy }, origin: this.origin('engine') })
    return { resumedAt: this.now() }
  }

  private shutdown(p: Record<string, unknown>): unknown {
    void p
    if (!this.shuttingDown) {
      this.shuttingDown = true
      for (const i of this.instances.all()) if (i.status === 'running') this.instances.stop(i.instanceId)
      // 响应先发出去，再退出
      setTimeout(() => { this.close(); this.o.onShutdown?.() }, 30).unref?.()
    }
    return { ok: true }
  }

  private health(): unknown {
    const insts = this.instances.all()
    const c = this.jobs.counts()
    const errors = insts.filter((i) => i.error).length
    const s = this.session
    return {
      status: this.guard.hostLost || errors > 0 ? 'degraded' : 'ok',
      metrics: {
        strategiesLoaded: this.strategies.size, strategyFileErrors: (this.strategyFolder?.reports() ?? []).filter((r) => r.status === 'error').length,
        instancesRunning: this.instances.runningCount(), instancesTotal: insts.length, instancesWithError: errors,
        backtestsRunning: c.running, backtestsQueued: c.queued, hostLost: this.guard.hostLost ? 1 : 0,
        eventsBuffered: s?.bufferedEvents ?? 0, eventsUnacked: s?.unacked ?? 0, policyVersion: this.guard.policyVersion(), takeovers: this.guard.activeTakeovers().length,
        uptimeMs: this.now() - this.startedAt,
      },
      ts: this.now(),
    }
  }

  private snapshot(p: Record<string, unknown>): unknown {
    const only = Array.isArray(p.accountIds) ? new Set(p.accountIds.filter((x): x is string => typeof x === 'string')) : null
    const strategies = this.instances.all().filter((i) => !only || only.has(i.accountId)).map((i) => this.instances.view(i))
    const orders = [...this.hostOrders.values()].filter((o) => !only || (typeof o.accountId === 'string' && only.has(o.accountId)))
    return { seq: this.session?.seq ?? 0, strategies, orders }
  }

  // ---- 策略 -------------------------------------------------------------------------

  private strategyList(): unknown {
    return {
      strategies: this.strategies.list().map((s) => {
        const sha256 = getStrategySha256(s)
        const entry: Record<string, unknown> = {
          id: s.id, name: s.name, version: s.version, kind: 'target-position', paramsSchemaRef: 'strategy.params',
          ...(s.nameZh ? { nameZh: s.nameZh } : {}), desc: s.desc, tags: s.tags, 'x-file': s.file ?? null,
          ...(sha256 ? { sha256 } : {}),
        }
        // 机器人模板：带参数声明，标记必填安全上限
        if (s.id.startsWith('bot-')) {
          entry.params = s.params.map(p => {
            const base: Record<string, unknown> = { key: p.key, label: p.label, type: p.type, default: p.default }
            if (p.min !== undefined) base.min = p.min
            if (p.max !== undefined) base.max = p.max
            if (p.help) base.help = p.help
            // 标记必填安全上限
            const safetyKeys = ['maxExposureNotional', 'maxAdds', 'maxTotalNotional', 'maxOrders']
            if (safetyKeys.includes(p.key)) base.required = true
            return base
          })
        }
        return entry
      }),
    }
  }

  /** 策略文件夹里每个文件的校验结果（给 Agent 看：错在哪、怎么改）。 */
  private strategyFiles(): unknown {
    return { dir: this.strategyFolder?.dir ?? null, files: this.strategyFolder?.reports() ?? [], loaded: this.strategies.ids() }
  }

  private strategyParams(p: Record<string, unknown>): unknown {
    const def = typeof p.strategyId === 'string' ? this.strategies.get(p.strategyId) : undefined
    if (!def) invalid(`unknown strategyId (loaded: ${this.strategies.ids().join(', ') || 'none'})`)
    return { schema: instanceParamsSchema(def!.params, def!.id), defaults: defaultsOf(def!.params) }
  }

  private async strategyStart(p: Record<string, unknown>): Promise<unknown> {
    if (typeof p.strategyId !== 'string') invalid('strategyId is required')
    const rec = await this.instances.start(p as never, this.accountBound)
    return { instanceId: rec.instanceId, status: rec.status }
  }

  private strategyStop(p: Record<string, unknown>): unknown {
    if (p.flatten === true) invalid('flatten is not supported: strategy.stop never closes positions')
    return { status: this.instances.stop(String(p.instanceId)).status }
  }

  private strategyUpdate(p: Record<string, unknown>): unknown {
    if (!isObj(p.params)) invalid('params must be an object')
    const rec = this.instances.update(String(p.instanceId), p.params as Record<string, number | boolean | string>)
    return { status: rec.status, appliedAt: this.now() }
  }

  private strategyStatus(p: Record<string, unknown>): unknown {
    if (p.instanceId !== undefined) {
      const rec = this.instances.get(String(p.instanceId))
      if (!rec) invalid('unknown instanceId')
      return { instances: [this.instances.view(rec!)] }
    }
    return { instances: this.instances.all().map((i) => this.instances.view(i)) }
  }

  // ---- 工作流（x-gitrader.workflow）-------------------------------------------------------

  private workflowNodes(): unknown {
    return {
      groups: NODE_GROUPS, nodes: nodeCatalog(),
      portTypes: { series: 'per-bar numeric series', number: 'scalar (broadcastable to series)', bool: 'per-bar boolean', signal: 'target position signal in -1..1', order: 'order intent', any: 'log nodes only' },
      paramRef: 'a node param value of "$name" refers to the workflow-level params entry of that name',
    }
  }

  private workflowValidate(p: Record<string, unknown>): unknown {
    const v = validateWorkflow(p.workflow)
    return { valid: v.ok, backtestable: v.backtestable, errors: v.errors, warnings: v.warnings, backtestBlockers: v.backtestBlockers, primarySignal: v.primarySignal, order: v.order }
  }

  private async workflowRun(p: Record<string, unknown>): Promise<unknown> {
    const rec = await this.instances.workflows.start(p as never, this.accountBound)
    return { instanceId: rec.instanceId, status: rec.status }
  }

  private workflowValues(p: Record<string, unknown>): unknown {
    const rec = this.instances.get(String(p.instanceId))
    if (!rec || rec.kind !== 'workflow' || !rec.workflow) invalid('unknown workflow instanceId')
    const w = rec!.workflow!
    return { instanceId: rec!.instanceId, workflowId: w.wf.id, barIndex: w.lastIdx, values: w.lastValues, errors: w.lastEvalErrors }
  }

  // ---- 来自宿主的通知 ---------------------------------------------------------------------

  private onNotify(conn: Conn, method: string, params: unknown): void {
    if (!conn.authed) return
    if (method === 'gep.heartbeat') {
      conn.lastHeartbeat = this.now()
      this.markHostBack()
      return
    }
    if (method === 'events.ack' || method === 'host.events.ack') {
      if (isObj(params) && typeof params.upToSeq === 'number') conn.session?.ack(params.upToSeq)
      return
    }
    if (method === 'events.push' && isObj(params) && Array.isArray(params.events)) this.onHostEvents(conn, params.events as GepEvent[])
  }

  private onHostEvents(conn: Conn, events: GepEvent[]): void {
    let maxSeq = this.lastHostSeq
    for (const ev of events) {
      if (!isObj(ev) || typeof ev.eventId !== 'string' || typeof ev.stream !== 'string') continue
      if (typeof ev.seq === 'number') maxSeq = Math.max(maxSeq, ev.seq)
      // 去重：同一 eventId 只处理一次（重放同一批事件不得产生重复副作用，T09）
      if (this.seenHostEvents.has(ev.eventId)) continue
      this.seenHostEvents.add(ev.eventId)
      if (this.seenHostEvents.size > 200_000) this.seenHostEvents.delete(this.seenHostEvents.values().next().value as string)
      this.dispatchHostEvent(ev)
    }
    this.lastHostSeq = maxSeq
    this.hostAckPending += events.length
    if (this.hostAckPending >= 1000) this.flushHostAck(conn)
    else if (!this.hostAckTimer) {
      this.hostAckTimer = setTimeout(() => { this.hostAckTimer = null; this.flushHostAck(conn) }, 500)
      this.hostAckTimer.unref?.()
    }
  }

  private flushHostAck(conn: Conn): void {
    this.hostAckPending = 0
    if (this.hostAckTimer) { clearTimeout(this.hostAckTimer); this.hostAckTimer = null }
    if (this.lastHostSeq > 0) conn.peer.notify('host.events.ack', { upToSeq: this.lastHostSeq })
  }

  private dispatchHostEvent(ev: GepEvent): void {
    switch (ev.stream) {
      case 'market': this.instances.onMarketEvent(ev.instrumentId, ev.data ?? {}); break
      case 'order': {
        const o = ev.data?.order
        if (isObj(o) && typeof o.orderId === 'string') {
          const closed = ['filled', 'cancelled', 'expired', 'rejected', 'denied'].includes(String(o.status))
          if (closed) this.hostOrders.delete(o.orderId); else this.hostOrders.set(o.orderId, o)
        }
        break
      }
      default: break // fill / position / funding / account / takeover / policy：引擎每次评估都向宿主取最新快照，不自己维护一份
    }
  }
}

