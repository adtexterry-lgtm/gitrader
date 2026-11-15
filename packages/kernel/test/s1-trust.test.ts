// SPDX-License-Identifier: CPAL-1.0
import { afterEach, expect, it } from 'vitest'
import { makeAgent, makeHarness } from './helpers/harness'
import type { Harness } from './helpers/harness'
import { BTC } from './helpers/fake-connector'
import { newClientOrderId, newId } from '../src/util/ids'
import type { Fill } from '../src/proto'
import { writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { ORG_SCOPE } from '../src/trading-state'

let h: Harness | undefined
afterEach(async () => { await h?.cleanup() })

it('keeps confirm-tier paper opening proposals pending without sending an order', async () => {
  h = await makeHarness()
  const agent = await makeAgent(h, 'confirm')
  const p = await h.k.trading.propose({ accountId: h.paper.accountId, reason: 'paper approval rehearsal', intents: [{ accountId: h.paper.accountId, instrumentId: BTC, side: 'buy', type: 'limit', size: '0.001', price: '80000', clientOrderId: newClientOrderId() }] as never }, agent.ctx())
  expect(p.status).toBe('pending')
  expect(h.k.orders.list({ accountId: h.paper.accountId })).toHaveLength(0)
})

it('routes a different agent reducing a human position into approval even through direct place', async () => {
  h = await makeHarness()
  await h.k.trading.place({ intent: { accountId: h.paper.accountId, instrumentId: BTC, side: 'buy', type: 'market', size: '0.001', clientOrderId: newClientOrderId() } as never }, h.human())
  const before = h.sim.submitted.length
  const agent = await makeAgent(h, 'confirm')
  const result = await h.k.trading.place({ intent: { accountId: h.paper.accountId, instrumentId: BTC, side: 'sell', type: 'market', size: '0.001', reason: 'reduce another actor position', clientOrderId: newClientOrderId() } as never }, agent.ctx())
  expect(result.proposal?.status).toBe('pending')
  expect(result.problem?.name).toBe('NEEDS_APPROVAL')
  expect(h.sim.submitted).toHaveLength(before)
})

it('latches kill before any locked wallet failure through a human session', async () => {
  h = await makeHarness()
  await h.pinProof()
  h.k.keystore.lock()
  await expect(h.k.ops.call(h.k, 'kill', { principal: h.session, params: { reason: 's1 human session kill' }, transport: 'http' }))
    .rejects.toMatchObject({ problem: { name: 'VENUE_AUTH' } })
  expect(h.k.tstate.get(ORG_SCOPE)).toBe('HALTED')
  expect(h.k.keystore.isUnlocked()).toBe(false)
  const requested = [...h.k.ledger.iterate()].find((e) => e.type === 'takeover.requested')
  expect(requested?.origin).toMatchObject({ actor: 'user:usr_local', actorType: 'human' })
  expect(Object.hasOwn(requested?.payload ?? {}, 'actorClass')).toBe(false)
  expect(Object.hasOwn(requested?.payload ?? {}, 'originActorType')).toBe(false)
})

it('latches the HALT file and does not resume when the file is removed', async () => {
  h = await makeHarness()
  const file = join(h.home, 'HALT')
  writeFileSync(file, '')
  await expect.poll(() => h!.k.tstate.get(ORG_SCOPE)).toBe('HALTED')
  unlinkSync(file)
  await new Promise((resolve) => setTimeout(resolve, 30))
  expect(h.k.tstate.get(ORG_SCOPE)).toBe('HALTED')
})

it('reports a conflicting fill id in the ledger and preserves the original fill', async () => {
  h = await makeHarness()
  const placed = await h.k.trading.place({ intent: { accountId: h.paper.accountId, instrumentId: BTC, side: 'buy', type: 'limit', size: '0.001', price: '80000', clientOrderId: newClientOrderId() } as never }, h.human())
  const o = placed.order!
  const fill: Fill = { fillId: newId('fill'), orderId: o.orderId, clientOrderId: o.clientOrderId, accountId: o.accountId, instrumentId: o.instrumentId, venueFillId: 's1-fill', price: '80000', size: '0.001', fee: '0', feeCcy: 'USDC', realizedPnl: '0', side: 'buy', liquidity: 'maker', ts: h.clock.now() } as Fill
  expect(h.k.trading.applyFill(fill)).toBe(true)
  expect(h.k.trading.applyFill({ ...fill, fillId: newId('fill') })).toBe(false)
  expect(() => h!.k.trading.applyFill({ ...fill, fillId: newId('fill'), price: '81000' as Fill['price'] })).toThrow('fill_id_conflict')
  expect(h.k.orders.fills({ accountId: o.accountId })).toHaveLength(1)
  expect(h.k.ledger.query({ types: ['annotation'], limit: 1 })[0]).toMatchObject({ type: 'annotation', payload: { reason: 'fill_id_conflict' } })
})
