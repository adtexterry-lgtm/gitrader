// SPDX-License-Identifier: CPAL-1.0
// GEP 宿主（模式 A，契约 §2）：内核扮演宿主，引擎（任意语言的子进程 / 本地 ws / 远程 wss）扮演引擎。
//
// 内核 → 引擎：gep.hello / engine.describe / engine.bind / events.subscribe / risk.policy.push / engine.halt / engine.resume / strategy.* / backtest.* …，
//              通知 events.push（行情、订单、成交）、gep.heartbeat、host.events.ack。
// 引擎 → 内核：host.describe / host.instruments / host.market.{subscribe,unsubscribe,snapshot,history,fundingHistory} / host.account.snapshot / host.order.{place,amend,cancel,cancelAll,batch,status}
//              / host.proposal.create / host.risk.precheck / host.events.subscribe / host.ledger.append / host.artifact.put，通知 events.push、gep.heartbeat、host.events.ack。
//
// 铁律（契约 §1.6、§2.7）：引擎的订单与提案**不信任引擎自报的来源**——actor / actorType / via / requestId 一律由这里盖章（engine:<id> / engine / gep），
// 只采信引擎给的 tool 与 causation（全链追溯）；订单照常过授权书 + 风控闸 + 速率预算再到场所（纸面 → 模拟场所）；引擎拿不到任何密钥，协议里也没有传密钥的字段（S1：含密钥类字段名的请求一律 5006）。
// 失联：引擎 15 s 没有心跳 → 对其模式 A 账户执行 halt_new（REDUCING），恢复只有人（PIN）。
import { CANDLE_INTERVALS, EVENTS_ACK_METHOD, GEP_LIMITS, findSecretFields, makeProblem } from './proto'
import type {
  AccountId, Binding, Candle, CandleInterval, EngineDescribe, GepEvent, GepStream, HaltParams, HostOrderPlaceParams, HostProposalCreateParams, HostProposalCreateResult, Instrument,
  HostMethods, MarketHistoryResult, Order, OrderIntent, OrderResult, Problem, TradingScope,
} from './proto'
import { assertProof } from './auth'
import type { HumanProof } from './auth'
import type { AgentService } from './agents'
import type { AccountRegistry } from './accounts'
import type { ConnectorBus } from './connector'
import type { Docs } from './db'
import type { EngineHandle, EngineNeedsRestartView, EngineSupervisor } from './engines'
import type { EventBus } from './events'
import { fundingHistoryFor } from './funding'
import type { FileCandleStore } from './market-store'
import { localFirstHistory } from './market-history'
import type { Ledger } from './ledger'
import type { OrderStore } from './orders'
import type { RiskService } from './risk'
import type { TakeoverService } from './takeover'
import type { ActorCtx, TradingService } from './trading'
import { ORG_SCOPE, scopeKey } from './trading-state'
import type { TradingStateService } from './trading-state'
import type { Clock } from './util/clock'
import { KernelError, toProblem } from './util/errors'
import { newId, newRequestId, ulid } from './util/ids'
import { mkOrigin, systemOrigin } from './util/origin'
import { StrategyInstances, findPositionOwner, currentCtx, type RunningInst } from './strategy-instances'
import { restoreInstances } from './instance-restore'
import type { RestoreOptions } from './instance-restore'

const GEP_VERSION = '0.1'

export interface GepHostDeps {
  clock: Clock
  docs: Docs
  ledger: Ledger
  events: EventBus
  accounts: AccountRegistry
  bus: ConnectorBus
  trading: TradingService
  agents: AgentService
  risk: RiskService
  tstate: TradingStateService
  takeover: TakeoverService
  orders: OrderStore
  engines: EngineSupervisor
  hostVersion: string
  store?: FileCandleStore
  artifactPut?: (engineId: string, input: HostMethods['host.artifact.put']['params']) => HostMethods['host.artifact.put']['result']
  /** 该场所的主标的目录是否已就绪（恢复策略实例前判断「标的已知」）。没提供 = 只看 instrument() 查得到查不到。 */
  venuePrimaryReady?: (venue: string) => boolean
}
export interface GepHostOptions {
  /** 向引擎发心跳的间隔（契约：≤ 5 s）。 */
  heartbeatMs?: number
  /** 多久没收到引擎心跳判失联（契约：15 s = 3 个周期）。 */
  heartbeatTimeoutMs?: number
  /** 握手各步的超时。 */
  callTimeoutMs?: number
  /** engine.describe 握手超时；描述元数据可比其它握手步骤更慢。 */
  describeTimeoutMs?: number
  /** engine.halt 的 ack 等待。 */
  haltAckTimeoutMs?: number
  /** 握手后策略实例恢复：可重试失败的退避与期限（默认 2 s → 30 s、10 分钟）。 */
  restore?: Omit<RestoreOptions, 'signal'>
}

export interface EngineBinding {
  accounts: { accountId: AccountId; mandateId: string }[]
  instruments: string[]
  /** 只用于人面这一轮：允许去掉现有实盘账户绑定；不落库。 */
  replaceLive?: boolean
}

// ---- 最小 JSON-RPC 对等端（宿主一侧）--------------------------------------------------------------
type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
class Rpc {
  private nextId = 1
  private pending = new Map<number | string, { resolve(v: unknown): void; reject(e: unknown): void; timer: ReturnType<typeof setTimeout>; method: string }>()
  closed = false
  constructor(
    private send: (text: string) => boolean,
    private onRequest: (method: string, params: unknown) => Promise<unknown>,
    private onNote: (method: string, params: unknown) => void,
  ) {}

  call<T = unknown>(method: string, params: unknown, timeoutMs = 10_000): Promise<T> {
    if (this.closed) return Promise.reject(new KernelError(makeProblem('VENUE_UNAVAILABLE', `engine connection closed (${method})`)))
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new KernelError(makeProblem('BUSY', `engine did not answer ${method} within ${timeoutMs} ms`, { retryable: true }))) }, timeoutMs)
      timer.unref?.()
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer, method })
      if (!this.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))) { clearTimeout(timer); this.pending.delete(id); reject(new KernelError(makeProblem('VENUE_UNAVAILABLE', `could not write ${method} to the engine`))) }
    })
  }
  /** 写出去了才返回 true（halt 的 sent 统计用）。 */
  notify(method: string, params?: unknown): boolean {
    if (this.closed) return false
    return this.send(JSON.stringify({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) }))
  }
  close(): void {
    this.closed = true
    for (const [id, p] of this.pending) { clearTimeout(p.timer); p.reject(new KernelError(makeProblem('VENUE_UNAVAILABLE', `engine connection closed during ${p.method}`))); this.pending.delete(id) }
  }

  async receive(text: string): Promise<void> {
    let msg: Json | Json[]
    try { msg = JSON.parse(text) } catch { return }
    for (const m of Array.isArray(msg) ? msg : [msg]) await this.one(m)
  }
  private async one(m: Json): Promise<void> {
    if (!m || m.jsonrpc !== '2.0') return
    if (typeof m.method !== 'string') {
      const p = this.pending.get(m.id)
      if (!p) return
      clearTimeout(p.timer)
      this.pending.delete(m.id)
      if (m.error) p.reject(new KernelError((m.error.data as Problem | undefined) ?? makeProblem('INTERNAL', String(m.error.message ?? 'engine error'))))
      else p.resolve(m.result)
      return
    }
    if (!('id' in m)) { try { this.onNote(m.method, m.params) } catch { /* 通知处理异常不影响连接 */ } return }
    // S1：含密钥类字段名的请求一律 5006，不回显值
    const hits = findSecretFields(m.params)
    if (hits.length) { this.send(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: 5006, message: `secret-like field rejected: ${hits.join(', ')}`, data: makeProblem('SECRET_FIELD_REJECTED', `secret-like field rejected: ${hits.join(', ')}`) } })); return }
    try {
      const result = await this.onRequest(m.method, m.params)
      this.send(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: result ?? null }))
    } catch (e) {
      const p = toProblem(e)
      this.send(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: p.code, message: p.message, data: p } }))
    }
  }
}

