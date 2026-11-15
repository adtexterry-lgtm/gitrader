// SPDX-License-Identifier: CPAL-1.0
// 配置与目录：~/.gitrader/gitrader.json + plugins/ engines/ workspaces/ lab/（定义 §〇·〇：一切皆文件夹、一份配置文件）。
// GITRADER_HOME 覆盖主目录（测试 / 隔离实例用，不得写入日常实例目录）。
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { AGENT_PERMISSION_TIERS, RISK_PRESETS, checkEngineLaunch, isDecimal } from './proto'
import type { AccountEnvironment, AccountMode, AgentPermissionTier, EngineLaunch, PaperReplayConfig, Protector, RiskLimits, ServerSecurityConfig } from './proto'
import { KernelError, findSecretKeys } from './util/errors'
import { writeFileAtomic } from './util/fsperm'
import { makeProblem } from './proto'
import { newId } from './util/ids'
import { assertSafeRelativePath } from './util/confined-path'
import { knownAccountIds } from './home-identity'
import { isWatchAddress } from './watch'

export const CONFIG_SCHEMA = 'gitrader-config/1'
export const DEFAULT_PORT_START = 47900
/** 默认端口探测要避开的端口（总单 §四 1）。 */
export const RESERVED_PORTS = [8765, 8188, 9872, 9222, 8080, 5198, 4184, 14609, 47831] as const

export interface HomePaths {
  home: string
  config: string
  plugins: string
  engines: string
  workspaces: string
  lab: string
  data: string
  db: string
  keys: string
  installKey: string
  keystore: string
  pin: string
  deviceKey: string
  service: string
}

export function resolveHome(arg?: string, env: Record<string, string | undefined> = process.env): string {
  const raw = arg && arg.trim() ? arg : env.GITRADER_HOME && env.GITRADER_HOME.trim() ? env.GITRADER_HOME : join(homedir(), '.gitrader')
  return resolve(raw)
}

export function homePaths(home: string): HomePaths {
  return {
    home, config: join(home, 'gitrader.json'), plugins: join(home, 'plugins'), engines: join(home, 'engines'),
    workspaces: join(home, 'workspaces'), lab: join(home, 'lab'), data: join(home, 'data'), db: join(home, 'data', 'gitrader.sqlite'),
    keys: join(home, 'keys'), installKey: join(home, 'keys', 'install-key.json'), keystore: join(home, 'keys', 'keystore.json'),
    pin: join(home, 'keys', 'pin.json'), deviceKey: join(home, 'keys', 'device.key.json'), service: join(home, 'service.json'),
  }
}

// ---- 配置类型 ----------------------------------------------------------------------
// TODO(protocol): 配置文件 schema 尚未进 protocol（契约没有 gitrader-config/1）；先在内核里定义，回报主会话决定是否进协议。

export interface ConfigVenue { id: string; environment: AccountEnvironment; enabled: boolean; symbols?: string[] }

export function validIbkrSymbols(id: string, symbols: unknown): symbols is string[] {
  if (id !== 'ibkr' || !Array.isArray(symbols) || symbols.length > 100) return false
  const seen = new Set<string>()
  for (const symbol of symbols) {
    if (typeof symbol !== 'string' || !/^[A-Z0-9][A-Z0-9.-]{0,31}$/.test(symbol) || seen.has(symbol)) return false
    seen.add(symbol)
  }
  return true
}
export interface ConfigAccount {
  accountId?: string
  alias: string
  venue: string
  environment: AccountEnvironment
  /** 运行时还可能是 'watch'（R3-20 只读观察账户：按公开地址读，没有钥匙、不能下单）。类型仍是协议的 AccountMode（协议不归本包改），判断一律走 isWatchAccount。 */
  mode: AccountMode
  /** mode=paper 时必填。 */
  paper?: { initialBalance: string; ccy: string }
  /** mode=watch 时必填：要观察的公开地址。不许同时带 signerRef / credentials / paper。 */
  watch?: { address: string }
  /** 实盘账户用哪只 API 钱包（钥匙库里的名字；这里不存密钥）。 */
  signerRef?: string
  /** API key credentials are environment-variable handles; values are never resolved here. */
  credentials?: Record<string, string>
  /** HL 主账户地址（公开地址，不是密钥）。 */
  owner?: { address?: string; accountRef?: string }
}
/**
 * 引擎项（v0.1.2：不限语言、不限跑在哪）：
 *   { id, enabled, launch: { command, args?, env?, cwd? } }   本地任意语言子进程（stdio），内核拉起 / 健康检查 / 退避重启；
 *   { id, enabled, launch: { url, auth } }                    已在运行的本地 ws 或远程 wss（令牌 / mTLS 只写句柄，不写明文）；
 *   { id, enabled, builtin: true }                            随包的参考引擎（进程内）。
 * uv 只是 Python 引擎的可选助手，M1 不实现。
 */
