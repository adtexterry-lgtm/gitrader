// SPDX-License-Identifier: CPAL-1.0
import { describe, expect, it, vi } from 'vitest'
import { asDecimal, type AccountId, type Decimal, type GateTicket, type GateInput, type OrderIntent } from '@gitrader/protocol'
import type { TradeContext } from '@gitrader/protocol/connector'
import type { SubmitResult } from '@gitrader/protocol/connector'
import { normalizeIntent } from '../src/normalize'
import * as dec from '../src/util/dec'
import * as reservationModule from '../src/risk-gate/reservations'
import { ReservationBook } from '../src/risk-gate/reservations'
import { FakeClock } from '../src/util/clock'
import { ConnectorBus } from '../src/connector'
import { GateTicketAuthority } from '../src/risk-gate/tickets'
import type { Account } from '../src/proto'
import type { Signer } from '../src/keystore'
import { FakeConnector, BTC } from './helpers/fake-connector'
import { makeHarness } from './helpers/harness'
import type { NormalizedIntent } from '../src/connector'
import type { AccountSnapshot as KernelSnapshot } from '../src/connector'
import { loadGateConformanceCases } from '../../protocol/conformance/risk-gate/load'
import type { RiskPolicy } from '@gitrader/protocol'
import { RiskGate, RiskService } from '../src/risk'
import type { TradingStateService } from '../src/trading-state'

const decimal = (value: string): Decimal => asDecimal(value)
const sourceAccount: Account = { accountId: 'acct_runtime' as AccountId, alias: 'runtime', orgId: 'org_runtime' as Account['orgId'], groupIds: [], venue: 'hyperliquid', environment: 'testnet', mode: 'paper', owner: {}, accountModel: 'standard', signer: { type: 'none', credentialRef: 'runtime', permissions: { trade: true, withdraw: 'unknown' } }, paper: { initialBalance: decimal('10000'), ccy: 'USD' }, status: 'active' }
const ticket = (expiresAt: number): GateTicket => ({ ticketId: 'tk_runtime', precheckId: 'pck_runtime', bootId: 'boot_runtime', accountId: sourceAccount.accountId, action: 'open', targetDigest: 'sha256:test', issuedAt: 1, expiresAt, sig: 'test' })
const gateOrder: NormalizedIntent = { accountId: sourceAccount.accountId, instrumentId: BTC, side: 'buy', type: 'limit', size: decimal('1'), price: decimal('10'), tif: 'gtc', clientOrderId: '0123456789abcdef0123456789abcdef' }
const testSigner: Signer = { walletId: 'wallet', address: `0x${'11'.repeat(20)}`, signTypedData: async () => '0x1234' }
const signingPayload = { domain: { name: 'x', version: '1', chainId: 1, verifyingContract: `0x${'00'.repeat(20)}` as never }, types: {}, primaryType: 'X', message: {} }
const fakeAuthority = { consume(value: GateTicket | undefined): NonNullable<TradeContext['gate']> { if (!value) throw new Error('missing fixture ticket'); return { precheckId: value.precheckId, ticketId: value.ticketId, expiresAt: value.expiresAt } } } as unknown as GateTicketAuthority

