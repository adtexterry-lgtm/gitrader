// SPDX-License-Identifier: Apache-2.0
// 最小假引擎（内存实现），让一致性套件自己能跑通，并能注入故障验证套件抓得到坏引擎。
// 它是"模式 A + 使用宿主行情"的最小实现：一个示例策略（echo-trend）、确定性回测、断线续传、接管、秘密字段拒收。
// 真引擎（engine-core 等）不依赖它，只通过 GEP_ENDPOINT / GEP_LAUNCH 被套件调用。
import { createHash, randomUUID } from 'node:crypto'
import {
  GEP_LIMITS, PROBLEM_CODES, canonicalize, findSecretFields, majorMinor, negotiateVersion, rpcError, validateBacktestSpec, validateBinding, type BacktestResult,
  type Candle, type EngineDescribe, type GepEvent, type JsonRpcId, type Problem, type ProblemName,
} from '../src'
import { genCandles } from './host-sim'
import type { MemoryEndpoint } from './transport'

export interface FakeFaults {
  /** 把令牌值写进 log 事件（泄漏）。 */
  leakSecret?: boolean
  /** 不拒收秘密字段。 */
  noSecretCheck?: boolean
  /** 接受错误令牌。 */
  acceptBadToken?: boolean
  /** 收到 halt 后照常开仓。 */
  ignoreHalt?: boolean
  /** 没收到 resume 就自己恢复。 */
  selfResume?: boolean
  /** 下单不带 instanceId / strategyId。 */
  missingInstanceId?: boolean
  /** 下单数量用 number。 */
  decimalAsNumber?: boolean
  /** 被 2001 拒绝后把单拆小继续下。 */
  resplitAfterDeny?: boolean
  /** 3006 后不查状态直接重发。 */
  blindRetry3006?: boolean
  /** describe 里声明未知能力位。 */
  unknownCapability?: boolean
  /** 对未声明的能力也照常响应（不返回 5002）。 */
  noCapabilityHonesty?: boolean
  /** 同一事件重放会重复下单。 */
  noDedupe?: boolean
  /** 回测结果每次不同。 */
  nondeterministicBacktest?: boolean
  /** 心跳丢失后继续下单。 */
  ignoreHeartbeatLoss?: boolean
  /** 引擎不主动发 gep.heartbeat（T27）。 */
  noEngineHeartbeat?: boolean
}

export interface FakeEngineOptions {
  token?: string
  /** 宿主心跳丢失判定（默认 15000；自测里缩短）。 */
  heartbeatTimeoutMs?: number
  /** 保留窗事件数（默认 20000）。 */
  retention?: number
  faults?: FakeFaults
  onExit?: () => void
}

const KNOWN_UNDECLARED = new Set([
  'replay.start', 'replay.stop', 'replay.status', 'order.place', 'order.amend', 'order.cancel', 'order.cancelAll', 'account.snapshot',
  'market.subscribe', 'market.snapshot', 'market.history',
])
const FAKE_ID = 'fake-engine'
const md5hex = (s: string): string => createHash('md5').update(s).digest('hex')
const round = (x: number): number => Math.round(x * 1e8) / 1e8

interface Instance { instanceId: string; strategyId: string; status: 'running' | 'stopped'; accountId: string; instruments: string[]; interval?: string; params: Record<string, unknown>; mandateId: string; startedAt: number; lastClose?: number; pauseUntil: number; seen: Set<number> }
interface Job { jobId: string; state: 'queued' | 'running' | 'done' | 'failed' | 'cancelled'; progress: number; result?: BacktestResult; timer?: ReturnType<typeof setInterval> }

class Conn {
  authed = false
  lastHb = Date.now()
  hbTimer: ReturnType<typeof setInterval> | undefined
  pendingHost = new Map<JsonRpcId, (v: { ok: boolean; result?: any; error?: any }) => void>()
  constructor(readonly ep: MemoryEndpoint) {}
  send(obj: unknown): void { this.ep.send(JSON.stringify(obj)) }
}

