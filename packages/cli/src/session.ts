// SPDX-License-Identifier: CPAL-1.0
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs'
import { resolveConfinedPath, tightenFile } from '@gitrader/kernel'

const CACHE_NAME = 'cli-session.json'
const CACHE_MAX_BYTES = 16 * 1024
const CACHE_VERSION = 1
const sessionTokenPattern = /^ses_[A-Z2-7]{52}$/
const sessionIdPattern = /^ses_[a-f0-9]{16}$/
const bootTokenPattern = /^boot_[A-Z2-7]{52}$/
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export interface SessionService { baseUrl: string; startedAt: number }
export interface CachedSession {
  version: 1
  sessionToken: string
  sessionId: string
  expiresAt: number
  serviceStartedAt: number
}
export interface SessionFileOps {
  tightenFile(path: string): boolean
  renameSync(from: string, to: string): void
  unlinkSync(path: string): void
  randomUUID?: () => string
}
export type SessionRequiredReason = 'missing' | 'invalid' | 'expired' | 'service-restarted' | 'service-unavailable'

/** 五种缺会话的原因各给一句中文 + 下一步命令；英文原句保留在括号里（中文在前）。 */
const SESSION_REQUIRED_ZH: Record<SessionRequiredReason, string> = {
  missing: '还没登录本机会话：运行 gitrader session login',
  invalid: '本机会话文件读不懂（被改过或损坏）：运行 gitrader session login 重新登录',
  expired: '本机会话已过期：运行 gitrader session login 重新登录',
  'service-restarted': '服务重启过，旧会话失效：运行 gitrader session login',
  'service-unavailable': '服务没在运行：先运行 gitrader serve，再 gitrader session login',
}

// 人用命令缺会话时顺带告诉 Agent 该走哪条路（只是文案：Agent 走 Agent 令牌的 `gitrader agent`，不走本机会话；人也不能用命令接受 Agent 钥匙）。
const AGENT_PATH_ZH = " Agent 请改用：gitrader agent <工具> [<动作>] --args '<JSON>'（用 Agent 令牌，不需要本机会话），如 gitrader agent research search --args '{\"query\":\"BTC\"}'。"
const AGENT_PATH_EN = "Agents: use `gitrader agent <tool> [<action>] --args '<JSON>'` with an agent token instead; no local session is needed, e.g. `gitrader agent research search --args '{\"query\":\"BTC\"}'`."
export class SessionRequiredError extends Error {
  readonly code = 'SESSION_REQUIRED'
  constructor(readonly reason: SessionRequiredReason) {
    super(`${SESSION_REQUIRED_ZH[reason]}（No valid local session. Run \`gitrader session login\` to sign in again.）${AGENT_PATH_ZH}（${AGENT_PATH_EN}）`)
    this.name = 'SessionRequiredError'
  }
}

export class SessionLoginError extends Error {
  constructor(message: string) { super(message); this.name = 'SessionLoginError' }
}

interface CacheSnapshot { path: string; raw: string; digest: string }
const defaultFileOps: SessionFileOps = { tightenFile, renameSync, unlinkSync }
const digest = (raw: string): string => createHash('sha256').update(raw).digest('hex')
/**
 * 家目录内的固定文件名（缓存文件 / 一次性暂存文件）解析成真实路径，要求真实路径仍在家目录里。
 * R2-REL-04：长路径（接近 260 字符）下的 realpath 回退已收进 @gitrader/kernel 的 resolveConfinedPath，这里不再留特例。
 */
const confine = (home: string, name: string, opts: { mustExist?: boolean } = {}): string => resolveConfinedPath(home, name, { anchorRoot: home, ...opts })
const cachePath = (home: string): string => confine(home, CACHE_NAME)

function snapshotCache(home: string): CacheSnapshot | null {
  try {
    const path = confine(home, CACHE_NAME, { mustExist: true })
    const stat = lstatSync(path)
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > CACHE_MAX_BYTES) return null
    const raw = readFileSync(path, 'utf8')
    if (Buffer.byteLength(raw, 'utf8') > CACHE_MAX_BYTES) return null
    return { path, raw, digest: digest(raw) }
  } catch { return null }
}

