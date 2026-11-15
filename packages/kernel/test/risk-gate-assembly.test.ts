// SPDX-License-Identifier: CPAL-1.0
import { describe, expect, it } from 'vitest'
import { KernelError } from '../src/util/errors'
import { makeHarness } from './helpers/harness'
import { makeAgent } from './helpers/harness'
import { BTC, ETH } from './helpers/fake-connector'
import { ReservationBook } from '../src/risk-gate/reservations'
import { digestOf } from '../src/util/hash'
import { assembleGateInput, gateTargetDigest } from '../src/risk-gate/assemble'
import type { GateTarget } from '@gitrader/protocol'
import { mkOrigin } from '../src/util/origin'
import { newClientOrderId } from '../src/util/ids'
import type { ActorCtx } from '../src/trading'
import type { AccountSnapshot, MarkPrice, NormalizedIntent } from '../src/connector'
import type { Account, Decimal, GateDecision, GateInput, GroupId, Mandate, OrderIntent } from '@gitrader/protocol'
import { asDecimal } from '@gitrader/protocol'
import type { ValuedOpenOrder } from '../src/risk-gate/reservations'

type Collected = { routeKey: string; snapshot: AccountSnapshot; mark?: MarkPrice; openOrderValuations: Record<string, { contractSize: Decimal; mark?: Decimal }>; valuedOpenOrders: ValuedOpenOrder[] }
type TradingSeams = {
  normalize(account: Account, intent: OrderIntent, ctx: ActorCtx): NormalizedIntent
  collectGateData(account: Account, n: NormalizedIntent): Promise<Collected>
  assembleOrderGate(data: Collected, account: Account, n: NormalizedIntent, ctx: ActorCtx, path: 'direct', book: ReservationBook, dryRun: boolean, commitState: boolean): { account: Account; input: GateInput; precheck: GateDecision }
  mintToken(n: NormalizedIntent, authorIntent: NormalizedIntent, pc: GateDecision, mandate: Mandate | null, ctx: ActorCtx, expiresAt: number): string
  writePrecheckLedger(account: Account, n: NormalizedIntent, pc: GateDecision, ctx: ActorCtx, mandate: Mandate | null, extra?: object): void
}

const decimal = (value: string): Decimal => asDecimal(value)
const intent = (accountId: Account['accountId'], extra: Partial<OrderIntent> = {}): OrderIntent => ({
  accountId, instrumentId: BTC, side: 'buy', type: 'limit', size: decimal('0.01'), price: decimal('80000'), tif: 'gtc', ...extra,
})