export interface ConfigEngine { id: string; enabled: boolean; builtin?: boolean; launch?: EngineLaunch }
export interface ConfigRisk {
  /** 数字预设 id（如 p-lev3-o2000-d3）；limits 里写的字段覆盖预设。 */
  preset?: string
  limits?: Partial<RiskLimits>
  protectors?: Protector[]
  failClosed?: { stalePriceMs: number; onMissingPrice: 'deny' }
  /** v0.1.2：缺省 true。写 false 属于放宽，配置文件里写了会被忽略（须在工作台用 PIN 关闭）。 */
  denyLlmLiveEntries?: boolean
  /** ADR-3：缺省 false（字段缺省 = 不要求）。为 true 时 Agent 开仓必须带 tpsl.stopLoss；配置文件里写 false 属于放宽，会被忽略。 */
  requireStopOnAgentOpen?: boolean
  dailyResetAt?: string
  valuationCcy?: string
  /** 本地批准价格界限；配置只能收紧，放宽须人面 PIN。 */
  maxDriftBps?: number
}
export type NoticeLevel = 'info' | 'warn' | 'critical'
export interface NotifyChannel { id: string; plugin: string; minLevel: NoticeLevel; params: Record<string, unknown> }
export interface NotifyRule { match: string; level: NoticeLevel; channels: string[] }
export interface NotifyConfig {
  channels: NotifyChannel[]
  rules?: NotifyRule[]
  rateLimit?: { perChannelPerMinute: number; dedupeWindowSec: number }
}
export interface GitraderConfig {
  schema: typeof CONFIG_SCHEMA
  /** 纯免费开源：默认 false。打开时连接器才带 Builder 费（Builder Code）；关着也照常交易。`init` 不询问。 */
  supportDeveloper: boolean
  venues: ConfigVenue[]
  accounts: ConfigAccount[]
  engines: ConfigEngine[]
  risk: ConfigRisk
  keys: { agentKeyExpiryDays: number; defaultTier: AgentPermissionTier; walletExpiryWarnDays: number }
  layout: { workspace: string }
  server: { port: number | null; maxInflightReadOps?: number; loopDelayShedMs?: number } & ServerSecurityConfig
  plugins: { developerMode: boolean; trustRoots: { keyId: string; publicKey: string }[]; secrets?: Record<string, Record<string, string>> }
  notify?: NotifyConfig
  /**
   * 允许把工作台嵌进 iframe 的上层页面源（例如 UNIGIT 的 https://app.example 或 http://localhost:5173）。
   * 默认空 = 禁止被嵌（CSP frame-ancestors 'none'）；非空时响应 `Content-Security-Policy: frame-ancestors <列表>`。
   * 只在“有人明确配置”时放开；写的是源（scheme://host[:port]），不是路径。
   */
  embed?: { allowedOrigins: string[] }
  paperReplay?: PaperReplayConfig
}

export const DEFAULT_PRESET_ID = 'p-lev3-o2000-d3'

