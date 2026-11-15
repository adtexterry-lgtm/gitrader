// SPDX-License-Identifier: CPAL-1.0
// 内核自带的操作（人面 + 本机工具）。同一个操作既能经工作台 WS `/ui` 调（query / command，JSON-RPC 2.0，protocol 的 ui/wire.ts），
// 也能经 HTTP `POST /api/op/<name>` 调（CLI / E 的 Agent 面）。Agent 面的操作 / 路由由 E 在 api/index.ts 里注册。
//
// 人面专属动作的在场证明由 OpSpec.presence 在入口强制：session = 会话主体；pin = PIN（带失败退避）。缺在场证明回 1010 ATTESTATION_REQUIRED，
// 壳弹 PIN 层后带 attestation 重发；错误的 PIN 回 5003 AUTH_FAILED。Agent 主体（gtk_）在这里什么都调不了。
import { existsSync, lstatSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { DEFAULT_LEVEL_OF_TIER, MANDATE_DEFAULTS, MANDATE_LEVEL_RULES, RISK_PRESETS, TAKEOVER_LEVEL_INFO, asDecimal, makeProblem } from './proto'
import type { AgentPermissionTier, Instrument, ReconcileConfirmInput, ReconcileResolutionInput, RiskUsageItem, TakeoverLevel, TradingScope } from './proto'
import { checkMandateInput, mandateGaps } from './agents'
import type { IssueMandateInput } from './agents'
import { runAs, type InstanceCtx } from './strategy-instances'
import { writeTokenFile } from './token-file'
import { BOOT_TTL_MS, attestationRequired } from './auth'
import type { Kernel } from './kernel'
import type { OpContext, OpParams } from './api/router'
import type { WalletInfo } from './keystore'
import { isWeakPin, pinHint } from './pin'
import { BOM, localStamp } from './ledger'
import { limitsOfPreset, protectorsOfPreset, isLooser, dayStartTs } from './risk-policy'
import * as d from './util/dec'
import { ORG_SCOPE } from './trading-state'
import { KernelError } from './util/errors'
import { resolveConfinedPath } from './util/confined-path'
import { isWatchAccount } from './watch'
import { revokeAgentKeyFully } from './agent-revoke'

export const CANDLES_TIMEOUT_MS = 10_000
const EXPORT_INLINE_MAX = 50_000
const bad = (m: string): KernelError => new KernelError(makeProblem('INVALID_PARAMS', m))
const need = <T>(v: T | undefined | null, name: string): T => { if (v === undefined || v === null || v === '') throw bad(`${name} is required`); return v }
const plainObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype
const scopeOf = (p: OpParams): TradingScope => {
  const s = (p.scope ?? { type: 'org' }) as { type?: string; id?: string }
  if (!s.type) throw bad('scope.type is required')
  const id = s.id ?? (s.type === 'org' ? ORG_SCOPE.id : undefined)
  if (!id) throw bad(`scope.id is required for ${s.type}`)
  return { type: s.type as TradingScope['type'], id }
}
const safeName = (n: unknown): string => {
  const s = String(n ?? '')
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/.test(s)) throw bad('name must be 1-64 characters: letters, digits, space, . _ -')
  return s
}

const reconcileConfirmInput = (p: OpParams): ReconcileConfirmInput => {
  const fields = ['accountId', 'offerId', 'reportId', 'suggestionId', 'fee', 'feeCcy', 'liquidity', 'realizedPnl'] as const
  if (!p || typeof p !== 'object' || Array.isArray(p) || Object.keys(p).length !== fields.length
    || Object.keys(p).some((key) => !(fields as readonly string[]).includes(key))) {
    throw bad('confirmation requires exactly the eight reconciliation input fields')
  }
  for (const field of fields) if (typeof p[field] !== 'string' || p[field] === '') throw bad(`${field} is required`)
  const fee = p.fee as string
  const realizedPnl = p.realizedPnl as string
  try {
    const validFee = asDecimal(fee)
    asDecimal(realizedPnl)
    if (d.lt(d.D(validFee), d.ZERO)) throw bad('fee must be non-negative')
  } catch (error) {
    if (error instanceof KernelError) throw error
    throw bad('fee and realizedPnl must be decimal strings')
  }
  const feeCcy = p.feeCcy as string
  if (!/^[A-Z0-9]{1,20}$/.test(feeCcy)) throw bad('feeCcy must be 1-20 uppercase letters or digits')
  if (p.liquidity !== 'maker' && p.liquidity !== 'taker') throw bad('liquidity must be maker or taker')
  return {
    accountId: p.accountId as ReconcileConfirmInput['accountId'],
    offerId: p.offerId as string,
    reportId: p.reportId as string,
    suggestionId: p.suggestionId as string,
    fee: fee as ReconcileConfirmInput['fee'],
    feeCcy,
    liquidity: p.liquidity,
    realizedPnl: realizedPnl as ReconcileConfirmInput['realizedPnl'],
  }
}

export const keyInfo = (w: WalletInfo): { id: string; label: string; address: string; venue: string; network: 'mainnet' | 'testnet'; createdAt: number; expiresAt: number } =>
  ({ id: w.walletId, label: w.name, address: w.address, venue: w.venue, network: w.network, createdAt: w.createdAt, expiresAt: w.notAfter })

const READ_AGE = 3000 // 只读查询可接受的实盘账户快照年龄（ConnectorBus.READ_SNAPSHOT_MAX_AGE_MS）

