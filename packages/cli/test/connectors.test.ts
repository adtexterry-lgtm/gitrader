// SPDX-License-Identifier: CPAL-1.0
import { describe, expect, it } from 'vitest'
import { loadConnectors } from '../src/index'
import type { CliIo } from '../src/index'
import { CONNECTOR_FACTORIES, assembleConnectors, factoryFor } from '../src/connectors'
import type { Kernel } from '@gitrader/kernel'

interface FakeKernel {
  k: Kernel
  registered: string[]
  connected: string[]
}

/** 假内核：venues 可控；budgetFor 返回假预算（可按 venue 设成抛错）；registerConnector / connectInBackground 只记录调用。 */
function fakeKernel(venues: unknown[], o: { failBudgetFor?: string } = {}): FakeKernel {
  const registered: string[] = []
  const connected: string[] = []
  const k = {
    config: { venues, supportDeveloper: false },
    bus: {
      budgetFor: (venue: string) => {
        if (o.failBudgetFor === venue) throw new Error('budget unavailable')
        return { venue, take: () => true, takeSync: () => true, charge: () => undefined, remaining: () => 1, snapshot: () => ({}) }
      },
    },
    clock: { now: () => 1_700_000_000_000 },
    registerConnector: (c: { venue: string }) => { registered.push(c.venue) },
    connectInBackground: (venue: string, _start: () => Promise<void>) => { connected.push(venue) },
  }
  return { k: k as unknown as Kernel, registered, connected }
}

const ioWith = (err: string[]): CliIo => ({
  out: () => undefined, err: (s) => { err.push(s) }, env: {}, interactive: false, readSecret: async () => '',
})

const ids = (r: { id: string }[]): string[] => r.map((x) => x.id)

describe('connector factories', () => {
  it('maps venue ids to factories and their kind', () => {
    expect(factoryFor('hyperliquid')?.kind).toBe('trading')
    expect(factoryFor('binance')?.kind).toBe('data')
    expect(factoryFor('okx')?.kind).toBe('data')
    expect(factoryFor('foo')).toBeUndefined()
  })

  it('maps the eight read-only data venue ids to data factories', () => {
    expect(factoryFor('kraken')?.kind).toBe('data')
    expect(factoryFor('coinbase')?.kind).toBe('data')
    expect(factoryFor('bybit')?.kind).toBe('data')
    expect(factoryFor('bitget')?.kind).toBe('data')
    expect(factoryFor('gateio')?.kind).toBe('data')
    expect(factoryFor('kucoin')?.kind).toBe('data')
    expect(factoryFor('dydx')?.kind).toBe('data')
    expect(factoryFor('deribit')?.kind).toBe('data')
  })

  it('keeps the ids in the table unique and in sync with factoryFor', () => {
    const tableIds = CONNECTOR_FACTORIES.map((f) => f.id)
    expect(new Set(tableIds).size).toBe(tableIds.length)
    for (const id of tableIds) expect(factoryFor(id)?.id).toBe(id)
  })
})