export function defaultConfig(): GitraderConfig {
  return {
    schema: CONFIG_SCHEMA,
    supportDeveloper: false,
    venues: [{ id: 'hyperliquid', environment: 'testnet', enabled: true }],
    accounts: [
      { alias: 'paper', venue: 'hyperliquid', environment: 'testnet', mode: 'paper', paper: { initialBalance: '10000', ccy: 'USDC' } },
    ],
    engines: [{ id: 'gitrader-core', enabled: true, builtin: true }, { id: 'python-engine', enabled: false, builtin: true }],
    risk: {
      preset: DEFAULT_PRESET_ID,
      // 报撤单频率与防重复的稳妥默认值（每账户；授权书里可给每把 Agent 钥匙单独设更严的）：
      //   每分钟最多 30 笔下单、60 次撤单；同标的同方向同价同量的重复意图 10 秒内拒绝（duplicateIntentWindowSec: 0 关闭，属放宽，要 PIN）。
      limits: { maxSlippageBps: 50, maxOrdersPerMinute: 30, maxCancelsPerMinute: 60, duplicateIntentWindowSec: 10 } as GitraderConfig['risk']['limits'],
      protectors: [],
      failClosed: { stalePriceMs: 5000, onMissingPrice: 'deny' },
      dailyResetAt: '00:00Z',
      valuationCcy: 'USDC',
    },
    keys: { agentKeyExpiryDays: 30, defaultTier: 'paper', walletExpiryWarnDays: 14 },
    layout: { workspace: 'ws_default' },
    server: { port: null },
    plugins: { developerMode: false, trustRoots: [] },
    embed: { allowedOrigins: [] },
  }
}