interface MarketSub { instrumentId: string; interval: string }
interface Conn {
  engineId: string
  rpc: Rpc
  state: 'handshaking' | 'ready' | 'failed'
  detail?: string
  sessionId: string
  describe?: EngineDescribe
  seq: number
  engineSeq: number
  lastBeat: number
  /** 最近一次收到引擎心跳的内核时钟毫秒；从没收到就不带。 */
  lastHeartbeatAt?: number
  lost: boolean
  beatTimer?: ReturnType<typeof setInterval>
  marketSubs: Map<string, MarketSub>
  unwatch: (() => void)[]
  evStreams: Set<string>
  haltIds: Map<string, string[]>
  placeCalls: number
  proposalCalls: number
  unsubLine: () => void
  /** 握手后恢复实例的重试在等；连接断开时中止。 */
  restoreAbort: AbortController
  /** 已因心跳丢失 2 个周期下令杀掉本地引擎（只下一次）。 */
  killed?: boolean
}

export class GepHost {
  private conns = new Map<string, Conn>()
  private lastCandle = new Map<string, Candle>()
  private o: Required<GepHostOptions>
  /** 引擎调用统计（测试 / 状态条）：下单次数、提案次数。 */
  readonly stats = { orderPlace: 0, proposalCreate: 0, marketHistory: 0, pushed: {} as Record<string, number>, engineAckedUpTo: 0, engineEventsSeen: 0 }
  private paperReplayHandler?: (engineId: string, method: string, params: Json) => Promise<unknown>
  readonly instances: StrategyInstances

  constructor(private x: GepHostDeps, opts: GepHostOptions = {}) {
    this.o = { heartbeatMs: GEP_LIMITS.heartbeatIntervalMs, heartbeatTimeoutMs: GEP_LIMITS.heartbeatTimeoutMs, callTimeoutMs: 5000, describeTimeoutMs: 30_000, haltAckTimeoutMs: 1500, restore: {}, ...opts }
    this.instances = new StrategyInstances(x.docs, x.clock)
    x.engines.setGepStatusProvider(() => this.status())
    x.engines.onConnected((id, h, token) => this.attach(id, h, token))
    x.engines.onDisconnected((id) => this.detach(id))
    // 内核事件 → 引擎（订单 / 成交 / 持仓 / 策略版本变化）
    x.events.subscribe('account.orders', (e) => this.fanout('order', e.data as Order))
    x.events.subscribe('account.fills', (e) => this.fanout('fill', e.data as Json))
    x.events.subscribe('account.positions', (e) => this.fanout('position', e.data as Json))
    x.events.subscribe('risk.state', (e) => { if ((e.data as Json).kind === 'policy') void this.pushPolicyAll() })
    // 行情：连接器总线上的 K 线 → 引擎（按订阅过滤；收盘由"出现新的一根"推断）
    x.bus.onEvent((_venue, e) => { if (e.type === 'candle') this.onBusCandle(e.instrumentId, e.interval, e.candle) })
  }

  setPaperReplayHandler(handler: (engineId: string, method: string, params: Json) => Promise<unknown>): void {
    this.paperReplayHandler = handler
  }

  callPaperReplay(engineId: string, method: string, params: Json = {}): Promise<unknown> {
    return this.dispatchPaperReplay(engineId, method, params)
  }

  // ================================================================
  // 连接生命周期
  // ================================================================
  private attach(engineId: string, h: EngineHandle, token: string): void {
    this.detach(engineId)
    const conn: Conn = {
      engineId, state: 'handshaking', sessionId: '', seq: 0, engineSeq: 0, lastBeat: Date.now(), lost: false, marketSubs: new Map(), unwatch: [], evStreams: new Set(),
      haltIds: new Map(), placeCalls: 0, proposalCalls: 0, unsubLine: () => undefined, restoreAbort: new AbortController(),
      rpc: new Rpc((t) => h.send(t), (m, p) => this.hostMethod(conn, m, p), (m, p) => this.onNote(conn, m, p)),
    }
    conn.unsubLine = h.kind === 'stdio' ? h.onLine((l) => { void conn.rpc.receive(l) }) : h.onMessage((t) => { void conn.rpc.receive(t) })
    this.conns.set(engineId, conn)
    void this.handshake(conn, token)
  }

  private detach(engineId: string): void {
    const c = this.conns.get(engineId)
    if (!c) return
    clearInterval(c.beatTimer)
    c.restoreAbort.abort()
    c.unsubLine()
    for (const u of c.unwatch) { try { u() } catch { /* 已断 */ } }
    c.rpc.close()
    this.conns.delete(engineId)
  }

  private async handshake(conn: Conn, token: string): Promise<void> {
    try {
      const hello = (await conn.rpc.call<{ version: string; sessionId: string }>('gep.hello', {
        protocol: 'gep', versions: [GEP_VERSION], host: { name: 'gitrader-kernel', version: this.x.hostVersion }, auth: { token },
      }, this.o.callTimeoutMs))
      conn.sessionId = hello.sessionId
      conn.describe = await conn.rpc.call<EngineDescribe>('engine.describe', {}, this.o.describeTimeoutMs)
      conn.state = 'ready'
      this.x.engines.markLocalReady(conn.engineId)
      conn.lastBeat = Date.now()
      this.beat(conn)
      conn.beatTimer = setInterval(() => this.beat(conn), this.o.heartbeatMs)
      conn.beatTimer.unref?.()
      // 引擎 → 内核的事件流（策略状态、信号、决策、健康）；订单 / 成交走 host.events.subscribe 反方向
      await conn.rpc.call('events.subscribe', { streams: ['strategy', 'signal', 'decision', 'health'] satisfies GepStream[] }, this.o.callTimeoutMs)
      const saved = this.x.docs.get<EngineBinding>('enginebind', conn.engineId)
      if (saved) await this.applyBinding(conn, saved)
      // GQ-22：握手后恢复策略实例（纸面自动，实盘需人批）
      // R2-REL-01：标的没到齐的实例按退避等（不阻塞握手，也不计入崩溃保护）
      void restoreInstances(this, conn, conn.engineId, { ...this.o.restore, signal: conn.restoreAbort.signal }).catch(() => { /* 恢复失败不影响引擎连接 */ })
      this.x.events.publish('engine.health', { id: conn.engineId, gep: 'ready', engine: conn.describe.engine })
    } catch (e) {
      conn.state = 'failed'
      conn.detail = e instanceof KernelError ? e.problem.message : String(e)
      this.x.engines.markLocalFailed(conn.engineId, conn.detail)
      this.x.events.publish('engine.health', { id: conn.engineId, gep: 'failed', detail: conn.detail })
    }
  }

  private beat(conn: Conn): void { conn.rpc.notify('gep.heartbeat', { ts: Date.now() }) }

