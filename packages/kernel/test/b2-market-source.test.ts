// SPDX-License-Identifier: CPAL-1.0
import { describe, expect, it, vi } from 'vitest'
import type { Account, Instrument, OrderIntent } from '../src/proto'
import type { TradeContext } from '@gitrader/protocol/connector'
import { ConnectorBus } from '../src/connector'
import type { AccountSnapshot as VenueAccountSnapshot } from '@gitrader/protocol/connector'
import { FakeClock } from '../src/util/clock'
import { FakeConnector } from './helpers/fake-connector'
import { makeHarness } from './helpers/harness'
import { AlpacaTradeConnector } from '../../connector-alpaca-trade/src/connector'
import type { SocketLike } from '../../connector-alpaca-trade/src/stream'

function venueConnector(venue: string, clock: FakeClock): FakeConnector {
  const connector = new FakeConnector({ id: 'hyperliquid', clock })
  Object.defineProperty(connector, 'venue', { value: venue })
  for (const instrument of connector.instrumentsList) {
    instrument.venue = venue
    instrument.instrumentId = `${venue}:${instrument.symbol}`
    instrument.contractSize = '3' as never
  }
  connector.marks.set(`${venue}:BTC`, '101')
  connector.marks.set(`${venue}:ETH`, '202')
  return connector
}

function liveAccount(venue: string, signer: Account['signer'] = { type: 'api-wallet', credentialRef: 'test-wallet', permissions: { trade: true, withdraw: false } }): Account {
  return {
    accountId: 'acct_test_live' as never, alias: 'test-live', orgId: 'org_local' as never, groupIds: [], venue,
    environment: 'testnet', mode: 'live', owner: { address: 'test-address' }, accountModel: 'standard', signer,
    status: 'active',
  }
}

