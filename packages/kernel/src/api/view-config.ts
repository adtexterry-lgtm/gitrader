// SPDX-License-Identifier: CPAL-1.0
import type { ConfigNotifySetView, ConfigView, ConfigVenuesSetView } from '@gitrader/protocol'
import { makeProblem, mainnetLiveBlocked } from '../proto'
import { saveConfig, validIbkrSymbols, validateConfig as validateProtocolConfig } from '../config'
import type { ConfigAccount, ConfigVenue, GitraderConfig, NotifyChannel, NotifyRule } from '../config'
import { newId } from '../util/ids'
import { KernelError } from '../util/errors'
import { isWatchAccount } from '../watch'
import type { Kernel } from '../kernel'
import type { OpContext, OpParams, OpRegistry } from './router'
import { hasSensitiveNotifyParams } from './view-config-privacy'

const invalid = (message = 'Configuration patch is invalid'): never => { throw new KernelError(makeProblem('INVALID_PARAMS', message)) }
const unexpected = (value: unknown, allowed: readonly string[]): boolean =>
  value === null || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !allowed.includes(key))
const own = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key)

export function projectConfigView(k: Kernel, config: GitraderConfig = k.config): ConfigView {
  const venues = config.venues.map((venue) => ({ id: venue.id, environment: venue.environment, enabled: venue.enabled,
    ...(venue.symbols === undefined ? {} : { symbols: [...venue.symbols] }) }))
  const accounts = config.accounts.map((account) => ({
    ...(account.accountId ? { accountId: account.accountId as NonNullable<ConfigView['accounts'][number]['accountId']> } : {}),
    alias: account.alias, venue: account.venue, environment: account.environment, mode: account.mode,
    ...(account.paper ? { paper: { initialBalance: account.paper.initialBalance as NonNullable<ConfigView['accounts'][number]['paper']>['initialBalance'], ccy: account.paper.ccy } } : {}),
    ...(account.signerRef ? { signerRef: account.signerRef } : {}),
    ...(account.credentials ? { credentials: { ...account.credentials } } : {}),
    ...(account.owner ? { owner: { ...(account.owner.address ? { address: account.owner.address } : {}), ...(account.owner.accountRef ? { accountRef: account.owner.accountRef } : {}) } } : {}),
  }))
  const notify = config.notify ? {
    channels: config.notify.channels.map((channel) => {
      if (hasSensitiveNotifyParams(channel.params)) throw new KernelError(makeProblem('DATA_UNAVAILABLE', 'Notification credentials must use plugins.secrets'))
      return { id: channel.id, plugin: channel.plugin, minLevel: channel.minLevel, params: structuredClone(channel.params) }
    }),
    ...(config.notify.rules ? { rules: config.notify.rules.map((rule) => ({ match: rule.match, level: rule.level, channels: [...rule.channels] })) } : {}),
    ...(config.notify.rateLimit ? { rateLimit: {
      perChannelPerMinute: config.notify.rateLimit.perChannelPerMinute,
      dedupeWindowSec: config.notify.rateLimit.dedupeWindowSec,
    } } : {}),
  } : { channels: [] }
  const handles: ConfigView['handles'] = []
  for (const [plugin, values] of Object.entries(config.plugins.secrets ?? {})) for (const [key, handle] of Object.entries(values)) {
    let resolved = false
    try { const value = k.opts.resolveSecret?.(handle); resolved = typeof value === 'string' && value.length > 0 } catch { resolved = false }
    handles.push({ path: `plugins.secrets.${plugin}.${key}`, handle, resolved })
  }
  for (const [index, account] of config.accounts.entries()) for (const [key, handle] of Object.entries(account.credentials ?? {})) {
    let resolved = false
    try { const value = k.opts.resolveSecret?.(handle); resolved = typeof value === 'string' && value.length > 0 } catch { resolved = false }
    handles.push({ path: `accounts[${index}].credentials.${key}`, handle, resolved })
  }
  return { venues, accounts, notify, handles, catalog: k.connectorCatalog.map((entry) => ({ venue: entry.venue, kind: entry.kind, verified: entry.verified, credentials: [...entry.credentials] })) }
}