/** 逐项检查，返回问题列表（空 = 合法）。不做静默修正。 */
export function validateConfig(c: unknown): string[] {
  const p: string[] = []
  const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
  const o = c as Partial<GitraderConfig> | null
  if (!o || typeof o !== 'object') return ['config must be a JSON object']
  if (o.schema !== CONFIG_SCHEMA) p.push(`schema must be ${CONFIG_SCHEMA}`)
  if (typeof o.supportDeveloper !== 'boolean') p.push('supportDeveloper must be boolean')
  if (!Array.isArray(o.venues)) p.push('venues must be an array')
  else o.venues.forEach((v, i) => {
    if (!v || typeof v.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(v.id)) p.push(`venues[${i}].id invalid`)
    if (v?.environment !== 'mainnet' && v?.environment !== 'testnet') p.push(`venues[${i}].environment must be mainnet|testnet`)
    if (typeof v?.enabled !== 'boolean') p.push(`venues[${i}].enabled must be boolean`)
    if (v && Object.prototype.hasOwnProperty.call(v, 'symbols') && !validIbkrSymbols(v.id, v.symbols)) p.push(`venues[${i}].symbols must be up to 100 unique uppercase IBKR tickers`)
  })
  if (!Array.isArray(o.accounts)) p.push('accounts must be an array')
  else {
    const aliases = new Set<string>()
    const singleLiveVenues = new Set(['binance', 'okx', 'bybit', 'bitget', 'gateio', 'alpaca', 'ibkr'])
    const liveVenueAccounts = new Set<string>()
    o.accounts.forEach((a, i) => {
      if (!a || typeof a.alias !== 'string' || !a.alias) { p.push(`accounts[${i}].alias required`); return }
      if (aliases.has(a.alias)) p.push(`accounts[${i}].alias duplicated: ${a.alias}`)
      aliases.add(a.alias)
      const watch = (a.mode as string) === 'watch'
      if (!watch && !['live', 'paper', 'shadow'].includes(a.mode)) p.push(`accounts[${i}].mode must be live|paper|shadow`)
      if (watch) {
        if (!isWatchAddress(a.watch?.address)) p.push(`accounts[${i}].watch.address must be 0x followed by 40 hex characters`)
        if (a.venue !== 'hyperliquid') p.push(`accounts[${i}]: watch accounts support venue hyperliquid only`)
        for (const forbidden of ['signerRef', 'credentials', 'paper'] as const) if ((a as unknown as Record<string, unknown>)[forbidden] !== undefined) p.push(`accounts[${i}].${forbidden} must not be set on a watch account (read-only)`)
      }
      if (a.environment !== 'mainnet' && a.environment !== 'testnet') p.push(`accounts[${i}].environment must be mainnet|testnet`)
      if (typeof a.venue !== 'string' || !a.venue) p.push(`accounts[${i}].venue required`)
      if (a.mode === 'paper' && !(a.paper && isDecimal(a.paper.initialBalance) && a.paper.ccy)) p.push(`accounts[${i}].paper{initialBalance,ccy} required for paper mode`)
      const credentials = (a as ConfigAccount).credentials as unknown
      if (a.mode === 'live' && a.venue === 'ibkr' && (credentials !== undefined || a.signerRef !== undefined)) p.push(`accounts[${i}]: IBKR live accounts cannot set credentials or signerRef`)
      if (a.owner?.accountRef !== undefined && (typeof a.owner.accountRef !== 'string' || !a.owner.accountRef.trim())) p.push(`accounts[${i}].owner.accountRef must be a non-empty string`)
      const hasCredentials = credentials !== undefined
      const validCredentials = credentials !== null && typeof credentials === 'object' && !Array.isArray(credentials)
        && Object.keys(credentials).length > 0
        && Object.values(credentials).every((value) => typeof value === 'string' && /^env:[A-Za-z_][A-Za-z0-9_]*$/.test(value))
      if (hasCredentials && !validCredentials) p.push(`accounts[${i}].credentials must be a non-empty object of env:VAR handles`)
      if (a.mode === 'live' && a.venue !== 'ibkr' && !a.signerRef && !validCredentials) p.push(`accounts[${i}].signerRef or valid credentials required for live mode`)
      if (a.mode === 'live' && singleLiveVenues.has(a.venue) && liveVenueAccounts.has(a.venue)) p.push(`only one live account is allowed for venue ${a.venue}`)
      if (a.mode === 'live' && singleLiveVenues.has(a.venue)) liveVenueAccounts.add(a.venue)
      if (typeof a.venue === 'string' && Array.isArray(o.venues)) {
        const venueCfg = o.venues.find((venue) => venue?.id === a.venue)
        if (venueCfg && !watch && venueCfg.environment !== a.environment) p.push(`accounts[${i}].environment must match venue environment`)
      }
    })
  }
  if (!Array.isArray(o.engines)) p.push('engines must be an array')
  else {
    const ids = new Set<string>()
    o.engines.forEach((e, i) => {
      if (!e || typeof e.id !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/.test(e.id)) { p.push(`engines[${i}].id invalid`); return }
      if (ids.has(e.id)) p.push(`engines[${i}].id duplicated: ${e.id}`)
      ids.add(e.id)
      if (typeof e.enabled !== 'boolean') p.push(`engines[${i}].enabled must be boolean`)
      if (!e.builtin && !e.launch) p.push(`engines[${i}] needs launch{command,...} or launch{url,auth} (or builtin: true)`)
      if (e.launch) for (const m of checkEngineLaunch(e.launch)) p.push(`engines[${i}].launch: ${m}`)
    })
  }
  if (o.paperReplay !== undefined) {
    const replay = o.paperReplay as PaperReplayConfig | null
    if (!replay || typeof replay.fixture !== 'string' || !replay.fixture.trim()) p.push('paperReplay.fixture must be a non-empty relative name')
    else {
      try { assertSafeRelativePath(replay.fixture) } catch { p.push('paperReplay.fixture must be a non-empty relative name') }
    }
    if (!Array.isArray(o.accounts) || o.accounts.length === 0 || o.accounts.some((account) => account?.mode !== 'paper')) {
      p.push('paperReplay requires non-empty all-paper accounts')
    }
    if (!Array.isArray(o.engines)) p.push('paperReplay requires exactly one enabled gitrader-core builtin')
    else {
      const enabled = o.engines.filter((engine) => engine?.enabled === true)
      const cores = enabled.filter((engine) => engine?.id === 'gitrader-core' && engine?.builtin === true && engine?.launch === undefined)
      if (cores.length !== 1 || enabled.some((engine) => engine?.id !== 'gitrader-core')) {
        p.push('paperReplay requires exactly one enabled gitrader-core builtin')
      }
    }
  }
  if (!o.risk || typeof o.risk !== 'object') p.push('risk must be an object')
  else {
    if (o.risk.preset !== undefined && !RISK_PRESETS.some((x) => x.id === o.risk?.preset)) p.push(`risk.preset unknown: ${String(o.risk.preset)}`)
    if (o.risk.denyLlmLiveEntries !== undefined && typeof o.risk.denyLlmLiveEntries !== 'boolean') p.push('risk.denyLlmLiveEntries must be boolean')
    if (o.risk.requireStopOnAgentOpen !== undefined && typeof o.risk.requireStopOnAgentOpen !== 'boolean') p.push('risk.requireStopOnAgentOpen must be boolean')
    if (o.risk.maxDriftBps !== undefined && !(Number.isSafeInteger(o.risk.maxDriftBps) && o.risk.maxDriftBps >= 0)) p.push('risk.maxDriftBps must be a non-negative integer')
    const l = o.risk.limits
    if (l) {
      for (const k of ['maxOrderNotional', 'maxPositionNotionalRatio', 'maxTotalNotionalRatio', 'maxDailyLossRatio', 'maxDailyNotional'] as const) {
        if (l[k] !== undefined && !isDecimal(l[k])) p.push(`risk.limits.${k} must be a canonical decimal string`)
      }
      for (const k of ['maxLeverage', 'maxOpenPositions', 'maxSlippageBps', 'maxOrdersPerMinute', 'maxDailyOrders', 'maxCancelsPerMinute', 'duplicateIntentWindowSec'] as const) {
        const v = (l as Record<string, unknown>)[k]
        if (v !== undefined && !(typeof v === 'number' && Number.isFinite(v) && v >= 0)) p.push(`risk.limits.${k} must be a non-negative number`)
      }
    }
  }
  if (!o.keys || !AGENT_PERMISSION_TIERS.includes(o.keys.defaultTier)) p.push('keys.defaultTier invalid')
  else {
    if (o.keys.defaultTier === 'auto_limited') p.push('keys.defaultTier must not be auto_limited (new keys start read-only/paper/confirm)')
    if (!(o.keys.agentKeyExpiryDays > 0)) p.push('keys.agentKeyExpiryDays must be > 0')
  }
  if (!o.layout || typeof o.layout.workspace !== 'string') p.push('layout.workspace required')
  if (!o.server || typeof o.server !== 'object') p.push('server must be an object')
  else {
    const server = o.server as unknown as Record<string, unknown>
    if (server.port !== null && !(Number.isInteger(server.port) && (server.port as number) > 0 && (server.port as number) < 65536)) p.push('server.port must be null or a valid port')
    if (server.operationRateLimit !== undefined) {
      const limit = server.operationRateLimit
      if (!record(limit)) p.push('server.operationRateLimit must be a non-empty object')
      else {
        const values = limit as Record<string, unknown>
        const hasCapacity = values.capacity !== undefined
        const hasRefill = values.refillPerSecond !== undefined
        const hasReadOnly = values.readOnly !== undefined
        const hasSession = values.session !== undefined
        if (!hasCapacity && !hasRefill && !hasReadOnly && !hasSession) p.push('server.operationRateLimit must specify capacity or refillPerSecond')
        if (hasCapacity && !(Number.isInteger(values.capacity) && (values.capacity as number) >= 1 && (values.capacity as number) <= 10000)) p.push('server.operationRateLimit.capacity must be an integer from 1 to 10000')
        if (hasRefill && !(typeof values.refillPerSecond === 'number' && Number.isFinite(values.refillPerSecond) && values.refillPerSecond >= 0.1 && values.refillPerSecond <= 10000)) p.push('server.operationRateLimit.refillPerSecond must be from 0.1 to 10000')
        if (hasReadOnly) {
          const readOnly = values.readOnly
          if (!record(readOnly)) p.push('server.operationRateLimit.readOnly must be an object')
          else {
            if (readOnly.capacity !== undefined && !(Number.isInteger(readOnly.capacity) && (readOnly.capacity as number) >= 1 && (readOnly.capacity as number) <= 10000)) p.push('server.operationRateLimit.readOnly.capacity must be an integer from 1 to 10000')
            if (readOnly.refillPerSecond !== undefined && !(typeof readOnly.refillPerSecond === 'number' && Number.isFinite(readOnly.refillPerSecond) && readOnly.refillPerSecond >= 0.1 && readOnly.refillPerSecond <= 10000)) p.push('server.operationRateLimit.readOnly.refillPerSecond must be from 0.1 to 10000')
          }
        }
        if (hasSession) {
          const session = values.session
          if (!record(session)) p.push('server.operationRateLimit.session must be an object')
          else {
            if (session.capacity !== undefined && !(Number.isInteger(session.capacity) && (session.capacity as number) >= 1 && (session.capacity as number) <= 10000)) p.push('server.operationRateLimit.session.capacity must be an integer from 1 to 10000')
            if (session.refillPerSecond !== undefined && !(typeof session.refillPerSecond === 'number' && Number.isFinite(session.refillPerSecond) && session.refillPerSecond >= 0.1 && session.refillPerSecond <= 10000)) p.push('server.operationRateLimit.session.refillPerSecond must be from 0.1 to 10000')
          }
        }
      }
    }
    if (server.maxWsSubscriptions !== undefined && !(Number.isInteger(server.maxWsSubscriptions) && (server.maxWsSubscriptions as number) >= 1 && (server.maxWsSubscriptions as number) <= 1024)) p.push('server.maxWsSubscriptions must be an integer from 1 to 1024')
    if (server.maxInflightReadOps !== undefined && !(Number.isInteger(server.maxInflightReadOps) && (server.maxInflightReadOps as number) >= 1 && (server.maxInflightReadOps as number) <= 10000)) p.push('server.maxInflightReadOps must be an integer from 1 to 10000')
    if (server.loopDelayShedMs !== undefined && !(Number.isInteger(server.loopDelayShedMs) && (server.loopDelayShedMs as number) >= 10 && (server.loopDelayShedMs as number) <= 60000)) p.push('server.loopDelayShedMs must be an integer from 10 to 60000')
  }
  if (!o.plugins || typeof o.plugins.developerMode !== 'boolean') p.push('plugins.developerMode must be boolean')
  if (o.plugins?.secrets !== undefined) {
    if (!record(o.plugins.secrets)) p.push('plugins.secrets must be an object')
    else for (const [id, names] of Object.entries(o.plugins.secrets)) {
      if (!/^[a-z0-9][a-z0-9.-]*$/.test(id) || !record(names)) { p.push('plugins.secrets requires plugin ids mapped to objects'); continue }
      for (const [name, handle] of Object.entries(names)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || typeof handle !== 'string' || !/^env:[A-Za-z_][A-Za-z0-9_]*$/.test(handle)) p.push('plugins.secrets requires environment names mapped to env:VAR handles')
      }
    }
  }
  if (o.notify !== undefined) {
    const n = o.notify
    const levels = ['info', 'warn', 'critical']
    const ids = new Set<string>()
    if (!record(n) || !Array.isArray(n.channels)) p.push('notify.channels must be an array')
    else {
      n.channels.forEach((channel, i) => {
        if (!record(channel)) { p.push(`notify.channels[${i}] must be an object`); return }
        if (typeof channel.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(channel.id) || ids.has(channel.id)) p.push(`notify.channels[${i}].id invalid or duplicated`)
        else ids.add(channel.id)
        if (typeof channel.plugin !== 'string' || !/^[a-z0-9][a-z0-9.-]*$/.test(channel.plugin)) p.push(`notify.channels[${i}].plugin required`)
        if (!levels.includes(channel.minLevel as string)) p.push(`notify.channels[${i}].minLevel invalid`)
        if (!record(channel.params) || findSecretKeys(channel.params).length > 0) p.push(`notify.channels[${i}].params must be an object without credentials (use plugins.secrets)`)
      })
      if (n.rules !== undefined) {
        if (!Array.isArray(n.rules)) p.push('notify.rules must be an array')
        else n.rules.forEach((rule, i) => {
          if (!record(rule)) { p.push(`notify.rules[${i}] must be an object`); return }
          if (typeof rule.match !== 'string' || !/^(?:\*|[a-z_]+(?:\.[a-z_]+)*(?:\.\*)?)$/.test(rule.match)) p.push(`notify.rules[${i}].match invalid`)
          if (!levels.includes(rule.level as string)) p.push(`notify.rules[${i}].level invalid`)
          if (!Array.isArray(rule.channels) || rule.channels.some(id => typeof id !== 'string' || !ids.has(id))) p.push(`notify.rules[${i}].channels must reference configured channels`)
        })
      }
      if (n.rateLimit !== undefined) {
        if (!record(n.rateLimit)) p.push('notify.rateLimit must be an object')
        else {
          if (!Number.isSafeInteger(n.rateLimit.perChannelPerMinute) || !(Number(n.rateLimit.perChannelPerMinute) > 0)) p.push('notify.rateLimit.perChannelPerMinute must be a positive integer')
          if (!Number.isSafeInteger(n.rateLimit.dedupeWindowSec) || !(Number(n.rateLimit.dedupeWindowSec) >= 0)) p.push('notify.rateLimit.dedupeWindowSec must be a non-negative integer')
        }
      }
    }
  }
  if (o.embed !== undefined) {
    if (!o.embed || !Array.isArray(o.embed.allowedOrigins)) p.push('embed.allowedOrigins must be an array')
    else o.embed.allowedOrigins.forEach((x, i) => { if (typeof x !== 'string' || !/^https?:\/\/[A-Za-z0-9.\-\[\]:]+(:\d{1,5})?$/.test(x) || x.includes('*')) p.push(`embed.allowedOrigins[${i}] must be an origin like https://host[:port] (no path, no wildcard)`) })
  }
  return p
}

