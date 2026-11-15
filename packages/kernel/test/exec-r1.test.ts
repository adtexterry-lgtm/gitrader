// SPDX-License-Identifier: CPAL-1.0
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Order, OrderIntent } from '../src/proto'
import { makeProblem } from '../src/proto'
import { KernelError } from '../src/util/errors'
import type { VenueFill } from '@gitrader/protocol/connector'
import { Kernel } from '../src/kernel'
import { fileProvider } from '../src/device-key'
import { FakeClock } from '../src/util/clock'
import { mkOrigin } from '../src/util/origin'
import { ConnectorBus, ConnectorOperationError, mapVenueStatus } from '../src/connector'
import { PaperVenue } from '../../venue-paper/src/venue'
import { BTC, TestMarket } from '../../venue-paper/test/helpers/test-market'
import { FakeConnector } from './helpers/fake-connector'
import type { ActorCtx } from '../src/trading'

describe('execution r1 with the paper venue', () => {
  let k: Kernel, home: string, market: TestMarket, paper: PaperVenue, human: ActorCtx, logs: string[]
  beforeEach(async () => {
    logs = []
    home = mkdtempSync(join(tmpdir(), 'gitrader-exec-r1-'))
    market = new TestMarket()
    k = await Kernel.create({ home, clock: { now: () => market.now }, deviceKeyProvider: fileProvider, scrypt: { N: 1024, r: 8, p: 1 }, timers: false, log: (message) => logs.push(message) })
    const source = new FakeConnector({ id: 'hyperliquid', clock: { now: () => market.now } })
    source.quote = market.quote.bind(market)
    source.context = market.context.bind(market)
    paper = new PaperVenue({ market, clock: () => market.now })
    k.registerConnector(source)
    k.registerConnector(paper)
    const session = k.auth.authenticateToken(k.auth.exchangeBoot(k.auth.mintBootToken()).sessionToken)!
    human = { principal: session, origin: mkOrigin('user:usr_local', 'order', 'ui') }
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    await k?.stop()
    if (home) rmSync(home, { recursive: true, force: true })
  })
  const intent = (extra: Partial<OrderIntent> = {}): OrderIntent => ({
    accountId: k.accounts.find('paper')!.accountId, instrumentId: BTC, side: 'buy', type: 'limit',
    price: '79000', size: '0.003', reason: 'execution fixture', ...extra,
  } as OrderIntent)
  const place = async (extra: Partial<OrderIntent> = {}, ctx = human): Promise<Order> => {
    const result = await k.trading.place({ intent: intent(extra) }, ctx)
    expect(result.order?.status).toMatch(/open|untriggered|filled/)
    return result.order!
  }
  const fill = (o: Order, extra: Partial<VenueFill> = {}): VenueFill => ({
    venueOrderId: o.venueOrderId!, clientOrderId: o.clientOrderId, venueFillId: 'execution-fill',
    instrumentId: BTC, side: o.side, size: '0.001', price: '79000', fee: '0.01', feeCcy: 'USDC',
    liquidity: 'maker', realizedPnl: '0', ts: market.now, ...extra,
  } as VenueFill)
  async function agent(limits: Record<string, number> = {}) {
    const proof = k.pin.isSet() ? await k.auth.pinProof(human.principal, '482916') : await k.auth.setupPin(human.principal, '482916')
    const result = k.agents.createKey({ name: 'execution fixture', host: 'other', tier: 'paper', mandate: { accounts: [k.accounts.find('paper')!.accountId], limits } }, proof, human.origin)
    const principal = k.auth.authenticateToken(result.token)!
    const ctx: ActorCtx = { principal, origin: k.auth.originFor(principal, 'order', 'mcp', '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d') }
    return { principal, ctx }
  }


  const bump = () => { market.now += 6000; market.setPrice(BTC, market.mark[BTC]!) }
  const entries = () => [...k.ledger.iterate()]
  const pinHuman = async (): Promise<ActorCtx> => ({
    ...human, proof: k.pin.isSet() ? await k.auth.pinProof(human.principal, '482916') : await k.auth.setupPin(human.principal, '482916'),
  })
  const childOf = (parent: Order, role: 'sl' | 'tp' = 'sl') => k.orders.list().find((o) => o.parentOrderId === parent.orderId && o.tpslRole === role)!
  async function activeProtection(ctx: ActorCtx, stopLimit = false) {
    const parent = await place({ tpsl: { grouping: 'order', stopLoss: { triggerPrice: '78000', ...(stopLimit ? { price: '77900' } : {}) }, takeProfit: { triggerPrice: '82000' } } as never }, ctx)
    market.setPrice(BTC, 78900); await paper.tick(); bump()
    return { parent, stop: childOf(parent), take: childOf(parent, 'tp') }
  }
  const amendReq = (o: Order, changes: { price?: string; size?: string; triggerPrice?: string }) => ({ accountId: o.accountId, orderId: o.orderId, ...changes })
  const reservation = (o: Order) => {
    const book = (k.trading as unknown as { reservations: { records: Map<string, { record: { clientOrderId: string; size: string; notional: string; margin: string } }> } }).reservations
    return [...book.records.values()].find((x) => x.record.clientOrderId === o.clientOrderId)?.record
  }
  async function restart(alreadyStopped = false) {
    if (!alreadyStopped) await k.stop()
    k = await Kernel.create({ home, clock: { now: () => market.now }, deviceKeyProvider: fileProvider, scrypt: { N: 1024, r: 8, p: 1 }, timers: false })
    const source = new FakeConnector({ id: 'hyperliquid', clock: { now: () => market.now } })
    source.quote = market.quote.bind(market); source.context = market.context.bind(market)
    k.registerConnector(source); k.registerConnector(paper)
    human = { principal: k.auth.authenticateToken(k.auth.exchangeBoot(k.auth.mintBootToken()).sessionToken)!, origin: mkOrigin('user:usr_local', 'order', 'ui') }
  }
  async function within<T>(promise: Promise<T>, ms = 1000): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('operation blocked by venue confirmation')), ms) })]) }
    finally { clearTimeout(timer) }
  }

  it.each([
    ['stop away', 'sl', { triggerPrice: '1000' }, false],
    ['stop coverage smaller', 'sl', { size: '0.002' }, false],
    ['take away', 'tp', { triggerPrice: '90000' }, false],
    ['stop limit harder to fill', 'sl', { price: '78500' }, true],
  ] as const)('denies Agent protective amendment: %s and records the denial', async (_name, role, changes, limit) => {
    const a = await agent(), { stop, take } = await activeProtection(a.ctx, limit)
    const order = role === 'sl' ? stop : take
    await expect(k.trading.amend(a.ctx, amendReq(order, changes))).rejects.toMatchObject({ problem: { code: 2009 } })
    expect(k.ledger.trace({ orderId: order.orderId })).toContainEqual(expect.objectContaining({
      type: 'order.rejected', payload: expect.objectContaining({ kind: 'amend', reason: 'protective_loosen', problem: expect.objectContaining({ code: 2009 }), before: expect.any(Object), after: expect.any(Object) }),
    }))
    expect(k.orders.get(order.orderId)?.size).toBe('0.003')
  })

  it('allows an Agent to move its stop nearer in ACTIVE', async () => {
    const a = await agent(), { stop } = await activeProtection(a.ctx)
    expect((await k.trading.amend(a.ctx, amendReq(stop, { triggerPrice: '78500' }))).order.triggerPrice).toBe('78500')
  })

  it.each(['ACTIVE', 'HALTED', 'REDUCING', 'KILL'] as const)('allows a PIN human to loosen a protective order in %s', async (state) => {
    const ctx = await pinHuman(), { stop } = await activeProtection(ctx)
    if (state === 'KILL') k.trading.setKillSwitchState({ tripped: true })
    else k.tstate.set({ type: 'account', id: stop.accountId }, state, 'fixture', human.origin)
    const result = await k.trading.amend(ctx, amendReq(stop, { triggerPrice: '1000', size: '0.002' }))
    expect(result.order).toMatchObject({ triggerPrice: '1000', size: '0.002' })
    expect(k.ledger.trace({ orderId: stop.orderId }).find((e) => e.type === 'order.amended')?.payload).toMatchObject({ orderId: stop.orderId })
  })

  it('requires PIN presence for a human protective amendment', async () => {
    const { stop } = await activeProtection(human)
    await expect(k.trading.amend(human, amendReq(stop, { triggerPrice: '1000' }))).rejects.toHaveProperty('problem')
    expect(k.orders.get(stop.orderId)?.triggerPrice).toBe('78000')
  })

  it.each([
    ['HALTED', 'org'], ['HALTED', 'account'], ['HALTED', 'instrument'], ['HALTED', 'mandate'],
    ['REDUCING', 'org'], ['REDUCING', 'account'], ['REDUCING', 'instrument'], ['REDUCING', 'mandate'],
  ] as const)('denies Agent amendments in %s at %s scope', async (state, scope) => {
    const a = await agent(), { stop } = await activeProtection(a.ctx)
    const id = scope === 'org' ? 'org_local' : scope === 'account' ? stop.accountId : scope === 'instrument' ? stop.instrumentId : stop.mandateId!
    k.tstate.set({ type: scope, id } as never, state, 'fixture', human.origin)
    await expect(k.trading.amend(a.ctx, amendReq(stop, { triggerPrice: '78500' }))).rejects.toMatchObject({ problem: { code: 2002 } })
    expect(k.ledger.trace({ orderId: stop.orderId })).toContainEqual(expect.objectContaining({ type: 'order.rejected', payload: expect.objectContaining({ kind: 'amend', reason: 'scope_state' }) }))
  })

  it('denies Agent amendments under the kill switch', async () => {
    const a = await agent(), { stop } = await activeProtection(a.ctx)
    k.trading.setKillSwitchState({ tripped: true })
    await expect(k.trading.amend(a.ctx, amendReq(stop, { triggerPrice: '78500' }))).rejects.toMatchObject({ problem: { code: 2002 } })
  })

  it.each(['HALTED', 'REDUCING'] as const)('keeps human amend-to-open on open limits in %s', async (state) => {
    const order = await place(), ctx = await pinHuman(); bump()
    k.tstate.set({ type: 'account', id: order.accountId }, state, 'fixture', human.origin)
    await expect(k.trading.amend(ctx, amendReq(order, { size: '0.002' }))).rejects.toMatchObject({ problem: { code: 2002 } })
  })

  it('records not-owner amendment rejection', async () => {
    const a = await agent(), order = await place()
    await expect(k.trading.amend(a.ctx, amendReq(order, { price: '78500' }))).rejects.toMatchObject({ problem: { code: 1016 } })
    expect(k.ledger.trace({ orderId: order.orderId })).toContainEqual(expect.objectContaining({ type: 'order.rejected', payload: expect.objectContaining({ kind: 'amend', reason: 'not_owner' }) }))
  })

  async function unlinkedStop() {
    const submit = paper.submit.bind(paper)
    vi.spyOn(paper, 'submit').mockImplementation(async (ctx, intents) => {
      const result = await submit(ctx, intents)
      return { ...result, acks: result.acks.map((ack) => ack.role === 'sl' ? { ...ack, venueOrderId: null, clientOrderId: '' } : ack) }
    })
    return childOf(await place({ tpsl: { grouping: 'order', stopLoss: { triggerPrice: '78000' } } as never }))
  }

  it('keeps an unidentified child without halting startup or restoring a reservation', async () => {
    const child = await unlinkedStop()
    expect((await k.startupReconcile(3000)).find((r) => r.account === child.accountId)?.ok).toBe(true)
    expect(k.tstate.get({ type: 'account', id: child.accountId })).not.toBe('HALTED')
    expect((k.trading as unknown as { unlinkedChildCount(): number }).unlinkedChildCount()).toBe(1)
    expect(k.docs.get('order-record', child.orderId)).toHaveProperty('unlinked')
    expect(entries()).toContainEqual(expect.objectContaining({ type: 'annotation', payload: expect.objectContaining({ kind: 'order.child_unlinked', parentOrderId: child.parentOrderId, tpslRole: 'sl' }) }))
    expect(entries()).toContainEqual(expect.objectContaining({ type: 'startup.reconciled', payload: expect.objectContaining({ unlinkedChildren: 1, unresolved: [] }) }))
    await restart()
    expect(reservation(child)).toBeUndefined()
    await k.trading.precheckIntent(intent({ price: '78500' as never }), human); bump()
    await k.trading.precheckIntent(intent({ price: '78400' as never }), human)
    expect(k.orders.get(child.orderId)?.status).toBe('untriggered')
  })

  it.each(['push', 'fill', 'query'] as const)('links an unidentified child by reliable client id from %s', async (source) => {
    const child = await unlinkedStop(), venueOrderId = 'linked-child'
    if (source === 'push') k.trading.onOrderUpdate(child.accountId, { venueOrderId, clientOrderId: child.clientOrderId, status: 'untriggered' })
    if (source === 'fill') k.trading.onVenueFill(child.accountId, fill(child, { venueOrderId }))
    if (source === 'query') {
      vi.spyOn(paper, 'orderStatus').mockResolvedValue({ found: true, status: 'untriggered', venueOrderId })
      await k.bus.lookup(k.accounts.get(child.accountId), child.clientOrderId)
    }
    expect(k.orders.get(child.orderId)?.venueOrderId).toBe(venueOrderId)
    expect(k.docs.get('order-record', child.orderId)).not.toHaveProperty('unlinked')
    expect(entries()).toContainEqual(expect.objectContaining({ type: 'annotation', payload: expect.objectContaining({ kind: 'order.child_linked' }) }))
  })

  it('rejects individual cancel and amend of an unlinked child before contacting the venue', async () => {
    const child = await unlinkedStop(), cancel = vi.spyOn(paper, 'cancel'), amend = vi.spyOn(paper, 'amend')
    await expect(k.trading.cancel({ accountId: child.accountId, orderId: child.orderId }, human)).rejects.toMatchObject({ problem: { name: 'INVALID_PARAMS' } })
    await expect(k.trading.amend(await pinHuman(), amendReq(child, { triggerPrice: '78500' }))).rejects.toMatchObject({ problem: { name: 'INVALID_PARAMS' } })
    expect(cancel).not.toHaveBeenCalled(); expect(amend).not.toHaveBeenCalled()
  })

  it('confirms five cancellations concurrently in under one second', async () => {
    for (const px of ['79000', '78900', '78800', '78700', '78600']) { await place({ price: px as never }); bump() }
    const status = paper.orderStatus.bind(paper)
    vi.spyOn(paper, 'orderStatus').mockImplementation(async (ref, key) => { await new Promise((resolve) => setTimeout(resolve, 400)); return status(ref, key) })
    const start = performance.now()
    expect((await k.trading.cancelAll({ accountId: intent().accountId }, human)).cancelled).toBe(5)
    expect(performance.now() - start).toBeLessThan(1000)
  })

  it.each(['takeover', 'system'] as const)('returns %s cancellation acknowledgement without waiting for status', async (kind) => {
    const order = await place()
    vi.spyOn(paper, 'cancel').mockImplementation(async (_ctx, targets) => targets.map((target) => ({ target, ok: true })))
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    vi.spyOn(paper, 'orderStatus').mockImplementation(async () => { await gate; return { found: true, status: 'cancelled', venueOrderId: order.venueOrderId! } })
    const account = k.accounts.get(order.accountId)
    const pending = kind === 'takeover' ? k.trading.takeoverCancelAll(account, {}, human) : k.trading.systemCancelAll(account)
    try {
      expect(await within(pending)).toEqual({ cancelled: 1 })
      expect(k.orders.get(order.orderId)?.status).toBe('open')
      expect(entries()).toContainEqual(expect.objectContaining({ type: 'annotation', payload: expect.objectContaining({ kind: 'cancel_all.requested', confirmation: 'pending' }) }))
      k.trading.onOrderUpdate(order.accountId, { venueOrderId: order.venueOrderId!, clientOrderId: order.clientOrderId, status: 'cancelled' })
    } finally { release(); await pending }
    await vi.waitFor(() => expect(entries()).toContainEqual(expect.objectContaining({ type: 'order.cancelled', payload: expect.objectContaining({ requested: 1, confirmed: 1 }) })))
  })

  it('persists partial cancellation failure immediately while final evidence follows background confirmation', async () => {
    const order = await place(), account = k.accounts.get(order.accountId)
    const problem = makeProblem('VENUE_UNAVAILABLE', 'fixture view failure')
    const operation = new ConnectorOperationError(problem, ['reconcile', 'cancel_all'], {
      partialCancel: { cancelled: 1, acks: [{ ok: true, target: { instrumentId: order.instrumentId, clientOrderId: order.clientOrderId, venueOrderId: order.venueOrderId! } }] },
      viewFailure: { problem, stages: ['reconcile'] },
    })
    vi.spyOn(k.bus, 'cancelAll').mockRejectedValue(operation)
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    vi.spyOn(paper, 'orderStatus').mockImplementation(async () => { await gate; return { found: true, status: 'cancelled', venueOrderId: order.venueOrderId! } })
    const pending = k.trading.systemCancelAll(account)
    try {
      await expect(within(pending)).rejects.toMatchObject({ problem, stages: operation.stages, partialCancel: operation.partialCancel, viewFailure: operation.viewFailure })
      expect(k.orders.get(order.orderId)?.status).toBe('open')
      expect(entries()).toContainEqual(expect.objectContaining({ type: 'annotation', payload: expect.objectContaining({
        kind: 'cancel_all.requested', confirmation: 'pending', failure: { problem, errorStages: operation.stages },
      }) }))
    } finally { release(); await pending.catch(() => undefined) }
    await vi.waitFor(() => {
      const final = entries().slice(-2)
      expect(final.map((entry) => entry.type)).toEqual(['order.cancelled', 'order.rejected'])
      expect(final[0]!.payload).toMatchObject({ kind: 'cancel.partial', confirmed: 1, requested: 1 })
      expect(final[1]!.payload).toMatchObject({ problem, partialCancelled: 1 })
    })
  })

  it('does not backfill fills when confirming foreign orders', async () => {
    const account = k.accounts.get(intent().accountId)
    await paper.submit({ account: k.bus.accountRef(account) } as never, [{ ...intent(), clientOrderId: 'ab'.repeat(16) } as never])
    const fills = vi.spyOn(paper, 'fills')
    expect(await k.trading.cancelAll({ accountId: account.accountId }, human)).toEqual({ cancelled: 1 })
    expect(fills).not.toHaveBeenCalled()
  })

  it('deduplicates fill ids separately for two accounts at one venue', async () => {
    await k.stop()
    const path = join(home, 'gitrader.json'), cfg = JSON.parse(readFileSync(path, 'utf8'))
    cfg.accounts.push({ alias: 'paper2', venue: 'hyperliquid', environment: 'testnet', mode: 'paper', paper: { initialBalance: '10000', ccy: 'USDC' } })
    writeFileSync(path, JSON.stringify(cfg))
    await restart(true)
    const one = await place(), two = await place({ accountId: k.accounts.find('paper2')!.accountId })
    k.trading.onVenueFill(one.accountId, fill(one))
    k.trading.onVenueFill(two.accountId, fill(two))
    expect(k.orders.fills({ orderId: one.orderId })).toHaveLength(1)
    expect(k.orders.fills({ orderId: two.orderId })).toHaveLength(1)
    expect(k.tstate.get({ type: 'account', id: two.accountId })).not.toBe('HALTED')
  })

  it('persists amend ticket rate use across restart and excludes TP/SL children', async () => {
    const a = await agent({ maxOrdersPerMinute: 2 })
    const order = await place({}, a.ctx); bump()
    await k.trading.amend(a.ctx, amendReq(order, { size: '0.002' }))
    expect(k.orders.countSince(order.accountId, market.now - 60_000, order.mandateId)).toBe(2)
    await restart(); bump()
    await expect(k.trading.amend(a.ctx, amendReq(order, { size: '0.001' }))).rejects.toHaveProperty('problem.ruleHits', expect.arrayContaining([expect.objectContaining({ unit: 'orders/min' })]))
    expect(k.orders.countSince(order.accountId, market.now - 60_000)).toBe(2)
  })

  it('counts an attached TP and SL submission only once', async () => {
    const order = await place({ tpsl: { grouping: 'order', stopLoss: { triggerPrice: '78000' }, takeProfit: { triggerPrice: '82000' } } as never })
    expect(k.orders.countSince(order.accountId, market.now - 60_000)).toBe(1)
  })

  it('records unknown status once per local order and raw status', async () => {
    const order = await place(), warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(paper, 'orderStatus').mockResolvedValue({ found: true, status: 'futureStatus', venueOrderId: order.venueOrderId! })
    await k.bus.lookup(k.accounts.get(order.accountId), order.clientOrderId)
    await k.bus.lookup(k.accounts.get(order.accountId), order.clientOrderId)
    expect(k.ledger.trace({ orderId: order.orderId }).filter((e) => e.type === 'order.status_unknown').map((e) => e.payload)).toEqual([{ venue: 'kernel-sim', rawStatus: 'futureStatus', orderId: order.orderId }])
    expect(k.orders.get(order.orderId)?.status).toBe('open')
    warn.mockRestore()
  })

  it('uses trigger price for both opening reservation and stored notional', async () => {
    const order = await place({ type: 'stop_market', price: undefined, triggerPrice: '81000' as never })
    expect(reservation(order)?.notional).toBe('243')
    expect(k.db.prepare('SELECT notional FROM orders WHERE order_id=?').get(order.orderId)).toMatchObject({ notional: '243' })
  })

  it('refreshes an amended venue id by client id and uses the new id to cancel', async () => {
    const order = await place(); bump()
    const original = paper.orderStatus.bind(paper)
    const orderStatus = vi.spyOn(paper, 'orderStatus').mockImplementation(async (ref, key) => key.venueOrderId === 'replacement-order' ? original(ref, key) : { found: true, status: 'open', venueOrderId: 'replacement-order' })
    await k.trading.amend(human, amendReq(order, { price: '78500' }))
    expect(orderStatus).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ clientOrderId: order.clientOrderId, venueOrderId: order.venueOrderId, instrumentId: order.instrumentId }))
    expect(k.orders.get(order.orderId)?.venueOrderId).toBe('replacement-order')
    const cancel = vi.spyOn(paper, 'cancel').mockImplementation(async (_ctx, targets) => targets.map((target) => ({ target, ok: true })))
    await k.trading.cancel({ accountId: order.accountId, orderId: order.orderId }, human)
    expect(cancel.mock.calls[0]?.[1][0]?.venueOrderId).toBe('replacement-order')
  })

  it('refreshes a venue id from a same-status push', async () => {
    const order = await place()
    k.trading.onOrderUpdate(order.accountId, { venueOrderId: 'push-replacement', clientOrderId: order.clientOrderId, status: 'open' })
    expect(k.orders.get(order.orderId)?.venueOrderId).toBe('push-replacement')
  })

  it('lets cancellation proceed during an amendment and rejects a second in-flight amend', async () => {
    const order = await place(); bump()
    const original = paper.amend.bind(paper)
    let release!: () => void, started!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve }), ready = new Promise<void>((resolve) => { started = resolve })
    vi.spyOn(paper, 'amend').mockImplementation(async (ctx, req) => { started(); await gate; return original(ctx, req) })
    const pending = k.trading.amend(human, amendReq(order, { size: '0.004' })).catch((e: unknown) => e)
    await ready
    try {
      expect(reservation(order)?.notional).toBe('316')
      await expect(within(k.trading.amend(human, amendReq(order, { size: '0.002' })))).rejects.toMatchObject({ problem: { name: 'INVALID_PARAMS' } })
      expect(await within(k.trading.cancel({ accountId: order.accountId, orderId: order.orderId }, human))).toMatchObject({ ok: true })
      expect(k.orders.get(order.orderId)?.status).toBe('cancelled')
    } finally { release(); await pending }
    expect(k.orders.get(order.orderId)?.status).toBe('cancelled')
    expect(reservation(order)).toBeUndefined()
  })

  it.each(['rejected', 'unknown'] as const)('handles %s amend outcome without losing the prior exposure', async (status) => {
    const order = await place(); bump()
    vi.spyOn(paper, 'amend').mockResolvedValue({ acks: [{ intentIndex: 0, clientOrderId: order.clientOrderId, venueOrderId: order.venueOrderId!, status, filledSize: '0' as never, avgFillPrice: null, builder: { attached: false } }], receiptHash: 'ab'.repeat(32), requestWeight: 0 })
    await expect(k.trading.amend(human, amendReq(order, { size: '0.004' }))).rejects.toMatchObject({ problem: { code: status === 'unknown' ? 3006 : 3001 } })
    expect(reservation(order)?.notional).toBe(status === 'unknown' ? '316' : '237')
    const trail = k.ledger.trace({ orderId: order.orderId })
    if (status === 'unknown') {
      expect(trail).toContainEqual(expect.objectContaining({ type: 'annotation', payload: expect.objectContaining({ kind: 'amend.unknown' }) }))
      expect(trail.filter((e) => e.type === 'order.rejected')).toHaveLength(0)
      await restart()
      expect(reservation(order)?.notional).toBe('316')
    }
    expect(k.orders.get(order.orderId)?.size).toBe('0.003')
  })

  it('excludes the amended order from exposure precheck near its cap', async () => {
    const ctx = await pinHuman()
    await k.risk.relax({ limits: { maxPositionNotionalRatio: '0.025' as never, maxTotalNotionalRatio: null, duplicateIntentWindowSec: 0 }, protectors: [] }, ctx.proof!, ctx.origin)
    const order = await place(); bump()
    expect((await k.trading.amend(human, amendReq(order, { price: '78500' }))).order.price).toBe('78500')
  })


  it.each([['sl', '90000'], ['tp', '1000']] as const)('denies a buy-side %s moved farther from the market', async (role, triggerPrice) => {
    const a = await agent()
    const parent = await place({ side: 'sell', price: '81000' as never, tpsl: { grouping: 'order', stopLoss: { triggerPrice: '82000' }, takeProfit: { triggerPrice: '78000' } } as never }, a.ctx)
    market.setPrice(BTC, 81100); await paper.tick(); bump()
    await expect(k.trading.amend(a.ctx, amendReq(childOf(parent, role), { triggerPrice }))).rejects.toMatchObject({ problem: { code: 2009 } })
  })

  it('audits unknown pushes for each local order while foreign orders remain log-only', async () => {
    const one = await place(); bump()
    const two = await place({ price: '78800' as never })
    let listener!: Parameters<PaperVenue['onEvent']>[0]
    const onEvent = paper.onEvent.bind(paper)
    vi.spyOn(paper, 'onEvent').mockImplementation((cb) => { listener = cb; return onEvent(cb) })
    k.bus.watchAccount(k.accounts.get(one.accountId))
    for (const order of [one, one, two]) listener({ kind: 'order', accountId: order.accountId, order: { ...order, status: 'futurePushStatus' } } as never)
    listener({ kind: 'order', accountId: one.accountId, order: { ...one, venueOrderId: 'foreign-order', clientOrderId: 'cd'.repeat(16), status: 'futurePushStatus' } } as never)
    expect(entries().filter((e) => e.type === 'order.status_unknown')).toHaveLength(2)
    expect(k.ledger.trace({ orderId: one.orderId }).filter((e) => e.type === 'order.status_unknown')).toHaveLength(1)
    expect(k.ledger.trace({ orderId: two.orderId }).filter((e) => e.type === 'order.status_unknown')).toHaveLength(1)
    expect(logs.filter((message) => message.includes('order.status_unknown'))).toHaveLength(1)
    expect(logs.find((message) => message.includes('order.status_unknown'))).toMatch(/^warning:/)
  })

  it('bounds concurrent cancel confirmations to eight workers', async () => {
    const account = k.accounts.get(intent().accountId)
    for (let index = 0; index < 12; index++) await paper.submit({ account: k.bus.accountRef(account) } as never, [{ ...intent(), clientOrderId: index.toString(16).padStart(32, '0') } as never])
    const status = paper.orderStatus.bind(paper)
    let active = 0, maximum = 0
    vi.spyOn(paper, 'orderStatus').mockImplementation(async (ref, key) => {
      active++; maximum = Math.max(maximum, active)
      try { await new Promise((resolve) => setTimeout(resolve, 30)); return await status(ref, key) }
      finally { active-- }
    })
    expect(await k.trading.cancelAll({ accountId: account.accountId }, human)).toEqual({ cancelled: 12 })
    expect(maximum).toBe(8)
  })

  it('keeps the larger amendment exposure while another precheck sees the old venue order', async () => {
    const ctx = await pinHuman()
    await k.risk.relax({ limits: { maxPositionNotionalRatio: '0.04' as never, maxTotalNotionalRatio: null, duplicateIntentWindowSec: 0 }, protectors: [] }, ctx.proof!, ctx.origin)
    const order = await place(); bump()
    const original = paper.amend.bind(paper)
    let release!: () => void, started!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve }), ready = new Promise<void>((resolve) => { started = resolve })
    vi.spyOn(paper, 'amend').mockImplementation(async (call, req) => { started(); await gate; return original(call, req) })
    const pending = k.trading.amend(human, amendReq(order, { size: '0.004' }))
    await ready
    try {
      const result = await k.trading.precheckIntent(intent({ size: '0.002' as never, price: '78000' as never }), human)
      expect(result.verdict).toBe('deny')
      expect(result.ruleHits).toContainEqual(expect.objectContaining({ code: 'POSITION_NOTIONAL' }))
    } finally { release(); await pending }
  })


  it.each([
    ['RATE_BUDGET', 'RATE_BUDGET', '237'],
    ['VENUE_AUTH', 'VENUE_AUTH', '237'],
    ['VENUE_UNAVAILABLE', 'VENUE_OUTCOME_UNKNOWN', '316'],
  ] as const)('classifies thrown %s without confusing rejection with an unknown outcome', async (name, expected, held) => {
    const order = await place(); bump()
    vi.spyOn(paper, 'amend').mockRejectedValue(new KernelError(makeProblem(name, 'fixture venue failure')))
    await expect(k.trading.amend(human, amendReq(order, { size: '0.004' }))).rejects.toMatchObject({ problem: { name: expected } })
    expect(reservation(order)?.notional).toBe(held)
    expect(k.orders.countSince(order.accountId, market.now - 60_000)).toBe(2)
    const trail = k.ledger.trace({ orderId: order.orderId })
    expect(trail.some((entry) => entry.type === 'order.rejected')).toBe(expected !== 'VENUE_OUTCOME_UNKNOWN')
    expect(trail.some((entry) => (entry.payload as { kind?: string }).kind === 'amend.unknown')).toBe(expected === 'VENUE_OUTCOME_UNKNOWN')
  })

  it('persists TP/SL children and reconciles a parent fill followed by a stop fill', async () => {
    const parent = await place({ tpsl: { grouping: 'order', takeProfit: { triggerPrice: '82000', price: '81900' }, stopLoss: { triggerPrice: '78000' } } as never })
    const children = k.orders.list().filter((o) => o.parentOrderId === parent.orderId)
    expect(children).toHaveLength(2)
    expect(children.find((o) => o.tpslRole === 'tp')).toMatchObject({ type: 'take_limit', price: '81900', triggerPrice: '82000', side: 'sell', reduceOnly: true, status: 'untriggered', size: '0.003', origin: parent.origin })
    const stop = children.find((o) => o.tpslRole === 'sl')!
    expect(stop).toMatchObject({ type: 'stop_market', status: 'untriggered', parentOrderId: parent.orderId })
    expect(stop.clientOrderId).not.toBe(parent.clientOrderId)
    market.setPrice(BTC, 78900)
    await paper.tick()
    expect(k.orders.get(parent.orderId)?.status).toBe('filled')
    market.setPrice(BTC, 77900)
    await paper.tick()
    expect(k.orders.get(stop.orderId)).toMatchObject({ status: 'filled', filledSize: '0.003' })
    expect(k.orders.get(children.find((o) => o.tpslRole === 'tp')!.orderId)?.status).toBe('cancelled')
    expect(k.orders.fills({ accountId: parent.accountId })).toHaveLength(2)
    expect((await paper.accountState(k.bus.accountRef(k.accounts.get(parent.accountId)))).positions).toHaveLength(0)
    const ledger = k.ledger.trace({ orderId: stop.orderId })
    expect(ledger.filter((e) => e.type === 'order.accepted')).toHaveLength(1)
    expect(ledger.find((e) => e.type === 'order.triggered')?.origin).toEqual(parent.origin)
    expect(ledger.filter((e) => e.type === 'fill')).toHaveLength(1)
  })

  it('follows venue child cancellation without predicting it from the parent ack', async () => {
    const parent = await place({ tpsl: { grouping: 'order', stopLoss: { triggerPrice: '78000' } } as never })
    const child = k.orders.list().find((o) => o.parentOrderId === parent.orderId)!
    expect(child).toBeDefined()
    vi.spyOn(paper, 'cancel').mockImplementation(async (_ctx, targets) => targets.map((target) => ({ target, ok: true })))
    await k.trading.cancel({ accountId: parent.accountId, orderId: parent.orderId }, human)
    expect(k.orders.get(child.orderId)?.status).toBe('untriggered')
    k.trading.onOrderUpdate(parent.accountId, { venueOrderId: child.venueOrderId!, clientOrderId: null, status: 'cancelled' })
    expect(k.orders.get(child.orderId)?.status).toBe('cancelled')
  })

  it('amends through the authenticated Agent API and keeps original ownership', async () => {
    const a = await agent()
    const order = await place({}, a.ctx)
    market.now += 6000
    market.setPrice(BTC, market.mark[BTC]!)
    const response = await k.ops.call(k, 'agent.order', { principal: a.principal, transport: 'http', params: { action: 'amend', accountId: order.accountId, orderId: order.orderId, price: '78500', size: '0.002' } }) as { data: { order: Order } }
    expect(response.data.order).toMatchObject({ orderId: order.orderId, price: '78500', size: '0.002', status: 'open', origin: order.origin })
    expect(paper.orders(order.accountId).find((o) => o.venueOrderId === order.venueOrderId)).toMatchObject({ price: '78500', size: '0.002' })
    expect(k.ledger.trace({ orderId: order.orderId }).filter((e) => e.type === 'order.amended')).toHaveLength(1)
  })

  it('rejects another actor with 1016 and rejects terminal orders with INVALID_PARAMS', async () => {
    const a = await agent(), b = await agent()
    const order = await place({}, a.ctx)
    await expect(k.trading.amend(b.ctx, { accountId: order.accountId, orderId: order.orderId, price: '78000' })).rejects.toMatchObject({ problem: { code: 1016 } })
    await k.trading.cancel({ accountId: order.accountId, orderId: order.orderId }, human)
    await expect(k.trading.amend(a.ctx, { accountId: order.accountId, orderId: order.orderId, price: '78000' })).rejects.toMatchObject({ problem: { name: 'INVALID_PARAMS' } })
  })

  it('passes an attached TP/SL amend rejection through unchanged', async () => {
    const order = await place({ tpsl: { grouping: 'order', stopLoss: { triggerPrice: '78000' } } as never })
    market.now += 6000
    market.setPrice(BTC, market.mark[BTC]!)
    const problem = { code: 1004, name: 'ORDER_TYPE_UNSUPPORTED', category: 'REJECTED', message: 'amend does not support attached tpsl', retryable: false } as const
    vi.spyOn(paper, 'amend').mockImplementation(async (_ctx, req) => {
      expect(req.order.tpsl?.stopLoss?.triggerPrice).toBe('78000')
      return { acks: [{ intentIndex: 0, clientOrderId: order.clientOrderId, venueOrderId: order.venueOrderId!, status: 'rejected', filledSize: '0' as never, avgFillPrice: null, builder: { attached: false }, problem }], receiptHash: 'ab'.repeat(32), requestWeight: 0 }
    })
    await expect(k.trading.amend(human, { accountId: order.accountId, orderId: order.orderId, price: '78500' })).rejects.toMatchObject({ problem })
    expect(k.orders.get(order.orderId)?.price).toBe('79000')
  })

  it('keeps cancel acknowledgements pending and accounts for fills before cancellation', async () => {
    const order = await place()
    vi.spyOn(paper, 'cancel').mockImplementation(async (_ctx, targets) => targets.map((target) => ({ target, ok: true })))
    await k.trading.cancel({ accountId: order.accountId, orderId: order.orderId }, human)
    expect(k.orders.get(order.orderId)?.status).toBe('open')
    expect(k.orders.get(order.orderId)).not.toHaveProperty('cancelRequestedAt')
    k.trading.onVenueFill(order.accountId, fill(order))
    k.trading.onOrderUpdate(order.accountId, { venueOrderId: order.venueOrderId!, clientOrderId: order.clientOrderId, status: 'cancelled' })
    expect(k.orders.get(order.orderId)).toMatchObject({ status: 'cancelled', filledSize: '0.001', fee: '0.01' })
    expect(k.orders.fills({ orderId: order.orderId })).toHaveLength(1)
    expect(k.ledger.trace({ orderId: order.orderId }).filter((e) => e.type === 'order.cancelled')).toHaveLength(1)
  })

  it.each([true, false])('deduplicates push and status-query fills (venue id present: %s)', async (hasId) => {
    const order = await place()
    const f = fill(order, { venueFillId: hasId ? 'execution-fill' : '' })
    const protection = vi.spyOn(k.protectors, 'onFill')
    k.trading.onVenueFill(order.accountId, f)
    vi.spyOn(paper, 'cancel').mockImplementation(async (_ctx, targets) => targets.map((target) => ({ target, ok: true })))
    vi.spyOn(paper, 'orderStatus').mockResolvedValue({ found: true, status: 'cancelled', venueOrderId: order.venueOrderId!, filledSize: '0.002' as never })
    vi.spyOn(paper, 'fills').mockResolvedValue([f, fill(order, { venueFillId: hasId ? 'execution-fill-2' : '', ts: market.now + 1 })])
    await k.trading.cancel({ accountId: order.accountId, orderId: order.orderId }, human)
    expect(k.orders.fills({ orderId: order.orderId })).toHaveLength(2)
    expect(k.orders.get(order.orderId)).toMatchObject({ status: 'cancelled', filledSize: '0.002', fee: '0.02' })
    expect(protection).toHaveBeenCalledTimes(2)
    expect(k.ledger.trace({ orderId: order.orderId }).filter((e) => e.type === 'fill')).toHaveLength(2)
  })
})

