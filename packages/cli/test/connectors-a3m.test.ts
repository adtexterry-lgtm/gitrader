// SPDX-License-Identifier: CPAL-1.0
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Kernel, fileProvider, initHome, loadConfig, mkOrigin, saveConfig } from '@gitrader/kernel'
import type { Book, Instrument, InstrumentId } from '@gitrader/protocol'
import type { StampedQuote, SubscriptionSpec, Unsubscribe, VenueConnector, VenueEvent } from '@gitrader/protocol/connector'
import type { PaperMarket, PaperVenue } from '@gitrader/venue-paper'
import { main } from '../src/index'
import type { CliIo } from '../src/index'
import { assembleConnectors } from '../src/connectors'

const NOW = 1_800_000_000_000
const BINANCE_ID = 'binance:BTC-USDC' as InstrumentId
const BYBIT_ID = 'bybit:ETH-USDC' as InstrumentId

function instrument(venue: 'binance' | 'bybit', instrumentId: InstrumentId, base: string): Instrument {
  return {
    instrumentId, venue, symbol: `${base}USDC`, displaySymbol: `${base}/USDC`, kind: 'perp', base, quote: 'USDC', settle: 'USDC',
    settlement: 'linear', contractSize: '1' as never, venueSizeUnit: 'base', assetClass: 'crypto', status: 'trading',
    price: { tick: '0.01' as never }, size: { step: '0.001' as never, decimals: 3, min: '0.001' as never }, minNotional: '1' as never,
    orderTypes: ['limit', 'market'], tif: ['gtc', 'ioc'], triggerPriceTypes: [], updatedAt: NOW as never,
  }
}

function capabilities(venue: string) {
  return {
    venue: venue as never, environments: ['mainnet', 'testnet'] as const, instrumentKinds: ['perp'] as const,
    orderTypes: { limit: 'native' as const, market: 'native' as const }, tif: ['gtc', 'ioc'] as const,
    triggerPriceTypes: [], batch: { maxOrders: 10, atomic: true }, accountModels: ['standard'], marginModes: ['cross', 'isolated'],
  }
}

function quote(id: InstrumentId, px: number, ts = NOW): StampedQuote {
  return { instrumentId: id, ts: ts as never, bid: px - 0.5, ask: px + 0.5, last: px, stale: false, ageMs: Math.max(0, NOW - ts) }
}

function book(id: InstrumentId, ask: number, ts = NOW): Book {
  return { instrumentId: id, ts: ts as never, bids: [{ price: ask - 1, size: 2 }], asks: [{ price: ask, size: 2 }] }
}

interface Fixture {
  home: string
  k: Kernel
  paper: PaperVenue
  sources: Record<'binance' | 'bybit', VenueConnector>
  ioErrors: string[]
  paperEvents: Array<{ kind: string; instrumentId?: string; price?: string }>
  ctx: ReturnType<Kernel['auth']['authenticateToken']> extends infer _T ? { principal: NonNullable<ReturnType<Kernel['auth']['authenticateToken']>>; origin: ReturnType<typeof mkOrigin> } : never
  accountIds: { binance: string; bybit: string }
  now(): number
  advance(ms: number): void
}

