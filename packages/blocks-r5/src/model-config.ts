// SPDX-License-Identifier: CPAL-1.0
// P9 设置页（交易所 / 通知）的纯逻辑：把 config.view 规整成行、拼 config.venues.set / config.notify.set 的补丁、判定哪些改动属于「放宽」（内核要 PIN）。
// 无 DOM、无 preact。内核回的文案一律原样，这里只做分类与拼补丁；界面永远拿不到密钥值（config.view 只给句柄名与是否就位）。
import type { ConfigAccountView, ConfigNotifyView, ConfigVenueView, ConfigView, VenueCatalogEntry } from '@gitrader/protocol'
import { t as tr } from '@gitrader/workbench/i18n'
import { connOf } from '../../blocks-default/src/model-risk'

export type Level = 'info' | 'warn' | 'critical'
export const LEVELS: readonly Level[] = ['info', 'warn', 'critical']
export const LEVEL_LABEL: Record<Level, string> = { info: tr('信息'), warn: tr('警告'), critical: tr('紧急') }

/** 内核 config.ts 同一条正则：凭据只许 env:VAR 句柄。 */
export const HANDLE_RE = /^env:[A-Za-z_][A-Za-z0-9_]*$/
export const isHandle = (v: string): boolean => HANDLE_RE.test(v)
/** 内核「每家只许一个实盘」的场所集合（config.ts singleLiveVenues）。 */
export const SINGLE_LIVE_VENUES: ReadonlySet<string> = new Set(['binance', 'okx', 'bybit', 'bitget', 'gateio', 'alpaca', 'ibkr'])
/** 未验证场所的主网禁用原因（与状态条同一常量）。 */
export const UNVERIFIED_WHY = tr('未经真网验证，仅限测试网 / 模拟盘')
/** 改完配置后内核回 restartRequired：行常驻「待重启」+ 复制这条命令（与连接页同一条）。 */
export const RESTART_CMD = 'gitrader serve'

export const VENUE_NAME: Record<string, string> = {
  hyperliquid: 'Hyperliquid', binance: 'Binance', okx: 'OKX', bitget: 'Bitget', bybit: 'Bybit', coinbase: 'Coinbase', gateio: 'Gate.io', alpaca: 'Alpaca', ibkr: 'IBKR',
}
export const venueName = (id: string): string => VENUE_NAME[id] ?? id

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

// ---- config.view 规整 ---------------------------------------------------------------------------------------------

export type Normalized = { ok: true; config: ConfigView } | { ok: false; missing: string; failure?: string }

/** 缺本单登记的字段 = 未接通（原文写字段名），不猜、不补。 */
export function normalizeConfig(raw: unknown): Normalized {
  if (!isRec(raw)) return { ok: false, missing: 'config.view' }
  // 回包是 ok:false = 失败（G3：不以没抛错当成功），原文照给
  if (raw.ok === false) { const e = isRec(raw.error) ? raw.error : isRec(raw.problem) ? raw.problem : {}; return { ok: false, missing: 'config.view', failure: typeof e.message === 'string' ? e.message : 'config.view' } }
  for (const key of ['venues', 'accounts', 'handles', 'catalog'] as const) if (!Array.isArray(raw[key])) return { ok: false, missing: key }
  if (!isRec(raw.notify) || !Array.isArray(raw.notify.channels)) return { ok: false, missing: 'notify.channels' }
  return { ok: true, config: raw as unknown as ConfigView }
}

export const catalogOf = (config: ConfigView, id: string): VenueCatalogEntry | undefined => config.catalog.find((c) => c.venue === id)
export const accountsOf = (config: ConfigView, venue: string): ConfigAccountView[] => config.accounts.filter((a) => a.venue === venue)
export const liveAccountOf = (config: ConfigView, venue: string): ConfigAccountView | undefined => config.accounts.find((a) => a.venue === venue && a.mode === 'live')

// ---- 连接状态（venue.status）--------------------------------------------------------------------------------------

export interface ConnInfo { state: 'connected' | 'connecting' | 'disconnected'; detail?: string; p50?: number }
export function parseVenueStatus(raw: unknown): Record<string, ConnInfo> {
  const list = Array.isArray(raw) ? raw : isRec(raw) && Array.isArray(raw.venues) ? raw.venues : []
  const out: Record<string, ConnInfo> = {}
  for (const item of list) {
    if (!isRec(item)) continue
    const id = typeof item.venue === 'string' ? item.venue : typeof item.id === 'string' ? item.id : ''
    if (!id) continue
    const state = connOf(item) ?? 'disconnected' // UX-10：与顶栏同一个取值规则（connection 与 wsState 取更差的）
    const lat = isRec(item.latencyMs) && typeof item.latencyMs.p50 === 'number' ? item.latencyMs.p50 : undefined
    out[id] = { state, ...(typeof item.connectionDetail === 'string' && item.connectionDetail ? { detail: item.connectionDetail } : {}), ...(lat !== undefined ? { p50: Math.round(lat) } : {}) }
  }
  return out
}
export const CONN_LABEL: Record<ConnInfo['state'], string> = { connected: tr('已连接'), connecting: tr('连接中'), disconnected: tr('已断开') }

