// SPDX-License-Identifier: CPAL-1.0
// Agent 钥匙与授权书（契约 §5.2、§5.3）。
//   - 对外四档（只读 / 纸面 / 需确认 / 限额自动）↔ 内部五级 L0–L4（L4 放量只能经晋级，不能直接选）。
//   - 授权书是用户签名的文档：签发 / 续期 / 晋级 = 人面 + PIN；降级只会变严，Agent 可对自己做（mandate.downgrade）。
//   - 令牌：gtk_ + 32 字节随机数 base32，只显示一次；内核只存其 scrypt 慢哈希（外加内存里的已验证缓存，热路径不做 scrypt）。
//   - 心跳：授权书 heartbeat.timeoutSec 内没有任何已认证调用，也没有 mandate.heartbeat → 降级 + 接管。MCP 服务器不得代发心跳。
import { randomBytes, scryptSync } from 'node:crypto'
import {
  DEFAULT_LEVEL_OF_TIER, MANDATE_DEFAULTS, MANDATE_LEVEL_RULES, STRONG_ATTESTATION_METHODS, AGENT_TOKEN_PATTERN, makeProblem,
} from './proto'
import type {
  AccountId, AgentHost, AgentKey, AgentPermissionTier, Attestation, AttestationMethod, Decimal, Mandate, MandateLevel, MandateLimits, Origin,
} from './proto'
import { assertProof } from './auth'
import type { HumanProof } from './auth'
import type { Docs } from './db'
import type { EventBus } from './events'
import type { InstallKey } from './install-key'
import { InstallKey as IK } from './install-key'
import type { Ledger } from './ledger'
import * as d from './util/dec'
import { KernelError } from './util/errors'
import { digestOf, randomToken, safeEqual, sha256Hex } from './util/hash'
import { newId } from './util/ids'
import { mkOrigin } from './util/origin'
import type { Clock } from './util/clock'

const DAY = 86_400_000
const KEYS = 'agentkey'
const MANDATES = 'mandate'
const lvl = (l: MandateLevel): number => Number(l.slice(1))
const bad = (m: string): KernelError => new KernelError(makeProblem('INVALID_PARAMS', m))
const strong = (m: AttestationMethod): boolean => (STRONG_ATTESTATION_METHODS as readonly string[]).includes(m)

interface KeyDoc extends AgentKey { secret: { fp: string; salt: string; hash: string } }

export interface IssueMandateInput {
  subject: Mandate['subject']
  level: MandateLevel
  accounts: AccountId[]
  venueAllowlist?: string[]
  instrumentAllowlist?: string[]
  limits?: MandateLimits
  notBefore?: number
  notAfter?: number
  heartbeat?: Mandate['heartbeat']
  approval?: Partial<NonNullable<Mandate['approval']>>
  denyLlmLiveEntries?: boolean
}

/** 授权书缺项（给人看的中文），供 CLI / UI 直接展示；`field` 与 checkMandateInput 的判断一一对应。 */
export interface MandateGap {
  field: 'accounts' | 'venueAllowlist' | 'instrumentAllowlist' | `limits.${string}` | 'heartbeat' | 'notAfter'
  zh: string
}

interface GapRow {
  /** null = 无法归到具名字段（未知档位 / 已由同名条目覆盖的重复项），不进 MandateGap 列表。 */
  field: MandateGap['field'] | null
  en: string
  zh: string
}

const LIMIT_ZH: Record<string, string> = { maxOrderNotional: '单笔上限', maxDailyNotional: '每日上限' }
const limitZh = (k: string): string => LIMIT_ZH[k] ?? `限额 ${k}`

/** 档位中文名（比 MANDATE_LEVEL_NAMES 更适合对用户说话）。 */
const LEVEL_ZH: Record<MandateLevel, string> = { L0: '只读', L1: '纸面直通', L2: '需确认', L3: '限额自动', L4: '全自动' }