const queues = new WeakMap<Kernel, Promise<unknown>>()
function enqueue<T>(k: Kernel, operation: () => Promise<T>): Promise<T> {
  const current = (queues.get(k) ?? Promise.resolve()).catch(() => undefined).then(operation)
  queues.set(k, current)
  void current.then(() => { if (queues.get(k) === current) queues.delete(k) }, () => { if (queues.get(k) === current) queues.delete(k) })
  return current
}

function validateVenuePatch(value: unknown): { venues?: ConfigVenue[]; accounts?: ConfigAccount[] } {
  if (unexpected(value, ['venues', 'accounts'])) return invalid()
  const patch = value as Record<string, unknown>
  if (!own(patch, 'venues') && !own(patch, 'accounts')) return invalid()
  let venues: ConfigVenue[] | undefined
  let accounts: ConfigAccount[] | undefined
  if (own(patch, 'venues')) {
    if (!Array.isArray(patch.venues)) return invalid()
    venues = patch.venues.map((item) => {
      if (unexpected(item, ['id', 'environment', 'enabled', 'symbols'])) return invalid()
      const row = item as Record<string, unknown>
      if (typeof row.id !== 'string' || typeof row.environment !== 'string' || typeof row.enabled !== 'boolean') return invalid()
      if (own(row, 'symbols') && !validIbkrSymbols(row.id, row.symbols)) return invalid()
      return { id: row.id, environment: row.environment as ConfigVenue['environment'], enabled: row.enabled,
        ...(own(row, 'symbols') ? { symbols: [...row.symbols as string[]] } : {}) }
    })
  }
  if (own(patch, 'accounts')) {
    if (!Array.isArray(patch.accounts)) return invalid()
    accounts = patch.accounts.map((item) => {
      if (unexpected(item, ['accountId', 'alias', 'venue', 'environment', 'mode', 'paper', 'signerRef', 'credentials', 'owner'])) return invalid()
      const row = item as Record<string, unknown>
      if (row.paper !== undefined && unexpected(row.paper, ['initialBalance', 'ccy'])) return invalid()
      if (row.owner !== undefined && unexpected(row.owner, ['address', 'accountRef'])) return invalid()
      if (row.credentials !== undefined && (row.credentials === null || typeof row.credentials !== 'object' || Array.isArray(row.credentials))) return invalid()
      const account: ConfigAccount = {
        ...(typeof row.accountId === 'string' ? { accountId: row.accountId } : {}),
        alias: row.alias as string, venue: row.venue as string,
        environment: row.environment as ConfigAccount['environment'], mode: row.mode as ConfigAccount['mode'],
        ...(row.paper !== undefined ? { paper: structuredClone(row.paper) as ConfigAccount['paper'] } : {}),
        ...(typeof row.signerRef === 'string' ? { signerRef: row.signerRef } : {}),
        ...(row.credentials !== undefined ? { credentials: structuredClone(row.credentials) as Record<string, string> } : {}),
        ...(row.owner !== undefined ? { owner: structuredClone(row.owner) as ConfigAccount['owner'] } : {}),
      }
      if (row.accountId !== undefined && typeof row.accountId !== 'string' || row.signerRef !== undefined && typeof row.signerRef !== 'string') return invalid()
      return account
    })
  }
  return { ...(venues ? { venues } : {}), ...(accounts ? { accounts } : {}) }
}

