// SPDX-License-Identifier: CPAL-1.0
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWeightBudget } from '../src/budget'
import type { RateBudget } from '../src/budget'
import { HyperliquidConnector } from '../src/connector'
import type { HyperliquidConnectorOptions } from '../src/connector'
import type { TradeContext, VenueEvent } from '@gitrader/protocol/connector'
import { FakeHl, FakeWS, FakeWebSocket, FX_NOW } from './helpers/fake-hl'
import { makeTestSigner } from './helpers/test-signer'

const ADDRESS = '0x2222222222222222222222222222222222222222' as const

afterEach(() => { FakeWebSocket.reset(); vi.useRealTimers() })

async function setup(extra: Partial<HyperliquidConnectorOptions> = {}) {
  const hl = new FakeHl()
  const c = new HyperliquidConnector({
    environment: 'mainnet', fetchImpl: hl.fetch, useWs: true, WebSocketImpl: FakeWS,
    discoveryIntervalMs: 0, clock: () => FX_NOW, ...extra,
    budget: extra.budget ?? createWeightBudget({ clock: () => FX_NOW, targetRatio: 1, sleep: async () => { throw new Error('unexpected budget wait') } }),
  })
  await c.market.refreshInstruments()
  hl.info.set('userAbstraction', () => 'default')
  hl.info.set('clearinghouseState', () => ({ marginSummary: { accountValue: '1', totalNtlPos: '0', totalMarginUsed: '0' }, crossMaintenanceMarginUsed: '0', withdrawable: '1', assetPositions: [] }))
  hl.info.set('spotClearinghouseState', () => ({ balances: [] }))
  hl.info.set('frontendOpenOrders', () => [])
  hl.info.set('userRateLimit', () => ({ cumVlm: '0', nRequestsUsed: 0, nRequestsCap: 0, nRequestsSurplus: 0 }))
  hl.calls.length = 0
  await c.market.start()
  FakeWebSocket.last.open()
  return { c, hl, ws: FakeWebSocket.last }
}

describe('H3 user order updates', () => {
  it('maps optional order fields, keeps unknown status and forwards duplicate frames unchanged', async () => {
    const { c, hl, ws } = await setup()
    const events: VenueEvent[] = []
    c.subscribe({ channel: 'orderUpdates', address: ADDRESS }, (event) => events.push(event))
    const frame = [{ order: {
      coin: 'BTC', side: 'B', limitPx: '10.00', sz: '2.500', origSz: '3.000', triggerPx: '9.50',
      reduceOnly: false, isTrigger: true, oid: 3, timestamp: FX_NOW, cloid: '0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC',
    }, status: 'venue-new-state', statusTimestamp: FX_NOW + 1 }]
    ws.push({ channel: 'orderUpdates', data: frame })
    ws.push({ channel: 'orderUpdates', data: frame })
    expect(events).toHaveLength(2)
    const event = events[0] as Extract<VenueEvent, { channel: 'orderUpdates' }>
    expect(event.updates[0]).toEqual({
      venueOrderId: '3', clientOrderId: 'cccccccccccccccccccccccccccccccc', instrumentId: 'hyperliquid:BTC',
      status: 'venue-new-state', ts: FX_NOW + 1, side: 'buy', size: '2.5', origSize: '3', price: '10',
      triggerPrice: '9.5', reduceOnly: false, isTrigger: true, createdAt: FX_NOW,
    })
    expect(hl.exchangeCalls()).toHaveLength(0)
    await c.close()
  })

  it('omits invalid optional fields and unsafe createdAt without changing the required event fields', async () => {
    const { c, ws } = await setup()
    const events: VenueEvent[] = []
    c.subscribe({ channel: 'orderUpdates', address: ADDRESS }, (event) => events.push(event))
    ws.push({ channel: 'orderUpdates', data: [{ order: {
      coin: 'BTC', side: 'X', limitPx: 'NaN', sz: '-1', origSz: '1e9999', triggerPx: '',
      reduceOnly: 'false', isTrigger: 1, oid: 4, timestamp: Number.MAX_SAFE_INTEGER + 1,
    }, status: 'partially-filled', statusTimestamp: FX_NOW }] })
    const event = events[0] as Extract<VenueEvent, { channel: 'orderUpdates' }>
    expect(event.updates[0]).toEqual({
      venueOrderId: '4', clientOrderId: null, instrumentId: 'hyperliquid:BTC', status: 'partially-filled', ts: FX_NOW,
    })
    await c.close()
  })
})