  // ================================================================
  // 绑定（人面 + PIN）
  // ================================================================
  /**
   * 把引擎绑到若干账户（模式 A）。每个账户必须有一份覆盖它的、主体是该引擎的授权书（人用 PIN 签发）。
   * 绑定落库，引擎重连后自动重新绑定；绑定本身不给引擎任何权限——权限永远是授权书 + 风控闸。
   */
  async bind(engineId: string, b: EngineBinding, proof: HumanProof, origin = mkOrigin('user:usr_local', 'ui:engine.bind', 'ui')): Promise<{ bindingId: string; warnings: string[] }> {
    assertProof(proof, 'pin')
    if (!this.x.engines.has(engineId)) throw new KernelError(makeProblem('INVALID_PARAMS', `unknown engine ${engineId} (configured: ${this.x.engines.ids().join(', ') || 'none'})`))
    if (!b.accounts?.length) throw new KernelError(makeProblem('INVALID_PARAMS', 'binding needs at least one account'))
    const kept = new Set(b.accounts.map((a) => a.accountId))
    const saved = this.x.docs.get<EngineBinding>('enginebind', engineId)
    for (const a of saved?.accounts ?? []) {
      if (kept.has(a.accountId)) continue
      const account = this.x.accounts.find(a.accountId)
      if (account?.mode !== 'live') continue
      if (b.replaceLive !== true) {
        throw new KernelError(makeProblem('INVALID_PARAMS', `this binding would remove the live account ${account.alias} from engine ${engineId}; include it again or pass replaceLive:true`))
      }
    }
    for (const a of b.accounts) {
      this.x.accounts.get(a.accountId)
      const m = this.x.agents.getMandate(a.mandateId)
      if (!m || m.subject.type !== 'engine' || m.subject.id !== engineId) throw new KernelError(makeProblem('MANDATE_LIMIT', `mandate ${a.mandateId} is not issued to engine ${engineId}`))
      if (!m.accounts.includes(a.accountId as never)) throw new KernelError(makeProblem('MANDATE_LIMIT', `mandate ${a.mandateId} does not cover ${a.accountId}`))
    }
    const persisted: EngineBinding = { accounts: b.accounts, instruments: b.instruments }
    this.x.docs.put('enginebind', engineId, persisted)
    this.x.ledger.append({ type: 'engine.bound', origin, subject: { engineId }, payload: { accounts: b.accounts, instruments: b.instruments } })
    const conn = this.conns.get(engineId)
    if (!conn || conn.state !== 'ready') return { bindingId: '', warnings: ['engine is not connected; the binding is saved and applies when it connects'] }
    return this.applyBinding(conn, persisted)
  }

  private async applyBinding(conn: Conn, b: EngineBinding): Promise<{ bindingId: string; warnings: string[] }> {
    const pol = this.x.risk.current()
    const binding: Binding = {
      bindingId: newId('bind'),
      accounts: b.accounts.map((a) => ({ accountId: a.accountId, mode: 'A' as const, mandateId: a.mandateId as never })),
      data: { source: 'host', instruments: b.instruments },
      policies: pol ? [{ policyId: pol.policyId, version: pol.version, digest: pol.attestation.digest }] : [],
      heartbeatMs: this.o.heartbeatMs,
    }
    const r = await conn.rpc.call<{ bindingId: string; warnings: string[] }>('engine.bind', binding, this.o.callTimeoutMs)
    this.bound.set(conn.engineId, b)
    await this.pushPolicy(conn)
    return { bindingId: r.bindingId, warnings: r.warnings ?? [] }
  }
  private lastTickAt = 0
  private bound = new Map<string, EngineBinding>()
  bindingOf(engineId: string): EngineBinding | undefined { return this.bound.get(engineId) }

  // GQ-22：适配器方法供 instance-restore 使用
  now(): number { return this.x.clock.now() }
  /** 账户已被删时返回 undefined（accounts.get 会抛，不能用）。 */
  getAccount(accountId: string): { mode: 'paper' | 'live' | 'shadow' } | undefined {
    const acc = this.x.accounts.find(accountId)
    return acc ? { mode: acc.mode } : undefined
  }
  /** 恢复前问：这个标的现在认得吗（instrument() 查得到，或该场所主标的目录已就绪）。 */
  instrumentKnown(instrumentId: string): boolean {
    if (this.x.bus.instrument(instrumentId as never)) return true
    return this.x.venuePrimaryReady?.(instrumentId.slice(0, Math.max(0, instrumentId.indexOf(':')))) === true
  }
  getTradingState(accountId: string): { state: string } {
    return this.x.tstate.effective([ORG_SCOPE, { type: 'account', id: accountId }])
  }
  /** 恢复成功入账：engine.event / strategy.restore（握手之后写，不在内核启动期）。 */
  recordRestore(engineId: string, e: { instanceId: string; strategyId: string; accountId: string }): void {
    const acct = this.x.accounts.get(e.accountId)
    this.x.ledger.append({ type: 'engine.event', origin: systemOrigin('engine:restore', 'engines'), subject: { engineId, accountId: acct.accountId }, payload: { action: 'strategy.restore', ...e } })
  }
  /** 重启后没能恢复、等人处理的实例（进 kernel.status().warnings）。 */
  restartWarnings(): string[] {
    return this.instances.needsRestart().map((r) =>
      `strategy instance ${r.instanceId} (${r.strategyId} @ ${this.x.accounts.find(r.accountId)?.alias ?? r.accountId}) was not restored after restart: ${r.needsRestart?.reason ?? 'unknown'}; restart or stop it. 策略实例 ${r.instanceId}（${r.strategyId} @ ${this.x.accounts.find(r.accountId)?.alias ?? r.accountId}）重启后没有恢复；请重新启动或停止它`)
  }

  /** 向引擎推当前生效的风控策略（引擎只能据此收紧自己）。 */
  private async pushPolicy(conn: Conn): Promise<void> {
    const pol = this.x.risk.current()
    if (!pol) return
    const eff = { ...pol, limits: this.x.risk.effectiveLimits() }
    try { await conn.rpc.call('risk.policy.push', { policies: [eff], effectiveAt: this.x.clock.now() }, this.o.callTimeoutMs) } catch { /* 引擎不接受不影响内核强制 */ }
    this.pushEvent(conn, 'policy', 'policy.updated', { policyId: pol.policyId, version: pol.version })
  }
  private async pushPolicyAll(): Promise<void> { for (const c of this.conns.values()) if (c.state === 'ready' && this.bound.has(c.engineId)) await this.pushPolicy(c) }

  // ================================================================
  // 接管：engine.halt / engine.resume
  // ================================================================
  private scopeFor(conn: Conn, scope: TradingScope): HaltParams['scope'] | null {
    const b = this.bound.get(conn.engineId)
    const mine = (b?.accounts ?? []).map((a) => a.accountId)
    switch (scope.type) {
      case 'org': case 'group': return mine.length ? { accountIds: mine } : {}
      case 'account': return mine.includes(scope.id as never) ? { accountIds: [scope.id as never] } : null
      case 'mandate': { const m = this.x.agents.getMandate(scope.id); const hit = mine.filter((a) => m?.accounts.includes(a as never)); return hit.length ? { accountIds: hit } : null }
      case 'instrument': return b?.instruments.includes(scope.id) ? { instrumentIds: [scope.id] } : null
      default: return null
    }
  }

