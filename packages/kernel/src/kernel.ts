// SPDX-License-Identifier: CPAL-1.0
// 内核装配：配置 → 存储 → 账本 → 鉴权 → 密钥库 → 风控 → 钥匙 / 授权书 → 交易 / 提案 / 接管 → 连接器总线 → 引擎 / 插件 → HTTP+WS。
import { AgentTrouble } from './agent-trouble'
import type { AgentTroubleInfo } from './agent-trouble'
import { AgentService } from './agents'
import { AgentRequests } from './agent-requests'
import { AccountRegistry } from './accounts'
import { AuthService } from './auth'
import type { Principal } from './auth'
import { initHome, saveConfig, loadConfig } from './config'
import { ResearchJobOwnership } from './research/ownership'
import type { GitraderConfig, HomePaths } from './config'
import { ConnectorBus, ConnectorOperationError, ReconcileSnapshotError } from './connector'
import type { ConnectorRegistrationOptions, VenueConnector } from './connector'
import { Docs, metaGet, openDb, longPathHint, classifyLedgerOpenFailure, ledgerNotWritable } from './db'
import type { Db } from './db'
import { EngineSupervisor, builtinEngineLaunch } from './engines'
import { GepHost } from './gep-host'
import type { GepHostOptions } from './gep-host'
import { EventBus } from './events'
import { InstallKey } from './install-key'
import { Keystore } from './keystore'
import { Ledger } from './ledger'
import { LabService } from './lab'
import { FileCandleStore, attachClosedCandleRecorder } from './market-store'
import { OrderStore } from './orders'
import { PinStore } from './pin'
import { DeviceKey } from './device-key'
import type { DeviceKeyProvider } from './device-key'
import type { ScryptParams } from './pin'
import { PluginHost } from './plugins'
import { NotifyOutlet } from './notify/outlet'
import { looseTokenFiles } from './token-file'
import { sampleEquity } from './equity-history'
import { ProtectorEngine } from './protectors'
import { RiskGate, RiskService } from './risk'
import { TakeoverService, VenueDeadman } from './takeover'
import { TradingService } from './trading'
import type { ActorCtx } from './trading'
import { ORG_SCOPE, TradingStateService } from './trading-state'
import { OpRegistry, RouteRegistry } from './api/router'
import { registerApiRoutes } from './api/index'
import { registerCoreOps } from './ops'
import { startHttp } from './http/server'
import type { HttpHandle } from './http/server'
import { makeProblem } from './proto'
import type { Account, Order, OrderStatus, TradingScope, TradingState, VenueCatalogEntry } from './proto'
import { KernelError, toProblem } from './util/errors'
import type { SecurityStateHealth, SecurityStateFileStatus } from '@gitrader/protocol'
import * as d from './util/dec'
import { SettingsService, WorkspaceService } from './services'
import { systemClock } from './util/clock'
import { ReplayClock } from './util/clock'
import { loadReplayFixture } from './replay-fixture'
import type { PaperReplayFixture } from './proto'
import { digestOf } from './util/hash'
import { ReplayController } from './replay'
import { ReconcileService } from './reconcile-service'
import type { ReplayDriver } from './replay'
import type { PaperReplayStart, PaperReplayStatus } from './proto'
import { existsSync, readFileSync, readdirSync, watch } from 'node:fs'
import type { FSWatcher } from 'node:fs'
import { join } from 'node:path'
import { guardNewLedgerPaperState, judgePaperState, restorePaperState, writePaperState } from './paper-integrity'
import type { PaperStateHealth } from './paper-integrity'
import { ledgerFailureZh, verifyLedgerDb } from './ledger-integrity'
import { reconcileProtection } from './child-protect'
import { paperLedgerFacts } from './paper-rebuild'
import { str as fxStrOf } from '@gitrader/protocol/decimal'

const fxToDecimalString = (v: bigint): string => fxStrOf(v, 10)
import type { ProtectionView } from './child-protect'
import type { LedgerVerifyStatus } from './ledger-integrity'
import { OpRateAudit, OpRateLimiter, classifyOperation } from './util/op-rate-limit'
import { OverloadGuard } from './util/overload'
import { opRateCounters } from './metrics'
import type { Clock } from './util/clock'
import { mkOrigin, systemOrigin } from './util/origin'
import type { Origin } from './proto'

type PaperStateConnector = VenueConnector & {
  createAccount?: (s: { accountId: string; initialBalance: string; ccy?: string }) => void
  hasAccount?: (id: string) => boolean
  exportState?: () => string
  importState?: (state: string) => void
  resetAccount?: (s: { accountId: string; initialBalance: string; ccy?: string }) => Promise<void>
  onEvent?: (cb: (e?: unknown) => void) => () => void
}

export const KERNEL_VERSION = '0.1.1'

/** K1：调用 CLI 的完整命令路径（便携包由 gitrader.cmd 设置 GITRADER_LAUNCHER）；没设就是 gitrader，含空格加双引号（与 CLI cmdName 同规则）。 */
export function launcherFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const v = env.GITRADER_LAUNCHER?.trim()
  if (!v) return 'gitrader'
  return /\s/.test(v) && !v.startsWith('"') ? `"${v}"` : v
}


function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

type ConnState = 'connecting' | 'connected' | 'disconnected'
/** 场所就绪度（R2-REL-02）：行情可用 / 主标的已知 / 全部目录完成 / 启动对账完成。 */
export interface VenueReadiness { marketLive: boolean; primaryInstruments: boolean; catalogComplete: boolean; startupReconciled: boolean }
export interface VenueConnection { venue: string; state: ConnState; detail?: string; stale?: boolean; since: number; readiness: VenueReadiness }
interface VenueReconcileRec { started: boolean; running: boolean; ran: boolean; retryAt: number; retryWait: number; redo?: boolean }
class StartTimeoutError extends Error {}

/**
 * 实盘开仓以启动对账完成为前置（R2-REL-02 / B-5，只许收紧）：给交易服务一份交易状态的视图，
 * 其中启动对账没完成的实盘账户多一条 REDUCING（原因 startup reconcile pending）。内核自己的 tstate 不动，
 * 所以 status / 风控状态页 / 接管不会因此出现假的 REDUCING；只有交易闸门看得到，开仓被拒、减仓 / 平仓 / 撤单照常。
 */
function withStartupHold(tstate: TradingStateService, hold: (accountId: string) => string | undefined): TradingStateService {
  return new Proxy(tstate, {
    get(target, prop) {
      if (prop !== 'effective') { const v = Reflect.get(target, prop, target); return typeof v === 'function' ? v.bind(target) : v }
      return (scopes: TradingScope[], groupIds: readonly string[] = []): ReturnType<TradingStateService['effective']> => {
        const base = target.effective(scopes, groupIds)
        const held = scopes.flatMap((sc) => { const reason = sc.type === 'account' ? hold(sc.id) : undefined; return reason ? [{ scope: { ...sc }, state: 'REDUCING' as const, reason }] : [] })
        return held.length ? { state: base.state === 'HALTED' ? 'HALTED' : 'REDUCING', reasons: [...base.reasons, ...held] } : base
      }
    },
  })
}

export interface KernelOptions {
  home: string
  clock?: Clock
  /** 测试用：降低 scrypt 成本。 */
  scrypt?: ScryptParams
  /** 设备密钥的包裹方式（缺省：Windows = DPAPI CurrentUser；其他 = 文件权限 0600）。测试里用 fileProvider 免起 PowerShell。 */
  deviceKeyProvider?: DeviceKeyProvider
  log?: (msg: string) => void
  /** 定时器（默认开）。测试里关掉，手动 tickOnce()。 */
  timers?: boolean
  deadman?: { windowSec: number; refreshSec: number; enabled: boolean }
  engines?: { backoffMinMs?: number; backoffMaxMs?: number }
  gep?: GepHostOptions
  plugins?: { backoffMinMs?: number; backoffMaxMs?: number; healthIntervalMs?: number; healthTimeoutMs?: number; shutdownGraceMs?: number }
  resolveSecret?: (ref: string) => string | undefined
  sleep?: (ms: number) => Promise<void>
  /** fix-r2 S2：账本库不见了但本机已有身份 / 状态文件时，只有显式同意才从空账本重来（也认 GITRADER_ACCEPT_NEW_LEDGER=1）。 */
  acceptNewLedger?: boolean
  /** R2-REL-11：和 acceptNewLedger 一起用——新账本遇到非空 paper-state.json 时，同意把旧状态移进 backups/ 并按初始资金重来（只认显式命令行参数 --reset-paper-state，没有环境变量写法）。 */
  resetPaperState?: boolean
}

/**
 * 账本库打不开：中文说明点名路径，上游原文放括号里。R2-REL-05：按真实原因说话——
 * 被占用 / 只读时文件是好的，绝不建议“从备份还原”（照做会用旧备份覆盖最新账本）；只有确认损坏才建议还原。
 * 占用 / 只读的英文句不写 “ledger database”，免得被通用问题文案表映射成“从备份还原”。
 */
function ledgerOpenError(path: string, e: unknown, readOnlyAt?: string): KernelError {
  const why = e instanceof Error ? e.message : String(e)
  const kind = readOnlyAt ? 'readonly' : classifyLedgerOpenFailure(path, e)
  if (kind === 'in_use') return new KernelError(makeProblem('STATE_FILE_CORRUPT', `ledger db file is in use by another process: ${path} (${why}). 账本库文件正被另一个程序占用（另一个 gitrader、杀毒或同步软件）：${path}。文件本身没有发现损坏；关掉占用它的程序、确认 data/ 目录可写后重启${longPathHint(path)}`))
  if (kind === 'readonly') return new KernelError(makeProblem('STATE_FILE_CORRUPT', `ledger db file is read-only: ${readOnlyAt ?? path} (${why}). 账本库是只读的：${readOnlyAt ?? path}。去掉这个文件和 data/ 目录的只读属性、确认当前用户可写后重启；文件本身没有发现损坏${longPathHint(path)}`))
  if (kind === 'corrupt') return new KernelError(makeProblem('STATE_FILE_CORRUPT', `ledger database cannot be opened: ${path} (${why}). 账本数据库打不开：检查目录权限，或从备份还原这个文件后重启${longPathHint(path)}`))
  return new KernelError(makeProblem('STATE_FILE_CORRUPT', `ledger db file cannot be opened: ${path} (${why}). 账本数据库打不开：检查目录权限、文件是否被别的程序占用；确认文件损坏之前不要覆盖它${longPathHint(path)}`))
}

/** fix-r2 S2（ADR-17）：库文件不见了而本机还留着身份 / 状态文件 → 拒绝启动（绝不悄悄新建空账）；打开失败翻成人话。 */
function openLedgerDb(path: string, acceptNew: boolean, evidence: string[]): { db: Db; createdNew: boolean } {
  const existed = existsSync(path)
  if (!existed && evidence.length > 0 && !acceptNew) {
    throw new KernelError(makeProblem('STATE_FILE_CORRUPT', `ledger database is missing: ${path}; restore it from a backup, or start with --accept-new-ledger to begin an empty ledger. 账本数据库不见了（本机还留着 ${evidence.join('、')}）：从备份还原后重启；确定要从空账本重来才加 --accept-new-ledger`))
  }
  let db: Db | undefined
  try {
    const readOnlyAt = ledgerNotWritable(path)
    if (readOnlyAt) throw ledgerOpenError(path, new Error('not writable'), readOnlyAt)
    db = openDb(path)
    db.prepare('SELECT COUNT(*) c FROM ledger').get()
    return { db, createdNew: !existed }
  } catch (e) {
    try { db?.close() } catch { /* ignore */ }
    if (e instanceof KernelError) throw e
    throw ledgerOpenError(path, e)
  }
}

