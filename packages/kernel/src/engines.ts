// SPDX-License-Identifier: CPAL-1.0
// 引擎监管（v0.1.2：引擎不限语言、不限跑在哪）。
//   本地：{ command, args, env, cwd } 任意语言子进程，stdio NDJSON；内核拉起 / 健康检查 / 退避重启（1 s → 60 s，10 分钟内崩溃 5 次 → failed）。
//   远程：{ url, auth } 已在运行的本地 ws 或远程 wss；内核做连接 / 心跳 / 断线重连（退避）。令牌与证书只写句柄，明文由 resolveSecret 取。
// 不预设 Python；uv 只是 Python 引擎的可选助手，M1 不实现。
// 子进程不继承宿主环境变量（契约 S3）：只传显式列出的 env + GITRADER_GEP_TOKEN + 最小系统变量（PATH / SystemRoot）。
// 结束进程只按自己持有的子进程句柄（句柄未退出 = PID 没被复用），绝不按进程名。
import { spawn, execFile } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import { GEP_LIMITS, GEP_TOKEN_ENV, GEP_WS_SUBPROTOCOL, PLUGIN_HEALTH, isEngineLaunchCommand, makeProblem } from './proto'
import type { EngineLaunch } from './proto'
import type { ConfigEngine } from './config'
import type { EventBus } from './events'
import type { Ledger } from './ledger'
import { KernelError } from './util/errors'
import { mkOrigin } from './util/origin'
import type { Clock } from './util/clock'
import { minimalSystemEnv } from './util/system-env'

export const ENGINE_STATES = ['stopped', 'starting', 'ready', 'degraded', 'stopping', 'failed'] as const
export type EngineState = (typeof ENGINE_STATES)[number]

export type EngineHandle =
  | { kind: 'stdio'; send(line: string): boolean; onLine(cb: (line: string) => void): () => void }
  | { kind: 'ws'; send(text: string): boolean; onMessage(cb: (text: string) => void): () => void }

export interface EngineBindingView { accountId: string; mode: string; mandateId?: string }
/** GQ-22：引擎重新握手后没能自动恢复、等人重新启动或停止的策略实例。 */
export interface EngineNeedsRestartView { instanceId: string; strategyId: string; accountId: string; reason: string }
export interface EngineGepStatus { engineId: string; bindings?: EngineBindingView[]; lastHeartbeatAt?: number; needsRestart?: EngineNeedsRestartView[] }
export interface EngineStatus {
  id: string
  enabled: boolean
  builtin: boolean
  state: EngineState
  transport: 'builtin' | 'stdio' | 'ws' | 'wss'
  /** 非 loopback 的远程引擎：界面须常驻"远程引擎"标识。 */
  remote: boolean
  pid: number | null
  restarts: number
  since: number
  detail?: string
  lastStderr?: string
  /** 来自 GEP 宿主 status() 的当前绑定（含账户模式与授权书号）。 */
  bindings?: EngineBindingView[]
  /** 最近一次收到引擎心跳的内核时钟毫秒；从没收到就不带。 */
  lastHeartbeatAt?: number
  /** 重启后没能自动恢复的策略实例（实盘 / 交易受限 / 读失败等），要人重新启动或停止；没有就不带。 */
  needsRestart?: EngineNeedsRestartView[]
}

interface Entry {
  cfg: ConfigEngine
  state: EngineState
  since: number
  child?: ChildProcess
  ws?: WebSocket
  restarts: number
  crashes: number[]
  timer?: ReturnType<typeof setTimeout>
  ping?: ReturnType<typeof setInterval>
  lastPong: number
  wantRun: boolean
  detail?: string
  stderr: string
  lineCbs: Set<(l: string) => void>
  msgCbs: Set<(t: string) => void>
  token: string
  local?: boolean
  localManaged?: boolean
  localClose?: () => void | Promise<void>
  /** GEP 心跳丢了：对外状态暂改报 degraded（进程还在）；心跳回来或进程重启后清掉。 */
  hbLost?: boolean
}