/** 能交易的标的：status 存在且不是 live / trading 的丢掉；带 expiry / expiresAt 且已过点的（期权类）丢掉。 */
export function filterSearchHits(instruments: readonly Instrument[], now: number): Instrument[] {
  return instruments.filter((i) => {
    const status = (i as { status?: unknown }).status
    if (status !== undefined && status !== 'live' && status !== 'trading') return false
    const raw = i as unknown as Record<string, unknown>
    const expiry = raw['expiry'] ?? raw['expiresAt']
    if (typeof expiry === 'number' && Number.isFinite(expiry) && expiry <= now) return false
    if (typeof expiry === 'string' && expiry.trim() !== '') {
      const ts = Number(expiry)
      if (Number.isFinite(ts) && ts <= now) return false
    }
    // 名字里带到期日的合约（如 builder dex 的 BTC-29AUG25）：当天结束后算到期
    const dated = symbolExpiry(`${i.symbol ?? ''} ${i.displaySymbol ?? ''}`)
    if (dated !== undefined && dated + 86_400_000 <= now) return false
    return true
  })
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']
/** 名字里的 DDMMMYY 到期日（UTC 零点毫秒）；没有返回 undefined。 */
export function symbolExpiry(name: string): number | undefined {
  const m = /(?:^|[-_:/ ])(\d{1,2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(\d{2})(?:$|[-_ ])/.exec(name.toUpperCase())
  if (!m) return undefined
  return Date.UTC(2000 + Number(m[3]), MONTHS.indexOf(m[2]!), Number(m[1]))
}

/** 市场组名（dex）；主市场为空串。 */
const dexOf = (instrument: { marketGroup?: string | null }): string => (typeof instrument.marketGroup === 'string' ? instrument.marketGroup.trim() : '')

/** 列表项：非主市场带 dex，主市场不加该键。 */
const withDex = <T extends { marketGroup?: string | null }>(instrument: T): T & { dex?: string } => {
  const dex = dexOf(instrument)
  return dex === '' ? instrument : { ...instrument, dex }
}

/** 搜索命中的最小形状：非主市场带 dex，主市场不加该键。 */
const searchHit = (i: Instrument): { id: string; name: string; venue: string; dex?: string } => {
  const dex = dexOf(i)
  return { id: i.instrumentId, name: i.displaySymbol, venue: i.venue, ...(dex === '' ? {} : { dex }) }
}

export function registerCoreOps(k: Kernel): void {
  const q = (name: string, fn: (c: OpContext, p: OpParams) => unknown, auth: 'human' | 'session' | 'any' = 'human'): void => k.ops.register(name, { auth, kind: 'query' }, fn)
  const c = (name: string, spec: { auth?: 'human' | 'session' | 'service'; presence?: 'session' | 'pin' | 'session-or-pin'; allowSecretFields?: boolean | string[] }, fn: (c: OpContext, p: OpParams) => unknown): void =>
    k.ops.register(name, { auth: spec.auth === 'service' ? 'service' : 'session', kind: 'command', ...(spec.presence ? { presence: spec.presence } : {}), ...(spec.allowSecretFields ? { allowSecretFields: spec.allowSecretFields } : {}) }, fn)

  const hasLink = (root: string, target: string): boolean => {
    let current = resolve(root)
    const rel = relative(current, resolve(target))
    if (rel === '..' || rel.startsWith(`..${sep}`)) return true
    try { if (lstatSync(current).isSymbolicLink()) return true } catch { return false }
    for (const part of rel.split(sep).filter(Boolean)) {
      current = join(current, part)
      try { if (lstatSync(current).isSymbolicLink()) return true } catch { return false }
    }
    return false
  }
  // 接入请求入参：按档位校验 input.mandate（与 agentkey.create 能拿到的那部分校验同口径），中文缺项直接拒
  const validateRequestInput = (raw: unknown): unknown => {
    if (!raw || typeof raw !== 'object') throw bad('input is required')
    const input = raw as { tier?: unknown; mandate?: unknown }
    const level = DEFAULT_LEVEL_OF_TIER[input.tier as AgentPermissionTier]
    if (!level) throw bad(`unknown tier ${String(input.tier)}`)
    const mandate = { ...((input.mandate ?? {}) as Record<string, unknown>) }
    if (MANDATE_LEVEL_RULES[level]?.heartbeat === 'required' && !mandate['heartbeat']) mandate['heartbeat'] = MANDATE_DEFAULTS.heartbeat
    const full = { ...mandate, subject: { type: 'agentKey', id: 'ak_pending' }, level } as unknown as IssueMandateInput
    const now = k.clock.now()
    const problems = checkMandateInput(full, now)
    if (problems.length) {
      const gaps = mandateGaps(full, now)
      throw bad(gaps.length ? `接入请求的授权书还需要：${gaps.map((g) => g.zh).join('、')}（原文：invalid mandate: ${problems.join('; ')}）` : `invalid mandate: ${problems.join('; ')}`)
    }
    return raw
  }

  // ---------------------------------------------------------------- 设置（壳用，protocol ui/wire.ts）
  const network = (): 'mainnet' | 'testnet' => (k.config.venues[0]?.environment ?? 'testnet')
  q('settings.get', () => ({ network: network(), pinSet: k.pin.isSet(), agentLayout: k.settings.agentLayout(), keys: k.keystore.list().map(keyInfo) }))
  c('settings.network.set', { auth: 'session', presence: 'session' }, (x, p) => {
    const n = need(p.network, 'network') as string
    if (n !== 'mainnet' && n !== 'testnet') throw bad('network must be mainnet|testnet')
    // 主网默认关闭：先导入（或生成）一只主网 API 钱包。限额在风控策略里一直存在（默认预设）。
    if (n === 'mainnet' && !k.keystore.list().some((w) => w.status === 'active' && w.network === 'mainnet')) {
      throw new KernelError(makeProblem('VENUE_AUTH', 'mainnet stays off until an active mainnet API wallet is imported or generated'))
    }
    for (const v of k.config.venues) v.environment = n
    for (const a of k.config.accounts) if (!isWatchAccount(a)) a.environment = n // 观察账户保持自己的 environment，不跟网络开关走
    k.saveConfig()
    k.accounts.load(k.config)
    k.ledger.append({ type: 'annotation', origin: x.origin, subject: { orgId: 'org_local' }, payload: { setting: 'network', value: n } })
    return { network: n, restartRequired: true }
  })
  c('settings.agent_layout.set', { auth: 'session', presence: 'session' }, (x, p) => {
    k.settings.setAgentLayout(p.enabled === true)
    k.ledger.append({ type: 'annotation', origin: x.origin, subject: { orgId: 'org_local' }, payload: { setting: 'agent_layout', value: p.enabled === true } })
    return { agentLayout: p.enabled === true }
  })

  // ---------------------------------------------------------------- PIN 与凭据
  c('pin.set', { auth: 'session', allowSecretFields: ['pin'] }, async (x, p) => {
    const pin = String(need(p.pin, 'pin'))
    // fix-r4 C5：弱 PIN（连号 / 全相同）要调用方明确确认；CLI 走自己的 y/N 提示，不经此处。
    if (isWeakPin(pin) && p.confirmWeak !== true) throw bad('WEAK_PIN: 这个 PIN 容易被猜到（连号或全相同数字），仍要使用请带 confirmWeak 再确认一次')
    if (!k.pin.isSet()) {
      const proof = await k.auth.setupPin(x.principal, pin) // 首次设置：会话即可
      k.keystore.unlock(proof)
      const hint = pinHint(pin)
      return { ok: true, changed: false, ...(hint ? { hint } : {}) }
    }
    // 修改：attestation = 旧 PIN；密钥库用新主密钥重新加密
    if (!x.pin) throw attestationRequired('changing the PIN requires the current PIN')
    const ch = await k.auth.changePin(x.principal, x.pin, pin)
    k.keystore.rekey(ch.oldKey, ch.newKey)
    k.ledger.append({ type: 'annotation', origin: x.origin, subject: { orgId: 'org_local' }, payload: { setting: 'pin', changed: true } })
    const hint = pinHint(pin)
    return { ok: true, changed: true, ...(hint ? { hint } : {}) }
  })
  c('keystore.unlock', { presence: 'pin' }, (x) => {
    k.keystore.unlock(x.proof!)
    k.ledger.append({ type: 'session.unlocked', origin: x.origin, subject: { orgId: 'org_local' }, payload: { via: x.origin.via } })
    return { ok: true }
  })
  c('keystore.lock', {}, () => { k.keystore.lock(); return { ok: true } })

  /** 导入 / 生成凭据只要会话有效且密钥库已解锁（解锁本身走 PIN）：已解锁就不逐次弹 PIN；没解锁则 1010，带 attestation 重发时顺带解锁。 */
  const withKeystore = async (x: OpContext): Promise<ReturnType<Kernel['auth']['sessionProof']>> => {
    if (!k.keystore.isUnlocked()) {
      if (!k.pin.isSet()) throw bad('set a PIN first (pin.set)')
      k.keystore.unlock(await k.auth.pinProof(x.principal, x.pin, 'ui'))
      k.ledger.append({ type: 'session.unlocked', origin: x.origin, subject: { orgId: 'org_local' }, payload: { via: x.origin.via } })
    }
    return k.auth.sessionProof(x.principal, 'ui')
  }
  const net = (p: OpParams): 'mainnet' | 'testnet' => { const n = need(p.network, 'network') as string; if (n !== 'mainnet' && n !== 'testnet') throw bad('network must be mainnet|testnet'); return n }
  const ledgerKey = (x: OpContext, w: WalletInfo): void => { k.ledger.append({ type: 'key.created', origin: x.origin, subject: { orgId: 'org_local' }, payload: { walletId: w.walletId, address: w.address, name: w.name, kind: 'api-wallet', network: w.network } }) }
  c('credential.import', { auth: 'session', allowSecretFields: ['secret'] }, async (x, p) => {
    const proof = await withKeystore(x)
    const w = k.keystore.import(proof, { name: String(need(p.label, 'label')), privateKey: String(need(p.secret, 'secret')), network: net(p) })
    ledgerKey(x, w)
    return { key: keyInfo(w) }
  })
  c('credential.generate', { auth: 'session' }, async (x, p) => {
    const proof = await withKeystore(x)
    const w = k.keystore.generate(proof, { name: String(need(p.label, 'label')), network: net(p) })
    ledgerKey(x, w)
    return { key: keyInfo(w) } // 私钥不出内核，只回元数据
  })
  c('credential.revoke', { auth: 'session', presence: 'session' }, (x, p) => {
    const w = k.keystore.revoke(x.proof!, String(need(p.id, 'id')))
    k.ledger.append({ type: 'key.revoked', origin: x.origin, subject: { orgId: 'org_local' }, payload: { walletId: w.walletId, address: w.address } })
    return { key: keyInfo(w) }
  })
  c('session.logout', { auth: 'session', presence: 'session' }, (x) => {
    k.auth.revokeSession(x.principal)
    return { ok: true }
  })
  // 给已经在跑的实例补一条一次性启动链接（嵌入方 / 配方用）：要 PIN 在场——否则任何拿到 service.json 的本机进程都能自己换会话。
  // 令牌只在返回里出现一次，120 秒内有效、用一次作废。第一次运行（还没设 PIN）不提供：用 `gitrader serve` 终端里打印的链接。
  // ADR-5（fix-r1）：`gitrader open` 只要 PIN——人面主体（会话或 service 令牌）带 PIN 即可；不要求先 `session login`。
  k.ops.register('session.link', { auth: 'human', kind: 'command', presence: 'pin' }, () => {
    const token = k.auth.mintBootToken()
    return { url: `http://127.0.0.1:${k.http?.port ?? 0}/?launch=${token}`, expiresAt: k.auth.now() + BOOT_TTL_MS, ttlSec: BOOT_TTL_MS / 1000 }
  })
  // 无人值守的启动链接（UNIGIT 等宿主程序化取链接）：要求当前工作台会话，不要求 PIN，但**必须**先在配置里显式写了 embed.allowedOrigins，
  // 且调用方声明的宿主来源在名单里。安全含义：本机任何能取得当前会话的同用户进程都能换到一个新工作台会话（看得到全部数据、
  // 能做"会话级"动作如批准低于阈值的提案）；放宽风控 / 解锁钥匙库 / 签发授权书等 PIN 动作仍然要 PIN。名单为空时此路关闭。每次签发都入账。
  c('session.link.unattended', { auth: 'session' }, (x, p) => {
    const allowed = k.config.embed?.allowedOrigins ?? []
    const origin = typeof p.origin === 'string' ? p.origin.replace(/\/+$/, '') : ''
    if (allowed.length === 0) throw new KernelError(makeProblem('AUTH_FAILED', 'unattended links are off: set embed.allowedOrigins (gitrader config set embed.allowedOrigins <origin>) or use `gitrader open --print` with your PIN'))
    if (!origin || !allowed.includes(origin)) throw new KernelError(makeProblem('AUTH_FAILED', `host origin ${origin || '(none)'} is not in embed.allowedOrigins`))
    const token = k.auth.mintBootToken()
    k.ledger.append({ type: 'annotation', origin: x.origin, subject: { orgId: 'org_local' }, payload: { setting: 'session_link_unattended', origin } })
    return { url: `http://127.0.0.1:${k.http?.port ?? 0}/?launch=${token}`, expiresAt: k.auth.now() + BOOT_TTL_MS, ttlSec: BOOT_TTL_MS / 1000 }
  })
  c('service.rotateToken', { presence: 'pin' }, () => {
    k.auth.rotateServiceToken()
    k.auth.writeServiceFile({ port: k.http?.port ?? 0, pid: process.pid, startedAt: k.startedAt, version: String(k.status().version) })
    return { ok: true }
  })

  // fix-r4 C4：停服务。会话或 service 令牌即可，不要 PIN（停服务是收紧）；先写账再让 HTTP 回包送出，100 ms 后通知宿主走优雅关闭。
  k.ops.register('service.shutdown', { auth: 'human', kind: 'command' }, (x) => {
    k.ledger.append({ type: 'annotation', origin: x.origin, subject: { orgId: 'org_local' }, payload: { setting: 'service_shutdown' } })
    setTimeout(() => k.onShutdownRequest?.(), 100)
    return { ok: true }
  })

  // ---------------------------------------------------------------- 查询
  q('status', () => k.status())
  q('reconcile.status', (_c, p) => k.reconcileService.get(p.accountId === undefined ? undefined : String(p.accountId)))
  c('reconcile.refresh', { auth: 'session', presence: 'session' }, (_c, p) => k.reconcileService.refresh(String(need(p.accountId, 'accountId'))))
  c('reconcile.confirm', { auth: 'session', presence: 'pin' }, (x, p) => k.reconcileService.confirm(reconcileConfirmInput(p), x.actor))
  c('reconcile.resolve', { auth: 'session', presence: 'pin' }, (x, p) => k.reconcileService.resolve(p as unknown as ReconcileResolutionInput, x.actor))
  q('account.list', () => k.accounts.list())
  // account.summary 带 dayStartEquity（当日基线权益，dailyResetAt 时点；还没建立就以当前权益建立）
  q('account.summary', async (_c, p) => { const a = k.accounts.get(need(p.accountId, 'accountId')); const s = await k.bus.snapshot(a, { maxAgeMs: READ_AGE }); return { accountId: a.accountId, ts: s.ts, equity: s.equity, available: s.available, positions: s.positions.length, openOrders: s.openOrders.length, dayStartEquity: k.trading.dayBaseline(a, s.equity) } })
  q('account.positions', async (_c, p) => { const a = k.accounts.get(need(p.accountId, 'accountId')); return (await k.bus.snapshot(a, { maxAgeMs: READ_AGE })).positions })
  q('account.orders', (_c, p) => k.orders.list({ accountId: k.accounts.get(need(p.accountId, 'accountId')).accountId, openOnly: p.openOnly === true, limit: Number(p.limit ?? 100) }))
  q('account.fills', (_c, p) => k.orders.fills({ accountId: k.accounts.get(need(p.accountId, 'accountId')).accountId, limit: Number(p.limit ?? 100) }))
  q('market.instruments', (_c, p) => {
    const text = String(p.q ?? '').toLowerCase()
    return k.bus.instruments().filter((i) => (!p.venue || i.venue === p.venue) && (!text || i.instrumentId.toLowerCase().includes(text) || i.displaySymbol.toLowerCase().includes(text))).slice(0, Math.min(Number(p.limit ?? 200), 1000)).map(withDex)
  })
  q('instruments.search', (_c, p) => {
    const text = String(p.q ?? '').toLowerCase()
    const hits = filterSearchHits(k.bus.instruments(), Date.now()).filter((i) => !text || i.instrumentId.toLowerCase().includes(text) || i.displaySymbol.toLowerCase().includes(text)).slice(0, Math.min(Number(p.limit ?? 20), 100))
    return { hits: hits.map(searchHit) }
  })
  q('market.quote', (_c, p) => k.bus.mark(need(p.instrumentId, 'instrumentId')) ?? null)
  q('market.candles', async (_c, p) => {
    const id = String(need(p.instrumentId, 'instrumentId'))
    const src = k.bus.marketSource(id.slice(0, id.indexOf(':')))
    if (!src) throw new KernelError(makeProblem('CAPABILITY_UNSUPPORTED', 'no candle source'))
    // fix-r4 C8：场所限流排队 / 网络挂住时不无限等，10 s 回 DATA_UNAVAILABLE（界面据此出错误态 + 重试）。
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new KernelError(makeProblem('DATA_UNAVAILABLE', `market.candles timed out after ${CANDLES_TIMEOUT_MS} ms`))), CANDLES_TIMEOUT_MS) })
    try { return await Promise.race([src.candles(id, (p.interval ?? '15m') as never, { n: Math.min(Number(p.limit ?? 500), 5000) }), timeout]) } finally { clearTimeout(timer) }
  })
  q('market.book', async (_c, p) => { const id = String(need(p.instrumentId, 'instrumentId')); const src = k.bus.marketSource(id.slice(0, id.indexOf(':'))); return src ? src.book(id) : null })
  q('venue.status', () => k.bus.list().map((cn) => { const conn = k.venueConnection(cn.venue); return { ...k.bus.readStatus(cn.venue), connection: conn.state, readiness: conn.readiness, ...(conn.detail ? { connectionDetail: conn.detail } : {}) } }))
  // risk.state：三态 + 各限额的占用 usage[]（protocol block/payloads.ts RiskUsageItem：key / used / limit / unit / ratio / scope / window）
  q('risk.state', async () => {
    const eff = k.tstate.effective([ORG_SCOPE, ...k.accounts.list().map((a) => ({ type: 'account' as const, id: a.accountId }))])
    const pol = k.risk.current()
    return { tradingState: eff.state, reasons: eff.reasons, ...k.tstateList(), policyVersion: pol?.version, policy: pol ?? null, limits: k.risk.effectiveLimits(), integrity: k.risk.integrity, denyLlmLiveEntries: pol?.denyLlmLiveEntries !== false, presets: RISK_PRESETS, usage: await riskUsage(k), ts: k.clock.now() }
  })
  q('risk.verify', (_x, p) => p.precheckId ? k.risk.replay(String(p.precheckId)) : k.risk.verify())
  q('risk.replay', (_x, p) => k.risk.replay(String(need(p.precheckId, 'precheckId'))))
  // risk.stats 可按条目事件时间起点统计：sinceTs 只接受非负整数毫秒。
  q('risk.stats', (_c, p) => {
    const sinceTs = p.sinceTs
    if (sinceTs === undefined) return k.risk.stats()
    if (typeof sinceTs !== 'number' || !Number.isSafeInteger(sinceTs) || sinceTs < 0) throw bad('sinceTs must be a non-negative integer (epoch ms)')
    return k.risk.stats({ sinceTs })
  })
  q('risk.policy.export', () => k.risk.exportPolicy())
  q('risk.denials', (_c, p) => k.ledger.query({ types: ['risk.denied'], limit: Number(p.limit ?? 50), ...(p.accountId ? { accountId: String(p.accountId) } : {}) }))
  q('ledger.query', (_c, p) => k.ledger.query(p as never))
  q('ledger.trace', (_c, p) => k.ledger.trace(p as never))
  q('ledger.verify', () => k.ledger.verify())
  // 幂等查询：任何下单类操作都接受 clientOrderId 幂等键；调用超时后用它查结果而不是重发
  k.ops.register('order.lookup', { auth: 'any', kind: 'query' }, (x, p) => k.trading.lookup({ ...(p.clientOrderId ? { clientOrderId: String(p.clientOrderId) } : {}), ...(p.orderId ? { orderId: String(p.orderId) } : {}) }, x.actor))
  // 提案视图追加 approvalNeedsPin：批准这张票是否要 PIN（纸面账户批准不用 PIN；实盘、或名义超过 presenceAboveNotional 才要）。
  // 判断出错按 true 处理——宁可多要一次 PIN；approvalNeedsPin 之外的字段一律不动。
  const withApprovalNeedsPin = <T extends { proposalId: string }>(proposal: T): T & { approvalNeedsPin: boolean } => {
    let approvalNeedsPin = true
    try { approvalNeedsPin = k.trading.approvalNeedsPin(proposal.proposalId) } catch { approvalNeedsPin = true }
    return { ...proposal, approvalNeedsPin }
  }
  q('proposal.list', (_c, p) => k.trading.listProposals({ ...(p.status ? { status: String(p.status) } : {}), ...(p.limit ? { limit: Number(p.limit) } : {}) }).map(withApprovalNeedsPin))
  q('proposal.get', (_c, p) => {
    const proposal = k.trading.getProposal(String(need(p.id, 'id')))
    return proposal ? withApprovalNeedsPin(proposal) : null
  })
  q('mandate.list', () => k.agents.listMandates())
  q('agentkey.list', () => k.agents.listKeys())
  q('agentkey.request.list', () => ({ requests: k.agentRequests.list() }), 'session') // fix-r2 T1：ADR-13 写的是只认会话
  q('agentkey.request.status', (_x, p) => {
    const requestId = String(need(p.requestId, 'requestId'))
    const v = k.agentRequests.get(requestId)
    if (!v) throw bad('没有这个接入请求（可能内核重启过）')
    return v
  })
  // 工作台插件区：已装、校验通过、声明了块的插件 → 块清单（manifest = 清单里 ui.blocks 的该项；moduleUrl = 内核静态路由 /plugins/<id>/<entry.module>）
  // 集成修补（H，v2）：插件清单 ui.blocks[].manifest 写的是块清单文件路径（如 "./block.json"，plugin-template 就是这样）——
  // 原来把这条引用原样当块清单交给壳，壳校验不过、插件块永远不显示。现在读出插件目录内的块清单（不出目录），入口路径去掉 "./"。
  const blockManifestOf = (dir: string, b: Record<string, unknown>): Record<string, unknown> => {
    if (typeof b.manifest !== 'string') return b
    const p = resolve(dir, b.manifest)
    if (!(p === resolve(dir) || p.startsWith(resolve(dir) + sep)) || !existsSync(p)) return b
    try { const m = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>; return m && typeof m === 'object' ? m : b } catch { return b }
  }
  q('plugin.blocks', () => ({
    blocks: k.plugins.list().filter((r) => r.ok && r.manifest).flatMap((r) => ((r.manifest!.ui?.blocks ?? []) as (Record<string, unknown> | string)[]).flatMap((b0) => {
      if (typeof b0 === 'string' || !b0 || typeof b0.id !== 'string') return []
      const b = blockManifestOf(r.dir, b0)
      const mod = (b.entry as { module?: unknown } | undefined)?.module ?? (b0.entry as { module?: unknown } | undefined)?.module
      const rel = typeof mod === 'string' ? mod.replace(/^(\.\/)+/, '') : ''
      return [{ pluginId: r.id, id: b0.id, name: typeof b.name === 'string' ? b.name : typeof b0.name === 'string' ? b0.name : r.manifest!.name, manifest: b, moduleUrl: rel ? `/plugins/${encodeURIComponent(r.id)}/${rel.split('/').map(encodeURIComponent).join('/')}` : '', granted: r.granted, state: r.state }]
    })),
  }))
  q('plugin.list', () => k.plugins.list().map(({ manifest, ...r }) => ({ ...r, kind: manifest?.kind, name: manifest?.name, permissions: manifest?.permissions ?? [], ...(manifest?.license !== undefined ? { license: manifest.license } : {}) })))
  q('engine.list', () => k.engines.status().map((e) => ({ ...e, gep: k.gep.status().find((g) => g.engineId === e.id) ?? null })))
  q('engine.describe', (_x, p) => k.gep.describeOf(String(need(p.id, 'id'))) ?? null)
  q('config.get', () => k.config, 'session')
  q('paper.replay.status', () => k.replayStatus())
  c('paper.replay.start', { auth: 'session' }, (_ctx, p) => k.replayStart(p as never))
  c('paper.replay.stop', { auth: 'session' }, (_ctx, p) => k.replayStop(String(need(p.runId as string | undefined, 'runId'))))

  // ---------------------------------------------------------------- 工作区（壳用；落盘到 workspaces/）
  q('workspace.current', () => k.workspaces.current())
  q('workspace.list', () => ({ workspaces: k.workspaces.list() }))
  c('workspace.update', { auth: 'session' }, (x, p) => k.workspaces.update(need(p.workspace, 'workspace'), x.origin.actor))
  c('workspace.save', { auth: 'session' }, (x, p) => k.workspaces.save(safeName(p.name), need(p.workspace, 'workspace'), x.origin.actor, true))
  c('workspace.load', { auth: 'session' }, (_x, p) => k.workspaces.load(safeName(p.name)))
  c('workspace.revert', { auth: 'session', presence: 'session' }, () => k.workspaces.revert())

  // ---------------------------------------------------------------- 界面偏好（壳用；存在数据目录的内核库里，换端口不丢）
  // 只存界面偏好（配色 / 导航 / 密度等），不是交易事实，所以不写账本。
  q('ui.prefs.get', () => k.docs.get<Record<string, unknown>>('ui', 'prefs') ?? {})
  c('ui.prefs.set', { auth: 'session' }, (_x, p) => {
    const prefs = p.prefs
    if (!plainObj(prefs)) throw bad('偏好太大或格式不对')
    if (Buffer.byteLength(JSON.stringify(prefs), 'utf8') > 16 * 1024) throw bad('偏好太大或格式不对')
    k.docs.put('ui', 'prefs', prefs)
    return { ok: true }
  })

  // 集成修补（H）：内核重启后密钥库是锁着的，而工作台没有单独的"解锁"入口——实盘批准 / 接管 / 杀开关要签名时，
  // 先回 1010 ATTESTATION_REQUIRED（壳弹 PIN 层），带 PIN 重发时顺带解锁。否则批准会以 "keystore is locked" 失败、全平平不掉。
  const unlockForLive = async (x: OpContext, needed: boolean): Promise<void> => {
    if (!needed || k.keystore.isUnlocked() || !k.pin.isSet()) return
    if (!x.pin) throw attestationRequired('enter your PIN to unlock the keystore: live orders need the API wallet signature')
    k.keystore.unlock(await k.auth.pinProof(x.principal, x.pin, 'ui'))
    k.ledger.append({ type: 'session.unlocked', origin: x.origin, subject: { orgId: 'org_local' }, payload: { via: x.origin.via } })
  }
  const anyLive = (): boolean => k.accounts.list().some((a) => a.mode === 'live')

  // ---------------------------------------------------------------- 手动下单（人，仍过风控闸）
  c('paper.reset', { auth: 'human', presence: 'pin' }, (x, p) => k.resetPaper(String(need(p.accountId, 'accountId')), x.origin))
  const liveAccount = (id: unknown): boolean => k.accounts.get(String(id)).mode === 'live'
  c('order.place', { auth: 'session', presence: 'session-or-pin' }, async (x, p) => { const intent = need(p.intent, 'intent'); await unlockForLive(x, liveAccount(intent.accountId)); return k.trading.place({ intent }, x.actor) })
  c('order.cancel', { auth: 'session' }, async (x, p) => { await unlockForLive(x, liveAccount(p.accountId)); return k.trading.cancel(p as never, x.actor) })
  c('order.cancel_all', { auth: 'session' }, async (x, p) => { await unlockForLive(x, liveAccount(p.accountId)); return k.trading.cancelAll(p as never, x.actor) })
  c('position.close', { auth: 'session', presence: 'session-or-pin' }, async (x, p) => { await unlockForLive(x, liveAccount(p.accountId)); return k.trading.closePosition(p as never, x.actor) })

  // ---------------------------------------------------------------- 提案：批准 / 拒绝只有人面
  c('proposal.approve', { auth: 'session' }, async (x, p) => {
    const id = String(need(p.id, 'id'))
    const prop = k.trading.getProposal(id)
    if (prop) await unlockForLive(x, k.accounts.get(String(prop.accountId)).mode === 'live')
    // 名义额超过授权书 presenceAboveNotional 时必须 PIN；否则会话即可
    const proof = k.trading.approvalNeedsPin(id) ? await k.auth.pinProof(x.principal, x.pin, 'ui') : k.auth.sessionProof(x.principal, 'ui')
    return k.trading.approve(id, proof, x.actor, p.note as string | undefined)
  })
  c('proposal.reject', { auth: 'session', presence: 'session' }, (x, p) => k.trading.reject(String(need(p.id, 'id')), x.proof!, x.actor, p.note as string | undefined))

  // ---------------------------------------------------------------- 接管三档 / 杀开关 / 恢复
  for (const level of Object.keys(TAKEOVER_LEVEL_INFO) as TakeoverLevel[]) {
    const spec = level === 'flatten_all' ? { auth: 'session' as const, presence: 'pin' as const } : {}
    c(`takeover.${level}`, spec, async (x, p) => { if (level !== 'halt_new') await unlockForLive(x, anyLive()); return k.takeover.execute({ level, scope: scopeOf(p), reason: String(need(p.reason, 'reason')), ...(p.keepProtective !== undefined ? { keepProtective: p.keepProtective === true } : {}) }, x.actor) })
  }
  k.ops.register('kill', { auth: 'human', kind: 'command' }, (x, p) => k.takeover.kill(String(need(p.reason, 'reason')), x.actor))
  c('trading_state.resume', { presence: 'pin' }, (x, p) => k.takeover.resume(scopeOf(p), String(p.reason ?? 'resume by user'), x.proof!, x.actor))
  c('risk.resume', { presence: 'pin' }, (x, p) => k.takeover.resume(scopeOf(p), String(p.reason ?? 'resume by user'), x.proof!, x.actor)) // 旧名别名，保留一个版本；以 trading_state.resume 为准
  // 状态条网络卡的“重连”按钮：立刻重试该场所的后台连接（退避从头算）
  c('venue.reconnect', {}, (_x, p) => k.reconnect(String(need(p.venue, 'venue'))))

  // ---------------------------------------------------------------- 风控：收紧会话即可，放宽 PIN
  c('risk.tighten', { auth: 'session', presence: 'session' }, (x, p) => k.risk.tighten(need(p.patch, 'patch') as never, x.proof!, x.origin))
  c('risk.relax', { auth: 'human', presence: 'pin' }, (x, p) => k.risk.relax(need(p.patch, 'patch') as never, x.proof!, x.origin))
  c('risk.temporaryRelax', { presence: 'pin' }, (x, p) => k.risk.temporaryRelax(need(p.fields, 'fields') as never, Number(need(p.until, 'until')), x.proof!, x.origin))
  c('risk.setLlmLiveEntries', { auth: 'human' }, async (x, p) => {
    // 开 = 收紧（会话）；关 = 放宽（PIN，入账 policy.relaxed）
    const deny = p.deny !== false
    const proof = deny ? k.auth.sessionProof(x.principal, 'ui') : await k.auth.pinProof(x.principal, x.pin, 'ui')
    return k.risk.setDenyLlmLiveEntries(deny, proof, x.origin)
  })
  c('risk.preset', { auth: 'human' }, async (x, p) => {
    const id = String(need(p.presetId, 'presetId'))
    const cur = k.risk.current()
    if (!RISK_PRESETS.some((r) => r.id === id)) throw bad(`unknown preset ${id}`)
    if (!cur) throw bad('no policy loaded')
    const limits = limitsOfPreset(id)
    const next = { limits: { ...cur.limits, ...limits }, protectors: protectorsOfPreset(id), failClosed: cur.failClosed, dailyResetAt: cur.dailyResetAt }
    const loosens = isLooser(next, cur).length > 0
    const proof = loosens ? await k.auth.pinProof(x.principal, x.pin, 'ui') : k.auth.sessionProof(x.principal, 'ui')
    const patch = { limits: limits as never, protectors: next.protectors }
    return loosens ? k.risk.relax(patch, proof, x.origin) : k.risk.tighten(patch, proof, x.origin)
  })

  // ---------------------------------------------------------------- Agent 钥匙与授权书（人面）
  c('agentkey.create', { presence: 'pin' }, (x, p) => {
    k.assertNotHalted('creating an agent key')
    const r = k.agents.createKey(need(p.input ?? p, 'input') as never, x.proof!, x.origin)
    // tokenFile = true：令牌只落盘，返回值去掉 token，只给路径
    if (p.tokenFile !== true) return r
    const tokenFilePath = writeTokenFile(k.home, r.key.name, r.token)
    const { token: _token, ...rest } = r
    return { ...rest, tokenFilePath }
  })
  // 接入请求：agent 主体发起 → 人在浏览器输 PIN 批准（令牌只在批准时生成并落盘）
  // ADR-13：service（本机 CLI / Agent）或会话都可发起；只登记待批请求，批准仍要会话 + PIN。B3 的 c() 把 human 收成 session，这里直接注册。
  k.ops.register('agentkey.request', { auth: 'human', kind: 'command' }, (_x, p) => {
    const input = validateRequestInput(need(p.input, 'input'))
    k.assertNotHalted('creating an agent key')
    return k.agentRequests.create(input)
  })
  c('agentkey.request.approve', { auth: 'session', presence: 'pin' }, (x, p) => {
    const requestId = String(need(p.requestId, 'requestId'))
    const req = k.agentRequests.get(requestId)
    if (!req) throw bad('没有这个接入请求（可能内核重启过）')
    if (req.state !== 'pending') throw bad(`接入请求不是待批准状态（当前 ${req.state}）`)
    k.assertNotHalted('creating an agent key')
    const r = k.agents.createKey(req.input as never, x.proof!, x.origin)
    const tokenFilePath = writeTokenFile(k.home, r.key.name, r.token)
    k.agentRequests.settle(requestId, { state: 'approved', keyId: r.key.keyId, tokenFilePath })
    return { requestId, keyId: r.key.keyId, tokenFilePath, name: r.key.name }
  })
  c('agentkey.request.reject', { auth: 'session', presence: 'session' }, (_x, p) => {
    const requestId = String(need(p.requestId, 'requestId'))
    const note = p.note === undefined || p.note === null ? undefined : String(p.note)
    if (note !== undefined && note.length > 200) throw bad('note must be at most 200 characters')
    return k.agentRequests.settle(requestId, { state: 'rejected', ...(note ? { note } : {}) })
  })
  c('agentkey.rotate', { presence: 'pin' }, (x, p) => k.agents.rotateKey(String(need(p.keyId, 'keyId')), x.proof!, x.origin))
  // fix-r4 C6：撤 Agent 钥匙与 CLI 一致，要 PIN（改前 presence 为 session，网页一点就撤）。
  c('agentkey.revoke', { auth: 'session', presence: 'pin' }, (x, p) => {
    const r = revokeAgentKeyFully(k, String(need(p.keyId, 'keyId')), x.proof!, x.origin)
    // 原字段保持在顶层（向后兼容），另加作废票号与名下遗留计数。
    return { ...r.key, withdrawn: r.withdrawn, openPositions: r.openPositions, openOrders: r.openOrders }
  })
  c('mandate.update', { presence: 'pin' }, (x, p) => { k.assertNotHalted('issuing a mandate'); return k.agents.issueMandate(need(p.input, 'input') as never, x.proof!, x.origin, String(need(p.mandateId, 'mandateId'))) })
  c('mandate.revoke', { auth: 'session', presence: 'session' }, (x, p) => k.agents.revokeMandate(String(need(p.mandateId, 'mandateId')), x.proof!, x.origin))

  // ---------------------------------------------------------------- 插件 / 引擎
  c('notify.test', {}, (_x, p) => {
    if (typeof p.channelId !== 'string' || !p.channelId) throw bad('channelId is required')
    return k.notify.test(p.channelId)
  })
  c('plugin.reload', {}, () => k.plugins.reload())
  // 新增 / 放宽权限要 PIN（裁决 10）：只收窄或启用（含空数组）不变。静态要求仍是会话；带 PIN 重发时在这里升级在场证明。
  c('plugin.grant', { auth: 'session', presence: 'session' }, async (x, p) => {
    const id = String(need(p.id, 'id'))
    const permissions = need(p.permissions, 'permissions') as unknown[]
    const granted = (k.plugins.get(id)?.granted ?? []) as readonly unknown[]
    const added = permissions.filter((perm) => !granted.includes(perm))
    let proof = x.proof!
    if (added.length && proof.presence !== 'pin') {
      if (!x.pin) throw attestationRequired(`adding plugin permissions requires a PIN (new: ${added.join(', ')})`)
      proof = await k.auth.pinProof(x.principal, x.pin, 'ui')
    }
    return k.plugins.grant(id, permissions as never, proof, x.origin)
  })
  c('plugin.uninstall', { auth: 'session', presence: 'session' }, async (x, p) => { await k.plugins.uninstall(String(need(p.id, 'id')), x.proof!); return { ok: true } })
  c('plugin.call', {}, (_x, p) => { k.assertNotHalted('plugin tool call'); return k.plugins.callTool(String(need(p.id, 'id')), String(need(p.tool, 'tool')), p.args) })
  c('plugin.start', {}, async (_x, p) => { k.assertNotHalted('starting a plugin'); await k.plugins.start(String(need(p.id, 'id'))); return { ok: true } })
  c('plugin.stop', {}, async (_x, p) => { await k.plugins.stop(String(need(p.id, 'id'))); return { ok: true } })
  // 引擎绑定（人面 + PIN）：把引擎绑到若干账户（每个账户一份主体是该引擎的授权书）。绑定不给权限，权限永远是授权书 + 风控闸。
  c('engine.bind', { presence: 'pin' }, (x, p) => {
    const id = String(need(p.id, 'id'))
    if (!k.engines.has(id)) throw bad(`unknown engine ${id} (configured: ${k.engines.ids().join(', ') || 'none'})`)
    // 集成修补（H）：accounts 里的条目可以只写账户（id / 别名字符串）：只对纸面账户，内核用这次的 PIN 证明给引擎签一份 L1（纸面）授权书。
    // 实盘账户必须带人另签的 {accountId, mandateId}——绑定从不放大权限。
    const accounts = (need(p.accounts, 'accounts') as unknown[]).map((a) => {
      if (a && typeof a === 'object') return a as { accountId: string; mandateId: string }
      const acct = k.accounts.get(String(a))
      if (acct.mode !== 'paper') throw bad(`account ${acct.alias} is ${acct.mode}: bind it with an explicit engine mandate ({accountId, mandateId})`)
      const m = k.agents.issueMandate({ subject: { type: 'engine', id }, level: 'L1', accounts: [acct.accountId] } as never, x.proof!, x.origin)
      return { accountId: acct.accountId, mandateId: m.mandateId }
    })
    return k.gep.bind(id, { accounts: accounts as never, instruments: (p.instruments ?? []) as string[], ...(p.replaceLive === true ? { replaceLive: true } : {}) }, x.proof!, x.origin)
  })
  // 策略 / 回测 / 回放：转给引擎（白名单方法；实盘账户上起策略要走提案）
  c('engine.call', { auth: 'session' }, (x, p) => {
    const id = String(need(p.id, 'id'))
    const method = String(need(p.method, 'method'))
    const ctx: InstanceCtx = { owner: { kind: 'human', actor: x.origin.actor }, origin: x.origin }
    if (method === 'strategy.update') return runAs(ctx, () => k.gep.callStrategyUpdate(id, (p.params ?? {}) as never, () => k.auth.pinProof(x.principal, x.pin)))
    if (method.startsWith('strategy.start')) k.assertNotHalted('starting a strategy')
    if (method === 'strategy.start' || method === 'strategy.stop' || method === 'strategy.update') return runAs(ctx, () => k.gep.callEngine(id, method, (p.params ?? {}) as never))
    return k.gep.callEngine(id, method, (p.params ?? {}) as never)
  })
  c('engine.start', {}, (_x, p) => { k.assertNotHalted('starting an engine'); k.engines.start(String(need(p.id, 'id'))); return { ok: true } })
  c('engine.stop', {}, async (_x, p) => { await k.engines.stop(String(need(p.id, 'id'))); return { ok: true } })

  c('lab.stage', { auth: 'session', presence: 'pin' }, (x, p) => k.lab.stage(String(p.experimentId ?? p.id), p.to, x.actor, x.proof))
  c('lab.attach', { auth: 'session', presence: 'session' }, (x, p) => k.lab.handle('attach', { experimentId: String(need(p.experimentId ?? p.id, 'experimentId')), attach: p.attach }, x.actor))
  c('lab.pack', { auth: 'session', presence: 'session' }, (x, p) => k.lab.handle('pack', {
    experimentId: String(need(p.experimentId ?? p.id, 'experimentId')),
    pack: { runId: need(p.runId, 'runId'), ...(p.note !== undefined ? { note: p.note } : {}) },
    ...(p.holdoutWindow !== undefined ? { holdoutWindow: p.holdoutWindow } : {}),
  }, x.actor))
  q('lab.export', (_x, p) => k.lab.export(String(need(p.experimentId ?? p.id, 'experimentId'))))
  q('lab.verify', (_x, p) => {
    let bundle = p.bundle ?? p.data
    if (bundle === undefined && p.file !== undefined) {
      try {
        const root = join(k.home, 'lab')
        const file = resolveConfinedPath(root, String(p.file), { anchorRoot: k.home, mustExist: true })
        if (hasLink(root, file) || !statSync(file).isFile() || statSync(file).size > 8 * 1024 * 1024) throw new Error('invalid file')
        bundle = JSON.parse(readFileSync(file, 'utf8'))
      } catch { throw bad('Invalid experiment export input') }
    }
    if (bundle === undefined) throw bad('bundle, data, or file is required')
    return k.lab.verify(bundle)
  })

  // ---------------------------------------------------------------- 账本 / 笔记
  c('ledger.export', { auth: 'session', presence: 'session' }, (x, p) => {
    const root = join(k.home, 'exports')
    let dir: string
    try {
      // fix-r4 C3：默认目录名用本地时间 gitrader-ledger-YYYYMMDD-HHmmss，重名加 -2、-3…
      let input = ''
      if (p.dir) input = String(p.dir)
      else {
        const base = `gitrader-ledger-${localStamp(k.clock.now(), true)}`
        input = base
        for (let n = 2; existsSync(join(root, input)); n++) input = `${base}-${n}`
      }
      dir = resolveConfinedPath(root, input, { anchorRoot: k.home })
      const rel = relative(root, dir)
      for (const name of ['ledger.jsonl', 'manifest.json', 'trade-log.md', '账单.csv']) {
        const output = resolveConfinedPath(root, join(rel, name), { anchorRoot: k.home })
        if (existsSync(output) && lstatSync(output).isSymbolicLink()) throw new Error('invalid output')
      }
    } catch { throw bad('Invalid ledger export destination') }
    // fix-r3 P1-15：回包追加落盘目录 dir（界面 toast 写完整路径）
    const m = k.ledger.export({ dir, exportedBy: x.origin, markdown: p.markdown !== false, ...(p.redaction ? { redaction: p.redaction as never } : {}), ...(p.fromSeq !== undefined ? { fromSeq: Number(p.fromSeq) } : {}), ...(p.toSeq !== undefined ? { toSeq: Number(p.toSeq) } : {}) })
    const res = { ...m, dir, billName: `gitrader-账单-${localStamp(m.exportedAt)}.csv` }
    // fix-r4 C3：界面要 inline 内容用来下载（CSV 无 BOM，前端补）；条数过大只写盘。
    if (p.inline !== true || m.count > EXPORT_INLINE_MAX) return res
    const bill = join(dir, '账单.csv')
    return { ...res, inline: true as const, files: { bill: existsSync(bill) ? readFileSync(bill, 'utf8').replace(BOM, '') : '', manifest: readFileSync(join(dir, 'manifest.json'), 'utf8') } }
  })
  c('ledger.checkpoint', {}, () => k.ledger.checkpoint())
  c('note.add', {}, (x, p) => k.ledger.append({ type: 'note', origin: x.origin, subject: { orgId: 'org_local', ...(p.accountId ? { accountId: String(p.accountId) as never } : {}) }, payload: { text: String(need(p.text, 'text')).slice(0, 4000) } }))
}