export class Kernel {
  readonly replayFixture?: PaperReplayFixture
  readonly replayClock?: ReplayClock
  readonly replayController?: ReplayController
  connectorCatalog: VenueCatalogEntry[] = []
  readonly lab: LabService
  readonly notify: NotifyOutlet
  readonly reconcileService: ReconcileService
  readonly research: ResearchJobOwnership
  /** 接入请求（内存，重启即失效）：人在浏览器输 PIN 批准后建钥匙。 */
  readonly agentRequests: AgentRequests
  readonly startedAt: number
  /** K1：启动时从环境读一次。 */
  readonly launcher: string = launcherFromEnv()
  /** K5：Agent 钥匙连续失败计数（内存，不写账本）。 */
  readonly agentTrouble: AgentTrouble = new AgentTrouble(() => this.auth.now())
  private agentTroubleSnapshot(): AgentTroubleInfo | null {
    return this.agentTrouble.worst((id) => this.agents.listKeys().find((x) => x.keyId === id)?.name ?? id)
  }
  /** fix-r4 C4：`service.shutdown` 的宿主回调（CLI serve 接到优雅关闭路径）；内核本身不决定怎么退出。 */
  onShutdownRequest?: () => void
  readonly operationRateLimiter: OpRateLimiter
  readonly operationRateAudit: OpRateAudit
  /** ADR-27：只读 / 预检类 op 的全局在途上限 + 事件循环延迟卸载。 */
  private readonly overload: OverloadGuard
  readonly warnings: string[] = []
  readonly ops = new OpRegistry()
  readonly routes = new RouteRegistry()
  http?: HttpHandle
  private timer?: ReturnType<typeof setInterval>
  private overloadTimer?: ReturnType<typeof setInterval>
  private venueTickTimer?: ReturnType<typeof setInterval>
  private ticking = false
  private readonly livePollAbort = new AbortController()
  private stopped = false
  private livePollRun?: Promise<void>
  private readonly livePollLastStarted = new Map<string, number>()
  private readonly livePollInFlight = new Set<string>()
  private readonly liveFillCursors = new Map<string, number>()
  private paperState?: PaperStateConnector
  private paperUnsubscribe?: () => void
  private paperSavedAt = 0
  private paperHealth: PaperStateHealth = { state: 'none', dirty: false }
  private paperRetryTimer?: ReturnType<typeof setTimeout>
  private paperRetryAttempt = 0
  private haltWatcher?: FSWatcher
  private haltFilePresent = false
  private unsubStore?: () => void
  private stateCorruptionLatched = false
  private readonly corruptedStateKinds = new Set<string>()
  private readonly startupReconcileAccounts = new Map<string, number>()
  private ledgerVerify?: LedgerVerifyStatus
  private ledgerLatched = false
  private readonly protectionRetry = new Map<string, { firstAt: number; lastAt: number }>()
  private readonly paperReconcileRetry = new Map<string, { firstAt: number; lastAt: number }>()
  /** 每个账户最近一次启动对账是否成功（没跑过 = 没有记录）。就绪度与实盘开仓闸门（startupHold）读它。 */
  private readonly reconcileOk = new Map<string, boolean>()
  private readonly venueRec = new Map<string, VenueReconcileRec>()

  private constructor(
    readonly paths: HomePaths, public config: GitraderConfig, readonly clock: Clock, readonly opts: KernelOptions,
    readonly db: Db, readonly docs: Docs, readonly events: EventBus, readonly installKey: InstallKey, readonly ledger: Ledger,
    readonly pin: PinStore, readonly auth: AuthService, readonly keystore: Keystore, readonly accounts: AccountRegistry, readonly bus: ConnectorBus,
    readonly tstate: TradingStateService, readonly risk: RiskService, readonly gate: RiskGate, readonly orders: OrderStore,
    readonly protectors: ProtectorEngine, readonly agents: AgentService, readonly trading: TradingService, readonly deadman: VenueDeadman,
    readonly takeover: TakeoverService, readonly engines: EngineSupervisor, readonly plugins: PluginHost,
    readonly settings: SettingsService, readonly workspaces: WorkspaceService, readonly gep: GepHost,
    readonly marketStore: FileCandleStore, replayFixture?: PaperReplayFixture, replayClock?: ReplayClock,
  ) {
    this.replayFixture = replayFixture ? deepFreeze(replayFixture) : undefined
    this.replayClock = replayClock
    this.replayController = replayFixture && replayClock ? new ReplayController(this, this.replayFixture!, replayClock) : undefined
    this.startedAt = auth.now()
    this.operationRateLimiter = new OpRateLimiter(config.server.operationRateLimit)
    // fix-r2 L1：被限的调用计数进指标，每主体每分钟最多一条账本 rate.limited
    this.operationRateAudit = new OpRateAudit((note) => {
      ledger.append({ type: 'annotation', origin: systemOrigin('rate:limited'), subject: { orgId: 'org_local' }, payload: { kind: 'rate.limited', ...note } })
    }, opRateCounters(events), () => clock.now())
    this.overload = new OverloadGuard({ maxInflight: config.server.maxInflightReadOps, loopDelayShedMs: config.server.loopDelayShedMs })
    this.lab = new LabService(this)
    this.research = new ResearchJobOwnership()
    this.agentRequests = new AgentRequests({ clock, onChange: () => { events.publish('agentkey.request.changed', {}) } })
    this.notify = new NotifyOutlet({ events, plugins, config: () => this.config.notify, now: () => clock.now(), log: message => this.log(message), outboxFile: join(paths.home, 'notify-outbox.jsonl') })
    this.reconcileService = new ReconcileService({
      accounts, orders, bus, clock, securityNow: () => auth.now(), ledger, docs, events, trading, tstate,
      securityHealth: () => this.securityStateHealth(),
      startupBusy: (accountId) => (this.startupReconcileAccounts.get(accountId) ?? 0) > 0 || this.livePollInFlight.has(accountId),
      log: (message) => this.log(message),
    })
  }

  get home(): string { return this.paths.home }
  /** 只读：供测试观察 / 触发 tick；内核自己不对外暴露。 */
  get overloadGuard(): OverloadGuard { return this.overload }
  log(msg: string): void { this.opts.log?.(msg) }

  /** ADR-27：op 分发入口统一过载保护；exempt（下单 / 撤单 / 平仓 / 急停 / 批准）不经过 guard。 */
  private async guardedDispatch<T>(name: string, params: unknown, principal: Principal | null, run: () => Promise<T>): Promise<T> {
    // 只管 Agent / 引擎的调用（ADR-27「不让一把钥匙拖垮别人」）；人面会话、服务令牌不被卸载，界面在负载下照常可用
    if (principal?.kind !== 'agent' && principal?.kind !== 'engine') return run()
    const cls = classifyOperation(name, params)
    if (cls === 'exempt') return run()
    const release = this.overload.enter(cls, this.auth.operationRateKey(principal) ?? '')
    try { return await run() } finally { release() }
  }

  attachReplayDriver(driver: ReplayDriver): void {
    if (!this.replayController) throw new KernelError(makeProblem('CAPABILITY_UNSUPPORTED', 'paper replay is not configured'))
    this.replayController.attachDriver(driver)
  }

  replayStart(input: PaperReplayStart): Promise<PaperReplayStatus> {
    if (!this.replayController) throw new KernelError(makeProblem('CAPABILITY_UNSUPPORTED', 'paper replay is not configured'))
    return this.replayController.start(input)
  }

  replayStatus(): PaperReplayStatus {
    if (!this.replayController) return { state: 'idle', frameIndex: -1, totalFrames: 0, clock: this.clock.now() }
    return this.replayController.status()
  }

  replayStop(runId: string): Promise<PaperReplayStatus> {
    if (!this.replayController) throw new KernelError(makeProblem('CAPABILITY_UNSUPPORTED', 'paper replay is not configured'))
    return this.replayController.stop(runId)
  }

  consumeOperationRate(principal: Principal, name: string, params?: unknown): void {
    // 下单 / 撤单 / 平仓 / 急停 / 批准不计数（自保动作不能被限流挡住）；只读与预检类走更小的单独桶（fix-r2 L1）
    const cls = classifyOperation(name, params)
    if (cls === 'exempt') return
    const key = this.auth.operationRateKey(principal)
    if (key === null) return
    try { this.operationRateLimiter.consume(key, cls) } catch (e) { this.operationRateAudit.record(key, name); throw e }
  }

  securityStateHealth(): SecurityStateHealth {
    const files: SecurityStateFileStatus[] = [
      this.pin.stateFileStatus(), this.keystore.stateFileStatus(), this.pin.deviceStateFileStatus(), this.installKey.stateFileStatus(),
    ]
    const pin = files.find((file) => file.kind === 'pin')!
    const keystore = files.find((file) => file.kind === 'keystore')!
    const deviceKey = files.find((file) => file.kind === 'device-key')!
    if (pin.state === 'missing' && (keystore.state !== 'missing' || deviceKey.state !== 'missing')) {
      this.pin.markStateCorrupt()
      this.corruptedStateKinds.add('pin')
    }
    if (pin.state === 'ok' && deviceKey.state === 'missing' && this.pin.version() === 2) {
      this.pin.markStateCorrupt()
      this.corruptedStateKinds.add('device-key')
    }
    for (const file of files) if (file.state === 'corrupt') this.corruptedStateKinds.add(file.kind)
    if (this.corruptedStateKinds.size > 0) this.stateCorruptionLatched = true
    if (this.stateCorruptionLatched) {
      this.keystore.lock()
      for (const file of files) if (this.corruptedStateKinds.has(file.kind)) file.state = 'corrupt'
    }
    return { ok: !this.stateCorruptionLatched, files, recoveryRequired: this.stateCorruptionLatched }
  }

  throwStateCorrupt(): never {
    throw new KernelError(makeProblem('STATE_FILE_CORRUPT', 'security state file is corrupt; restore the original file and restart'))
  }

  healthSnapshot(): { version: string; launcher: string; uptimeMs: number; degraded: boolean; stateFiles: SecurityStateFileStatus[]; warnings: string[]; ledgerVerify: LedgerVerifyStatus | null; paperState: PaperStateHealth; agentTrouble: AgentTroubleInfo | null } {
    const health = this.securityStateHealth()
    const integrityWarnings = this.integrityWarnings()
    return {
      version: KERNEL_VERSION, launcher: this.launcher, uptimeMs: Math.max(0, this.auth.now() - this.startedAt), degraded: !health.ok, stateFiles: [...health.files, ...this.paperFileStatus()],
      warnings: [...(health.ok ? [] : ['security state file is corrupt']), ...integrityWarnings],
      ledgerVerify: this.ledgerVerify ?? null, paperState: this.paperStateHealth(), agentTrouble: this.agentTroubleSnapshot(),
    }
  }

  private paperFileStatus(): SecurityStateFileStatus[] {
    const s = this.paperHealth.state
    if (s === 'none') return []
    return [{ kind: 'paper-state', state: s === 'corrupt' ? 'corrupt' : s === 'missing' ? 'missing' : 'ok' }]
  }

  private integrityWarnings(): string[] {
    const out: string[] = []
    if (this.ledgerVerify && !this.ledgerVerify.ok) out.push(`ledger verification failed at seq ${this.ledgerVerify.failure?.seq ?? '?'}: ${this.ledgerVerify.failure?.reason ?? 'unknown'}`)
    if (this.paperHealth.state === 'corrupt' || this.paperHealth.state === 'missing') out.push(`paper state file refused: ${this.paperHealth.reasonEn ?? 'unknown reason'}`)
    if (this.paperHealth.dirty) out.push('paper state is not persisted yet (retrying)')
    return out
  }

  /** 验账本链（auto：条目不多就全量，否则从最近检查点起）。失败 → 全局 HALTED 并锁存。返回本次结果。 */
  runLedgerVerify(mode: 'auto' | 'full' = 'auto'): LedgerVerifyStatus {
    const lv = verifyLedgerDb(this.db, { mode, now: this.clock.now() })
    this.ledgerVerify = lv
    if (!lv.ok && !this.ledgerLatched) {
      this.ledgerLatched = true
      this.tstate.set(ORG_SCOPE, 'HALTED', ledgerFailureZh(lv), systemOrigin('ledger:verify', 'ledger'))
      this.log(`ledger verification failed at seq ${lv.failure?.seq}: ${lv.failure?.reason}`)
    }
    return lv
  }