export class FakeEngine {
  private conn: Conn | undefined
  private sessionId = ''
  private seq = 0
  private buffer: GepEvent[] = []
  private unacked = 0
  private conflatedPending = 0
  private queue: GepEvent[] = []
  private flushing = false
  private seenEvents = new Set<string>()
  private instances = new Map<string, Instance>()
  private jobs = new Map<string, Job>()
  private halt: { takeoverId: string; level: string } | undefined
  private maxOrderNotional: number | null = null
  private hostId = 1
  private n = 0
  private sessionCounter = 0

  constructor(private readonly opts: FakeEngineOptions = {}) {}

  private get token(): string { return this.opts.token ?? 'conformance-token' }
  private get faults() { return this.opts.faults ?? {} }
  private get retention(): number { return this.opts.retention ?? 20_000 }

  /** 接入一条新连接（内存端点）。引擎状态跨连接保留，以便测试断线续传。 */
  accept(ep: MemoryEndpoint): void {
    const conn = new Conn(ep)
    ep.onMessage((text) => { void this.onText(conn, text) })
    ep.onClose(() => { if (conn.hbTimer) clearInterval(conn.hbTimer); if (this.conn === conn) this.conn = undefined })
    // 引擎的心跳（每秒一次）
    if (!this.faults.noEngineHeartbeat) {
      conn.hbTimer = setInterval(() => { if (conn.authed) conn.send({ jsonrpc: '2.0', method: 'gep.heartbeat', params: { ts: Date.now() } }) }, 1000)
      conn.hbTimer.unref?.()
    }
  }

  private restricted(): boolean {
    const hbLost = !this.faults.ignoreHeartbeatLoss && this.conn !== undefined && Date.now() - this.conn.lastHb > (this.opts.heartbeatTimeoutMs ?? GEP_LIMITS.heartbeatTimeoutMs)
    const haltActive = this.halt !== undefined && !this.faults.ignoreHalt
    return hbLost || haltActive || this.conn === undefined
  }

  // ---- 入口 ---------------------------------------------------------------------------
  private async onText(conn: Conn, text: string): Promise<void> {
    let msg: any
    try { msg = JSON.parse(text) } catch { conn.send(rpcError(null, 'PARSE_ERROR', 'parse error')); return }
    if (Array.isArray(msg)) {
      const out: unknown[] = []
      for (const m of msg) { const r = await this.dispatch(conn, m); if (r) out.push(r) }
      if (out.length > 0) conn.send(out)
      return
    }
    // 宿主对引擎 host.* 请求的响应
    if (msg && typeof msg === 'object' && 'id' in msg && !('method' in msg) && conn.pendingHost.has(msg.id)) {
      const cb = conn.pendingHost.get(msg.id)!
      conn.pendingHost.delete(msg.id)
      cb('error' in msg ? { ok: false, error: msg.error } : { ok: true, result: msg.result })
      return
    }
    const r = await this.dispatch(conn, msg)
    if (r) conn.send(r)
  }

  private async dispatch(conn: Conn, m: any): Promise<unknown | null> {
    if (!m || typeof m !== 'object' || m.jsonrpc !== '2.0' || typeof m.method !== 'string') return rpcError(m?.id ?? null, 'INVALID_REQUEST', 'invalid request')
    const isNotification = !('id' in m)
    if (isNotification) { this.onNotification(conn, m); return null }
    const id: JsonRpcId = m.id
    try {
      if (m.method === 'gep.hello') return this.hello(conn, id, m.params)
      if (!conn.authed) return rpcError(id, 'AUTH_FAILED', 'hello required')
      if (!this.faults.noSecretCheck) {
        const hits = findSecretFields(m.params)
        if (hits.length > 0) return rpcError(id, 'SECRET_FIELD_REJECTED', `secret-like field rejected: ${hits.join(', ')}`)
      }
      const res = await this.method(conn, id, m.method, m.params ?? {})
      if (res && typeof res === 'object' && '__error' in (res as object)) return (res as { __error: unknown }).__error
      return { jsonrpc: '2.0', id, result: res }
    } catch (e) {
      return rpcError(id, 'INTERNAL', e instanceof Error ? e.message : 'internal error')
    }
  }

