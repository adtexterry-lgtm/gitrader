// SPDX-License-Identifier: CPAL-1.0
// 本地 API 鉴权与在场证明（契约 §5.1 T-A / T-B）。
//
// 原则（Demo `main.mjs:85-89` 的教训）：**没有令牌就是没有身份**。`Origin` / `Sec-Fetch-Site` / `Host` 只能用来
// *额外拒绝*（跨站、DNS 重绑定），永远不能用来*放行*——非浏览器进程可以随便伪造这些头。
//
// 三种主体：
//   session  工作台界面的会话令牌（ses_…）。只在内存；由一次性引导令牌（boot_…）换取；重启即失效。
//   service  service.json 里的令牌（svc_…）。CLI / 本机工具用；只读与"PIN 在场"的动作；不能当"会话"用。
//   agent    Agent 钥匙令牌（gtk_…）。由 AgentService 验证；只代表授权书范围内的能力，永远拿不到人面专属动作。
// 人面专属动作需要 HumanProof：'session'（会话主体）或 'pin'（会话 / service 主体 + 正确 PIN）。
// HumanProof 只能由本模块签发（私有构造令牌），Agent 路由里没有任何办法造出一个。
import { createHash } from 'node:crypto'
import { makeProblem } from './proto'
import type { Origin, OriginVia } from './proto'
import { KernelError } from './util/errors'
import { randomToken, safeEqual, sha256Hex } from './util/hash'
import { writeSecretFile } from './util/fsperm'
import { mkOrigin } from './util/origin'
import type { Clock } from './util/clock'
import type { PinStore } from './pin'

export type Principal =
  | { kind: 'session'; sessionId: string; userId: 'usr_local'; since: number; expiresAt: number }
  | { kind: 'service' }
  | { kind: 'agent'; keyId: string; mandateId: string }
  /** 内核 GEP 宿主代引擎下单时用的主体（只在进程内构造，令牌认证不会产生它）：origin = engine:<id> / actorType engine / via gep。 */
  | { kind: 'engine'; engineId: string; mandateId: string }

export type Presence = 'session' | 'pin'

const MINT = Symbol('mint-human-proof')
/** 人面在场证明。只有 AuthService 能造；服务层方法用 `assertProof` 检查。 */
export class HumanProof {
  constructor(token: symbol, readonly presence: Presence, readonly userId: 'usr_local', readonly via: OriginVia, readonly at: number, readonly masterKey?: Buffer) {
    if (token !== MINT) throw new TypeError('HumanProof can only be issued by AuthService')
  }
}

const authFailed = (message: string, extra: { retryAfterMs?: number } = {}): KernelError =>
  new KernelError(makeProblem('AUTH_FAILED', message, extra))
/** 1010 ATTESTATION_REQUIRED：人面动作缺在场证明；壳弹出 PIN 层后带 attestation 重发一次。 */
export const attestationRequired = (message = 'a presence proof (PIN) is required for this action'): KernelError =>
  new KernelError(makeProblem('ATTESTATION_REQUIRED', message))

/** 服务层调用：要求至少 need 级别的在场证明。 */
export function assertProof(proof: unknown, need: Presence): HumanProof {
  if (!(proof instanceof HumanProof)) throw authFailed('human presence proof required')
  if (need === 'pin' && proof.presence !== 'pin') throw attestationRequired('PIN presence required for this action')
  return proof
}
export const isHumanProof = (x: unknown): x is HumanProof => x instanceof HumanProof

export const BOOT_TTL_MS = 120_000
export const SESSION_TTL_MS = 12 * 3600_000

export interface AuthOptions {
  clock: Clock
  pin: PinStore
  /** Agent 钥匙令牌验证（AgentService 提供）。 */
  verifyAgentToken?: (token: string) => { keyId: string; mandateId: string } | null
  /** 服务文件路径（service.json）。 */
  servicePath?: string
  assertPinStateHealthy?: () => void
}

const hashTok = (t: string): string => createHash('sha256').update(t).digest('hex')

export class AuthService {
  private boots = new Map<string, number>()
  private sessions = new Map<string, Extract<Principal, { kind: 'session' }>>()
  private serviceTokenHash = ''
  private serviceTokenPlain = ''
  verifyAgentToken?: AuthOptions['verifyAgentToken']

  constructor(private o: AuthOptions) {
    this.verifyAgentToken = o.verifyAgentToken
    this.rotateServiceToken()
  }

  now(): number { return this.o.clock.now() }