  /**
   * 粘性状态变严时通知引擎（契约 §5.6）：REDUCING → halt_new；HALTED → cancel_all（引擎什么单都不再发，撤单 / 平仓由内核做）。
   * 向所有已连引擎广播（未绑定的也发 org 级）；ack 在 deadlineMs 内；发出的与确认的都入账。
   */
  async halt(scope: TradingScope, state: 'REDUCING' | 'HALTED', reason: string): Promise<{ sent: string[]; acked: string[]; failed: string[] }> {
    const out = { sent: [] as string[], acked: [] as string[], failed: [] as string[] }
    const level: HaltParams['level'] = state === 'HALTED' ? 'cancel_all' : 'halt_new'
    const waits: Promise<void>[] = []
    for (const c of this.conns.values()) {
      const sc = this.scopeFor(c, scope)
      if (sc === null) continue
      const takeoverId = newId('tko') as HaltParams['takeoverId']
      const key = scopeKey(scope)
      c.haltIds.set(key, [...(c.haltIds.get(key) ?? []), takeoverId])
      const p = c.rpc.call('engine.halt', { takeoverId, level, scope: sc, reason, deadlineMs: GEP_LIMITS.haltAckMs } satisfies HaltParams, this.o.haltAckTimeoutMs)
      out.sent.push(c.engineId) // 已写入传输（写不出去 call 会立刻 reject，下面算 failed）
      waits.push(p.then(() => { out.acked.push(c.engineId); this.pushEvent(c, 'takeover', 'takeover.halt', { takeoverId, level, scope: sc, reason }) }, () => {
        out.sent.splice(out.sent.indexOf(c.engineId), 1)
        out.failed.push(c.engineId)
      }))
    }
    // 先留痕“发出去了”，再等 ack（ack 在 deadlineMs 内；没回的标引擎 unhealthy 并告警）
    await new Promise<void>((r) => setImmediate(r)) // 让同步写失败的 call 先落到 failed
    const record = (extra: Record<string, unknown>): void => {
      try { this.x.ledger.append({ type: 'engine.event', origin: systemOrigin('halt:broadcast', 'engines'), subject: { orgId: 'org_local' }, payload: { halt: true, level, scope, reason, ...extra }, attestation: 'kernel-observed' }) } catch (e) { console.error("HALT-LEDGER", String(e)) }
    }
    if (out.sent.length || out.failed.length) record({ sent: [...out.sent], failed: [...out.failed] })
    this.x.events.publish('engine.health', { halt: true, scope, reason, sent: [...out.sent], failed: [...out.failed] })
    await Promise.all(waits)
    const unacked = out.sent.filter((id) => !out.acked.includes(id))
    if (out.sent.length) {
      record({ haltAck: true, acked: out.acked, unacked })
      for (const id of unacked) this.x.events.publish('engine.health', { id, status: 'unhealthy', detail: 'no engine.halt ack' })
    }
    return out
  }

  /** 人面恢复 ACTIVE 后，按 takeoverId 通知引擎解除（引擎不得自行恢复）。 */
  async resume(scope: TradingScope, approvedBy = 'user:usr_local'): Promise<string[]> {
    const done: string[] = []
    const key = scopeKey(scope)
    for (const c of this.conns.values()) {
      const ids = c.haltIds.get(key)
      if (!ids?.length) continue
      c.haltIds.delete(key)
      const sc = this.scopeFor(c, scope) ?? {}
      for (const takeoverId of ids) {
        try { await c.rpc.call('engine.resume', { takeoverId, scope: sc, approvedBy }, this.o.callTimeoutMs); done.push(c.engineId) } catch { /* 引擎没回就没回，状态以内核为准 */ }
      }
    }
    return done
  }

  // ================================================================
  // 心跳与失联
  // ================================================================
  /** 内核定时器每秒调：引擎 15 s 没有心跳 → 对其模式 A 账户 halt_new。 */
  async tick(): Promise<void> {
    const now = Date.now()
    // 内核自己的事件循环被卡住（两次 tick 隔了一个超时周期以上）时，「没收到心跳」可能只是还没轮到处理：这一轮不下杀手
    const starved = this.lastTickAt !== 0 && now - this.lastTickAt > this.o.heartbeatTimeoutMs
    this.lastTickAt = now
    for (const c of this.conns.values()) {
      if (c.state !== 'ready') continue
      const b = this.bound.get(c.engineId)
      if (now - c.lastBeat > this.o.heartbeatTimeoutMs) {
        if (!c.lost) {
          c.lost = true
          this.x.events.publish('engine.health', { id: c.engineId, status: 'down', detail: 'engine heartbeat lost' })
          try { this.x.ledger.append({ type: 'engine.health_changed', origin: systemOrigin('engine:heartbeat', 'engines'), subject: { engineId: c.engineId }, payload: { to: 'lost', timeoutMs: this.o.heartbeatTimeoutMs } }) } catch { /* ignore */ }
          // R2-REL-06：监管侧状态不再报 ready（进程还在，心跳停了）
          this.x.engines.markHeartbeatLost(c.engineId, `engine heartbeat lost (no heartbeat for ${this.o.heartbeatTimeoutMs} ms)`)
          for (const a of b?.accounts ?? []) {
            await this.x.takeover.execute({ level: 'halt_new', scope: { type: 'account', id: a.accountId }, reason: `engine ${c.engineId} heartbeat lost` }, { principal: { kind: 'service' }, origin: systemOrigin('engine:heartbeat', 'engines') }).catch(() => undefined)
          }
        }
        // R2-REL-06：连续 2 个超时周期还没有心跳 = 挂死。halt_new 已经先于此做了；这里只杀本地引擎进程树，重启走监管的现有崩溃退避，
        // 重启后的交易状态仍是 REDUCING（恢复交易只有人）。远程 / 内嵌引擎没有可杀的句柄，killHung 返回 false。
        if (!starved && !c.killed && now - c.lastBeat > 2 * this.o.heartbeatTimeoutMs) {
          c.killed = true
          this.x.engines.killHung(c.engineId)
        }
      } else if (c.lost) { c.lost = false; this.x.engines.markHeartbeatRecovered(c.engineId) } // 心跳恢复：不自动解除接管（恢复只有人）
    }
  }

  // ================================================================
  // 引擎 → 内核：通知
  // ================================================================
  private onNote(conn: Conn, method: string, params: unknown): void {
    const p = (params ?? {}) as Json
    if (method === 'gep.heartbeat') {
      conn.lastBeat = Date.now()
      conn.lastHeartbeatAt = this.x.clock.now()
      for (const a of this.bound.get(conn.engineId)?.accounts ?? []) this.x.agents.heartbeat(a.mandateId)
    } else if (method === EVENTS_ACK_METHOD || method === 'events.ack') {
      // 引擎确认了宿主事件：无损流在这里可以释放缓冲（内核不保留历史，续传靠 engine.snapshot）
      this.stats.engineAckedUpTo = Math.max(this.stats.engineAckedUpTo, Number(p.upToSeq ?? 0))
    } else if (method === 'gep.overflow') {
      // 引擎侧无损流溢出：宿主必须随后 engine.snapshot 对账
      void conn.rpc.call('engine.snapshot', {}, this.o.callTimeoutMs).catch(() => undefined)
      this.x.events.publish('engine.health', { id: conn.engineId, status: 'degraded', detail: 'gep.overflow' })
    } else if (method === 'events.push') {
      const evs = (p.events ?? []) as GepEvent[]
      let max = conn.engineSeq
      for (const e of evs) { max = Math.max(max, e.seq); this.stats.engineEventsSeen++; this.onEngineEvent(conn, e) }
      conn.engineSeq = max
      if (evs.length) conn.rpc.notify(EVENTS_ACK_METHOD, { upToSeq: max })
    }
  }