  private err(id: JsonRpcId, name: ProblemName, message: string, extra: Partial<Problem> = {}): { __error: unknown } { return { __error: rpcError(id, name, message, extra) } }

  private onNotification(conn: Conn, m: any): void {
    if (m.method === 'gep.heartbeat') conn.lastHb = Date.now()
    else if (m.method === 'host.events.ack' || m.method === 'events.ack') this.unacked = Math.max(0, this.seq - (m.params?.upToSeq ?? 0))
    else if (m.method === 'events.push') {
      for (const ev of (m.params?.events ?? []) as GepEvent[]) this.onHostEvent(ev)
    }
  }

  // ---- hello / 会话 -------------------------------------------------------------------------
  private hello(conn: Conn, id: JsonRpcId, p: any): unknown {
    if (!(p?.auth?.token === this.token || this.faults.acceptBadToken)) {
      conn.send(rpcError(id, 'AUTH_FAILED', 'authentication failed'))
      setTimeout(() => conn.ep.close(), 50)
      return null
    }
    const version = negotiateVersion(Array.isArray(p?.versions) ? p.versions : [])
    if (!version) return rpcError(id, 'VERSION_UNSUPPORTED', `no common version in ${JSON.stringify(p?.versions)}; supported: 0.1`)
    conn.authed = true
    conn.lastHb = Date.now()
    this.conn = conn
    let resumed = false
    let fromSeq: number | undefined
    if (p.resume) {
      const { sessionId, lastSeq } = p.resume as { sessionId: string; lastSeq: number }
      const firstRetained = this.buffer[0]?.seq ?? this.seq + 1
      if (sessionId !== this.sessionId || lastSeq + 1 < firstRetained) return rpcError(id, 'SESSION_GAP', `cannot resume from seq ${lastSeq}`)
      resumed = true
      fromSeq = lastSeq + 1
      const replay = this.buffer.filter((e) => e.seq > lastSeq)
      setImmediate(() => { if (replay.length > 0) conn.send({ jsonrpc: '2.0', method: 'events.push', params: { sessionId: this.sessionId, events: replay } }) })
    } else {
      this.sessionCounter += 1
      this.sessionId = `ses_01JABFAKE${String(this.sessionCounter).padStart(4, '0')}`
      this.seq = 0
      this.buffer = []
      this.unacked = 0
      this.instances.clear()
      this.seenEvents.clear()
      this.halt = undefined
      this.maxOrderNotional = null
    }
    return { jsonrpc: '2.0', id, result: { version, sessionId: this.sessionId, resumed, ...(fromSeq !== undefined ? { fromSeq } : {}), engine: { id: FAKE_ID, version: '0.1.0' } } }
  }

  // ---- 引擎 → 宿主 -----------------------------------------------------------------------------
  private callHost(method: string, params: unknown, timeoutMs = 5000): Promise<{ ok: boolean; result?: any; error?: any }> {
    const conn = this.conn
    if (!conn) return Promise.resolve({ ok: false, error: { code: -1, message: 'no host connection' } })
    const id = `e${this.hostId++}`
    return new Promise((resolve) => {
      const t = setTimeout(() => { conn.pendingHost.delete(id); resolve({ ok: false, error: { code: -2, message: 'host timeout' } }) }, timeoutMs)
      conn.pendingHost.set(id, (v) => { clearTimeout(t); resolve(v) })
      conn.send({ jsonrpc: '2.0', id, method, params })
    })
  }