  // ---- 引导令牌 → 会话令牌 -------------------------------------------------------------
  /** 一次性引导令牌（120 s）。只给"启动 / 嵌入这个实例的人"（serve 的终端、Electron 主进程）。service 令牌不能铸造它。 */
  mintBootToken(ttlMs = BOOT_TTL_MS): string {
    const t = randomToken('boot_')
    this.boots.set(hashTok(t), this.o.clock.now() + ttlMs)
    return t
  }

  /** 引导令牌是否有效（不消耗）。页面服务据此决定要不要在 index.html 里注入它。 */
  peekBoot(token: string): boolean {
    const exp = this.boots.get(hashTok(String(token ?? '')))
    return exp !== undefined && exp >= this.o.clock.now()
  }

  exchangeBoot(token: string): { sessionToken: string; sessionId: string; expiresAt: number; user: string } {
    const h = hashTok(String(token ?? ''))
    const exp = this.boots.get(h)
    this.boots.delete(h) // 无论成败都作废：一次性
    if (exp === undefined || exp < this.o.clock.now()) throw authFailed('invalid or expired boot token')
    const sessionToken = randomToken('ses_')
    const now = this.o.clock.now()
    const sessionId = `ses_${sha256Hex(sessionToken).slice(0, 16)}`
    const principal = { kind: 'session' as const, sessionId, userId: 'usr_local' as const, since: now, expiresAt: now + SESSION_TTL_MS }
    this.sessions.set(hashTok(sessionToken), principal)
    return { sessionToken, sessionId, expiresAt: principal.expiresAt, user: principal.userId }
  }

  revokeSessions(): void { this.sessions.clear() }
  revokeSession(principal: Principal): void {
    if (principal.kind !== 'session') return
    for (const [tokenHash, current] of this.sessions) {
      if (current.sessionId === principal.sessionId) this.sessions.delete(tokenHash)
    }
  }
  isSessionActive(principal: Principal): boolean {
    if (principal.kind !== 'session') return false
    const now = this.o.clock.now()
    for (const [tokenHash, current] of this.sessions) {
      if (current.sessionId !== principal.sessionId) continue
      if (current.expiresAt < now) { this.sessions.delete(tokenHash); return false }
      return current.since === principal.since && current.expiresAt === principal.expiresAt
    }
    return false
  }
  get sessionCount(): number { return this.sessions.size }

  // ---- service 令牌（service.json）------------------------------------------------------
  rotateServiceToken(): string {
    this.serviceTokenPlain = randomToken('svc_')
    this.serviceTokenHash = hashTok(this.serviceTokenPlain)
    return this.serviceTokenPlain
  }

  /** 写 service.json（权限收紧）。令牌可轮换：再调一次 rotate + write 即可，旧令牌立即失效。 */
  writeServiceFile(info: { port: number; pid: number; startedAt: number; version: string }): { tightened: boolean } {
    if (!this.o.servicePath) throw new Error('servicePath not configured')
    const tightened = writeSecretFile(this.o.servicePath, JSON.stringify({ ...info, token: this.serviceTokenPlain }, null, 2))
    return { tightened }
  }

  // ---- 鉴权 ----------------------------------------------------------------------------
  /** 解析 `Authorization: Bearer <令牌>`。无令牌 / 未知 / 过期 → null。 */
  authenticate(authorization: string | undefined): Principal | null {
    if (!authorization) return null
    const m = /^Bearer\s+(\S+)$/.exec(authorization)
    if (!m) return null
    return this.authenticateToken(m[1] as string)
  }

  authenticateToken(token: string): Principal | null {
    if (token.startsWith('ses_')) {
      const s = this.sessions.get(hashTok(token))
      if (!s) return null
      if (s.expiresAt < this.o.clock.now()) { this.sessions.delete(hashTok(token)); return null }
      return s
    }
    if (token.startsWith('svc_')) return safeEqual(hashTok(token), this.serviceTokenHash) ? { kind: 'service' } : null
    if (token.startsWith('gtk_') && this.verifyAgentToken) {
      const a = this.verifyAgentToken(token)
      return a ? { kind: 'agent', keyId: a.keyId, mandateId: a.mandateId } : null
    }
    return null
  }

  /** Internal stable bucket identity; raw bearer tokens are never returned or stored. */
  operationRateKey(principal: Principal): string | null {
    if (principal.kind === 'session') return `session:${principal.sessionId}`
    if (principal.kind === 'agent') return `agent:${principal.keyId}`
    if (principal.kind === 'service') return `service:${this.serviceTokenHash}`
    if (principal.kind === 'engine') return `engine:${principal.engineId}`
    return null
  }