/** 同一组必填判断：en 保持原有英文串（checkMandateInput 的返回值不变），zh 是新加的中文说明。 */
function gapRows(i: IssueMandateInput, now: number): GapRow[] {
  const rows: GapRow[] = []
  const rule = MANDATE_LEVEL_RULES[i.level]
  if (!rule) return [{ field: null, en: `unknown level ${String(i.level)}`, zh: '' }]
  if (!Array.isArray(i.accounts) || i.accounts.length === 0) rows.push({ field: 'accounts', en: 'accounts is required', zh: '账户' })
  if (rule.requiresAllowlists) {
    if (!i.venueAllowlist?.length) rows.push({ field: 'venueAllowlist', en: `${i.level} requires venueAllowlist`, zh: '允许的场所' })
    if (!i.instrumentAllowlist?.length) rows.push({ field: 'instrumentAllowlist', en: `${i.level} requires instrumentAllowlist`, zh: '允许的标的' })
  }
  for (const k of rule.requiredLimits) if (i.limits?.[k] === undefined) rows.push({ field: `limits.${k}`, en: `${i.level} requires limits.${k}`, zh: limitZh(k) })
  if (rule.heartbeat === 'required' && !i.heartbeat) rows.push({ field: 'heartbeat', en: `${i.level} requires heartbeat`, zh: '心跳设置' })
  const notAfter = i.notAfter ?? now + MANDATE_DEFAULTS.notAfterDays * DAY
  const maxDays = lvl(i.level) >= 3 ? MANDATE_DEFAULTS.notAfterMaxDaysL3L4 : 365
  if (notAfter <= (i.notBefore ?? now)) rows.push({ field: 'notAfter', en: 'notAfter must be after notBefore', zh: '有效期（结束时间必须晚于开始时间）' })
  if (notAfter - now > maxDays * DAY) rows.push({ field: 'notAfter', en: `notAfter must be within ${maxDays} days for ${i.level}`, zh: `有效期（${i.level} 最长 ${maxDays} 天）` })
  // L4 的这四项已在上面的 requiredLimits 里报过（同一组键），这里只补原英文串，不再重复计入中文缺项
  if (i.level === 'L4') {
    for (const k of ['maxOrderNotional', 'maxDailyNotional', 'maxDailyLoss', 'autoMaxOrderNotional'] as const) if (i.limits?.[k] === undefined) rows.push({ field: null, en: `L4 requires finite limits.${k}`, zh: '' })
  }
  if (i.heartbeat && (i.heartbeat.timeoutSec <= i.heartbeat.intervalSec)) rows.push({ field: 'heartbeat', en: 'heartbeat.timeoutSec must exceed intervalSec', zh: '心跳设置（超时必须大于间隔）' })
  return rows
}

/** 授权书校验（按级别的必填字段，MANDATE_LEVEL_RULES）。返回问题列表（原英文串，签名与返回值不变）。 */
export function checkMandateInput(i: IssueMandateInput, now: number): string[] {
  return gapRows(i, now).map((r) => r.en)
}

/** 与 checkMandateInput 同口径的中文缺项列表（同一组判断，各带中文说明）。 */
export function mandateGaps(i: IssueMandateInput, now: number): MandateGap[] {
  const out: MandateGap[] = []
  for (const r of gapRows(i, now)) if (r.field) out.push({ field: r.field, zh: r.zh })
  return out
}

const symOf = (instrumentId: string): string => instrumentId.slice(instrumentId.lastIndexOf(':') + 1)

/** 编辑距离（Levenshtein），用于「最近三个 instrumentId」提示。 */
function editDistance(a: string, b: string): number {
  let prev: number[] = []
  for (let j = 0; j <= b.length; j++) prev.push(j)
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0] ?? 0
    const next: number[] = [i]
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j] ?? 0
      next.push(Math.min(up + 1, (next[j - 1] ?? 0) + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1)))
      diag = up
    }
    prev = next
  }
  return prev[b.length] ?? 0
}

/**
 * 白名单规范化：裸符号（不含 `:`）按目录补全成 `venue:SYMBOL`，大小写不敏感。
 * 只补全主市场（marketGroup 为空）；多场所时取第一个并在 notes 提示；目录里没有的进 unknown（附最近的 3 个 instrumentId）。
 * 目录不在 AgentRegistry 里，所以 issueMandate 不调它，由 CLI / ops 在签发前调用。
 */