describe('H3 address budget estimate', () => {
  it('counts unique snapshot and live fills by instrument and fill id with exact decimal volume', async () => {
    const { c, ws } = await setup()
    const otherAddress = '0x5555555555555555555555555555555555555555'
    c.subscribe({ channel: 'userFills', address: ADDRESS }, () => {})
    c.subscribe({ channel: 'userFills', address: otherAddress as typeof ADDRESS }, () => {})
    const fill = (coin: string, tid: number, px: string, sz: string) => ({
      coin, px, sz, side: 'B', time: FX_NOW, closedPnl: '0', oid: 9, tid, crossed: true, fee: '0', feeToken: 'USDC',
    })
    ws.push({ channel: 'userFills', data: { isSnapshot: true, user: ADDRESS, fills: [fill('BTC', 7, '0.1', '0.3'), fill('ETH', 7, '0.2', '0.4')] } })
    ws.push({ channel: 'userFills', data: { isSnapshot: false, user: ADDRESS, fills: [fill('BTC', 7, '0.1', '0.3')] } })
    ws.push({ channel: 'userFills', data: { isSnapshot: true, user: otherAddress, fills: [fill('BTC', 7, '0.2', '0.1')] } })
    const usage = c.http.addressBudget.usage(ADDRESS)
    expect(usage).toEqual({ actionCount: 0, fillVolume: '0.11', estimatedLimit: '10000.11', estimatedCancelLimit: '20000.22', incomplete: true })
    expect(c.http.addressBudget.usage(otherAddress).fillVolume).toBe('0.02')
    await c.close()
  })

  it('ignores zero or negative fill values without poisoning a later valid fill id', async () => {
    const { c, hl, ws } = await setup()
    c.subscribe({ channel: 'userFills', address: ADDRESS }, () => {})
    const push = (tid: number, px: string, sz: string) => ws.push({
      channel: 'userFills', data: { isSnapshot: false, user: ADDRESS, fills: [{
        coin: 'BTC', px, sz, side: 'B', time: FX_NOW, closedPnl: '0', oid: 9, tid, crossed: true, fee: '0', feeToken: 'USDC',
      }] },
    })
    push(11, '-100', '-1')
    push(12, '-100', '1')
    push(13, '100', '-1')
    push(14, '0', '1')
    push(15, '100', '0')
    expect(c.http.addressBudget.usage(ADDRESS)).toMatchObject({ actionCount: 0, fillVolume: '0', estimatedLimit: '10000', incomplete: true })
    push(11, '100', '1')
    push(11, '100', '1')
    expect(c.http.addressBudget.usage(ADDRESS)).toMatchObject({ actionCount: 0, fillVolume: '100', estimatedLimit: '10100', incomplete: true })
    expect(hl.exchangeCalls()).toHaveLength(0)
    await c.close()
  })

  it('counts each batched action after the budget and not info or an already-cancelled request', async () => {
    const { c, hl } = await setup()
    const transport = c.http.exchangeTransport(ADDRESS)
    await transport.request('exchange', { action: { type: 'order', orders: [{}, {}, {}] } })
    expect(c.http.addressBudget.usage(ADDRESS).actionCount).toBe(3)
    await transport.request('info', { type: 'userRateLimit' })
    expect(c.http.addressBudget.usage(ADDRESS).actionCount).toBe(3)
    const ctl = new AbortController()
    ctl.abort(new Error('cancelled before budget'))
    await expect(transport.request('exchange', { action: { type: 'order', orders: [{}] } }, ctl.signal)).rejects.toThrow()
    expect(c.http.addressBudget.usage(ADDRESS).actionCount).toBe(3)
    expect(hl.exchangeCalls()).toHaveLength(1)
    await c.close()
  })

  it('does not count an exchange request cancelled while waiting for the shared budget', async () => {
    let started!: () => void
    const startedPromise = new Promise<void>((resolve) => { started = resolve })
    const base = createWeightBudget({ clock: () => FX_NOW, targetRatio: 1 })
    const budget: RateBudget = {
      ...base,
      async acquire(weight, options) {
        if (options?.kind === 'trade') {
          await new Promise<void>((_, reject) => {
            started()
            const signal = options.signal
            if (signal?.aborted) { reject(signal.reason); return }
            signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
          })
        }
        return base.acquire(weight, options)
      },
    }
    const { c, hl } = await setup({ budget })
    const ctl = new AbortController()
    const transport = c.http.exchangeTransport(ADDRESS)
    const request = transport.request('exchange', { action: { type: 'order', orders: [{}] } }, ctl.signal)
    await startedPromise
    ctl.abort(new Error('cancelled while waiting'))
    await expect(request).rejects.toThrow()
    expect(c.http.addressBudget.usage(ADDRESS).actionCount).toBe(0)
    expect(hl.exchangeCalls()).toHaveLength(0)
    await c.close()
  })

  it('uses the larger bounded allowance for cancellation actions', async () => {
    const { c } = await setup()
    const transport = c.http.exchangeTransport(ADDRESS)
    await transport.request('exchange', { action: { type: 'cancel', cancels: Array.from({ length: 20_001 }, () => ({})) } })
    const usage = c.http.addressBudget.usage(ADDRESS)
    expect(usage).toMatchObject({ actionCount: 20_001, estimatedLimit: '10000', estimatedCancelLimit: '20000', incomplete: true })
    await c.close()
  })

  it('passes the account address to the real trading transport and warns once per threshold and action class', async () => {
    const warnings: string[] = []
    const { c } = await setup({ onWarn: (message) => warnings.push(message) })
    const vault = '0x3333333333333333333333333333333333333333'
    const ctx = {
      account: { accountId: 'acct_01TEST', address: ADDRESS, vaultAddress: vault },
      signer: makeTestSigner(),
    } as TradeContext
    await c.submit(ctx, [{ accountId: 'acct_01TEST', instrumentId: 'hyperliquid:BTC', side: 'buy', type: 'limit', size: '0.001', price: '80000' } as never])
    expect(c.http.addressBudget.usage(vault).actionCount).toBe(1)
    expect(c.http.addressBudget.usage(ADDRESS).actionCount).toBe(0)
    c.http.addressBudget.recordActions(vault, 8_999, 'other')
    c.http.addressBudget.recordActions(vault, 11_000, 'other')
    const cancelVault = '0x4444444444444444444444444444444444444444'
    c.http.addressBudget.recordActions(cancelVault, 18_000, 'cancel')
    c.http.addressBudget.recordActions(cancelVault, 2_000, 'cancel')
    expect(warnings).toHaveLength(4)
    expect(warnings.every((message) => !message.includes(vault) && !message.includes(ADDRESS))).toBe(true)
    await c.close()
  })

  it('adds four times the batch only for explicit expiry responses and keeps one estimate on unknown network outcome', async () => {
    const { c, hl } = await setup()
    const transport = c.http.exchangeTransport(ADDRESS)
    hl.exchange = () => ({ status: 'err', response: 'request expired after expiresAfter' })
    await transport.request('exchange', { action: { type: 'order', orders: [{}, {}] } })
    expect(c.http.addressBudget.usage(ADDRESS).actionCount).toBe(10)
    hl.exchangeNetworkFail = true
    await expect(transport.request('exchange', { action: { type: 'order', orders: [{}, {}] } })).rejects.toThrow()
    expect(c.http.addressBudget.usage(ADDRESS).actionCount).toBe(12)
    hl.exchange = () => ({ status: 'ok', response: { type: 'order', data: { statuses: [{ error: 'expired' }, { error: 'expired' }] } } })
    await transport.request('exchange', { action: { type: 'order', orders: [{}, {}] } })
    expect(c.http.addressBudget.usage(ADDRESS).actionCount).toBe(14)
    await c.close()
  })
})
