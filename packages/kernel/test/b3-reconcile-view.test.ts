// SPDX-License-Identifier: CPAL-1.0
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Fill, MarginMode, Order } from '../src/proto'
import { asDecimal, validateFill } from '../src/proto'
import { mkOrigin } from '../src/util/origin'
import { buildReconcileInput, buildReconcileView, type ReconcileViewSource } from '../src/reconcile-view'
import { makeHarness } from './helpers/harness'

const ACCOUNT = 'acct_reconcile_test' as Order['accountId']
const INSTRUMENT = 'hyperliquid:BTC' as Order['instrumentId']

function localOrder(id: string, over: Partial<Order> = {}): Order {
  return {
    orderId: id as Order['orderId'], clientOrderId: '0123456789abcdef0123456789abcdef', venueOrderId: `venue-${id}`,
    accountId: ACCOUNT, instrumentId: INSTRUMENT, side: 'buy', type: 'limit', tif: 'gtc', size: asDecimal('1'),
    filledSize: asDecimal('0'), price: asDecimal('100'), triggerPrice: null, avgFillPrice: null, reduceOnly: false,
    postOnly: false, status: 'filled', fee: asDecimal('0'), origin: mkOrigin('user:usr_local', 'reconcile-test', 'cli'),
    createdAt: 100, updatedAt: 100, submittedAt: 100, closedAt: 200, ...over,
  }
}

function localFill(id: string, over: Partial<Fill> = {}): Fill {
  return {
    fillId: `fill_${id}` as Fill['fillId'], orderId: 'ord_trade' as Fill['orderId'],
    clientOrderId: '0123456789abcdef0123456789abcdef', venueFillId: `venue-fill-${id}`, accountId: ACCOUNT,
    instrumentId: INSTRUMENT, side: 'buy', price: asDecimal('100'), size: asDecimal('1'), fee: asDecimal('0'),
    feeCcy: 'USD', liquidity: 'maker', realizedPnl: asDecimal('0'), ts: 150, ...over,
  }
}

async function sourceFixture(): Promise<{ source: ReconcileViewSource; cleanup: () => Promise<void> }> {
  const h = await makeHarness()
  const snapshot = await h.live.startupSnapshot(h.k.bus.accountRef(h.liveAcct), 0)
  return {
    cleanup: h.cleanup,
    source: {
      accountId: ACCOUNT, orders: [], fills: [], snapshot: { ...snapshot, account: { ...snapshot.account, confirmedAt: 1_000 } },
      snapshotObservedAt: 1_001, historyOrderIds: [], observations: [], now: 1_002,
    },
  }
}