export function normalizeInstrumentAllowlist(
  list: readonly string[],
  catalog: readonly { instrumentId: string; marketGroup?: string | null }[],
): { list: string[]; notes: string[]; unknown: Array<{ input: string; nearest: string[] }> } {
  const ids = catalog.map((c) => c.instrumentId)
  const nearestTo = (input: string): string[] => ids
    // 距离取「到完整 instrumentId」与「到符号部分」的较小值，裸符号输入才能对齐到同名标的
    .map((id) => ({ id, d: Math.min(editDistance(input.toLowerCase(), id.toLowerCase()), editDistance(input.toLowerCase(), symOf(id).toLowerCase())) }))
    .sort((x, y) => (x.d - y.d) || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))
    .slice(0, 3)
    .map((x) => x.id)
  const out: string[] = []
  const notes: string[] = []
  const unknown: Array<{ input: string; nearest: string[] }> = []
  for (const raw of list) {
    const input = String(raw ?? '').trim()
    if (!input) continue
    if (input.includes(':')) {
      const hit = ids.find((id) => id.toLowerCase() === input.toLowerCase())
      if (hit) out.push(input)
      else unknown.push({ input, nearest: nearestTo(input) })
      continue
    }
    const want = input.toLowerCase()
    const primary = catalog.filter((c) => !c.marketGroup && symOf(c.instrumentId).toLowerCase() === want)
    const first = primary[0]
    if (!first) { unknown.push({ input, nearest: nearestTo(input) }); continue }
    out.push(first.instrumentId)
    notes.push(primary.length === 1
      ? `已补全为 ${first.instrumentId}`
      : `${symOf(first.instrumentId)} 有多个场所，已选 ${first.instrumentId}；可写全名`)
  }
  return { list: out, notes, unknown }
}

/** a 是否比 b 更宽（授权书）：级别更高、有效期更长、账户更多、额度更大或缺失。 */
export function mandateLooser(a: Mandate, b: Mandate): string[] {
  const why: string[] = []
  if (lvl(a.level) > lvl(b.level)) why.push('level')
  if (a.notAfter > b.notAfter) why.push('notAfter')
  if (a.accounts.some((x) => !b.accounts.includes(x))) why.push('accounts')
  for (const k of ['maxOrderNotional', 'maxDailyNotional', 'maxDailyLoss', 'maxPositionNotional', 'autoMaxOrderNotional'] as const) {
    const av = a.limits[k] as Decimal | undefined, bv = b.limits[k] as Decimal | undefined
    if (bv !== undefined && (av === undefined || d.gt(d.D(av), d.D(bv)))) why.push(`limits.${k}`)
  }
  for (const k of ['maxOpenPositions', 'maxLeverage', 'maxOrdersPerMinute', 'maxDailyOrders', 'maxCancelsPerMinute'] as const) {
    const av = a.limits[k], bv = b.limits[k]
    if (bv !== undefined && (av === undefined || av > bv)) why.push(`limits.${k}`)
  }
  for (const k of ['venueAllowlist', 'instrumentAllowlist'] as const) {
    const bl = b[k]
    if (bl?.length && (!a[k]?.length || a[k]!.some((x) => !bl.includes(x)))) why.push(k)
  }
  if (a.denyLlmLiveEntries === false && b.denyLlmLiveEntries !== false) why.push('denyLlmLiveEntries')
  return why
}

export type HeartbeatTimeoutHandler = (m: Mandate, takeover: 'none' | 'halt_new' | 'cancel_all') => void

export class AgentService {
  private cache = new Map<string, { keyId: string; mandateId: string }>()
  private lastBeat = new Map<string, number>()
  private lastSeenWrite = new Map<string, number>()
  private mandateOk = new Map<string, boolean>()
  onHeartbeatTimeout?: HeartbeatTimeoutHandler

