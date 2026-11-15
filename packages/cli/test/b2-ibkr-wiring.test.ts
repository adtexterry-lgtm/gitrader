// SPDX-License-Identifier: CPAL-1.0
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Kernel } from '@gitrader/kernel'
import type { CliIo } from '../src/index'
import { FakeTws } from '../../connector-ibkr-trade/test/helpers/fake-tws'
import { makeHarness } from '../../kernel/test/helpers/harness'
import { DEFAULT_GATEWAY, DEFAULT_HOST, DEFAULT_MODE, IB_PORTS } from '../../connector-ibkr-trade/src/ids'
import { factoryFor } from '../src/connectors'

let redirectedPort = 0
const requestedTargets: Array<{ host: string; port: number }> = []

vi.mock('node:net', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:net')>()
  const ids = await import('../../connector-ibkr-trade/src/ids')
  return {
    ...actual,
    connect: ((options: { host?: string; port: number }, ...args: unknown[]) => {
      requestedTargets.push({ host: options.host ?? '', port: options.port })
      if (options.host !== ids.DEFAULT_HOST || options.port !== ids.IB_PORTS[ids.DEFAULT_GATEWAY][ids.DEFAULT_MODE] || redirectedPort <= 0) throw new Error('unexpected IBKR socket target')
      return actual.connect({ host: ids.DEFAULT_HOST, port: redirectedPort }, ...(args as never[]))
    }) as typeof actual.connect,
  }
})

const ioErrors: string[] = []
const io: CliIo = { out: () => undefined, err: (message) => ioErrors.push(message), env: {}, interactive: false, readSecret: async () => '' }
function makeKernelConfig(environment: 'mainnet' | 'testnet', symbols: string[] | undefined = ['AAPL'], accounts = [{ alias: 'ibkr-owner', venue: 'ibkr', environment, mode: 'live', owner: { accountRef: 'DU-TEST' } }]): Kernel {
  return {
    clock: { now: () => Date.UTC(2026, 9, 21, 14, 30, 0) },
    config: { venues: [{ id: 'ibkr', environment, enabled: true, ...(symbols !== undefined ? { symbols } : {}) }], accounts },
  } as unknown as Kernel
}

const k = makeKernelConfig('testnet')

let tws: FakeTws | undefined
let connector: { close?: () => Promise<void> } | undefined
let harness: Awaited<ReturnType<typeof makeHarness>> | undefined

function redirectToFakeTws(server: FakeTws): void {
  expect([8765, 8188, 9872, 9222, 8080, 5198, 4184, 14609, 47831]).not.toContain(server.port)
  redirectedPort = server.port
}

afterEach(async () => {
  await connector?.close?.().catch(() => undefined)
  await tws?.stop().catch(() => undefined)
  await harness?.cleanup()
  connector = undefined
  tws = undefined
  harness = undefined
  redirectedPort = 0
  requestedTargets.length = 0
  ioErrors.length = 0
  vi.restoreAllMocks()
})