// ---- 场所 / 账户 / 可接入 行 ----------------------------------------------------------------------------------------

export interface VenueRow {
  id: string; name: string; kind: 'trading' | 'data'; verified: boolean
  environment: ConfigVenueView['environment']; enabled: boolean; accounts: number; conn?: ConnInfo
}
export function venueRows(config: ConfigView, status: Record<string, ConnInfo> = {}): VenueRow[] {
  return config.venues.map((v) => {
    const cat = catalogOf(config, v.id)
    return {
      id: v.id, name: venueName(v.id), kind: cat?.kind ?? 'trading', verified: cat?.verified === true,
      environment: v.environment, enabled: v.enabled, accounts: accountsOf(config, v.id).length, ...(status[v.id] ? { conn: status[v.id]! } : {}),
    }
  })
}

/** 可接入 = 连接器目录里还没配置成场所的条目。 */
export const availableCatalog = (config: ConfigView): VenueCatalogEntry[] => config.catalog.filter((c) => !config.venues.some((v) => v.id === c.venue))

export interface CredRow { key: string; handle: string; state: 'ready' | 'missing' | 'unknown'; path: string }
/** 一个账户的凭据行：只有句柄名与是否就位。signerRef 是钥匙库里的名字，内核没回就位状态 → unknown（不替它说「已就位」）。 */
export function credentialRows(config: ConfigView, accountIndex: number): CredRow[] {
  const a = config.accounts[accountIndex]
  if (!a) return []
  const rows: CredRow[] = Object.entries(a.credentials ?? {}).map(([key, handle]) => {
    const path = `accounts[${accountIndex}].credentials.${key}`
    const h = config.handles.find((x) => x.path === path)
    return { key, handle, path, state: h ? (h.resolved ? 'ready' : 'missing') : 'unknown' }
  })
  if (a.signerRef) rows.unshift({ key: 'signerRef', handle: `keystore:${a.signerRef}`, path: `accounts[${accountIndex}].signerRef`, state: 'unknown' })
  return rows
}

// ---- 补丁（整段替换数组）------------------------------------------------------------------------------------------------

export type VenuesPatch = { venues?: ConfigVenueView[]; accounts?: ConfigAccountView[] }
const venuesOf = (c: ConfigView): ConfigVenueView[] => c.venues.map((v) => ({ ...v, ...(v.symbols ? { symbols: [...v.symbols] } : {}) }))
const accountsCopy = (c: ConfigView): ConfigAccountView[] => structuredClone(c.accounts)

export const patchVenueEnabled = (c: ConfigView, id: string, enabled: boolean): VenuesPatch => ({ venues: venuesOf(c).map((v) => (v.id === id ? { ...v, enabled } : v)) })
export const patchVenueEnv = (c: ConfigView, id: string, environment: ConfigVenueView['environment']): VenuesPatch => ({ venues: venuesOf(c).map((v) => (v.id === id ? { ...v, environment } : v)) })
/** 接入目录里的场所：以测试网加入并启用；是否放宽由 gate 判（交易类启用 = 放宽）。 */
export const patchAttachVenue = (c: ConfigView, id: string): VenuesPatch => ({ venues: [...venuesOf(c), { id, environment: 'testnet', enabled: true }] })
export const patchDeleteAccount = (c: ConfigView, index: number): VenuesPatch => ({ accounts: accountsCopy(c).filter((_, i) => i !== index) })
type Money = NonNullable<ConfigAccountView['paper']>['initialBalance']
/** UX-24：新纸面账户的计价币跟同一交易所已有的纸面账户走；没有就按交易所的结算币（Hyperliquid 是 USDC），其余 USDT。 */
export const paperCcyFor = (c: ConfigView, venue: string): string =>
  c.accounts.find((x) => x.venue === venue && x.paper?.ccy)?.paper?.ccy ?? (venue === 'hyperliquid' ? 'USDC' : 'USDT')