  private onEngineEvent(conn: Conn, e: GepEvent): void {
    switch (e.stream) {
      case 'strategy': this.x.events.publish('strategy.status', { engineId: conn.engineId, ...e }); break
      case 'health': this.x.events.publish('engine.health', { id: conn.engineId, ...e.data }); break
      case 'signal': case 'decision': {
        try {
          const dec = e.stream === 'decision'
          this.x.ledger.append({
            type: dec ? 'decision.made' : 'signal.emitted', origin: mkOrigin(`engine:${conn.engineId}`, e.origin?.tool ?? `engine:${e.stream}`, 'gep', e.origin?.causation ? { causation: e.origin.causation } : {}),
            subject: { engineId: conn.engineId, ...(e.instrumentId ? { instrumentId: e.instrumentId } : {}) }, payload: e.data, attestation: 'engine-reported',
            engineRef: { engineId: conn.engineId, sessionId: conn.sessionId, seq: e.seq, eventId: e.eventId },
          })
        } catch { /* 引擎事件写账本失败不影响连接 */ }
        break
      }
    }
  }

  // ================================================================
  // 内核 → 引擎：事件推送
  // ================================================================
  private pushEvent(conn: Conn, stream: GepStream, type: string, data: Record<string, unknown>, extra: Partial<GepEvent> = {}): void {
    if (conn.state !== 'ready') return
    this.stats.pushed[stream] = (this.stats.pushed[stream] ?? 0) + 1
    const ev: GepEvent = { seq: ++conn.seq, eventId: `evt_${ulid()}`, stream, type, ts: this.x.clock.now(), data, ...extra }
    conn.rpc.notify('events.push', { sessionId: conn.sessionId, events: [ev] })
  }

  private wants(conn: Conn, stream: string, accountId?: string): boolean {
    if (conn.state !== 'ready' || !conn.evStreams.has(stream)) return false
    const b = this.bound.get(conn.engineId)
    return !accountId || !!b?.accounts.some((a) => a.accountId === accountId)
  }

  private fanout(stream: 'order' | 'fill' | 'position', data: Json): void {
    const accountId = data.accountId as string | undefined
    for (const c of this.conns.values()) {
      if (!this.wants(c, stream, accountId)) continue
      if (stream === 'order') {
        const o = data as unknown as Order
        const type = ({ new: 'order.created', denied: 'order.denied', submitted: 'order.submitted', open: 'order.accepted', rejected: 'order.rejected', untriggered: 'order.untriggered', partially_filled: 'order.filled', filled: 'order.filled', cancelled: 'order.cancelled', expired: 'order.expired' } as Record<string, string>)[o.status] ?? 'order.accepted'
        this.pushEvent(c, 'order', type, o as unknown as Record<string, unknown>, { accountId: o.accountId, instrumentId: o.instrumentId, origin: o.origin })
      } else if (stream === 'fill') {
        this.pushEvent(c, 'fill', 'fill', data, { accountId: accountId as never, instrumentId: data.instrumentId as string })
      } else {
        const pos = data.position as Json | null
        this.pushEvent(c, 'position', pos ? 'position.changed' : 'position.closed', data, { accountId: accountId as never, instrumentId: data.instrumentId as string })
      }
    }
  }

  // ---- 行情 ----
  /** 总线上来的 K 线：没有“收盘”标记，出现新的一根就说明上一根已收盘。 */
  private onBusCandle(instrumentId: string, interval: string, candle: Candle): void {
    const key = `${instrumentId}|${interval}`
    const prev = this.lastCandle.get(key)
    this.lastCandle.set(key, candle)
    if (prev && candle.t > prev.t) this.feedCandle(instrumentId, interval, prev, { closed: true })
    this.feedCandle(instrumentId, interval, candle, { closed: false })
  }

  /** 把一根 K 线喂给订阅了它的引擎（总线事件与夹具共用）。closed = true 才会触发策略评估。 */
  feedCandle(instrumentId: string, interval: string, candle: Candle, o: { closed?: boolean } = {}): number {
    let n = 0
    for (const c of this.conns.values()) {
      if (c.state !== 'ready' || !c.marketSubs.has(`${instrumentId}|${interval}`)) continue
      this.pushEvent(c, 'market', 'market.candle', { interval, candle, ...(o.closed ? { closed: true } : {}) }, { instrumentId })
      n++
    }
    return n
  }

  // ================================================================
  // 引擎 → 内核：host.* 方法面
  // ================================================================
  private bindingFor(conn: Conn, accountId: string): { accountId: AccountId; mandateId: string } {
    const a = this.bound.get(conn.engineId)?.accounts.find((x) => x.accountId === accountId)
    if (!a) throw new KernelError(makeProblem('ACCOUNT_NOT_BOUND', `engine ${conn.engineId} is not bound to ${accountId}`))
    return a
  }

  /** 引擎的调用上下文：actor / actorType / via / requestId 由这里盖章，只采信引擎给的 tool 与 causation。 */
  private ctxFor(conn: Conn, accountId: string, hint?: { tool?: string; causation?: Json }, strategyId?: string, instanceId?: string): ActorCtx {
    const b = this.bindingFor(conn, accountId)
    const tool = typeof hint?.tool === 'string' && hint.tool ? hint.tool.slice(0, 120) : strategyId ? `strategy:${strategyId}` : `engine:${conn.engineId}`
    const causation = { ...(hint?.causation && typeof hint.causation === 'object' ? (hint.causation as Json) : {}), ...(instanceId ? { instanceId } : {}), engineId: conn.engineId, mandateId: b.mandateId }
    return { principal: { kind: 'engine', engineId: conn.engineId, mandateId: b.mandateId }, origin: mkOrigin(`engine:${conn.engineId}`, tool, 'gep', { requestId: newRequestId(), causation: causation as never }) }
  }

  private toOrderResult(o: Order): OrderResult {
    return { orderId: o.orderId, clientOrderId: o.clientOrderId, status: o.status, order: o, ...(o.problem ? { problem: o.problem } : {}) }
  }
  private deniedResult(clientOrderId: string, problem: Problem): OrderResult {
    return { orderId: newId('ord'), clientOrderId, status: 'denied', problem }
  }

  /** host.order.place：经授权书 + 风控闸 → 场所（纸面 → 模拟场所）；被拒不是 JSON-RPC 错误，返回 denied + problem；授权书额度不足 → 自动转提案（2009 + 票号）。 */
  private async orderPlace(conn: Conn, p: HostOrderPlaceParams): Promise<OrderResult> {
    this.stats.orderPlace++
    conn.placeCalls++
    const intent: OrderIntent = { ...p.intent, accountId: p.accountId, clientOrderId: p.clientOrderId }
    const ctx = this.ctxFor(conn, p.accountId, p.origin, p.strategyId, p.instanceId)
    try {
      const r = await this.x.trading.place({ intent }, ctx)
      if (r.order) return this.toOrderResult(r.order)
      return this.deniedResult(p.clientOrderId, r.problem ?? makeProblem('NEEDS_APPROVAL', `needs human approval: ticket ${r.proposal?.ticket ?? '?'}`))
    } catch (e) {
      if (e instanceof KernelError && e.problem.category !== 'PROTOCOL') return this.deniedResult(p.clientOrderId, e.problem)
      throw e
    }
  }