  constructor(private docs: Docs, private ledger: Ledger, private events: EventBus, private clock: Clock, private installKey: InstallKey, private opts: { defaultExpiryDays?: number } = {}) {
    const now = clock.now()
    for (const m of this.listMandates()) if (m.heartbeat) this.lastBeat.set(m.mandateId, now) // 重启后给一个完整的超时窗口
  }

  // ---- 授权书 ---------------------------------------------------------------------
  private sign(m: Omit<Mandate, 'attestation'>, method: AttestationMethod, by = 'usr_local'): Mandate {
    const digest = digestOf(m)
    const attestation: Attestation = { method, by, at: this.clock.now(), digest, sig: this.installKey.sign(digest) }
    return { ...m, attestation }
  }

  /** 全部版本（升序）。 */
  mandateVersions(id: string): Mandate[] { return this.docs.versions<Mandate>(MANDATES, id) }
  getMandate(id: string): Mandate | undefined { return this.docs.get<Mandate>(MANDATES, id) }
  listMandates(): Mandate[] { return this.docs.list<Mandate>(MANDATES) }

  /** 验签 + 非强签名版本不得比最近一次强签名版本更宽（T-B 伪造最多造成更严的限制）。 */
  verifyMandate(id: string): boolean {
    const vs = this.mandateVersions(id)
    let ok = vs.length > 0
    let lastStrong: Mandate | undefined
    for (const v of vs) {
      const { attestation, ...rest } = v
      if (!attestation || digestOf(rest) !== attestation.digest || !IK.verify(this.installKey.publicKey, attestation.digest, attestation.sig)) { ok = false; break }
      if (strong(attestation.method)) lastStrong = v
      else if (lastStrong && mandateLooser(v, lastStrong).length) { ok = false; break }
    }
    this.mandateOk.set(id, ok)
    return ok
  }

  /** 生效授权书：验签失败 / 已撤销 / 到期 → 视同 L0（只读）。 */
  effective(id: string, now = this.clock.now()): Mandate | undefined {
    const m = this.getMandate(id)
    if (!m) return undefined
    const ok = this.mandateOk.get(id) ?? this.verifyMandate(id)
    // 'downgraded' = 已降到更低一级、仍然有效（级别就是降级后的那一级）；expired / revoked / suspended / 验签失败 才视同 L0
    const live = m.status === 'active' || m.status === 'downgraded'
    if (!ok || !live || now >= m.notAfter || now < m.notBefore) return { ...m, level: 'L0', status: ok ? (live ? 'expired' : m.status) : 'revoked' }
    return m
  }

  issueMandate(input0: IssueMandateInput, proof: HumanProof, origin: Origin, existingId?: string): Mandate {
    assertProof(proof, 'pin')
    const now = this.clock.now()
    // L3+ 必须有心跳：没给就用默认值（60 / 180 / 超时降到 L0 并停止新开仓）
    const input: IssueMandateInput = MANDATE_LEVEL_RULES[input0.level]?.heartbeat === 'required' && !input0.heartbeat ? { ...input0, heartbeat: MANDATE_DEFAULTS.heartbeat } : input0
    const problems = checkMandateInput(input, now)
    if (problems.length) {
      const gaps = mandateGaps(input, now)
      // 档位都认不出来时没有可列的中文缺项：保留原英文报错
      if (!gaps.length) throw bad(`invalid mandate: ${problems.join('; ')}`)
      throw bad(`「${LEVEL_ZH[input.level]}」档还需要：${gaps.map((g) => g.zh).join('、')}。可以加 --preset starter 一键用默认值（原文：invalid mandate: ${problems.join('; ')}）`)
    }
    const rule = MANDATE_LEVEL_RULES[input.level]
    const prev = existingId ? this.getMandate(existingId) : undefined
    const mandateId = (existingId ?? newId('mdt')) as Mandate['mandateId']
    const body: Omit<Mandate, 'attestation'> = {
      mandateId, version: (prev?.version ?? 0) + 1, subject: input.subject, level: input.level, accounts: input.accounts,
      ...(input.venueAllowlist ? { venueAllowlist: input.venueAllowlist } : {}),
      ...(input.instrumentAllowlist ? { instrumentAllowlist: input.instrumentAllowlist } : {}),
      limits: input.limits ?? {},
      notBefore: input.notBefore ?? now,
      notAfter: input.notAfter ?? now + MANDATE_DEFAULTS.notAfterDays * DAY,
      ...(input.heartbeat ? { heartbeat: input.heartbeat } : rule.heartbeat === 'required' ? { heartbeat: MANDATE_DEFAULTS.heartbeat } : {}),
      approval: { ...MANDATE_DEFAULTS.approval, presenceAboveNotional: (input.limits?.maxOrderNotional ?? '1000') as Decimal, ...(input.approval ?? {}) },
      temporaryRelax: null,
      ...(input.denyLlmLiveEntries !== undefined ? { denyLlmLiveEntries: input.denyLlmLiveEntries } : {}),
      status: 'active', issuedBy: 'user:usr_local',
    }
    const m = this.sign(body, 'pin')
    this.docs.put(MANDATES, mandateId, m, m.version)
    this.mandateOk.delete(mandateId)
    if (m.heartbeat) this.lastBeat.set(mandateId, now)
    this.ledger.append({ type: prev ? 'mandate.changed' : 'mandate.issued', origin, subject: { mandateId }, payload: { version: m.version, level: m.level, accounts: m.accounts, notAfter: m.notAfter, limits: m.limits, digest: m.attestation.digest } , attestation: 'user-asserted' })
    this.events.publish('mandate.changed', { mandateId, level: m.level, status: m.status })
    this.cache.clear()
    return m
  }