describe('IBKR local assembly', () => {
  it('has a registered IBKR factory for explicit venue configuration', () => {
    expect(factoryFor('ibkr')).toBeDefined()
  })

  it('uses the default local session options and qualifies configured symbols before quoting', async () => {
    const factory = factoryFor('ibkr')
    expect(factory).toBeDefined()
    const made = factory!.create({ k, io, environment: 'testnet' })
    connector = made.connector as unknown as { close?: () => Promise<void> }
    expect(made.registration).toEqual({ unverified: true, pollOrders: true, deadman: false })
    tws = await FakeTws.start({ accounts: ['DU-OTHER', 'DU-TEST'], catalogue: { AAPL: {} }, quote: { bid: 100, ask: 101, last: 100.5 } })
    expect(tws.port).not.toBeLessThan(1024)
    redirectToFakeTws(tws)
    await made.start?.()
    expect(requestedTargets.length).toBeGreaterThan(0)
    expect(requestedTargets[0]).toEqual({ host: DEFAULT_HOST, port: IB_PORTS[DEFAULT_GATEWAY][DEFAULT_MODE] })
    expect(tws.frames(9).length).toBeGreaterThan(0)
    expect(made.connector.getInstrument('ibkr:AAPL' as never)).toBeDefined()
    expect(made.connector.quote('ibkr:AAPL' as never)?.last).toBe(100.5)
    expect((made.connector as unknown as { accounts: { accountId: string } }).accounts.accountId).toBe('DU-TEST')
  })

  it('keeps an enabled mainnet-configured venue paper and market-only when it has no live account', () => {
    const dataOnly = makeKernelConfig('mainnet', ['AAPL'], [])
    const made = factoryFor('ibkr')!.create({ k: dataOnly, io, environment: 'mainnet' })
    expect(made.kind).toBe('data')
    expect(made.marketOnly).toBe(true)
    expect(made.registration).toEqual({ unverified: true, pollOrders: false, deadman: false })
    expect((made.connector as unknown as { mode: string; environment: string }).mode).toBe('paper')
    expect((made.connector as unknown as { mode: string; environment: string }).environment).toBe('testnet')
  })

  it('registers a no-live source only for market reads and leaves live order routing unavailable', async () => {
    const localHarness = await makeHarness({ registerLive: false, configure: (config) => {
      config.venues = [{ id: 'ibkr', environment: 'mainnet', enabled: true, symbols: ['AAPL'] }]
      config.accounts = [{ accountId: 'acct_IBKRPAPER000000000000000001', alias: 'ibkr-paper', venue: 'ibkr', environment: 'mainnet', mode: 'paper', paper: { initialBalance: '10000', ccy: 'USD' }, owner: { accountRef: 'DU-PAPER' } }]
    } })
    harness = localHarness
    const made = factoryFor('ibkr')!.create({ k: localHarness.k, io, environment: 'mainnet' })
    localHarness.k.bus.registerMarketSource(made.connector, made.registration)
    expect(localHarness.k.bus.get('ibkr')).toBeUndefined()
    expect(localHarness.k.bus.marketSource('ibkr')).toBe(made.connector)
    expect(localHarness.k.bus.registrationOptions('ibkr')).toEqual({ unverified: true, pollOrders: false, deadman: false })
    const liveRoute = { ...localHarness.k.accounts.find('ibkr-paper')!, mode: 'live' } as never
    expect(() => localHarness.k.bus.routeFor(liveRoute)).toThrow('no connector registered for ibkr')
  })

  it('rejects mainnet live before creating a connector and refuses ambiguous account references or empty symbols', () => {
    expect(() => factoryFor('ibkr')!.create({ k: makeKernelConfig('mainnet'), io, environment: 'mainnet' })).toThrow('IBKR mainnet live trading is unavailable')
    expect(requestedTargets).toHaveLength(0)
    const ambiguous = makeKernelConfig('testnet', ['AAPL'], [
      { alias: 'one', venue: 'ibkr', environment: 'testnet', mode: 'paper', owner: { accountRef: 'DU-A' } },
      { alias: 'two', venue: 'ibkr', environment: 'testnet', mode: 'paper', owner: { accountRef: 'DU-B' } },
    ])
    expect(() => factoryFor('ibkr')!.create({ k: ambiguous, io, environment: 'testnet' })).toThrow('IBKR owner.accountRef configuration is ambiguous')
    expect(() => factoryFor('ibkr')!.create({ k: makeKernelConfig('testnet', [], []), io, environment: 'testnet' })).toThrow('IBKR requires configured symbols')
    expect(requestedTargets).toHaveLength(0)
  })

  it('lets a single-account market session auto-select when no owner reference is configured', async () => {
    const dataOnly = makeKernelConfig('testnet', ['AAPL'], [])
    const made = factoryFor('ibkr')!.create({ k: dataOnly, io, environment: 'testnet' })
    connector = made.connector as unknown as { close?: () => Promise<void> }
    tws = await FakeTws.start({ accounts: ['DU-SINGLE'], catalogue: { AAPL: {} }, quote: { bid: 100, ask: 101, last: 100.5 } })
    redirectToFakeTws(tws)
    await made.start?.()
    expect(made.marketOnly).toBe(true)
    expect(made.registration?.pollOrders).toBe(false)
    expect(made.connector.getInstrument('ibkr:AAPL' as never)).toBeDefined()
  })

  it('uses a unique configured owner reference for a market-only multi-account session', async () => {
    const dataOnly = makeKernelConfig('mainnet', ['AAPL'], [
      { alias: 'paper-account', venue: 'ibkr', environment: 'mainnet', mode: 'paper', owner: { accountRef: 'DU-SELECTED' } },
    ])
    const made = factoryFor('ibkr')!.create({ k: dataOnly, io, environment: 'mainnet' })
    connector = made.connector as unknown as { close?: () => Promise<void> }
    tws = await FakeTws.start({ accounts: ['DU-OTHER', 'DU-SELECTED'], catalogue: { AAPL: {} }, quote: { bid: 100, ask: 101, last: 100.5 } })
    redirectToFakeTws(tws)
    await made.start?.()
    expect(made.marketOnly).toBe(true)
    expect((made.connector as unknown as { accounts: { accountId: string } }).accounts.accountId).toBe('DU-SELECTED')
  })

  it('sanitizes the multi-account no-reference startup error without returning account names', async () => {
    const dataOnly = makeKernelConfig('testnet', ['AAPL'], [])
    const made = factoryFor('ibkr')!.create({ k: dataOnly, io, environment: 'testnet' })
    connector = made.connector as unknown as { close?: () => Promise<void> }
    tws = await FakeTws.start({ accounts: ['DU-ALPHA', 'DU-BETA'], catalogue: { AAPL: {} }, quote: { bid: 100, ask: 101, last: 100.5 } })
    redirectToFakeTws(tws)
    await expect(made.start?.()).rejects.toThrow('IBKR session needs owner.accountRef when multiple accounts are available')
    expect(ioErrors.join('')).not.toContain('DU-ALPHA')
    expect(ioErrors.join('')).not.toContain('DU-BETA')
  })

  it('does not report readiness when qualification fails for every configured symbol', async () => {
    const made = factoryFor('ibkr')!.create({ k, io, environment: 'testnet' })
    connector = made.connector as unknown as { close?: () => Promise<void> }
    tws = await FakeTws.start({ accounts: ['DU-TEST'], catalogue: {}, quote: { bid: 100, ask: 101, last: 100.5 } })
    redirectToFakeTws(tws)
    await expect(made.start?.()).rejects.toThrow('IBKR connector unavailable: DATA_UNAVAILABLE')
    expect(made.connector.getInstrument('ibkr:AAPL' as never)).toBeUndefined()
    expect(ioErrors.join('')).toContain('IBKR contract qualification failed for: AAPL')
  })

  it('keeps qualified symbols and quotes when another configured symbol cannot qualify', async () => {
    const twoSymbols = makeKernelConfig('testnet', ['AAPL', 'MSFT'])
    const made = factoryFor('ibkr')!.create({ k: twoSymbols, io, environment: 'testnet' })
    connector = made.connector as unknown as { close?: () => Promise<void> }
    tws = await FakeTws.start({ accounts: ['DU-TEST'], catalogue: { AAPL: {} }, quote: { bid: 100, ask: 101, last: 100.5 } })
    redirectToFakeTws(tws)
    await made.start?.()
    expect(made.connector.getInstrument('ibkr:AAPL' as never)).toBeDefined()
    expect(made.connector.quote('ibkr:AAPL' as never)?.last).toBe(100.5)
    expect(made.connector.getInstrument('ibkr:MSFT' as never)).toBeUndefined()
    expect(made.connector.quote('ibkr:MSFT' as never)).toBeUndefined()
    expect(ioErrors.join('')).toContain('IBKR contract qualification failed for: MSFT')
  })

  it('keeps a qualified instrument but fails readiness when no initial quote is available', async () => {
    const made = factoryFor('ibkr')!.create({ k, io, environment: 'testnet' })
    connector = made.connector as unknown as { close?: () => Promise<void> }
    tws = await FakeTws.start({ accounts: ['DU-TEST'], catalogue: { AAPL: {} }, quote: null })
    redirectToFakeTws(tws)
    await expect(made.start?.()).rejects.toThrow('IBKR connector unavailable: DATA_UNAVAILABLE')
    expect(made.connector.getInstrument('ibkr:AAPL' as never)).toBeDefined()
    expect(made.connector.quote('ibkr:AAPL' as never)).toBeUndefined()
    expect(ioErrors.join('')).toContain('IBKR market data unavailable for: AAPL')
  })

  it('routes a PIN-unlocked live order through real Kernel risk and IBKR wire, then reads back the mapped venue id', async () => {
    harness = await makeHarness({ registerLive: false, configure: (config) => {
      config.venues = [{ id: 'ibkr', environment: 'testnet', enabled: true, symbols: ['AAPL'] }]
      config.accounts = [{ accountId: 'acct_IBKRTEST00000000000000000001', alias: 'ibkr-owner', venue: 'ibkr', environment: 'testnet', mode: 'live', owner: { accountRef: 'DU-TEST' } }]
    } })
    harness.clock.set(Date.UTC(2026, 9, 21, 14, 30, 0))
    tws = await FakeTws.start({ accounts: ['DU-TEST'], catalogue: { AAPL: {} }, quote: { bid: 100, ask: 101, last: 100.5 } })
    redirectToFakeTws(tws)
    const made = factoryFor('ibkr')!.create({ k: harness.k, io, environment: 'testnet' })
    connector = made.connector as unknown as { close?: () => Promise<void> }
    harness.k.registerConnector(made.connector, made.registration)
    await made.start?.()
    await harness.pinProof()
    const account = harness.k.accounts.find('ibkr-owner')!
    const placed = await harness.k.trading.place({ intent: {
      accountId: account.accountId,
      instrumentId: 'ibkr:AAPL', side: 'buy', type: 'limit', size: '1', price: '100.5', tif: 'gtc', reason: 'local connector wiring',
    } as never }, harness.human())
    expect(placed.order?.status, JSON.stringify(placed.order?.problem)).toBe('open')
    expect(tws.ordersReceived()).toHaveLength(1)
    const readback = await made.connector.openOrders({ accountId: account.accountId, address: '0x0000000000000000000000000000000000000001' } as never)
    expect(readback).toHaveLength(1)
    expect(readback[0]?.venueOrderId).toBe(placed.order?.venueOrderId)
    expect(readback[0]?.venueOrderId).not.toBe(String(tws.ordersReceived()[0]?.orderId))
  })

  it('refreshes through context and lets the real risk gate deny an opening order on a 6000ms stale quote', async () => {
    harness = await makeHarness({ registerLive: false, configure: (config) => {
      config.venues = [{ id: 'ibkr', environment: 'testnet', enabled: true, symbols: ['AAPL'] }]
      config.accounts = [{ accountId: 'acct_IBKRTEST00000000000000000001', alias: 'ibkr-owner', venue: 'ibkr', environment: 'testnet', mode: 'live', owner: { accountRef: 'DU-TEST' } }]
    } })
    harness.clock.set(Date.UTC(2026, 9, 21, 14, 30, 0))
    tws = await FakeTws.start({ accounts: ['DU-TEST'], catalogue: { AAPL: {} }, quote: { bid: 100, ask: 101, last: 100.5 } })
    redirectToFakeTws(tws)
    const made = factoryFor('ibkr')!.create({ k: harness.k, io, environment: 'testnet' })
    connector = made.connector as unknown as { close?: () => Promise<void> }
    harness.k.registerConnector(made.connector, made.registration)
    await made.start?.()
    const firstTs = made.connector.quote('ibkr:AAPL' as never)?.ts
    harness.clock.advance(1000)
    const refreshedContext = await made.connector.context('ibkr:AAPL' as never)
    expect(refreshedContext.ts).toBe(harness.clock.now())
    expect(refreshedContext.ts).toBeGreaterThan(firstTs ?? 0)
    tws.options.quote = null
    harness.clock.advance(6000)
    const staleContext = await made.connector.context('ibkr:AAPL' as never)
    expect(staleContext.ts).toBe(refreshedContext.ts)
    await harness.pinProof()
    const account = harness.k.accounts.find('ibkr-owner')!
    const placed = await harness.k.trading.place({ intent: {
      accountId: account.accountId,
      instrumentId: 'ibkr:AAPL', side: 'buy', type: 'limit', size: '1', price: '100.5', tif: 'gtc', reason: 'stale quote gate',
    } as never }, harness.human())
    expect(placed.order?.status).toBe('denied')
    expect(placed.order?.problem?.ruleHits).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'STALE_PRICE', action: 'deny' })]))
    expect(tws.ordersReceived()).toHaveLength(0)
  })
})