export interface InitResult { created: string[]; config: GitraderConfig; paths: HomePaths }

/** 这个主目录「用过」的痕迹（只看文件，不看空目录：init 只建目录时不算）。配置不见了而这些还在 = 事故，不是新目录。 */
export function homeStateEvidence(home: string): string[] {
  const p = homePaths(home)
  const rows: Array<[string, string]> = [
    [p.db, 'data/gitrader.sqlite'], [p.installKey, 'keys/install-key.json'], [p.pin, 'keys/pin.json'],
    [p.keystore, 'keys/keystore.json'], [join(home, 'paper-state.json'), 'paper-state.json'],
  ]
  return rows.filter(([file]) => existsSync(file)).map(([, label]) => label)
}

export interface InitOptions {
  /** 配置整份不见但目录已用过时，明确同意用默认配置重建（沿用账本 / 纸面状态 / 授权书里已有的纸面账户 id）。 */
  rebuildConfig?: boolean
  /** 重建时有多个候选账户 id 才需要：指定沿用哪一个（必须出现在候选里）。 */
  accountId?: string
}

/** 重建配置时选择账户 id：0 个候选 = undefined（用新 id）；1 个 = 沿用；多个 = 要求显式指定。 */
function chooseAccountId(home: string, wanted?: string): string | undefined {
  const paths = homePaths(home)
  const { ids, ledgerCounts } = knownAccountIds(paths.db, join(home, 'paper-state.json'))
  if (ids.length === 0) return undefined
  if (ids.length === 1) return ids[0]
  // 多个候选
  if (!wanted) {
    const desc = ids.map((id) => `${id}（账本 ${ledgerCounts[id] ?? 0} 条）`).join('、')
    throw new KernelError(makeProblem('INVALID_PARAMS', `账本 / 纸面状态里有多个账户 id，没法自动判断哪个是纸面账户：${desc}；用 gitrader init --rebuild-config --account-id <id> 指定一个`))
  }
  if (!ids.includes(wanted)) {
    throw new KernelError(makeProblem('INVALID_PARAMS', `--account-id ${wanted} is not in this home's known account ids: ${ids.join(', ')}`))
  }
  return wanted
}