/** 限额占用（每个账户、每项有限额的维度）。used / limit 是十进制字符串；ratio = used / limit（limit 为 0 时省略）。 */
async function riskUsage(k: Kernel): Promise<RiskUsageItem[]> {
  const out: RiskUsageItem[] = []
  const lim = k.risk.effectiveLimits() as unknown as Record<string, unknown>
  const now = k.clock.now()
  const dayStart = dayStartTs(now, k.risk.current()?.dailyResetAt ?? '00:00Z')
  const item = (key: RiskUsageItem['key'], used: d.Dec, limit: unknown, unit: string, scope: string, window: RiskUsageItem['window']): void => {
    if (limit === undefined || limit === null) return
    const l = d.D(limit as string | number)
    out.push({ key, used: d.str(used), limit: d.str(l), unit, ...(d.gt(l, d.ZERO) ? { ratio: d.str(d.div(used, l, 6)) } : {}), scope, ...(window ? { window } : {}) })
  }
  for (const a of k.accounts.list()) {
    const scope = `account:${a.alias}`
    let snap
    try { snap = await k.bus.snapshot(a, { maxAgeMs: READ_AGE }) } catch { continue } // 场所不可达：这个账户的占用先不报
    const equity = d.D(snap.equity)
    const notionals = snap.positions.map((p) => d.D(p.notional))
    const total = notionals.reduce((s, n) => d.add(s, n), d.ZERO)
    const ratioOf = (x: d.Dec): d.Dec => (d.gt(equity, d.ZERO) ? d.div(x, equity, 6) : d.ZERO)
    item('maxLeverage', snap.positions.reduce((m, p) => d.max(m, d.D(p.leverage)), d.ZERO), lim.maxLeverage, 'x', scope, 'now')
    item('maxPositionNotionalRatio', notionals.reduce((m, n) => d.max(m, ratioOf(n)), d.ZERO), lim.maxPositionNotionalRatio, 'ratio', scope, 'now')
    item('maxTotalNotionalRatio', ratioOf(total), lim.maxTotalNotionalRatio, 'ratio', scope, 'now')
    item('maxOpenPositions', d.D(snap.positions.length), lim.maxOpenPositions, 'count', scope, 'now')
    const base = d.D(k.trading.dayBaseline(a, snap.equity))
    item('maxDailyLossRatio', d.gt(base, d.ZERO) ? d.max(d.ZERO, d.div(d.sub(base, equity), base, 6)) : d.ZERO, lim.maxDailyLossRatio, 'ratio', scope, 'day')
    item('maxDailyNotional', k.orders.notionalSince(a.accountId, dayStart), lim.maxDailyNotional, a.paper?.ccy ?? 'USDC', scope, 'day')
    item('maxDailyOrders', d.D(k.orders.countSince(a.accountId, dayStart)), lim.maxDailyOrders, 'count', scope, 'day')
    item('maxOrdersPerMinute', d.D(k.orders.countSince(a.accountId, now - 60_000)), lim.maxOrdersPerMinute, 'count', scope, 'minute')
    item('maxCancelsPerMinute', d.D(k.trading.cancelsLastMinute(a.accountId)), lim.maxCancelsPerMinute, 'count', scope, 'minute')
  }
  return out
}
