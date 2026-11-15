// SPDX-License-Identifier: CPAL-1.0
import { afterEach, describe, expect, it } from 'vitest'
import { makeHarness, makeAgent } from './helpers/harness'
import type { Harness } from './helpers/harness'
import type { Principal } from '../src/auth'
import { validateConfig } from '../src/config'

let h: Harness | undefined
afterEach(async () => { await h?.cleanup(); h = undefined })

describe('B2-04C config.view', () => {
  it('projects only safe config fields, reports resolver presence without leaking values, and returns defensive copies', async () => {
    const secretValue = 'CANARY_RESOLVED_VALUE_B2C'
    const thrownText = 'CANARY_RESOLVER_ERROR_B2C'
    const unknownFieldCanary = 'CANARY_UNKNOWN_VIEW_FIELD_B2C_RW1'
    let throwResolver = false
    h = await makeHarness({
      configure: (config) => {
        config.accounts[0]!.credentials = { apiKey: 'env:ENV_ACCOUNT_KEY_HANDLE' }
        config.plugins.secrets = { 'sample-plugin': { token: 'env:ENV_PLUGIN_TOKEN_HANDLE' } }
        config.notify = {
          channels: [{ id: 'alerts', plugin: 'sample-plugin', minLevel: 'warn', params: { nested: ['original'] } }],
          rules: [{ match: '*', level: 'warn', channels: ['alerts'], privateNote: unknownFieldCanary }],
          rateLimit: { perChannelPerMinute: 3, dedupeWindowSec: 60, privateNote: unknownFieldCanary },
        } as unknown as NonNullable<typeof config.notify>
      },
      kernel: { resolveSecret: () => { if (throwResolver) throw new Error(thrownText); return secretValue } },
    })
    expect(validateConfig(h.k.config)).toEqual([])
    h.k.connectorCatalog = [{ venue: 'sample-venue', kind: 'data', verified: false, credentials: ['API_KEY_HANDLE'], privateNote: unknownFieldCanary } as never]

    const result = await h.k.ops.call(h.k, 'config.view', { principal: h.session, params: {}, transport: 'ws', kind: 'query' }) as {
      venues: Array<Record<string, unknown>>
      accounts: Array<Record<string, any>>
      notify: { channels: Array<Record<string, any>>; rules?: Array<Record<string, any>>; rateLimit?: Record<string, any> }
      handles: Array<{ path: string; handle: string; resolved: boolean }>
      catalog: Array<Record<string, any>>
    }
    expect(result.venues).toEqual(h.k.config.venues)
    expect(Object.keys(result).sort()).toEqual(['accounts', 'catalog', 'handles', 'notify', 'venues'])
    expect(result.accounts[0]).toMatchObject({ alias: 'paper', credentials: { apiKey: 'env:ENV_ACCOUNT_KEY_HANDLE' } })
    expect(Object.keys(result.accounts[0]!).sort()).toEqual(['accountId', 'alias', 'credentials', 'environment', 'mode', 'paper', 'venue'])
    expect(result.notify.channels[0]).toEqual({ id: 'alerts', plugin: 'sample-plugin', minLevel: 'warn', params: { nested: ['original'] } })
    expect(result.notify.rules).toEqual([{ match: '*', level: 'warn', channels: ['alerts'] }])
    expect(result.notify.rateLimit).toEqual({ perChannelPerMinute: 3, dedupeWindowSec: 60 })
    expect(result.catalog).toEqual([{ venue: 'sample-venue', kind: 'data', verified: false, credentials: ['API_KEY_HANDLE'] }])
    expect(JSON.stringify(result)).not.toContain(unknownFieldCanary)
    expect(result.handles).toContainEqual({ path: 'plugins.secrets.sample-plugin.token', handle: 'env:ENV_PLUGIN_TOKEN_HANDLE', resolved: true })
    expect(JSON.stringify(result)).not.toContain(secretValue)
    expect(JSON.stringify(result)).not.toContain(thrownText)

    result.venues[0]!.enabled = false
    result.accounts[0]!.alias = 'mutated'
    result.accounts[0]!.credentials.apiKey = 'mutated'
    result.accounts[0]!.paper.initialBalance = '0'
    result.notify.channels[0]!.params.nested[0] = 'mutated'
    result.handles[0]!.handle = 'mutated'
    if (result.catalog[0]) result.catalog[0].venue = 'mutated'
    expect(h.k.config.venues[0]!.enabled).toBe(true)
    expect(h.k.config.accounts[0]!.alias).toBe('paper')
    expect(h.k.config.accounts[0]!.credentials!.apiKey).toBe('env:ENV_ACCOUNT_KEY_HANDLE')
    expect(h.k.config.accounts[0]!.paper!.initialBalance).toBe('10000')
    expect(h.k.config.notify!.channels[0]!.params.nested).toEqual(['original'])
    expect(h.k.config.plugins.secrets!['sample-plugin']!.token).toBe('env:ENV_PLUGIN_TOKEN_HANDLE')
    expect(h.k.connectorCatalog).toEqual([{ venue: 'sample-venue', kind: 'data', verified: false, credentials: ['API_KEY_HANDLE'], privateNote: unknownFieldCanary }])

    throwResolver = true
    const failedResolution = await h.k.ops.call(h.k, 'config.view', { principal: h.session, params: {}, transport: 'ws', kind: 'query' }) as { handles: Array<{ handle: string; resolved: boolean }> }
    expect(failedResolution.handles).toContainEqual({ path: 'plugins.secrets.sample-plugin.token', handle: 'env:ENV_PLUGIN_TOKEN_HANDLE', resolved: false })
    const visible = JSON.stringify({ result, failedResolution, ledger: h.k.ledger.query() })
    expect(visible).not.toContain(secretValue)
    expect(visible).not.toContain(thrownText)
    expect(visible).not.toContain(unknownFieldCanary)
  })

  it('defaults notify channels to empty and allows only a session principal', async () => {
    h = await makeHarness()
    h.k.config.notify = undefined
    const call = (principal: Principal) => h!.k.ops.call(h!.k, 'config.view', { principal, params: {}, transport: 'ws', kind: 'query' })
    await expect(call(h.session)).resolves.toMatchObject({ notify: { channels: [] } })
    const agent = await makeAgent(h, 'read_only')
    await expect(call(agent.principal)).rejects.toMatchObject({ problem: { name: 'AUTH_FAILED' } })
    await expect(call({ kind: 'service' })).rejects.toMatchObject({ problem: { name: 'AUTH_FAILED' } })
  })

  it.each([
    { label: 'token', params: { token: 'CANARY_NOTIFY_PARAM_B2C_RW2' } },
    { label: 'apiKey', params: { apiKey: 'CANARY_NOTIFY_PARAM_B2C_RW2' } },
    { label: 'webhookUrl', params: { webhookUrl: 'CANARY_NOTIFY_PARAM_B2C_RW2' } },
    { label: 'nested array credential', params: { nested: [{ accessToken: 'CANARY_NOTIFY_PARAM_B2C_RW2' }] } },
  ])('refuses notify.params credential-like keys ($label) without modifying source config', async ({ params }) => {
    const canary = 'CANARY_NOTIFY_PARAM_B2C_RW2'
    h = await makeHarness({
      configure: (config) => {
        config.notify = { channels: [{ id: 'unsafe', plugin: 'sample-plugin', minLevel: 'warn', params }] }
      },
    })
    expect(validateConfig(h.k.config)).toEqual([])
    const original = structuredClone(h.k.config.notify!.channels[0]!.params)
    let response: unknown
    let problem: unknown
    try {
      response = await h.k.ops.call(h.k, 'config.view', { principal: h.session, params: {}, transport: 'ws', kind: 'query' })
    } catch (error) {
      problem = error
    }
    const errorRecord = problem as { message?: unknown; problem?: unknown } | undefined
    const observed = JSON.stringify({ response, errorMessage: errorRecord?.message, errorProblem: errorRecord?.problem, ledger: h.k.ledger.query() })
    expect(observed).not.toContain(canary)
    expect(response).toBeUndefined()
    expect(problem).toMatchObject({ problem: { name: 'DATA_UNAVAILABLE', message: 'Notification credentials must use plugins.secrets' } })
    expect(h.k.config.notify!.channels[0]!.params).toEqual(original)
  })

  it('reports account credential handles for every account without exposing resolver values', async () => {
    const values = new Map<string, string | undefined>([
      ['env:ENV_ACCT0_API_KEY', 'CANARY_ACCOUNT_VALUE_ALPHA'],
      ['env:ENV_ACCT0_API_SECRET', 'CANARY_ACCOUNT_VALUE_BETA'],
      ['env:ENV_ACCT1_API_KEY', undefined],
      ['env:ENV_ACCT1_API_SECRET', ''],
    ])
    h = await makeHarness({
      configure: (config) => {
        config.accounts[0]!.credentials = { apiKey: 'env:ENV_ACCT0_API_KEY', apiSecret: 'env:ENV_ACCT0_API_SECRET' }
        config.accounts[1]!.credentials = { apiKey: 'env:ENV_ACCT1_API_KEY', apiSecret: 'env:ENV_ACCT1_API_SECRET' }
        config.plugins.secrets = { 'sample-plugin': { token: 'env:ENV_PLUGIN_LEGACY' } }
      },
      kernel: { resolveSecret: (handle) => handle === 'env:ENV_PLUGIN_LEGACY' ? 'CANARY_PLUGIN_VALUE' : values.get(handle) },
    })
    const result = await h.k.ops.call(h.k, 'config.view', { principal: h.session, params: {}, transport: 'ws', kind: 'query' }) as {
      handles: Array<{ path: string; handle: string; resolved: boolean }>
    }
    expect(result.handles).toEqual([
      { path: 'plugins.secrets.sample-plugin.token', handle: 'env:ENV_PLUGIN_LEGACY', resolved: true },
      { path: 'accounts[0].credentials.apiKey', handle: 'env:ENV_ACCT0_API_KEY', resolved: true },
      { path: 'accounts[0].credentials.apiSecret', handle: 'env:ENV_ACCT0_API_SECRET', resolved: true },
      { path: 'accounts[1].credentials.apiKey', handle: 'env:ENV_ACCT1_API_KEY', resolved: false },
      { path: 'accounts[1].credentials.apiSecret', handle: 'env:ENV_ACCT1_API_SECRET', resolved: false },
    ])
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('CANARY_ACCOUNT_VALUE_ALPHA')
    expect(serialized).not.toContain('CANARY_ACCOUNT_VALUE_BETA')
    expect(serialized).not.toContain('CANARY_PLUGIN_VALUE')
  })

  it('isolates resolver exceptions for account handles and exposes no thrown or resolved values', async () => {
    const exceptionCanary = 'CANARY_ACCOUNT_RESOLVER_EXCEPTION'
    const resolvedCanary = 'CANARY_ACCOUNT_RESOLVED_SECRET'
    h = await makeHarness({
      configure: (config) => {
        config.accounts[0]!.credentials = { apiKey: 'env:ENV_ACCOUNT_THROW', apiSecret: 'env:ENV_ACCOUNT_OK' }
      },
      kernel: { resolveSecret: (handle) => { if (handle === 'env:ENV_ACCOUNT_THROW') throw new Error(exceptionCanary); return resolvedCanary } },
    })
    const result = await h.k.ops.call(h.k, 'config.view', { principal: h.session, params: {}, transport: 'ws', kind: 'query' }) as {
      handles: Array<{ path: string; handle: string; resolved: boolean }>
    }
    expect(result.handles).toEqual([
      { path: 'accounts[0].credentials.apiKey', handle: 'env:ENV_ACCOUNT_THROW', resolved: false },
      { path: 'accounts[0].credentials.apiSecret', handle: 'env:ENV_ACCOUNT_OK', resolved: true },
    ])
    const serialized = JSON.stringify({ result, ledger: h.k.ledger.query() })
    expect(serialized).not.toContain(exceptionCanary)
    expect(serialized).not.toContain(resolvedCanary)
  })

  it('reports account handles unresolved when no resolver exists and omits credential-free accounts', async () => {
    h = await makeHarness({
      configure: (config) => {
        config.accounts[0]!.credentials = { apiKey: 'env:ENV_NO_RESOLVER_KEY', apiSecret: 'env:ENV_NO_RESOLVER_SECRET' }
        config.accounts[1]!.credentials = undefined
      },
    })
    const result = await h.k.ops.call(h.k, 'config.view', { principal: h.session, params: {}, transport: 'ws', kind: 'query' }) as {
      handles: Array<{ path: string; handle: string; resolved: boolean }>
    }
    expect(result.handles).toEqual([
      { path: 'accounts[0].credentials.apiKey', handle: 'env:ENV_NO_RESOLVER_KEY', resolved: false },
      { path: 'accounts[0].credentials.apiSecret', handle: 'env:ENV_NO_RESOLVER_SECRET', resolved: false },
    ])
  })
})