  /** 降级：只会变严。Agent 可对自己的授权书调用（自保动作）；系统（心跳超时）也走这里。 */
  downgrade(mandateId: string, to: MandateLevel, reason: string, origin: Origin, status: Mandate['status'] = 'downgraded'): Mandate {
    const cur = this.getMandate(mandateId)
    if (!cur) throw new KernelError(makeProblem('ACCOUNT_NOT_BOUND', `no such mandate: ${mandateId}`))
    if (lvl(to) > lvl(cur.level)) throw bad(`downgrade target ${to} is not lower than ${cur.level}`)
    const { attestation: _a, ...rest } = cur
    const next: Omit<Mandate, 'attestation'> = { ...rest, version: cur.version + 1, level: to, status }
    if (lvl(to) < 3) delete next.heartbeat
    const m = this.sign(next, 'system')
    this.docs.put(MANDATES, mandateId, m, m.version)
    this.mandateOk.delete(mandateId)
    this.ledger.append({ type: 'mandate.downgraded', origin, subject: { mandateId: cur.mandateId }, payload: { from: cur.level, to: m.level, reason, version: m.version } })
    this.events.publish('mandate.changed', { mandateId, level: m.level, status: m.status })
    return m
  }

  /** 撤销只需会话。 */
  revokeMandate(mandateId: string, proof: HumanProof, origin: Origin): Mandate {
    assertProof(proof, 'session')
    const cur = this.getMandate(mandateId)
    if (!cur) throw new KernelError(makeProblem('ACCOUNT_NOT_BOUND', `no such mandate: ${mandateId}`))
    const { attestation: _a, ...rest } = cur
    const m = this.sign({ ...rest, version: cur.version + 1, status: 'revoked' }, 'session')
    this.docs.put(MANDATES, mandateId, m, m.version)
    this.mandateOk.delete(mandateId)
    this.ledger.append({ type: 'mandate.revoked', origin, subject: { mandateId: cur.mandateId }, payload: { version: m.version } })
    this.events.publish('mandate.changed', { mandateId, level: m.level, status: m.status })
    return m
  }

  // ---- 钥匙 ----------------------------------------------------------------------
  listKeys(): AgentKey[] { return this.docs.list<KeyDoc>(KEYS).map(({ secret: _s, ...k }) => k) }
  getKey(keyId: string): AgentKey | undefined { const k = this.docs.get<KeyDoc>(KEYS, keyId); if (!k) return undefined; const { secret: _s, ...rest } = k; return rest }