  private emit(stream: GepEvent['stream'], type: string, data: Record<string, unknown>, extra: Partial<GepEvent> = {}): void {
    const conflatable = stream === 'health' || stream === 'account' || stream === 'backtest' || stream === 'market'
    if (conflatable && this.unacked > GEP_LIMITS.backpressureUnackedEvents) { this.conflatedPending += 1; return }
    this.seq += 1
    const ev: GepEvent = { seq: this.seq, eventId: `evt_F${this.seq}`, stream, type, ts: Date.now(), data, ...extra }
    if (conflatable && this.conflatedPending > 0) { ev.conflated = this.conflatedPending; this.conflatedPending = 0 }
    this.buffer.push(ev)
    if (this.buffer.length > this.retention) this.buffer.shift()
    this.unacked += 1
    this.queue.push(ev)
    if (!this.flushing) { this.flushing = true; setImmediate(() => this.flush()) }
  }

  private flush(): void {
    this.flushing = false
    const conn = this.conn
    const events = this.queue.splice(0)
    if (!conn || events.length === 0) return
    for (let i = 0; i < events.length; i += 500) conn.send({ jsonrpc: '2.0', method: 'events.push', params: { sessionId: this.sessionId, events: events.slice(i, i + 500) } })
  }

  // ---- 宿主事件 → 策略 ----------------------------------------------------------------------------
  private onHostEvent(ev: GepEvent): void {
    if (!this.faults.noDedupe) {
      if (this.seenEvents.has(ev.eventId)) return
      this.seenEvents.add(ev.eventId)
    }
    if (ev.type !== 'market.candle') return
    const d = ev.data as { interval: string; candle: Candle; closed?: boolean }
    const instrumentId = ev.instrumentId
    if (!instrumentId) return
    for (const inst of this.instances.values()) if (inst.status === 'running' && inst.instruments.includes(instrumentId)) void this.onCandle(inst, instrumentId, d.candle)
  }

  private async onCandle(inst: Instance, instrumentId: string, c: Candle): Promise<void> {
    const prev = inst.lastClose
    inst.lastClose = c.c
    this.n += 1
    if (this.n % 10 === 0) this.emit('health', 'health.tick', { instances: this.instances.size })
    if (this.faults.leakSecret) this.emit('log', 'log.line', { level: 'info', msg: `auth token was ${this.token}` })
    if (prev === undefined || c.c === prev) return
    const dir = c.c > prev ? 1 : -1
    this.emit('signal', 'signal.emitted', { instrumentId, kind: 'target', target: dir, candleT: c.t }, { instrumentId })
    if (this.restricted()) return
    if (Date.now() < inst.pauseUntil) return
    if (!this.faults.noDedupe && inst.seen.has(c.t)) return
    inst.seen.add(c.t)
    let size = Number(inst.params['size'] ?? 0.001)
    if (this.maxOrderNotional !== null && size * c.c > this.maxOrderNotional) size = Math.floor((this.maxOrderNotional / c.c) * 1000) / 1000
    if (size < 0.001) return
    await this.place(inst, instrumentId, dir > 0 ? 'buy' : 'sell', size, c.t)
  }

  private async place(inst: Instance, instrumentId: string, side: 'buy' | 'sell', size: number, candleT: number, attempt = 0): Promise<void> {
    const clientOrderId = md5hex(`${inst.instanceId}:${candleT}:${attempt}`)
    const sizeStr = size.toFixed(3).replace(/\.?0+$/, '') || '0'
    const intent = {
      accountId: inst.accountId, instrumentId, side, type: 'market', size: this.faults.decimalAsNumber ? size : sizeStr, maxSlippageBps: 50,
      reason: 'echo-trend: follows the last candle direction',
    }
    const params: Record<string, unknown> = { accountId: inst.accountId, intent, clientOrderId, ...(this.faults.missingInstanceId ? {} : { strategyId: inst.strategyId, instanceId: inst.instanceId }) }
    const out = await this.callHost('host.order.place', params)
    if (!out.ok) return
    const r = out.result as { status?: string; problem?: Problem }
    const code = r.problem?.code
    if (code === PROBLEM_CODES.RULE_DENIED.code) {
      inst.pauseUntil = Date.now() + 5000
      if (this.faults.resplitAfterDeny && attempt < 3) await this.place(inst, instrumentId, side, Math.max(0.001, size / 2), candleT, attempt + 1)
    } else if (code === PROBLEM_CODES.VENUE_OUTCOME_UNKNOWN.code) {
      if (this.faults.blindRetry3006) await this.place(inst, instrumentId, side, size, candleT, attempt + 1)
      else await this.callHost('host.order.status', { clientOrderId })
    }
    // 1002 PRECISION 等：不原样重发
  }

