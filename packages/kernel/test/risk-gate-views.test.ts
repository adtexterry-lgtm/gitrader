// SPDX-License-Identifier: CPAL-1.0
import { describe, expect, it, vi } from 'vitest'
import { asDecimal } from '@gitrader/protocol'
import { loadGateConformanceCases } from '../../protocol/conformance/risk-gate/load'
import { ConnectorBus } from '../src/connector'
import { TradingStateService } from '../src/trading-state'
import { FakeClock } from '../src/util/clock'
import type { Account, TradingScope } from '../src/proto'
import { FakeConnector, BTC } from './helpers/fake-connector'
import type { MarkPrice } from '../src/connector'

const baseAccount = structuredClone(loadGateConformanceCases()[0]!.input.account) as Account
const account = (mode: 'paper' | 'live' = 'paper'): Account => ({ ...structuredClone(baseAccount), mode, venue: 'hyperliquid', owner: baseAccount.owner ?? { address: `0x${'00'.repeat(20)}` } as never })

describe('risk gate source views', () => {
  it('distinguishes quote last/mid from frozen venue mark and preserves context timestamp', async () => {
    const clock = new FakeClock(10_000)
    const sim = new FakeConnector({ id: 'kernel-sim', clock })
    const bus = new ConnectorBus(clock)
    bus.register(sim)
    expect(bus.mark(BTC)).toMatchObject({ source: 'last', price: '80000' })
    sim.quote = (() => ({ instrumentId: BTC, ts: 9_000, bid: 10, ask: 12, stale: false, ageMs: 0 })) as typeof sim.quote
    expect(bus.mark(BTC)).toMatchObject({ source: 'mid', price: '11' })

    sim.frozenMarkTs = 7_777
    expect(await bus.gateMark(BTC)).toMatchObject({ source: 'venue_mark', price: '80000', ts: 7_777 })
    sim.marks.delete(BTC)
    expect(bus.mark(BTC)).toMatchObject({ source: 'mid', price: '11' })
    expect(await bus.gateMark(BTC)).toBeUndefined()
  })

  it('preserves protocol decimals without a narrower numeric scale and rejects malformed venue marks', async () => {
    const clock = new FakeClock(10_000)
    const sim = new FakeConnector({ id: 'kernel-sim', clock })
    let providerMark: MarkPrice = { source: 'venue_mark', price: asDecimal('0.0000000000000000001'), ts: 10_000 }
    Object.assign(sim, { mark: (_id: string): MarkPrice => providerMark })
    const bus = new ConnectorBus(clock)
    bus.register(sim)

    expect(await bus.gateMark(BTC)).toEqual(providerMark)
    providerMark = { source: 'venue_mark', price: '1234567890123456789012345678901' as MarkPrice['price'], ts: 10_000 }
    expect(await bus.gateMark(BTC)).toBeUndefined()
  })

  it('preserves account source fields, both open-order views, and summary semantics', async () => {
    const clock = new FakeClock(10_000)
    const sim = new FakeConnector({ id: 'kernel-sim', clock })
    sim.accountSnapshotOverrides = { asOf: 8_888, confirmedAt: undefined, stale: false, availableDeductsOpenOrders: false, rules: { minOrderNotional: '1' } as never }
    sim.orders.push(
      { venueOrderId: 'vo-limit', clientOrderId: 'cl-limit', accountId: baseAccount.accountId, instrumentId: BTC, side: 'buy', type: 'limit', size: '2', price: '100', reduceOnly: false, isTrigger: false, status: 'open', createdAt: 1 },
      { venueOrderId: 'vo-stop', clientOrderId: 'cl-stop', accountId: baseAccount.accountId, instrumentId: BTC, side: 'sell', type: 'stop_limit', size: '1', price: '90', reduceOnly: true, isTrigger: true, status: 'open', createdAt: 1 },
      { venueOrderId: 'vo-take', clientOrderId: 'cl-take', accountId: baseAccount.accountId, instrumentId: BTC, side: 'sell', type: 'take_limit', size: '1', price: '110', reduceOnly: true, isTrigger: true, status: 'open', createdAt: 1 },
    )
    const bus = new ConnectorBus(clock)
    bus.register(sim)
    const snapshot = await bus.snapshot(account())
    expect(snapshot).toMatchObject({ ts: 10_000, asOf: 8_888, stale: false, availableDeductsOpenOrders: false })
    expect(snapshot).not.toHaveProperty('confirmedAt')
    expect(snapshot.openOrders).toHaveLength(3)
    expect(snapshot.gateOpenOrders).toEqual([{ instrumentId: BTC, side: 'buy', notional: '200', count: 1 }])
    expect(snapshot.stopLossOrderIds).toEqual(['vo-stop'])
    expect(snapshot.rules).toEqual({ minOrderNotional: '1' })
  })

  it('refetches completed zero-age snapshots even in the same clock tick but coalesces pending fetches', async () => {
    const clock = new FakeClock(10_000)
    const live = new FakeConnector({ id: 'hyperliquid', clock })
    const bus = new ConnectorBus(clock)
    bus.register(live)
    const acct = account('live')
    await bus.snapshot(acct, { maxAgeMs: 0 })
    await bus.snapshot(acct, { maxAgeMs: 0 })
    expect(live.accountStateCalls).toBe(2)

    const pendingBus = new ConnectorBus(clock)
    const pendingLive = new FakeConnector({ id: 'hyperliquid', clock })
    pendingBus.register(pendingLive)
    const first = pendingBus.snapshot(acct, { maxAgeMs: 0 })
    const second = pendingBus.snapshot(acct, { maxAgeMs: 0 })
    expect(second).toBe(first)
    await Promise.all([first, second])
    expect(pendingLive.accountStateCalls).toBe(1)
  })

  it('uses explicit order-expiry registration for the connector selected by account routing', () => {
    const clock = new FakeClock(10_000)
    const sim = new FakeConnector({ id: 'kernel-sim', clock })
    const live = new FakeConnector({ id: 'hyperliquid', clock })
    const bus = new ConnectorBus(clock)
    bus.register(sim, { supportsOrderExpiry: true })
    bus.register(live)
    expect(bus.supportsOrderExpiry(account('paper'))).toBe(true)
    expect(bus.supportsOrderExpiry(account('live'))).toBe(false)
    const explicitLiveBus = new ConnectorBus(clock)
    explicitLiveBus.register(sim)
    explicitLiveBus.register(live, { supportsOrderExpiry: true })
    expect(explicitLiveBus.supportsOrderExpiry(account('live'))).toBe(true)
  })

  it('retains connector registration options and returns an empty default for unknown venues', () => {
    const clock = new FakeClock(10_000)
    const sim = new FakeConnector({ id: 'kernel-sim', clock })
    const bus = new ConnectorBus(clock)
    bus.register(sim, { supportsOrderExpiry: true, unverified: true, pollOrders: true, deadman: false })
    expect(bus.registrationOptions('kernel-sim')).toEqual({ supportsOrderExpiry: true, unverified: true, pollOrders: true, deadman: false })
    expect(bus.registrationOptions('unknown')).toEqual({})
    expect(bus.supportsOrderExpiry(account('paper'))).toBe(true)
  })

  it('reads unverified status and prefers connector rate budget before kernel fallback', () => {
    const clock = new FakeClock(10_000)
    const sim = new FakeConnector({ id: 'kernel-sim', clock })
    const bus = new ConnectorBus(clock)
    bus.register(sim, { unverified: true })
    const kernelBudget = bus.budgetFor('kernel-sim', 100, 60_000)
    kernelBudget.charge(3)
    const fallback = bus.readStatus('kernel-sim')
    expect(fallback).toMatchObject({ unverified: true, rateBudget: kernelBudget.usage() })

    const connectorBudget = { used: 9, limit: 20, windowMs: 30_000 }
    sim.status = () => ({ venue: 'kernel-sim', environment: 'testnet', ts: 10_000, wsState: 'connected', stale: false, source: 'ws', lastMessageTs: 10_000, rateBudget: connectorBudget } as never)
    expect(bus.readStatus('kernel-sim')).toMatchObject({ unverified: true, rateBudget: connectorBudget })
  })

  it('passes the instrument filter to status and fill lookups', async () => {
    const clock = new FakeClock(10_000)
    const sim = new FakeConnector({ id: 'kernel-sim', clock })
    const bus = new ConnectorBus(clock)
    bus.register(sim)
    const status = vi.spyOn(sim, 'orderStatus').mockResolvedValue({ found: true, status: 'open', venueOrderId: 'venue-order' })
    const fills = vi.spyOn(sim, 'fills').mockResolvedValue([])

    await bus.lookup(account(), 'client-order', { instrumentId: BTC, venueOrderId: 'venue-order', sinceMs: 123 } as never)

    expect(status).toHaveBeenCalledWith(expect.anything(), { clientOrderId: 'client-order', venueOrderId: 'venue-order', instrumentId: BTC })
    expect(fills).toHaveBeenCalledWith(expect.anything(), 123, { instrumentId: BTC })
  })

  it('subscribes api-key accounts without an owner address using the zero address', () => {
    const clock = new FakeClock(10_000)
    const sim = new FakeConnector({ id: 'hyperliquid', clock })
    const bus = new ConnectorBus(clock)
    bus.register(sim)
    const subscribe = vi.spyOn(sim, 'subscribe')
    const apiKeyAccount = { ...account('live'), owner: {}, signer: { type: 'api-key', credentialRef: 'config', permissions: { trade: true, withdraw: false } } } as Account

    bus.watchAccount(apiKeyAccount)

    expect(subscribe.mock.calls.map(([spec]) => [spec.channel, 'address' in spec ? spec.address : undefined])).toEqual([
      ['userFills', `0x${'0'.repeat(40)}`],
      ['orderUpdates', `0x${'0'.repeat(40)}`],
    ])
  })

  it('adds group scopes once without mutating scopes and applies group HALTED state', () => {
    const group: TradingScope = { type: 'group', id: 'group-a' }
    const docs = { list: (collection: string) => collection === 'tstate' ? [{ scope: group, state: 'HALTED', reason: 'group pause', since: 1, by: 'test' }] : [] }
    const service = new TradingStateService(docs as never, {} as never, {} as never, new FakeClock(10_000))
    const scopes: TradingScope[] = [{ type: 'account', id: 'acct-a' }, group]
    const before = structuredClone(scopes)
    const result = service.effective(scopes, ['group-a', 'group-a'])
    expect(result.state).toBe('HALTED')
    expect(result.reasons).toEqual([{ scope: group, state: 'HALTED', reason: 'group pause' }])
    expect(scopes).toEqual(before)
  })
})