const isRemote = (l: EngineLaunch | undefined): boolean => {
  if (!l || isEngineLaunchCommand(l)) return false
  try { return !['127.0.0.1', '::1', '[::1]', 'localhost'].includes(new URL(l.url).hostname.toLowerCase()) } catch { return true }
}

export interface EngineSupervisorOptions {
  clock: Clock
  events: EventBus
  ledger: Ledger
  /** 句柄 → 明文（令牌 / 证书）。M1 没有对应的钥匙串条目类型时返回 undefined，远程引擎进入 failed 并写明原因。 */
  resolveSecret?: (ref: string) => string | undefined
  /** 内核主目录：本地引擎默认拿到 <home>/engines/<id>/strategies（GITRADER_STRATEGIES_DIR）与 <home>/lab/artifacts/<id>（GITRADER_ENGINE_ARTIFACT_DIR）。 */
  home?: string
  backoffMinMs?: number
  backoffMaxMs?: number
}

export class EngineSupervisor {
  private entries = new Map<string, Entry>()
  private connected = new Set<(id: string, h: EngineHandle, token: string) => void>()
  private disconnected = new Set<(id: string) => void>()
  private handles = new Map<string, EngineHandle>()
  private haltSeq = 0
  private o: Required<Pick<EngineSupervisorOptions, 'backoffMinMs' | 'backoffMaxMs'>> & EngineSupervisorOptions

  constructor(opts: EngineSupervisorOptions) {
    this.o = { backoffMinMs: PLUGIN_HEALTH.backoffMinMs, backoffMaxMs: PLUGIN_HEALTH.backoffMaxMs, ...opts }
  }

  load(engines: ConfigEngine[]): void {
    for (const cfg of engines) {
      const cur = this.entries.get(cfg.id)
      if (cur) { cur.cfg = cfg; continue }
      this.entries.set(cfg.id, { cfg, state: 'stopped', since: this.o.clock.now(), restarts: 0, crashes: [], lastPong: 0, wantRun: false, stderr: '', lineCbs: new Set(), msgCbs: new Set(), token: '' })
    }
  }

  /** GEP 层在连接建立后拿到传输句柄（握手 gep.hello / engine.describe 在它之上做）。 */
  /** 传输建立后回调（GEP 层在它之上做 gep.hello / engine.describe）。token = 本次启动的一次性令牌（本地）或解析出的远程令牌。 */
  onConnected(cb: (id: string, h: EngineHandle, token: string) => void): () => void { this.connected.add(cb); return () => { this.connected.delete(cb) } }
  /** 传输断开 / 进程退出时回调：GEP 层据此清理这条连接的订阅与定时器。 */
  onDisconnected(cb: (id: string) => void): () => void { this.disconnected.add(cb); return () => { this.disconnected.delete(cb) } }
  private notifyGone(id: string): void { this.handles.delete(id); for (const cb of this.disconnected) { try { cb(id) } catch { /* 忽略 */ } } }

  adoptLocal(id: string, handle: EngineHandle, token: string, close: () => void | Promise<void>): void {
    const e = this.entries.get(id)
    if (!e || !e.cfg.enabled || e.child || e.ws || this.handles.has(id) || e.local || !token) throw new KernelError(makeProblem('INVALID_PARAMS', 'local engine adoption requires an enabled, stopped configured entry'))
    e.local = true
    e.localManaged = true
    e.localClose = close
    e.wantRun = false
    e.token = token
    this.set(e, 'starting')
    this.handles.set(id, handle)
    for (const cb of this.connected) cb(id, handle, token)
  }