  /** 新建钥匙 + 授权书（四档之一）。令牌只在返回值里出现一次。需要 PIN。 */
  createKey(input: { name: string; host: AgentHost; tier: AgentPermissionTier; mandate: Omit<IssueMandateInput, 'subject' | 'level'>; expiresInDays?: number }, proof: HumanProof, origin: Origin): { key: AgentKey; mandate: Mandate; token: string } {
    assertProof(proof, 'pin')
    const name = String(input.name ?? '').trim()
    if (!name || name.length > 60) throw bad('key name must be 1-60 characters')
    const now = this.clock.now()
    const keyId = newId('ak', now)
    // 钥匙与授权书同一次创建，到期日必须一致：显式 expiresInDays 优先，否则沿用调用方给的 notAfter，最后才用默认天数。
    const expiresAt = input.expiresInDays !== undefined
      ? now + input.expiresInDays * DAY
      : input.mandate.notAfter ?? now + (this.opts.defaultExpiryDays ?? MANDATE_DEFAULTS.notAfterDays) * DAY
    const mandate = this.issueMandate({ ...input.mandate, subject: { type: 'agentKey', id: keyId }, level: DEFAULT_LEVEL_OF_TIER[input.tier], notAfter: expiresAt }, proof, origin)
    const { token, secret } = this.mintToken()
    const doc: KeyDoc = {
      keyId, name, host: input.host, mandateId: mandate.mandateId, status: 'active', createdAt: now,
      expiresAt, lastSeenAt: null, createdBy: 'user:usr_local', secret,
    }
    this.docs.put(KEYS, keyId, doc)
    this.ledger.append({ type: 'key.created', origin, subject: { mandateId: mandate.mandateId }, payload: { keyId, name, host: input.host, tier: input.tier, expiresAt: doc.expiresAt } })
    const { secret: _s, ...key } = doc
    return { key, mandate, token }
  }

  /** 轮换令牌（需要 PIN）。旧令牌立即失效。 */
  rotateKey(keyId: string, proof: HumanProof, origin: Origin): { key: AgentKey; token: string } {
    assertProof(proof, 'pin')
    const doc = this.docs.get<KeyDoc>(KEYS, keyId)
    if (!doc) throw new KernelError(makeProblem('ACCOUNT_NOT_BOUND', `no such key: ${keyId}`))
    const { token, secret } = this.mintToken()
    this.docs.put(KEYS, keyId, { ...doc, secret, status: 'active' })
    this.cache.clear()
    this.ledger.append({ type: 'key.rotated', origin, subject: { mandateId: doc.mandateId }, payload: { keyId } })
    const { secret: _s, ...key } = { ...doc, secret }
    return { key, token }
  }

  /** 吊销只需会话；同时撤销其授权书。 */
  revokeKey(keyId: string, proof: HumanProof, origin: Origin): AgentKey {
    assertProof(proof, 'session')
    const doc = this.docs.get<KeyDoc>(KEYS, keyId)
    if (!doc) throw new KernelError(makeProblem('ACCOUNT_NOT_BOUND', `no such key: ${keyId}`))
    if (doc.status !== 'revoked') {
      this.docs.put(KEYS, keyId, { ...doc, status: 'revoked' })
      this.cache.clear()
      this.ledger.append({ type: 'key.revoked', origin, subject: { mandateId: doc.mandateId }, payload: { keyId } })
      this.revokeMandate(doc.mandateId, proof, origin)
    }
    const { secret: _s, ...key } = { ...doc, status: 'revoked' as const }
    return key
  }

  private mintToken(): { token: string; secret: KeyDoc['secret'] } {
    const token = randomToken('gtk_')
    const salt = randomBytes(16)
    return { token, secret: { fp: sha256Hex(token).slice(0, 16), salt: salt.toString('base64'), hash: scryptSync(token, salt, 32, { N: 1 << 14, r: 8, p: 1 }).toString('base64') } }
  }