function normalizeAccounts(previous: ConfigAccount[], accounts: ConfigAccount[]): ConfigAccount[] {
  const normalized = accounts.map((account) => {
    const prior = previous.find((row) => account.accountId ? row.accountId === account.accountId : row.alias === account.alias)
    if (prior) return { ...account, accountId: prior.accountId ?? account.accountId }
    return { ...account, accountId: account.accountId ?? newId('acct') }
  })
  const ids = normalized.flatMap((account) => account.accountId ? [account.accountId] : [])
  const aliases = normalized.map((account) => account.alias)
  if (new Set(ids).size !== ids.length || new Set(aliases).size !== aliases.length) return invalid()
  return normalized
}

function validateCandidate(k: Kernel, config: GitraderConfig): void {
  const venueIds = config.venues.map((venue) => venue.id)
  if (new Set(venueIds).size !== venueIds.length) invalid()
  for (const account of config.accounts) {
    const venue = config.venues.find((candidate) => candidate.id === account.venue)
    // 观察账户（只读、不带钥匙）按自己的 environment 读公开数据，不要求跟场所当前连的网一致（R3-20 跟进）；交易账户仍须一致。
    if (!venue || (!isWatchAccount(account) && venue.environment !== account.environment)) invalid()
    if (account.credentials) {
      const catalog = k.connectorCatalog.find((entry) => entry.venue === account.venue)
      if (!catalog || Object.keys(account.credentials).some((key) => !catalog.credentials.includes(key))) invalid()
    }
  }
  if (validateProtocolConfig(config).length) invalid()
}

function needsPin(k: Kernel, before: GitraderConfig, after: GitraderConfig): boolean {
  let required = before.venues.some((venue) => venue.environment === 'testnet' && after.venues.find((item) => item.id === venue.id)?.environment === 'mainnet')
  required ||= after.venues.some((venue) => venue.enabled
    && k.connectorCatalog.some((entry) => entry.venue === venue.id && entry.kind === 'trading')
    && !before.venues.some((prior) => prior.id === venue.id && prior.enabled))
  for (const account of after.accounts) {
    const prior = before.accounts.find((item) => account.accountId ? item.accountId === account.accountId : item.alias === account.alias)
    if (account.mode === 'live' && account.environment === 'mainnet') {
      const catalog = k.connectorCatalog.find((entry) => entry.venue === account.venue)
      if (!catalog || catalog.kind !== 'trading' || !catalog.verified) invalid('Unverified mainnet trading venues cannot be enabled')
    }
    if (account.mode === 'live' && (!prior || prior.mode !== 'live' || prior.environment === 'testnet' && account.environment === 'mainnet' || prior.venue !== account.venue || JSON.stringify(prior.owner ?? null) !== JSON.stringify(account.owner ?? null) || JSON.stringify(prior.credentials ?? null) !== JSON.stringify(account.credentials ?? null))) required = true
    if (prior?.environment === 'testnet' && account.environment === 'mainnet') required = true
  }
  const priorIbkr = before.venues.find((venue) => venue.id === 'ibkr')
  const nextIbkr = after.venues.find((venue) => venue.id === 'ibkr')
  if (nextIbkr?.enabled && after.accounts.some((account) => account.venue === 'ibkr' && account.mode === 'live')) {
    const priorSymbols = new Set(priorIbkr?.symbols ?? [])
    if ((nextIbkr.symbols ?? []).some((symbol) => !priorSymbols.has(symbol))) required = true
  }
  return required
}