  private async proposalCreate(conn: Conn, p: HostProposalCreateParams): Promise<HostProposalCreateResult> {
    this.stats.proposalCreate++
    conn.proposalCalls++
    const ctx = this.ctxFor(conn, p.accountId, p.origin, p.strategyId, p.instanceId)
    const pr = await this.x.trading.propose({ accountId: p.accountId, intents: p.intents, reason: p.reason, ...(p.evidence ? { evidence: p.evidence } : {}), forcePending: true }, ctx)
    const denied = pr.status === 'denied'
    const first = pr.precheck.ruleHits.find((h) => h.action === 'deny')
    return {
      proposalId: pr.proposalId, ticket: pr.ticket, status: denied ? 'denied' : 'pending', precheck: pr.precheck, expiresAt: pr.expiresAt,
      ...(denied ? { problem: makeProblem('RULE_DENIED', first?.message ?? (pr.precheck.ruleHits.map((h) => `${h.code}`).join(', ') || 'denied'), { ruleHits: pr.precheck.ruleHits, precheckId: pr.precheck.precheckId }) } : {}),
    }
  }

  private findOrder(p: { orderId?: string; clientOrderId?: string }): Order {
    const o = (p.orderId ? this.x.orders.get(p.orderId) : undefined) ?? (p.clientOrderId ? this.x.orders.byClientOrderId(p.clientOrderId) : undefined)
    if (!o) throw new KernelError(makeProblem('INSTRUMENT_UNKNOWN', 'order not found'))
    return o
  }

