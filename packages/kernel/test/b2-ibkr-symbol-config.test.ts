// SPDX-License-Identifier: CPAL-1.0
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../src/config'
import { Kernel } from '../src/kernel'
import { fileProvider } from '../src/device-key'
import { FAST_SCRYPT, makeHarness } from './helpers/harness'
import type { Harness } from './helpers/harness'

let h: Harness | undefined
let restartedKernel: Kernel | undefined
afterEach(async () => { await restartedKernel?.stop().catch(() => undefined); restartedKernel = undefined; await h?.cleanup(); h = undefined })
type VenueRow = Record<string, unknown>
const venuesNow = (): VenueRow[] => structuredClone(h!.k.config.venues) as unknown as VenueRow[]
const accountsNow = (): Record<string, unknown>[] => structuredClone(h!.k.config.accounts) as unknown as Record<string, unknown>[]
const setVenues = (venues: VenueRow[], accounts?: Record<string, unknown>[], pin?: string): Promise<unknown> =>
  h!.k.ops.call(h!.k, 'config.venues.set', { principal: h!.session, params: { patch: { venues, ...(accounts ? { accounts } : {}) } }, pin, transport: 'ws' })
const addDisabledIbkr = (venues: VenueRow[], symbols?: unknown): void => {
  venues.push({ id: 'ibkr', environment: 'testnet', enabled: false, ...(symbols === undefined ? {} : { symbols }) })
}

async function configureLiveIbkr(): Promise<void> {
  h!.k.connectorCatalog = [{ venue: 'ibkr', kind: 'trading', verified: true, credentials: [] }]
  const venues = venuesNow()
  venues.push({ id: 'ibkr', environment: 'testnet', enabled: true })
  const accounts = accountsNow()
  accounts.push({ alias: 'local-live', venue: 'ibkr', environment: 'testnet', mode: 'live' })
  await h!.pinProof()
  await setVenues(venues, accounts, '482916')
}