describe('venue status normalization', () => {
  it.each([
    ['modified', 'open'], ['waitingForTrigger', 'untriggered'], ['waitingForFill', 'open'],
    ...['siblingFilledCanceled', 'reduceOnlyCanceled', 'liquidatedCanceled', 'selfTradeCanceled', 'vaultWithdrawalCanceled', 'openInterestCapCanceled', 'delistedCanceled'].map((s) => [s, 'cancelled']),
    ['scheduledCancel', 'expired'],
    ['internalCancel', 'cancelled'], ['outcomeSettledCanceled', 'cancelled'],
    ...['badTriggerPxRejected', 'marketOrderNoLiquidityRejected', 'tickRejected', 'minTradeNtlRejected', 'perpMarginRejected', 'positionIncreaseAtOpenInterestCapRejected', 'positionFlipAtOpenInterestCapRejected', 'oracleRejected', 'badAloPxRejected', 'iocCancelRejected', 'tooAggressiveAtOpenInterestCapRejected', 'openInterestIncreaseRejected', 'perpMaxPositionRejected', 'tooManyOpenOrdersRejected'].map((s) => [s, 'rejected']),
  ])('%s becomes %s', (source, expected) => { expect(mapVenueStatus(source)).toBe(expected) })

  it.each([
    ['live', 'open'], ['created', 'open'], ['active', 'open'], ['trigger', 'open'], ['in_progress', 'open'],
    ['accepted', 'open'], ['pending_new', 'open'], ['accepted_for_bidding', 'open'], ['pending_replace', 'open'], ['ApiPending', 'open'],
    ['partial_filled', 'partially_filled'], ['executed', 'filled'],
    ['cancel', 'cancelled'], ['deactivated', 'cancelled'], ['partiallyfilledcanceled', 'cancelled'], ['mmp_canceled', 'cancelled'],
    ['fail_execute', 'rejected'], ['failed', 'rejected'], ['order_failed', 'rejected'], ['denied', 'rejected'],
    ['EXPIRED_IN_MATCH', 'expired'], ['expire', 'expired'], ['not_triggered', 'untriggered'], ['pause', 'untriggered'],
  ])('maps the contracted status alias %s to %s', (source, expected) => { expect(mapVenueStatus(source)).toBe(expected) })

  it.each(['FINISHED', 'finished', 'effective', 'partially_effective', 'replaced', 'done_for_day', 'stopped', 'suspended', 'calculated', 'held', 'triggering'])('%s remains unknown without venue context', (source) => {
    expect(mapVenueStatus(source)).toBeUndefined()
  })

  it('logs an unknown status once per venue/status and never guesses open', async () => {
    const clock = new FakeClock(), messages: string[] = [], bus = new ConnectorBus(clock, (message) => messages.push(message)), venue = new FakeConnector({ id: 'kernel-sim', clock })
    bus.register(venue)
    vi.spyOn(venue, 'orderStatus').mockResolvedValue({ found: true, status: 'futureStatus', venueOrderId: 'future-order' })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const account = { accountId: 'acct_test', mode: 'paper', venue: 'hyperliquid', owner: {} } as never
    try {
      expect(await bus.lookup(account, 'a'.repeat(32))).toBeNull()
      expect(await bus.lookup(account, 'a'.repeat(32))).toBeNull()
      expect(messages).toHaveLength(1)
      expect(messages[0]).toMatch(/^warning:/)
      expect(warn).not.toHaveBeenCalled()
    } finally { warn.mockRestore(); await bus.close() }
  })

  it('does not emit an unknown status to console when no logger is configured', async () => {
    const clock = new FakeClock(), bus = new ConnectorBus(clock), venue = new FakeConnector({ id: 'kernel-sim', clock })
    bus.register(venue)
    vi.spyOn(venue, 'orderStatus').mockResolvedValue({ found: true, status: 'futureStatus' })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const account = { accountId: 'acct_test', mode: 'paper', venue: 'hyperliquid', owner: {} } as never
    try {
      expect(await bus.lookup(account, 'b'.repeat(32))).toBeNull()
      expect(warn).not.toHaveBeenCalled()
    } finally { warn.mockRestore(); await bus.close() }
  })
})
