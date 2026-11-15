// SPDX-License-Identifier: CPAL-1.0
import { describe, expect, it } from 'vitest'
import type { Kernel } from '@gitrader/kernel'
import type { CliIo } from '../src/index'
import { assembleConnectors, factoryFor } from '../src/connectors'
import { BinanceTradeConnector } from '@gitrader/connector-binance-trade'
import { OkxTradeConnector } from '@gitrader/connector-okx-trade'
import { BybitTradeConnector } from '@gitrader/connector-bybit-trade'
import { BitgetTradeConnector } from '@gitrader/connector-bitget-trade'
import { GateioTradeConnector } from '@gitrader/connector-gateio-trade'

const tradeVenues = ['binance', 'okx', 'bybit', 'bitget', 'gateio'] as const
const requiredKeys: Record<(typeof tradeVenues)[number], string[]> = {
  binance: ['apiKey', 'apiSecret'],
  okx: ['apiKey', 'apiSecret', 'passphrase'],
  bybit: ['apiKey', 'apiSecret'],
  bitget: ['apiKey', 'apiSecret', 'passphrase'],
  gateio: ['apiKey', 'apiSecret'],
}
const tradeClasses = {
  binance: BinanceTradeConnector,
  okx: OkxTradeConnector,
  bybit: BybitTradeConnector,
  bitget: BitgetTradeConnector,
  gateio: GateioTradeConnector,
}

function harness(venue: string, options: { environment?: 'mainnet' | 'testnet'; accounts?: unknown[]; credentials?: Record<string, string> } = {}) {
  const calls: { connector: { venue: string }; registration?: unknown }[] = []
  const budgetCalls: string[] = []
  const env: Record<string, string> = {}
  const credentials = options.credentials ?? Object.fromEntries((requiredKeys[venue as keyof typeof requiredKeys] ?? []).map((key) => [key, `env:${venue}_${key}`]))
  for (const [key, handle] of Object.entries(credentials)) env[handle.slice(4)] = `synthetic-${venue}-${key}`
  const k = {
    config: {
      venues: [{ id: venue, environment: options.environment ?? 'testnet', enabled: true }],
      accounts: options.accounts ?? [{ venue, environment: options.environment ?? 'testnet', mode: 'live', alias: 'test', credentials }],
      supportDeveloper: false,
    },
    opts: { resolveSecret: (ref: string) => env[ref.slice(4)] },
    bus: { budgetFor: (id: string) => { budgetCalls.push(id); return { take: () => true, takeSync: () => true, charge: () => undefined, remaining: () => 1, snapshot: () => ({}) } } },
    clock: { now: () => 1_700_000_000_000 },
    registerConnector: (connector: { venue: string }, registration?: unknown) => { calls.push({ connector, registration }) },
    connectInBackground: () => undefined,
  }
  const err: string[] = []
  const io: CliIo = { out: () => undefined, err: (s) => err.push(s), env, interactive: false, readSecret: async () => '' }
  return { k: k as unknown as Kernel, io, calls, budgetCalls, err }
}

describe('A3F trade connector factory selection', () => {
  it.each(tradeVenues)('selects the actual %s trade connector for same-venue testnet live credentials', (venue) => {
    const h = harness(venue)
    const created = factoryFor(venue)!.create({ k: h.k, io: h.io, environment: 'testnet' }) as { connector: { constructor: { name: string }; venue: string }; kind?: string; registration?: unknown }
    expect(created.kind).toBe('trading')
    expect(created.connector).toBeInstanceOf(tradeClasses[venue])
    expect(created.registration).toEqual({ unverified: true, pollOrders: true, deadman: false })
    expect(h.budgetCalls).toEqual([])
  })

  it.each(tradeVenues.flatMap((venue) => requiredKeys[venue].map((key) => [venue, key] as const)))('falls back to data when %s is missing %s and never emits values', (venue, key) => {
    const handles = Object.fromEntries(requiredKeys[venue].filter((candidate) => candidate !== key).map((candidate) => [candidate, `env:missing_${venue}_${candidate}`]))
    const h = harness(venue, { credentials: handles })
    const created = factoryFor(venue)!.create({ k: h.k, io: h.io, environment: 'testnet' }) as { connector: { venue: string }; kind?: string }
    expect(created.kind).toBe('data')
    expect(created.connector.venue).toBe(venue)
    expect(h.err.join('')).not.toContain('synthetic-')
  })

  it('hard-refuses same-venue mainnet live credentials before resolving secrets', () => {
    let resolveCalls = 0
    const h = harness('binance', { environment: 'testnet', accounts: [{ venue: 'binance', environment: 'mainnet', mode: 'live', alias: 'main', credentials: { apiKey: 'env:blocked_key', apiSecret: 'env:blocked_secret' } }] })
    ;(h.k as unknown as { opts: { resolveSecret: (ref: string) => string | undefined } }).opts.resolveSecret = () => { resolveCalls += 1; return 'synthetic' }
    const created = factoryFor('binance')!.create({ k: h.k, io: h.io, environment: 'testnet' }) as { connector: { venue: string }; kind?: string }
    expect(created.kind).toBe('data')
    expect(resolveCalls).toBe(0)
    expect(h.err.join('')).not.toContain('synthetic')
  })

  it('lists only the environment variable name when secret resolution fails', () => {
    const h = harness('binance')
    ;(h.k as unknown as { opts: { resolveSecret: () => undefined } }).opts.resolveSecret = () => undefined
    const created = factoryFor('binance')!.create({ k: h.k, io: h.io, environment: 'testnet' }) as { kind?: string }
    expect(created.kind).toBe('data')
    expect(h.err.join('')).toContain('binance_apiKey, binance_apiSecret')
    expect(h.err.join('')).not.toContain('synthetic')
  })

  it('does not let another venue mainnet account block this venue testnet trade', () => {
    const other = { venue: 'okx', environment: 'mainnet', mode: 'live', alias: 'other', credentials: { apiKey: 'env:other_key', apiSecret: 'env:other_secret', passphrase: 'env:other_pass' } }
    const target = { venue: 'binance', environment: 'testnet', mode: 'live', alias: 'target', credentials: { apiKey: 'env:binance_apiKey', apiSecret: 'env:binance_apiSecret' } }
    const h = harness('binance', { accounts: [other, target] })
    const created = factoryFor('binance')!.create({ k: h.k, io: h.io, environment: 'testnet' }) as { kind?: string }
    expect(created.kind).toBe('trading')
  })

  it('assembles real trade registration metadata and preserves paper-only data behavior', () => {
    const h = harness('binance')
    assembleConnectors({ k: h.k, io: h.io })
    const registeredTrade = h.calls.find((call) => call.connector.venue === 'binance')
    expect(registeredTrade?.registration).toEqual({ unverified: true, pollOrders: true, deadman: false })
    expect(h.calls.some((call) => call.connector.venue === 'kernel-sim')).toBe(true)

    const paper = harness('binance', { accounts: [{ venue: 'binance', environment: 'testnet', mode: 'paper', alias: 'paper' }] })
    const created = factoryFor('binance')!.create({ k: paper.k, io: paper.io, environment: 'testnet' }) as { connector: { venue: string }; kind?: string }
    expect(created.kind).toBe('data')
    expect(created.connector.venue).toBe('binance')
  })
})