describe('B2-08C0 IBKR symbols config', () => {
  it('persists and projects an IBKR symbols array without sharing the input array', async () => {
    h = await makeHarness()
    const beforeView = await h.k.ops.call(h.k, 'config.view', {
      principal: h.session, params: {}, transport: 'ws', kind: 'query',
    }) as { venues: VenueRow[] }
    const venues = structuredClone(beforeView.venues)
    const symbols = ['AAPL', 'BRK.B']
    addDisabledIbkr(venues, symbols)
    const response = await h.k.ops.call(h.k, 'config.venues.set', {
      principal: h.session, params: { patch: { venues } }, transport: 'ws',
    }) as { config: { venues: VenueRow[] }; restartRequired: boolean }
    symbols.push('MSFT')
    expect(response.config.venues.find((venue) => venue.id === 'ibkr')).toMatchObject({ symbols: ['AAPL', 'BRK.B'] })
    expect((loadConfig(h.home).venues as unknown as Array<Record<string, unknown>>).find((venue) => venue.id === 'ibkr'))
      .toMatchObject({ symbols: ['AAPL', 'BRK.B'] })
    const returned = response.config.venues.find((venue) => venue.id === 'ibkr')!
    ;(returned.symbols as string[]).push('NVDA')
    expect((h.k.config.venues as unknown as VenueRow[]).find((venue) => venue.id === 'ibkr'))
      .toMatchObject({ symbols: ['AAPL', 'BRK.B'] })
    await h.k.stop()
    restartedKernel = await Kernel.create({ home: h.home, clock: h.clock, scrypt: FAST_SCRYPT, deviceKeyProvider: fileProvider, timers: false })
    h.k = restartedKernel
    const boot = h.k.auth.mintBootToken()
    const session = h.k.auth.authenticateToken(h.k.auth.exchangeBoot(boot).sessionToken)!
    const persistedView = await h.k.ops.call(h.k, 'config.view', {
      principal: session, params: {}, transport: 'ws', kind: 'query',
    }) as { venues: VenueRow[] }
    expect(persistedView.venues.find((venue) => venue.id === 'ibkr'))
      .toMatchObject({ symbols: ['AAPL', 'BRK.B'] })
    expect(response.restartRequired).toBe(true)
  })

  it('keeps omitted and empty symbols compatible', async () => {
    h = await makeHarness()
    const omitted = venuesNow()
    addDisabledIbkr(omitted)
    await expect(setVenues(omitted)).resolves.toBeDefined()
    const empty = venuesNow()
    const ibkr = empty.find((venue) => venue.id === 'ibkr')!
    ibkr.symbols = []
    const result = await setVenues(empty) as { config: { venues: VenueRow[] } }
    expect(result.config.venues.find((venue) => venue.id === 'ibkr')).toMatchObject({ symbols: [] })
  })

  it.each([
    { label: 'another venue', venue: 'hyperliquid', symbols: ['AAPL'] },
    { label: 'duplicate ticker', venue: 'ibkr', symbols: ['AAPL', 'AAPL'] },
    { label: 'lowercase ticker', venue: 'ibkr', symbols: ['aapl'] },
    { label: 'whitespace', venue: 'ibkr', symbols: [' AAPL'] },
    { label: 'instrument id', venue: 'ibkr', symbols: ['ibkr:AAPL'] },
    { label: 'empty ticker', venue: 'ibkr', symbols: [''] },
    { label: 'non-string ticker', venue: 'ibkr', symbols: [5] },
    { label: 'over 100 tickers', venue: 'ibkr', symbols: Array.from({ length: 101 }, (_, index) => `T${index}`) },
  ])('rejects $label without changing persisted configuration', async ({ label: _label, venue, symbols }) => {
    h = await makeHarness()
    const venues = venuesNow()
    if (venue === 'ibkr') addDisabledIbkr(venues, symbols)
    else venues[0] = { ...venues[0]!, symbols }
    await expect(setVenues(venues)).rejects.toMatchObject({ problem: { name: 'INVALID_PARAMS' } })
    expect(loadConfig(h.home).venues).toEqual(h.k.config.venues)
  })

  it('allows symbols for a paper-only IBKR configuration without PIN', async () => {
    h = await makeHarness()
    const venues = venuesNow()
    addDisabledIbkr(venues, ['AAPL'])
    const accounts = accountsNow()
    accounts.push({ alias: 'local-paper', venue: 'ibkr', environment: 'testnet', mode: 'paper', paper: { initialBalance: '10000', ccy: 'USD' } })
    await expect(setVenues(venues, accounts)).resolves.toBeDefined()
    expect((loadConfig(h.home).venues as unknown as VenueRow[]).find((venue) => venue.id === 'ibkr'))
      .toMatchObject({ symbols: ['AAPL'] })
  })

  it('requires PIN for adding a symbol to an existing live IBKR account and allows removal without PIN', async () => {
    h = await makeHarness()
    await configureLiveIbkr()
    const added = venuesNow()
    added.find((venue) => venue.id === 'ibkr')!.symbols = ['AAPL']
    await expect(setVenues(added)).rejects.toMatchObject({ problem: { name: 'ATTESTATION_REQUIRED' } })
    await expect(setVenues(added, undefined, '482916')).resolves.toBeDefined()
    const removed = venuesNow()
    removed.find((venue) => venue.id === 'ibkr')!.symbols = []
    await expect(setVenues(removed)).resolves.toBeDefined()
    expect((loadConfig(h.home).venues as unknown as VenueRow[]).find((venue) => venue.id === 'ibkr'))
      .toMatchObject({ symbols: [] })
  })

  it('does not require PIN when the same save disables IBKR while adding a symbol', async () => {
    h = await makeHarness()
    await configureLiveIbkr()
    const venues = venuesNow()
    const ibkr = venues.find((venue) => venue.id === 'ibkr')!
    ibkr.enabled = false
    ibkr.symbols = ['AAPL']
    await expect(setVenues(venues)).resolves.toBeDefined()
    expect((loadConfig(h.home).venues as unknown as VenueRow[]).find((venue) => venue.id === 'ibkr'))
      .toMatchObject({ enabled: false, symbols: ['AAPL'] })
  })

  it('does not require PIN when the same save removes the last live IBKR account while adding a symbol', async () => {
    h = await makeHarness()
    await configureLiveIbkr()
    const venues = venuesNow()
    venues.find((venue) => venue.id === 'ibkr')!.symbols = ['AAPL']
    const accounts = accountsNow()
    const ibkr = accounts.find((account) => account.venue === 'ibkr')!
    ibkr.mode = 'paper'
    ibkr.paper = { initialBalance: '10000', ccy: 'USD' }
    await expect(setVenues(venues, accounts)).resolves.toBeDefined()
    expect((loadConfig(h.home).venues as unknown as VenueRow[]).find((venue) => venue.id === 'ibkr'))
      .toMatchObject({ symbols: ['AAPL'] })
    expect(loadConfig(h.home).accounts.find((account) => account.alias === 'local-live')?.mode).toBe('paper')
  })

  it('keeps mainnet IBKR hard rejection when adding symbols', async () => {
    h = await makeHarness()
    await configureLiveIbkr()
    h.k.connectorCatalog = [{ venue: 'ibkr', kind: 'trading', verified: false, credentials: [] }]
    const venues = venuesNow()
    venues.find((venue) => venue.id === 'ibkr')!.environment = 'mainnet'
    venues.find((venue) => venue.id === 'ibkr')!.symbols = ['AAPL']
    const accounts = accountsNow()
    accounts.find((account) => account.venue === 'ibkr')!.environment = 'mainnet'
    await expect(setVenues(venues, accounts, '482916')).rejects.toMatchObject({ problem: { name: 'INVALID_PARAMS' } })
  })

  it('compares symbols against the latest serialized configuration for queued writes', async () => {
    h = await makeHarness()
    await configureLiveIbkr()
    let entered!: () => void
    const pinStarted = new Promise<void>((resolve) => { entered = resolve })
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const originalPinProof = h.k.auth.pinProof.bind(h.k.auth)
    vi.spyOn(h.k.auth, 'pinProof').mockImplementation(async (...args) => { entered(); await gate; return originalPinProof(...args) })
    const first = venuesNow()
    first.find((venue) => venue.id === 'ibkr')!.symbols = ['AAPL']
    const firstWrite = setVenues(first, undefined, '482916')
    void firstWrite.catch(() => entered())
    await pinStarted
    const second = venuesNow()
    second.find((venue) => venue.id === 'ibkr')!.symbols = ['AAPL', 'MSFT']
    const secondWrite = setVenues(second).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    )
    release()
    await firstWrite
    const secondResult = await secondWrite
    expect('error' in secondResult).toBe(true)
    if (!('error' in secondResult)) throw new Error('queued symbol addition unexpectedly succeeded')
    expect(secondResult.error).toMatchObject({ problem: { name: 'ATTESTATION_REQUIRED' } })
    expect((loadConfig(h.home).venues as unknown as VenueRow[]).find((venue) => venue.id === 'ibkr'))
      .toMatchObject({ symbols: ['AAPL'] })
  })
})