  /** 恢复交易前的完整性关卡：账本锁存时先全量重验（仍断就拒绝）；纸面状态不可信时拒绝恢复纸面账户。 */
  assertResumable(scope: { type: string; id?: string }): void {
    if (this.ledgerLatched) {
      const lv = this.runLedgerVerify('full')
      if (!lv.ok) throw new KernelError(makeProblem('TRADING_STATE', `ledger verification failed at seq ${lv.failure?.seq}: ${lv.failure?.reason}; trading stays HALTED. ${ledgerFailureZh(lv)}，交易保持停止：从备份还原账本数据库后重启`))
      this.ledgerLatched = false
    }
    const s = this.paperHealth.state
    if ((s === 'corrupt' || s === 'missing') && scope.type === 'account' && !!scope.id && this.paperAccountIds().includes(scope.id)) {
      throw new KernelError(makeProblem('TRADING_STATE', `paper state file is not trusted (${this.paperHealth.reasonEn ?? 'unknown'}); restore paper-state.json or run gitrader paper rebuild-from-ledger, then restart. 纸面状态文件不可信：先还原文件或运行 gitrader paper rebuild-from-ledger，再重启`))
    }
  }

  /** 创建内核（幂等 init：缺的目录与配置补上，已有的不动）。不起网络监听，调 start() 才起。 */
  static async create(opts: KernelOptions): Promise<Kernel> {
    const { paths, config } = initHome(opts.home)
    if (config.paperReplay && opts.clock) throw new KernelError(makeProblem('INVALID_PARAMS', 'an injected clock cannot be used with paperReplay'))
    const replayFixture = config.paperReplay ? loadReplayFixture(paths.home, config) : undefined
    const replayClock = replayFixture ? new ReplayClock(replayFixture.frames[0]!.ts) : undefined
    const clock = replayClock ?? opts.clock ?? systemClock
    const securityClock = replayFixture ? systemClock : clock
    const acceptNewLedger = opts.acceptNewLedger === true || process.env.GITRADER_ACCEPT_NEW_LEDGER === '1'
    const tokensDir = join(paths.home, 'agent-tokens')
    const ledgerEvidence = [
      ...(existsSync(paths.installKey) ? ['keys/install-key.json'] : []),
      ...(existsSync(join(paths.home, 'paper-state.json')) ? ['paper-state.json'] : []),
      ...(existsSync(tokensDir) && readdirSync(tokensDir).length > 0 ? ['agent-tokens/'] : []),
    ]
    // R2-REL-11：新账本 + 非空纸面状态默认拒绝（在建库之前判定，拒绝时不留空账本、不动 paper-state.json）
    if (opts.resetPaperState === true && existsSync(paths.db)) {
      throw new KernelError(makeProblem('INVALID_PARAMS', '--reset-paper-state only applies together with --accept-new-ledger when the ledger db file is missing; the ledger exists here, so nothing was changed. 账本库在，--reset-paper-state 不适用，什么都没动'))
    }
    let paperResetDir: string | undefined
    if (!existsSync(paths.db) && acceptNewLedger) {
      paperResetDir = guardNewLedgerPaperState(paths.home, opts.resetPaperState === true, clock.now())
    }
    let opened: ReturnType<typeof openLedgerDb>
    try { opened = openLedgerDb(paths.db, acceptNewLedger, ledgerEvidence) } catch (e) {
      if (paperResetDir) {
        // 新账本没建成：旧纸面状态搬回原处，别让状态停在半截。搬回本身失败也不许盖掉开库的原始报错：两个原因都带上，并写明旧状态现在在哪。
        try { restorePaperState(paths.home, paperResetDir) } catch (re) {
          const base = toProblem(e)
          throw new KernelError({ ...base, message: `${base.message} | moving the old paper state back also failed (${re instanceof Error ? re.message : String(re)}); it is now in ${paperResetDir} (paper-state.json / .prev) -- 旧纸面状态现在在备份目录 ${paperResetDir}，手动搬回 ${paths.home} 即可` })
        }
      }
      throw e
    }
    const { db, createdNew: ledgerCreatedNew } = opened
    if (paperResetDir) opts.log?.(`paper-state.json moved to ${paperResetDir} (--reset-paper-state); paper accounts restart from the configured initial balance`)
    const docs = new Docs(db, () => clock.now())
    const events = new EventBus(() => clock.now(), (e) => opts.log?.(`event subscriber error: ${e instanceof Error ? e.message : String(e)}`))
    let installKey: InstallKey
    try {
      const savedKeyId = metaGet(db, 'install_key_id')
      const savedPublicKey = metaGet(db, 'install_key_pub')
      const ledgerCount = (db.prepare('SELECT COUNT(*) c FROM ledger').get() as { c: number }).c
      if ((savedKeyId && !savedPublicKey) || (!savedKeyId && savedPublicKey) || (ledgerCount > 0 && !savedKeyId && !savedPublicKey)) {
        throw new KernelError(makeProblem('STATE_FILE_CORRUPT', 'security state file is corrupt; restore the original file and restart'))
      }
      // The ledger records the stable public identity but not its creation time; zero is an internal unknown sentinel for this disabled signer.
      const savedIdentity = savedKeyId && savedPublicKey ? { keyId: savedKeyId, publicKey: savedPublicKey, createdAt: 0 } : undefined
      if (savedIdentity && !existsSync(paths.installKey)) {
        installKey = InstallKey.unavailable(paths.installKey, savedIdentity)
      } else {
        try {
          installKey = InstallKey.loadOrCreate(paths.installKey, clock.now())
        } catch (error) {
          if (savedIdentity && error instanceof KernelError && error.problem.name === 'STATE_FILE_CORRUPT') {
            installKey = InstallKey.unavailable(paths.installKey, savedIdentity)
          } else {
            throw error
          }
        }
      }
      if (savedIdentity && (installKey.keyId !== savedIdentity.keyId || installKey.publicKey !== savedIdentity.publicKey)) {
        installKey = InstallKey.unavailable(paths.installKey, savedIdentity)
      }
    } catch (error) {
      db.close()
      throw error
    }
    const persistedReplayDigest = metaGet(db, 'paper_replay_fixture_digest')
    if (persistedReplayDigest && !replayFixture) {
      db.close()
      throw new KernelError(makeProblem('STATE_FILE_CORRUPT', 'historical paper replay home cannot open without its replay configuration'))
    }
    const replayFixtureDigest = replayFixture ? digestOf(replayFixture) : undefined
    let ledger: Ledger
    try { ledger = new Ledger(db, clock, events, installKey, replayFixtureDigest ? { replayFixtureDigest } : undefined) }
    catch (error) { db.close(); throw error instanceof KernelError ? error : ledgerOpenError(paths.db, error) }
    let k: Kernel
    const pin = new PinStore(paths.pin, securityClock, opts.scrypt, new DeviceKey(paths.deviceKey, opts.deviceKeyProvider))
    const agents = new AgentService(docs, ledger, events, clock, installKey, { defaultExpiryDays: config.keys.agentKeyExpiryDays })
    const auth = new AuthService({ clock: securityClock, pin, servicePath: paths.service, verifyAgentToken: (t) => agents.verifyToken(t), assertPinStateHealthy: () => { if (k && !k.securityStateHealth().ok) k.throwStateCorrupt() } })
    // 旧格式 PIN 文件（没有设备密钥）验证通过时就地升级：先给密钥库换钥，不改变密钥库原来的锁定状态，并入账（集成修补 H）
    pin.onLegacyUpgrade = (oldKey, newKey) => {
      const was = keystore.isUnlocked()
      keystore.rekey(oldKey, newKey)
      if (!was) keystore.lock()
      ledger.append({ type: 'annotation', origin: systemOrigin('pin:upgrade', 'auth'), subject: { orgId: 'org_local' }, payload: { setting: 'pin', upgraded: 'v1->v2', kdf: 'scrypt+device-key' } })
    }
    const keystore = new Keystore(paths.keystore, clock, {
      warnDays: config.keys.walletExpiryWarnDays,
      // 每次签名把载荷摘要写入账本 signer.signed（只记摘要，不记载荷、不记密钥）
      onSigned: (s) => { ledger.append({ type: 'signer.signed', origin: systemOrigin('signer:sign', 'signer'), subject: { orgId: 'org_local' }, payload: { walletId: s.walletId, address: s.address, digest: s.digest, primaryType: s.primaryType } }) },
      assertStateHealthy: () => { if (k && !k.securityStateHealth().ok) k.throwStateCorrupt() },
    })
    const accounts = new AccountRegistry(config)
    ledger.accountLabel = (id) => { const a = accounts.find(id); return a ? (a.alias || `${a.venue} ${a.mode === 'paper' ? '纸面' : '实盘'}`) : undefined }
    const bus = new ConnectorBus(clock, opts.log)
    const tstate = new TradingStateService(docs, ledger, events, clock)
    const risk = new RiskService(docs, ledger, events, clock, installKey)
    const gate = new RiskGate(risk, tstate)
    const orders = new OrderStore(db)
    const protectors = new ProtectorEngine(risk, tstate, orders, ledger, events, clock)
    const trading = new TradingService({ clock, db, docs, ledger, events, accounts, bus, risk, gate, tstate: withStartupHold(tstate, (accountId) => k?.startupHold(accountId)), agents, orders, protectors, installKey, keystore, assertLiveStateHealthy: () => { if (k && !k.securityStateHealth().ok) k.throwStateCorrupt() }, paperTrusted: () => !!k && k.paperStateTrusted(), persistenceWarnings: () => (k ? k.persistenceWarnings() : []) })
    const deadman = new VenueDeadman({
      clock, bus, accounts, keystore, ledger,
      // 看门狗只在“有实盘挂单”或“有开启了实盘的授权书（L2+ 且覆盖该账户）”时续期
      needed: (a) => orders.list({ accountId: a.accountId, openOnly: true, limit: 1 }).length > 0
        || agents.listMandates().some((m) => m.status === 'active' && Number(m.level.slice(1)) >= 2 && m.accounts.includes(a.accountId as never) && clock.now() < m.notAfter),
    }, opts.deadman)
    const takeover = new TakeoverService({ clock, ledger, events, accounts, bus, tstate, trading, agents, keystore, deadman, assertResumable: (scope) => k.assertResumable(scope), ...(opts.sleep ? { sleep: opts.sleep } : {}) })
    const engines = new EngineSupervisor({ clock, events, ledger, home: paths.home, ...(opts.resolveSecret ? { resolveSecret: opts.resolveSecret } : {}), ...(opts.engines ?? {}) })
    // ponytail: 库目录按第一个场所配置的环境分层（testnet / mainnet 不混），逐场所环境等多场所时再做。
    const store = new FileCandleStore(join(paths.home, 'data', 'candles', config.venues[0]?.environment ?? 'testnet'))
    const unsubStore = attachClosedCandleRecorder(events, store, { onError: (e) => opts.log?.(`candle store record failed: ${e instanceof Error ? e.message : String(e)}`) })
    const gep = new GepHost({ clock, docs, ledger, events, accounts, bus, trading, agents, risk, tstate, takeover, orders, engines, store, artifactPut: (engineId, input) => k.lab.artifacts.put(engineId, input), venuePrimaryReady: (venue) => k.venuePrimaryReady(venue), hostVersion: KERNEL_VERSION }, opts.gep)
    const plugins = new PluginHost({
      home: paths.home, pluginsDir: paths.plugins, docs, ledger, events, clock,
      secretHandles: () => k.config.plugins.secrets ?? {}, resolveSecret: opts.resolveSecret, log: opts.log,
      developerMode: () => k.config.plugins.developerMode, trustRoots: () => k.config.plugins.trustRoots, kernelVersion: KERNEL_VERSION, ...(opts.plugins ?? {}),
      knownIds: () => (db.prepare("SELECT DISTINCT id FROM docs WHERE coll='pluginknown'").all() as { id: string }[]).map((r) => r.id),
    })
    const settings = new SettingsService(docs)
    const workspaces = new WorkspaceService(paths.workspaces, docs, clock, events)
    k = new Kernel(paths, config, clock, opts, db, docs, events, installKey, ledger, pin, auth, keystore, accounts, bus, tstate, risk, gate, orders, protectors, agents, trading, deadman, takeover, engines, plugins, settings, workspaces, gep, store, replayFixture, replayClock)
    k.gep.callEngine = ((engineId, method, params) => method.startsWith('paper.replay.')
      ? k.gep.callPaperReplay(engineId, method, params)
      : k.lab.forward(engineId, method, params)) as typeof k.gep.callEngine
    k.gep.setPaperReplayHandler(async (engineId, method, params) => {
      if (method === 'paper.replay.status') return k.replayStatus()
      if (method === 'paper.replay.start') {
        const input = params as unknown as PaperReplayStart
        if (input.engineId !== engineId) throw new KernelError(makeProblem('INVALID_PARAMS', 'replay engineId must match the authenticated GEP caller'))
        return k.replayStart(input)
      }
      if (method === 'paper.replay.stop') return k.replayStop(String(params.runId ?? ''))
      throw new KernelError(makeProblem('CAPABILITY_UNSUPPORTED', 'paper replay method is unsupported'))
    })
    k.unsubStore = unsubStore

    // 风控策略：按配置播种 / 只收紧，然后验签；失败即停
    if (installKey.isAvailable()) {
      const seeded = risk.seedFromConfig(config.risk)
      k.warnings.push(...seeded.warnings)
    } else {
      k.warnings.push('security state file is corrupt')
    }
    // 集成修补（H）：Hyperliquid 的 API 钱包替主账户下单，账户状态 / 成交推送都要按主账户地址查。实盘账户没写 owner.address 时，
    // 内核会去查零地址、收不到成交推送——账本与持仓对不上，所以启动时明说。
    for (const a of accounts.list()) if (a.mode === 'live' && a.signer.type === 'api-wallet' && !a.owner.address) k.warnings.push(`account ${a.alias}: owner.address (your main wallet address, public) is missing in gitrader.json; balances, positions and fills of this live account cannot be tracked until it is set`)
    const integrity = risk.verify()
    if (!integrity.ok) {
      tstate.set(ORG_SCOPE, 'HALTED', `risk policy failed verification: ${integrity.problems[0]}`, systemOrigin('startup:policy-verify', 'risk'))
      k.warnings.push(`risk policy failed verification, trading is HALTED: ${integrity.problems.join('; ')}`)
    }
    // fix-r2 S2（ADR-17）：启动验账本哈希链 + 成交投影；断了就全局 HALTED 并锁存（恢复时重验）。
    if (ledgerCreatedNew && ledgerEvidence.length > 0) {
      ledger.append({ type: 'annotation', origin: systemOrigin('startup:ledger', 'ledger'), subject: { orgId: 'org_local' }, payload: { kind: 'ledger.restarted_empty', evidence: ledgerEvidence } })
      k.warnings.push('ledger database was missing and an empty ledger was started (--accept-new-ledger)')
      if (paperResetDir) k.warnings.push(`the old paper-state.json was moved to ${paperResetDir} and paper accounts restarted from the configured initial balance (--reset-paper-state)`)
    }
    k.runLedgerVerify('auto')
    for (const m of agents.listMandates()) agents.verifyMandate(m.mandateId)
    // 随包参考引擎 gitrader-core：解析得到 engine-core 的打包产物就当成一个 stdio 子进程引擎（builtin 仍写在配置里）；找不到就只登记、不拉起
    engines.load(config.engines.map((e) => (e.builtin && !e.launch ? { ...e, ...(builtinEngineLaunch(e.id) ? { launch: builtinEngineLaunch(e.id)! } : {}) } : e)))
    // fix-r6 R3-04：服务停着时被卸载的插件，这次打开内核就补记 plugin.removed（离线命令也会走到这里）
    if (!replayFixture && k.securityStateHealth().ok) plugins.reconcileRemoved()

    // 连接器事件 → 交易服务 / 事件总线
    bus.onEvent((venue, e) => {
      switch (e.type) {
        case 'fill': trading.onVenueFill(e.accountId, e.fill); break
        case 'orderUpdate': trading.onOrderUpdate(e.accountId, e); break
        case 'position': events.publish('account.positions', { accountId: e.accountId, instrumentId: e.instrumentId, position: e.position }); break
        case 'status': events.publish('venue.status', e.status); break
        case 'quote': events.publish('market.quote', e); break
        case 'book': events.publish('market.book', e.book); break
        case 'candle': events.publish('market.candles', { instrumentId: e.instrumentId, interval: e.interval, candles: [e.candle] }); break
      }
      void venue
    })
    // HALT 哨兵：进入 HALTED → 向所有已连引擎广播 halt，并留痕
    tstate.onHalted = (scope, reason) => {
      // 场所级看门狗：HALTED 立即触发“到点全撤”（范围内的实盘账户）
      const accts = scope.type === 'account' ? [accounts.find(scope.id)].filter((x): x is NonNullable<typeof x> => !!x) : scope.type === 'mandate' ? (agents.getMandate(scope.id)?.accounts ?? []).map((id) => accounts.find(id)).filter((x): x is NonNullable<typeof x> => !!x) : undefined
      void deadman.trip(`HALTED: ${reason}`, { principal: { kind: 'service' }, origin: systemOrigin('halt:deadman', 'risk') }, accts).catch((e) => opts.log?.(`deadman trip failed: ${String(e)}`))
    }
    // GEP 宿主：粘性状态变严（REDUCING / HALTED）→ engine.halt（halt_new / cancel_all）广播给所有已连引擎，ack 与未送达都入账；人面恢复 → engine.resume
    tstate.onTightened = (scope, state, reason) => { if (state !== 'ACTIVE') void gep.halt(scope, state, reason).catch((e) => opts.log?.(`engine.halt failed: ${String(e)}`)) }
    tstate.onResumed = (scope) => { void gep.resume(scope).catch((e) => opts.log?.(`engine.resume failed: ${String(e)}`)) }
    // Agent 心跳超时：授权书降级（agents.tick 已做）+ 按授权书配置的接管
    agents.onHeartbeatTimeout = (m, level) => {
      if (level === 'none') return
      const origin = mkOrigin('system:mandate', 'mandate:heartbeat-timeout', 'internal')
      const ctx: ActorCtx = { principal: { kind: 'service' }, origin }
      void takeover.execute({ level, scope: { type: 'mandate', id: m.mandateId }, reason: 'agent heartbeat timeout' }, ctx).catch((e) => k.log(`heartbeat takeover failed: ${String(e)}`))
    }

    registerCoreOps(k)
    registerApiRoutes(k, k.ops, k.routes)
    // fix-r2 S3：纸面状态与账本的对照（doctor 用；只读）
    k.ops.register('paper.audit', { auth: 'human', kind: 'query' }, () => k.paperAudit())
    // ADR-27：所有 op 分发都从这里经过载保护（HTTP / WS / 测试同一入口）
    const dispatch = k.ops.call.bind(k.ops)
    k.ops.call = (kernel, name, a) => k.guardedDispatch(name, a.params, a.principal, () => dispatch(kernel, name, a))
    k.watchHaltFile()
    return k
  }

