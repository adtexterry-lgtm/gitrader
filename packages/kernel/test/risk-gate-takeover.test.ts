// SPDX-License-Identifier: CPAL-1.0
import { afterEach, describe, expect, it } from 'vitest'
import { asDecimal } from '@gitrader/protocol'
import type { Position } from '@gitrader/protocol'
import type { StartupSnapshot } from '@gitrader/protocol/connector'
import type { Harness } from './helpers/harness'
import { makeAgent, makeHarness } from './helpers/harness'
import { BTC } from './helpers/fake-connector'
import { mkOrigin } from '../src/util/origin'
import { newClientOrderId } from '../src/util/ids'
import type { OrderIntent, Origin } from '../src/proto'
import { makeProblem } from '../src/proto'
import type { ActorCtx } from '../src/trading'
import { VenueDeadman } from '../src/takeover'
import { enableLive } from './helpers/harness'
import { ORG_SCOPE } from '../src/trading-state'
import { KernelError } from '../src/util/errors'

let h: Harness | undefined
afterEach(async () => { await h?.cleanup() })

const intent = (accountId: string): OrderIntent => ({ accountId: accountId as never, instrumentId: BTC, side: 'buy', type: 'limit', size: asDecimal('0.001'), price: asDecimal('80000'), tif: 'gtc', clientOrderId: newClientOrderId() })

async function freshRemote(harness: Harness, positions?: Position[]): Promise<StartupSnapshot> {
  const ref = harness.k.bus.accountRef(harness.paper), account = await harness.sim.accountState(ref)
  return { account: { ...account, stale: false, ...(positions ? { positions } : {}) }, openOrders: await harness.sim.openOrders(ref), fills: [], fillsSince: harness.clock.now() - 86_400_000, truncated: false }
}

