// SPDX-License-Identifier: CPAL-1.0
import { afterEach, describe, expect, it } from 'vitest'
import { asDecimal } from '@gitrader/protocol'
import { BTC } from './helpers/fake-connector'
import { makeAgent, makeHarness } from './helpers/harness'
import type { Harness } from './helpers/harness'
import { newClientOrderId } from '../src/util/ids'
import { mkOrigin } from '../src/util/origin'

let h: Harness | undefined
afterEach(async () => { await h?.cleanup(); h = undefined })

describe('X2C stale-price agent cancellation boundary', () => {
  it('keeps a fresh public agent cancel on the existing success path', async () => {
    h = await makeHarness()
    const agent = await makeAgent(h, 'auto_limited')
    const placed = await h.k.trading.place({ intent: {
      accountId: h.paper.accountId as never, instrumentId: BTC, side: 'buy', type: 'limit',
      size: asDecimal('0.001'), price: asDecimal('80000'), clientOrderId: newClientOrderId(), reason: 'X2C fresh cancel fixture',
    } }, agent.ctx())
    expect(['open', 'untriggered']).toContain(placed.order?.status)
    await expect(h.k.trading.cancel({ accountId: h.paper.accountId, orderId: placed.order!.orderId }, agent.ctx())).resolves.toMatchObject({ ok: true })
    expect(h.sim.cancelCalls).toHaveLength(1)
  })

  it('blocks a public agent cancel after its target mark expires and preserves the open order', async () => {
    h = await makeHarness()
    const agent = await makeAgent(h, 'auto_limited')
    const placed = await h.k.trading.place({ intent: {
      accountId: h.paper.accountId as never, instrumentId: BTC, side: 'buy', type: 'limit',
      size: asDecimal('0.001'), price: asDecimal('80000'), clientOrderId: newClientOrderId(), reason: 'X2C public cancel fixture',
    } }, agent.ctx())
    expect(['open', 'untriggered']).toContain(placed.order?.status)
    h.live.frozenMarkTs = h.clock.now() - 5_001
    await expect(h.k.trading.cancel({ accountId: h.paper.accountId, orderId: placed.order!.orderId }, agent.ctx()))
      .rejects.toMatchObject({ problem: { ruleHits: [expect.objectContaining({ code: 'STALE_PRICE', action: 'deny' })] } })
    expect(h.sim.cancelCalls).toHaveLength(0)
    expect(h.sim.orders.find((order) => order.clientOrderId === placed.order!.clientOrderId)?.status).toBe('open')
  })

  it('blocks cancel-all when one of two actual instrument marks is stale and records both witnesses', async () => {
    h = await makeHarness()
    const agent = await makeAgent(h, 'auto_limited')
    const place = async (instrumentId: typeof BTC | 'hyperliquid:ETH', price: string, size: string): Promise<string> => {
      const result = await h!.k.trading.place({ intent: {
        accountId: h!.paper.accountId as never, instrumentId: instrumentId as never, side: 'buy', type: 'limit',
        size: asDecimal(size), price: asDecimal(price), clientOrderId: newClientOrderId(), reason: 'X2C cancel-all fixture',
      } }, agent.ctx())
      if (!['open', 'untriggered'].includes(result.order?.status ?? '')) throw new Error(`cancel-all order fixture denied: ${JSON.stringify(result.order?.problem?.ruleHits?.map((hit) => hit.code))}`)
      return result.order!.clientOrderId
    }
    const btc = await place(BTC, '79000', '0.001')
    h.clock.advance(11_000)
    const eth = await place('hyperliquid:ETH', '2300', '0.01')
    const now = h.clock.now()
    const source = h.live as unknown as { mark: (id: string) => { price: string; ts: number; source: 'venue_mark' } }
    source.mark = (id) => ({ price: id === BTC ? '80000' : '2400', ts: now - (id === BTC ? 5_001 : 0), source: 'venue_mark' })
    await expect(h.k.trading.cancelAll({ accountId: h.paper.accountId }, agent.ctx()))
      .rejects.toMatchObject({ problem: { ruleHits: [expect.objectContaining({ code: 'STALE_PRICE', action: 'deny' })] } })
    expect(h.sim.cancelAllContexts).toHaveLength(0)
    expect(h.sim.cancelCalls).toHaveLength(0)
    expect(h.sim.orders.find((order) => order.clientOrderId === btc)?.status).toBe('open')
    expect(h.sim.orders.find((order) => order.clientOrderId === eth)?.status).toBe('open')
    const rejected = [...h.k.ledger.iterate()].reverse().find((entry) => entry.type === 'order.rejected')!
    const gate = (rejected.payload as { gate: { decision: { ruleHits: Array<{ code: string }> }; snapshot: { cancelPriceChecks?: Array<{ instrumentId: string; mark?: { ts: number } }> } } }).gate
    expect(gate.decision.ruleHits).toContainEqual(expect.objectContaining({ code: 'STALE_PRICE' }))
    expect(gate.snapshot.cancelPriceChecks?.map((check) => check.instrumentId)).toEqual([BTC, 'hyperliquid:ETH'])
    expect(gate.snapshot.cancelPriceChecks?.map((check) => check.mark?.ts)).toEqual([now - 5_001, now])
  })

  it('rejects an agent cancel when its price witness is missing', async () => {
    h = await makeHarness()
    const agent = await makeAgent(h, 'auto_limited')
    const placed = await h.k.trading.place({ intent: {
      accountId: h.paper.accountId as never, instrumentId: BTC, side: 'buy', type: 'limit',
      size: asDecimal('0.001'), price: asDecimal('80000'), clientOrderId: newClientOrderId(), reason: 'X2C missing mark fixture',
    } }, agent.ctx())
    expect(['open', 'untriggered']).toContain(placed.order?.status)
    const source = h.live as unknown as { mark: (_id: string) => undefined }
    source.mark = () => undefined
    await expect(h.k.trading.cancel({ accountId: h.paper.accountId, orderId: placed.order!.orderId }, agent.ctx()))
      .rejects.toMatchObject({ problem: { ruleHits: [expect.objectContaining({ code: 'STALE_PRICE', action: 'deny' })] } })
    expect(h.sim.cancelCalls).toHaveLength(0)
    expect(h.sim.orders.find((order) => order.clientOrderId === placed.order!.clientOrderId)?.status).toBe('open')
  })

  it('records cached stale-price warnings for human and trusted-system cancels', async () => {
    h = await makeHarness()
    const place = async (reason: string): Promise<string> => {
      const result = await h!.k.trading.place({ intent: {
        accountId: h!.paper.accountId as never, instrumentId: BTC, side: 'buy', type: 'limit',
        size: asDecimal('0.001'), price: asDecimal('80000'), clientOrderId: newClientOrderId(), reason,
      } }, h!.human())
      if (!['open', 'untriggered'].includes(result.order?.status ?? '')) throw new Error(`human/system order fixture denied: ${JSON.stringify(result.order?.problem?.ruleHits?.map((hit) => hit.code))}`)
      return result.order!.orderId
    }
    let markReads = 0
    let contextReads = 0
    const source = h.live as unknown as {
      mark?: (_id: string) => { price: string; ts: number; source: 'venue_mark' }
      context: (_id: string) => Promise<unknown>
    }
    source.context = async () => { contextReads += 1; return undefined }
    const system = { principal: { kind: 'service' as const }, origin: mkOrigin('system:kernel', 'cancel.system', 'internal') }
    source.mark = () => ({ price: '80000', ts: h!.clock.now(), source: 'venue_mark' })
    const systemOrder = await place('X2C system cancel fixture')
    source.mark = () => { markReads += 1; return { price: '80000', ts: h!.clock.now() - 5_001, source: 'venue_mark' } }
    await expect(h.k.trading.cancel({ accountId: h.paper.accountId, orderId: systemOrder }, system)).resolves.toMatchObject({ ok: true })
    expect(markReads).toBe(1)
    const systemEntry = [...h.k.ledger.iterate()].reverse().find((entry) => entry.type === 'order.cancelled' && entry.subject.orderId === systemOrder)!
    const systemGate = (systemEntry.payload as { gate: { decision: { precheckId: string; ruleHits: Array<{ code: string; action: string }>; applied: Array<{ code?: string; field?: string; from?: string; to?: string; unit?: string; kind?: string }>; targetDigest: string; adjustedTargetDigest: string } } }).gate
    const quote = h.k.bus.instrument(BTC)?.quote ?? 'quote'
    expect(systemGate.decision.ruleHits).toContainEqual(expect.objectContaining({ code: 'STALE_PRICE', action: 'warn' }))
    expect(systemGate.decision.applied).toContainEqual(expect.objectContaining({ code: 'STALE_PRICE', field: 'markPrice', from: '80000', to: '80000', unit: quote, kind: 'warning' }))
    expect(systemGate.decision.adjustedTargetDigest).toBe(systemGate.decision.targetDigest)
    expect(h.k.risk.replay(systemGate.decision.precheckId).status).toBe('identical')
    h.clock.advance(11_000)
    source.mark = () => ({ price: '80000', ts: h!.clock.now(), source: 'venue_mark' })
    const humanOrder = await place('X2C human cancel fixture')
    markReads = 0
    source.mark = () => { markReads += 1; return { price: '80000', ts: h!.clock.now() - 5_001, source: 'venue_mark' } }
    await expect(h.k.trading.cancel({ accountId: h.paper.accountId, orderId: humanOrder }, h.human())).resolves.toMatchObject({ ok: true })
    const humanEntry = [...h.k.ledger.iterate()].reverse().find((entry) => entry.type === 'order.cancelled' && entry.subject.orderId === humanOrder)!
    const humanGate = (humanEntry.payload as { gate: { decision: { precheckId: string; ruleHits: Array<{ code: string; action: string }>; applied: Array<{ code?: string; field?: string; from?: string; to?: string; unit?: string; kind?: string }>; targetDigest: string; adjustedTargetDigest: string } } }).gate
    expect(humanGate.decision.ruleHits).toContainEqual(expect.objectContaining({ code: 'STALE_PRICE', action: 'warn' }))
    expect(humanGate.decision.applied).toContainEqual(expect.objectContaining({ code: 'STALE_PRICE', field: 'markPrice', from: '80000', to: '80000', unit: quote, kind: 'warning' }))
    expect(humanGate.decision.adjustedTargetDigest).toBe(humanGate.decision.targetDigest)
    expect(h.k.risk.replay(humanGate.decision.precheckId).status).toBe('identical')
    expect(markReads).toBe(1)
    expect(contextReads).toBe(0)
    expect(h.sim.cancelCalls).toHaveLength(2)
  })

  it('allows human and trusted-system cancellation when the cached mark read fails', async () => {
    h = await makeHarness()
    h.live.frozenMarkTs = h.clock.now()
    const humanOrder = await h.k.trading.place({ intent: {
      accountId: h.paper.accountId as never, instrumentId: BTC, side: 'buy', type: 'limit',
      size: asDecimal('0.001'), price: asDecimal('80000'), clientOrderId: newClientOrderId(), reason: 'X2CW missing cache fixture',
    } }, h.human())
    h.clock.advance(11_000)
    h.live.frozenMarkTs = h.clock.now()
    const systemOrder = await h.k.trading.place({ intent: {
      accountId: h.paper.accountId as never, instrumentId: BTC, side: 'buy', type: 'limit',
      size: asDecimal('0.001'), price: asDecimal('80000'), clientOrderId: newClientOrderId(), reason: 'X2CW mark error fixture',
    } }, h.human())
    expect(['open', 'untriggered']).toContain(humanOrder.order?.status)
    expect(['open', 'untriggered']).toContain(systemOrder.order?.status)
    let contextReads = 0
    const source = h.live as unknown as { mark?: (_id: string) => never; context: (_id: string) => Promise<unknown> }
    source.mark = undefined
    source.context = () => { contextReads += 1; return new Promise<never>(() => undefined) }
    const system = { principal: { kind: 'service' as const }, origin: mkOrigin('system:kernel', 'cancel.system', 'internal') }
    let timeout: ReturnType<typeof setTimeout> | undefined
    const missing = await Promise.race([
      h.k.trading.cancel({ accountId: h.paper.accountId, orderId: humanOrder.order!.orderId }, h.human()),
      new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error('human cancel waited for unavailable context')), 100) }),
    ]).finally(() => { if (timeout) clearTimeout(timeout) })
    expect(missing).toMatchObject({ ok: true })
    source.mark = () => { throw new Error('cached mark read failed') }
    await expect(h.k.trading.cancel({ accountId: h.paper.accountId, orderId: systemOrder.order!.orderId }, system)).resolves.toMatchObject({ ok: true })
    expect(contextReads).toBe(0)
    expect(h.sim.cancelCalls).toHaveLength(2)
  })

  it('makes cache-only gateMark read once and never wait for connector refresh', async () => {
    h = await makeHarness()
    let contextReads = 0
    let markReads = 0
    const source = h.live as unknown as { mark?: (_id: string) => undefined; context: (_id: string) => Promise<unknown> }
    source.mark = undefined
    source.context = () => { contextReads += 1; return new Promise<never>(() => undefined) }
    let timeout: ReturnType<typeof setTimeout> | undefined
    const mark = await Promise.race([
      h.k.bus.gateMark(BTC, { allowStale: true, cacheOnly: true }),
      new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error('cache-only mark waited for context')), 100) }),
    ]).finally(() => { if (timeout) clearTimeout(timeout) })
    expect(mark).toBeUndefined()
    expect(contextReads).toBe(0)
    source.mark = () => { markReads += 1; return undefined }
    timeout = undefined
    const cachedMiss = await Promise.race([
      h.k.bus.gateMark(BTC, { allowStale: true, cacheOnly: true, deadline: performance.now() + 10_000 }),
      new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error('cache-only mark retried the synchronous cache read')), 100) }),
    ]).finally(() => { if (timeout) clearTimeout(timeout) })
    expect(cachedMiss).toBeUndefined()
    expect(markReads).toBe(1)
    expect(contextReads).toBe(0)
    source.mark = undefined
    const boundedFallback = await h.k.bus.gateMark(BTC, { allowStale: true, deadline: performance.now() + 20 })
    expect(boundedFallback).toBeUndefined()
    expect(contextReads).toBe(1)
  })
})
