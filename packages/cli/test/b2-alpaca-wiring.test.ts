// SPDX-License-Identifier: CPAL-1.0
import { describe, expect, it, vi } from 'vitest'
import { assembleConnectors, factoryFor } from '../src/connectors'
import { makeHarness } from '../../kernel/test/helpers/harness'
import { FAST_SCRYPT, TEST_PIN } from '../../kernel/test/helpers/harness'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Kernel } from '../../kernel/src/kernel'
import { FakeClock } from '../../kernel/src/util/clock'
import { fileProvider } from '../../kernel/src/device-key'
import { mkOrigin } from '../../kernel/src/util/origin'
import type { CliIo } from '../src/index'
import { API_KEY, API_SECRET, LIVE_API_KEY, NOW, FakeAlpaca } from '../../connector-alpaca-trade/test/helpers/fake-alpaca'

class LocalSocket {
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  closed = false
  readonly sent: string[] = []
  constructor() { queueMicrotask(() => this.onopen?.()) }
  send(text: string): void {
    this.sent.push(text)
    const message = JSON.parse(text) as { action?: string }
    if (message.action === 'auth') queueMicrotask(() => this.emit({ stream: 'authorization', data: { status: 'authorized' } }))
    if (message.action === 'listen') queueMicrotask(() => this.emit({ stream: 'listening', data: { streams: ['trade_updates'] } }))
  }
  emit(value: unknown): void { this.onmessage?.({ data: JSON.stringify(value) }) }
  close(): void { this.closed = true; this.onclose?.() }
  drop(): void { this.closed = true; this.onclose?.() }
}

class RejectAuthSocket extends LocalSocket {
  override send(text: string): void {
    this.sent.push(text)
    if ((JSON.parse(text) as { action?: string }).action === 'auth') {
      queueMicrotask(() => this.emit({ stream: 'authorization', data: { status: 'unauthorized' } }))
    }
  }
}

const alpacaIo: CliIo = { out: () => undefined, err: () => undefined, env: {}, interactive: false, readSecret: async () => '' }
const configuredHarness = () => makeHarness({
  configure: (config) => {
    config.venues = [{ id: 'alpaca', environment: 'testnet', enabled: true }]
    config.accounts.push({
      alias: 'alpaca-live', venue: 'alpaca', environment: 'testnet', mode: 'live', accountId: 'alpaca-test-account',
      credentials: { apiKey: 'env:ALPACA_TEST_KEY', apiSecret: 'env:ALPACA_TEST_SECRET' },
    })
  },
  kernel: { resolveSecret: (handle) => handle === 'env:ALPACA_TEST_KEY' ? API_KEY : API_SECRET },
})