describe('ticketed takeover', () => {
  it('halts and trips deadman before cancelling every account, preserving the first remote failure', async () => {
    h = await makeHarness({ kernel: { sleep: async () => undefined } })
    await enableLive(h)
    const harness = h
    const paperOrder = await h.k.trading.place({ intent: intent(h.paper.accountId) }, h.human())
    const liveOrder = await h.k.trading.place({ intent: { ...intent(h.liveAcct.accountId), clientOrderId: newClientOrderId() } }, h.human())
    h.sim.orders.push({ venueOrderId: 'venue_kill_sl', clientOrderId: 'cl_kill_sl', accountId: h.paper.accountId, instrumentId: BTC, side: 'sell', type: 'stop_market', size: '0.001', price: null, reduceOnly: true, isTrigger: true, status: 'open', createdAt: h.clock.now() })
    h.sim.accountSnapshotOverrides = { stale: true }
    h.sim.openOrdersOverride = undefined
    h.sim.startupResponseSequence = [new Error('paper remote view failed')]
    let haltedBeforePaperCancel = false
    const cancel = h.sim.cancel.bind(h.sim)
    h.sim.cancel = async (ctx, targets) => {
      haltedBeforePaperCancel = harness.k.tstate.get(ORG_SCOPE) === 'HALTED' && harness.live.scheduleGateCalls.some((row) => row.ctxGate?.ticketId)
      return cancel(ctx, targets)
    }
    const ctx: ActorCtx = { principal: { kind: 'service' }, origin: mkOrigin('system:kernel', 'kill.sequence', 'internal') }

    await expect(h.k.takeover.kill('ordered kill', ctx)).rejects.toMatchObject({ problem: { message: 'paper remote view failed' } })
    expect(haltedBeforePaperCancel).toBe(true)
    expect(h.k.tstate.get(ORG_SCOPE)).toBe('HALTED')
    expect(h.k.orders.get(paperOrder.order!.orderId)?.status).toBe('cancelled')
    expect(h.sim.orders.find((order) => order.clientOrderId === 'cl_kill_sl')?.status).toBe('open')
    expect(h.k.orders.get(liveOrder.order!.orderId)?.status).toBe('cancelled')
    const failures = [...h.k.ledger.iterate()].filter((entry) => entry.type === 'takeover.failed')
    expect(failures.some((entry) => (entry.payload as { phase?: string }).phase === 'cancel_all')).toBe(true)
    expect(failures.some((entry) => (entry.subject as { accountId?: string }).accountId === h!.paper.accountId && (entry.payload as { error?: { message?: string } }).error?.message === 'paper remote view failed')).toBe(true)
    expect([...h.k.ledger.iterate()].some((entry) => entry.type === 'takeover.completed')).toBe(false)
  })

  it('human kill uses explicit full cancellation fallback and leaves the org halted', async () => {
    h = await makeHarness()
    await enableLive(h)
    const ordinary = await h.k.trading.place({ intent: intent(h.paper.accountId) }, h.human())
    h.sim.orders.push({ venueOrderId: 'venue_kill_full_sl', clientOrderId: 'cl_kill_full_sl', accountId: h.paper.accountId, instrumentId: BTC, side: 'sell', type: 'stop_market', size: '0.001', price: null, reduceOnly: true, isTrigger: true, status: 'open', createdAt: h.clock.now() })
    h.sim.accountSnapshotOverrides = { stale: true }
    h.sim.openOrdersOverride = undefined
    h.sim.startupResponseSequence = [new Error('paper remote view failed')]

    const result = await h.k.takeover.kill('manual kill', h.human('kill'))
    expect(result.stateAfter).toBe('HALTED')
    expect(h.k.tstate.get(ORG_SCOPE)).toBe('HALTED')
    expect(h.sim.cancelAllCalls).toHaveLength(1)
    expect(h.k.orders.get(ordinary.order!.orderId)?.status).toBe('cancelled')
    expect(h.sim.orders.find((order) => order.clientOrderId === 'cl_kill_full_sl')?.status).toBe('cancelled')
    const cancelEntry = [...h.k.ledger.iterate()].reverse().find((entry) => entry.type === 'order.cancelled' && (entry.payload as { viewFailure?: unknown }).viewFailure)
    expect(cancelEntry?.payload).toMatchObject({ viewFailure: { problem: { message: 'paper remote view failed' } } })
  })

  it('continues deadman trip and cancellation across two live accounts after the first trip fails', async () => {
    h = await makeHarness({ kernel: { sleep: async () => undefined } })
    await enableLive(h)
    Object.assign(h.paper, { mode: 'live', venue: h.liveAcct.venue, environment: h.liveAcct.environment, signer: structuredClone(h.liveAcct.signer), status: 'active' })
    h.live.orders.push(
      { venueOrderId: 'venue_bad_live', clientOrderId: 'cl_bad_live', accountId: h.paper.accountId, instrumentId: BTC, side: 'buy', type: 'limit', size: '0.001', price: '80000', reduceOnly: false, isTrigger: false, status: 'open', createdAt: h.clock.now() },
      { venueOrderId: 'venue_good_live', clientOrderId: 'cl_good_live', accountId: h.liveAcct.accountId, instrumentId: BTC, side: 'buy', type: 'limit', size: '0.001', price: '80000', reduceOnly: false, isTrigger: false, status: 'open', createdAt: h.clock.now() },
    )
    const schedule = h.live.scheduleCancel.bind(h.live)
    h.live.scheduleCancel = async (ctx, atMs) => {
      if (ctx.account.accountId === h!.paper.accountId) throw new Error('first deadman target failed')
      return schedule(ctx, atMs)
    }
    const ctx: ActorCtx = { principal: { kind: 'service' }, origin: mkOrigin('system:kernel', 'kill.multi', 'internal') }
    const killAlerts: unknown[] = []
    const unsubscribeKill = h.k.events.subscribe('takeover.alert', (event) => killAlerts.push(event.data))

    await expect(h.k.takeover.kill('multi account kill', ctx)).rejects.toMatchObject({ problem: { message: 'first deadman target failed' } })
    expect(h.k.tstate.get(ORG_SCOPE)).toBe('HALTED')
    expect(h.live.scheduleGateCalls.length).toBeGreaterThan(0)
    expect(h.live.scheduleGateCalls.every((row) => row.ctxGate?.ticketId && row.ctxGate.precheckId && row.ctxGate.expiresAt > 0)).toBe(true)
    expect(h.live.cancelCalls.flat().map((target) => target.clientOrderId)).toEqual(expect.arrayContaining(['cl_bad_live', 'cl_good_live']))
    expect(h.live.orders.every((order) => order.status === 'cancelled')).toBe(true)
    const deadmanFailure = [...h.k.ledger.iterate()].find((entry) => entry.type === 'annotation' && (entry.payload as { deadman?: string }).deadman === 'trip' && (entry.payload as { ok?: boolean }).ok === false)
    expect(deadmanFailure?.payload).toMatchObject({ problem: { message: 'first deadman target failed' }, errorStages: ['deadman.trip'] })
    const scheduleFailure = [...h.k.ledger.iterate()].find((entry) => entry.type === 'order.rejected' && (entry.payload as { action?: string; result?: { ok?: boolean } }).action === 'deadman_arm' && (entry.payload as { result?: { ok?: boolean } }).result?.ok === false)
    expect(scheduleFailure?.subject).toMatchObject({ accountId: h.paper.accountId })
    expect(scheduleFailure?.payload).toMatchObject({ problem: { message: 'first deadman target failed' }, errorStages: ['deadman.schedule'] })
    expect([...h.k.ledger.iterate()].some((entry) => entry.type === 'annotation' && (entry.subject as { accountId?: string }).accountId === h!.liveAcct.accountId && (entry.payload as { action?: string }).action === 'deadman_arm')).toBe(true)
    const entries = [...h.k.ledger.iterate()]
    const deadmanTakeoverFailure = entries.find((entry) => entry.type === 'takeover.failed' && (entry.payload as { phase?: string }).phase === 'kill.deadman')
    expect(deadmanTakeoverFailure?.origin.requestId).toBe(ctx.origin.requestId)
    expect(entries.some((entry) => entry.type === 'takeover.completed' && entry.origin.requestId === ctx.origin.requestId)).toBe(false)
    expect(h.live.orders.every((order) => order.status === 'cancelled')).toBe(true)
    expect(killAlerts).toEqual(expect.arrayContaining([expect.objectContaining({ phase: 'kill.deadman' })]))
    unsubscribeKill()
  })

  it('keeps resume reducing until each armed venue is disarmed and retries with fresh tickets', async () => {
    h = await makeHarness({ kernel: { sleep: async () => undefined } })
    await enableLive(h)
    Object.assign(h.paper, { mode: 'live', venue: h.liveAcct.venue, environment: h.liveAcct.environment, signer: structuredClone(h.liveAcct.signer), status: 'active' })
    await h.k.trading.place({ intent: { ...intent(h.liveAcct.accountId), clientOrderId: newClientOrderId() } }, h.human())
    const ctx: ActorCtx = { principal: { kind: 'service' }, origin: mkOrigin('system:kernel', 'resume.setup', 'internal') }
    await h.k.takeover.kill('prepare resume', ctx)
    const proof = await h.pinProof()
    const original = h.live.scheduleCancel.bind(h.live)
    const during: string[] = []
    const attempted: string[] = []
    const remoteProblem = makeProblem('VENUE_UNAVAILABLE', 'disarm remote failure', { retryable: true, venue: { id: h.liveAcct.venue, message: 'disarm remote failure' } })
    let failFirst = true
    h.live.scheduleCancel = async (call, atMs) => {
      during.push(String(h!.k.tstate.get(ORG_SCOPE)))
      attempted.push(call.account.accountId)
      if (call.account.accountId === h!.paper.accountId && failFirst) {
        failFirst = false
        throw new KernelError(remoteProblem)
      }
      return original(call, atMs)
    }
    const alerts: unknown[] = []
    const unsubscribe = h.k.events.subscribe('takeover.alert', (event) => alerts.push(event.data))
    await expect(h.k.takeover.resume(ORG_SCOPE, 'resume attempt', proof, h.human('ui:resume'))).rejects.toMatchObject({ problem: { name: 'VENUE_UNAVAILABLE', message: 'disarm remote failure', venue: { id: h.liveAcct.venue, message: 'disarm remote failure' } } })
    expect(during.every((state) => state === 'REDUCING')).toBe(true)
    expect(attempted).toEqual(expect.arrayContaining([h.paper.accountId, h.liveAcct.accountId]))
    expect(h.k.tstate.get(ORG_SCOPE)).toBe('REDUCING')
    expect(alerts).toEqual(expect.arrayContaining([expect.objectContaining({ phase: 'resume.disarm' })]))
    const failedResume = [...h.k.ledger.iterate()].reverse().find((entry) => entry.type === 'annotation' && (entry.payload as { kind?: string }).kind === 'resume.failed')
    expect(failedResume?.payload).toMatchObject({ kind: 'resume.failed', from: 'HALTED', tradingStateAfter: 'REDUCING', problem: { message: 'disarm remote failure' }, errorStages: ['deadman.disarm'] })
    expect((failedResume?.payload as { problem?: unknown }).problem).toEqual(remoteProblem)
    const failedSchedule = [...h.k.ledger.iterate()].find((entry) => entry.type === 'order.rejected' && (entry.payload as { action?: string }).action === 'deadman_disarm' && (entry.subject as { accountId?: string }).accountId === h!.paper.accountId)
    expect((failedSchedule?.payload as { gate?: { ticketId?: string } }).gate?.ticketId).toBeTruthy()
    expect([...h.k.ledger.iterate()].some((entry) => entry.type === 'annotation' && (entry.subject as { accountId?: string }).accountId === h!.liveAcct.accountId && (entry.payload as { action?: string }).action === 'deadman_disarm')).toBe(true)

    const previousTickets = new Set(h.live.scheduleGateCalls.map((row) => row.ctxGate?.ticketId).filter(Boolean))
    h.clock.advance(5_000)
    await h.k.deadman.tick()
    expect(h.live.scheduleGateCalls.some((row) => row.ctxGate?.ticketId && !previousTickets.has(row.ctxGate.ticketId))).toBe(true)
    const retried = await h.k.takeover.resume(ORG_SCOPE, 'resume retry', proof, h.human('ui:resume'))
    expect(retried).toEqual({ from: 'REDUCING', to: 'ACTIVE' })
    expect(h.k.tstate.get(ORG_SCOPE)).toBe('ACTIVE')
    unsubscribe()
  })

  it('returns the entry state after a successful resume and rejects session proof before venue I/O', async () => {
    h = await makeHarness()
    await enableLive(h)
    await h.k.trading.place({ intent: { ...intent(h.liveAcct.accountId), clientOrderId: newClientOrderId() } }, h.human())
    const system: ActorCtx = { principal: { kind: 'service' }, origin: mkOrigin('system:kernel', 'resume.setup', 'internal') }
    await h.k.takeover.kill('prepare resume', system)
    const scheduleCalls = h.live.scheduleCalls.length
    const cancelCalls = h.live.cancelCalls.length
    const cancelAllCalls = h.live.cancelAllCalls.length
    await expect(h.k.takeover.resume(ORG_SCOPE, 'no PIN', h.sessionProof(), h.human('ui:resume'))).rejects.toMatchObject({ problem: { name: 'ATTESTATION_REQUIRED' } })
    expect(h.k.tstate.get(ORG_SCOPE)).toBe('HALTED')
    expect(h.live.scheduleCalls).toHaveLength(scheduleCalls)
    expect(h.live.cancelCalls).toHaveLength(cancelCalls)
    expect(h.live.cancelAllCalls).toHaveLength(cancelAllCalls)
    const resumed = await h.k.takeover.resume(ORG_SCOPE, 'all clear', await h.pinProof(), h.human('ui:resume'))
    expect(resumed).toEqual({ from: 'HALTED', to: 'ACTIVE' })
    expect(h.k.tstate.get(ORG_SCOPE)).toBe('ACTIVE')
  })

  it('does not treat a PIN proof as an unlocked wallet for an armed deadman', async () => {
    h = await makeHarness()
    await enableLive(h)
    await h.k.trading.place({ intent: { ...intent(h.liveAcct.accountId), clientOrderId: newClientOrderId() } }, h.human())
    const system: ActorCtx = { principal: { kind: 'service' }, origin: mkOrigin('system:kernel', 'resume.setup', 'internal') }
    await h.k.takeover.kill('prepare resume', system)
    const proof = await h.pinProof()
    const scheduleCalls = h.live.scheduleCalls.length
    await h.k.keystore.lock()
    await expect(h.k.takeover.resume(ORG_SCOPE, 'wallet locked', proof, h.human('ui:resume'))).rejects.toMatchObject({ problem: { name: 'VENUE_AUTH' } })
    expect(h.k.tstate.get(ORG_SCOPE)).toBe('REDUCING')
    expect(h.live.scheduleCalls).toHaveLength(scheduleCalls)
  })

  it('continues flattening healthy paper accounts after a first account exhausts cancellation retries', async () => {
    h = await makeHarness({ kernel: { sleep: async () => undefined } })
    Object.assign(h.liveAcct, { mode: 'paper' })
    const failedAccount = h.paper.accountId
    const healthyAccount = h.liveAcct.accountId
    const position: Position = { accountId: healthyAccount as never, instrumentId: BTC, side: 'long', size: asDecimal('0.001'), entryPrice: asDecimal('80000'), markPrice: asDecimal('80000'), notional: asDecimal('80'), unrealizedPnl: asDecimal('0'), realizedPnl: asDecimal('0'), leverage: 1, marginMode: 'cross', liquidationPrice: null, fundingSinceOpen: asDecimal('0'), openedAt: h.clock.now(), updatedAt: h.clock.now() }
    h.sim.positions.set(healthyAccount, [position])
    const accountState = h.sim.accountState.bind(h.sim)
    h.sim.accountState = async (ref) => ({ ...await accountState(ref), ...(ref.accountId === failedAccount ? { stale: true } : { stale: false }) })
    h.sim.startupResponseSequence = [new Error('first account cancel view failed'), new Error('first account cancel view failed'), new Error('first account cancel view failed'), new Error('first account cancel view failed')]
    const ctx = h.human('takeover.flatten')

    await expect(h.k.takeover.execute({ level: 'flatten_all', scope: ORG_SCOPE, reason: 'continue other account' }, ctx)).rejects.toMatchObject({ problem: { message: 'first account cancel view failed' } })
    expect(h.sim.positions.get(healthyAccount)).toEqual([])
    expect(h.k.tstate.get(ORG_SCOPE)).toBe('REDUCING')
    expect([...h.k.ledger.iterate()].some((entry) => entry.type === 'takeover.completed')).toBe(false)
    expect([...h.k.ledger.iterate()].some((entry) => entry.type === 'takeover.failed' && (entry.subject as { accountId?: string }).accountId === failedAccount)).toBe(true)
  })

  it('rejects an agent or empty kill reason before state or venue side effects', async () => {
    h = await makeHarness()
    const agent = await makeAgent(h, 'paper')
    const before = [...h.k.ledger.iterate()].length
    await expect(h.k.takeover.kill('agent cannot kill', agent.ctx('takeover.kill'))).rejects.toMatchObject({ problem: { name: 'MANDATE_LIMIT' } })
    await expect(h.k.takeover.kill('   ', h.human('kill'))).rejects.toMatchObject({ problem: { name: 'INVALID_PARAMS' } })
    expect(h.k.tstate.get(ORG_SCOPE)).toBe('ACTIVE')
    expect([...h.k.ledger.iterate()]).toHaveLength(before)
    expect(h.sim.cancelCalls).toHaveLength(0)
    expect(h.sim.cancelAllCalls).toHaveLength(0)
    expect(h.live.scheduleCalls).toHaveLength(0)
  })

  it('does not accept a forged system origin from a valid L0 agent', async () => {
    h = await makeHarness()
    const agent = await makeAgent(h, 'read_only')
    const base = agent.ctx('takeover.execute')
    const ctx: ActorCtx = { ...base, origin: { ...base.origin, actor: 'system:forged', actorType: 'system' } }
    const original = structuredClone(ctx)
    await expect(h.k.takeover.execute({ level: 'cancel_all', scope: { type: 'account', id: h.paper.accountId }, reason: 'identity test' }, ctx))
      .rejects.toMatchObject({ problem: { name: 'MANDATE_LEVEL' } })
    expect(ctx).toEqual(original)
    expect(h.sim.cancelAllCalls).toHaveLength(0)
    const failed = [...h.k.ledger.iterate()].reverse().find((entry) => entry.type === 'takeover.failed')!
    expect(failed.origin).toMatchObject({ actor: `agent:${agent.keyId}`, actorType: 'llm-agent' })
  })

  it('does not accept forged human or system origins from a valid L0 engine', async () => {
    h = await makeHarness()
    const agent = await makeAgent(h, 'read_only')
    const ctx: ActorCtx = {
      principal: { kind: 'engine', engineId: 'engine_gate_identity', mandateId: agent.mandate.mandateId },
      origin: { ...mkOrigin('user:usr_local', 'takeover.execute', 'ui'), actorType: 'human' },
    }
    const original = structuredClone(ctx)
    await expect(h.k.takeover.execute({ level: 'cancel_all', scope: { type: 'account', id: h.paper.accountId }, reason: 'identity test' }, ctx))
      .rejects.toMatchObject({ problem: { name: 'MANDATE_LEVEL' } })
    expect(ctx).toEqual(original)
    expect(h.sim.cancelAllCalls).toHaveLength(0)
    const failed = [...h.k.ledger.iterate()].reverse().find((entry) => entry.type === 'takeover.failed')!
    expect(failed.origin).toMatchObject({ actor: 'engine:engine_gate_identity', actorType: 'engine' })
  })

  it('canonicalizes a session spoofing system through the real cancellation gate', async () => {
    h = await makeHarness()
    const placed = await h.k.trading.place({ intent: intent(h.paper.accountId) }, h.human())
    h.sim.orders.push({ venueOrderId: 'venue_session_sl', clientOrderId: 'cl_session_sl', accountId: h.paper.accountId, instrumentId: BTC, side: 'sell', type: 'stop_market', size: '0.001', price: null, reduceOnly: true, isTrigger: true, status: 'open', createdAt: h.clock.now() })
    const base = h.human('takeover.execute')
    const ctx: ActorCtx = { ...base, origin: { ...base.origin, actor: 'system:forged', actorType: 'system' } }
    const original = structuredClone(ctx)
    const record = await h.k.takeover.execute({ level: 'cancel_all', scope: { type: 'account', id: h.paper.accountId }, reason: 'identity test', keepProtective: false }, ctx)
    expect(record.ok).toBe(true)
    expect(ctx).toEqual(original)
    expect(h.k.orders.get(placed.order!.orderId)?.status).toBe('cancelled')
    expect(h.sim.orders.find((order) => order.clientOrderId === 'cl_session_sl')?.status).toBe('cancelled')
    const entry = [...h.k.ledger.iterate()].reverse().find((item) => item.type === 'order.cancelled')!
    expect(entry.origin).toMatchObject({ actor: 'user:usr_local', actorType: 'human', requestId: base.origin.requestId })
    expect((entry.payload as { gate: { snapshot: { actorClass: string; originActorType: string }; target: { keepProtective: boolean } } }).gate)
      .toMatchObject({ snapshot: { actorClass: 'human', originActorType: 'human' }, target: { keepProtective: false } })
  })

  it('preserves trusted internal service system authority and protective orders', async () => {
    h = await makeHarness()
    const placed = await h.k.trading.place({ intent: intent(h.paper.accountId) }, h.human())
    h.sim.orders.push({ venueOrderId: 'venue_system_sl', clientOrderId: 'cl_system_sl', accountId: h.paper.accountId, instrumentId: BTC, side: 'sell', type: 'stop_market', size: '0.001', price: null, reduceOnly: true, isTrigger: true, status: 'open', createdAt: h.clock.now() })
    const ctx: ActorCtx = { principal: { kind: 'service' }, origin: mkOrigin('system:kernel', 'takeover.system', 'internal') }
    const record = await h.k.takeover.execute({ level: 'cancel_all', scope: { type: 'account', id: h.paper.accountId }, reason: 'system identity test', keepProtective: false }, ctx)
    expect(record.ok).toBe(true)
    expect(h.k.orders.get(placed.order!.orderId)?.status).toBe('cancelled')
    expect(h.sim.orders.find((order) => order.clientOrderId === 'cl_system_sl')?.status).toBe('open')
    const entry = [...h.k.ledger.iterate()].reverse().find((item) => item.type === 'order.cancelled')!
    expect(entry.origin).toMatchObject({ actor: 'system:kernel', actorType: 'system', via: 'internal' })
    expect((entry.payload as { gate: { snapshot: { actorClass: string; originActorType: string }; target: { keepProtective: boolean } } }).gate)
      .toMatchObject({ snapshot: { actorClass: 'system', originActorType: 'system' }, target: { keepProtective: true } })
    expect(h.sim.cancelGateCalls.at(-1)?.ticketId).toBeTruthy()
  })

  it('rejects a service principal carrying engine origin before takeover writes state or ledger', async () => {
    h = await makeHarness()
    const ctx: ActorCtx = { principal: { kind: 'service' }, origin: mkOrigin('engine:forged', 'takeover.execute', 'gep') }
    const ledgerSize = [...h.k.ledger.iterate()].length
    expect(h.k.tstate.get({ type: 'account', id: h.paper.accountId })).toBe('ACTIVE')
    await expect(h.k.takeover.execute({ level: 'cancel_all', scope: { type: 'account', id: h.paper.accountId }, reason: 'identity test' }, ctx))
      .rejects.toMatchObject({ problem: { name: 'MANDATE_LEVEL' } })
    expect(h.k.tstate.get({ type: 'account', id: h.paper.accountId })).toBe('ACTIVE')
    expect([...h.k.ledger.iterate()]).toHaveLength(ledgerSize)
    expect(h.sim.cancelAllCalls).toHaveLength(0)
  })

  it('routes deadman writes through trading tickets and keeps legacy trace shape', async () => {
    h = await makeHarness()
    await enableLive(h)
    await h.k.trading.place({ intent: { ...intent(h.liveAcct.accountId), clientOrderId: newClientOrderId() } }, h.human())
    const systemSchedule = h.k.trading.systemScheduleCancel.bind(h.k.trading)
    let forwardedOrigin: Origin | undefined
    h.k.trading.systemScheduleCancel = async (account, atMs, origin) => { forwardedOrigin = origin; return systemSchedule(account, atMs, origin) }
    const renewed = await h.k.deadman.tick()
    expect(renewed).toBe(1)
    expect(h.live.scheduleCalls).toEqual([{ atMs: expect.any(Number), signed: true }])
    expect(h.live.scheduleGateCalls).toHaveLength(1)
    expect(h.live.scheduleGateCalls[0]?.ctxGate?.ticketId).toBeTruthy()
    const entry = [...h.k.ledger.iterate()].reverse().find((row) => row.type === 'annotation' && (row.payload as { action?: string }).action === 'deadman_arm')!
    expect(forwardedOrigin).toMatchObject({ actor: 'system:kernel', actorType: 'system', via: 'internal', requestId: expect.any(String) })
    expect(entry.origin).toMatchObject({ actor: 'system:kernel', actorType: 'system', via: 'internal', requestId: forwardedOrigin?.requestId })
    const decision = (entry.payload as { gate: { decision: { precheckId: string }; ticketId: string } }).gate
    expect(decision.ticketId).toBe(h.live.scheduleGateCalls[0]?.ctxGate?.ticketId)
    expect(h.k.risk.replay(decision.decision.precheckId).status).toBe('identical')
  })

  it('does not write on duplicate ticks or while the wallet is locked', async () => {
    h = await makeHarness()
    await enableLive(h)
    await h.k.trading.place({ intent: { ...intent(h.liveAcct.accountId), clientOrderId: newClientOrderId() } }, h.human())
    expect(await h.k.deadman.tick()).toBe(1)
    expect(await h.k.deadman.tick()).toBe(0)
    expect(h.live.scheduleCalls).toHaveLength(1)
    await h.k.keystore.lock()
    h.clock.advance(10 * 60_000)
    expect(await h.k.deadman.tick()).toBe(0)
    expect(h.live.scheduleCalls).toHaveLength(1)
  })

  it('disarms through a fresh ticket when the watchdog no longer has anything to monitor', async () => {
    h = await makeHarness()
    await enableLive(h)
    await h.k.trading.place({ intent: { ...intent(h.liveAcct.accountId), clientOrderId: newClientOrderId() } }, h.human())
    let needed = true
    const deadman = new VenueDeadman({ clock: h.clock, bus: h.k.bus, accounts: h.k.accounts, keystore: h.k.keystore, ledger: h.k.ledger, needed: () => needed })
    deadman.bindTrading(h.k.trading)
    const systemSchedule = h.k.trading.systemScheduleCancel.bind(h.k.trading)
    let forwardedOrigin: Origin | undefined
    h.k.trading.systemScheduleCancel = async (account, atMs, origin) => { forwardedOrigin = origin; return systemSchedule(account, atMs, origin) }
    expect(await deadman.tick()).toBe(1)
    needed = false
    expect(await deadman.tick()).toBe(0)
    expect(h.live.scheduleCalls.map((row) => row.atMs)).toEqual([h.clock.now() + 20 * 60_000, null])
    const disarm = h.live.scheduleGateCalls.at(-1)?.ctxGate
    expect(disarm?.ticketId).not.toBe(h.live.scheduleGateCalls[0]?.ctxGate?.ticketId)
    const entry = [...h.k.ledger.iterate()].reverse().find((row) => row.type === 'annotation' && (row.payload as { action?: string }).action === 'deadman_disarm')!
    expect(forwardedOrigin).toMatchObject({ actor: 'system:kernel', actorType: 'system', via: 'internal', requestId: expect.any(String) })
    expect(entry.origin).toMatchObject({ actor: 'system:kernel', actorType: 'system', via: 'internal', requestId: forwardedOrigin?.requestId })
    const gate = (entry.payload as { gate: { decision: { precheckId: string } } }).gate
    expect(h.k.risk.replay(gate.decision.precheckId).status).toBe('identical')
  })

  it('fails closed when unbound and permits only idempotent binding to one trading service', async () => {
    h = await makeHarness()
    await enableLive(h)
    const deadman = new VenueDeadman({ clock: h.clock, bus: h.k.bus, accounts: h.k.accounts, keystore: h.k.keystore, ledger: h.k.ledger })
    await expect(deadman.tick()).rejects.toMatchObject({ problem: { name: 'GATE_TICKET_INVALID' } })
    expect(h.live.scheduleCalls).toHaveLength(0)
    deadman.bindTrading(h.k.trading)
    deadman.bindTrading(h.k.trading)
    expect(() => deadman.bindTrading({} as never)).toThrow()
  })

  it('keeps human kill identity for cancellation and uses a separate system ticket for deadman trip', async () => {
    h = await makeHarness()
    await enableLive(h)
    const liveOrder = await h.k.trading.place({ intent: { ...intent(h.liveAcct.accountId), clientOrderId: newClientOrderId() } }, h.human())
    const paperOrder = await h.k.trading.place({ intent: intent(h.paper.accountId) }, h.human())
    const ctx = h.human('kill')
    await h.k.takeover.kill('manual stop', ctx)
    expect(h.k.orders.get(paperOrder.order!.orderId)?.status).toBe('cancelled')
    expect(h.k.orders.get(liveOrder.order!.orderId)?.status).toBe('cancelled')
    const cancelled = [...h.k.ledger.iterate()].filter((row) => row.type === 'order.cancelled').at(-1)!
    const cancelGate = (cancelled.payload as { gate: { decision: { precheckId: string }; snapshot: { actorClass: string }; target: { keepProtective: boolean } } }).gate
    expect(cancelGate).toMatchObject({ snapshot: { actorClass: 'human' }, target: { keepProtective: false } })
    expect(h.k.risk.replay(cancelGate.decision.precheckId).status).toBe('identical')
    const scheduleGate = h.live.scheduleGateCalls.at(-1)?.ctxGate
    expect(scheduleGate?.ticketId).toBeTruthy()
    const armEntry = [...h.k.ledger.iterate()].reverse().find((row) => row.type === 'annotation' && (row.payload as { action?: string }).action === 'deadman_arm')!
    const gate = (armEntry.payload as { gate: { decision: { precheckId: string }; snapshot: { actorClass: string }; ticketId: string } }).gate
    expect(gate.snapshot.actorClass).toBe('system')
    expect(gate.ticketId).toBe(scheduleGate?.ticketId)
    expect(h.k.risk.replay(gate.decision.precheckId).status).toBe('identical')
  })

  it('routes a HALTED sentinel deadman write as a replayable system action', async () => {
    h = await makeHarness()
    await enableLive(h)
    await h.k.trading.place({ intent: { ...intent(h.liveAcct.accountId), clientOrderId: newClientOrderId() } }, h.human())
    h.k.tstate.set({ type: 'account', id: h.liveAcct.accountId }, 'HALTED', 'sentinel test', mkOrigin('system:kernel', 'halt:sentinel', 'internal'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(h.live.scheduleGateCalls).toHaveLength(1)
    const entry = [...h.k.ledger.iterate()].reverse().find((row) => row.type === 'annotation' && (row.payload as { action?: string }).action === 'deadman_arm')!
    const gate = (entry.payload as { gate: { decision: { precheckId: string }; snapshot: { actorClass: string } } }).gate
    expect(gate.snapshot.actorClass).toBe('system')
    expect(h.k.risk.replay(gate.decision.precheckId).status).toBe('identical')
  })

  it('keeps the live-wallet requirement for human takeover writes', async () => {
    h = await makeHarness()
    await expect(h.k.trading.takeoverCancelAll(h.liveAcct, { keepProtective: false }, h.human('takeover.execute')))
      .rejects.toMatchObject({ problem: { name: 'VENUE_AUTH' } })
    expect(h.live.cancelAllCalls).toHaveLength(0)
  })

  it('does not let an agent borrow a human origin to bypass mandate or preserve protections', async () => {
    h = await makeHarness()
    const order = await h.k.trading.place({ intent: intent(h.paper.accountId) }, h.human())
    const agent = await makeAgent(h, 'paper')
    h.k.docs.put('mandate', agent.mandate.mandateId, { ...agent.mandate, level: 'L0' }, agent.mandate.version)
    expect(h.k.agents.verifyMandate(agent.mandate.mandateId)).toBe(false)
    const spoofed = { ...agent.ctx('takeover.execute'), origin: h.human('takeover.execute').origin }
    await expect(h.k.trading.takeoverCancelAll(h.paper, { keepProtective: false }, spoofed)).rejects.toMatchObject({ problem: { name: 'MANDATE_EXPIRED' } })
    expect(h.k.orders.get(order.order!.orderId)?.status).toBe('open')
    expect(h.sim.cancelAllCalls).toHaveLength(0)
  })

  it('retries deadman failures with a new ticket and keeps the previous armed state until success', async () => {
    h = await makeHarness()
    await enableLive(h)
    await h.k.trading.place({ intent: { ...intent(h.liveAcct.accountId), clientOrderId: newClientOrderId() } }, h.human())
    let needed = true
    const deadman = new VenueDeadman({ clock: h.clock, bus: h.k.bus, accounts: h.k.accounts, keystore: h.k.keystore, ledger: h.k.ledger, needed: () => needed })
    deadman.bindTrading(h.k.trading)
    expect(await deadman.tick()).toBe(1)
    const firstTicket = h.live.scheduleGateCalls[0]?.ctxGate?.ticketId
    h.clock.advance(10 * 60_000)
    let fail = true
    const original = h.live.scheduleCancel.bind(h.live)
    h.live.scheduleCancel = async (ctx, atMs) => { await original(ctx, atMs); if (fail) { fail = false; throw new Error('simulated venue failure') } }
    expect(await deadman.tick()).toBe(0)
    expect(h.live.scheduleGateCalls[1]?.ctxGate?.ticketId).not.toBe(firstTicket)
    expect(deadman.failures).toBe(1)
    needed = false
    expect(await deadman.tick()).toBe(0)
    expect(h.live.scheduleGateCalls).toHaveLength(2)
    h.clock.advance(5_000)
    expect(await deadman.tick()).toBe(0)
    expect(h.live.scheduleCalls.map((row) => row.atMs)).toEqual([h.clock.now() - 605_000 + 20 * 60_000, h.clock.now() - 5_000 + 20 * 60_000, null])
    expect(h.live.scheduleGateCalls[2]?.ctxGate?.ticketId).not.toBe(h.live.scheduleGateCalls[1]?.ctxGate?.ticketId)
    const attempts = [...h.k.ledger.iterate()].filter((row) => (row.type === 'annotation' || row.type === 'order.rejected') && (row.payload as { action?: string }).action === 'deadman_arm')
    expect(attempts).toHaveLength(2)
    expect(attempts.map((row) => (row.payload as { gate: { ticketId: string } }).gate.ticketId)).toEqual(h.live.scheduleGateCalls.slice(0, 2).map((row) => row.ctxGate?.ticketId))
    const failed = attempts[1]!
    expect(failed.type).toBe('order.rejected')
    expect(failed.payload).toMatchObject({ result: { ok: false }, problem: { name: 'VENUE_UNAVAILABLE' } })
    for (const row of attempts) {
      const gate = (row.payload as { gate: { decision: { precheckId: string } } }).gate
      expect(h.k.risk.replay(gate.decision.precheckId).status).toBe('identical')
    }
  })

  it('allows API-key deadman arm and disarm only while the keystore is unlocked without creating a signer', async () => {
    h = await makeHarness({ configure: (config) => {
      const live = config.accounts.find((account) => account.alias === 'live')!
      delete live.signerRef
      live.owner = {}
      live.credentials = { apiKey: 'env:A2W_API_KEY' }
    } })
    const pin = await h.pinProof()
    expect(h.liveAcct.signer.type).toBe('api-key')
    expect(h.k.keystore.list()).toHaveLength(0)

    let needed = true
    const deadman = new VenueDeadman({ clock: h.clock, bus: h.k.bus, accounts: h.k.accounts, keystore: h.k.keystore, ledger: h.k.ledger, needed: () => needed })
    deadman.bindTrading(h.k.trading)

    h.k.keystore.lock()
    expect(await deadman.tick()).toBe(0)
    expect(h.live.scheduleCalls).toHaveLength(0)

    h.k.keystore.unlock(pin)
    expect(await deadman.tick()).toBe(1)
    expect(h.live.scheduleCalls).toEqual([{ atMs: h.clock.now() + 20 * 60_000, signed: false }])

    needed = false
    h.k.keystore.lock()
    expect(await deadman.tick()).toBe(0)
    expect(h.live.scheduleCalls).toHaveLength(1)

    h.k.keystore.unlock(pin)
    expect(await deadman.tick()).toBe(0)
    expect(h.live.scheduleCalls).toEqual([{ atMs: h.clock.now() + 20 * 60_000, signed: false }, { atMs: null, signed: false }])
  })

  it('disables deadman when registration sets false even if connector capabilities advertise it', async () => {
    h = await makeHarness({ registerLive: false })
    h.k.registerConnector(h.live, { deadman: false })
    expect(h.live.describe().deadman?.method).toBe('schedule_cancel')
    expect(h.k.bus.hasDeadman(h.liveAcct)).toBe(false)

    const deadman = new VenueDeadman({ clock: h.clock, bus: h.k.bus, accounts: h.k.accounts, keystore: h.k.keystore, ledger: h.k.ledger, needed: () => true })
    deadman.bindTrading(h.k.trading)
    expect(await deadman.tick()).toBe(0)
    expect(await deadman.trip('test', { principal: { kind: 'service' }, origin: mkOrigin('system:kernel', 'deadman.test', 'internal') }, [h.liveAcct])).toBe(0)
    expect(h.live.scheduleCalls).toHaveLength(0)
  })

  it('disarms an API-key venue on resume while unlocked without creating a signer', async () => {
    h = await makeHarness({ configure: (config) => {
      const live = config.accounts.find((account) => account.alias === 'live')!
      delete live.signerRef
      live.owner = {}
      live.credentials = { apiKey: 'env:A2W_API_KEY' }
    } })
    await h.pinProof()
    expect(h.liveAcct.signer.type).toBe('api-key')
    expect(h.k.keystore.list()).toHaveLength(0)

    const deadman = new VenueDeadman({ clock: h.clock, bus: h.k.bus, accounts: h.k.accounts, keystore: h.k.keystore, ledger: h.k.ledger })
    deadman.bindTrading(h.k.trading)
    await deadman.disarmAfterResume([h.liveAcct], mkOrigin('system:kernel', 'deadman.resume', 'internal'))
    expect(h.live.scheduleCalls).toEqual([{ atMs: null, signed: false }])
  })

  it('preserves human identity and allows takeover when the legacy cancel counter is full', async () => {
    h = await makeHarness()
    const placed = await h.k.trading.place({ intent: intent(h.paper.accountId) }, h.human())
    await h.k.risk.relax({ limits: { maxCancelsPerMinute: 0 } as never }, await h.pinProof(), h.human('risk.relax').origin)
    await expect(h.k.trading.cancelAll({ accountId: h.paper.accountId }, h.human())).rejects.toMatchObject({ problem: { name: 'RATE_BUDGET' } })
    const ctx = h.human('takeover.execute')
    const rec = await h.k.takeover.execute({ level: 'cancel_all', scope: { type: 'account', id: h.paper.accountId }, reason: 'test takeover', keepProtective: false }, ctx)
    expect(rec.ok).toBe(true)
    expect(h.k.orders.get(placed.order!.orderId)?.status).toBe('cancelled')
    expect(h.sim.cancelAllGateCalls.at(-1)?.ticketId).toBeTruthy()
    expect([...h.k.ledger.iterate()].some((entry) => entry.type === 'order.cancelled' && entry.origin.actor === ctx.origin.actor && entry.origin.requestId === ctx.origin.requestId)).toBe(true)
    const cancelEntry = [...h.k.ledger.iterate()].reverse().find((entry) => entry.type === 'order.cancelled')!
    expect((cancelEntry.payload as { gate: { decision: { action: string } } }).gate.decision.action).toBe('cancel_protective')
  })

  it('keeps agent scope and forces protective preservation without changing actor class', async () => {
    h = await makeHarness()
    const normal = await h.k.trading.place({ intent: intent(h.paper.accountId) }, h.human())
    h.sim.orders.push({ venueOrderId: 'venue_sl_agent', clientOrderId: 'cl_sl_agent', accountId: h.paper.accountId, instrumentId: BTC, side: 'sell', type: 'stop_market', size: '0.001', price: null, reduceOnly: true, isTrigger: true, status: 'open', createdAt: h.clock.now() })
    const agent = await makeAgent(h, 'paper')
    const rec = await h.k.takeover.execute({ level: 'cancel_all', scope: { type: 'account', id: h.paper.accountId }, reason: 'agent scoped takeover', keepProtective: false }, agent.ctx('takeover.execute'))
    expect(rec.ok).toBe(true)
    expect(h.k.orders.get(normal.order!.orderId)?.status).toBe('cancelled')
    expect(h.sim.orders.find((order) => order.clientOrderId === 'cl_sl_agent')?.status).toBe('open')
    expect(h.sim.cancelGateCalls.at(-1)?.ticketId).toBeTruthy()
    const entry = [...h.k.ledger.iterate()].reverse().find((item) => item.type === 'order.cancelled')!
    expect((entry.payload as { gate: { snapshot: { actorClass: string }; target: { keepProtective: boolean } } }).gate).toMatchObject({ snapshot: { actorClass: 'agent' }, target: { keepProtective: true } })
  })

  it('reissues a fresh ticket after retryable remote-view failure and preserves system origin', async () => {
    h = await makeHarness({ kernel: { sleep: async () => undefined } })
    const placed = await h.k.trading.place({ intent: intent(h.paper.accountId) }, h.human())
    const remote = await freshRemote(h)
    h.sim.accountSnapshotOverrides = { stale: true }
    h.sim.openOrdersOverride = []
    h.sim.startupResponseSequence = [new Error('remote read failed'), remote]
    const ctx = { principal: { kind: 'service' as const }, origin: mkOrigin('system:kernel', 'takeover.system', 'internal') }
    const rec = await h.k.takeover.execute({ level: 'cancel_all', scope: { type: 'account', id: h.paper.accountId }, reason: 'system takeover', keepProtective: false }, ctx)
    expect(rec.ok).toBe(true)
    expect(h.k.orders.get(placed.order!.orderId)?.status).toBe('cancelled')
    const attempts = [...h.k.ledger.iterate()].filter((entry) => (entry.type === 'order.rejected' && (entry.payload as { kind?: string }).kind === 'cancel.failed') || entry.type === 'order.cancelled')
    const ticketIds = attempts.map((entry) => (entry.payload as { gate?: { ticketId?: string } }).gate?.ticketId).filter((id): id is string => !!id)
    expect(ticketIds).toHaveLength(2)
    expect(new Set(ticketIds).size).toBe(2)
    expect(h.sim.cancelGateCalls.at(-1)?.ticketId).toBe(ticketIds.at(-1))
    const successEntry = [...h.k.ledger.iterate()].reverse().find((entry) => entry.type === 'order.cancelled')!
    expect((successEntry.payload as { gate: { decision: { action: string }; snapshot: { actorClass: string }; target: { keepProtective: boolean } } }).gate).toMatchObject({ decision: { action: 'cancel' }, snapshot: { actorClass: 'system' }, target: { keepProtective: true } })
  })

  it('leaves takeover reducing and reports failure after four failed remote reads', async () => {
    h = await makeHarness({ kernel: { sleep: async () => undefined } })
    await h.k.trading.place({ intent: intent(h.paper.accountId) }, h.human())
    h.sim.accountSnapshotOverrides = { stale: true }
    h.sim.openOrdersOverride = []
    h.sim.startupResponseSequence = [new Error('remote read failed')]
    const ctx = { principal: { kind: 'service' as const }, origin: mkOrigin('system:kernel', 'takeover.system', 'internal') }
    await expect(h.k.takeover.execute({ level: 'cancel_all', scope: { type: 'account', id: h.paper.accountId }, reason: 'retry exhaustion' }, ctx)).rejects.toMatchObject({ problem: { name: 'VENUE_UNAVAILABLE', retryable: true } })
    expect(h.sim.startupSnapshotCalls).toBe(4)
    expect(h.k.tstate.get({ type: 'account', id: h.paper.accountId })).toBe('REDUCING')
    const entries = [...h.k.ledger.iterate()]
    expect(entries.some((entry) => entry.type === 'takeover.failed')).toBe(true)
    expect(entries.some((entry) => entry.type === 'takeover.completed')).toBe(false)
    const failedAttempts = entries.filter((entry) => entry.type === 'order.rejected' && (entry.payload as { kind?: string }).kind === 'cancel.failed')
    expect(failedAttempts).toHaveLength(4)
    expect((failedAttempts[0]!.payload as { problem: { venue?: { id: string; message: string } } }).problem.venue).toEqual({ id: h.k.bus.routeFor(h.paper).venue, message: 'remote read failed' })
    const tickets = failedAttempts.map((entry) => (entry.payload as { gate: { ticketId: string } }).gate.ticketId)
    expect(new Set(tickets).size).toBe(4)
  })

  it('does not treat a stale empty position view as a completed flatten', async () => {
    h = await makeHarness({ kernel: { sleep: async () => undefined } })
    const position: Position = { accountId: h.paper.accountId, instrumentId: BTC, side: 'long', size: asDecimal('0.001'), entryPrice: asDecimal('80000'), markPrice: asDecimal('80000'), notional: asDecimal('80'), unrealizedPnl: asDecimal('0'), realizedPnl: asDecimal('0'), leverage: 1, marginMode: 'cross', liquidationPrice: null, fundingSinceOpen: asDecimal('0'), openedAt: h.clock.now(), updatedAt: h.clock.now() }
    h.sim.positions.set(h.paper.accountId, [position])
    h.sim.accountSnapshotOverrides = { stale: true, positions: [] }
    const freshWithPosition = await freshRemote(h, [position])
    const freshFlat: StartupSnapshot = { ...freshWithPosition, account: { ...freshWithPosition.account, positions: [] } }
    h.sim.startupResponseSequence = [freshWithPosition, freshWithPosition, freshFlat]
    const trading = h.k.trading
    const takeoverReduceOnly = trading.takeoverReduceOnly.bind(trading)
    let firstReduction: Awaited<ReturnType<typeof takeoverReduceOnly>> | undefined
    let submittedAtFirstReduction: number | undefined
    let restoredAfterFirstDeny = false
    trading.takeoverReduceOnly = async (...args: Parameters<typeof trading.takeoverReduceOnly>) => {
      const result = await takeoverReduceOnly(...args)
      if (firstReduction === undefined) {
        firstReduction = result
        submittedAtFirstReduction = h!.sim.submitted.length
        if (result.status === 'denied') {
          h!.sim.accountSnapshotOverrides = { stale: false }
          restoredAfterFirstDeny = true
        }
      }
      return result
    }
    const ctx = h.human('takeover.execute')
    const rec = await h.k.takeover.execute({ level: 'flatten_all', scope: { type: 'account', id: h.paper.accountId }, reason: 'flatten stale view' }, ctx)
    expect(firstReduction?.status).toBe('denied')
    expect(firstReduction?.problem?.ruleHits).toContainEqual(expect.objectContaining({ code: 'ACCOUNT_UNKNOWN', action: 'deny' }))
    expect(submittedAtFirstReduction).toBe(0)
    expect(restoredAfterFirstDeny).toBe(true)
    expect(rec.ok).toBe(true)
    expect(h.sim.submitted.some((submission) => submission.intent.reduceOnly === true && submission.intent.side === 'sell')).toBe(true)
    const submission = h.sim.submitted.find((item) => item.intent.reduceOnly === true)!
    const intentEntry = [...h.k.ledger.iterate()].find((entry) => entry.type === 'order.intent' && entry.subject.clientOrderId === submission.intent.clientOrderId)!
    expect((intentEntry.payload as { gate: { ticketId: string } }).gate.ticketId).toBe(submission.ctx.gate?.ticketId)
    expect(intentEntry.origin.actor).toBe(ctx.origin.actor)
    expect((intentEntry.payload as { gate: { snapshot: { actorClass: string } } }).gate.snapshot.actorClass).toBe('human')
    expect(h.sim.positions.get(h.paper.accountId)).toEqual([])
    expect(rec.stateAfter).toBe('HALTED')
  })

  it('keeps a flatten incomplete when the position view remains permanently stale', async () => {
    h = await makeHarness({ kernel: { sleep: async () => undefined } })
    const position: Position = { accountId: h.paper.accountId, instrumentId: BTC, side: 'long', size: asDecimal('0.001'), entryPrice: asDecimal('80000'), markPrice: asDecimal('80000'), notional: asDecimal('80'), unrealizedPnl: asDecimal('0'), realizedPnl: asDecimal('0'), leverage: 1, marginMode: 'cross', liquidationPrice: null, fundingSinceOpen: asDecimal('0'), openedAt: h.clock.now(), updatedAt: h.clock.now() }
    h.sim.positions.set(h.paper.accountId, [position])
    h.sim.accountSnapshotOverrides = { stale: true, positions: [] }
    const freshWithPosition = await freshRemote(h, [position])
    h.sim.startupResponseSequence = [freshWithPosition]
    const ctx = h.human('takeover.execute')
    const rec = await h.k.takeover.execute({ level: 'flatten_all', scope: { type: 'account', id: h.paper.accountId }, reason: 'permanently stale view' }, ctx)
    expect(rec.ok).toBe(false)
    expect(rec.closeOrders).toBe(0)
    expect(rec.remaining).toEqual([{ accountId: h.paper.accountId, instrumentId: BTC, size: '0.001' }])
    expect(rec.stateAfter).toBe('REDUCING')
    expect(h.sim.submitted).toHaveLength(0)
    expect(h.sim.positions.get(h.paper.accountId)).toEqual([position])
    expect([...h.k.ledger.iterate()].some((entry) => entry.type === 'takeover.completed')).toBe(false)
  })
})