async function makeFixture(): Promise<Fixture> {
  const home = mkdtempSync(join(tmpdir(), 'gitrader-a3m-'))
  initHome(home)
  const config = loadConfig(home)
  config.venues = [
    { id: 'binance', environment: 'mainnet', enabled: true },
    { id: 'bybit', environment: 'mainnet', enabled: true },
  ]
  config.accounts = [
    { accountId: 'acct_A3MBINANCE000000000000001', alias: 'paper-binance', venue: 'binance', environment: 'mainnet', mode: 'paper', paper: { initialBalance: '10000', ccy: 'USDC' } },
    { accountId: 'acct_A3MBYBIT0000000000000001', alias: 'paper-bybit', venue: 'bybit', environment: 'mainnet', mode: 'paper', paper: { initialBalance: '10000', ccy: 'USDC' } },
  ]
  saveConfig(home, config)
  let now = NOW
  const k = await Kernel.create({ home, timers: false, deviceKeyProvider: fileProvider, clock: { now: () => now }, sleep: async () => undefined })
  const ioErrors: string[] = []
  const io: CliIo = { out: () => undefined, err: (message) => ioErrors.push(message), env: {}, interactive: false, readSecret: async () => '' }
  const assembledKernel = Object.assign(Object.create(k), {
    registerConnector: k.registerConnector.bind(k),
    connectInBackground: (_venue: string, _start: () => Promise<void>) => undefined,
  }) as Kernel
  assembleConnectors({ k: assembledKernel, io })
  const sources = { binance: k.bus.get('binance')!, bybit: k.bus.get('bybit')! }
  const instruments = { binance: instrument('binance', BINANCE_ID, 'BTC'), bybit: instrument('bybit', BYBIT_ID, 'ETH') }
  for (const venue of ['binance', 'bybit'] as const) {
    const source = sources[venue]
    vi.spyOn(source, 'describe').mockReturnValue(capabilities(venue) as never)
    vi.spyOn(source, 'listInstruments').mockImplementation(() => [instruments[venue]])
    vi.spyOn(source, 'getInstrument').mockImplementation((id) => id === instruments[venue].instrumentId ? instruments[venue] : undefined)
    vi.spyOn(source, 'quote').mockImplementation((id) => id === instruments[venue].instrumentId ? quote(id, venue === 'binance' ? 100 : 200, now) : undefined)
    vi.spyOn(source, 'book').mockImplementation(async (id) => {
      if (id !== instruments[venue].instrumentId) throw new Error('instrument not present in this source')
      return book(id, venue === 'binance' ? 101 : 201, now)
    })
    vi.spyOn(source, 'candles').mockImplementation(async (id) => {
      if (id !== instruments[venue].instrumentId) throw new Error('instrument not present in this source')
      return []
    })
    vi.spyOn(source, 'context').mockImplementation(async (id) => {
      if (id !== instruments[venue].instrumentId) throw new Error('instrument not present in this source')
      return { instrumentId: id, ts: now as never, markPrice: venue === 'binance' ? 100 : 200, midPrice: venue === 'binance' ? 100 : 200, fundingIntervalMs: 3_600_000 as never }
    })
    vi.spyOn(source, 'subscribe').mockReturnValue(() => undefined)
    Object.defineProperty(source, 'bookSnapshot', { value: () => undefined, configurable: true })
    Object.defineProperty(source, 'refreshBook', { value: undefined, configurable: true })
  }
  const paper = k.bus.get('kernel-sim') as PaperVenue
  const paperEvents: Fixture['paperEvents'] = []
  paper.onEvent((event) => { if (event.kind === 'fill') paperEvents.push({ kind: event.kind, instrumentId: event.instrumentId, price: event.price }) })
  const principal = k.auth.authenticateToken(k.auth.exchangeBoot(k.auth.mintBootToken()).sessionToken)!
  return {
    home, k, paper, sources, ioErrors, paperEvents,
    ctx: { principal, origin: mkOrigin('user:usr_local', 'order', 'ui') },
    accountIds: { binance: 'acct_A3MBINANCE000000000000001', bybit: 'acct_A3MBYBIT0000000000000001' },
    now: () => now,
    advance: (ms) => { now += ms },
  }
}

let fixture: Fixture | undefined
let externalFetchCalls = 0

async function place(accountId: string, instrumentId: InstrumentId, limitPrice: string) {
  return fixture!.k.trading.place({ intent: {
    accountId: accountId as never, instrumentId, side: 'buy', type: 'limit', price: limitPrice as never,
    size: '0.01' as never, leverage: 1, tif: 'ioc',
  } }, fixture!.ctx)
}

