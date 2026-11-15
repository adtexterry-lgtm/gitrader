// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest'
import type {
  AccountAssetsView, ConfigAccountView, ConfigNotifySetParams, ConfigNotifySetView, ConfigVenueView,
  ConfigVenuesSetParams, ConfigVenuesSetView, ConfigView, EngineCatalogEntry, EngineCatalogParam, EngineCatalogStrategy, EngineCatalogView, EngineStrategiesView, EngineStrategyView,
  EngineStrategyFailureView, EquityHistoryParams, EquityHistoryView, LabGetView, LabListView, LabRunView,
  LedgerEntry, PortfolioAnalysisResult, PortfolioAnalysisView, PortfolioPnlView, PortfolioShareView, RecordFillView, RecordsQueryParams, RecordsQueryView, VenueCatalogEntry,
} from '../src'
import type { AccountId, Decimal, InstanceId, LedgerId, Ms, ProposalId, Sha256Digest } from '../src'

// Importing this tuple from the package root is the type-consumer/export smoke check.
type PublicViews = [
  AccountAssetsView, EquityHistoryParams, EquityHistoryView, RecordsQueryParams, RecordsQueryView,
  RecordFillView, EngineStrategyView, EngineStrategyFailureView, EngineStrategiesView,
  LabListView, LabGetView, LabRunView, VenueCatalogEntry, ConfigVenueView, ConfigAccountView,
  ConfigView, ConfigVenuesSetParams, ConfigVenuesSetView, ConfigNotifySetParams, ConfigNotifySetView,
  EngineCatalogParam, EngineCatalogStrategy, EngineCatalogEntry, EngineCatalogView,
  PortfolioShareView, PortfolioPnlView, PortfolioAnalysisView, PortfolioAnalysisResult,
]

describe('B2 UI read view protocol types', () => {
  it('exports the complete type set from the protocol root', () => {
    const publicTypes: PublicViews[] = []
    expect(publicTypes).toEqual([])
  })

  it('keeps accounting values decimal strings and timestamps integer milliseconds', () => {
    const accountId = 'acct_sample' as AccountId
    const equity = '1250.75' as Decimal
    const ts: Ms = 1_798_761_600_000
    const assets: AccountAssetsView = {
      accountId,
      balances: [{ accountId, asset: 'USD', total: equity, available: '1200.00' as Decimal, hold: '50.75' as Decimal, ts }],
      margin: null,
      ts,
    }
    const query: EquityHistoryParams = { accountId, from: ts - 60_000, to: ts, step: '1m' }
    const history: EquityHistoryView = { points: [{ t: ts, equity, available: '1200.00' as Decimal }], gaps: [] }
    const recordsParams: RecordsQueryParams = { kind: 'funding', accountId, sinceTs: ts, limit: 500 }
    const hash = `sha256:${'0'.repeat(64)}` as Sha256Digest
    const fundingEntry: LedgerEntry = {
      schema: 'gitrader-ledger/1', seq: 1, id: 'led_sample' as LedgerId, ts, recordedAt: ts, type: 'funding',
      origin: { actor: 'system:funding', actorType: 'system', tool: 'ledger:funding', requestId: 'req_sample', via: 'internal' },
      subject: { accountId }, payloadHash: hash, attestation: 'kernel-observed', prevHash: hash, hash,
    }
    const records: RecordsQueryView = { items: [fundingEntry], next: 'opaque-cursor' }

    expect(assets.balances[0]?.total).toBe('1250.75')
    expect(typeof history.points[0]?.equity).toBe('string')
    expect(Number.isInteger(history.points[0]?.t)).toBe(true)
    expect(query).toMatchObject({ from: ts - 60_000, to: ts, step: '1m' })
    expect(recordsParams).toMatchObject({ kind: 'funding', limit: 500 })
    expect(records.items[0]).toBe(fundingEntry)
    expect(records.next).toBe('opaque-cursor')
  })

  it('represents per-engine failures explicitly and config credentials as handles', () => {
    const issue = { code: 1, name: 'ENGINE_UNAVAILABLE', category: 'ENGINE' as const, message: 'unavailable', retryable: true }
    const failed: EngineStrategyFailureView = { engineId: 'engine-a', unavailable: true, problem: issue }
    const success: EngineStrategyView = {
      engineId: 'engine-b', instanceId: 'inst_sample' as InstanceId, strategyId: 'sample-strategy',
      version: '1', accountId: 'acct_sample' as AccountId, state: 'running', params: { fast: 8 },
    }
    const aggregate: EngineStrategiesView = [success, failed]
    const catalog: VenueCatalogEntry = { venue: 'sample-venue', kind: 'trading', verified: false, credentials: ['API_KEY_HANDLE'] }
    const venue: ConfigVenueView = { id: 'sample-venue', environment: 'testnet', enabled: true }
    const account: ConfigAccountView = {
      alias: 'paper sample', venue: 'sample-venue', environment: 'testnet', mode: 'paper',
      paper: { initialBalance: '1000.00' as Decimal, ccy: 'USD' }, credentials: { key: 'env:KEY_HANDLE' },
    }
    const config: ConfigView = {
      venues: [venue], accounts: [account], notify: { channels: [] },
      handles: [{ path: 'sample', handle: 'env:KEY_HANDLE', resolved: false }], catalog: [catalog],
    }
    const venuePatch: ConfigVenuesSetParams = { patch: { venues: [venue] } }
    const ibkrVenue: ConfigVenueView = { id: 'ibkr', environment: 'testnet', enabled: false, symbols: ['AAPL', 'BRK.B'] }
    const venueResult: ConfigVenuesSetView = { config, restartRequired: true }
    const notifyPatch: ConfigNotifySetParams = { channels: [] }
    const notifyResult: ConfigNotifySetView = { notify: { channels: [] }, restartRequired: false }

    expect(aggregate).toMatchObject([{ engineId: 'engine-b', state: 'running' }, { engineId: 'engine-a', unavailable: true }])
    expect(venuePatch.patch.venues).toHaveLength(1)
    expect(venueResult.restartRequired).toBe(true)
    expect(notifyPatch.channels).toEqual([])
    expect(notifyResult.notify.channels).toEqual([])
    expect(config.accounts[0]?.credentials?.key).toBe('env:KEY_HANDLE')
    expect(ibkrVenue.symbols).toEqual(['AAPL', 'BRK.B'])
  })

  it('allows null fill origin when no related order exists', () => {
    const fill: RecordFillView = {
      fillId: 'fill_sample', orderId: 'ord_sample', clientOrderId: 'client-sample', venueFillId: 'venue-fill-sample',
      accountId: 'acct_sample', instrumentId: 'sample-venue:BTC', side: 'buy', price: '10.00' as Decimal,
      size: '2.00' as Decimal, fee: '0.01' as Decimal, feeCcy: 'USD', liquidity: 'maker', realizedPnl: '0' as Decimal,
      ts: 1_798_761_600_000, origin: null, proposalId: 'prop_sample' as ProposalId, ticket: 'T-20261022-0001',
    }
    expect(fill.origin).toBeNull()
    expect(fill.proposalId).toBe('prop_sample')
  })
})