function parseCache(raw: string): CachedSession | null {
  try {
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const record = value as Record<string, unknown>
    const keys = Object.keys(record).sort()
    const expected = ['expiresAt', 'serviceStartedAt', 'sessionId', 'sessionToken', 'version']
    if (keys.length !== expected.length || keys.some((key, i) => key !== expected[i])) return null
    if (record.version !== CACHE_VERSION || typeof record.sessionToken !== 'string' || !sessionTokenPattern.test(record.sessionToken)
      || typeof record.sessionId !== 'string' || !sessionIdPattern.test(record.sessionId)
      || typeof record.expiresAt !== 'number' || !Number.isSafeInteger(record.expiresAt)
      || typeof record.serviceStartedAt !== 'number' || !Number.isSafeInteger(record.serviceStartedAt)) return null
    return {
      version: CACHE_VERSION,
      sessionToken: record.sessionToken,
      sessionId: record.sessionId,
      expiresAt: record.expiresAt,
      serviceStartedAt: record.serviceStartedAt,
    }
  } catch { return null }
}

function validateForService(session: CachedSession, service: SessionService | null, now: number): SessionRequiredReason | null {
  if (session.expiresAt <= now) return 'expired'
  if (!service) return 'service-unavailable'
  if (!Number.isSafeInteger(service.startedAt) || session.serviceStartedAt !== service.startedAt) return 'service-restarted'
  return null
}

/** Read only a bounded, regular, home-confined cache bound to the current service process. */
export function readCachedSession(home: string, service: SessionService | null, now = Date.now()): CachedSession {
  const snapshot = snapshotCache(home)
  if (!snapshot) throw new SessionRequiredError('missing')
  const session = parseCache(snapshot.raw)
  if (!session) throw new SessionRequiredError('invalid')
  const reason = validateForService(session, service, now)
  if (reason) throw new SessionRequiredError(reason)
  return session
}

/** Remove the cached session only when it still matches the token rejected by the service. */
export function invalidateCachedSession(home: string, sessionToken: string, files: SessionFileOps = defaultFileOps): boolean {
  const snapshot = snapshotCache(home)
  if (!snapshot || parseCache(snapshot.raw)?.sessionToken !== sessionToken) return false
  return clearMatchingSnapshot(home, snapshot.digest, files)
}

function clearMatchingSnapshot(home: string, expectedDigest: string, files: SessionFileOps): boolean {
  try {
    const currentPath = confine(home, CACHE_NAME, { mustExist: true })
    const stat = lstatSync(currentPath)
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > CACHE_MAX_BYTES) return false
    const current = readFileSync(currentPath, 'utf8')
    if (Buffer.byteLength(current, 'utf8') > CACHE_MAX_BYTES || digest(current) !== expectedDigest) return false
    files.unlinkSync(currentPath)
    return true
  } catch { return false }
}

interface FileIdentity { dev: bigint; ino: bigint }

function identityOf(stat: { dev: bigint; ino: bigint }): FileIdentity {
  if (typeof stat.dev !== 'bigint' || typeof stat.ino !== 'bigint') throw new Error('file identity is unavailable')
  return { dev: stat.dev, ino: stat.ino }
}

function sameIdentity(stat: { dev: bigint; ino: bigint }, identity: FileIdentity): boolean {
  return stat.dev === identity.dev && stat.ino === identity.ino
}

function verifyOpenStage(home: string, stageName: string, stagePath: string, fd: number, identity: FileIdentity): void {
  const confined = confine(home, stageName, { mustExist: true })
  if (confined !== stagePath) throw new Error('staging path changed')
  const pathStat = lstatSync(confined, { bigint: true })
  const fdStat = fstatSync(fd, { bigint: true })
  if (!pathStat.isFile() || pathStat.isSymbolicLink() || pathStat.nlink !== 1n || fdStat.nlink !== 1n
    || !sameIdentity(pathStat, identity) || !sameIdentity(fdStat, identity)) throw new Error('staging file identity changed')
}

function verifyClosedStage(home: string, stageName: string, stagePath: string, identity: FileIdentity): void {
  const confined = confine(home, stageName, { mustExist: true })
  if (confined !== stagePath) throw new Error('staging path changed')
  const pathStat = lstatSync(confined, { bigint: true })
  if (!pathStat.isFile() || pathStat.isSymbolicLink() || pathStat.nlink !== 1n || !sameIdentity(pathStat, identity)) {
    throw new Error('staging file identity changed')
  }
}