describe('assembleConnectors', () => {
  it('assembles hyperliquid, binance and the paper venue when both venues are configured', () => {
    const f = fakeKernel([{ id: 'hyperliquid', environment: 'testnet', enabled: true }, { id: 'binance', environment: 'mainnet', enabled: true }])
    const err: string[] = []
    const results = assembleConnectors({ k: f.k, io: ioWith(err) })
    expect(f.registered).toEqual(['hyperliquid', 'binance', 'kernel-sim'])
    expect(f.connected).toEqual(['hyperliquid', 'binance'])
    expect(err.join('')).not.toContain('unknown venue')
    expect(results).toEqual([{ id: 'hyperliquid', ok: true }, { id: 'binance', ok: true }])
    expect(ids(results)).toEqual(['hyperliquid', 'binance'])
  })

  it('registers binance alone and says the paper market is a read-only data feed', () => {
    const f = fakeKernel([{ id: 'binance', environment: 'mainnet', enabled: true }])
    const err: string[] = []
    const results = assembleConnectors({ k: f.k, io: ioWith(err) })
    expect(f.registered).toEqual(['binance', 'kernel-sim'])
    expect(f.connected).toEqual(['binance'])
    expect(err.join('')).toContain('PaperVenue')
    expect(err.join('')).toContain('只读')
    expect(err.join('')).toContain('data-only')
    expect(results).toEqual([{ id: 'binance', ok: true }])
  })

  it('registers hyperliquid, okx and the paper venue in the configured order', () => {
    const f = fakeKernel([{ id: 'hyperliquid', environment: 'testnet', enabled: true }, { id: 'okx', environment: 'mainnet', enabled: true }])
    const err: string[] = []
    const results = assembleConnectors({ k: f.k, io: ioWith(err) })
    expect(f.registered).toEqual(['hyperliquid', 'okx', 'kernel-sim'])
    expect(f.connected).toEqual(['hyperliquid', 'okx'])
    expect(err.join('')).not.toContain('unknown venue')
    expect(results).toEqual([{ id: 'hyperliquid', ok: true }, { id: 'okx', ok: true }])
    expect(ids(results)).toEqual(['hyperliquid', 'okx'])
  })

  it('registers hyperliquid, bybit, deribit and the paper venue in the configured order', () => {
    const f = fakeKernel([{ id: 'hyperliquid', environment: 'testnet', enabled: true }, { id: 'bybit', environment: 'mainnet', enabled: true }, { id: 'deribit', environment: 'mainnet', enabled: true }])
    const err: string[] = []
    const results = assembleConnectors({ k: f.k, io: ioWith(err) })
    expect(f.registered).toEqual(['hyperliquid', 'bybit', 'deribit', 'kernel-sim'])
    expect(f.connected).toEqual(['hyperliquid', 'bybit', 'deribit'])
    expect(results).toEqual([{ id: 'hyperliquid', ok: true }, { id: 'bybit', ok: true }, { id: 'deribit', ok: true }])
  })

  it('skips an unknown venue with a message and builds no paper venue', () => {
    const f = fakeKernel([{ id: 'foo' }])
    const err: string[] = []
    const results = assembleConnectors({ k: f.k, io: ioWith(err) })
    expect(err.join('')).toContain('unknown venue')
    expect(f.registered).toEqual([])
    expect(results).toEqual([{ id: 'foo', ok: false, error: 'unknown venue' }])
  })

  it('skips a disabled venue without an error and still builds the paper venue', () => {
    const f = fakeKernel([{ id: 'hyperliquid', environment: 'testnet', enabled: false }, { id: 'binance', environment: 'mainnet', enabled: true }])
    const err: string[] = []
    const results = assembleConnectors({ k: f.k, io: ioWith(err) })
    expect(f.registered).toEqual(['binance', 'kernel-sim'])
    expect(results).toEqual([{ id: 'binance', ok: true }])
  })

  it('skips a venue whose factory throws and keeps the remaining ones', () => {
    const f = fakeKernel([{ id: 'hyperliquid', environment: 'testnet', enabled: true }, { id: 'binance', environment: 'mainnet', enabled: true }], { failBudgetFor: 'hyperliquid' })
    const err: string[] = []
    const results = assembleConnectors({ k: f.k, io: ioWith(err) })
    expect(f.registered).toEqual(['binance', 'kernel-sim'])
    expect(err.join('')).toContain('could not set up the hyperliquid connector')
    expect(results).toEqual([{ id: 'hyperliquid', ok: false, error: 'budget unavailable' }, { id: 'binance', ok: true }])
  })

  it('builds no paper venue when every venue was skipped', () => {
    const f = fakeKernel([])
    const err: string[] = []
    const results = assembleConnectors({ k: f.k, io: ioWith(err) })
    expect(f.registered).toEqual([])
    expect(err.join('')).toContain('PaperVenue (kernel-sim) is not available')
    expect(results).toEqual([])
  })
})

describe('loadConnectors', () => {
  it('delegates to the registry and keeps the same registration order', () => {
    const f = fakeKernel([{ id: 'hyperliquid', environment: 'testnet', enabled: true }, { id: 'binance', environment: 'mainnet', enabled: true }])
    const err: string[] = []
    loadConnectors(f.k, ioWith(err))
    expect(f.registered).toEqual(['hyperliquid', 'binance', 'kernel-sim'])
    expect(f.connected).toEqual(['hyperliquid', 'binance'])
    expect(err.join('')).not.toContain('unknown venue')
  })
})