  /** GEP 层：引擎心跳丢了 → 对外状态改报 degraded（detail 由调用方写明 heartbeat lost）。只改状态，不动进程。 */
  markHeartbeatLost(id: string, detail: string): void {
    const e = this.entries.get(id)
    if (!e || e.state !== 'ready') return
    e.hbLost = true
    this.set(e, 'degraded', detail)
  }
  /** GEP 层：心跳回来了 → 把 markHeartbeatLost 改的状态改回 ready（别的原因造成的 degraded 不碰）。 */
  markHeartbeatRecovered(id: string): void {
    const e = this.entries.get(id)
    if (!e?.hbLost) return
    delete e.hbLost
    if (e.state === 'degraded') this.set(e, 'ready')
  }
  /**
   * 本地受管引擎挂死（进程在、心跳停）：只按自己持有的子进程句柄杀进程树；杀掉之后走 exit → crashed() 的现有崩溃退避重启。
   * 远程 / 内嵌（adoptLocal）引擎没有这个句柄，返回 false。
   */
  killHung(id: string): boolean {
    const e = this.entries.get(id)
    if (!e?.child || !e.wantRun) return false
    this.killTree(e.child)
    return true
  }

  markLocalReady(id: string): void { const e = this.entries.get(id); if (e?.local) this.set(e, 'ready') }
  markLocalFailed(id: string, detail: string): void { const e = this.entries.get(id); if (e?.local) this.set(e, 'failed', detail) }

  private gepStatus?: () => readonly EngineGepStatus[]
  /** GEP 宿主注册：engine.list 每项透传当前绑定与最近心跳时间。 */
  setGepStatusProvider(provider: () => readonly EngineGepStatus[]): void { this.gepStatus = provider }

  has(id: string): boolean { return this.entries.has(id) }
  ids(): string[] { return [...this.entries.keys()] }

  status(): EngineStatus[] {
    const gep = new Map((this.gepStatus?.() ?? []).map((g) => [g.engineId, g]))
    return [...this.entries.values()].map((e) => {
      const g = gep.get(e.cfg.id)
      return {
        id: e.cfg.id, enabled: e.cfg.enabled, builtin: !!e.cfg.builtin,
        state: e.localManaged ? e.state : e.cfg.builtin && !e.cfg.launch
          ? e.cfg.id === 'python-engine' ? (e.cfg.enabled ? 'failed' : 'stopped') : (e.cfg.enabled ? 'ready' : 'stopped')
          : e.state,
        transport: e.cfg.builtin && !e.cfg.launch ? 'builtin' : e.cfg.launch ? (isEngineLaunchCommand(e.cfg.launch) ? 'stdio' : new URL(e.cfg.launch.url).protocol === 'wss:' ? 'wss' : 'ws') : 'builtin',
        remote: isRemote(e.cfg.launch), pid: e.child?.pid ?? null, restarts: e.restarts, since: e.since,
        ...(e.cfg.builtin && !e.cfg.launch && e.cfg.id === 'python-engine' && e.cfg.enabled
          ? { detail: 'bundled Python entry is unavailable' }
          : e.detail ? { detail: e.detail } : {}),
        ...(e.stderr ? { lastStderr: e.stderr.slice(-400) } : {}),
        ...(g?.bindings ? { bindings: g.bindings } : {}),
        ...(g?.lastHeartbeatAt !== undefined ? { lastHeartbeatAt: g.lastHeartbeatAt } : {}),
        ...(g?.needsRestart ? { needsRestart: g.needsRestart } : {}),
      }
    })
  }

  private set(e: Entry, state: EngineState, detail?: string): void {
    if (e.state === state && e.detail === detail) return
    const from = e.state
    e.state = state
    e.since = this.o.clock.now()
    if (detail !== undefined) e.detail = detail; else delete e.detail
    this.o.events.publish('engine.health', { id: e.cfg.id, state, detail })
    try {
      this.o.ledger.append({ type: 'engine.health_changed', origin: mkOrigin('system:engines', 'engine:supervisor', 'internal'), subject: { engineId: e.cfg.id }, payload: { from, to: state, ...(detail ? { detail } : {}), remote: isRemote(e.cfg.launch) } })
    } catch { /* 账本不可用时不影响监管 */ }
  }

