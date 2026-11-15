// SPDX-License-Identifier: CPAL-1.0
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConfigNotifySetParams, ConfigNotifySetView, ConfigVenueView, ConfigVenuesSetParams, ConfigVenuesSetView, ConfigView } from '@gitrader/protocol'
import * as configModule from '../src/config'
import { homePaths, loadConfig } from '../src/config'
import type { GitraderConfig } from '../src/config'
import type { Principal } from '../src/auth'
import { makeAgent, makeHarness } from './helpers/harness'
import type { Harness } from './helpers/harness'

let h: Harness | undefined
afterEach(async () => { await h?.cleanup(); h = undefined; vi.restoreAllMocks() })

const call = (name: string, params: Record<string, unknown>, pin?: string, principal: Principal = h!.session): Promise<unknown> => h!.k.ops.call(h!.k, name, { principal, params, pin, transport: 'ws' })
const setVenues = (patch: Record<string, unknown>, pin?: string, principal?: Principal): Promise<unknown> => call('config.venues.set', { patch }, pin, principal)
const setNotify = (patch: ConfigNotifySetParams, principal?: Principal): Promise<unknown> => call('config.notify.set', { ...patch }, undefined, principal)
const diskHash = (): string => createHash('sha256').update(readFileSync(homePaths(h!.home).config)).digest('hex')
const configSnapshot = (): GitraderConfig => structuredClone(h!.k.config)
const accountRows = (config: GitraderConfig): Record<string, unknown>[] => structuredClone(config.accounts) as unknown as Record<string, unknown>[]
const venueRows = (config: GitraderConfig): Record<string, unknown>[] => structuredClone(config.venues) as unknown as Record<string, unknown>[]
const noSecret = (value: unknown, canary: string): void => { expect(JSON.stringify(value)).not.toContain(canary) }