export function patchAddAccount(c: ConfigView, a: { alias: string; venue: string; mode: 'paper' | 'live'; initialBalance?: string; ccy?: string }): VenuesPatch {
  const environment = c.venues.find((v) => v.id === a.venue)?.environment ?? 'testnet'
  const next: ConfigAccountView = a.mode === 'paper'
    ? { alias: a.alias, venue: a.venue, environment, mode: 'paper', paper: { initialBalance: (a.initialBalance ?? '10000') as Money, ccy: a.ccy ?? paperCcyFor(c, a.venue) } }
    : { alias: a.alias, venue: a.venue, environment, mode: 'live' }
  return { accounts: [...accountsCopy(c), next] }
}
export function patchCredentials(c: ConfigView, index: number, creds: Record<string, string>): VenuesPatch {
  return { accounts: accountsCopy(c).map((a, i) => (i === index ? { ...a, credentials: creds } : a)) }
}
export function patchPaperBalance(c: ConfigView, index: number, initialBalance: string): VenuesPatch {
  return { accounts: accountsCopy(c).map((a, i) => (i === index && a.paper ? { ...a, paper: { ...a.paper, initialBalance: initialBalance as Money } } : a)) }
}

/** 草稿里每个凭据栏：句柄 → ok；填了别的东西（疑似密钥值）→ bad，界面以圆点遮蔽、不发给内核。 */
export const draftIssues = (drafts: Record<string, string>): string[] => Object.entries(drafts).filter(([, v]) => v !== '' && !isHandle(v)).map(([k]) => k)

/** 小数字符串（初始资金）：正数，最多 8 位小数；千分位逗号先去掉。 */
export function parseBalance(text: string): string | null {
  const t = text.replace(/,/g, '').trim()
  return /^[0-9]{1,15}(\.[0-9]{1,8})?$/.test(t) && Number(t) > 0 ? t : null
}

// ---- 放宽判定（对照 kernel/src/api/view-config.ts needsPin / validateCandidate）----------------------------------------------

export type Gate = { kind: 'none' } | { kind: 'pin'; why: string } | { kind: 'refuse'; why: string }
/**
 * 四条放宽（内核要 PIN）：① 测试网 → 主网；② 启用一个新的交易类场所；③ 新增 / 改动实盘账户（新实盘、模式变实盘、场所 / 属主 / 凭据变、测试网实盘切主网）；④ 实盘 IBKR 新增标的。
 * 另：实盘主网必须是目录里「已验证」的交易场所，否则内核直接拒（invalid）；UI 在这之前就禁用，这里也判一次。收紧（关闭、删除、改回测试网）永远不要 PIN。
 */
export function gate(before: ConfigView, after: { venues: ConfigVenueView[]; accounts: ConfigAccountView[] }): Gate {
  for (const a of after.accounts) {
    if (a.mode === 'live' && a.environment === 'mainnet') {
      const cat = catalogOf(before, a.venue)
      if (!cat || cat.kind !== 'trading' || !cat.verified) return { kind: 'refuse', why: UNVERIFIED_WHY }
    }
  }
  if (before.venues.some((v) => v.environment === 'testnet' && after.venues.find((x) => x.id === v.id)?.environment === 'mainnet')) return { kind: 'pin', why: tr('切到主网') }
  if (after.venues.some((v) => v.enabled && catalogOf(before, v.id)?.kind === 'trading' && !before.venues.some((p) => p.id === v.id && p.enabled))) return { kind: 'pin', why: tr('启用交易场所') }
  for (const a of after.accounts) {
    const prior = before.accounts.find((p) => (a.accountId ? p.accountId === a.accountId : p.alias === a.alias))
    if (a.mode === 'live' && (!prior || prior.mode !== 'live' || (prior.environment === 'testnet' && a.environment === 'mainnet') || prior.venue !== a.venue
      || JSON.stringify(prior.owner ?? null) !== JSON.stringify(a.owner ?? null) || JSON.stringify(prior.credentials ?? null) !== JSON.stringify(a.credentials ?? null))) return { kind: 'pin', why: tr('新增或改动实盘账户') }
    if (prior?.environment === 'testnet' && a.environment === 'mainnet') return { kind: 'pin', why: tr('切到主网') }
  }
  // ④ 实盘 IBKR 新增标的（内核 view-config.ts 末段）：IBKR 启用且有实盘账户时，symbols 里出现之前没有的标的
  const nextIbkr = after.venues.find((v) => v.id === 'ibkr')
  if (nextIbkr?.enabled && after.accounts.some((a) => a.venue === 'ibkr' && a.mode === 'live')) {
    const prior = new Set(before.venues.find((v) => v.id === 'ibkr')?.symbols ?? [])
    if ((nextIbkr.symbols ?? []).some((symbol) => !prior.has(symbol))) return { kind: 'pin', why: tr('实盘 IBKR 新增标的') }
  }
  return { kind: 'none' }
}
export const applyPatch = (c: ConfigView, p: VenuesPatch): { venues: ConfigVenueView[]; accounts: ConfigAccountView[] } => ({ venues: p.venues ?? c.venues, accounts: p.accounts ?? c.accounts })

// ---- 通知 ------------------------------------------------------------------------------------------------------------

export type NotifyChannelView = ConfigNotifyView['channels'][number]
export type NotifyRuleView = NonNullable<ConfigNotifyView['rules']>[number]