  /**
   * HALT 哨兵：向所有已连引擎广播 engine.halt（JSON-RPC 请求，ack 由 GEP 层处理；契约 §2.7：200 ms 内 ack）。
   * 返回送达（写入传输）的引擎数。
   */
  broadcastHalt(p: { takeoverId: string; level: 'halt_new' | 'cancel_all' | 'flatten_all'; scope: { type: string; id: string }; reason: string; deadlineMs?: number }): { sent: string[]; failed: string[] } {
    const out = { sent: [] as string[], failed: [] as string[] }
    for (const [id, h] of this.handles) {
      const msg = JSON.stringify({ jsonrpc: '2.0', id: `halt-${++this.haltSeq}`, method: 'engine.halt', params: { deadlineMs: GEP_LIMITS.haltAckMs, ...p } })
      let ok = false
      try { ok = h.send(msg) } catch { ok = false }
      ;(ok ? out.sent : out.failed).push(id)
    }
    return out
  }

  /** builtin = true 时也拉起随包的参考引擎（需要能解析到 engine-core 的打包产物）。 */
  startAll(o: { builtin?: boolean } = {}): void { for (const e of this.entries.values()) if (!e.localManaged && e.cfg.enabled && (!e.cfg.builtin || (o.builtin === true && e.cfg.launch))) this.start(e.cfg.id) }

  start(id: string): void {
    const e = this.entries.get(id)
    if (!e) throw new KernelError(makeProblem('INVALID_PARAMS', `unknown engine ${id}`))
    if (e.localManaged) return
    if (!e.cfg.launch) return
    if (e.state === 'starting' || e.state === 'ready') return
    e.wantRun = true
    this.launch(e)
  }

  private launch(e: Entry): void {
    clearTimeout(e.timer)
    delete e.hbLost
    const l = e.cfg.launch!
    this.set(e, 'starting')
    e.token = randomBytes(24).toString('base64url')
    if (isEngineLaunchCommand(l)) this.launchLocal(e, l)
    else this.launchRemote(e, l)
  }

  private launchLocal(e: Entry, l: Extract<EngineLaunch, { command: string }>): void {
    // 策略文件夹 / 产物目录由内核按配置交给引擎（用户在 launch.env 里写了就用用户的）。
    const dirs: Record<string, string> = {}
    if (this.o.home) {
      const sd = join(this.o.home, 'engines', e.cfg.id, 'strategies')
      const ad = join(this.o.home, 'lab', 'artifacts', e.cfg.id)
      try { mkdirSync(sd, { recursive: true }); mkdirSync(ad, { recursive: true }) } catch { /* 目录建不了就不给 */ }
      dirs.GITRADER_STRATEGIES_DIR = sd
      dirs.GITRADER_ENGINE_ARTIFACT_DIR = ad
    }
    const env: Record<string, string> = { ...(process.env.PATH ? { PATH: process.env.PATH } : {}), ...minimalSystemEnv(), ...dirs, ...(l.env ?? {}), [GEP_TOKEN_ENV]: e.token }
    let child: ChildProcess
    try {
      child = spawn(l.command, l.args ?? [], { cwd: l.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    } catch (ex) { this.crashed(e, `spawn failed: ${String(ex)}`); return }
    e.child = child
    let buf = ''
    child.stdout!.setEncoding('utf8').on('data', (chunk: string) => {
      buf += chunk
      if (buf.length > GEP_LIMITS.maxStdioLineBytes && !buf.includes('\n')) { buf = ''; this.set(e, 'degraded', 'engine stdout line exceeds 1 MiB'); return }
      let i: number
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '')
        buf = buf.slice(i + 1)
        if (line) for (const cb of e.lineCbs) { try { cb(line) } catch { /* 订阅者异常不影响监管 */ } }
      }
    })
    child.stderr!.setEncoding('utf8').on('data', (c: string) => { e.stderr = (e.stderr + c).slice(-4096) })
    child.stdin!.on('error', () => undefined)
    child.once('error', (ex) => this.crashed(e, `process error: ${ex.message}`))
    child.once('spawn', () => {
      this.set(e, 'ready')
      const h: EngineHandle = { kind: 'stdio', send: (line) => { if (!child.stdin!.writable) return false; child.stdin!.write(line.endsWith('\n') ? line : line + '\n'); return true /* write() 返回 false 只是背压，不是失败 */ }, onLine: (cb) => { e.lineCbs.add(cb); return () => { e.lineCbs.delete(cb) } } }
      this.handles.set(e.cfg.id, h)
      for (const cb of this.connected) cb(e.cfg.id, h, e.token)
    })
    child.once('exit', (code, sig) => {
      if (e.child !== child) return
      delete e.child
      this.notifyGone(e.cfg.id)
      if (e.state === 'stopping' || !e.wantRun) { this.set(e, 'stopped'); return }
      this.crashed(e, `exited (code ${String(code)}${sig ? `, signal ${sig}` : ''})`)
    })
  }