  /** 验证令牌（热路径：已验证缓存，不做 scrypt）。每次成功认证都算一次"存活"（心跳）。 */
  verifyToken(token: string): { keyId: string; mandateId: string } | null {
    if (!new RegExp(AGENT_TOKEN_PATTERN).test(token)) return null
    const now = this.clock.now()
    const fp = sha256Hex(token).slice(0, 16)
    let hit = this.cache.get(token)
    if (!hit) {
      for (const k of this.docs.list<KeyDoc>(KEYS)) {
        if (k.secret.fp !== fp) continue
        const h = scryptSync(token, Buffer.from(k.secret.salt, 'base64'), 32, { N: 1 << 14, r: 8, p: 1 }).toString('base64')
        if (safeEqual(h, k.secret.hash)) hit = { keyId: k.keyId, mandateId: k.mandateId }
        break
      }
      if (hit) this.cache.set(token, hit)
    }
    if (!hit) return null
    const k = this.docs.get<KeyDoc>(KEYS, hit.keyId)
    if (!k || k.status !== 'active' || k.expiresAt <= now || k.secret.fp !== fp) { this.cache.delete(token); return null }
    this.lastBeat.set(hit.mandateId, now)
    if (now - (this.lastSeenWrite.get(hit.keyId) ?? 0) > 30_000) { this.lastSeenWrite.set(hit.keyId, now); this.docs.put(KEYS, hit.keyId, { ...k, lastSeenAt: now }) }
    return hit
  }

  /** 令牌属于哪种状态；只在认证失败后给出更准的原因（只读，不新增放行）。scrypt 只在指纹命中某把钥匙时才跑。 */
  tokenStatus(token: string): 'active' | 'revoked' | 'expired' | 'unknown' {
    if (!new RegExp(AGENT_TOKEN_PATTERN).test(token)) return 'unknown'
    const fp = sha256Hex(token).slice(0, 16)
    for (const k of this.docs.list<KeyDoc>(KEYS)) {
      if (k.secret.fp !== fp) continue
      const h = scryptSync(token, Buffer.from(k.secret.salt, 'base64'), 32, { N: 1 << 14, r: 8, p: 1 }).toString('base64')
      if (!safeEqual(h, k.secret.hash)) return 'unknown'
      return k.status === 'revoked' ? 'revoked' : k.expiresAt <= this.clock.now() ? 'expired' : 'active'
    }
    return 'unknown'
  }

  /** mandate.heartbeat 工具：显式心跳。 */
  heartbeat(mandateId: string): { ok: true; at: number } {
    const now = this.clock.now()
    this.lastBeat.set(mandateId, now)
    return { ok: true, at: now }
  }

  // ---- 定时 ----------------------------------------------------------------------
  /** 到期 → 降到 L0（mandate.expired）；心跳超时 → 降级 + 接管（回调给接管服务）。 */
  tick(): { expired: string[]; heartbeatLost: string[] } {
    const now = this.clock.now()
    const out = { expired: [] as string[], heartbeatLost: [] as string[] }
    for (const m of this.listMandates()) {
      if (m.status !== 'active' && m.status !== 'downgraded') continue
      const sys = mkOrigin('system:mandate', 'mandate:tick', 'internal')
      if (now >= m.notAfter) {
        this.downgrade(m.mandateId, 'L0', 'mandate expired', sys, 'expired')
        this.ledger.append({ type: 'mandate.expired', origin: sys, subject: { mandateId: m.mandateId }, payload: { notAfter: m.notAfter } })
        out.expired.push(m.mandateId)
        continue
      }
      if (m.heartbeat && lvl(m.level) >= 3) {
        const last = this.lastBeat.get(m.mandateId) ?? now
        if (now - last > m.heartbeat.timeoutSec * 1000) {
          const to = m.heartbeat.onTimeout.downgradeTo
          this.downgrade(m.mandateId, lvl(to) < lvl(m.level) ? to : 'L0', `heartbeat timeout (${m.heartbeat.timeoutSec}s)`, sys)
          out.heartbeatLost.push(m.mandateId)
          this.onHeartbeatTimeout?.(m, m.heartbeat.onTimeout.takeover)
        }
      }
    }
    return out
  }
}
