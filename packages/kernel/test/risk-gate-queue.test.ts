// SPDX-License-Identifier: CPAL-1.0
import { afterEach, describe, expect, it } from 'vitest'
import { asDecimal, type AccountId } from '@gitrader/protocol'
import type { OrderIntent } from '../src/proto'
import type { ActorCtx } from '../src/trading'
import type { Harness } from './helpers/harness'
import { enableLive, makeAgent, makeHarness } from './helpers/harness'
import { BTC, ETH } from './helpers/fake-connector'
import { mkOrigin } from '../src/util/origin'
import { newClientOrderId } from '../src/util/ids'

let h: Harness | undefined
afterEach(async () => { await h?.cleanup() })

type Start<T> = { done: T } | { pending: Promise<T> }
interface QueueSeam {
  withAccountQueue<T>(accountId: string, job: () => Promise<Start<T>>, priority?: 'high' | 'normal'): Promise<T>
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

const rawIntent = (accountId: AccountId, side: 'buy' | 'sell' = 'buy', size = '0.001', instrumentId: OrderIntent['instrumentId'] = BTC): OrderIntent => ({
  accountId, instrumentId, side, type: 'market', size: asDecimal(size), clientOrderId: newClientOrderId(), reason: 'queue priority test',
})

describe('account write priority queue', () => {
  it('runs high FIFO before queued normal FIFO and continues after rejection', async () => {
    h = await makeHarness()
    const queue = h.k.trading as unknown as QueueSeam
    const entered = deferred<void>(), releaseCurrent = deferred<void>(), order: string[] = []
    const current = queue.withAccountQueue(h.paper.accountId, async () => {
      order.push('current'); entered.resolve(); await releaseCurrent.promise
      return { done: 'current' }
    }, 'normal')
    await entered.promise
    const normalA = queue.withAccountQueue(h.paper.accountId, async () => { order.push('normal-a'); return { done: 'a' } }, 'normal')
    const normalB = queue.withAccountQueue(h.paper.accountId, async () => { order.push('normal-b'); return { done: 'b' } }, 'normal')
    const highC = queue.withAccountQueue(h.paper.accountId, async () => { order.push('high-c'); return { done: 'c' } }, 'high')
    const highD = queue.withAccountQueue(h.paper.accountId, async () => { order.push('high-d'); return { done: 'd' } }, 'high')
    const rejected = queue.withAccountQueue(h.paper.accountId, async () => { order.push('reject'); throw new Error('expected job failure') }, 'high')
    const afterReject = queue.withAccountQueue(h.paper.accountId, async () => { order.push('after-reject'); return { done: 'after' } }, 'normal')
    const otherAccount = queue.withAccountQueue(h.liveAcct.accountId, async () => { order.push('other-account'); return { done: 'other' } }, 'normal')
    expect(await otherAccount).toBe('other')
    releaseCurrent.resolve()
    await expect(rejected).rejects.toThrow('expected job failure')
    await Promise.all([current, normalA, normalB, highC, highD, afterReject])
    expect(order).toEqual(['current', 'other-account', 'high-c', 'high-d', 'reject', 'normal-a', 'normal-b', 'after-reject'])
  })

  it('runs a waiting human cancel before an agent paper open', async () => {
    h = await makeHarness()
    await h.k.risk.relax({ limits: { duplicateIntentWindowSec: 0 } as never }, await h.pinProof(), h.human('risk').origin)
    const existing = await h.k.trading.place({ intent: { ...rawIntent(h.paper.accountId), type: 'limit', price: asDecimal('80000') } }, h.human())
    h.clock.advance(6000)
    const agent = await makeAgent(h, 'paper')
    const queue = h.k.trading as unknown as QueueSeam
    const entered = deferred<void>(), releaseCurrent = deferred<void>()
    const blocker = queue.withAccountQueue(h.paper.accountId, async () => { entered.resolve(); await releaseCurrent.promise; return { done: undefined } }, 'normal')
    await entered.promise
    const events: string[] = []
    const submit = h.sim.submit.bind(h.sim), cancel = h.sim.cancel.bind(h.sim)
    h.sim.submit = async (ctx, intents) => { events.push('submit'); return submit(ctx, intents) }
    h.sim.cancel = async (ctx, targets) => { events.push('cancel'); return cancel(ctx, targets) }
    const open = h.k.trading.place({ intent: rawIntent(h.paper.accountId, 'buy', '0.01', ETH) }, agent.ctx('order'))
    const cancelPending = h.k.trading.cancel({ accountId: h.paper.accountId, orderId: existing.order!.orderId, clientOrderId: existing.order!.clientOrderId }, h.human('order.cancel'))
    releaseCurrent.resolve()
    const [, cancelled, opened] = await Promise.all([blocker, cancelPending, open])
    expect(cancelled.ok).toBe(true)
    expect(opened.order?.status).toBe('filled')
    expect(events).toEqual(['cancel', 'submit'])
  })

  it('runs system deadman scheduling ahead of a queued open and releases before its acknowledgement', async () => {
    h = await makeHarness()
    await enableLive(h)
    const mandate = h.k.agents.issueMandate({ subject: { type: 'engine', id: 'engine_queue_open' }, level: 'L3', accounts: [h.liveAcct.accountId], venueAllowlist: ['hyperliquid'], instrumentAllowlist: [BTC], limits: { maxOrderNotional: '1500', maxDailyNotional: '5000', autoMaxOrderNotional: '1000', maxDailyLoss: '100' } } as never, await h.pinProof(), h.human('mandate.issue').origin)
    const engine: ActorCtx = { principal: { kind: 'engine', engineId: 'engine_queue_open', mandateId: mandate.mandateId }, origin: mkOrigin('engine:engine_queue_open', 'engine.order', 'gep') }
    let finishSchedule!: () => void
    let scheduleStarted = false
    h.live.scheduleCancel = async () => { scheduleStarted = true; await new Promise<void>((resolve) => { finishSchedule = resolve }) }
    const queue = h.k.trading as unknown as QueueSeam
    const entered = deferred<void>(), releaseCurrent = deferred<void>()
    const blocker = queue.withAccountQueue(h.liveAcct.accountId, async () => { entered.resolve(); await releaseCurrent.promise; return { done: undefined } }, 'normal')
    await entered.promise
    const open = h.k.trading.place({ intent: rawIntent(h.liveAcct.accountId) }, engine)
    const schedule = h.k.trading.systemScheduleCancel(h.liveAcct, h.clock.now() + 60_000)
    const actions: string[] = []
    const decide = h.k.gate.decide.bind(h.k.gate)
    h.k.gate.decide = ((input) => { actions.push(input.action); return decide(input) }) as typeof h.k.gate.decide
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(scheduleStarted).toBe(false)
    expect(actions).toEqual([])
    releaseCurrent.resolve()
    await blocker
    for (let i = 0; i < 200 && !scheduleStarted; i++) await new Promise((resolve) => setTimeout(resolve, 1))
    expect(scheduleStarted).toBe(true)
    for (let i = 0; i < 200 && actions.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 1))
    expect(actions.slice(0, 2)).toEqual(['deadman_arm', 'open'])
    for (let i = 0; i < 200 && h.live.submitted.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 1))
    expect(h.live.submitted).toHaveLength(1)
    expect((await open).order?.status).toBe('filled')
    finishSchedule()
    await schedule
  })