  private async hostMethod(conn: Conn, method: string, params: unknown): Promise<unknown> {
    const p = (params ?? {}) as Json
    switch (method) {
      case 'host.describe': return {
        host: { name: 'gitrader-kernel', version: this.x.hostVersion },
        venues: this.x.bus.list().map((c) => c.describe()),
        accounts: this.x.accounts.list().map((a) => ({ accountId: a.accountId, alias: a.alias, venue: a.venue, environment: a.environment, mode: a.mode })),
      }
      case 'host.instruments': {
        const ids = p.ids as string[] | undefined
        const all: Instrument[] = this.x.bus.instruments().filter((i) => (!ids || ids.includes(i.instrumentId)) && (!p.venue || i.venue === p.venue))
        return { instruments: all }
      }
      case 'host.market.subscribe': {
        const subId = `msub_${ulid()}`
        for (const ch of (p.channels ?? []) as { type: string; instrumentId: string; interval?: string }[]) {
          if (ch.type !== 'candles') continue // 引擎目前只吃 K 线
          const interval = ch.interval ?? '1m'
          conn.marketSubs.set(`${ch.instrumentId}|${interval}`, { instrumentId: ch.instrumentId, interval })
          const un = this.x.bus.watchMarket(ch.instrumentId, 'candles', interval as never)
          if (un) conn.unwatch.push(un)
        }
        return { subscriptionId: subId }
      }
      case 'host.market.unsubscribe': return { ok: true }
      case 'host.market.snapshot': {
        const id = String(p.instrumentId)
        const src = this.x.bus.marketSource(id.slice(0, id.indexOf(':')))
        if (!src) throw new KernelError(makeProblem('DATA_UNAVAILABLE', 'no market source'))
        if (p.type === 'book') return src.book(id, p.depth)
        if (p.type === 'context') return src.context(id)
        const q = src.quote(id)
        if (!q) throw new KernelError(makeProblem('DATA_UNAVAILABLE', `no quote for ${id}`))
        return q
      }
      case 'host.market.history': {
        this.stats.marketHistory++
        const id = String(p.instrumentId)
        const src = this.x.bus.marketSource(id.slice(0, id.indexOf(':')))
        if (!src) throw new KernelError(makeProblem('DATA_UNAVAILABLE', `no market source for ${id}`))
        const interval = String(p.interval)
        if (!(CANDLE_INTERVALS as readonly string[]).includes(interval)) throw new KernelError(makeProblem('INVALID_PARAMS', `unknown interval ${interval}`))
        const rawLimit = p.limit ?? 500
        if (!Number.isInteger(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > GEP_LIMITS.maxHistoryLimit) throw new KernelError(makeProblem('INVALID_PARAMS', `limit must be an integer in 1..${GEP_LIMITS.maxHistoryLimit}`))
        const n = Number(rawLimit)
        const range = { ...(p.from !== undefined ? { from: Number(p.from) } : {}), ...(p.to !== undefined ? { to: Number(p.to) } : {}) }
        const store = this.x.store
        // R1-PERF-01：带 from 的区间请求本地优先、只补缺口（库里齐了就不碰场所）；帮不上（区间里还没有已收盘格点）才走下面原来的先打场所路径
        if (store && range.from !== undefined) {
          const local = await localFirstHistory({ store, src, now: this.x.clock.now() }, id, interval as CandleInterval, n, range.from, range.to)
          if (local) return local
        }
        let candles: Candle[] = []
        let source = src.venue
        let venueError: unknown = null
        try { candles = await src.candles(id, interval as CandleInterval, { n, ...range }) } catch (e) { venueError = e }
        if (store) {
          if (!venueError && candles.length) {
            // 只录已收盘的：没给 to 或 to ≥ now 时末根可能仍在形成；没给 from 的轮询按「已录最大 t」去重，免得每次轮询把整批重复追加。
            const now = this.x.clock.now()
            const closed = range.to === undefined || range.to >= now ? candles.slice(0, -1) : candles
            if (closed.length) void (range.from === undefined ? store.recordNew(id, interval, closed) : store.record(id, interval, closed)).catch(() => {})
          }
          if (venueError || candles.length < n) {
            const local = await store.read(id, interval, { ...range, n }).catch(() => [] as Candle[])
            if (local.length) {
              const byT = new Map<number, Candle>()
              for (const c of local) byT.set(c.t, c)
              for (const c of candles) byT.set(c.t, c) // 场所数据优先
              const merged = [...byT.values()].sort((a, b) => a.t - b.t).slice(-n)
              if (merged.length > candles.length) { source = venueError ? 'store' : `${src.venue}+store`; candles = merged }
            }
          }
        }
        if (venueError && !candles.length) throw venueError
        return { candles, source, complete: candles.length < n } satisfies MarketHistoryResult
      }
      // fix-r6 R3-07：资金费历史取自场所连接器的公开接口（只读、无钥匙）；拿不到就报错，回测据此降级并在 warnings 里说明
      case 'host.market.fundingHistory': return fundingHistoryFor(this.x.bus, p)
      case 'host.account.snapshot': {
        this.bindingFor(conn, String(p.accountId))
        const a = this.x.accounts.get(String(p.accountId))
        const vc = this.x.bus.routeFor(a)
        const s = await vc.accountState(this.x.bus.accountRef(a))
        return { balances: s.balances, margin: s.margin, positions: s.positions, openOrders: this.x.orders.list({ accountId: a.accountId, openOnly: true }), ts: s.ts, attestation: 'kernel-observed' }
      }
      case 'host.order.place': return this.orderPlace(conn, p as unknown as HostOrderPlaceParams)
      case 'host.order.batch': {
        const results: OrderResult[] = []
        for (const o of (p.orders ?? []) as HostOrderPlaceParams[]) results.push(await this.orderPlace(conn, o))
        return { results }
      }
      case 'host.order.cancel': {
        const o = this.findOrder(p)
        const r = await this.x.trading.cancel({ accountId: o.accountId, orderId: o.orderId }, this.ctxFor(conn, o.accountId))
        const cur = this.x.orders.get(o.orderId) ?? o
        return { orderId: cur.orderId, clientOrderId: cur.clientOrderId, status: cur.status, order: cur, ...(r.problem ? { problem: r.problem } : {}) }
      }
      case 'host.order.cancelAll': {
        this.bindingFor(conn, String(p.accountId))
        return this.x.trading.cancelAll({ accountId: p.accountId, ...(p.instrumentId ? { instrumentId: p.instrumentId } : {}), keepProtective: p.keepProtective !== false }, this.ctxFor(conn, String(p.accountId)))
      }
      case 'host.order.amend': {
        const order = this.findOrder(p)
        const result = await this.x.trading.amend(this.ctxFor(conn, order.accountId), {
          accountId: order.accountId, orderId: order.orderId,
          ...(p.price === undefined ? {} : { price: p.price }), ...(p.size === undefined ? {} : { size: p.size }), ...(p.triggerPrice === undefined ? {} : { triggerPrice: p.triggerPrice }),
        })
        return this.toOrderResult(result.order)
      }
      case 'host.order.status': return this.findOrder(p)
      case 'host.proposal.create': return this.proposalCreate(conn, p as unknown as HostProposalCreateParams)
      case 'host.risk.precheck': {
        const ctx = this.ctxFor(conn, String(p.accountId))
        return this.x.trading.precheckIntent({ ...p.intent, accountId: p.accountId }, ctx)
      }
      case 'host.events.subscribe': {
        for (const s of (p.streams ?? []) as string[]) conn.evStreams.add(s)
        return { subscriptionId: `evsub_${ulid()}` }
      }
      case 'host.ledger.append': {
        const seqs: number[] = []
        for (const en of (p.entries ?? []) as { type: string; data: Record<string, unknown> }[]) {
          const type = en.type === 'signal' ? 'signal.emitted' : en.type === 'decision' ? 'decision.made' : en.type === 'note' ? 'note' : 'engine.event'
          const e = this.x.ledger.append({
            type, origin: mkOrigin(`engine:${conn.engineId}`, `engine:ledger.${en.type}`, 'gep'), subject: { engineId: conn.engineId }, payload: en.data, attestation: 'engine-reported',
            engineRef: { engineId: conn.engineId, sessionId: conn.sessionId, seq: conn.engineSeq, eventId: `evt_${ulid()}` },
          })
          seqs.push(e.seq)
        }
        return { seqs }
      }
      case 'host.artifact.put': {
        if (!this.x.artifactPut) throw new KernelError(makeProblem('CAPABILITY_UNSUPPORTED', 'artifact storage is not available'))
        return this.x.artifactPut(conn.engineId, p as HostMethods['host.artifact.put']['params'])
      }
      case 'paper.replay.start':
      case 'paper.replay.status':
      case 'paper.replay.stop':
        return this.dispatchPaperReplay(conn.engineId, method, p)
      default: throw new KernelError(makeProblem('METHOD_NOT_FOUND', `unknown host method ${method}`))
    }
  }

  // ================================================================
  // 给人面 / Agent 面用的引擎控制
  // ================================================================
  /** 方法白名单：策略 / 回测 / 回放 / 健康 / 快照。下单永远不经这里（引擎的单只走 host.order.place）。 */
  private static readonly CALLABLE = new Set(['strategy.list', 'strategy.params', 'strategy.start', 'strategy.stop', 'strategy.update', 'strategy.status', 'backtest.run', 'backtest.status', 'backtest.result', 'backtest.cancel', 'replay.start', 'replay.stop', 'replay.status', 'paper.replay.start', 'paper.replay.stop', 'paper.replay.status', 'engine.health', 'engine.snapshot', 'engine.describe', 'x-gitrader.research.run', 'x-gitrader.research.status', 'x-gitrader.research.result', 'x-gitrader.research.cancel'])

  async callEngine(engineId: string, method: string, params: Json = {}): Promise<unknown> {
    const c = this.conns.get(engineId)
    if (!c || c.state !== 'ready') throw new KernelError(makeProblem('VENUE_UNAVAILABLE', `engine ${engineId} is not connected`))
    if (!GepHost.CALLABLE.has(method)) throw new KernelError(makeProblem('METHOD_NOT_FOUND', `engine method ${method} is not exposed`))
    if (method.startsWith('paper.replay.')) return this.dispatchPaperReplay(engineId, method, params)
    if (method === 'strategy.update') return this.callStrategyUpdate(engineId, params)
    if (method === 'strategy.stop') return this.stopInstance(c, engineId, params)
    if (method === 'strategy.start') {
      // 实盘账户上的策略只能由人面经提案升级；这里只开纸面 / 影子
      const a = this.x.accounts.get(String(params.accountId))
      if (a.mode === 'live') throw new KernelError(makeProblem('MANDATE_LEVEL', 'starting a strategy on a live account needs a human-approved proposal'))
      const b = this.bindingFor(c, a.accountId)
      params = { ...params, mandateId: params.mandateId ?? b.mandateId }
      // 净额制：跨引擎检查同账户同标的是否已被占用
      await this.assertNoPositionOwner(a.accountId, params.instruments, params.instanceId)
    }
    const r = await c.rpc.call(method, params, 15_000)
    if (method === 'strategy.start') this.instances.recordStart(engineId, params, r as { instanceId?: unknown } | undefined)
    return r
  }

  private async assertNoPositionOwner(accountId: string, instruments: unknown, selfId: unknown): Promise<void> {
    const want = Array.isArray(instruments) ? instruments.map(String) : []
    for (const c of this.conns.values()) {
      if (c.state !== 'ready') continue
      let st: { instances?: RunningInst[] }
      try { st = await c.rpc.call('strategy.status', {}, 5_000) } catch { continue }   // 该引擎答不上来：不挡（引擎自己的检查仍在）
      const hit = findPositionOwner(st.instances ?? [], accountId, want, typeof selfId === 'string' ? selfId : undefined)
      if (hit) throw new KernelError(makeProblem('INVALID_PARAMS', `${hit.strategyId} (instance ${hit.instanceId}, engine ${c.engineId}) already owns the target position of ${hit.shared} on this account; stop it first`))
    }
  }

  private async stopInstance(c: Conn, engineId: string, params: Json): Promise<unknown> {
    const instanceId = String(params.instanceId ?? '')
    const ctx = currentCtx()
    // 停之前先取实例信息（停了以后引擎里还在，但保险起见先取）
    let info: { accountId?: string; instruments?: string[] } | undefined
    try { const st = await c.rpc.call<{ instances?: Json[] }>('strategy.status', { instanceId }, 5_000); info = st.instances?.find((i) => i.instanceId === instanceId) as typeof info } catch { /* 下面 stop 会报同样的错 */ }
    let r: Json
    try { r = (await c.rpc.call('strategy.stop', params, 15_000)) as Json } catch (e) {
      // 引擎重启后丢了实例，但登记表里有「需要重新启动」的行：随这次 stop 一并清掉（WP-C 的 GQ-22 依赖这一条）
      if (this.instances.get(instanceId)?.needsRestart) { this.instances.recordStop(instanceId); return { status: 'stopped', note: 'the engine no longer ran this instance; the pending restart entry was removed' } }
      throw e
    }
    this.instances.recordStop(instanceId)
    const remain = await this.positionsLeft(info)
    if (!remain.length) return r
    const accountId = info?.accountId as string
    try { this.x.ledger.append({ type: 'annotation', origin: ctx?.origin ?? systemOrigin('engine:stop', 'engines'), subject: { orgId: 'org_local', accountId: accountId as never, engineId }, payload: { kind: 'strategy.stopped_unmanaged', instanceId, positions: remain } }) } catch { /* 入账失败不挡 stop */ }
    return { ...r, unmanagedPositions: remain,
      notice: `策略已停止，但 ${remain.map((p) => `${p.instrumentId} ${p.side} ${p.size}`).join('、')} 的持仓仍在、已无策略管理`,
      closeHint: { workbench: '工作台 → 持仓 → 平仓', agent: { tool: 'order', action: 'close', accountId, instrumentIds: remain.map((p) => p.instrumentId) } } }
  }
  
  private async positionsLeft(info?: { accountId?: string; instruments?: string[] }): Promise<{ instrumentId: string; side: string; size: string }[]> {
    try {
      if (!info?.accountId) return []
      const s = await this.x.bus.snapshot(this.x.accounts.get(info.accountId), { maxAgeMs: 3000 })
      return s.positions.filter((p) => (info.instruments ?? []).includes(p.instrumentId) && Number(p.size) > 0).map((p) => ({ instrumentId: p.instrumentId, side: String(p.side), size: String(p.size) }))
    } catch { return [] }       // 查不到持仓不影响 stop 成功
  }

  private async dispatchPaperReplay(engineId: string, method: string, params: Json): Promise<unknown> {
    if (!this.paperReplayHandler) throw new KernelError(makeProblem('CAPABILITY_UNSUPPORTED', 'paper replay is not configured'))
    const current = await this.paperReplayHandler(engineId, 'paper.replay.status', {}) as { accountId?: string; runId?: string }
    const accountId = method === 'paper.replay.start' ? String(params.accountId ?? '') : String(current.accountId ?? '')
    if (!accountId) throw new KernelError(makeProblem('INVALID_PARAMS', 'paper replay request has no bound account'))
    const conn = this.conns.get(engineId)
    if (!conn) throw new KernelError(makeProblem('VENUE_UNAVAILABLE', `engine ${engineId} is not connected`))
    this.bindingFor(conn, accountId)
    if (method !== 'paper.replay.start' && params.runId !== undefined && params.runId !== current.runId) throw new KernelError(makeProblem('INVALID_PARAMS', 'replay run does not belong to the bound engine account'))
    return this.paperReplayHandler(engineId, method, params)
  }

  /** A strategy update is authorized from the engine's live instance ownership, never request-supplied account metadata. */
  async callStrategyUpdate(engineId: string, params: Json, authorizeLive?: () => Promise<unknown>): Promise<unknown> {
    const c = this.conns.get(engineId)
    if (!c || c.state !== 'ready') throw new KernelError(makeProblem('VENUE_UNAVAILABLE', `engine ${engineId} is not connected`))
    const instanceId = typeof params?.instanceId === 'string' ? params.instanceId : ''
    if (!instanceId || instanceId.trim() !== instanceId) throw new KernelError(makeProblem('INVALID_PARAMS', 'strategy.update requires an unpadded instanceId'))

    const status: unknown = await c.rpc.call('strategy.status', { instanceId }, 15_000)
    if (!status || typeof status !== 'object' || !Array.isArray((status as { instances?: unknown }).instances)) {
      throw new KernelError(makeProblem('INVALID_PARAMS', 'strategy.status must return an instances array'))
    }
    if ((status as { ok?: unknown }).ok === false) throw new KernelError(makeProblem('INVALID_PARAMS', 'strategy.status reported failure'))
    const instances = (status as { instances: unknown[] }).instances
    const matches = instances.filter((item): item is Record<string, unknown> =>
      !!item && typeof item === 'object' && !Array.isArray(item) && (item as Record<string, unknown>).instanceId === instanceId)
    if (matches.length !== 1) throw new KernelError(makeProblem('INVALID_PARAMS', 'strategy.status must identify exactly one matching instance'))
    const accountId = matches[0]!.accountId
    if (typeof accountId !== 'string' || !accountId.trim()) throw new KernelError(makeProblem('INVALID_PARAMS', 'strategy instance has no accountId'))

    const account = this.x.accounts.get(accountId)
    this.bindingFor(c, account.accountId)
    if (account.mode === 'live') {
      if (!authorizeLive) throw new KernelError(makeProblem('ATTESTATION_REQUIRED', 'updating a live strategy requires a PIN'))
      await authorizeLive()
    }
    const r = await c.rpc.call('strategy.update', params, 15_000)
    this.instances.recordUpdate(instanceId, params.params)
    return r
  }

  status(): { engineId: string; state: string; detail?: string; sessionId: string; bound: boolean; accounts: string[]; lost: boolean; placeCalls: number; proposalCalls: number; engine?: string; bindings?: { accountId: string; mode: string; mandateId?: string }[]; lastHeartbeatAt?: number; needsRestart?: EngineNeedsRestartView[] }[] {
    return [...this.conns.values()].map((c) => {
      const needsRestart = this.instances.needsRestart(c.engineId).map((r) => ({ instanceId: r.instanceId, strategyId: r.strategyId, accountId: r.accountId, reason: r.needsRestart?.reason ?? '' }))
      const bindings = (this.bound.get(c.engineId)?.accounts ?? []).flatMap((a) => {
        const account = this.x.accounts.find(a.accountId)
        if (!account) return []
        return [{ accountId: a.accountId, mode: account.mode, mandateId: a.mandateId }]
      })
      return {
        engineId: c.engineId, state: c.state, ...(c.detail ? { detail: c.detail } : {}), sessionId: c.sessionId, bound: this.bound.has(c.engineId),
        accounts: (this.bound.get(c.engineId)?.accounts ?? []).map((a) => a.accountId), lost: c.lost, placeCalls: c.placeCalls, proposalCalls: c.proposalCalls,
        ...(c.describe ? { engine: `${c.describe.engine.id}@${c.describe.engine.version}` } : {}),
        ...(bindings.length ? { bindings } : {}),
        ...(c.lastHeartbeatAt !== undefined ? { lastHeartbeatAt: c.lastHeartbeatAt } : {}),
        ...(needsRestart.length ? { needsRestart } : {}),
      }
    })
  }
  describeOf(engineId: string): EngineDescribe | undefined { return this.conns.get(engineId)?.describe }
  isReady(engineId: string): boolean { return this.conns.get(engineId)?.state === 'ready' }
  /** 已握手的引擎 id（只读）；给了能力位就只要声明了该能力的。研究作业靠它挑引擎，再经 callEngine（白名单）发请求。 */
  readyEngineIds(capability?: string): string[] {
    return [...this.conns.values()].filter((c) => c.state === 'ready' && (!capability || (c.describe?.capabilities as Record<string, unknown> | undefined)?.[capability] === true)).map((c) => c.engineId)
  }

  close(): void { for (const id of [...this.conns.keys()]) this.detach(id) }
}