async function setVenues(k: Kernel, ctx: OpContext, input: OpParams): Promise<ConfigVenuesSetView> {
  if (unexpected(input, ['patch']) || !own(input, 'patch')) return invalid()
  const patch = validateVenuePatch(structuredClone(input.patch))
  return enqueue(k, async () => {
    const before = k.config
    const candidate = structuredClone(before)
    if (patch.venues) candidate.venues = patch.venues
    if (patch.accounts) candidate.accounts = normalizeAccounts(before.accounts, patch.accounts)
    if (candidate.accounts.some((a) => mainnetLiveBlocked(a))) {
      throw new KernelError(makeProblem('INVALID_PARAMS', '0.1.1 does not support mainnet live trading; see Known limitations. 0.1.1 不支持主网实盘交易，见已知限制。'))
    }
    validateCandidate(k, candidate)
    if (needsPin(k, before, candidate)) await k.auth.pinProof(ctx.principal, ctx.pin)
    const view = projectConfigView(k, candidate)
    try { saveConfig(k.home, candidate) } catch { throw new KernelError(makeProblem('DATA_UNAVAILABLE', 'Configuration could not be saved')) }
    k.config = candidate
    try {
      k.ledger.append({ type: 'annotation', origin: ctx.origin, subject: { orgId: 'org_local' }, payload: { kind: 'config.venues.set', fields: Object.keys(patch), venues: candidate.venues.length, accounts: candidate.accounts.length } })
    } catch { throw new KernelError(makeProblem('INTERNAL_ERROR', 'Configuration was saved but audit recording failed; reload configuration before retrying')) }
    return { config: view, restartRequired: true }
  })
}

async function setNotify(k: Kernel, ctx: OpContext, input: OpParams): Promise<ConfigNotifySetView> {
  if (unexpected(input, ['channels', 'rules']) || !own(input, 'channels') && !own(input, 'rules')) return invalid()
  const patch = structuredClone(input) as Record<string, unknown>
  if (patch.channels !== undefined) {
    if (!Array.isArray(patch.channels)) return invalid()
    patch.channels = patch.channels.map((channel) => {
      if (unexpected(channel, ['id', 'plugin', 'minLevel', 'params'])) return invalid()
      const row = channel as Record<string, unknown>
      if (row.params === null || typeof row.params !== 'object' || Array.isArray(row.params)) return invalid()
      if (hasSensitiveNotifyParams(row.params)) return invalid('Notification credentials must use plugins.secrets')
      return structuredClone(row) as unknown as NotifyChannel
    })
  }
  if (patch.rules !== undefined) {
    if (!Array.isArray(patch.rules)) return invalid()
    patch.rules = patch.rules.map((rule) => {
      if (unexpected(rule, ['match', 'level', 'channels'])) return invalid()
      return structuredClone(rule) as NotifyRule
    })
  }
  return enqueue(k, async () => {
    const candidate = structuredClone(k.config)
    const previous = candidate.notify ?? { channels: [] }
    candidate.notify = {
      channels: patch.channels === undefined ? previous.channels : patch.channels as NotifyChannel[],
      ...(patch.rules === undefined ? (previous.rules ? { rules: previous.rules } : {}) : { rules: patch.rules as NotifyRule[] }),
      ...(previous.rateLimit ? { rateLimit: previous.rateLimit } : {}),
    }
    validateCandidate(k, candidate)
    const view = projectConfigView(k, candidate)
    try { saveConfig(k.home, candidate) } catch { throw new KernelError(makeProblem('DATA_UNAVAILABLE', 'Configuration could not be saved')) }
    k.config = candidate
    try {
      k.ledger.append({ type: 'annotation', origin: ctx.origin, subject: { orgId: 'org_local' }, payload: { kind: 'config.notify.set', fields: Object.keys(patch), channels: candidate.notify?.channels.length ?? 0, rules: candidate.notify?.rules?.length ?? 0 } })
    } catch { throw new KernelError(makeProblem('INTERNAL_ERROR', 'Configuration was saved but audit recording failed; reload configuration before retrying')) }
    return { notify: view.notify, restartRequired: true }
  })
}

export function registerConfigWriteOps(k: Kernel, ops: OpRegistry): void {
  ops.register('config.venues.set', { auth: 'session', presence: 'session', kind: 'command', allowSecretFields: true }, (ctx, params) => setVenues(k, ctx, params))
  ops.register('config.notify.set', { auth: 'session', presence: 'session', kind: 'command', allowSecretFields: true }, (ctx, params) => setNotify(k, ctx, params))
}