  // ---- 方法 ----------------------------------------------------------------------------------------
  private async method(conn: Conn, id: JsonRpcId, method: string, p: any): Promise<unknown> {
    switch (method) {
      case 'engine.describe': return this.describe()
      case 'engine.bind': {
        const v = validateBinding(p)
        if (!v.ok) return this.err(id, 'INVALID_PARAMS', `invalid binding: ${v.issues.map((i) => `${i.path} ${i.message}`).join('; ')}`)
        const hostInfo = await this.callHost('host.describe', {})
        const known = new Set<string>((hostInfo.result?.accounts ?? []).map((a: { accountId: string }) => a.accountId))
        for (const a of p.accounts) {
          if (!known.has(a.accountId)) return this.err(id, 'ACCOUNT_NOT_BOUND', `account ${a.accountId} is not known to the host`)
          if (a.mode === 'B') return this.err(id, 'CAPABILITY_UNSUPPORTED', 'execution.modeB is not declared')
        }
        return { bindingId: p.bindingId, effective: p, warnings: [] }
      }
      case 'engine.health': return { status: 'ok', metrics: { instances: this.instances.size, bufferedEvents: this.buffer.length }, ts: Date.now() }
      case 'engine.snapshot': return { seq: this.seq, strategies: [...this.instances.values()].map((i) => this.view(i)), orders: [] }
      case 'engine.halt': {
        if (!this.faults.ignoreHalt) this.halt = { takeoverId: p.takeoverId, level: p.level }
        return { ack: true, appliedAt: Date.now() }
      }
      case 'engine.resume': {
        if (!this.halt || this.halt.takeoverId !== p.takeoverId) return this.err(id, 'INVALID_PARAMS', 'unknown takeoverId')
        this.halt = undefined
        return { resumedAt: Date.now() }
      }
      case 'engine.shutdown': {
        const grace = Math.min(Number(p.graceMs ?? 0), 200)
        setTimeout(() => { conn.ep.close(); this.opts.onExit?.() }, grace)
        return { ok: true }
      }
      case 'events.subscribe': return { subscriptionId: 'sub_fake', fromSeq: this.seq + 1 }
      case 'events.unsubscribe': return { ok: true }
      case 'risk.policy.push': {
        const pol = (p.policies ?? [])[0]
        const cap = pol?.limits?.maxOrderNotional
        this.maxOrderNotional = cap !== undefined ? Number(cap) : null
        return { acceptedVersions: (p.policies ?? []).map((x: { version: number }) => x.version) }
      }
      case 'strategy.list': return { strategies: [{ id: 'echo-trend', name: 'Echo trend (conformance fake)', version: '0.1.0', kind: 'target-position', paramsSchemaRef: 'strategy.params' }] }
      case 'strategy.params': {
        if (p.strategyId !== 'echo-trend') return this.err(id, 'INVALID_PARAMS', 'unknown strategy')
        return { schema: { type: 'object', properties: { size: { type: 'string', pattern: '^[0-9.]+$' } }, additionalProperties: true }, defaults: { size: '0.001' } }
      }
      case 'strategy.start': {
        if (p.strategyId !== 'echo-trend') return this.err(id, 'INVALID_PARAMS', 'unknown strategy')
        const instanceId = p.instanceId ?? `inst_F${this.instances.size + 1}`
        const inst: Instance = { instanceId, strategyId: p.strategyId, status: 'running', accountId: p.accountId, instruments: p.instruments, interval: p.interval, params: { size: '0.001', ...(p.params ?? {}) }, mandateId: p.mandateId, startedAt: Date.now(), pauseUntil: 0, seen: new Set() }
        this.instances.set(instanceId, inst)
        this.emit('strategy', 'strategy.started', { instanceId })
        return { instanceId, status: 'running' }
      }
      case 'strategy.stop': {
        const i = this.instances.get(p.instanceId)
        if (!i) return this.err(id, 'INVALID_PARAMS', 'unknown instance')
        i.status = 'stopped'
        this.emit('strategy', 'strategy.stopped', { instanceId: i.instanceId })
        return { status: 'stopped' }
      }
      case 'strategy.update': {
        const i = this.instances.get(p.instanceId)
        if (!i) return this.err(id, 'INVALID_PARAMS', 'unknown instance')
        i.params = { ...i.params, ...(p.params ?? {}) }
        return { status: i.status, appliedAt: Date.now() }
      }
      case 'strategy.status': return { instances: [...this.instances.values()].filter((i) => !p.instanceId || i.instanceId === p.instanceId).map((i) => this.view(i)) }
      case 'backtest.run': {
        const v = validateBacktestSpec(p.spec)
        if (!v.ok) return this.err(id, 'INVALID_PARAMS', `invalid spec: ${v.issues.map((i) => `${i.path} ${i.message}`).join('; ')}`)
        return { jobId: this.startJob(p.spec) }
      }
      case 'backtest.status': {
        const j = this.jobs.get(p.jobId)
        return j ? { state: j.state, progress: j.progress } : this.err(id, 'INVALID_PARAMS', 'unknown job')
      }
      case 'backtest.result': {
        const j = this.jobs.get(p.jobId)
        if (!j) return this.err(id, 'INVALID_PARAMS', 'unknown job')
        if (j.state !== 'done' || !j.result) return this.err(id, 'BUSY', `job is ${j.state}`)
        return j.result
      }
      case 'backtest.cancel': {
        const j = this.jobs.get(p.jobId)
        if (!j) return this.err(id, 'INVALID_PARAMS', 'unknown job')
        if (j.state === 'queued' || j.state === 'running') { j.state = 'cancelled'; if (j.timer) clearInterval(j.timer) }
        return { state: j.state }
      }
      default:
        if (KNOWN_UNDECLARED.has(method) && !this.faults.noCapabilityHonesty) return this.err(id, 'CAPABILITY_UNSUPPORTED', `${method} is not declared in engine.describe`)
        if (KNOWN_UNDECLARED.has(method)) return {}
        return this.err(id, 'METHOD_NOT_FOUND', `method not found: ${method}`)
    }
  }