  it('rechecks a cached reduction hint against fresh positions before allowing an open', async () => {
    h = await makeHarness()
    await h.k.risk.relax({ limits: { maxOrderNotional: asDecimal('50'), duplicateIntentWindowSec: 0 } as never }, await h.pinProof(), h.human('risk').origin)
    h.sim.positions.set(h.paper.accountId, [{ accountId: h.paper.accountId, instrumentId: BTC, side: 'long', size: asDecimal('0.001'), entryPrice: asDecimal('80000'), markPrice: asDecimal('80000'), notional: asDecimal('80'), unrealizedPnl: asDecimal('0'), realizedPnl: asDecimal('0'), leverage: 1, marginMode: 'cross', liquidationPrice: null, fundingSinceOpen: asDecimal('0'), openedAt: 0, updatedAt: 0 }])
    const agent = await makeAgent(h, 'paper')
    await h.k.trading.preview(rawIntent(h.paper.accountId, 'sell'), agent.ctx('order.preview'))
    h.sim.positions.set(h.paper.accountId, [])
    const queue = h.k.trading as unknown as QueueSeam
    const entered = deferred<void>(), releaseCurrent = deferred<void>()
    const blocker = queue.withAccountQueue(h.paper.accountId, async () => { entered.resolve(); await releaseCurrent.promise; return { done: undefined } }, 'normal')
    await entered.promise
    const observed: Array<{ action: string; side?: string; reduceOnly?: boolean }> = []
    const decide = h.k.gate.decide.bind(h.k.gate)
    h.k.gate.decide = ((input) => { observed.push({ action: input.action, ...(input.target.kind === 'order' ? { side: input.target.intent.side, reduceOnly: input.target.intent.reduceOnly } : {}) }); return decide(input) }) as typeof h.k.gate.decide
    const competingOpen = h.k.trading.place({ intent: rawIntent(h.paper.accountId, 'buy', '0.001', ETH) }, agent.ctx('order'))
    const staleHintOrder = h.k.trading.place({ intent: rawIntent(h.paper.accountId, 'sell') }, agent.ctx('order'))
    releaseCurrent.resolve()
    await blocker
    const [, first, hinted] = await Promise.all([blocker, competingOpen, staleHintOrder])
    expect(hinted.order?.status).toBe('denied')
    expect(hinted.order?.problem?.ruleHits).toContainEqual(expect.objectContaining({ code: 'ORDER_NOTIONAL', action: 'deny' }))
    expect(observed.slice(0, 2).map((entry) => `${entry.action}:${entry.side ?? ''}:${entry.reduceOnly === true}`)).toEqual(['open:sell:false', 'open:buy:false'])
    expect(hinted.order?.precheckId).toBeTruthy()
    expect(first.order?.status).toBe('denied')
  })
})