async function configuredBareKernel(options: {
  environment?: 'mainnet' | 'testnet'
  mode?: 'live' | 'paper' | 'shadow'
  credentials?: Record<string, string> | false
  extraAccounts?: Array<Record<string, unknown>>
  resolveSecret?: (handle: string) => string | undefined
  now?: number
} = {}) {
  const environment = options.environment ?? 'testnet'
  const mode = options.mode ?? 'live'
  const keyHandle = environment === 'mainnet' ? 'env:ALPACA_LIVE_KEY' : 'env:ALPACA_TEST_KEY'
  const secretHandle = environment === 'mainnet' ? 'env:ALPACA_LIVE_SECRET' : 'env:ALPACA_TEST_SECRET'
  const home = mkdtempSync(join(tmpdir(), 'gitrader-alpaca-assembly-'))
  const clock = new FakeClock(options.now ?? NOW)
  const kernelOptions = { home, clock, scrypt: FAST_SCRYPT, deviceKeyProvider: fileProvider, timers: false as const }
  const first = await Kernel.create(kernelOptions)
  await first.stop()
  const configPath = join(home, 'gitrader.json')
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>
  config['venues'] = [{ id: 'alpaca', environment, enabled: true }]
  const accounts = config['accounts'] as Array<Record<string, unknown>>
  const credentials = options.credentials === false ? undefined : options.credentials ?? { apiKey: keyHandle, apiSecret: secretHandle }
  accounts.push({
    alias: 'alpaca-configured', venue: 'alpaca', environment, mode, accountId: 'acct_ALPACA00000000000000000001',
    ...(mode === 'paper' ? { paper: { initialBalance: '1000', ccy: 'USD' } } : {}),
    ...(credentials ? { credentials } : {}),
  })
  accounts.push(...(options.extraAccounts ?? []))
  writeFileSync(configPath, JSON.stringify(config, null, 2))
  const k = await Kernel.create({
    ...kernelOptions, sleep: async () => undefined,
    resolveSecret: options.resolveSecret ?? ((handle) => handle === 'env:ALPACA_LIVE_KEY' ? LIVE_API_KEY : handle === 'env:ALPACA_TEST_KEY' ? API_KEY : API_SECRET),
  })
  const boot = k.auth.mintBootToken()
  const exchanged = k.auth.exchangeBoot(boot)
  const session = k.auth.authenticateToken(exchanged.sessionToken)!
  const pinProof = async () => {
    if (!k.pin.isSet()) {
      const proof = await k.auth.setupPin(session, TEST_PIN)
      k.keystore.unlock(proof)
      return proof
    }
    return k.auth.pinProof(session, TEST_PIN)
  }
  const human = (tool = 'test') => ({ principal: session, origin: mkOrigin('user:usr_local', tool, 'ui') })
  return { k, clock, session, pinProof, human, cleanup: async () => { await k.stop().catch(() => undefined); rmSync(home, { recursive: true, force: true }) } }
}