describe('A3M PaperMarket adapter', () => {
  beforeEach(async () => {
    vi.restoreAllMocks()
    externalFetchCalls = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { externalFetchCalls++; throw new Error('external fetch blocked by A3M fixture') })
    fixture = await makeFixture()
  })
  afterEach(async () => {
    await fixture?.k.stop().catch(() => undefined)
    expect(externalFetchCalls).toBe(0)
    if (fixture) rmSync(fixture.home, { recursive: true, force: true, maxRetries: 5 })
    fixture = undefined
    vi.restoreAllMocks()
  })

  it('routes two real PaperVenue trades to their own venue quote and book and produces both fills', async () => {
    const binance = await place(fixture!.accountIds.binance, BINANCE_ID, '101')
    const bybit = await place(fixture!.accountIds.bybit, BYBIT_ID, '201')

    expect(binance.order?.status, JSON.stringify(binance.order?.problem)).toBe('filled')
    expect(bybit.order?.status, JSON.stringify(bybit.order?.problem)).toBe('filled')
    expect(fixture!.paperEvents).toEqual([
      { kind: 'fill', instrumentId: BINANCE_ID, price: '101' },
      { kind: 'fill', instrumentId: BYBIT_ID, price: '201' },
    ])
    expect(fixture!.paper.listInstruments().map((item) => item.instrumentId)).toEqual([BINANCE_ID, BYBIT_ID])
    expect(fixture!.paper.getInstrument(BYBIT_ID)?.venue).toBe('bybit')
  })

  it('uses book fallback without a source snapshot and keeps an old fallback book stale', async () => {
    const source = fixture!.sources.binance as VenueConnector & { bookSnapshot?: unknown; refreshBook?: unknown }
    Object.defineProperty(source, 'bookSnapshot', { value: undefined, configurable: true })
    Object.defineProperty(source, 'refreshBook', { value: undefined, configurable: true })
    const fresh = await place(fixture!.accountIds.binance, BINANCE_ID, '101')
    expect(fresh.order?.status, JSON.stringify(fresh.order?.problem)).toBe('filled')

    fixture!.advance(11_000)
    vi.spyOn(source, 'book').mockResolvedValue(book(BINANCE_ID, 101, fixture!.now() - 5_001))
    const staleSnapshot = await (fixture!.paper as unknown as { market: PaperMarket }).market.refreshBook?.(BINANCE_ID)
    expect(staleSnapshot?.stale).toBe(true)
    expect(staleSnapshot?.asOf).toBe(fixture!.now() - 5_001)
    expect(staleSnapshot?.book.ts).toBe(fixture!.now() - 5_001)
    const stale = await place(fixture!.accountIds.binance, BINANCE_ID, '101')
    expect(stale.order?.status).toBe('rejected')
    expect(stale.order?.problem?.name).toBe('STALE_PRICE')
    expect(stale.order?.problem?.code).toBe(2007)
  })

  it('forwards an available snapshot and refresh method for the selected source', async () => {
    const market = (fixture!.paper as unknown as { market: PaperMarket }).market
    const source = fixture!.sources.bybit as VenueConnector & { bookSnapshot?: (id: InstrumentId) => { book: Book; asOf: number; stale: boolean } | undefined; refreshBook?: (id: InstrumentId, options?: { maxWaitMs?: number }) => Promise<{ book: Book; asOf: number; stale: boolean } | undefined> }
    const snapshot = { book: book(BYBIT_ID, 201), asOf: fixture!.now(), stale: false }
    const readSnapshot = vi.fn((id: InstrumentId) => id === BYBIT_ID ? snapshot : undefined)
    const refresh = vi.fn(async (_id: InstrumentId) => snapshot)
    Object.defineProperty(source, 'bookSnapshot', { value: readSnapshot, configurable: true })
    Object.defineProperty(source, 'refreshBook', { value: refresh, configurable: true })

    expect(market.bookSnapshot?.(BYBIT_ID)).toBe(snapshot)
    expect(market.bookSnapshot?.(BINANCE_ID)).toBeUndefined()
    await expect(market.refreshBook?.(BYBIT_ID, { maxWaitMs: 12 })).resolves.toBe(snapshot)
    expect(readSnapshot).toHaveBeenCalledTimes(1)
    expect(refresh).toHaveBeenCalledWith(BYBIT_ID, { maxWaitMs: 12 })
  })

  it('does not fall back to another venue for an unknown instrument prefix', async () => {
    const unknown = 'unknown:BTC-USDC' as InstrumentId
    const market = (fixture!.paper as unknown as { market: PaperMarket }).market
    const routes = [
      vi.spyOn(fixture!.sources.binance, 'getInstrument').mockClear(), vi.spyOn(fixture!.sources.bybit, 'getInstrument').mockClear(),
      vi.spyOn(fixture!.sources.binance, 'quote').mockClear(), vi.spyOn(fixture!.sources.bybit, 'quote').mockClear(),
      vi.spyOn(fixture!.sources.binance, 'book').mockClear(), vi.spyOn(fixture!.sources.bybit, 'book').mockClear(),
      vi.spyOn(fixture!.sources.binance, 'candles').mockClear(), vi.spyOn(fixture!.sources.bybit, 'candles').mockClear(),
      vi.spyOn(fixture!.sources.binance, 'context').mockClear(), vi.spyOn(fixture!.sources.bybit, 'context').mockClear(),
      vi.spyOn(fixture!.sources.binance, 'subscribe').mockClear(), vi.spyOn(fixture!.sources.bybit, 'subscribe').mockClear(),
    ]
    expect(fixture!.paper.getInstrument(unknown)).toBeUndefined()
    expect(fixture!.paper.quote(unknown)).toBeUndefined()
    expect(market.bookSnapshot?.(unknown)).toBeUndefined()
    expect(typeof market.refreshBook).toBe('function')
    if (market.refreshBook) await expect(market.refreshBook(unknown)).resolves.toBeUndefined()
    await expect(market.book(unknown)).rejects.toThrow()
    await expect(market.candles(unknown, '1m' as never)).rejects.toThrow()
    await expect(market.context(unknown)).rejects.toThrow()
    expect(() => market.subscribe({ channel: 'quote', instrumentId: unknown }, () => undefined)).toThrow()
    for (const route of routes) expect(route).not.toHaveBeenCalled()
    await expect(place(fixture!.accountIds.binance, unknown, '101')).rejects.toThrow('INSTRUMENT_UNKNOWN')
  })

  it('returns undefined when the selected source book fallback fails', async () => {
    const market = (fixture!.paper as unknown as { market: PaperMarket }).market
    vi.spyOn(fixture!.sources.binance, 'book').mockRejectedValue(new Error('synthetic book failure'))
    expect(typeof market.refreshBook).toBe('function')
    if (market.refreshBook) await expect(market.refreshBook(BINANCE_ID)).resolves.toBeUndefined()
    expect(fixture!.ioErrors.join('')).not.toContain('synthetic book failure')
  })

  it('merges successful instrument sources, reports only the failed venue, and rejects when all fail', () => {
    vi.spyOn(fixture!.sources.bybit, 'listInstruments').mockImplementation(() => { throw new Error('synthetic upstream detail') })
    expect(fixture!.paper.listInstruments().map((item) => item.instrumentId)).toEqual([BINANCE_ID])
    expect(fixture!.ioErrors.join('')).toContain('bybit')
    expect(fixture!.ioErrors.join('')).not.toContain('synthetic upstream detail')

    vi.spyOn(fixture!.sources.binance, 'listInstruments').mockImplementation(() => { throw new Error('synthetic other detail') })
    expect(() => fixture!.paper.listInstruments()).toThrow()
    expect(fixture!.ioErrors.join('')).not.toContain('synthetic other detail')
  })

  it('combines no-instrument subscriptions and attempts all successful unsubscriptions before rethrowing the first error', () => {
    const callbacks: Array<(event: VenueEvent) => void> = []
    let binanceUnsubscribed = 0
    let bybitUnsubscribed = 0
    vi.spyOn(fixture!.sources.binance, 'subscribe').mockImplementation((_spec: SubscriptionSpec, callback) => {
      callbacks.push(callback)
      return () => { binanceUnsubscribed++; throw new Error('first cancellation failure') }
    })
    vi.spyOn(fixture!.sources.bybit, 'subscribe').mockImplementation((_spec: SubscriptionSpec, callback) => {
      callbacks.push(callback)
      return () => { bybitUnsubscribed++; throw new Error('second cancellation failure') }
    })
    const onEvent = vi.fn()
    const unsubscribe: Unsubscribe = fixture!.paper.subscribe({ channel: 'mids' }, onEvent)
    expect(callbacks).toHaveLength(2)
    expect(() => unsubscribe()).toThrow('first cancellation failure')
    expect(binanceUnsubscribed).toBe(1)
    expect(bybitUnsubscribed).toBe(1)
    expect(onEvent).not.toHaveBeenCalled()
  })

  it.each([undefined, null])('preserves the first unsubscribe failure when it throws %s', (firstFailure) => {
    let remainingUnsubscribeAttempted = false
    vi.spyOn(fixture!.sources.binance, 'subscribe').mockReturnValue(() => { throw firstFailure })
    vi.spyOn(fixture!.sources.bybit, 'subscribe').mockReturnValue(() => { remainingUnsubscribeAttempted = true; throw new Error('later cancellation failure') })
    const unsubscribe = fixture!.paper.subscribe({ channel: 'mids' }, () => undefined)
    let didThrow = false
    let caught: unknown
    try { unsubscribe() } catch (error) { didThrow = true; caught = error }
    expect(remainingUnsubscribeAttempted).toBe(true)
    expect(didThrow).toBe(true)
    expect(caught).toBe(firstFailure)
  })

  it('rejects private account subscriptions and rejects an unsupported public channel on every source', () => {
    const subscribe = vi.spyOn(fixture!.sources.binance, 'subscribe').mockImplementation(() => { throw new Error('synthetic unsupported detail') })
    const otherSubscribe = vi.spyOn(fixture!.sources.bybit, 'subscribe').mockImplementation(() => { throw new Error('synthetic unsupported detail') })
    expect(() => fixture!.paper.subscribe({ channel: 'userFills', address: '0x01' as never }, () => undefined)).toThrow()
    expect(subscribe).not.toHaveBeenCalled()
    expect(otherSubscribe).not.toHaveBeenCalled()
    expect(() => fixture!.paper.subscribe({ channel: 'mids' }, () => undefined)).toThrow()
    expect(subscribe).toHaveBeenCalledTimes(1)
    expect(otherSubscribe).toHaveBeenCalledTimes(1)
    expect(fixture!.ioErrors.join('')).not.toContain('synthetic unsupported detail')
  })

  it('routes quote subscription warnings through the fixed CLI warning prefix', () => {
    vi.spyOn(fixture!.sources.binance, 'subscribe').mockImplementation(() => { throw new Error('synthetic upstream detail') })
    expect(fixture!.paper.mark(BINANCE_ID)).toBeDefined()
    expect(fixture!.ioErrors).toContain('[gitrader] warning: 纸面场所行情订阅失败；仅使用本地报价\n')
    expect(fixture!.ioErrors.join('')).not.toContain('synthetic upstream detail')
  })
})