  private view(i: Instance) {
    return { instanceId: i.instanceId, strategyId: i.strategyId, status: i.status, accountId: i.accountId, instruments: i.instruments, ...(i.interval ? { interval: i.interval } : {}), params: i.params, mandateId: i.mandateId, startedAt: i.startedAt }
  }

  private describe(): EngineDescribe {
    const caps: Record<string, unknown> = {
      'execution.modeA': true, 'execution.modeB': false, 'market.useHost': true, 'market.own': false, strategy: true, 'strategy.hotUpdate': true,
      backtest: true, 'backtest.fillModels': ['next-bar-open'], replay: false, 'events.resume': true,
      'events.retention': { minEvents: GEP_LIMITS.retentionMinEvents, minMs: GEP_LIMITS.retentionMinMs }, 'risk.cooperative': true,
      'halt.levels': ['halt_new', 'cancel_all', 'flatten_all'], 'builder.attach': false, 'decision.log': false,
    }
    if (this.faults.unknownCapability) caps['mystery.feature'] = true
    return {
      engine: { id: FAKE_ID, name: 'Conformance fake engine', version: '0.1.0', vendor: { id: 'gitrader', name: 'Gitrader', kind: 'builtin', verified: true }, license: 'Apache-2.0', runtime: 'node' },
      protocol: { version: majorMinor('0.1.0') ?? '0.1', transports: ['stdio', 'ws'] },
      capabilities: caps as EngineDescribe['capabilities'],
      venues: [],
      data: { intervals: ['1m', '5m'], maxHistoryBars: 5000 },
      strategies: [{ id: 'echo-trend', name: 'Echo trend (conformance fake)', version: '0.1.0', kind: 'target-position', paramsSchemaRef: 'strategy.params' }],
      limits: { maxConcurrentBacktests: 2, maxStrategyInstances: 20 },
      assumptions: { backtest: { fill: 'next-bar-open', slippageBps: 2, fees: 'venue-taker', funding: false, liquidation: false, maxBars: 5000 } },
    }
  }