  private launchRemote(e: Entry, l: Extract<EngineLaunch, { url: string }>): void {
    const tokenRef = l.auth.method === 'token' ? l.auth.tokenRef : undefined
    const clientCertRef = l.auth.method === 'mtls' ? l.auth.clientCertRef : undefined
    const secret = this.o.resolveSecret?.(tokenRef ?? clientCertRef ?? '')
    if (secret === undefined) { this.set(e, 'failed', `cannot resolve ${tokenRef ? 'tokenRef' : 'clientCertRef'} (no secret store entry)`); return }
    const opts: WebSocket.ClientOptions = l.auth.method === 'mtls' ? (() => { try { const j = JSON.parse(secret) as { cert: string; key: string; ca?: string }; return { cert: j.cert, key: j.key, ...(j.ca ? { ca: j.ca } : {}) } } catch { return {} } })() : {}
    const ws = new WebSocket(l.url, GEP_WS_SUBPROTOCOL, { ...opts, handshakeTimeout: 10_000 })
    e.ws = ws
    e.lastPong = this.o.clock.now()
    ws.on('open', () => {
      this.set(e, 'ready')
      e.crashes = []
      const h: EngineHandle = { kind: 'ws', send: (t) => { if (ws.readyState !== WebSocket.OPEN) return false; ws.send(t); return true }, onMessage: (cb) => { e.msgCbs.add(cb); return () => { e.msgCbs.delete(cb) } } }
      this.handles.set(e.cfg.id, h)
      for (const cb of this.connected) cb(e.cfg.id, { ...h }, secret)
      e.ping = setInterval(() => { try { ws.ping() } catch { /* 连接已断 */ } }, GEP_LIMITS.heartbeatIntervalMs)
      e.ping.unref?.()
    })
    ws.on('pong', () => { e.lastPong = this.o.clock.now() })
    ws.on('message', (data) => { const t = data.toString('utf8'); for (const cb of e.msgCbs) { try { cb(t) } catch { /* 忽略 */ } } })
    ws.on('error', (ex) => { e.detail = ex.message })
    ws.on('close', () => {
      clearInterval(e.ping)
      if (e.ws !== ws) return
      delete e.ws
      this.notifyGone(e.cfg.id)
      if (e.state === 'stopping' || !e.wantRun) { this.set(e, 'stopped'); return }
      this.reconnect(e, e.detail ?? 'connection closed')
    })
  }

  private backoffFor(n: number): number { return Math.min(this.o.backoffMinMs * 2 ** Math.max(0, n - 1), this.o.backoffMaxMs) }

  private crashed(e: Entry, why: string): void {
    const now = this.o.clock.now()
    e.crashes = e.crashes.filter((t) => now - t < PLUGIN_HEALTH.crashWindowMs)
    e.crashes.push(now)
    delete e.child
    if (e.crashes.length >= PLUGIN_HEALTH.crashLimit) { e.wantRun = false; this.set(e, 'failed', `${why}; ${e.crashes.length} crashes within 10 minutes, giving up`); return }
    this.set(e, 'degraded', why)
    e.restarts++
    e.timer = setTimeout(() => { if (e.wantRun) this.launch(e) }, this.backoffFor(e.crashes.length))
    e.timer.unref?.()
  }

  /** 远程引擎断线：一直退避重连（人显式开启的远程连接不因次数放弃）。 */
  private reconnect(e: Entry, why: string): void {
    e.restarts++
    e.crashes = e.crashes.filter((t) => this.o.clock.now() - t < PLUGIN_HEALTH.crashWindowMs)
    e.crashes.push(this.o.clock.now())
    this.set(e, 'degraded', why)
    e.timer = setTimeout(() => { if (e.wantRun) this.launch(e) }, this.backoffFor(Math.min(e.crashes.length, 8)))
    e.timer.unref?.()
  }