function removeOwnedStage(home: string, stageName: string, stagePath: string, identity: FileIdentity, files: SessionFileOps): void {
  try {
    const confined = confine(home, stageName, { mustExist: true })
    if (confined !== stagePath) return
    const stat = lstatSync(confined, { bigint: true })
    if (stat.isFile() && !stat.isSymbolicLink() && sameIdentity(stat, identity)) files.unlinkSync(confined)
  } catch { /* Leave a replaced or unidentifiable path untouched. */ }
}

async function revokeNewSession(service: SessionService, sessionToken: string): Promise<void> {
  try {
    await fetch(new URL('/api/op/session.logout', service.baseUrl), {
      method: 'POST', headers: { authorization: `Bearer ${sessionToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ params: {} }), signal: AbortSignal.timeout(5000),
    })
  } catch { /* Never report or retain the one-time token in an error path. */ }
}

/** 登录用的一次性令牌：整条登录链接（?launch=boot_…）、或裸令牌都认。 */
export function bootTokenFrom(typed: string): string {
  try { const launch = new URL(typed).searchParams.get('launch'); if (launch) return launch } catch { /* 不是链接，当裸令牌 */ }
  return typed
}

/** Exchange one boot token and securely install its session cache after permission tightening succeeds. */
export async function loginSession(
  home: string,
  service: SessionService,
  readSecret: (prompt: string) => Promise<string>,
  files: SessionFileOps = defaultFileOps,
  lang: 'zh' | 'en' = 'zh',
): Promise<CachedSession> {
  const m = (zh: string, en: string): string => (lang === 'en' ? en : zh)
  if (!Number.isSafeInteger(service.startedAt)) throw new SessionLoginError(m('没法把本机会话绑定到正在运行的服务：重启服务后再试（The running service cannot be bound to a local session）。', 'The running service cannot be bound to a local session. Restart it and try again.'))
  const typed = (await readSecret(m('一次性登录令牌，或整条登录链接（One-time boot token or launch link）：', 'One-time boot token or the whole launch link: '))).trim()
  const bootstrap = bootTokenFrom(typed)
  if (!bootTokenPattern.test(bootstrap)) throw new SessionLoginError(m('需要一条新的一次性登录令牌（A fresh one-time boot token is required）：粘贴 gitrader serve --detach 打印的整条登录链接、或 gitrader open --print 的输出，或链接里 launch= 后面那段。已用过或超过 2 分钟的要重新取。', 'A fresh one-time boot token is required: paste the whole login link printed by `gitrader serve --detach` or `gitrader open --print` (or just the part after launch=). A link that was used or is older than 2 minutes needs a new one.'))

  let response: Response
  try {
    response = await fetch(new URL('/api/session', service.baseUrl), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ bootstrap }),
      signal: AbortSignal.timeout(15_000),
    })
  } catch {
    throw new SessionLoginError(m('连不上正在运行的服务：确认它还在跑，再试一次（Could not reach the running service）。', 'Could not reach the running service. Check that it is still running and try again.'))
  }
  if (!response.ok) throw new SessionLoginError(m('登录失败（Login failed）：登录令牌已用过或已过期，请重新取一条新的。', 'Login failed. Get a fresh one-time boot token from the running service and try again.'))

  let body: Record<string, unknown>
  try {
    const parsed: unknown = await response.json()
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid response')
    body = parsed as Record<string, unknown>
  } catch { throw new SessionLoginError(m('服务返回的登录响应不对（The running service returned an invalid login response）：重新取一条登录令牌再试。', 'The running service returned an invalid login response. Get a fresh boot token and try again.')) }

  const candidateToken = typeof body.sessionToken === 'string' && sessionTokenPattern.test(body.sessionToken) ? body.sessionToken : undefined
  const sessionId = body.sessionId
  const expiresAt = body.expiresAt
  if (!candidateToken || typeof sessionId !== 'string' || !sessionIdPattern.test(sessionId)
    || !Number.isSafeInteger(expiresAt) || (expiresAt as number) <= Date.now()
    || body.user !== 'usr_local' || Object.keys(body).some((key) => !['sessionToken', 'sessionId', 'expiresAt', 'user', 'ws'].includes(key))) {
    if (candidateToken) await revokeNewSession(service, candidateToken)
    throw new SessionLoginError(m('服务返回的登录响应不对（The running service returned an invalid login response）：重新取一条登录令牌再试。', 'The running service returned an invalid login response. Get a fresh boot token and try again.'))
  }

  const session: CachedSession = { version: 1, sessionToken: candidateToken, sessionId, expiresAt: expiresAt as number, serviceStartedAt: service.startedAt }
  let stageName: string | undefined
  let stagingPath: string | undefined
  let fd: number | undefined
  let owned = false
  let identity: FileIdentity | undefined
  try {
    const finalPath = cachePath(home)
    const uuid = files.randomUUID ? files.randomUUID() : randomUUID()
    if (!uuidPattern.test(uuid)) throw new Error('invalid staging identifier')
    stageName = `.cli-session-${uuid}.tmp`
    stagingPath = confine(home, stageName)
    fd = openSync(stagingPath, 'wx', 0o600)
    owned = true
    identity = identityOf(fstatSync(fd, { bigint: true }))
    verifyOpenStage(home, stageName, stagingPath, fd, identity)
    if (!files.tightenFile(stagingPath)) throw new Error('permission tightening failed')
    verifyOpenStage(home, stageName, stagingPath, fd, identity)
    if (fstatSync(fd, { bigint: true }).size !== 0n) throw new Error('staging file is not empty')
    const payload = Buffer.from(JSON.stringify(session), 'utf8')
    let offset = 0
    while (offset < payload.length) {
      const written = writeSync(fd, payload, offset, payload.length - offset, null)
      if (written <= 0) throw new Error('staging write did not complete')
      offset += written
    }
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    verifyClosedStage(home, stageName, stagingPath, identity)
    const confinedFinal = confine(home, CACHE_NAME)
    if (confinedFinal !== finalPath) throw new Error('cache path changed')
    files.renameSync(stagingPath, confinedFinal)
    return session
  } catch {
    if (fd !== undefined) { try { closeSync(fd) } catch { /* descriptor may already be closed */ } }
    if (owned && identity && stageName && stagingPath) removeOwnedStage(home, stageName, stagingPath, identity, files)
    await revokeNewSession(service, session.sessionToken)
    const longHome = process.platform === 'win32' && home.length >= 200
      ? ` The data directory path is ${home.length} characters long (close to the Windows 260-character limit): set GITRADER_HOME to a shorter directory and log in again. 数据目录路径过长（${home.length} 个字符）：把 GITRADER_HOME 换到更短的目录再登录。`
      : ''
    throw new SessionLoginError(lang === 'zh' ? `没能安全地保存本机会话缓存（Could not secure the local session cache）：没有保存新会话，检查本地文件权限后重试。${longHome}` : `Could not secure the local session cache. No NEW session was stored; check local file permissions and try again.${longHome}`)
  }
}

export type LogoutOutcome = 'remote' | 'local' | 'unconfirmed' | 'newer-session'

/** Revoke the cached session remotely when possible, then remove only the cache snapshot used for that request. */
export async function logoutSession(home: string, service: SessionService | null, files: SessionFileOps = defaultFileOps): Promise<LogoutOutcome> {
  const snapshot = snapshotCache(home)
  if (!snapshot) throw new SessionRequiredError('missing')
  const session = parseCache(snapshot.raw)
  if (!session) return clearMatchingSnapshot(home, snapshot.digest, files) ? 'local' : 'newer-session'
  const reason = validateForService(session, service, Date.now())
  if (reason) return clearMatchingSnapshot(home, snapshot.digest, files) ? 'local' : 'newer-session'

  let outcome: 'remote' | 'local' | 'unconfirmed' = 'unconfirmed'
  try {
    const response = await fetch(new URL('/api/op/session.logout', service!.baseUrl), {
      method: 'POST', headers: { authorization: `Bearer ${session.sessionToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ params: {} }), signal: AbortSignal.timeout(10_000),
    })
    if (response.ok) outcome = 'remote'
    else if (response.status === 401) outcome = 'local'
  } catch { /* Local removal remains useful, but remote revocation cannot be claimed. */ }
  const cleared = clearMatchingSnapshot(home, snapshot.digest, files)
  if (!cleared) return 'newer-session'
  return outcome
}