describe('A3M CLI status suffix', () => {
  it('marks only connector rows whose status is explicitly unverified', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gitrader-a3m-status-'))
    initHome(home)
    writeFileSync(join(home, 'service.json'), JSON.stringify({ port: 49123, pid: process.pid, token: 'synthetic-token', startedAt: 7 }))
    const status = {
      version: 'test', pid: process.pid, port: 49123, startedAt: 7, tradingState: 'ACTIVE', stateReasons: [], policy: null,
      policyIntegrity: { ok: true }, ledger: { seq: 0, count: 0 }, accounts: [],
      connections: ['binance', 'bybit', 'hyperliquid', 'kernel-sim'].map((venue) => ({ venue, state: 'connected' })),
      connectors: [
        { id: 'binance', status: { unverified: true } }, { id: 'bybit', status: {} },
        { id: 'hyperliquid', status: {} }, { id: 'kernel-sim', status: { unverified: false } },
      ],
      engines: [], plugins: [], warnings: [], pinSet: false, keystoreUnlocked: false,
    }
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      return url.endsWith('/api/health')
        ? new Response(JSON.stringify({ ok: true, startedAt: 7 }), { status: 200 })
        : new Response(JSON.stringify({ ok: true, result: status }), { status: 200 })
    })
    const out: string[] = []
    const io: CliIo = { out: (value) => out.push(value), err: () => undefined, env: { GITRADER_HOME: home }, interactive: false, readSecret: async () => '' }
    try {
      expect(await main(['status'], io)).toBe(0)
      const text = out.join('')
      // fix-r3 D5（裁决：gitrader status 改中文，场所状态英文码留在括号里）
      expect(text).toContain('binance 已连接（connected） [未经真网验证]')
      expect(text).toContain('bybit 已连接（connected）')
      expect(text).toContain('hyperliquid 已连接（connected）')
      expect(text).toContain('kernel-sim 已连接（connected）')
      expect(text.match(/\[未经真网验证\]/g)).toHaveLength(1)
      // fix-r3 D5：status 另读一次 risk.state 取账户 / 授权书级停机，所以多一次调用
      // fix-r4: status 再读一次 agentkey.list，把授权书编号换成钥匙名（不露 6 位编号），所以 3 次变 4 次
      expect(fetch).toHaveBeenCalledTimes(4)
    } finally {
      vi.restoreAllMocks()
      rmSync(home, { recursive: true, force: true, maxRetries: 5 })
    }
  })
})