describe('B2-08B0 dual market and trade sources', () => {
  it('separates market reads from trade routing and keeps trade instrument metadata on collision', () => {
    const clock = new FakeClock(), bus = new ConnectorBus(clock)
    const trade = venueConnector('shared', clock), data = venueConnector('shared', clock)
    trade.instrumentsList[0]!.orderTypes = ['limit']
    data.instrumentsList[0]!.orderTypes = ['market']
    trade.quote = () => ({ instrumentId: 'shared:BTC', ts: clock.now(), bid: 10, ask: 12, last: 11, stale: false, ageMs: 0 })
    data.quote = () => ({ instrumentId: 'shared:BTC', ts: clock.now(), bid: 20, ask: 22, last: 21, stale: false, ageMs: 0 })
    bus.register(trade, { unverified: true })
    expect(() => bus.registerMarketSource(data)).not.toThrow()
    expect(() => bus.registerMarketSource(venueConnector('shared', clock))).toThrow()
    expect(bus.get('shared')).toBe(trade)
    expect(bus.list()).toEqual([trade])
    expect(bus.routeFor(liveAccount('shared'))).toBe(trade)
    expect(bus.marketSource('shared')).toBe(data)
    expect(bus.registrationOptions('shared').unverified).toBe(true)
    expect(bus.mark('shared:BTC')?.price).toBe('21')
    expect(bus.instrument('shared:BTC')?.orderTypes).toEqual(['limit'])
    expect(bus.instrument('shared:BTC')?.contractSize).toBe('1')
    expect(trade.instrumentsList[0]!.contractSize).toBe('3')
  })

  it('lists the union of trade and data instruments, preferring trade metadata for duplicate IDs', () => {
    const clock = new FakeClock(), bus = new ConnectorBus(clock)
    const trade = venueConnector('shared', clock), data = venueConnector('shared', clock)
    data.instrumentsList[1]!.instrumentId = 'shared:DATA_ONLY'
    data.instrumentsList[1]!.symbol = 'DATA_ONLY'
    bus.register(trade)
    bus.registerMarketSource(data)
    const rows = bus.instruments().filter((row) => row.venue === 'shared')
    expect(rows.map((row) => row.instrumentId).sort()).toEqual(['shared:BTC', 'shared:DATA_ONLY', 'shared:ETH'])
    expect(rows.find((row) => row.instrumentId === 'shared:BTC')?.contractSize).toBe('1')
  })

  it('uses data context for gateMark when the trading connector has no context support', async () => {
    const clock = new FakeClock(), bus = new ConnectorBus(clock)
    const trade = venueConnector('shared', clock), data = venueConnector('shared', clock)
    trade.context = async () => { throw new Error('trade context unavailable') }
    data.context = async (id) => ({ instrumentId: id, ts: clock.now(), markPrice: 333 })
    bus.register(trade)
    bus.registerMarketSource(data)
    expect(await bus.gateMark('shared:BTC')).toMatchObject({ price: '333', source: 'venue_mark' })
  })

  it('forwards quote subscriptions from the independent market source', () => {
    const clock = new FakeClock(), bus = new ConnectorBus(clock)
    const trade = venueConnector('shared', clock), data = venueConnector('shared', clock)
    let deliver: ((event: never) => void) | undefined
    data.subscribe = ((spec, callback) => { expect(spec.channel).toBe('quote'); deliver = callback as (event: never) => void; return () => undefined }) as typeof data.subscribe
    bus.register(trade)
    bus.registerMarketSource(data)
    const events: unknown[] = []
    bus.onEvent((venue, event) => events.push({ venue, event }))
    expect(bus.watchMarket('shared:BTC', 'quote')).toBeTypeOf('function')
    deliver?.({ channel: 'quote', quote: { instrumentId: 'shared:BTC', ts: clock.now(), bid: 30, ask: 32, last: 31, stale: false, ageMs: 0 } } as never)
    expect(events).toEqual([{ venue: 'shared', event: { type: 'quote', instrumentId: 'shared:BTC', ts: clock.now(), bid: 30, ask: 32, last: 31 } }])
  })

  it('keeps market-only reads available but refuses live routing and sends paper accounts to sim', () => {
    const clock = new FakeClock(), bus = new ConnectorBus(clock)
    const data = venueConnector('market-only', clock), sim = new FakeConnector({ id: 'kernel-sim', clock })
    bus.registerMarketSource(data, { unverified: true })
    bus.register(sim)
    expect(bus.mark('market-only:BTC')?.price).toBe('101')
    expect(bus.registrationOptions('market-only').unverified).toBe(true)
    expect(() => bus.routeFor(liveAccount('market-only'))).toThrow(/no connector registered/)
    expect(bus.routeFor({ ...liveAccount('market-only'), mode: 'paper' })).toBe(sim)
  })

  it('closes every distinct source once, including same-venue market source', async () => {
    const clock = new FakeClock(), bus = new ConnectorBus(clock)
    const trade = venueConnector('shared', clock), data = venueConnector('shared', clock)
    let tradeClosed = 0, dataClosed = 0
    trade.close = async () => { tradeClosed++ }
    data.close = async () => { dataClosed++ }
    bus.register(trade)
    bus.registerMarketSource(data)
    await bus.close()
    expect({ tradeClosed, dataClosed }).toEqual({ tradeClosed: 1, dataClosed: 1 })
  })

  it('never subscribes a gateway-session account to private streams, even if owner.address exists', () => {
    const clock = new FakeClock(), bus = new ConnectorBus(clock), connector = venueConnector('ibkr', clock)
    const subscriptions: unknown[] = []
    connector.subscribe = ((spec) => { subscriptions.push(spec); return () => undefined }) as typeof connector.subscribe
    bus.register(connector)
    bus.watchAccount(liveAccount('ibkr', { type: 'gateway-session', credentialRef: 'gateway-session', permissions: { trade: true, withdraw: false } }))
    expect(subscriptions).toEqual([])
  })

  it('tracks a market-only source disconnect without making it a live trade route', async () => {
    const h = await makeHarness()
    try {
      let wsState: 'connected' | 'disconnected' = 'connected'
      const data = venueConnector('market-only', h.clock)
      data.status = () => ({ venue: 'market-only', environment: 'testnet', ts: h.clock.now(), wsState, stale: wsState !== 'connected', source: 'rest', lastMessageTs: h.clock.now() })
      h.k.bus.registerMarketSource(data)
      h.k.connectInBackground('market-only', async () => undefined)
      for (let i = 0; i < 100 && h.k.connectionStatus().find((row) => row.venue === 'market-only')?.state !== 'connected'; i++) await new Promise((resolve) => setTimeout(resolve, 1))
      expect(h.k.connectionStatus().find((row) => row.venue === 'market-only')?.state).toBe('connected')
      wsState = 'disconnected'
      expect(h.k.connectionStatus().find((row) => row.venue === 'market-only')).toMatchObject({ state: 'disconnected', stale: true })
      expect(() => h.k.bus.routeFor(liveAccount('market-only'))).toThrow(/no connector registered/)
    } finally { await h.cleanup() }
  })

  it('falls back to backend connection state when source status throws and skips status unless connected', async () => {
    const h = await makeHarness()
    let finishConnecting!: () => void
    try {
      const marketOnly = venueConnector('market-status-error', h.clock)
      marketOnly.status = vi.fn(() => { throw new Error('fixture status failure') })
      h.k.bus.registerMarketSource(marketOnly)
      h.k.connectInBackground('market-status-error', async () => undefined)
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(h.k.connectionStatus().find((row) => row.venue === 'market-status-error')).toMatchObject({ state: 'connected' })
      expect(marketOnly.status).toHaveBeenCalledTimes(1)

      const data = venueConnector('hyperliquid', h.clock)
      data.status = vi.fn(() => ({ venue: 'hyperliquid', environment: 'testnet' as const, ts: h.clock.now(), wsState: 'disconnected' as const, stale: true, source: 'rest' as const, lastMessageTs: h.clock.now() }))
      h.k.bus.registerMarketSource(data)
      h.live.status = vi.fn(() => { throw new Error('fixture status failure') })
      h.k.connectInBackground('hyperliquid', async () => undefined)
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(h.k.connectionStatus().find((row) => row.venue === 'hyperliquid')).toMatchObject({ state: 'connected' })
      expect(h.live.status).toHaveBeenCalledTimes(1)
      expect(data.status).not.toHaveBeenCalled()

      const connecting = venueConnector('connecting-status', h.clock)
      connecting.status = vi.fn(() => { throw new Error('fixture status failure while connecting') })
      h.k.bus.registerMarketSource(connecting)
      h.k.connectInBackground('connecting-status', () => new Promise<void>((resolve) => { finishConnecting = resolve }))
      // R2-REL-02：连接中也读连接器状态（报就绪度 marketLive），不再等 start() 返回才细化；读失败照旧退回后台连接结果
      expect(h.k.connectionStatus().find((row) => row.venue === 'connecting-status')).toMatchObject({ state: 'connecting', readiness: { marketLive: false } })
      expect(connecting.status).toHaveBeenCalledTimes(1)

      const disconnected = venueConnector('disconnected-status', h.clock)
      disconnected.status = vi.fn(() => { throw new Error('must not read while disconnected') })
      h.k.bus.registerMarketSource(disconnected)
      h.k.connectInBackground('disconnected-status', async () => { throw new Error('fixture connect failure') }, { backoffMinMs: 60_000, backoffMaxMs: 60_000 })
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(h.k.connectionStatus().find((row) => row.venue === 'disconnected-status')?.state).toBe('disconnected')
      expect(disconnected.status).not.toHaveBeenCalled()
    } finally {
      finishConnecting?.()
      await h.cleanup()
    }
  })

  it('feeds real Alpaca stream partial fills and order updates through bus to Kernel ledger, idempotently', async () => {
    const h = await makeHarness()
    const socket = new TestSocket()
    try {
      const account = h.liveAcct
      account.venue = 'alpaca'
      account.signer = { type: 'api-key', credentialRef: 'config', permissions: { trade: true, withdraw: false } }
      const connector = new AlpacaTradeConnector({ apiKey: 'PK_TEST_ONLY', apiSecret: 'TEST_ONLY', streamSocket: () => socket })
      const instrument = { ...h.live.getInstrument('hyperliquid:BTC')!, venue: 'alpaca', instrumentId: 'alpaca:AAPL', symbol: 'AAPL', displaySymbol: 'AAPL', base: 'AAPL', quote: 'USD', settle: 'USD', tif: ['day', 'gtc'] } as Instrument
      connector.getInstrument = (id) => id === instrument.instrumentId ? instrument : undefined
      connector.context = async () => ({ instrumentId: instrument.instrumentId, ts: h.clock.now(), markPrice: 10 })
      connector.accountState = async (ref) => ({ accountModel: 'standard', balances: [], ts: h.clock.now(), margin: { accountId: ref.accountId, model: 'standard', valuationCcy: 'USD', equity: '10000' as never, initialMargin: '0' as never, maintenanceMargin: '0' as never, available: '10000' as never, marginRatio: '0' as never, leverage: 1, ts: h.clock.now() }, asOf: h.clock.now(), confirmedAt: h.clock.now(), stale: false, availableDeductsOpenOrders: false, positions: [], openOrders: [], stopLossOrderIds: [] }) as VenueAccountSnapshot
      connector.openOrders = async () => []
      connector.trading.submit = vi.fn(async (_ctx: TradeContext, intents: OrderIntent[]) => ({ acks: intents.map((intent, intentIndex) => ({ intentIndex, clientOrderId: intent.clientOrderId!, venueOrderId: 'alpaca-order-1', status: 'open' as const, filledSize: '0' as never, avgFillPrice: null, builder: { attached: false } })), receiptHash: 'ab'.repeat(32), requestWeight: 1 }))
      h.k.registerConnector(connector)
      await h.pinProof()
      const intent = { accountId: account.accountId, instrumentId: 'alpaca:AAPL', side: 'buy', type: 'limit', size: '2', price: '10', tif: 'day', reason: 'test' } as never
      const placed = await h.k.trading.place({ intent }, h.human())
      expect(placed.order?.status, JSON.stringify(placed.order?.problem)).toBe('open')
      expect(h.k.orders.fills({ accountId: account.accountId })).toHaveLength(0)
      const order = placed.order!
      const ready = connector.stream.connect()
      socket.open()
      socket.emit({ stream: 'authorization', data: { status: 'authorized' } })
      socket.emit({ stream: 'listening', data: { streams: ['trade_updates'] } })
      await ready
      const update = (event: string, qty: string, filledQty: string, status: string) => socket.emit({ stream: 'trade_updates', data: { event, qty, price: '10', timestamp: new Date(h.clock.now()).toISOString(), order: { id: 'alpaca-order-1', client_order_id: order.clientOrderId, symbol: 'AAPL', side: 'buy', status, qty: '2', filled_qty: filledQty } } })
      update('partial_fill', '1', '1', 'partially_filled')
      update('partial_fill', '1', '1', 'partially_filled')
      expect(h.k.orders.fills({ orderId: order.orderId })).toHaveLength(1)
      expect(h.k.orders.get(order.orderId)?.status).toBe('partially_filled')
      update('fill', '1', '2', 'filled')
      expect(h.k.orders.fills({ orderId: order.orderId })).toHaveLength(2)
      expect(h.k.orders.get(order.orderId)?.status).toBe('filled')
      expect(h.k.ledger.query({ types: ['fill'], limit: 10 }).filter((entry) => entry.subject.orderId === order.orderId)).toHaveLength(2)
    } finally { await h.cleanup() }
  })
})

class TestSocket implements SocketLike {
  onopen: ((ev?: unknown) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: ((ev?: unknown) => void) | null = null
  onerror: ((ev?: unknown) => void) | null = null
  sent: string[] = []
  send(data: string): void { this.sent.push(data) }
  close(): void { this.onclose?.() }
  open(): void { this.onopen?.() }
  emit(frame: unknown): void { this.onmessage?.({ data: JSON.stringify(frame) }) }
}
