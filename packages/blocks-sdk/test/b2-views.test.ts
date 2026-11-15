// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ConfigNotifySetParams, ConfigVenuesSetParams } from '@gitrader/protocol'
import { KernelClient, LinkHub, createHostBridge } from '../src'
import { startFakeKernel, type FakeKernel, installViewFixtures } from '../src/testing/fake-kernel'
import { good } from './helpers'

const scenarios = ['normal', 'empty', 'partial-fill', 'venue-unavailable', 'ok-false', 'method-missing'] as const
type Scenario = (typeof scenarios)[number]
const venueWriteParams = { patch: { venues: [], accounts: [] } } satisfies ConfigVenuesSetParams
const notifyWriteParams = { channels: [] } satisfies ConfigNotifySetParams
const endpoints = [
  { name: 'account.assets', kind: 'query', params: { accountId: 'acct_sdk_fixture' } },
  { name: 'account.equity_history', kind: 'query', params: { accountId: 'acct_sdk_fixture', from: 1700000000000, to: 1700000060000, step: '1m' } },
  { name: 'records.query', kind: 'query', params: { kind: 'order', accountId: 'acct_sdk_fixture', limit: 1 } },
  { name: 'engine.strategies', kind: 'query', params: {} },
  { name: 'engine.catalog', kind: 'query', params: {} },
  { name: 'portfolio.analysis', kind: 'query', params: { scope: 'paper' } },
  { name: 'lab.list', kind: 'query', params: {} },
  { name: 'lab.get', kind: 'query', params: { experimentId: 'exp_sdk_fixture' } },
  { name: 'lab.run', kind: 'query', params: { experimentId: 'exp_sdk_fixture', runId: 'run_sdk_fixture' } },
  { name: 'config.view', kind: 'query', params: {} },
  { name: 'config.venues.set', kind: 'command', params: venueWriteParams },
  { name: 'config.notify.set', kind: 'command', params: notifyWriteParams },
] as const

let kernel: FakeKernel
let client: KernelClient

beforeEach(async () => {
  kernel = await startFakeKernel()
  const response = await fetch(`${kernel.url}/api/session`, { method: 'POST', body: JSON.stringify({ bootstrap: kernel.bootstrapToken }) })
  const token = ((await response.json()) as { sessionToken: string }).sessionToken
  client = new KernelClient({ url: kernel.wsUrl, getToken: () => token, reconnect: false })
  await client.connect()
})

afterEach(async () => {
  client.close()
  await kernel.close()
})