describe('risk gate bounded runtime helpers', () => {
  it('rounds internal margin budgets upward while retaining 18-place estimate division', () => {
    const helpers = reservationModule as unknown as { budgetMargin?: (numerator: dec.Dec, denominator: dec.Dec) => string }
    expect(helpers.budgetMargin).toBeTypeOf('function')
    expect(helpers.budgetMargin!(dec.D('1'), dec.D('3'))).toBe('0.333333333333333334')
    expect(dec.str(dec.div(dec.D('1'), dec.D('3'), 18))).toBe('0.333333333333333333')
  })

  it('keeps local and cached partial margin prorating conservative', () => {
    const helpers = reservationModule as unknown as { budgetMargin?: (numerator: dec.Dec, denominator: dec.Dec) => string }
    expect(helpers.budgetMargin).toBeTypeOf('function')
    const book = new ReservationBook()
    book.reserve({ accountId: sourceAccount.accountId, clientOrderId: 'partial', instrumentId: BTC, side: 'buy', size: decimal('3'), margin: decimal('1'), notional: decimal('3'), issuedAt: 1, expiresAt: 10_000, supportsExpiry: false, reduceOnly: false })
    book.outcome(sourceAccount.accountId, 'partial', { status: 'partially_filled', filledSize: decimal('2') })
    const remainingMargin = dec.D(book.view(sourceAccount.accountId, 2, 0).account.margin)
    expect(dec.str(remainingMargin)).toBe('0.333333333333333334')
    expect(dec.cmp(dec.mul(remainingMargin, dec.D('3')), dec.D('1'))).toBeGreaterThanOrEqual(0)

    const external = new ReservationBook()
    external.reconcileReservations({ accountId: sourceAccount.accountId, now: 1, fresh: true, availableDeductsOpenOrders: false, openOrders: [{ venueOrderId: 'venue', clientOrderId: 'row', instrumentId: BTC, side: 'buy', remainingSize: decimal('3'), reduceOnly: false, notional: decimal('3'), margin: decimal('1') }] })
    external.reconcileReservations({ accountId: sourceAccount.accountId, now: 2, fresh: true, availableDeductsOpenOrders: false, openOrders: [{ venueOrderId: 'venue', clientOrderId: 'row', instrumentId: BTC, side: 'buy', remainingSize: decimal('1'), reduceOnly: false }] })
    expect(external.view(sourceAccount.accountId, 2, 0).account.margin).toBe('0.333333333333333334')
  })

  it('blocks the third 1/3 margin order after two worst-case reservations', () => {
    const helpers = reservationModule as unknown as { budgetMargin?: (numerator: dec.Dec, denominator: dec.Dec) => string }
    expect(helpers.budgetMargin).toBeTypeOf('function')
    const book = new ReservationBook()
    for (const id of ['first', 'second']) book.reserve({ accountId: sourceAccount.accountId, clientOrderId: id, instrumentId: BTC, side: 'buy', size: decimal('1'), margin: decimal(helpers.budgetMargin!(dec.D('1'), dec.D('3'))), notional: decimal('1'), issuedAt: 1, expiresAt: 10_000, supportsExpiry: false, reduceOnly: false })
    const reserved = book.view(sourceAccount.accountId, 2, 0)
    expect(reserved.account.margin).toBe('0.666666666666666668')
    const input = structuredClone(loadGateConformanceCases().find((fixture) => fixture.name === '17-limit-size')!.input) as GateInput
    input.account = { ...input.account, accountId: sourceAccount.accountId, mode: 'paper', groupIds: [] }
    input.actorClass = 'human'; input.originActorType = 'human'; input.path = 'direct'; input.action = 'open'; input.dryRun = true
    input.mandate = null; input.mandateIntegrity = { ok: true, problems: [] }
    input.policy = { ...input.policy!, limits: { maxSlippageBps: 50 } as RiskPolicy['limits'] }
    input.snapshot = { ...input.snapshot, equity: decimal('1000'), available: decimal('1'), positions: [], openOrders: [], stale: false }
    input.mark = { price: decimal('1'), ts: input.now, source: 'venue_mark' }
    input.instrument = { ...input.instrument!, contractSize: decimal('1'), maxLeverage: 3 }
    input.target = { kind: 'order', intent: { ...(input.target.kind === 'order' ? input.target.intent : gateOrder), side: 'buy', size: decimal('1'), price: decimal('1'), leverage: 3, reduceOnly: false } }
    input.reserved = reserved
    input.stats = { dailyNotional: decimal('0'), mandateDailyNotional: decimal('0'), ordersToday: 0, ordersLastMinute: 0, mandateOrdersToday: 0, mandateOrdersLastMinute: 0 }
    const risk = { signGateDigest: () => 'test-signature', current: () => input.policy, integrity: { ok: true, problems: [] } } as unknown as RiskService
    const decision = new RiskGate(risk, {} as TradingStateService).decide(input)
    expect(decision.decision).toBe('BLOCK')
    expect(decision.estimates.marginRequired).toBe('0.333333333333333333')
    expect(decision.ruleHits).toContainEqual(expect.objectContaining({ code: 'INSUFFICIENT_MARGIN', action: 'deny' }))
  })

  it('converts notional using price times contract size and checks actual notional', () => {
    const clock = new FakeClock(1_000)
    const connector = new FakeConnector({ id: 'kernel-sim', clock })
    const instrument = connector.getInstrument(BTC)!
    const common: OrderIntent = { accountId: sourceAccount.accountId, instrumentId: BTC, side: 'buy', type: 'limit', notional: decimal('1000'), price: decimal('100'), tif: 'gtc', clientOrderId: '0123456789abcdef0123456789abcdef' }
    const sized = normalizeIntent(common, { ...instrument, contractSize: decimal('10'), minNotional: decimal('1000') }, { mark: decimal('100'), defaultMaxSlippageBps: 50 })
    expect(sized.size).toBe('1')
    expect(() => normalizeIntent(common, { ...instrument, contractSize: decimal('10'), minNotional: decimal('1001') }, { mark: decimal('100'), defaultMaxSlippageBps: 50 })).toThrow()
    expect(normalizeIntent({ ...common, reduceOnly: true }, { ...instrument, contractSize: decimal('10'), minNotional: decimal('1001') }, { mark: decimal('100'), defaultMaxSlippageBps: 50 }).size).toBe('1')
  })

  it('bounds a ticket call, aborts its context, and closes saved signer handles', async () => {
    vi.useFakeTimers()
    const clock = new FakeClock(1_000)
    const connector = new FakeConnector({ id: 'kernel-sim', clock })
    const bus = new ConnectorBus(clock)
    bus.register(connector)
    bus.setGateAuthority(fakeAuthority)
    let saved: TradeContext | undefined
    connector.submit = async (ctx) => { saved = ctx; return new Promise(() => undefined) }
    const call = bus.submit(sourceAccount, gateOrder, { ticket: ticket(11_000), signer: testSigner })
    const timedOut = expect(call).rejects.toMatchObject({ problem: { code: 3006 } })
    await Promise.resolve(); await Promise.resolve()
    await vi.advanceTimersByTimeAsync(10_000)
    await timedOut
    expect(saved?.signal?.aborted).toBe(true)
    await expect(saved!.signer.signTypedData(signingPayload)).rejects.toMatchObject({ problem: { code: 2010 } })
  })

  it('rejects an expired ticket before connector invocation and permits multiple signatures in one valid call', async () => {
    const clock = new FakeClock(1_000)
    const connector = new FakeConnector({ id: 'kernel-sim', clock })
    const bus = new ConnectorBus(clock)
    bus.register(connector)
    bus.setGateAuthority(fakeAuthority)
    let saved: TradeContext | undefined
    let signatures = 0
    connector.submit = async (ctx, _intents): Promise<SubmitResult> => {
      saved = ctx
      await ctx.signer.signTypedData(signingPayload)
      await ctx.signer.signTypedData(signingPayload)
      return { acks: [{ intentIndex: 0, clientOrderId: gateOrder.clientOrderId, venueOrderId: 'venue', status: 'open', filledSize: decimal('0'), avgFillPrice: null, builder: { attached: false } }], receiptHash: 'receipt', requestWeight: 1 }
    }
    const signer: Signer = { ...testSigner, signTypedData: async () => { signatures++; return '0x1234' } }
    await expect(bus.submit(sourceAccount, gateOrder, { ticket: ticket(1_000), signer })).rejects.toMatchObject({ problem: { code: 2011 } })
    expect(saved).toBeUndefined()
    await bus.submit(sourceAccount, gateOrder, { ticket: ticket(31_000), signer })
    expect(signatures).toBe(2)
    expect(saved?.signal?.aborted).toBe(true)
    await expect(saved!.signer.signTypedData(signingPayload)).rejects.toMatchObject({ problem: { code: 2010 } })
  })

  it('returns a stale fallback at the read deadline and ignores a late snapshot completion', async () => {
    const h = await makeHarness()
    vi.useFakeTimers()
    try {
      const seams = h.k.trading as unknown as {
        normalize(account: Account, value: OrderIntent, ctx: ReturnType<typeof h.human>): NormalizedIntent
        collectGateData(account: Account, n: NormalizedIntent): Promise<{ snapshot: KernelSnapshot; mark?: unknown; openOrderValuations: Record<string, unknown>; valuedOpenOrders: unknown[] }>
      }
      const account = h.liveAcct
      const normalized = seams.normalize(account, { ...gateOrder, accountId: account.accountId }, h.human())
      const original = h.live.accountState.bind(h.live)
      let resolveLate!: (value: Awaited<ReturnType<typeof original>>) => void
      h.live.accountState = async () => new Promise((resolve) => { resolveLate = resolve })
      const pending = seams.collectGateData(account, normalized)
      await Promise.resolve(); await Promise.resolve()
      await vi.advanceTimersByTimeAsync(10_000)
      const timedOut = await pending
      expect(timedOut.snapshot.stale).toBe(true)
      expect(timedOut.mark).toBeUndefined()
      expect(timedOut.openOrderValuations).toEqual({})
      expect(timedOut.valuedOpenOrders).toEqual([])

      h.live.accountState = original
      const recovered = await seams.collectGateData(account, normalized)
      expect(recovered.snapshot.stale).not.toBe(true)
      const late = await original(h.k.bus.accountRef(account))
      resolveLate({ ...late, margin: { ...late.margin, equity: decimal('1') } })
      await Promise.resolve(); await Promise.resolve()

      h.live.accountState = async () => { throw new Error('snapshot unavailable') }
      const cached = await seams.collectGateData(account, normalized)
      expect(cached.snapshot.equity).toBe(recovered.snapshot.equity)
      expect(cached.snapshot.stale).toBe(true)
    } finally { vi.useRealTimers(); await h.cleanup() }
  })

  it('does not coalesce pending account snapshots across route environments', async () => {
    const h = await makeHarness()
    try {
      const original = h.live.accountState.bind(h.live)
      const resolvers: Array<(value: Awaited<ReturnType<typeof original>>) => void> = []
      let calls = 0
      h.live.accountState = async () => new Promise((resolve) => { calls++; resolvers.push(resolve) })
      const first = h.k.bus.snapshot(h.liveAcct)
      await Promise.resolve()
      const alternate = { ...h.liveAcct, environment: 'mainnet' as const }
      const second = h.k.bus.snapshot(alternate)
      await Promise.resolve()
      expect(calls).toBe(2)
      const [firstValue, secondValue] = await Promise.all([original(h.k.bus.accountRef(h.liveAcct)), original(h.k.bus.accountRef(alternate))])
      resolvers[0]!(firstValue); resolvers[1]!(secondValue)
      await Promise.all([first, second])
    } finally { await h.cleanup() }
  })

  it('uses worst-case margin budget for locally leveraged visible orders', async () => {
    const h = await makeHarness()
    try {
      const account = h.paper
      const cloid = 'local-margin-order'
      h.k.orders.upsert({ orderId: 'local-order' as never, clientOrderId: cloid as never, accountId: account.accountId, instrumentId: BTC as never, side: 'buy', type: 'limit', tif: 'gtc', size: '1' as never, filledSize: '0' as never, price: '1' as never, leverage: 3, status: 'open', fee: '0' as never, origin: { actor: 'user:usr_local', tool: 'test', via: 'ui', requestId: 'req-runtime' } as never, createdAt: h.clock.now(), updatedAt: h.clock.now() }, '1', true)
      h.sim.orders.push({ venueOrderId: 'local-venue-order', clientOrderId: cloid, accountId: account.accountId, instrumentId: BTC, side: 'buy', type: 'limit', size: '1', price: '1', reduceOnly: false, isTrigger: false, status: 'open', createdAt: h.clock.now() })
      const seams = h.k.trading as unknown as { normalize(account: Account, value: OrderIntent, ctx: ReturnType<typeof h.human>): NormalizedIntent; collectGateData(account: Account, n: NormalizedIntent): Promise<{ valuedOpenOrders: Array<{ margin?: Decimal }> }> }
      const normalized = seams.normalize(account, { ...gateOrder, accountId: account.accountId }, h.human())
      const data = await seams.collectGateData(account, normalized)
      expect(data.valuedOpenOrders[0]?.margin).toBe('0.333333333333333334')
    } finally { await h.cleanup() }
  })
})