  /** 注册连接器（HL / 模拟场所 / 测试用假连接器）。模拟场所注册后为所有纸面 / 影子账户绑定初始资金。 */
  registerConnector(c: VenueConnector, options: ConnectorRegistrationOptions = {}): void {
    const paperCandidate = c as PaperStateConnector
    const paperFile = join(this.home, 'paper-state.json')
    if (c.venue === ConnectorBus.SIM_ID && typeof paperCandidate.createAccount === 'function' && existsSync(paperFile)) {
      const raw = readFileSync(paperFile, 'utf8')
      let state: unknown
      try { state = JSON.parse(raw) } catch { state = undefined }
      const marker = state && typeof state === 'object' ? (state as Record<string, unknown>).gitraderProvenance : undefined
      if (marker && !this.replayFixture) throw new KernelError(makeProblem('INVALID_PARAMS', 'historical paper state cannot be imported by a forward kernel'))
      if (marker) {
        const value = marker as Record<string, unknown>
        const expected = this.replayProvenance()
        if (!expected || value.source !== expected.source || value.fixtureDigest !== expected.fixtureDigest || (value.runId !== undefined && typeof value.runId !== 'string')) {
          throw new KernelError(makeProblem('STATE_FILE_CORRUPT', 'historical paper state fixture identity does not match this home'))
        }
      }
    }
    this.bus.register(c, options)
    if (options.unverified) this.warnings.push(`warning: connector ${c.venue} registered as unverified`)
    // 模拟场所：为纸面 / 影子账户建账（初始资金来自 gitrader.json 的 accounts[].paper）
    const paper = c as PaperStateConnector
    if (c.venue === ConnectorBus.SIM_ID && typeof paper.createAccount === 'function') {
      this.paperUnsubscribe?.()
      this.paperState = undefined
      const file = paperFile
      // fix-r2 S1（ADR-16）：先判定文件可不可信，再导入；判定或导入失败 → 锁存，不导入、不建空账户、不落盘（绝不覆盖原文件）。
      const verdict = judgePaperState(this.db, file, this.paperAccountIds())
      let health = verdict.health
      if (verdict.raw !== undefined) {
        try {
          if (!paper.importState) throw new Error('paper connector cannot restore the saved state')
          paper.importState(verdict.raw)
        } catch (e) {
          const why = e instanceof Error ? e.message : String(e)
          health = { state: 'corrupt', reason: `纸面状态文件内容不合法（${why}）`, reasonEn: `paper state file is invalid (${why})`, dirty: false }
        }
      }
      this.paperHealth = health
      if (health.state === 'corrupt' || health.state === 'missing') this.latchPaperState(health)
      else {
        this.paperState = paper
        for (const a of this.accounts.list()) if (a.mode !== 'live' && a.paper && !paper.hasAccount?.(a.accountId)) paper.createAccount({ accountId: a.accountId, initialBalance: a.paper.initialBalance, ccy: a.paper.ccy })
      }
    }
    if (this.paperState === paper) {
      this.persistPaperState()
      // fix-r2 K1/S1：落盘监听必须排在总线监听（它把成交 / 回执写进内核库）之前，并且每个事件同步落盘：
      // 这样崩在任何一点，磁盘上的纸面状态都不会比内核库旧（只会更新，启动对账按场所回补）。
      // 「父单已成交、子单还在等父单」的半个事务由 importState 补完（K1），所以不再合并落盘。
      this.paperUnsubscribe = paper.onEvent?.((e) => {
        this.recordPaperFunding(e)
        this.persistPaperState()
      })
    }
    for (const a of this.accounts.list()) {
      if ((a.mode === 'live' && a.venue === c.venue) || (a.mode !== 'live' && c.venue === ConnectorBus.SIM_ID)) { try { this.bus.watchAccount(a) } catch (e) { this.log(`cannot watch account ${a.alias}: ${String(e)}`) } }
    }
    if (existsSync(join(this.home, 'HALT'))) this.tripHaltFile()
  }