  /** 健康检查：本地 = 进程在不在；远程 = 15 s 没有 pong 就断开重连。由内核定时器调用。 */
  tick(): void {
    const now = this.o.clock.now()
    for (const e of this.entries.values()) {
      if (e.ws && e.state === 'ready' && now - e.lastPong > GEP_LIMITS.heartbeatTimeoutMs) { try { e.ws.terminate() } catch { /* 已断 */ } }
      if (e.child && e.state === 'ready' && (e.child.exitCode !== null || e.child.signalCode !== null)) this.crashed(e, 'process is not running')
    }
  }

  async stop(id: string, graceMs: number = PLUGIN_HEALTH.shutdownGraceMs): Promise<void> {
    const e = this.entries.get(id)
    if (!e) return
    if (e.local) {
      if (e.state === 'stopped') return
      this.set(e, 'stopping')
      const close = e.localClose
      delete e.localClose
      try { await close?.() } finally {
        this.notifyGone(id)
        e.local = false
        e.token = ''
        this.set(e, 'stopped')
      }
      return
    }
    e.wantRun = false
    clearTimeout(e.timer)
    clearInterval(e.ping)
    if (e.ws) {
      this.set(e, 'stopping')
      const ws = e.ws
      await new Promise<void>((res) => { ws.once('close', () => res()); try { ws.close() } catch { res() }; setTimeout(res, 1000).unref?.() })
      try { ws.terminate() } catch { /* 已关 */ }
      delete e.ws
    }
    const child = e.child
    if (child) {
      this.set(e, 'stopping')
      const exited = new Promise<void>((res) => child.once('exit', () => res()))
      try { child.stdin!.end() } catch { /* 已关 */ }
      const t = setTimeout(() => this.killTree(child), graceMs)
      await exited
      clearTimeout(t)
      delete e.child
    }
    this.set(e, 'stopped')
  }

  async stopAll(graceMs?: number): Promise<void> { await Promise.all([...this.entries.keys()].map((id) => this.stop(id, graceMs))) }

  /** 只对自己持有的、还没退出的子进程句柄动手。 */
  private killTree(child: ChildProcess): void {
    if (child.exitCode !== null || child.signalCode !== null || !child.pid) return
    if (process.platform === 'win32') execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => undefined)
    else child.kill('SIGKILL')
  }
}

/**
 * 随包的参考引擎 gitrader-core（engine-core）的启动配置：任意语言引擎的特例——一个 node 子进程，stdio。
 * 找打包产物：GITRADER_ENGINE_CORE_BUNDLE 环境变量 > 工作区里的 packages/engine-core/dist/engine-core.mjs。找不到返回 undefined（内核照常起来，只是没有引擎）。
 */
export function builtinEngineLaunch(id: string, env: Record<string, string | undefined> = process.env): EngineLaunch | undefined {
  const here = (() => { try { return dirname(fileURLToPath(import.meta.url)) } catch { return process.cwd() } })()
  if (id === 'python-engine') {
    const entry = [
      join(here, 'python-engine', 'engine', 'main.py'),
      join(here, '..', '..', 'engine-python', 'engine', 'main.py'),
    ].map((candidate) => resolve(candidate)).find((candidate) => existsSync(candidate))
    if (!entry) return undefined
    return {
      command: env.GEP_PYTHON || 'python',
      args: [entry],
      env: { PYTHONDONTWRITEBYTECODE: '1' },
    }
  }
  if (id !== 'gitrader-core') return undefined
  const cands = [env.GITRADER_ENGINE_CORE_BUNDLE, join(here, '..', '..', 'engine-core', 'dist', 'engine-core.mjs'), join(here, 'engine-core.mjs')].filter((x): x is string => !!x)
  const bundle = cands.find((p) => existsSync(p))
  return bundle ? { command: process.execPath, args: [bundle, '--stdio'] } : undefined
}