describe('SDK view fixtures use the exact public query and command protocol', () => {
  it.each(endpoints.flatMap((endpoint) => scenarios.map((scenario) => ({ endpoint, scenario }))))(
    '$endpoint.name returns the $scenario wire result through the real client and host bridge',
    async ({ endpoint, scenario }: { endpoint: (typeof endpoints)[number]; scenario: Scenario }) => {
      installViewFixtures(kernel, scenario)
      const queries = endpoints.filter((entry) => entry.kind === 'query').map((entry) => entry.name)
      const actions = endpoints.filter((entry) => entry.kind === 'command').map((entry) => entry.name)
      const host = createHostBridge({
        manifest: good({ inputs: { queries }, actions, permissions: ['account.read', 'ledger.read'] }),
        instanceId: 'bi_sdk_views',
        kernel: client,
        hub: new LinkHub(),
        trusted: true,
        isUserActive: () => true,
      })
      const invoke = () => endpoint.kind === 'query'
        ? host.query(endpoint.name, endpoint.params)
        : host.command(endpoint.name, endpoint.params)

      if (scenario === 'venue-unavailable') {
        await expect(invoke()).rejects.toMatchObject({ problemName: 'VENUE_UNAVAILABLE', problem: { retryable: true } })
        return
      }
      if (scenario === 'method-missing') {
        await expect(invoke()).rejects.toMatchObject({ problemName: 'METHOD_NOT_FOUND' })
        return
      }
      if (scenario === 'empty' && (endpoint.name === 'lab.get' || endpoint.name === 'lab.run')) {
        await expect(invoke()).rejects.toMatchObject({ problemName: 'EXPERIMENT_EVIDENCE_INCOMPLETE' })
        return
      }

      const result = await invoke()
      if (endpoint.kind === 'query') expect(kernel.queries.at(-1)?.method).toBe(endpoint.name)
      else expect(kernel.commands.at(-1)?.action).toBe(endpoint.name)
      const recorded = endpoint.kind === 'query' ? kernel.queries.at(-1) : kernel.commands.at(-1)
      expect(recorded?.params).toEqual(endpoint.params)

      if (scenario === 'ok-false') {
        expect(result).toMatchObject({ ok: false, error: { code: 4005, name: 'DATA_UNAVAILABLE', retryable: false } })
        return
      }
      if (scenario === 'empty') {
        if (endpoint.name === 'account.assets') expect(result).toMatchObject({ balances: [], margin: null })
        else if (endpoint.name === 'account.equity_history') expect(result).toEqual({ points: [], gaps: [] })
        else if (endpoint.name === 'records.query') expect(result).toEqual({ items: [] })
        else if (endpoint.name === 'engine.strategies') expect(result).toEqual([])
        else if (endpoint.name === 'engine.catalog') expect(result).toEqual([])
        else if (endpoint.name === 'portfolio.analysis') expect(result).toMatchObject({ scope: 'paper', byVenue: [], byStrategy: [], byInstrument: [] })
        else if (endpoint.name === 'lab.list') expect(result).toEqual({ items: [] })
        else if (endpoint.name === 'config.view') expect(result).toMatchObject({ venues: [], accounts: [], notify: { channels: [] } })
        else if (endpoint.name === 'config.venues.set') expect(result).toMatchObject({ config: { venues: [], accounts: [] }, restartRequired: true })
        else if (endpoint.name === 'config.notify.set') expect(result).toEqual({ notify: { channels: [] }, restartRequired: true })
        return
      }
      if (endpoint.name === 'account.assets') expect(result).toMatchObject({ accountId: 'acct_sdk_fixture', balances: [{ asset: 'USD', available: scenario === 'partial-fill' ? '850' : '900' }] })
      else if (endpoint.name === 'account.equity_history') expect(result).toMatchObject({ points: [{ t: 1700000000000, equity: scenario === 'partial-fill' ? '950' : '1000', available: scenario === 'partial-fill' ? '850' : '900' }], gaps: [] })
      else if (endpoint.name === 'records.query') expect(result).toMatchObject({ items: [{ orderId: 'ord_sdk_fixture', status: scenario === 'partial-fill' ? 'partially_filled' : 'filled', size: '1', filledSize: scenario === 'partial-fill' ? '0.25' : '1' }] })
      else if (endpoint.name === 'engine.strategies') expect(result).toMatchObject([{ instanceId: 'inst_sdk_fixture', strategyId: 'strategy_sdk_fixture', accountId: 'acct_sdk_fixture', state: 'running' }])
      else if (endpoint.name === 'engine.catalog') expect(result).toMatchObject([{ engineId: 'engine_sdk_fixture', strategies: [{ id: 'strategy_sdk_fixture', params: [{ key: 'period', type: 'integer' }] }] }])
      else if (endpoint.name === 'portfolio.analysis') expect(result).toMatchObject({ scope: 'paper', gross: '100', byInstrument: [{ key: 'hyperliquid:BTC', weight: '1' }] })
      else if (endpoint.name === 'lab.list') expect(result).toMatchObject({ items: [{ experimentId: 'exp_sdk_fixture', stage: 'backtest' }] })
      else if (endpoint.name === 'lab.get') expect(result).toMatchObject({ experimentId: 'exp_sdk_fixture', runSummaries: [], forwardSnapshots: [] })
      else if (endpoint.name === 'lab.run') expect(result).toMatchObject({ jobId: 'job_sdk_fixture', stats: { trades: 1, finalEquity: 1010 } })
      else if (endpoint.name === 'config.view') expect(result).toMatchObject({ venues: [{ id: 'venue_sdk_fixture', enabled: true }], accounts: [{ alias: 'sdk-fixture' }], handles: [], catalog: [] })
      else if (endpoint.name === 'config.venues.set') expect(result).toMatchObject({ config: { venues: [{ id: 'venue_sdk_fixture', environment: 'testnet', enabled: true }], accounts: [{ alias: 'sdk-fixture' }] }, restartRequired: true })
      else if (endpoint.name === 'config.notify.set') expect(result).toMatchObject({ notify: { channels: [{ id: 'alerts', plugin: 'fixture-plugin', minLevel: 'info' }] }, restartRequired: true })
    },
  )
})