describe('order gate data assembly', () => {
  it('rejects order and leverage gate targets without instrument metadata', async () => {
    const h = await makeHarness()
    try {
      const snapshot = await h.k.bus.snapshot(h.paper)
      const args: Parameters<typeof assembleGateInput>[0] = { target: { kind: 'order', intent: { ...intent(h.paper.accountId), size: decimal('0.01'), tif: 'gtc', clientOrderId: newClientOrderId() } }, action: 'open', account: h.paper, snapshot, policy: null, policyIntegrity: { ok: true, problems: [] }, mandateIntegrity: { ok: true, problems: [] }, states: [], stats: { dailyNotional: decimal('0'), mandateDailyNotional: decimal('0'), ordersLastMinute: 0, mandateOrdersLastMinute: 0, ordersToday: 0, mandateOrdersToday: 0 }, path: 'direct', actorType: 'human', now: h.clock.now(), precheckId: 'pck_missing_inst', dryRun: true }
      expect(() => assembleGateInput(args)).toThrow(/instrument/i)
    } finally { await h.cleanup() }
  })
  it('keeps dry precheck from writing day baseline, equity samples, ledger, or reservations', async () => {
    const h = await makeHarness()
    try {
      let equityCalls = 0
      const onEquity = h.k.protectors.onEquity.bind(h.k.protectors)
      h.k.protectors.onEquity = (...args) => { equityCalls++; onEquity(...args) }
      const beforeHead = h.k.ledger.head().seq
      const book = (h.k.trading as unknown as { reservations: ReservationBook }).reservations
      book.reserve({ accountId: h.paper.accountId, clientOrderId: 'reduce-local', instrumentId: BTC, side: 'sell', size: decimal('1'), margin: decimal('0'), notional: decimal('0'), issuedAt: h.clock.now(), expiresAt: h.clock.now() + 10_000, supportsExpiry: false, reduceOnly: true })
      const beforeBook = { reduction: book.reductionSize(h.paper.accountId, BTC, 'sell'), view: book.view(h.paper.accountId, h.clock.now(), 0), complete: book.complete(h.paper.accountId) }
      const result = await h.k.trading.precheckIntent(intent(h.paper.accountId), h.human())
      expect(result.decision).toMatch(/ALLOW|LIMIT|BLOCK/)
      expect(h.k.docs.get('day', h.paper.accountId)).toBeUndefined()
      expect(equityCalls).toBe(0)
      expect(h.k.ledger.head().seq).toBe(beforeHead)
      expect({ reduction: book.reductionSize(h.paper.accountId, BTC, 'sell'), view: book.view(h.paper.accountId, h.clock.now(), 0), complete: book.complete(h.paper.accountId) }).toEqual(beforeBook)
    } finally { await h.cleanup() }
  })

  it('writes a preview ledger payload that preserves full gate and snapshot digests', async () => {
    const h = await makeHarness()
    try {
      const preview = await h.k.trading.preview(intent(h.paper.accountId), h.human())
      const entry = h.k.ledger.query({ types: ['risk.precheck'] }).at(-1)!
      const payload = entry.payload as { gate?: { decision?: { snapshotDigest?: string }; snapshot?: unknown; target?: unknown }; timing?: unknown; intent?: unknown }
      const gate = payload.gate as { decision: typeof preview.precheck; snapshot: unknown; target: typeof preview.normalizedIntent }
      expect(gate.decision.snapshotDigest).toBe(digestOf(gate.snapshot))
      expect(gate.decision.targetDigest).toBe(gateTargetDigest(gate.target as unknown as GateTarget))
      expect(payload.timing).toEqual(expect.objectContaining({ assembleUs: expect.any(Number), decideUs: expect.any(Number), protectorUs: 0 }))
      expect(Object.keys(payload.timing as object).sort()).toEqual(['assembleUs', 'decideUs', 'protectorUs'])
      expect(payload.intent).toEqual(preview.normalizedIntent)
    } finally { await h.cleanup() }
  })

  it('includes group-scoped HALTED state in current order gate evaluation', async () => {
    const h = await makeHarness()
    try {
      h.paper.groupIds.push('grp_assembly')
      h.k.tstate.set({ type: 'group', id: 'grp_assembly' }, 'HALTED', 'group stop', h.human().origin)
      const result = await h.k.trading.precheckIntent(intent(h.paper.accountId), h.human())
      expect(result.verdict).toBe('deny')
      expect(result.ruleHits).toContainEqual(expect.objectContaining({ code: 'TRADING_STATE' }))
    } finally { await h.cleanup() }
  })

  it('fails stale open and reduction orders closed after snapshot failure', async () => {
    const h = await makeHarness()
    try {
      h.k.bus.snapshot = async () => { throw new Error('simulated read failure') }
      const open = await h.k.trading.precheckIntent(intent(h.paper.accountId), h.human())
      expect(open.decision).toBe('BLOCK')
      expect(open.ruleHits).toContainEqual(expect.objectContaining({ code: 'ACCOUNT_UNKNOWN', action: 'deny' }))
      const reduce = await h.k.trading.precheckIntent(intent(h.paper.accountId, { side: 'sell', reduceOnly: true }), h.human())
      expect(reduce.verdict).toBe('deny')
      expect(reduce.decision).toBe('BLOCK')
      expect(reduce.ruleHits).toContainEqual(expect.objectContaining({ code: 'ACCOUNT_UNKNOWN', action: 'deny' }))
      expect(h.sim.submitted).toHaveLength(0)
    } finally { await h.cleanup() }
  })

  it('records inferred reduction normalization beside the unchanged submitted intent', async () => {
    const h = await makeHarness()
    try {
      h.sim.positions.set(h.paper.accountId, [{ accountId: h.paper.accountId, instrumentId: BTC, side: 'long', size: decimal('1'), entryPrice: decimal('80000'), markPrice: decimal('80000'), notional: decimal('80000'), unrealizedPnl: decimal('0'), realizedPnl: decimal('0'), leverage: 2, marginMode: 'cross', liquidationPrice: null, fundingSinceOpen: decimal('0'), openedAt: 0, updatedAt: 0 }])
      const raw = intent(h.paper.accountId, { side: 'sell', size: decimal('0.5'), leverage: 3 })
      const preview = await h.k.trading.preview(raw, h.human())
      expect(preview.normalizedIntent.reduceOnly).toBe(true)
      expect(preview.normalizedIntent.leverage).toBeUndefined()
      const entry = h.k.ledger.query({ types: ['risk.precheck'] }).at(-1)!
      const payload = entry.payload as { normalization?: { warnings?: Array<{ code: string; ruleId: string }>; originalTargetDigest?: string }; intent?: Record<string, unknown> }
      expect(payload.normalization?.warnings).toContainEqual(expect.objectContaining({ code: 'LEVERAGE', ruleId: 'gate#reduceLeverage' }))
      expect(payload.intent).toMatchObject({ reduceOnly: true })
      expect(raw.reduceOnly).toBeUndefined()
      expect(payload.normalization?.originalTargetDigest).toBeDefined()
      expect(preview.precheck.targetDigest).not.toBe(payload.normalization?.originalTargetDigest)
    } finally { await h.cleanup() }
  })

  it('fails open closed when another instrument open order cannot be valued', async () => {
    const h = await makeHarness()
    try {
      const instrument = h.k.bus.instrument.bind(h.k.bus)
      h.k.bus.instrument = (id) => id === ETH ? undefined : instrument(id)
      h.sim.orders.push({ venueOrderId: 'venue-order', clientOrderId: 'cl-order', accountId: h.paper.accountId, instrumentId: ETH, side: 'buy', type: 'limit', size: '1', price: null, reduceOnly: false, isTrigger: false, status: 'open', createdAt: h.clock.now() })
      const original = h.sim.accountState.bind(h.sim)
      h.sim.accountState = async (ref) => ({ ...(await original(ref)), openOrders: undefined }) as never
      const open = await h.k.trading.precheckIntent(intent(h.paper.accountId), h.human())
      expect(open.verdict).toBe('deny')
      expect(open.ruleHits).toContainEqual(expect.objectContaining({ code: 'ACCOUNT_UNKNOWN' }))
    } finally { await h.cleanup() }
  })

  it('uses policy and group state read after delayed venue data returns', async () => {
    const h = await makeHarness()
    try {
      const originalAccount = h.k.accounts.get.bind(h.k.accounts)
      const read = h.k.bus.snapshot.bind(h.k.bus)
      let release!: () => void
      const gate = new Promise<void>((resolve) => { release = resolve })
      h.k.bus.snapshot = async (account, options) => { await gate; return read(account, options) }
      const pending = h.k.trading.precheckIntent(intent(h.paper.accountId), h.human())
      await Promise.resolve()
      const current = originalAccount(h.paper.accountId)
      const replacement: Account = { ...current, groupIds: ['grp_delayed' as GroupId] }
      h.k.accounts.get = (id) => id === h.paper.accountId ? replacement : originalAccount(id)
      h.k.tstate.set({ type: 'group', id: 'grp_delayed' }, 'HALTED', 'changed during read', h.human().origin)
      release()
      const result = await pending
      expect(result.verdict).toBe('deny')
      expect(result.ruleHits).toContainEqual(expect.objectContaining({ code: 'TRADING_STATE' }))
    } finally { await h.cleanup() }
  })

  it('lets reduce-only classification escape reduce-only instrument admission but rejects an open', async () => {
    const h = await makeHarness()
    try {
      const instrument = h.k.bus.instrument.bind(h.k.bus)
      h.k.bus.instrument = (id) => { const found = instrument(id); return id === BTC && found ? { ...found, status: 'reduce_only' } : found }
      await expect(h.k.trading.precheckIntent(intent(h.paper.accountId), h.human())).rejects.toBeInstanceOf(KernelError)
      h.sim.positions.set(h.paper.accountId, [{ accountId: h.paper.accountId, instrumentId: BTC, side: 'long', size: decimal('1'), entryPrice: decimal('80000'), markPrice: decimal('80000'), notional: decimal('80000'), unrealizedPnl: decimal('0'), realizedPnl: decimal('0'), leverage: 2, marginMode: 'cross', liquidationPrice: null, fundingSinceOpen: decimal('0'), openedAt: 0, updatedAt: 0 }])
      const reduce = await h.k.trading.precheckIntent(intent(h.paper.accountId, { side: 'sell', size: decimal('0.5') }), h.human())
      expect(reduce.action).toBe('reduce')
    } finally { await h.cleanup() }
  })

  it('reconciles external reductions before inferring a new target action', async () => {
    const h = await makeHarness()
    try {
      h.sim.positions.set(h.paper.accountId, [{ accountId: h.paper.accountId, instrumentId: BTC, side: 'long', size: decimal('3'), entryPrice: decimal('100'), markPrice: decimal('100'), notional: decimal('300'), unrealizedPnl: decimal('0'), realizedPnl: decimal('0'), leverage: 2, marginMode: 'cross', liquidationPrice: null, fundingSinceOpen: decimal('0'), openedAt: 0, updatedAt: 0 }])
      h.sim.orders.push({ venueOrderId: 'reduce-venue', clientOrderId: 'reduce-client', accountId: h.paper.accountId, instrumentId: BTC, side: 'sell', type: 'market', size: '2', price: null, reduceOnly: true, isTrigger: false, status: 'open', createdAt: h.clock.now() })
      let input: import('@gitrader/protocol').GateInput | undefined
      const decide = h.k.gate.decide.bind(h.k.gate)
      h.k.gate.decide = (value) => { input = value; return decide(value) }
      await h.k.trading.precheckIntent(intent(h.paper.accountId, { side: 'sell', size: decimal('2') }), h.human())
      expect(input?.action).toBe('open')
      expect(input?.target.kind === 'order' && input.target.intent.reduceOnly).not.toBe(true)
      h.sim.orders = []
      await h.k.trading.precheckIntent(intent(h.paper.accountId, { side: 'sell', size: decimal('2') }), h.human())
      expect(input?.action).toBe('reduce')
    } finally { await h.cleanup() }
  })

  it('rechecks mandate integrity before resolving its effective level', async () => {
    const h = await makeHarness()
    try {
      const agent = await makeAgent(h, 'auto_limited')
      await h.k.trading.precheckIntent(intent(h.paper.accountId, { reason: 'review' }), agent.ctx())
      const tampered = { ...agent.mandate, attestation: { ...agent.mandate.attestation, sig: 'invalid-signature' } }
      h.k.docs.put('mandate', agent.mandate.mandateId, tampered, agent.mandate.version)
      let input: import('@gitrader/protocol').GateInput | undefined
      const decide = h.k.gate.decide.bind(h.k.gate)
      h.k.gate.decide = (value) => { input = value; return decide(value) }
      const result = await h.k.trading.precheckIntent(intent(h.paper.accountId, { reason: 'review' }), agent.ctx())
      expect(input?.mandate?.level).toBe('L0')
      expect(input?.mandateIntegrity.ok).toBe(false)
      expect(result.allowedActions.open).toBe(false)
    } finally { await h.cleanup() }
  })

  it('uses only own-priced foreign orders and does not borrow another account leverage', async () => {
    const h = await makeHarness()
    try {
      const cloid = 'cross-account-client'
      h.k.orders.upsert({ orderId: 'foreign-order' as never, clientOrderId: cloid as never, accountId: h.liveAcct.accountId, instrumentId: ETH as never, side: 'buy', type: 'limit', tif: 'gtc', size: '2' as never, filledSize: '0' as never, price: '12' as never, leverage: 4, status: 'open', fee: '0' as never, origin: mkOrigin('user:test', 'test', 'ui'), createdAt: h.clock.now(), updatedAt: h.clock.now() }, '24', true)
      h.sim.orders.push({ venueOrderId: 'foreign-venue-row', clientOrderId: cloid, accountId: h.paper.accountId, instrumentId: ETH, side: 'buy', type: 'limit', size: '2', price: '12', reduceOnly: false, isTrigger: false, status: 'open', createdAt: h.clock.now() })
      const marks: string[] = []
      const gateMark = h.k.bus.gateMark.bind(h.k.bus)
      h.k.bus.gateMark = async (id) => { marks.push(id); return gateMark(id) }
      let input: import('@gitrader/protocol').GateInput | undefined
      const decide = h.k.gate.decide.bind(h.k.gate)
      h.k.gate.decide = (value) => { input = value; return decide(value) }
      await h.k.trading.precheckIntent(intent(h.paper.accountId), h.human())
      expect(marks).toEqual([BTC])
      expect(input?.reserved.account.margin).toBe('24')
    } finally { await h.cleanup() }
  })

  it('does not persist a failed neutral snapshot as day baseline when committing state', async () => {
    const h = await makeHarness()
    try {
      h.k.bus.snapshot = async () => { throw new Error('read unavailable') }
      const ctx = h.human()
      const account = h.k.accounts.get(h.paper.accountId)
      const submitted = intent(h.paper.accountId, { side: 'sell', size: decimal('0.5'), reduceOnly: true })
      const seams = h.k.trading as unknown as TradingSeams
      const normalized = seams.normalize(account, submitted, ctx)
      const data = await seams.collectGateData(account, normalized)
      let equityCalls = 0
      const onEquity = h.k.protectors.onEquity.bind(h.k.protectors)
      h.k.protectors.onEquity = (...args) => { equityCalls++; onEquity(...args) }
      const result = seams.assembleOrderGate(data, account, normalized, ctx, 'direct', new ReservationBook(), true, true)
      expect(result.precheck.verdict).toBe('deny')
      expect(result.precheck.decision).toBe('BLOCK')
      expect(result.precheck.ruleHits).toContainEqual(expect.objectContaining({ code: 'ACCOUNT_UNKNOWN', action: 'deny' }))
      expect(h.k.docs.get('day', h.paper.accountId)).toBeUndefined()
      expect(equityCalls).toBe(0)
    } finally { await h.cleanup() }
  })

  it('uses the mandate resolved after venue reads for preview writing and token minting', async () => {
    const h = await makeHarness()
    try {
      const agent = await makeAgent(h, 'auto_limited')
      const refreshed = { ...agent.mandate, level: 'L2' as const }
      let effectiveCalls = 0
      h.k.agents.effective = () => ++effectiveCalls === 1 ? agent.mandate : refreshed
      h.k.agents.verifyMandate = () => true
      const seams = h.k.trading as unknown as TradingSeams
      const mint = seams.mintToken.bind(h.k.trading)
      let mintedWith: Mandate | null | undefined
      seams.mintToken = (n, authorIntent, pc, mandate, ctx, expiresAt) => { mintedWith = mandate; return mint(n, authorIntent, pc, mandate, ctx, expiresAt) }
      const write = seams.writePrecheckLedger.bind(h.k.trading)
      let writtenWith: Mandate | null | undefined
      seams.writePrecheckLedger = (account, n, pc, ctx, mandate, extra) => { writtenWith = mandate; write(account, n, pc, ctx, mandate, extra) }
      const preview = await h.k.trading.preview(intent(h.paper.accountId, { size: decimal('0.001'), reason: 'current mandate' }), agent.ctx())
      expect(effectiveCalls).toBe(2)
      expect(writtenWith?.level).toBe('L2')
      expect(mintedWith?.level).toBe('L2')
      expect(preview.precheck.mandateRef?.effectiveLevel).toBe('L2')
    } finally { await h.cleanup() }
  })

  it('rejects a collected snapshot if account routing changes before synchronous assembly', async () => {
    const h = await makeHarness()
    try {
      const originalGet = h.k.accounts.get.bind(h.k.accounts)
      const registry = h.k.accounts as unknown as { get(id: string): Account }
      let changed = false
      registry.get = (id) => changed ? { ...originalGet(id), mode: 'live' } as Account : originalGet(id)
      const originalSnapshot = h.k.bus.snapshot.bind(h.k.bus)
      let started!: () => void
      let release!: () => void
      const startedWaiter = new Promise<void>((resolve) => { started = resolve })
      const readBarrier = new Promise<void>((resolve) => { release = resolve })
      let delayed = false
      h.k.bus.snapshot = async (account, options) => {
        if (!delayed) { delayed = true; started(); await readBarrier }
        return originalSnapshot(account, options)
      }
      const pending = h.k.trading.place({ intent: intent(h.paper.accountId, { reason: 'route boundary' }) }, h.human())
      await startedWaiter
      changed = true
      release()
      await expect(pending).rejects.toMatchObject({ problem: { name: 'STALE_PRICE' } })
      h.k.bus.snapshot = originalSnapshot
      expect(h.sim.submitted).toHaveLength(0)
      expect(h.live.submitted).toHaveLength(0)
      const next = await h.k.trading.precheckIntent(intent(h.paper.accountId, { reason: 'fresh route' }), h.human())
      expect(next.ruleHits.some((hit) => hit.code === 'ACCOUNT_UNKNOWN')).toBe(false)
    } finally { await h.cleanup() }
  })

  it('pins the refreshed account route object used by the assembled decision', async () => {
    const h = await makeHarness()
    try {
      const account = h.k.accounts.get(h.paper.accountId)
      const ctx = h.human()
      const seams = h.k.trading as unknown as TradingSeams
      const normalized = seams.normalize(account, intent(account.accountId), ctx)
      const data = await seams.collectGateData(account, normalized)
      const assembled = seams.assembleOrderGate(data, account, normalized, ctx, 'direct', new ReservationBook(), false, false)
      account.mode = 'live'
      account.venue = 'changed-venue' as never
      expect(assembled.account.mode).toBe('paper')
      expect(assembled.account.venue).toBe('hyperliquid')
    } finally { await h.cleanup() }
  })
})