  /** fix-r2 S1：纸面资金费写账本（账本才能成为纸面状态的完整真源，rebuild-from-ledger 才算得对）。 */
  private recordPaperFunding(e: unknown): void {
    const f = e as { kind?: string; accountId?: string; instrumentId?: string; amount?: string; rate?: string; intervalMs?: number; positionSize?: string; ts?: number } | undefined
    if (f?.kind !== 'funding' || !f.accountId || !f.instrumentId || typeof f.amount !== 'string') return
    try {
      this.ledger.append({ type: 'funding', origin: mkOrigin('venue:kernel-sim', 'venue:funding', 'internal'), subject: { accountId: f.accountId as `acct_${string}`, instrumentId: f.instrumentId },
        payload: { instrumentId: f.instrumentId, amount: f.amount, ...(f.rate ? { rate: f.rate } : {}), ...(f.intervalMs ? { intervalMs: f.intervalMs } : {}), ...(f.positionSize ? { positionSize: f.positionSize } : {}), ...(f.ts ? { venueTs: f.ts } : {}) } })
    } catch (err) { this.log(`paper funding ledger write failed: ${err instanceof Error ? err.message : String(err)}`) }
  }

  private paperAccountIds(): string[] {
    return this.accounts.list().filter((a) => a.mode !== 'live' && !!a.paper).map((a) => a.accountId)
  }

  /** 纸面状态不可信：只停纸面账户（不碰实盘，不触发实盘看门狗），原因写人话；状态锁存到下次启动重新判定。 */
  private latchPaperState(health: PaperStateHealth): void {
    const reason = `纸面状态文件和账本对不上：${health.reason ?? '原因不明'}。原文件和 paper-state.json.prev 都没动，见 gitrader doctor`
    for (const id of this.paperAccountIds()) this.tstate.set({ type: 'account', id }, 'HALTED', reason, systemOrigin('startup:paper-state'))
    this.warnings.push(`paper state file refused: ${health.reasonEn ?? 'unknown reason'}; run gitrader doctor`)
    this.log(`paper state file refused: ${health.reasonEn ?? 'unknown reason'}`)
  }

  /** 纸面状态可信（K2 收敛的前提）：本次启动摘要校验通过或全新建账，且没有锁存损坏。 */
  paperStateTrusted(): boolean {
    return !!this.paperState && (this.paperHealth.state === 'ok' || this.paperHealth.state === 'fresh')
  }

  paperStateHealth(): PaperStateHealth { return { ...this.paperHealth } }

  /** 落盘并处理失败：置 dirty、停纸面账户、1 s 起指数退避自动补写（上限 30 s）；补写成功清 dirty 并入账。 */
  private persistPaperState(): void {
    try {
      this.savePaperState()
    } catch (e) {
      const first = !this.paperHealth.dirty
      this.paperHealth = { ...this.paperHealth, dirty: true }
      if (first) {
        for (const id of this.paperAccountIds()) this.tstate.set({ type: 'account', id }, 'HALTED', 'paper state persistence failed', systemOrigin('paper:save'))
        this.log(`paper state persistence failed; paper trading halted (${e instanceof Error ? e.message : String(e)})`)
      }
      if (!this.paperRetryTimer && !this.stopped) {
        const delay = Math.min(30_000, 1000 * 2 ** this.paperRetryAttempt)
        this.paperRetryAttempt++
        this.paperRetryTimer = setTimeout(() => { this.paperRetryTimer = undefined; this.persistPaperState() }, delay)
        this.paperRetryTimer.unref?.()
      }
      return
    }
    if (this.paperHealth.dirty) {
      this.paperHealth = { ...this.paperHealth, dirty: false }
      this.paperRetryAttempt = 0
      try { this.ledger.append({ type: 'annotation', origin: systemOrigin('paper:save'), subject: { orgId: 'org_local' }, payload: { kind: 'paper.state_persisted' } }) } catch { /* 账本写失败不影响已落盘的状态 */ }
      this.log('paper state persisted after retry')
    }
  }

  /** fix-r2 S3：纸面状态与账本推算对照（已实现盈亏、手续费、各标的净持仓）。差异超容差的账户 ok=false。 */
  paperAudit(): { paperState: PaperStateHealth; accounts: Array<{ accountId: string; alias: string; ok: boolean; cash: { state: string; ledger: string }; diffs: string[] }> } {
    if (!this.paperState?.exportState) return { paperState: this.paperStateHealth(), accounts: [] }
    const parsed = JSON.parse(this.paperState.exportState()) as { accounts?: Array<{ id: string; cash: { $b: string }; realized: { $b: string }; fees: { $b: string }; positions: { $m: Array<[string, { side: string; size: { $b: string } }]> } }> }
    const { expectations } = paperLedgerFacts(this)
    const fxStr = (v: { $b: string } | undefined): string => (v ? fxToDecimalString(BigInt(v.$b)) : '0')
    const near = (a: string, b: string, tol = '0.000001'): boolean => d.lte(d.abs(d.sub(d.D(a), d.D(b))), d.D(tol))
    const accounts = expectations.map((x) => {
      const s = parsed.accounts?.find((a) => a.id === x.accountId)
      const diffs: string[] = []
      if (!s) diffs.push('account missing from the paper state')
      else {
        if (!near(fxStr(s.realized), x.realized)) diffs.push(`realized ${fxStr(s.realized)} vs ledger ${x.realized}`)
        if (!near(fxStr(s.fees), x.fees)) diffs.push(`fees ${fxStr(s.fees)} vs ledger ${x.fees}`)
        const pos = new Map((s.positions?.$m ?? []).map(([id, p]) => [id, p.side === 'short' ? d.str(d.neg(d.D(fxStr(p.size)))) : fxStr(p.size)]))
        for (const id of new Set([...pos.keys(), ...Object.keys(x.netSize)])) if (!near(pos.get(id) ?? '0', x.netSize[id] ?? '0')) diffs.push(`${id} position ${pos.get(id) ?? '0'} vs ledger ${x.netSize[id] ?? '0'}`)
      }
      return { accountId: x.accountId, alias: this.accounts.find(x.accountId)?.alias ?? x.accountId, ok: diffs.length === 0, cash: { state: fxStr(s?.cash), ledger: x.cash }, diffs }
    })
    return { paperState: this.paperStateHealth(), accounts }
  }

  /** 下单回执附带的告警（纸面状态没落盘时内核仍在后台重试）。 */
  persistenceWarnings(): string[] { return this.paperHealth.dirty ? ['state_not_persisted'] : [] }

  private tripHaltFile(): void {
    void this.takeover.kill('HALT file', { principal: { kind: 'service' }, origin: systemOrigin('halt:file') }).catch(() => this.log('HALT file latched; some venue cancellations failed (see ledger)'))
  }

  private watchHaltFile(): void {
    const check = (): void => {
      const present = existsSync(join(this.home, 'HALT'))
      if (present && !this.haltFilePresent) this.tripHaltFile()
      this.haltFilePresent = present
    }
    this.haltWatcher = watch(this.home, { persistent: false }, (_event, file) => { if (file === null || file.toString() === 'HALT') check() })
    check()
  }

  private savePaperState(): void {
    if (!this.paperState?.exportState) return
    let state = this.paperState.exportState()
    if (this.replayFixture) {
      const parsed: unknown = JSON.parse(state)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('paper connector exported an invalid state object')
      state = JSON.stringify({ ...(parsed as Record<string, unknown>), gitraderProvenance: this.replayProvenance() })
    }
    writePaperState(this.db, join(this.home, 'paper-state.json'), state, this.clock.now(), this.ledger.head().seq)
    this.paperSavedAt = this.clock.now()
  }

  private replayProvenance() {
    if (!this.replayFixture) return undefined
    return { source: 'replay' as const, fixtureDigest: digestOf(this.replayFixture) }
  }

  async resetPaper(accountId: string, origin: Origin): Promise<{ ok: true }> {
    const a = this.accounts.get(accountId)
    if (a.mode === 'live' || !a.paper) throw new KernelError(makeProblem('INVALID_PARAMS', 'paper.reset requires a paper or shadow account'))
    if (!this.paperState?.resetAccount) throw new KernelError(makeProblem('CAPABILITY_UNSUPPORTED', 'paper connector does not support reset'))
    await this.paperState.resetAccount({ accountId: a.accountId, initialBalance: a.paper.initialBalance, ccy: a.paper.ccy })
    for (const o of this.orders.list({ accountId: a.accountId, openOnly: true, limit: 1000 })) this.trading.onOrderUpdate(a.accountId, { clientOrderId: o.clientOrderId, venueOrderId: o.venueOrderId ?? '', status: 'cancelled' }, { origin })
    this.savePaperState()
    this.ledger.append({ type: 'annotation', origin, subject: { accountId: a.accountId as `acct_${string}` }, payload: { action: 'paper.reset', initialBalance: a.paper.initialBalance, ccy: a.paper.ccy } })
    return { ok: true }
  }

  /** HALT 哨兵（入口拒绝）：整个内核 HALTED 时，除撤单 / 平仓 / 接管 / 只读外的新动作一律拒绝。 */
  assertNotHalted(what: string): void {
    const eff = this.tstate.effective([ORG_SCOPE])
    if (eff.state === 'HALTED') throw new KernelError(makeProblem('TRADING_STATE', `kernel is HALTED: ${what} refused (only cancel, close and takeover are accepted)`))
  }

  reloadConfig(): void {
    this.config = loadConfig(this.home)
    this.accounts.load(this.config)
    this.engines.load(this.config.engines.map((e) => (e.builtin && !e.launch ? { ...e, ...(builtinEngineLaunch(e.id) ? { launch: builtinEngineLaunch(e.id)! } : {}) } : e)))
  }
  saveConfig(): void { saveConfig(this.home, this.config) }

  // ---- 场所连接（后台、带退避；任何场所不可达都不阻塞工作台与 MCP）----------------------------------
  readonly connections = new Map<string, { state: 'connecting' | 'connected' | 'disconnected'; detail?: string; since: number }>()
  private connectStop = false
  private connectTimers = new Set<ReturnType<typeof setTimeout>>()
  private venueTimer = new Map<string, ReturnType<typeof setTimeout>>()
  private reconnectors = new Map<string, () => void>()

  /** 立刻重连某场所（没有后台连接登记的场所不支持）。 */
  reconnect(venue: string): { venue: string; state: string } {
    const r = this.reconnectors.get(venue)
    if (!r) throw new KernelError(makeProblem('CAPABILITY_UNSUPPORTED', `venue ${venue} has no background connection to retry`))
    r()
    return { venue, state: this.connections.get(venue)?.state ?? 'connecting' }
  }

  private setConnection(venue: string, state: 'connecting' | 'connected' | 'disconnected', detail?: string): void {
    const cur = this.connections.get(venue)
    if (cur && cur.state === state && cur.detail === detail) return
    this.connections.set(venue, { state, ...(detail ? { detail } : {}), since: this.clock.now() })
    this.events.publish('venue.status', { venue, connection: state, ...(detail ? { detail } : {}), ts: this.clock.now() })
  }