describe('read-only reconciliation connector observations', () => {
  let cleanup: (() => Promise<void>) | undefined
  afterEach(async () => { await cleanup?.(); cleanup = undefined })

  it('observeOnly returns validated status data without fills or order callbacks', async () => {
    const h = await makeHarness()
    cleanup = h.cleanup
    vi.spyOn(h.live, 'orderStatus').mockResolvedValue({
      found: true, status: 'partially_filled', venueOrderId: 'venue-known', filledSize: '0.4', avgFillPrice: '123.5',
    } as never)
    const fills = vi.spyOn(h.live, 'fills')
    const onUnknown = vi.fn()
    const onQueried = vi.fn()
    const events: unknown[] = []
    h.k.bus.setOrderStatusCallbacks(onUnknown, onQueried)
    h.k.bus.onEvent((_venue, event) => events.push(event))

    const result = await h.k.bus.lookup(h.liveAcct, 'client-known', {
      sinceMs: 10, observeOnly: true,
    })

    expect(fills).not.toHaveBeenCalled()
    expect(onUnknown).not.toHaveBeenCalled()
    expect(onQueried).not.toHaveBeenCalled()
    expect(events).toEqual([])
    expect(result).toEqual({ status: 'partially_filled', venueOrderId: 'venue-known', filledSize: '0.4', avgFillPrice: '123.5' })
  })

  it('does not infer an average price from raw data and rejects an invalid direct price', async () => {
    const h = await makeHarness()
    cleanup = h.cleanup
    vi.spyOn(h.live, 'orderStatus').mockResolvedValue({
      found: true, status: 'filled', venueOrderId: 'venue-raw', avgFillPrice: 'bad', raw: { avgFillPrice: '99' },
    } as never)

    const result = await h.k.bus.lookup(h.liveAcct, 'client-raw', { observeOnly: true, sinceMs: 10 })

    expect(result).toEqual({ status: 'filled', venueOrderId: 'venue-raw' })
  })

  it('observeSnapshot invokes startupSnapshot once and returns its actual pending completion', async () => {
    const h = await makeHarness()
    cleanup = h.cleanup
    const nativeSnapshot = await h.live.startupSnapshot(h.k.bus.accountRef(h.liveAcct), 1)
    let complete!: (snapshot: typeof nativeSnapshot) => void
    const startupSnapshot = vi.spyOn(h.live, 'startupSnapshot').mockImplementation(
      () => new Promise((resolve) => { complete = resolve }),
    )
    const onQueried = vi.fn()
    const events: unknown[] = []
    h.k.bus.setOrderStatusCallbacks(vi.fn(), onQueried)
    h.k.bus.onEvent((_venue, event) => events.push(event))

    const observed = h.k.bus.observeSnapshot(h.liveAcct, 42)
    expect(startupSnapshot).toHaveBeenCalledTimes(1)
    expect(startupSnapshot).toHaveBeenCalledWith(h.k.bus.accountRef(h.liveAcct), 42)
    let settled = false
    void observed.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(events).toEqual([])
    expect(onQueried).not.toHaveBeenCalled()

    complete(nativeSnapshot)
    await expect(observed).resolves.toBe(nativeSnapshot)
    expect(startupSnapshot).toHaveBeenCalledTimes(1)
    expect(events).toEqual([])
    expect(onQueried).not.toHaveBeenCalled()
  })

  it('keeps the default lookup fill and status-callback path intact', async () => {
    const h = await makeHarness()
    cleanup = h.cleanup
    vi.spyOn(h.live, 'orderStatus').mockResolvedValue({
      found: true, status: 'open', venueOrderId: 'venue-default', filledSize: '0.2', avgFillPrice: '120',
    } as never)
    const venueFill = {
      venueOrderId: 'venue-default', clientOrderId: 'client-default', venueFillId: 'fill-default',
      instrumentId: 'hyperliquid:BTC', side: 'buy', price: '120', size: '0.2', fee: '0', feeCcy: 'USDC',
      liquidity: 'maker', realizedPnl: '0', ts: 10,
    }
    const fills = vi.spyOn(h.live, 'fills').mockResolvedValue([venueFill] as never)
    const onQueried = vi.fn()
    const events: unknown[] = []
    h.k.bus.setOrderStatusCallbacks(vi.fn(), onQueried)
    h.k.bus.onEvent((_venue, event) => events.push(event))

    const result = await h.k.bus.lookup(h.liveAcct, 'client-default', { sinceMs: 5 })

    expect(fills).toHaveBeenCalledTimes(1)
    expect(onQueried).toHaveBeenCalledTimes(1)
    expect(events).toHaveLength(1)
    expect(result).toEqual({ status: 'open', venueOrderId: 'venue-default', filledSize: '0.2', avgFillPrice: '120' })
  })
})