/** 幂等：已存在的文件与目录不动；只补缺失的目录、缺失的 accountId（有改动才回写）。 */
export function initHome(home: string, opts: InitOptions = {}): InitResult {
  const paths = homePaths(home)
  const created: string[] = []
  for (const d of [paths.home, paths.plugins, paths.engines, paths.workspaces, paths.lab, paths.data, paths.keys]) {
    if (!existsSync(d)) { mkdirSync(d, { recursive: true }); created.push(d) }
  }
  let config: GitraderConfig
  if (!existsSync(paths.config)) {
    const evidence = homeStateEvidence(home)
    if (evidence.length > 0 && !opts.rebuildConfig) {
      throw new KernelError(makeProblem('STATE_FILE_CORRUPT',
        `gitrader.json is missing: ${paths.config}, but this home already has ${evidence.join(', ')}; restore it from a backup, or run gitrader init --rebuild-config to start from the default config (keeps the paper account id found in the ledger). ` +
        `配置文件 gitrader.json 不见了（本目录还留着 ${evidence.join('、')}）：从备份还原；确定要用默认配置重来才运行 gitrader init --rebuild-config（会沿用账本里已有的纸面账户 id）`))
    }
    config = defaultConfig()
    const keep = evidence.length > 0 ? chooseAccountId(home, opts.accountId) : undefined   // 只有显式重建才会走到这里
    for (const a of config.accounts) a.accountId = keep ?? newId('acct')
    writeFileAtomic(paths.config, JSON.stringify(config, null, 2) + '\n')
    created.push(paths.config)
  } else {
    config = loadConfig(home)
    let dirty = false
    for (const a of config.accounts) if (!a.accountId) { a.accountId = newId('acct'); dirty = true }
    if (dirty) writeFileAtomic(paths.config, JSON.stringify(config, null, 2) + '\n')
  }
  return { created, config, paths }
}

export function loadConfig(home: string): GitraderConfig {
  const { config: file } = homePaths(home)
  let raw: unknown
  try {
    raw = JSON.parse(stripBom(readFileSync(file, 'utf8')))
  } catch (e) {
    throw new KernelError(makeProblem('INVALID_REQUEST', `cannot read ${file}: ${e instanceof Error ? e.message : String(e)}`))
  }
  const problems = validateConfig(raw)
  if (problems.length) throw new KernelError(makeProblem('INVALID_PARAMS', `invalid ${file}: ${problems.join('; ')}`))
  return raw as GitraderConfig
}

/** 剥除 UTF-8 BOM（U+FEFF）：Windows 编辑器可能加 BOM，readFileSync(..., 'utf8') 不剥。 */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

export function saveConfig(home: string, config: GitraderConfig): void {
  const problems = validateConfig(config)
  if (problems.length) throw new KernelError(makeProblem('INVALID_PARAMS', `refusing to write invalid config: ${problems.join('; ')}`))
  writeFileAtomic(homePaths(home).config, JSON.stringify(config, null, 2) + '\n')
}