describe('B2-06 config writes through authenticated ops and temporary HOME', () => {
  it('saves a tightening change without PIN and returns a persisted safe view', async () => {
    h = await makeHarness()
    const venues = venueRows(h.k.config)
    venues[0]!.enabled = false
    const beforeView = await call('config.view', {}) as ConfigView
    const result = await setVenues({ venues }) as ConfigVenuesSetView
    expect(result.restartRequired).toBe(true)
    expect(result.config.venues).toEqual(venues)
    expect(result.config.accounts).toEqual(beforeView.accounts)
    expect(h.k.config.venues).toEqual(venues)
    expect(loadConfig(h.home).venues).toEqual(venues)
  })

  it('requires PIN for new live accounts, accepts a verified testnet live account with correct PIN, and generates its id once', async () => {
    h = await makeHarness()
    await h.pinProof()
    h.k.connectorCatalog = [
      { venue: 'hyperliquid', kind: 'trading', verified: true, credentials: [] },
      { venue: 'new-trading', kind: 'trading', verified: true, credentials: [] },
    ]
    const newVenuePatch = venueRows(h.k.config)
    newVenuePatch.push({ id: 'new-trading', environment: 'testnet', enabled: true })
    await expect(setVenues({ venues: newVenuePatch })).rejects.toMatchObject({ problem: { name: 'ATTESTATION_REQUIRED' } })
    const accounts = accountRows(h.k.config)
    accounts.push({ alias: 'live-added', venue: 'hyperliquid', environment: 'testnet', mode: 'live', signerRef: 'wallet-handle', owner: { accountRef: 'account-handle' } })
    await expect(setVenues({ accounts })).rejects.toMatchObject({ problem: { name: 'ATTESTATION_REQUIRED' } })
    await expect(setVenues({ accounts }, '000000')).rejects.toMatchObject({ problem: { name: 'AUTH_FAILED' } })
    const result = await setVenues({ accounts }, '482916') as ConfigVenuesSetView
    const added = result.config.accounts.find((account) => account.alias === 'live-added')
    expect(added?.accountId).toMatch(/^acct_/)
    expect(added?.owner).toEqual({ accountRef: 'account-handle' })
    expect(loadConfig(h.home).accounts.find((account) => account.alias === 'live-added')?.accountId).toBe(added?.accountId)
    expect(h.k.config.accounts.find((account) => account.alias === 'live-added')?.accountId).toBe(added?.accountId)
  })

  it('hard-rejects unverified mainnet live accounts even with a correct PIN', async () => {
    h = await makeHarness()
    await h.pinProof()
    h.k.connectorCatalog = [{ venue: 'unverified-main', kind: 'trading', verified: false, credentials: [] }]
    const venues = venueRows(h.k.config)
    venues.push({ id: 'unverified-main', environment: 'mainnet', enabled: true })
    const accounts = accountRows(h.k.config)
    accounts.push({ alias: 'main-live', venue: 'unverified-main', environment: 'mainnet', mode: 'live', signerRef: 'wallet-handle' })
    const before = diskHash()
    await expect(setVenues({ venues, accounts }, '482916')).rejects.toMatchObject({ problem: { name: 'INVALID_PARAMS' } })
    expect(diskHash()).toBe(before)
    expect(h.k.config.venues.some((venue) => venue.id === 'unverified-main')).toBe(false)
  })

  it('rejects unknown keys, duplicate ids, bad venue references, and raw credential values without disk changes or canary leaks', async () => {
    h = await makeHarness()
    const before = diskHash()
    const validVenues = venueRows(h.k.config)
    await expect(setVenues({ venues: validVenues, privateNote: 'CANARY_CONFIG_UNKNOWN' })).rejects.toMatchObject({ problem: { name: 'INVALID_PARAMS' } })
    await expect(setVenues({ venues: [...validVenues, { ...validVenues[0] }] })).rejects.toMatchObject({ problem: { name: 'INVALID_PARAMS' } })
    const badAccounts = accountRows(h.k.config)
    badAccounts.push({ alias: 'bad-ref', venue: 'unknown-venue', environment: 'testnet', mode: 'paper', paper: { initialBalance: '10', ccy: 'USD' } })
    await expect(setVenues({ accounts: badAccounts })).rejects.toMatchObject({ problem: { name: 'INVALID_PARAMS' } })
    const rawCredentials = accountRows(h.k.config)
    rawCredentials[0]!.credentials = { apiKey: 'CANARY_RAW_CREDENTIAL' }
    let error: unknown
    try { await setVenues({ accounts: rawCredentials }) } catch (caught) { error = caught }
    expect(error).toMatchObject({ problem: { name: 'INVALID_PARAMS' } })
    noSecret(error, 'CANARY_RAW_CREDENTIAL')
    const unknownCredentialHandle = accountRows(h.k.config)
    unknownCredentialHandle[0]!.credentials = { undeclaredCredential: 'env:UNDECLARED_HANDLE' }
    await expect(setVenues({ accounts: unknownCredentialHandle })).rejects.toMatchObject({ problem: { name: 'INVALID_PARAMS' } })
    expect(diskHash()).toBe(before)
  })

  it('requires PIN for live owner.accountRef changes and safely projects the saved account reference', async () => {
    h = await makeHarness()
    await h.pinProof()
    const accounts = accountRows(h.k.config)
    const live = accounts.find((account) => account.alias === 'live')!
    const existingAccountId = live.accountId
    delete live.accountId
    live.owner = { accountRef: 'new-account-reference' }
    await expect(setVenues({ accounts })).rejects.toMatchObject({ problem: { name: 'ATTESTATION_REQUIRED' } })
    const result = await setVenues({ accounts }, '482916') as ConfigVenuesSetView
    expect(result.config.accounts.find((account) => account.alias === 'live')?.owner).toEqual({ accountRef: 'new-account-reference' })
    expect(result.config.accounts.find((account) => account.alias === 'live')?.accountId).toBe(existingAccountId)
    expect(loadConfig(h.home).accounts.find((account) => account.alias === 'live')?.owner).toEqual({ accountRef: 'new-account-reference' })
  })

  it('replaces supplied notify arrays, preserves omitted rules and rate limits, and rejects nested credential keys', async () => {
    h = await makeHarness({ configure: (config) => {
      config.notify = {
        channels: [{ id: 'alerts', plugin: 'sample-plugin', minLevel: 'warn', params: { region: 'local' } }],
        rules: [{ match: '*', level: 'warn', channels: ['alerts'] }],
        rateLimit: { perChannelPerMinute: 3, dedupeWindowSec: 60 },
      }
    } })
    const result = await setNotify({ channels: [{ id: 'alerts', plugin: 'sample-plugin', minLevel: 'info', params: { region: 'changed' } }] }) as ConfigNotifySetView
    expect(result.restartRequired).toBe(true)
    expect(result.notify.channels[0]?.params).toEqual({ region: 'changed' })
    expect(result.notify.rules).toEqual([{ match: '*', level: 'warn', channels: ['alerts'] }])
    expect(result.notify.rateLimit).toEqual({ perChannelPerMinute: 3, dedupeWindowSec: 60 })
    const before = diskHash()
    let error: unknown
    try { await setNotify({ channels: [{ id: 'alerts', plugin: 'sample-plugin', minLevel: 'warn', params: { nested: [{ apiKey: 'CANARY_NOTIFY_WRITE' }] } }] }) } catch (caught) { error = caught }
    expect(error).toMatchObject({ problem: { name: 'INVALID_PARAMS', message: 'Notification credentials must use plugins.secrets' } })
    noSecret(error, 'CANARY_NOTIFY_WRITE')
    expect(diskHash()).toBe(before)
  })

  it('refuses a venue write before saving when an existing notify config cannot be safely projected', async () => {
    const canary = 'CANARY_LEGACY_NOTIFY'
    h = await makeHarness({ configure: (config) => {
      config.notify = { channels: [{ id: 'legacy', plugin: 'sample-plugin', minLevel: 'warn', params: { token: canary } }] }
    } })
    const before = diskHash()
    const memory = configSnapshot()
    const venues = venueRows(h.k.config)
    venues[0]!.enabled = false
    let error: unknown
    try { await setVenues({ venues }) } catch (caught) { error = caught }
    expect(error).toMatchObject({ problem: { name: 'DATA_UNAVAILABLE', message: 'Notification credentials must use plugins.secrets' } })
    noSecret(error, canary)
    expect(diskHash()).toBe(before)
    expect(h.k.config).toEqual(memory)
  })

  it('serializes concurrent venue and notify writes so neither patch is lost', async () => {
    h = await makeHarness()
    await h.pinProof()
    h.k.connectorCatalog = [{ venue: 'hyperliquid', kind: 'trading', verified: true, credentials: [] }]
    const accounts = accountRows(h.k.config)
    accounts.push({ alias: 'queued-live', venue: 'hyperliquid', environment: 'testnet', mode: 'live', signerRef: 'wallet-handle' })
    let entered!: () => void
    const pinStarted = new Promise<void>((resolve) => { entered = resolve })
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const originalPinProof = h.k.auth.pinProof.bind(h.k.auth)
    vi.spyOn(h.k.auth, 'pinProof').mockImplementation(async (...args) => { entered(); await gate; return originalPinProof(...args) })
    const venueWrite = setVenues({ accounts }, '482916')
    void venueWrite.catch(() => entered())
    await pinStarted
    const notifyWrite = setNotify({ channels: [{ id: 'queued', plugin: 'sample-plugin', minLevel: 'info', params: { region: 'local' } }] })
    release()
    const [venueResult, notifyResult] = await Promise.all([venueWrite, notifyWrite]) as [ConfigVenuesSetView, ConfigNotifySetView]
    expect(venueResult.config.accounts.some((account) => account.alias === 'queued-live')).toBe(true)
    expect(notifyResult.notify.channels.some((channel) => channel.id === 'queued')).toBe(true)
    expect(loadConfig(h.home).accounts.some((account) => account.alias === 'queued-live')).toBe(true)
    expect(loadConfig(h.home).notify?.channels.some((channel) => channel.id === 'queued')).toBe(true)
  })

  it('leaves memory and disk unchanged on save failure and allows the next queued write', async () => {
    h = await makeHarness()
    const before = diskHash()
    const memory = configSnapshot()
    const venues = venueRows(h.k.config)
    venues[0]!.enabled = false
    const save = vi.spyOn(configModule, 'saveConfig').mockImplementationOnce(() => { throw new Error('CANARY_SAVE_FAILURE') })
    let error: unknown
    try { await setVenues({ venues }) } catch (caught) { error = caught }
    expect(error).toMatchObject({ problem: { name: 'DATA_UNAVAILABLE' } })
    noSecret(error, 'CANARY_SAVE_FAILURE')
    expect(diskHash()).toBe(before)
    expect(h.k.config).toEqual(memory)
    save.mockRestore()
    const retry = venueRows(h.k.config)
    retry[0]!.enabled = false
    await expect(setVenues({ venues: retry })).resolves.toMatchObject({ restartRequired: true })
    expect(loadConfig(h.home).venues).toEqual(retry)
  })

  it('reports an audit failure after save without pretending rollback, then lets the queue continue', async () => {
    h = await makeHarness()
    const venues = venueRows(h.k.config)
    venues[0]!.enabled = false
    const append = h.k.ledger.append.bind(h.k.ledger)
    const audit = vi.spyOn(h.k.ledger, 'append').mockImplementation(((entry) => {
      if (entry.type === 'annotation' && (entry.payload as { kind?: string } | undefined)?.kind === 'config.venues.set') throw new Error('CANARY_AUDIT_FAILURE')
      return append(entry)
    }) as typeof h.k.ledger.append)
    let error: unknown
    try { await setVenues({ venues }) } catch (caught) { error = caught }
    expect(error).toMatchObject({ problem: { name: 'INTERNAL_ERROR', message: 'Configuration was saved but audit recording failed; reload configuration before retrying' } })
    noSecret(error, 'CANARY_AUDIT_FAILURE')
    expect(h.k.config.venues).toEqual(venues)
    expect(loadConfig(h.home).venues).toEqual(venues)
    audit.mockRestore()
    await expect(setNotify({ channels: [{ id: 'after-audit', plugin: 'sample-plugin', minLevel: 'warn', params: {} }] })).resolves.toMatchObject({ restartRequired: true })
    expect(loadConfig(h.home).notify?.channels[0]?.id).toBe('after-audit')
  })

  it('matches the protocol write params and response shapes through direct ops calls', async () => {
    h = await makeHarness()
    const venueParams = { patch: { venues: [] as ConfigVenueView[], accounts: [] } } satisfies ConfigVenuesSetParams
    const notifyParams = { channels: [] } satisfies ConfigNotifySetParams
    const venueResponse = await h.k.ops.call(h.k, 'config.venues.set', { principal: h.session, params: venueParams, transport: 'ws' }) as ConfigVenuesSetView
    const notifyResponse = await h.k.ops.call(h.k, 'config.notify.set', { principal: h.session, params: notifyParams, transport: 'ws' }) as ConfigNotifySetView
    expect(Object.keys(venueResponse).sort()).toEqual(['config', 'restartRequired'])
    expect(Object.keys(venueResponse.config).sort()).toEqual(['accounts', 'catalog', 'handles', 'notify', 'venues'])
    expect(Object.keys(notifyResponse).sort()).toEqual(['notify', 'restartRequired'])
    expect(Object.keys(notifyResponse.notify).sort()).toEqual(['channels'])
    const before = diskHash()
    await expect(h.k.ops.call(h.k, 'config.notify.set', { principal: h.session, params: { patch: { channels: [] } }, transport: 'ws' })).rejects.toMatchObject({ problem: { name: 'INVALID_PARAMS' } })
    expect(diskHash()).toBe(before)
  })

  it('enables a disabled data-only catalog entry in session without PIN and persists the protocol view', async () => {
    h = await makeHarness()
    h.k.connectorCatalog = [{ venue: 'local-data', kind: 'data', verified: true, credentials: [] }]
    const venues = venueRows(h.k.config)
    venues.push({ id: 'local-data', environment: 'testnet', enabled: false })
    await setVenues({ venues })
    const enabledVenues = structuredClone(venues)
    const dataVenue = { id: 'local-data', environment: 'testnet', enabled: true }
    enabledVenues[enabledVenues.length - 1] = dataVenue

    const result = await setVenues({ venues: enabledVenues }) as ConfigVenuesSetView
    expect(result).toMatchObject({ restartRequired: true, config: { venues: enabledVenues } })
    expect(result.config.catalog).toContainEqual({ venue: 'local-data', kind: 'data', verified: true, credentials: [] })
    expect(h.k.config.venues).toEqual(enabledVenues)
    expect(loadConfig(h.home).venues).toEqual(enabledVenues)
  })

  it('rejects service and agent principals for both write operations', async () => {
    h = await makeHarness()
    const agent = await makeAgent(h, 'read_only')
    const service: Principal = { kind: 'service' }
    await expect(setVenues({}, undefined, service)).rejects.toMatchObject({ problem: { name: 'AUTH_FAILED' } })
    await expect(setNotify({}, service)).rejects.toMatchObject({ problem: { name: 'AUTH_FAILED' } })
    await expect(setVenues({}, undefined, agent.principal)).rejects.toMatchObject({ problem: { name: 'AUTH_FAILED' } })
    await expect(setNotify({}, agent.principal)).rejects.toMatchObject({ problem: { name: 'AUTH_FAILED' } })
  })
})