describe('pure reconciliation adapter', () => {
  it('keeps the ledger position independent from venue holdings and does not mutate source data', async () => {
    const { source, cleanup } = await sourceFixture()
    try {
      const order = localOrder('ord_trade')
      const fill = localFill('trade', { orderId: order.orderId, clientOrderId: order.clientOrderId })
      const venuePosition = {
        accountId: ACCOUNT, instrumentId: INSTRUMENT, side: 'short' as const, size: asDecimal('2'),
        entryPrice: asDecimal('90'), markPrice: asDecimal('90'), notional: asDecimal('180'), unrealizedPnl: asDecimal('0'),
        realizedPnl: asDecimal('0'), leverage: 1, marginMode: 'cross' as MarginMode, liquidationPrice: null,
        fundingSinceOpen: asDecimal('0'), openedAt: 100, updatedAt: 200,
      }
      source.orders = [order]
      source.fills = [fill]
      source.snapshot.account.positions = [venuePosition]
      const before = JSON.stringify(source)

      const input = buildReconcileInput(source)
      const built = buildReconcileView(source)

      expect(input.local.positions).toMatchObject([{ side: 'long', size: '1', entryPrice: '100' }])
      expect(input.venue.positions).toMatchObject([{ side: 'short', size: '2', entryPrice: '90' }])
      expect(built.report.findings.map((finding) => finding.code)).toContain('position_side_mismatch')
      expect(JSON.stringify(source)).toBe(before)
    } finally { await cleanup() }
  })

  it('keeps alias timestamps explicitly unknown and resolves old venue identity to the local order', async () => {
    const { source, cleanup } = await sourceFixture()
    try {
      const order = localOrder('ord_alias', { status: 'open', filledSize: asDecimal('0'), venueOrderId: 'venue-current' })
      source.orders = [order]
      source.orderAliases = new Map([[order.orderId, ['venue-old-a', 'venue-old-b']]])
      source.historyOrderIds = [order.orderId]
      source.observations = [{
        orderId: order.orderId, observedAt: 1_001,
        result: { status: 'filled', venueOrderId: 'venue-old-b', filledSize: asDecimal('1'), avgFillPrice: asDecimal('100') },
      }]
      source.snapshot.fills = [{
        venueOrderId: 'venue-old-b', clientOrderId: order.clientOrderId, venueFillId: 'venue-fill-old', instrumentId: INSTRUMENT,
        side: 'buy', price: asDecimal('100'), size: asDecimal('1'), fee: asDecimal('0'), feeCcy: 'USD',
        liquidity: 'maker', realizedPnl: asDecimal('0'), ts: 300,
      }]

      const built = buildReconcileView(source)
      const chain = built.input.links?.filter((link) => link.orderId === order.orderId)
      expect(chain?.map((link) => [link.kind, link.previousVenueOrderId, link.venueOrderId, link.ts])).toEqual([
        ['submit', undefined, 'venue-old-a', 0],
        ['replace', 'venue-old-a', 'venue-old-b', 0],
        ['replace', 'venue-old-b', 'venue-current', 0],
      ])
      expect(built.report.links.find((link) => link.orderId === order.orderId)?.venueOrderIds).toEqual([
        'venue-old-a', 'venue-old-b', 'venue-current',
      ])
      expect(built.input.venue.fills[0]?.venueOrderId).toBe('venue-old-b')
      expect(built.view.findings.flatMap((finding) => finding.evidence).some((evidence) => evidence.field.endsWith('.ts') && evidence.value === 'unknown; persisted identity only')).toBe(true)
      expect(built.view.suggestions.every((suggestion) => suggestion.orderId === order.orderId)).toBe(true)
    } finally { await cleanup() }
  })

  it('marks missing history unavailable and keeps report identity independent of observation time', async () => {
    const { source, cleanup } = await sourceFixture()
    try {
      const order = localOrder('ord_history', { status: 'open' })
      source.orders = [order]
      source.historyOrderIds = [order.orderId]
      source.observations = [{ orderId: order.orderId, observedAt: 1_001, result: null }]

      const first = buildReconcileView(source)
      source.snapshotObservedAt += 5
      source.observations = [{ orderId: order.orderId, observedAt: 1_006, result: null }]
      source.now += 5
      const second = buildReconcileView(source)

      expect(first.input.venue.unavailable).toContain('historyOrders')
      expect(first.view.coverage).toMatchObject({ historyChecked: 1, historyTotal: 1, unavailable: ['historyOrders'] })
      expect(first.view.verdict).not.toBe('clean')
      expect(first.view.reportId).toBe(second.view.reportId)
      expect(first.report.generatedAt).not.toBe(second.report.generatedAt)

      source.orders = [localOrder('ord_history', { status: 'open', size: asDecimal('2') })]
      expect(buildReconcileView(source).view.reportId).not.toBe(first.view.reportId)
      source.now = 100_000
      expect(buildReconcileView(source).view.reportId).not.toBe(first.view.reportId)
    } finally { await cleanup() }
  })

  it('rebuilds weighted entry through adds, reductions, and a reversal from ledger fills', async () => {
    const { source, cleanup } = await sourceFixture()
    try {
      const order = localOrder('ord_position', { status: 'open' })
      source.orders = [order]
      source.fills = [
        localFill('add-a', { orderId: order.orderId, clientOrderId: order.clientOrderId, size: asDecimal('2'), ts: 10 }),
        localFill('add-b', { fillId: 'fill_add_b' as Fill['fillId'], orderId: order.orderId, clientOrderId: order.clientOrderId, size: asDecimal('1'), price: asDecimal('200'), ts: 20 }),
        localFill('reduce', { fillId: 'fill_reduce' as Fill['fillId'], orderId: order.orderId, clientOrderId: order.clientOrderId, side: 'sell', size: asDecimal('1'), price: asDecimal('120'), ts: 30 }),
        localFill('reverse', { fillId: 'fill_reverse' as Fill['fillId'], orderId: order.orderId, clientOrderId: order.clientOrderId, side: 'sell', size: asDecimal('3'), price: asDecimal('80'), ts: 40 }),
      ]

      const position = buildReconcileInput(source).local.positions[0]

      expect(position).toMatchObject({ side: 'short', size: '1', entryPrice: '80', marginMode: 'cross' })
    } finally { await cleanup() }
  })

  it('derives local filled size only from recorded fills and never invents a history price', async () => {
    const { source, cleanup } = await sourceFixture()
    try {
      const order = localOrder('ord_partial', { status: 'open', filledSize: asDecimal('1') })
      source.orders = [order]
      source.historyOrderIds = [order.orderId]
      source.observations = [{
        orderId: order.orderId, observedAt: 1_001,
        result: { status: 'partially_filled', venueOrderId: 'venue-ord_partial', filledSize: asDecimal('1') },
      }]

      const built = buildReconcileView(source)

      expect(built.input.local.orders[0]?.filledSize).toBe('0')
      expect(built.input.venue.historyOrders?.[0]).not.toHaveProperty('avgFillPrice')
      for (const field of ['size', 'origSize', 'price', 'triggerPrice', 'reduceOnly', 'createdAt', 'updatedAt']) {
        expect(built.input.venue.historyOrders?.[0]).not.toHaveProperty(field)
      }
      expect(built.report.inferredFills).toEqual([])
      expect(built.view.suggestions).toEqual([])
    } finally { await cleanup() }
  })

  it('uses only the explicit local last-fill price fallback when history has no venue average', async () => {
    const { source, cleanup } = await sourceFixture()
    try {
      const order = localOrder('ord_local_price', { status: 'open', filledSize: asDecimal('0'), venueOrderId: 'venue-local-price' })
      source.orders = [order]
      source.fills = [localFill('local-price', { orderId: order.orderId, clientOrderId: order.clientOrderId, price: asDecimal('97'), size: asDecimal('1') })]
      source.historyOrderIds = [order.orderId]
      source.observations = [{
        orderId: order.orderId, observedAt: 1_001,
        result: { status: 'filled', venueOrderId: 'venue-local-price', filledSize: asDecimal('2') },
      }]

      const built = buildReconcileView(source)

      expect(built.input.venue.historyOrders?.[0]).not.toHaveProperty('avgFillPrice')
      expect(built.report.inferredFills).toMatchObject([{ price: '97', priceSource: 'local_last_fill_price' }])
      expect(built.view.suggestions).toMatchObject([{ orderId: order.orderId, price: '97', priceSource: 'local_last_fill_price' }])
    } finally { await cleanup() }
  })

  it('copies only unique inferred fills with the proven local order identity', async () => {
    const { source, cleanup } = await sourceFixture()
    try {
      const order = localOrder('ord_inferred', { status: 'open', venueOrderId: 'venue-inferred' })
      source.orders = [order]
      source.orderAliases = new Map([[order.orderId, ['venue-old-inferred']]])
      source.historyOrderIds = [order.orderId]
      source.observations = [{
        orderId: order.orderId, observedAt: 1_001,
        result: { status: 'filled', venueOrderId: 'venue-old-inferred', filledSize: asDecimal('1'), avgFillPrice: asDecimal('100') },
      }]

      const built = buildReconcileView(source)

      expect(built.report.inferredFills).toHaveLength(1)
      expect(built.view.suggestions).toMatchObject([{ orderId: order.orderId, venueOrderId: 'venue-old-inferred', inferred: true }])
    } finally { await cleanup() }
  })

  it('derives open-order filled size only from a valid nonnegative residual', async () => {
    const { source, cleanup } = await sourceFixture()
    try {
      source.snapshot.openOrders = [
        { venueOrderId: 'venue-open-valid', clientOrderId: '0123456789abcdef0123456789abcdef', instrumentId: INSTRUMENT,
          side: 'buy', type: 'limit', price: asDecimal('100'), triggerPrice: null, size: asDecimal('0.6'), origSize: asDecimal('1'),
          reduceOnly: false, isTrigger: false, createdAt: 500 },
        { venueOrderId: 'venue-open-invalid', clientOrderId: '0123456789abcdef0123456789abcdef', instrumentId: INSTRUMENT,
          side: 'buy', type: 'limit', price: asDecimal('100'), triggerPrice: null, size: asDecimal('2'), origSize: asDecimal('1'),
          reduceOnly: false, isTrigger: false, createdAt: 501 },
        { venueOrderId: 'venue-open-negative', clientOrderId: '0123456789abcdef0123456789abcdef', instrumentId: INSTRUMENT,
          side: 'buy', type: 'limit', price: asDecimal('100'), triggerPrice: null, size: asDecimal('-2'), origSize: asDecimal('-1'),
          reduceOnly: false, isTrigger: false, createdAt: 502 },
      ]

      const input = buildReconcileInput(source)

      expect(input.venue.openOrders[0]?.filledSize).toBe('0.4')
      expect(input.venue.openOrders[1]).not.toHaveProperty('filledSize')
      expect(input.venue.openOrders[2]).not.toHaveProperty('filledSize')
      expect(input.venue.unavailable).toContain('openOrders')
    } finally { await cleanup() }
  })

  it('marks history unavailable when a valid status has no filled size', async () => {
    const { source, cleanup } = await sourceFixture()
    try {
      const order = localOrder('ord_unknown_quantity', { status: 'open' })
      source.orders = [order]
      source.historyOrderIds = [order.orderId]
      source.observations = [{ orderId: order.orderId, observedAt: 1_001,
        result: { status: 'filled', venueOrderId: 'venue-unknown-quantity' } }]

      const built = buildReconcileView(source)

      expect(built.input.venue.historyOrders).toEqual([])
      expect(built.input.venue.unavailable).toContain('historyOrders')
      const coverage = built.view.coverage
      expect(coverage).toBeDefined()
      if (!coverage) throw new Error('reconcile coverage must be present')
      expect(coverage.unavailable).toContain('historyOrders')
      expect(built.view.state).toBe('ready')
    } finally { await cleanup() }
  })

  it('withholds suggestions when the actual report marks the snapshot stale', async () => {
    const { source, cleanup } = await sourceFixture()
    try {
      source.now = 100_000

      const built = buildReconcileView(source)

      expect(built.report.findings.map((finding) => finding.code)).toContain('snapshot_stale')
      expect(built.view.state).toBe('unavailable')
      expect(built.view.suggestions).toEqual([])
      expect(built.view.problem?.name).toBe('VENUE_OUTCOME_UNKNOWN')
    } finally { await cleanup() }
  })

  it('rejects duplicate and foreign history observations with the existing invalid-params error', async () => {
    const { source, cleanup } = await sourceFixture()
    try {
      const order = localOrder('ord_observed', { status: 'open' })
      source.orders = [order]
      source.historyOrderIds = [order.orderId]
      source.observations = [
        { orderId: order.orderId, observedAt: 1_000, result: null },
        { orderId: order.orderId, observedAt: 1_001, result: null },
      ]

      expect(() => buildReconcileInput(source)).toThrow(expect.objectContaining({ problem: expect.objectContaining({ name: 'INVALID_PARAMS' }) }))
      source.observations = [{ orderId: 'ord_foreign' as Order['orderId'], observedAt: 1_000, result: null }]
      expect(() => buildReconcileInput(source)).toThrow(expect.objectContaining({ problem: expect.objectContaining({ name: 'INVALID_PARAMS' }) }))
    } finally { await cleanup() }
  })

  it('validates inferred fill provenance while preserving legacy fill payloads', () => {
    const base = {
      fillId: 'fill_schema', orderId: 'ord_schema', clientOrderId: '0123456789abcdef0123456789abcdef',
      venueFillId: 'venue-fill-schema', accountId: 'acct_schema', instrumentId: INSTRUMENT, side: 'buy' as const,
      price: asDecimal('1'), size: asDecimal('1'), fee: asDecimal('0'), feeCcy: 'USD', liquidity: 'maker' as const,
      realizedPnl: asDecimal('0'), ts: 1,
    }
    expect(validateFill(base).ok).toBe(true)
    expect(validateFill({ ...base, inferred: {
      suggestionId: 'suggestion-a', reportId: 'report-a', confirmedAt: 2, confirmedBy: 'user:usr_test',
      priceSource: 'venue_avg_fill_price', basisDigest: `sha256:${'a'.repeat(64)}`,
    } }).ok).toBe(true)
    expect(validateFill({ ...base, inferred: { ...base, priceSource: 'raw-value' } }).ok).toBe(false)
  })
})