  /**
   * 后台连接某场所：立即返回；失败按 1 s → 60 s 退避重试，成功后对该场所的实盘账户做启动对账。
   * 连接期间状态是 connecting / disconnected：纸面、账本、工作台、MCP 照常可用。
   * R2-REL-02：每次 start() 尝试最多等 startTimeoutMs（默认 30 s），超时按失败走同一套退避重试；
   * 尝试进行中「重连」也生效（新一轮作废旧一轮）；行情已通且主标的已知时由 venueTick 把 connecting 提升为 connected，不等 start() 返回。
   * 实盘开仓不看这个状态，看 startupHold()：启动对账没成功就拒。
   */
  connectInBackground(venue: string, start: () => Promise<void>, o: { backoffMinMs?: number; backoffMaxMs?: number; startTimeoutMs?: number } = {}): void {
    let wait = o.backoffMinMs ?? 1000
    const max = o.backoffMaxMs ?? 60_000
    const startTimeoutMs = o.startTimeoutMs ?? 30_000
    this.venueRecord(venue)
    this.setConnection(venue, 'connecting')
    let round = 0
    const attempt = async (manual = false): Promise<void> => {
      if (this.connectStop) return
      const mine = ++round
      // 定时重试时若已被提升为 connected（行情已通、只是 start() 慢）不退回 connecting，免得状态来回跳；人按重连则照旧
      if (manual || this.connections.get(venue)?.state !== 'connected') this.setConnection(venue, 'connecting')
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const started = start()
        started.catch(() => undefined) // 超时之后它才失败，不能变成未处理的拒绝
        await Promise.race([started, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new StartTimeoutError(`start() did not finish within ${startTimeoutMs} ms`)), startTimeoutMs)
          timer.unref?.()
        })])
        if (this.connectStop || mine !== round) return
        const rec = this.venueRecord(venue)
        rec.started = true
        if (manual) rec.ran = false // 手动重连成功：上一轮对账结论作废，离线期间的成交要重新回补；对账完成前实盘开仓继续被拦（只收紧）
        this.setConnection(venue, 'connected')
        void this.venueStarted(venue, manual)
      } catch (e) {
        if (this.connectStop || mine !== round) return
        // start() 慢但行情已通（已被提升为 connected，HL：其余 dex 目录慢）：不降级，下一轮照常重试
        if (!(e instanceof StartTimeoutError && this.connections.get(venue)?.state === 'connected')) this.setConnection(venue, 'disconnected', e instanceof Error ? e.message : String(e))
        const t = setTimeout(() => { this.connectTimers.delete(t); void attempt() }, wait)
        t.unref?.()
        this.connectTimers.add(t)
        this.venueTimer.set(venue, t)
        wait = Math.min(wait * 2, max)
      } finally { clearTimeout(timer) }
    }
    // 状态条网络卡的“重连”按钮：立刻重试一次，退避从头算（上一轮还在跑也一样）
    this.reconnectors.set(venue, () => { clearTimeout(this.venueTimer.get(venue)); wait = o.backoffMinMs ?? 1000; void attempt(true) })
    void attempt()
  }

  private venueRecord(venue: string): VenueReconcileRec {
    let rec = this.venueRec.get(venue)
    if (!rec) { rec = { started: false, running: false, ran: false, retryAt: 0, retryWait: 0 }; this.venueRec.set(venue, rec) }
    return rec
  }

  /**
   * 连接器自报的目录就绪度。没有 readiness() 的连接器：目录里有标的就算主标的已知，start() 返回才算目录完成；读失败一律按未就绪。
   * 没有后台连接登记的场所（模拟场所等）没有 start() 可等，按已启动算。
   */
  private catalogReadiness(venue: string): { primaryInstruments: boolean; catalogComplete: boolean; hooked: boolean } {
    const connector = this.bus.list().find((c) => c.venue === venue)
    const started = !this.connections.has(venue) || this.venueRec.get(venue)?.started === true
    try {
      const hook = (connector as { readiness?: () => { primaryInstruments: boolean; catalogComplete: boolean } } | undefined)?.readiness
      if (typeof hook === 'function') { const r = hook.call(connector); return { primaryInstruments: r.primaryInstruments === true, catalogComplete: r.catalogComplete === true, hooked: true } }
      return { primaryInstruments: started || (connector?.listInstruments().length ?? 0) > 0, catalogComplete: started, hooked: false }
    } catch { return { primaryInstruments: false, catalogComplete: false, hooked: false } }
  }

  /** 该场所所有活跃实盘账户的启动对账都成功过（没有实盘账户 = 真）。 */
  private liveReconciled(venue: string): boolean {
    return this.accounts.list().every((a) => a.status !== 'active' || a.venue !== venue || a.mode !== 'live' || this.reconcileOk.get(a.accountId) === true)
  }

  /**
   * 启动对账是否完成：主标的已知，且该场所跑过一轮对账，且（有实盘账户 → 实盘账户都对账成功；没有 → 纸面账户都对账成功）。
   * 不早于 primaryInstruments 是按构造保证的。实盘开仓闸门（startupHold）和 status / venue_status 用同一个答案。
   */
  private venueStartupReconciled(venue: string, primary: boolean): boolean {
    if (!primary || this.venueRec.get(venue)?.ran !== true) return false
    const active = this.accounts.list().filter((a) => a.status === 'active' && a.venue === venue)
    const live = active.filter((a) => a.mode === 'live')
    return (live.length > 0 ? live : active).every((a) => this.reconcileOk.get(a.accountId) === true)
  }

  /**
   * 某场所的连接状态与就绪度：status.connections[]、market.venue_status、ops venue.status 共用这一处，口径一致。
   * state 以后台连接结果为底（含 venueTick 的提升），连上之后再按连接器自己的实时状态细化（WS 掉线 → disconnected / connecting）；
   * start() 失败后的 disconnected 不读连接器；读不到连接器状态时退回后台结果。没有后台连接登记的场所（模拟场所等）一律 connected，只补就绪度。
   * readiness 逐项取事实，catalogComplete 可以晚到，不影响 state。
   */
  venueConnection(venue: string): VenueConnection {
    const c = this.connections.get(venue)
    let status: ReturnType<ConnectorBus['readStatus']>
    if (c?.state !== 'disconnected') { try { status = this.bus.readStatus(venue) } catch { /* 读不到就用后台结果 */ } }
    const cat = this.catalogReadiness(venue)
    let state: ConnState = c?.state ?? 'connected'
    if ((c === undefined || c.state === 'connected') && status) state = status.wsState === 'connected' ? 'connected' : status.wsState === 'connecting' ? 'connecting' : 'disconnected'
    return {
      venue, state, ...(c?.detail ? { detail: c.detail } : {}), ...(status ? { stale: status.stale } : {}), since: c?.since ?? 0,
      readiness: { marketLive: status?.wsState === 'connected', primaryInstruments: cat.primaryInstruments, catalogComplete: cat.catalogComplete, startupReconciled: this.venueStartupReconciled(venue, cat.primaryInstruments) },
    }
  }

  /** 每个场所的连接状态（含就绪度）。 */
  connectionStatus(): VenueConnection[] { return [...this.connections.keys()].map((venue) => this.venueConnection(venue)) }

  /** 有后台连接登记的场所：主标的是否已知（策略实例恢复用，不读连接器行情状态）。 */
  venuePrimaryReady(venue: string): boolean { return this.connections.has(venue) && this.catalogReadiness(venue).primaryInstruments }

  /** start() 成功：还没对账过（或实盘账户对账没成功）就对账一次；主标的就绪时已经对过且成功的不重复。 */
  private async venueStarted(venue: string, manual = false): Promise<void> {
    if (!manual && this.venueRecord(venue).ran && this.liveReconciled(venue)) return
    await this.venueReconcile(venue, manual)
  }

  /** 对该场所的实盘账户做启动对账。没成功就按 15 s 起翻倍、封顶 5 分钟的间隔由 venueTick 重试（失败只意味着实盘开仓继续被拒）。 */
  private async venueReconcile(venue: string, force = false): Promise<void> {
    const rec = this.venueRecord(venue)
    if (this.connectStop) return
    if (rec.running) { if (force) rec.redo = true; return } // 手动重连时上一轮对账还在跑：它跑完后立刻再对一轮
    rec.running = true
    try {
      do {
        rec.redo = false
        try { await this.startupReconcile(10_000, venue) } catch (e) { this.log(`reconcile failed: ${String(e)}`) }
      } while (rec.redo && !this.connectStop)
    } finally { rec.running = false }
    rec.ran = true
    if (this.liveReconciled(venue)) rec.retryWait = 0
    else { rec.retryWait = Math.min(Math.max(rec.retryWait * 2, 15_000), 300_000); rec.retryAt = this.clock.now() + rec.retryWait }
  }

  /**
   * 每秒一次：① 行情可用（WS 已连）且主标的已知的 connecting 提升为 connected，不等 start() 返回（start() 失败时仍照常降为 disconnected）；
   * ② 主标的一就绪就启动对账，对账没成功的按退避重试。没有 readiness() 的连接器仍等 start() 返回才对账。（测试里直接调）
   */
  venueTick(): void {
    const now = this.clock.now()
    for (const venue of [...this.connections.keys()]) {
      if (this.connectStop) return
      const state = this.connections.get(venue)!.state
      if (state === 'disconnected') continue
      const cat = this.catalogReadiness(venue)
      if (state === 'connecting' && cat.primaryInstruments) {
        let live = false
        try { live = this.bus.readStatus(venue)?.wsState === 'connected' } catch { /* 读不到就不提升 */ }
        if (live) this.setConnection(venue, 'connected')
      }
      const rec = this.venueRecord(venue)
      if ((cat.hooked ? cat.primaryInstruments : rec.started) && !rec.running && (!rec.ran || !this.liveReconciled(venue)) && now >= rec.retryAt) void this.venueReconcile(venue)
    }
  }

  /**
   * 实盘开仓闸门（只许收紧）：实盘账户所在场所有后台连接登记、且启动对账还没完成 → 返回原因，交易闸门按 REDUCING 看待
   * （开仓被拒，规则码 TRADING_STATE；减仓 / 平仓 / 撤单照常）。对账失败或未决一直拒，直到某次对账成功。纸面 / 影子账户和没有后台连接登记的场所不受影响。
   */
  startupHold(accountId: string): string | undefined {
    const a = this.accounts.find(accountId)
    if (!a || a.mode !== 'live' || !this.connections.has(a.venue)) return undefined
    return this.venueStartupReconciled(a.venue, this.catalogReadiness(a.venue).primaryInstruments) ? undefined : 'startup reconcile pending'
  }

  /** 启动对账：纸面与实盘都核对未结订单并回补成交。超时保持 HALTED 等人处理。 */
  async startupReconcile(timeoutMs = 10_000, onlyVenue?: string, skipManaged = false): Promise<{ account: string; ok: boolean; detail?: string }[]> {
    const out: { account: string; ok: boolean; detail?: string }[] = []
    const selectedAccounts = this.accounts.list().filter((x) => x.status === 'active' && (!onlyVenue || (x.mode === 'live' ? x.venue : ConnectorBus.SIM_ID) === onlyVenue) && !(skipManaged && x.mode === 'live' && this.connections.has(x.venue)))
    for (const account of selectedAccounts) this.startupReconcileAccounts.set(account.accountId, (this.startupReconcileAccounts.get(account.accountId) ?? 0) + 1)
    const released = new Set<string>()
    const releaseStartupAccount = (accountId: string): void => {
      if (released.has(accountId)) return
      released.add(accountId)
      const remaining = Math.max(0, (this.startupReconcileAccounts.get(accountId) ?? 1) - 1)
      if (remaining === 0) {
        this.startupReconcileAccounts.delete(accountId)
      } else this.startupReconcileAccounts.set(accountId, remaining)
    }
    try {
    for (const a of selectedAccounts) {
      try {
      const origin = systemOrigin('startup:reconcile')
      const subject = { accountId: a.accountId as `acct_${string}` }
      if (!this.bus.get(a.mode === 'live' ? a.venue : ConnectorBus.SIM_ID)) { out.push({ account: a.accountId, ok: false, detail: `no connector for ${a.venue}` }); continue }
      const pollStartup = a.mode === 'live' && this.bus.registrationOptions(a.venue).pollOrders === true
      const signal = this.livePollAbort.signal
      try {
        const venue = await this.bus.reconcile(a, timeoutMs)
        if (pollStartup && signal.aborted) return out
        if (venue.account.stale === true || venue.truncated === true) {
          throw new ReconcileSnapshotError(makeProblem('VENUE_OUTCOME_UNKNOWN', 'startup snapshot did not become fresh and complete', { venue: { id: a.venue, message: 'startup snapshot was not fresh and complete' } }), { stale: venue.account.stale === true, truncated: venue.truncated === true })
        }
        const terminalAmends = this.trading.pendingTerminalAmends(a.accountId)
        const terminalUnresolved: string[] = []
        for (const candidate of terminalAmends) {
          if (signal.aborted) return out
          const { order } = candidate
          const targetId = candidate.replacementVenueOrderId ?? order.venueOrderId ?? undefined
          let q: Awaited<ReturnType<ConnectorBus['lookup']>> = null
          try {
            q = await this.bus.lookup(a, order.clientOrderId, {
              instrumentId: order.instrumentId,
              ...(targetId ? { venueOrderId: targetId } : {}),
              signal,
            })
          } catch {
            // A pending reservation remains held until this amendment has conclusive identity evidence.
          }
          if (signal.aborted) return out
          const hasReplacement = !!candidate.replacementVenueOrderId && candidate.replacementVenueOrderId === order.venueOrderId
          const identityMatches = !!q && (!q.venueOrderId || q.venueOrderId === targetId)
          const terminalCancel = !!q && ['cancelled', 'expired', 'rejected'].includes(q.status)
          const fullyFilled = !!q && q.status === 'filled' && d.cmp(d.D(order.filledSize), d.D(candidate.reservationSize)) >= 0
          if (hasReplacement && targetId && q && identityMatches && (terminalCancel || fullyFilled)) {
            this.trading.onOrderUpdate(a.accountId, { venueOrderId: targetId, clientOrderId: order.clientOrderId, status: q.status })
          } else terminalUnresolved.push(order.clientOrderId)
        }
        if (pollStartup) {
          const pollNow = this.clock.now()
          const sinceMs = pollNow - 24 * 60 * 60 * 1000
          const localOrders = this.orders.forPolling(a.accountId, sinceMs)
          const venueCloids = new Set(venue.openOrders.map((o) => o.clientOrderId).filter((x): x is string => !!x))
          const venueIds = new Set(venue.openOrders.map((o) => o.venueOrderId))
          const unresolved: string[] = [...new Set(terminalUnresolved)]
          const openStatuses = new Set(['new', 'submitted', 'open', 'untriggered', 'partially_filled'])
          for (const o of localOrders) {
            if (signal.aborted) return out
            if (!openStatuses.has(o.status)) continue
            if (this.trading.isUnlinkedChild(o.orderId)) {
              const linked = venue.openOrders.find((row) => row.clientOrderId === o.clientOrderId && !!row.venueOrderId)
              if (linked) this.trading.onOrderUpdate(a.accountId, { venueOrderId: linked.venueOrderId, clientOrderId: o.clientOrderId, status: o.status })
              if (this.trading.isUnlinkedChild(o.orderId)) continue
            }
            if (venueCloids.has(o.clientOrderId) || (o.venueOrderId && venueIds.has(o.venueOrderId))) continue
            if (signal.aborted) return out
            const q = await this.bus.lookup(a, o.clientOrderId, { instrumentId: o.instrumentId, ...(o.venueOrderId ? { venueOrderId: o.venueOrderId } : {}), signal })
            if (signal.aborted) return out
            if (q) this.trading.onOrderUpdate(a.accountId, { venueOrderId: q.venueOrderId ?? o.venueOrderId ?? '', clientOrderId: o.clientOrderId, status: q.status })
            else unresolved.push(o.clientOrderId)
          }
          let backfilledFills = venue.fills.length
          for (const f of venue.fills) {
            if (signal.aborted) return out
            this.trading.onVenueFill(a.accountId, f)
          }
          const instruments = [...new Set(localOrders.map((order) => order.instrumentId))]
          for (const instrumentId of instruments) {
            if (signal.aborted) return out
            const fills = await this.bus.pollFills(a, sinceMs, { instrumentId, signal })
            if (signal.aborted) return out
            backfilledFills += fills.length
            for (const fill of fills) {
              if (signal.aborted) return out
              this.trading.onVenueFill(a.accountId, fill)
            }
          }
          if (signal.aborted) return out
          await this.protectAccount(a, { positions: venue.account.positions, openOrders: venue.openOrders })
          const ok = unresolved.length === 0
          const currentOrders = this.orders.forPolling(a.accountId, sinceMs)
          const unlinkedChildren = currentOrders.filter((order) => openStatuses.has(order.status) && this.trading.isUnlinkedChild(order.orderId)).length
          this.ledger.append({ type: 'startup.reconciled', origin, subject, payload: { ok, venueOpenOrders: venue.openOrders.length, positions: venue.account.positions.length, backfilledFills, unresolved, unlinkedChildren } })
          if (!ok) this.tstate.set({ type: 'account', id: a.accountId }, 'HALTED', `startup reconcile: ${unresolved.length} local open orders unknown at venue`, origin)
          out.push({ account: a.accountId, ok, ...(ok ? {} : { detail: `${unresolved.length} unresolved orders` }) })
          continue
        }
        const venueCloids = new Set(venue.openOrders.map((o) => o.clientOrderId).filter((x): x is string => !!x))
        const venueIds = new Set(venue.openOrders.map((o) => o.venueOrderId))
        const unresolved: string[] = [...new Set(terminalUnresolved)]
        for (const o of this.orders.list({ accountId: a.accountId, openOnly: true })) {
          if (this.trading.isUnlinkedChild(o.orderId)) {
            const linked = venue.openOrders.find((row) => row.clientOrderId === o.clientOrderId && !!row.venueOrderId)
            if (linked) this.trading.onOrderUpdate(a.accountId, { venueOrderId: linked.venueOrderId, clientOrderId: o.clientOrderId, status: o.status })
            if (this.trading.isUnlinkedChild(o.orderId)) continue
          }
          if (venueCloids.has(o.clientOrderId) || (o.venueOrderId && venueIds.has(o.venueOrderId))) continue
          const q = await this.bus.lookup(a, o.clientOrderId, { instrumentId: o.instrumentId, ...(o.venueOrderId ? { venueOrderId: o.venueOrderId } : {}) }) // 本地以为在挂、场所没看到 → 先查再动
          if (q) this.trading.onOrderUpdate(a.accountId, { venueOrderId: q.venueOrderId ?? o.venueOrderId ?? '', clientOrderId: o.clientOrderId, status: q.status })
          // fix-r2 K2（ADR-15）：纸面、状态可信、本地没有场所单号、场所查无且成交里也没有 → 确定没发出，收敛为终态，不再 HALTED
          else if (this.trading.neverReachedCandidate(a, o) && !venue.fills.some((f) => f.clientOrderId === o.clientOrderId)) this.trading.convergeNeverReached(o, 'recovery', origin)
          else unresolved.push(o.clientOrderId)
        }
        for (const f of venue.fills) this.trading.onVenueFill(a.accountId, f) // 回补离线期间的成交（按 venueFillId 去重）
        await this.protectAccount(a, { positions: venue.account.positions, openOrders: venue.openOrders })
        this.paperReconcileRetry.delete(a.accountId)
        const ok = unresolved.length === 0
        const unlinkedChildren = this.orders.list({ accountId: a.accountId, openOnly: true }).filter((order) => this.trading.isUnlinkedChild(order.orderId)).length
        this.ledger.append({ type: 'startup.reconciled', origin, subject, payload: { ok, venueOpenOrders: venue.openOrders.length, positions: venue.account.positions.length, backfilledFills: venue.fills.length, unresolved, unlinkedChildren } })
        if (!ok) this.tstate.set({ type: 'account', id: a.accountId }, 'HALTED', `startup reconcile: ${unresolved.length} local open orders unknown at venue`, origin)
        out.push({ account: a.accountId, ok, ...(ok ? {} : { detail: `${unresolved.length} unresolved orders` }) })
      } catch (e) {
        if (pollStartup && signal.aborted) return out
        const detail = e instanceof Error ? e.message : String(e)
        // fix-r2 K2：纸面场所的行情要等真实行情源连上才新鲜；刚启动就对账超时 / 快照陈旧不是「状态不明」，稍后重试（120 s 仍不行才 HALTED）
        const problemName = e instanceof KernelError ? e.problem.name : e instanceof ConnectorOperationError ? (e as { problem?: { name?: string } }).problem?.name : undefined
        const firstFailedAt = this.paperReconcileRetry.get(a.accountId)?.firstAt ?? this.clock.now()
        const deferPaper = a.mode !== 'live' && problemName === 'VENUE_OUTCOME_UNKNOWN' && this.clock.now() - firstFailedAt < 120_000
        this.ledger.append({ type: 'startup.reconciled', origin, subject, payload: { ok: false, ...(e instanceof ReconcileSnapshotError && e.last ? { stale: e.last.stale, truncated: e.last.truncated } : {}), error: detail, ...(deferPaper ? { retry: true } : {}), ...(e instanceof KernelError ? { problem: e.problem } : {}), ...(e instanceof ConnectorOperationError ? { errorStages: e.stages } : {}) } })
        if (deferPaper) this.paperReconcileRetry.set(a.accountId, { firstAt: firstFailedAt, lastAt: this.clock.now() })
        else { this.paperReconcileRetry.delete(a.accountId); this.tstate.set({ type: 'account', id: a.accountId }, 'HALTED', `startup reconcile failed: ${detail}`, origin) }
        out.push({ account: a.accountId, ok: false, detail })
      }
      } finally { releaseStartupAccount(a.accountId) }
    }
    } finally { for (const account of selectedAccounts) releaseStartupAccount(account.accountId) }
    for (const r of out) this.reconcileOk.set(r.account, r.ok) // 就绪度与实盘开仓闸门：失败 / 不明都记 false
    // fix-r2 K3：对账之后收敛被崩溃打断的提案（本进程正在执行的不碰）
    try { await this.trading.recoverInterruptedProposals() } catch (e) { this.log(`proposal recovery failed: ${e instanceof Error ? e.message : String(e)}`) }
    return out
  }

  /** fix-r2 K1：领养 + 保护审计；瞬时失败记下来，tickOnce 每 10 s 重试，120 s 仍失败按失败处理（REDUCING）。审计本身出错只记日志，不影响对账结论。 */
  private async protectAccount(a: Account, view: ProtectionView, final = false): Promise<void> {
    try {
      const r = await reconcileProtection(this, a, view, { final })
      if (r.retry.length > 0) { if (!this.protectionRetry.has(a.accountId)) this.protectionRetry.set(a.accountId, { firstAt: this.clock.now(), lastAt: this.clock.now() }) }
      else this.protectionRetry.delete(a.accountId)
    } catch (e) {
      this.log(`protection audit failed for ${a.alias}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  private async retryProtection(): Promise<void> {
    const now = this.clock.now()
    for (const [accountId, r] of [...this.protectionRetry]) {
      if (now - r.lastAt < 10_000) continue
      r.lastAt = now
      const a = this.accounts.find(accountId)
      if (!a) { this.protectionRetry.delete(accountId); continue }
      const snapshot = await this.bus.snapshot(a, { maxAgeMs: 1000 })
      await this.protectAccount(a, { positions: snapshot.positions, openOrders: snapshot.openOrders }, now - r.firstAt >= 120_000)
    }
  }

  /** 一次定时任务（测试里直接调）。 */
  async tickOnce(): Promise<void> {
    const step = async (name: string, f: () => unknown): Promise<void> => { try { await f() } catch (e) { this.log(`tick ${name} failed: ${e instanceof Error ? e.message : String(e)}`) } }
    await step('trading-state', () => this.tstate.tick())
    await step('risk', () => this.risk.tick())
    await step('agents', () => this.agents.tick())
    await step('proposals', () => this.trading.tick())
    await step('engines', () => this.engines.tick())
    await step('gep', () => this.gep.tick())
    if (!this.replayFixture) await step('lab', () => this.lab.forwardStats.tick())
    await step('deadman', () => this.deadman.tick())
    if (this.protectionRetry.size > 0) await step('protection-retry', () => this.retryProtection())
    if (this.paperReconcileRetry.size > 0 && [...this.paperReconcileRetry.values()].every((r) => this.clock.now() - r.lastAt >= 5_000)) await step('paper-reconcile-retry', () => this.startupReconcile(10_000, ConnectorBus.SIM_ID))
    await step('rate-audit', () => this.operationRateAudit.flush())
    if (!this.replayFixture && !this.livePollRun) {
      this.livePollRun = this.pollLiveOrders()
        .catch(() => this.log('tick live-poll failed'))
        .finally(() => { this.livePollRun = undefined })
    }
    if (this.livePollAbort.signal.aborted) return
    const accountPush = step('account-push', () => Promise.all(this.accounts.list().filter((a) => a.status === 'active').map(async (a) => {
      try {
        const maxAgeMs = a.mode === 'live' && this.bus.registrationOptions(a.venue).pollOrders === true ? 5000 : 1000
        const snapshot = await this.bus.snapshot(a, { maxAgeMs })
        const observedAt = this.clock.now()
        try { sampleEquity(this.docs, a.accountId, observedAt, snapshot) }
        catch { this.log('tick equity-sample failed') }
        this.events.publish('account.summary', { accountId: a.accountId, ts: snapshot.ts, equity: snapshot.equity, available: snapshot.available, positions: snapshot.positions.length, openOrders: snapshot.openOrders.length, dayStartEquity: this.trading.dayBaseline(a, snapshot.equity) })
        this.events.publish('account.positions', { accountId: a.accountId, ts: snapshot.ts, positions: snapshot.positions })
      } catch { /* 单个离线账户不阻止其他账户推送。 */ }
    })))
    if (!this.replayFixture && !this.livePollAbort.signal.aborted) void this.reconcileService.tick().catch(() => this.log('reconciliation scan failed'))
    await accountPush
    if (this.clock.now() - this.paperSavedAt >= 60_000) await step('paper-save', () => this.persistPaperState())
    // ponytail: 后台每 10 分钟同步全量验一次链（1 万条量级是百毫秒内）；账本大到卡事件循环时再改成分片。
    if (!this.ledgerVerify || this.clock.now() - this.ledgerVerify.at >= 600_000) await step('ledger-verify', () => this.runLedgerVerify('full'))
  }

  private async pollLiveOrders(): Promise<void> {
    const signal = this.livePollAbort.signal
    if (signal.aborted) return
    const openStatuses = new Set<OrderStatus>(['new', 'submitted', 'open', 'untriggered', 'partially_filled'])
    const accounts = this.accounts.list().filter((a) => a.status === 'active' && a.mode === 'live' && this.bus.registrationOptions(a.venue).pollOrders === true)
    for (const account of accounts) {
      if (signal.aborted) return
      if (this.livePollInFlight.has(account.accountId)) continue
      const accountNow = this.clock.now()
      const lastStarted = this.livePollLastStarted.get(account.accountId)
      if (lastStarted !== undefined && accountNow - lastStarted < 5000) continue
      this.livePollLastStarted.set(account.accountId, accountNow)
      this.livePollInFlight.add(account.accountId)
      try {
        const orders: Order[] = this.orders.forPolling(account.accountId, accountNow - 24 * 60 * 60 * 1000)
        if (orders.length === 0 || signal.aborted) continue

        for (const order of orders) {
          if (signal.aborted) return
          if (!openStatuses.has(order.status as OrderStatus)) continue
          try {
            const result = await this.bus.lookup(account, order.clientOrderId, {
              instrumentId: order.instrumentId,
              ...(order.venueOrderId ? { venueOrderId: order.venueOrderId } : {}),
              signal,
            })
            if (signal.aborted) return
            if (result) this.trading.onOrderUpdate(account.accountId, {
              venueOrderId: result.venueOrderId ?? order.venueOrderId ?? '',
              clientOrderId: order.clientOrderId,
              status: result.status,
            })
          } catch {
            this.log(`live poll lookup failed account=${account.alias} instrument=${order.instrumentId}`)
          }
        }

        const instruments = [...new Set(orders.map((order) => order.instrumentId))]
        for (const instrumentId of instruments) {
          if (signal.aborted) return
          const cursorKey = `${account.accountId}\u0000${instrumentId}`
          const cursor = this.liveFillCursors.get(cursorKey)
          const requestNow = this.clock.now()
          const sinceMs = Math.max(requestNow - 24 * 60 * 60 * 1000, cursor === undefined ? Number.MIN_SAFE_INTEGER : cursor - 1000)
          try {
            const fills = await this.bus.pollFills(account, sinceMs, { instrumentId, signal })
            if (signal.aborted) return
            const responseNow = this.clock.now()
            let maxTs: number | undefined
            for (const fill of fills) {
              if (Number.isSafeInteger(fill.ts) && fill.ts >= 0 && fill.ts <= responseNow) maxTs = Math.max(maxTs ?? fill.ts, fill.ts)
            }
            if (maxTs !== undefined) this.liveFillCursors.set(cursorKey, Math.max(cursor ?? Number.MIN_SAFE_INTEGER, maxTs))
          } catch {
            this.log(`live poll fills failed account=${account.alias} instrument=${instrumentId}`)
          }
        }
      } finally {
        this.livePollInFlight.delete(account.accountId)
      }
    }
  }

  /** 起服务：定时器、对账、引擎、HTTP+WS（127.0.0.1，默认从 47900 起探测）。 */
  async start(o: { port?: number; host?: string; staticDir?: string; builtinEngine?: boolean } = {}): Promise<{ port: number; bootToken: string }> {
    const healthyState = this.securityStateHealth().ok
    if (healthyState) this.reconcileService.initialize()
    if (healthyState && !this.replayFixture) await this.plugins.reload()
    // 启动对账放后台，且不碰还在“连接中 / 断开”的场所（它们连上后自己对账）：任何场所不可达都不阻塞监听。
    if (healthyState && !this.replayFixture) void this.startupReconcile(10_000, undefined, true).catch((e) => this.log(`reconcile failed: ${String(e)}`))
    if (healthyState && !this.replayFixture && this.opts.timers !== false) {
      this.timer = setInterval(() => { if (this.ticking) return; this.ticking = true; void this.tickOnce().finally(() => { this.ticking = false }) }, 1000)
      this.timer.unref?.()
    }
    if (this.opts.timers !== false) {
      this.overloadTimer = setInterval(() => this.overload.tick(), 1000)
      this.overloadTimer.unref?.()
      // 场所连接状态提升与启动对账：独立于 tickOnce，慢的那一步不拖它
      this.venueTickTimer = setInterval(() => { try { this.venueTick() } catch (e) { this.log(`venue tick failed: ${String(e)}`) } }, 1000)
      this.venueTickTimer.unref?.()
    }
    if (healthyState && !this.replayFixture) this.engines.startAll({ builtin: o.builtinEngine === true })
    this.http = await startHttp(this, { ...(o.port !== undefined || this.config.server.port ? { port: o.port ?? this.config.server.port! } : {}), ...(o.host !== undefined ? { host: o.host } : {}), ...(o.staticDir ? { staticDir: o.staticDir } : {}) })
    const w = this.auth.writeServiceFile({ port: this.http.port, pid: process.pid, startedAt: this.startedAt, version: KERNEL_VERSION })
    if (!w.tightened) this.warnings.push('could not tighten permissions on service.json (token file); other local users may be able to read it')
    return { port: this.http.port, bootToken: this.auth.mintBootToken() }
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    this.livePollAbort.abort()
    this.connectStop = true
    for (const t of this.connectTimers) clearTimeout(t)
    clearInterval(this.timer)
    clearInterval(this.overloadTimer)
    clearInterval(this.venueTickTimer)
    this.overload.close()
    clearTimeout(this.paperRetryTimer)
    let failure: unknown
    const attempt = async (action: () => void | Promise<void>): Promise<void> => {
      try { await action() } catch (error) { failure ??= error }
    }
    await attempt(() => this.reconcileService.stop())
    await attempt(() => this.notify.stop())
    await attempt(() => this.replayController?.cancelForShutdown())
    await attempt(() => this.http?.close())
    await attempt(() => this.plugins.stopAll())
    await attempt(() => this.engines.stopAll(1000))
    await attempt(() => this.bus.close())
    await attempt(() => this.savePaperState())
    await attempt(() => this.operationRateAudit.flush(true))
    await attempt(() => this.trading.flushPrecheckSummaries(true))
    await attempt(() => this.haltWatcher?.close())
    await attempt(() => this.gep.close())
    this.paperUnsubscribe?.()
    this.unsubStore?.()
    this.keystore.lock()
    await attempt(() => this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'))
    await attempt(() => this.db.close())
    this.stopped = true
    if (failure !== undefined) throw failure
  }
  /** 作用域状态清单（status 与 risk.state 共用）。账户级状态若指向已不在配置里的账户，不再展示；
   *  状态本身仍留在库里：同 id 的账户日后加回来仍是停止（fail-closed），只是不拿一个已不存在的账户吓唬人。 */
  tstateList(): ReturnType<TradingStateService['list']> {
    const l = this.tstate.list()
    const known = (s: { scope: TradingScope }): boolean => s.scope.type !== 'account' || !!this.accounts.find(s.scope.id)
    return { sticky: l.sticky.filter(known), pauses: l.pauses.filter(known) }
  }
  /** fix-r4 C7：所有非 ACTIVE 的作用域（org / account / mandate / instrument / group，含未到期的保护器暂停）；tradingState 的语义不变。 */
  private scopedStates(): { scope: TradingScope; state: TradingState; reason?: string; since?: number }[] {
    const l = this.tstateList()
    return [
      ...l.sticky.map((s) => ({ scope: s.scope, state: s.state, reason: s.reason, since: s.since })),
      ...l.pauses.map((p) => ({ scope: p.scope, state: 'REDUCING' as TradingState, reason: p.reason, since: p.since })),
    ]
  }
  /** 状态概览（CLI status / 状态条）。不含任何密钥。 */
  status(): Record<string, unknown> {
    const stateHealth = this.securityStateHealth()
    const eff = this.tstate.effective([ORG_SCOPE, ...this.accounts.list().map((a) => ({ type: 'account' as const, id: a.accountId }))])
    const pol = this.risk.current()
    return {
      name: 'gitrader', version: KERNEL_VERSION, launcher: this.launcher, agentTrouble: this.agentTroubleSnapshot(), pid: process.pid, startedAt: this.startedAt, uptimeMs: this.auth.now() - this.startedAt,
      ...(this.replayFixture ? { paperReplay: this.replayStatus() } : {}),
      reconciliation: this.reconcileService.get(),
      home: this.home, port: this.http?.port ?? null,
      tradingState: eff.state, stateReasons: eff.reasons,
      scopedStates: this.scopedStates(),
      policy: pol ? { policyId: pol.policyId, version: pol.version, denyLlmLiveEntries: pol.denyLlmLiveEntries !== false, temporaryRelax: pol.temporaryRelax ?? null } : null,
      policyIntegrity: this.risk.integrity,
      ledger: { ...this.ledger.head(), count: this.ledger.count() },
      pinSet: !stateHealth.ok || stateHealth.files.find((file) => file.kind === 'pin')?.state !== 'missing',
      keystoreUnlocked: stateHealth.ok && this.keystore.isUnlocked(), liveAvailable: stateHealth.ok,
      stateFiles: [...stateHealth.files, ...this.paperFileStatus()],
      ledgerVerify: this.ledgerVerify ?? null, paperState: this.paperStateHealth(),
      accounts: this.accounts.list().map((a) => ({ accountId: a.accountId, alias: a.alias, venue: a.venue, environment: a.environment, mode: a.mode, status: a.status })),
      connectors: this.bus.list().map((c) => ({ id: c.venue, status: this.bus.readStatus(c.venue) })),
      connections: this.connectionStatus(),
      engines: this.engines.status().map((e) => ({ ...e, gep: this.gep.status().find((g) => g.engineId === e.id) ?? null })),
      plugins: this.plugins.list().map((p) => ({ id: p.id, version: p.version, ok: p.ok, state: p.state })),
      warnings: [...new Set([...this.warnings, ...looseTokenFiles.map(p => `could not tighten permissions on token file ${p}; other local users may be able to read it`), ...(stateHealth.ok ? [] : ['security state file is corrupt']), ...this.integrityWarnings(), ...this.gep.restartWarnings()])],
    }
  }
}

export { ConnectorBus }
