// SPDX-License-Identifier: CPAL-1.0
import { describe, expect, it } from 'vitest'
import { CONNECTOR_FACTORIES, assembleConnectors } from '../src/connectors'
import type { Kernel } from '@gitrader/kernel'
import type { CliIo } from '../src/index'

function fakeCatalogKernel(): Kernel {
  return {
    config: { venues: [], supportDeveloper: false },
    connectorCatalog: [],
    bus: { budgetFor: () => ({}) },
    clock: { now: () => 1_700_000_000_000 },
    registerConnector: () => undefined,
    connectInBackground: () => undefined,
  } as unknown as Kernel
}

const io: CliIo = { out: () => undefined, err: () => undefined, env: {}, interactive: false, readSecret: async () => '' }

describe('B2-04C connector catalog', () => {
  it('injects a cloned full static catalog with capability and credential metadata without changing factory kinds', () => {
    const k = fakeCatalogKernel()
    assembleConnectors({ k, io })
    const byVenue = new Map(k.connectorCatalog.map((entry) => [entry.venue, entry]))
    expect([...byVenue.keys()].sort()).toEqual(['alpaca', 'binance', 'bitget', 'bybit', 'coinbase', 'deribit', 'dydx', 'gateio', 'hyperliquid', 'ibkr', 'kraken', 'kucoin', 'okx'].sort())
    expect(byVenue.get('hyperliquid')).toEqual({ venue: 'hyperliquid', kind: 'trading', verified: true, credentials: [] })
    const tradeCredentials: Record<string, string[]> = {
      alpaca: ['apiKey', 'apiSecret'],
      binance: ['apiKey', 'apiSecret'],
      okx: ['apiKey', 'apiSecret', 'passphrase'],
      bybit: ['apiKey', 'apiSecret'],
      bitget: ['apiKey', 'apiSecret', 'passphrase'],
      gateio: ['apiKey', 'apiSecret'],
      ibkr: [],
    }
    for (const [venue, credentials] of Object.entries(tradeCredentials)) {
      expect(byVenue.get(venue)).toEqual({ venue, kind: 'trading', verified: false, credentials })
    }
    for (const venue of ['kraken', 'coinbase', 'kucoin', 'dydx', 'deribit']) {
      expect(byVenue.get(venue)).toEqual({ venue, kind: 'data', verified: false, credentials: [] })
    }
    expect(CONNECTOR_FACTORIES.find((factory) => factory.id === 'binance')?.kind).toBe('data')
    expect(CONNECTOR_FACTORIES.find((factory) => factory.id === 'okx')?.kind).toBe('data')

    k.connectorCatalog[0]!.credentials.push('MUTATED')
    k.connectorCatalog[0]!.verified = !k.connectorCatalog[0]!.verified
    const second = fakeCatalogKernel()
    assembleConnectors({ k: second, io })
    expect(second.connectorCatalog.some((entry) => entry.credentials.includes('MUTATED'))).toBe(false)
    expect(second.connectorCatalog).not.toBe(k.connectorCatalog)
  })
})