  // ---- 回测 -----------------------------------------------------------------------------------------
  private startJob(spec: any): string {
    this.n += 1
    const jobId = `job_F${canonicalize(spec).length}${md5hex(canonicalize(spec)).slice(0, 8)}${this.faults.nondeterministicBacktest ? randomUUID().slice(0, 4) : ''}${this.jobs.size}`
    const job: Job = { jobId, state: 'queued', progress: 0 }
    this.jobs.set(jobId, job)
    let step = 0
    job.timer = setInterval(() => {
      if (job.state === 'cancelled') { clearInterval(job.timer); return }
      step += 1
      job.state = 'running'
      job.progress = Math.min(1, step / 10)
      if (step >= 10) {
        clearInterval(job.timer)
        job.result = this.runBacktest(spec, jobId)
        job.state = 'done'
        job.progress = 1
      }
    }, 40)
    job.timer.unref?.()
    return jobId
  }

  private runBacktest(spec: any, jobId: string): BacktestResult {
    const bars = Math.max(10, Math.min(5000, Math.floor((spec.to - spec.from) / 60_000)))
    const candles = genCandles(spec.seed, bars, 60_000, spec.from)
    const rnd = (x: number): number => round(x)
    let equity = Number(spec.account.initialBalance)
    let pos = 0
    let entry = 0
    const trades: BacktestResult['trades'] = []
    const eq: { t: number; v: number }[] = []
    let peak = equity
    let maxDd = 0
    for (let i = 1; i < candles.length; i++) {
      const prev = candles[i - 1]!
      const cur = candles[i]!
      const want = prev.c > (candles[i - 2]?.c ?? prev.c) ? 1 : -1
      if (want !== pos) {
        const fill = cur.o
        if (pos !== 0) { const pnl = (fill - entry) * pos * 0.01; equity += pnl; trades.push({ t: cur.t, side: pos > 0 ? 'sell' : 'buy', price: rnd(fill), size: 0.01, pnl: rnd(pnl), fee: rnd(fill * 0.01 * 0.00045), reason: 'flip' }) }
        pos = want
        entry = fill
      }
      eq.push({ t: cur.t, v: rnd(equity) })
      peak = Math.max(peak, equity)
      maxDd = Math.max(maxDd, (peak - equity) / peak)
    }
    const start = Number(spec.account.initialBalance)
    return {
      jobId, specDigest: `sha256:${createHash('sha256').update(canonicalize(spec)).digest('hex')}`, assumptions: spec.assumptions,
      stats: { totalReturnRatio: rnd(equity / start - 1), annualizedRatio: 0, maxDrawdownRatio: rnd(maxDd), sharpe: 0, winRatio: this.faults.nondeterministicBacktest ? round(Math.random()) : 0.5, profitFactor: null, trades: trades.length, fills: trades.length, avgHoldBars: 1, spanDays: rnd(bars / 1440), finalEquity: rnd(equity) },
      equity: eq, trades, openPosition: null, artifacts: [], warnings: ['funding and liquidation are not simulated'], engine: { id: FAKE_ID, version: '0.1.0' },
      dataDigest: `sha256:${createHash('sha256').update(JSON.stringify(candles)).digest('hex')}`,
    }
  }
}