  /**
   * 请求头附加检查，只拒不放：
   *   - Host 必须是本机回环 + 本服务端口（防 DNS 重绑定）；
   *   - 带 Origin 时必须是本服务自己的源；
   *   - 带 Sec-Fetch-Site 时只接受 same-origin / none（跨站浏览器请求一律拒绝）。
   * 通过这个检查不代表有身份——身份只来自令牌。
   */
  checkHeaders(h: Record<string, string | string[] | undefined>, port: number): { ok: true } | { ok: false; reason: string } {
    const one = (k: string): string | undefined => { const v = h[k]; return Array.isArray(v) ? v[0] : v }
    const host = (one('host') ?? '').toLowerCase()
    if (![`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(host)) return { ok: false, reason: 'Host not allowed' }
    const origin = one('origin')
    if (origin !== undefined && ![`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`].includes(origin.toLowerCase())) return { ok: false, reason: 'Origin not allowed' }
    const sfs = one('sec-fetch-site')
    if (sfs !== undefined && sfs !== 'same-origin' && sfs !== 'none') return { ok: false, reason: 'cross-site request refused' }
    return { ok: true }
  }

  // ---- 人面在场证明 ---------------------------------------------------------------------
  /** 'session'：只认会话主体（service / agent 不行）。 */
  sessionProof(p: Principal | null, via: OriginVia = 'ui'): HumanProof {
    if (!p || p.kind !== 'session') throw authFailed('a workbench session is required for this action')
    return new HumanProof(MINT, 'session', p.userId, via, this.o.clock.now())
  }

  /** 'pin'：会话或 service 主体 + 正确 PIN（带退避）。Agent 主体永远不行。 */
  async pinProof(p: Principal | null, pin: string | undefined, via: OriginVia = 'ui'): Promise<HumanProof> {
    if (!p || p.kind === 'agent' || p.kind === 'engine') throw authFailed('Agent keys cannot perform human-only actions')
    if (typeof pin !== 'string' || pin === '') throw attestationRequired()
    this.o.assertPinStateHealthy?.()
    const key = await this.o.pin.verify(pin)
    return new HumanProof(MINT, 'pin', 'usr_local', via, this.o.clock.now(), key)
  }

  /** 首次设置 PIN。要求会话主体（拿得到引导令牌的人）；返回的证明可直接用于随后的密钥库初始化。 */
  async setupPin(p: Principal | null, pin: string): Promise<HumanProof> {
    if (!p || p.kind !== 'session') throw authFailed('PIN can only be set from a workbench session or the local terminal')
    if (typeof pin !== 'string' || pin === '') throw authFailed('PIN is required')
    this.o.assertPinStateHealthy?.()
    const key = await this.o.pin.setup(pin)
    return new HumanProof(MINT, 'pin', 'usr_local', 'ui', this.o.clock.now(), key)
  }

  /** 修改 PIN：旧 PIN 必须校验通过（带失败退避）。返回新旧主密钥，调用方给密钥库换钥。 */
  async changePin(p: Principal | null, oldPin: string, newPin: string): Promise<{ oldKey: Buffer; newKey: Buffer }> {
    if (!p || p.kind === 'agent' || p.kind === 'engine') throw authFailed('Agent keys cannot change the PIN')
    if (typeof oldPin !== 'string' || oldPin === '' || typeof newPin !== 'string' || newPin === '') throw authFailed('PIN is required')
    this.o.assertPinStateHealthy?.()
    return this.o.pin.change(oldPin, newPin)
  }

  /** CLI 本地终端设置 PIN（人在终端前）：由 CLI 进程直接调用，不经 HTTP。 */
  async setupPinLocalTerminal(pin: string): Promise<HumanProof> {
    if (typeof pin !== 'string' || pin === '') throw authFailed('PIN is required')
    this.o.assertPinStateHealthy?.()
    const key = await this.o.pin.setup(pin)
    return new HumanProof(MINT, 'pin', 'usr_local', 'cli', this.o.clock.now(), key)
  }

  /** 本地终端（CLI 进程内）验证 PIN。 */
  async pinProofLocalTerminal(pin: string): Promise<HumanProof> {
    if (typeof pin !== 'string' || pin === '') throw authFailed('PIN is required')
    this.o.assertPinStateHealthy?.()
    const key = await this.o.pin.verify(pin)
    return new HumanProof(MINT, 'pin', 'usr_local', 'cli', this.o.clock.now(), key)
  }

  /** 按已认证主体盖章 Origin（行为人不能自报 actor，§1.6）。 */
  originFor(p: Principal, tool: string, via: OriginVia, requestId: string): Origin {
    const actor = p.kind === 'agent' ? (`agent:${p.keyId}` as const) : p.kind === 'engine' ? (`engine:${p.engineId}` as const) : (`user:usr_local` as const)
    return mkOrigin(actor, tool, via, { requestId })
  }
}