/**
 * 紧急通道 = 被「紧急」级别规则点名的通道；一条规则都没有时，内核对所有事件向所有通道广播，此时每个通道都算。
 * 只数配置里仍存在的通道。
 */
export function emergencyChannels(n: ConfigNotifyView): string[] {
  const ids = new Set(n.channels.map((c) => c.id))
  const rules = n.rules ?? []
  if (!rules.length) return [...ids]
  return [...new Set(rules.filter((r) => r.level === 'critical').flatMap((r) => r.channels).filter((id) => ids.has(id)))]
}
/** 删掉这个通道后，急停（紧急事件）是否将无人可通知：删前有紧急通道，删后一个都没有。 */
export const deletingLastEmergency = (n: ConfigNotifyView, id: string): boolean => {
  const before = emergencyChannels(n)
  return before.length > 0 && before.every((x) => x === id)
}
export const patchDeleteChannel = (n: ConfigNotifyView, id: string): { channels: NotifyChannelView[]; rules?: NotifyRuleView[] } => ({
  channels: n.channels.filter((c) => c.id !== id),
  ...(n.rules ? { rules: n.rules.map((r) => ({ ...r, channels: r.channels.filter((x) => x !== id) })) } : {}),
})
export const patchChannelLevel = (n: ConfigNotifyView, id: string, minLevel: Level): { channels: NotifyChannelView[] } => ({ channels: n.channels.map((c) => (c.id === id ? { ...c, minLevel } : c)) })
export const patchChannelParams = (n: ConfigNotifyView, id: string, params: Record<string, unknown>): { channels: NotifyChannelView[] } => ({ channels: n.channels.map((c) => (c.id === id ? { ...c, params } : c)) })
export const patchRuleLevel = (n: ConfigNotifyView, index: number, level: Level): { rules: NotifyRuleView[] } => ({ rules: (n.rules ?? []).map((r, i) => (i === index ? { ...r, level } : r)) })

/** 通道插件 → 显示名与标识（有官方原件的用原件，其余用中性线性图标）。 */
export type ChannelLogo = 'telegram' | 'discord' | 'slack' | 'mail' | 'hook' | 'chat'
export function channelKind(plugin: string): { name: string; logo: ChannelLogo } {
  const p = plugin.toLowerCase()
  if (p.includes('telegram')) return { name: 'Telegram', logo: 'telegram' }
  if (p.includes('discord')) return { name: 'Discord', logo: 'discord' }
  if (p.includes('slack')) return { name: 'Slack', logo: 'slack' }
  if (p.includes('wecom') || p.includes('wechat')) return { name: tr('企业微信'), logo: 'chat' }
  if (p.includes('mail') || p.includes('smtp')) return { name: tr('邮件'), logo: 'mail' }
  if (p.includes('hook') || p.includes('http')) return { name: 'Webhook', logo: 'hook' }
  return { name: plugin, logo: 'hook' }
}

/** 通道密钥句柄：plugins.secrets.<插件>.<名> 的句柄（config.view.handles），只有句柄名与是否就位。 */
export const channelHandles = (config: ConfigView, plugin: string): { key: string; handle: string; state: 'ready' | 'missing' }[] =>
  config.handles.filter((h) => h.path.startsWith(`plugins.secrets.${plugin}.`)).map((h) => ({
    key: h.path.slice(`plugins.secrets.${plugin}.`.length), handle: h.handle, state: h.resolved ? 'ready' : 'missing',
  }))

export interface TestResult { at: number; ms: number; ok: boolean; text: string }
/** notify.test 的回包 → 一行：送达给耗时（前端自测）；失败给内核原文（detail 优先，其次 reason）。 */
export function testResultOf(raw: unknown, channelId: string, ms: number, at: number): TestResult {
  const list = isRec(raw) && Array.isArray(raw.results) ? raw.results : []
  const r = list.find((x): x is Record<string, unknown> => isRec(x) && x.channelId === channelId)
  if (!r) return { at, ms, ok: false, text: 'notify.test' }
  if (r.ok === true) return { at, ms, ok: true, text: `${(ms / 1000).toFixed(1)} s` }
  return { at, ms, ok: false, text: String(r.detail ?? r.reason ?? 'notify.test') }
}

/** 一个很小的共享状态仓：同页几张卡（场所 / 账户 / 可接入 / 详情）共用「选中」「待重启」「最近测试」。 */
export interface Store<T> { get(): T; set(patch: Partial<T>): void; subscribe(fn: () => void): () => void }
export function createStore<T extends object>(initial: T): Store<T> {
  let state = initial
  const subs = new Set<() => void>()
  return { get: () => state, set(patch) { state = { ...state, ...patch }; for (const f of subs) f() }, subscribe(fn) { subs.add(fn); return () => { subs.delete(fn) } } }
}