describe('Alpaca shared connector assembly', () => {
  it('creates separate real trading and market connectors for a live testnet account', async () => {
    const h = await configuredHarness()
    try {
      const factory = factoryFor('alpaca')
      expect(factory).toBeDefined()
      const created = factory!.create({ k: h.k, io: alpacaIo, environment: 'testnet' })
      expect('marketSource' in created).toBe(true)
      expect(created.kind).toBe('trading')
      expect(created.registration).toEqual({ unverified: true, pollOrders: false, deadman: false })
    } finally {
      await h.cleanup()
    }
  })

  it('registers both real sources and reaches listening before startup reconciliation', async () => {
    const h = await configuredBareKernel()
    const fake = new FakeAlpaca()
    const sockets: LocalSocket[] = []
    vi.stubGlobal('fetch', fake.fetch)
    vi.stubGlobal('WebSocket', class extends LocalSocket { constructor() { super(); sockets.push(this) } })
    const reconcile = vi.spyOn(h.k, 'startupReconcile')
    try {
      const results = assembleConnectors({ k: h.k, io: alpacaIo })
      expect(results).toEqual([{ id: 'alpaca', ok: true }])
      expect(h.k.bus.get('alpaca')).toBeDefined()
      expect(h.k.bus.marketSource('alpaca')).toBeDefined()
      await vi.waitFor(() => expect(h.k.connectionStatus().find((entry) => entry.venue === 'alpaca')?.state).toBe('connected'), { timeout: 2_000 })
      expect(sockets).toHaveLength(1)
      expect(JSON.parse(sockets[0]!.sent[0]!)).toMatchObject({ action: 'auth' })
      expect(JSON.parse(sockets[0]!.sent[1]!)).toEqual({ action: 'listen', data: { streams: ['trade_updates'] } })
      expect(fake.calls.filter((call) => call.path === '/v2/assets')).toHaveLength(2)
      expect(fake.calls.filter((call) => call.path === '/v2/calendar')).toHaveLength(2)
      expect(reconcile).toHaveBeenCalled()
    } finally {
      await h.cleanup()
      vi.unstubAllGlobals()
    }
  })

  it('keeps data-only accounts out of the trading map and marks them unverified', async () => {
    const h = await configuredBareKernel({ mode: 'paper' })
    const fake = new FakeAlpaca()
    vi.stubGlobal('fetch', fake.fetch)
    try {
      const results = assembleConnectors({ k: h.k, io: alpacaIo })
      expect(results).toEqual([{ id: 'alpaca', ok: true }])
      expect(h.k.bus.get('alpaca')).toBeUndefined()
      expect(h.k.bus.marketSource('alpaca')).toBeDefined()
      expect(h.k.bus.registrationOptions('alpaca')).toMatchObject({ unverified: true, pollOrders: false, deadman: false })
      await vi.waitFor(() => expect(fake.calls.filter((call) => call.path === '/v2/calendar')).toHaveLength(1), { timeout: 2_000 })
      expect(h.k.bus.marketSource('alpaca')!.listInstruments()).not.toHaveLength(0)
    } finally {
      await h.cleanup()
      vi.unstubAllGlobals()
    }
  })

  it('rejects missing credential handles without creating a data connector', async () => {
    const h = await configuredBareKernel({ mode: 'paper', credentials: false })
    try {
      const results = assembleConnectors({ k: h.k, io: alpacaIo })
      expect(results).toEqual([{ id: 'alpaca', ok: false, error: 'Alpaca connector unavailable: configured credentials are missing or ambiguous' }])
      expect(h.k.bus.get('alpaca')).toBeUndefined()
      expect(h.k.bus.marketSource('alpaca')).toBeUndefined()
    } finally {
      await h.cleanup()
    }
  })

  it('keeps a mainnet live account out of trading while allowing its read-only market source', async () => {
    const h = await configuredBareKernel({ environment: 'mainnet', mode: 'live' })
    const fake = new FakeAlpaca()
    const warnings: string[] = []
    const io: CliIo = { ...alpacaIo, err: (text) => warnings.push(text) }
    vi.stubGlobal('fetch', fake.fetch)
    try {
      const results = assembleConnectors({ k: h.k, io })
      expect(results).toEqual([{ id: 'alpaca', ok: true }])
      expect(h.k.bus.get('alpaca')).toBeUndefined()
      expect(h.k.bus.marketSource('alpaca')).toBeDefined()
      expect(h.k.bus.registrationOptions('alpaca')).toMatchObject({ unverified: true, pollOrders: false, deadman: false })
      expect(h.k.connectorCatalog.find((entry) => entry.venue === 'alpaca')?.kind).toBe('trading')
      expect(warnings.join('')).toContain('Alpaca trade connector is unavailable for a mainnet live account')
      await vi.waitFor(() => expect(fake.calls.filter((call) => call.path === '/v2/calendar')).toHaveLength(1), { timeout: 2_000 })
      expect(h.k.bus.marketSource('alpaca')!.describe()['x-environment']).toBe('live')
      expect(warnings.join('')).not.toContain(API_SECRET)
    } finally {
      await h.cleanup()
      vi.unstubAllGlobals()
    }
  })

  it('rejects distinct complete data credential pairs before constructing a source', async () => {
    const h = await configuredBareKernel({
      mode: 'paper',
      extraAccounts: [{ alias: 'alpaca-shadow', venue: 'alpaca', environment: 'testnet', mode: 'shadow', credentials: { apiKey: 'env:OTHER_KEY', apiSecret: 'env:OTHER_SECRET' } }],
    })
    try {
      const results = assembleConnectors({ k: h.k, io: alpacaIo })
      expect(results).toEqual([{ id: 'alpaca', ok: false, error: 'Alpaca connector unavailable: configured credentials are missing or ambiguous' }])
      expect(h.k.bus.marketSource('alpaca')).toBeUndefined()
    } finally {
      await h.cleanup()
    }
  })

  it('does not expose resolver exceptions or create a source when secret resolution fails', async () => {
    const canary = 'resolver-private-canary'
    const h = await configuredBareKernel({ mode: 'paper', resolveSecret: () => { throw new Error(canary) } })
    const warnings: string[] = []
    try {
      const results = assembleConnectors({ k: h.k, io: { ...alpacaIo, err: (text) => warnings.push(text) } })
      expect(results).toEqual([{ id: 'alpaca', ok: false, error: 'Alpaca connector unavailable: configured credentials are missing or ambiguous' }])
      expect(warnings.join('')).not.toContain(canary)
      expect(h.k.bus.marketSource('alpaca')).toBeUndefined()
    } finally {
      await h.cleanup()
    }
  })

  it('places through TradingService and reads a real private-stream partial fill through records.query', async () => {
    const h = await configuredBareKernel()
    const fake = new FakeAlpaca()
    const sockets: LocalSocket[] = []
    vi.stubGlobal('fetch', fake.fetch)
    vi.stubGlobal('WebSocket', class extends LocalSocket { constructor() { super(); sockets.push(this) } })
    try {
      const result = assembleConnectors({ k: h.k, io: alpacaIo })
      expect(result).toEqual([{ id: 'alpaca', ok: true }])
      await vi.waitFor(() => expect(h.k.connectionStatus().find((entry) => entry.venue === 'alpaca')?.state).toBe('connected'), { timeout: 2_000 })
      await h.pinProof()
      const accountId = h.k.accounts.find('alpaca-configured')!.accountId
      const placed = await h.k.trading.place({ intent: {
        accountId, instrumentId: 'alpaca:AAPL', side: 'buy', type: 'market', size: '1', reason: 'C1 local fixture',
      } as never }, h.human('order.place'))
      expect(placed.order?.status, JSON.stringify(placed.order?.problem)).toBe('open')
      expect(fake.callsFor('POST', '/v2/orders')).toHaveLength(1)
      const order = placed.order!
      sockets[0]!.drop()
      await vi.waitFor(() => expect(h.k.connectionStatus().find((entry) => entry.venue === 'alpaca')?.state).not.toBe('connected'), { timeout: 2_000 })
      expect(h.k.reconnect('alpaca').state).toBe('connecting')
      await vi.waitFor(() => expect(h.k.connectionStatus().find((entry) => entry.venue === 'alpaca')?.state).toBe('connected'), { timeout: 2_000 })
      expect(sockets).toHaveLength(2)
      expect(sockets[0]!.closed).toBe(true)
      const insertFill = vi.spyOn(h.k.orders, 'insertFill')
      sockets[1]!.emit({ stream: 'trade_updates', data: {
        event: 'partial_fill', execution_id: 'c1-partial-exec', price: '190.01', qty: '0.5',
        position_qty: '0.5', timestamp: new Date(NOW).toISOString(),
        order: {
          id: 'ord-1', client_order_id: order.clientOrderId, symbol: 'AAPL', side: 'buy',
          status: 'partially_filled', qty: '1', filled_qty: '0.5', filled_avg_price: '190.01',
        },
      } })
      expect(insertFill).toHaveBeenCalledTimes(1)
      expect(h.k.orders.get(order.orderId)?.status).toBe('partially_filled')
      const records = await h.k.ops.call(h.k, 'records.query', {
        principal: h.session, params: { kind: 'fill', accountId }, transport: 'ws', kind: 'query',
      }) as { items: Array<Record<string, unknown>> }
      expect(records.items).toHaveLength(1)
      expect(records.items[0]).toMatchObject({ orderId: order.orderId, size: '0.5', price: '190.01' })
      const finalSocket = sockets[1]!
      await h.cleanup()
      expect(finalSocket.closed).toBe(true)
    } finally {
      await h.cleanup()
      vi.unstubAllGlobals()
    }
  })

  it('keeps trade metadata for PaperVenue when its separate market source has no instruments', async () => {
    const h = await configuredBareKernel()
    const fake = new FakeAlpaca()
    let assetCalls = 0
    const localFetch: typeof fetch = async (input, init) => {
      if (new URL(String(input)).pathname === '/v2/assets' && ++assetCalls === 2) return new Response('[]', { status: 200 })
      return fake.fetch(input, init)
    }
    const sockets: LocalSocket[] = []
    vi.stubGlobal('fetch', localFetch)
    vi.stubGlobal('WebSocket', class extends LocalSocket { constructor() { super(); sockets.push(this) } })
    try {
      assembleConnectors({ k: h.k, io: alpacaIo })
      await vi.waitFor(() => expect(h.k.connectionStatus().find((entry) => entry.venue === 'alpaca')?.state).toBe('connected'), { timeout: 2_000 })
      expect(h.k.bus.marketSource('alpaca')!.listInstruments()).toHaveLength(0)
      const paper = h.k.bus.get('kernel-sim')!
      expect(paper.getInstrument('alpaca:AAPL')).toMatchObject({ instrumentId: 'alpaca:AAPL', venueSizeUnit: 'base', contractSize: '1' })
      expect(paper.listInstruments().some((instrument) => instrument.instrumentId === 'alpaca:AAPL')).toBe(true)
      expect(sockets).toHaveLength(1)
    } finally {
      await h.cleanup()
      vi.unstubAllGlobals()
    }
  })

  it('does not reconcile on failed stream authorization and closes the failed socket safely', async () => {
    const h = await configuredBareKernel()
    const fake = new FakeAlpaca()
    const sockets: RejectAuthSocket[] = []
    vi.stubGlobal('fetch', fake.fetch)
    vi.stubGlobal('WebSocket', class extends RejectAuthSocket { constructor() { super(); sockets.push(this) } })
    const reconcile = vi.spyOn(h.k, 'startupReconcile')
    try {
      const results = assembleConnectors({ k: h.k, io: alpacaIo })
      expect(results).toEqual([{ id: 'alpaca', ok: true }])
      await vi.waitFor(() => expect(h.k.connectionStatus().find((entry) => entry.venue === 'alpaca')?.state).toBe('disconnected'), { timeout: 2_000 })
      expect(sockets).toHaveLength(1)
      expect(sockets[0]!.closed).toBe(true)
      expect(h.k.connectionStatus().find((entry) => entry.venue === 'alpaca')?.detail).toBe('Alpaca connector unavailable: VENUE_UNAVAILABLE')
      expect(reconcile).not.toHaveBeenCalled()
      expect(fake.callsFor('GET', '/v2/clock')).toHaveLength(0)
    } finally {
      await h.cleanup()
      vi.unstubAllGlobals()
    }
  })

  it('keeps the native market-closed rule on a real factory order path', async () => {
    const saturday = Date.parse('2026-10-24T14:00:00Z')
    const h = await configuredBareKernel({ now: saturday })
    const fake = new FakeAlpaca()
    const stamp = new Date(saturday - 500).toISOString()
    fake.snapshot = {
      latestQuote: { t: stamp, ap: 190.02, bp: 190.0, as: 3, bs: 4 },
      latestTrade: { t: stamp, p: 190.01, s: 100 },
    }
    const sockets: LocalSocket[] = []
    vi.stubGlobal('fetch', fake.fetch)
    vi.stubGlobal('WebSocket', class extends LocalSocket { constructor() { super(); sockets.push(this) } })
    try {
      assembleConnectors({ k: h.k, io: alpacaIo })
      await vi.waitFor(() => expect(h.k.connectionStatus().find((entry) => entry.venue === 'alpaca')?.state).toBe('connected'), { timeout: 2_000 })
      await h.pinProof()
      const accountId = h.k.accounts.find('alpaca-configured')!.accountId
      const placed = await h.k.trading.place({ intent: {
        accountId, instrumentId: 'alpaca:AAPL', side: 'buy', type: 'market', size: '1', reason: 'C1 closed-session fixture',
      } as never }, h.human('order.place'))
      expect(placed.order?.status).not.toBe('open')
      expect(placed.order?.problem?.code).toBe(-32602)
      expect(fake.callsFor('POST', '/v2/orders')).toHaveLength(0)
    } finally {
      await h.cleanup()
      vi.unstubAllGlobals()
    }
  })
})
