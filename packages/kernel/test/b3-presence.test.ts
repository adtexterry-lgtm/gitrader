// SPDX-License-Identifier: CPAL-1.0
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { asDecimal } from '@gitrader/protocol'
import type { OrderIntent, Position } from '../src/proto'
import * as d from '../src/util/dec'
import { systemOrigin } from '../src/util/origin'
import { BTC } from './helpers/fake-connector'
import { enableLive, makeAgent, makeHarness, TEST_PIN } from './helpers/harness'
import type { Harness } from './helpers/harness'

let h: Harness
let sessionToken = ''

beforeEach(async () => {
  h = await makeHarness()
  const started = await h.k.start({ port: 0 })
  sessionToken = h.k.auth.exchangeBoot(started.bootToken).sessionToken
  await h.pinProof()
})
afterEach(async () => { await h.cleanup() })
function serverUrl(protocol: 'http' | 'ws' = 'http'): string {
  const address = h.k.http?.server.address()
  if (!address || typeof address === 'string') throw new Error('HTTP server address unavailable')
  const host = address.address.includes(':') ? `[${address.address}]` : address.address
  return `${protocol}://${host}:${address.port}`
}

const api = async (name: string, params: unknown, pin?: string, token = sessionToken) => {
  const headers: Record<string, string> = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
  if (pin !== undefined) headers['x-gitrader-pin'] = pin
  const res = await fetch(`${serverUrl()}/api/op/${name}`, { method: 'POST', headers, body: JSON.stringify({ params }) })
  return { status: res.status, json: await res.json() as Record<string, any> } // eslint-disable-line @typescript-eslint/no-explicit-any
}

async function wsCommand(action: string, params: unknown, pin?: string): Promise<Record<string, any>> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const ws = new WebSocket(`${serverUrl('ws')}/ui`)
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true })
    ws.addEventListener('error', () => reject(new Error('ws error')), { once: true })
  })
  let id = 0
  const call = (method: string, params: unknown): Promise<Record<string, any>> => { // eslint-disable-line @typescript-eslint/no-explicit-any
    const requestId = ++id
    return new Promise((resolve, reject) => {
      const onMessage = (event: MessageEvent) => {
        const message = JSON.parse(String(event.data)) as Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
        if (message.id === requestId) { ws.removeEventListener('message', onMessage); resolve(message) }
      }
      ws.addEventListener('message', onMessage)
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }))
      ws.addEventListener('error', () => reject(new Error('ws error')), { once: true })
    })
  }
  try {
    await call('auth', { token: sessionToken, client: { name: 'b3-presence' } })
    return await call('command', {
      action,
      params,
      origin: { tool: `ui:${action}`, via: 'ui' },
      ...(pin === undefined ? {} : { attestation: { method: 'pin', pin } }),
    })
  } finally { ws.close() }
}

function longPosition(accountId: string, size = '0.01'): Position {
  return { accountId: accountId as never, instrumentId: BTC, side: 'long', size: asDecimal(size), entryPrice: asDecimal('80000'), markPrice: asDecimal('80000'), notional: asDecimal('800'), unrealizedPnl: asDecimal('0'), realizedPnl: asDecimal('0'), leverage: 1, marginMode: 'cross', liquidationPrice: null, fundingSinceOpen: asDecimal('0'), openedAt: 0, updatedAt: 0 }
}

const reduceIntent = (accountId = h.paper.accountId): OrderIntent => ({ accountId: accountId as never, instrumentId: BTC, side: 'sell', type: 'market', size: asDecimal('0.001'), reduceOnly: true, reason: 'B3 HALT reduction' })

const connectorPosition = async () => (await h.k.bus.snapshot(h.paper, { maxAgeMs: 0 })).positions.find((position) => position.instrumentId === BTC)

describe('B3 PIN presence reaches human trading operations', () => {
  it('allows an HTTP reduce-only order during HALT only with the correct PIN', async () => {
    h.sim.positions.set(h.paper.accountId, [longPosition(h.paper.accountId)])
    h.k.tstate.set({ type: 'account', id: h.paper.accountId }, 'HALTED', 'B3 fixture', h.human().origin)
    const submitted = h.sim.submitted.length
    const initialPosition = await connectorPosition()
    expect(initialPosition?.size).toBe('0.01')

    const missing = await api('order.place', { intent: reduceIntent() })
    expect(missing.status).toBe(401)
    expect(missing.json.error).toMatchObject({ code: 1010, name: 'ATTESTATION_REQUIRED' })
    expect(h.sim.submitted).toHaveLength(submitted)
    expect((await connectorPosition())?.size).toBe(initialPosition?.size)

    const wrong = await api('order.place', { intent: reduceIntent() }, '000000')
    expect(wrong.status).toBe(401)
    expect(wrong.json.error).toMatchObject({ code: 5003, name: 'AUTH_FAILED' })
    expect(h.sim.submitted).toHaveLength(submitted)
    expect((await connectorPosition())?.size).toBe(initialPosition?.size)

    const allowed = await api('order.place', { intent: reduceIntent() }, TEST_PIN)
    expect(allowed.status).toBe(200)
    expect(allowed.json.result.order.status).toBe('filled')
    expect(allowed.json.result.order.reduceOnly).toBe(true)
    expect(h.sim.submitted).toHaveLength(submitted + 1)
    expect(h.k.ledger.query({ types: ['order.submitted'] })).toHaveLength(1)
    const reducedPosition = await connectorPosition()
    expect(reducedPosition).toBeDefined()
    expect(d.cmp(d.D(reducedPosition!.size), d.ZERO)).toBeGreaterThanOrEqual(0)
    expect(d.cmp(d.D(reducedPosition!.size), d.D(initialPosition!.size))).toBeLessThan(0)
  })

  it('allows a WS position.close during HALT with PIN proof through OpRegistry', async () => {
    h.sim.positions.set(h.paper.accountId, [longPosition(h.paper.accountId)])
    h.k.tstate.set({ type: 'account', id: h.paper.accountId }, 'HALTED', 'B3 fixture', h.human().origin)
    const submitted = h.sim.submitted.length
    expect((await connectorPosition())?.size).toBe('0.01')

    const missing = await wsCommand('position.close', { accountId: h.paper.accountId, instrumentId: BTC })
    expect(missing.error.data).toMatchObject({ code: 1010, name: 'ATTESTATION_REQUIRED' })
    expect(h.sim.submitted).toHaveLength(submitted)
    expect((await connectorPosition())?.size).toBe('0.01')

    const allowed = await wsCommand('position.close', { accountId: h.paper.accountId, instrumentId: BTC }, TEST_PIN)
    expect(allowed.result.order.status).toBe('filled')
    expect(allowed.result.order.reduceOnly).toBe(true)
    expect(h.sim.submitted).toHaveLength(submitted + 1)
    expect((await h.k.bus.snapshot(h.paper, { maxAgeMs: 0 })).positions).toEqual([])
  })

  it('requires PIN to flatten an ACTIVE account and then clears the position', async () => {
    h.sim.positions.set(h.paper.accountId, [longPosition(h.paper.accountId)])
    const params = { reason: 'B3 active flatten', scope: { type: 'account', id: h.paper.accountId } }

    const missing = await api('takeover.flatten_all', params)
    expect(missing.status).toBe(401)
    expect(missing.json.error).toMatchObject({ code: 1010, name: 'ATTESTATION_REQUIRED' })
    expect(h.sim.submitted).toHaveLength(0)

    const allowed = await api('takeover.flatten_all', params, TEST_PIN)
    expect(allowed.status).toBe(200)
    expect(allowed.json.result.closeOrders).toBe(1)
    expect(h.sim.positions.get(h.paper.accountId)).toEqual([])
  })

  it('requires PIN to flatten a HALTED account and records the resulting order and fill', async () => {
    h.sim.positions.set(h.paper.accountId, [longPosition(h.paper.accountId)])
    h.k.tstate.set({ type: 'account', id: h.paper.accountId }, 'HALTED', 'B3 fixture', h.human().origin)
    const params = { reason: 'B3 halted flatten', scope: { type: 'account', id: h.paper.accountId } }
    const submitted = h.sim.submitted.length
    const initialPosition = await connectorPosition()
    expect(initialPosition?.size).toBe('0.01')

    const missing = await api('takeover.flatten_all', params)
    expect(missing.status).toBe(401)
    expect(missing.json.error).toMatchObject({ code: 1010, name: 'ATTESTATION_REQUIRED' })
    expect(h.sim.submitted).toHaveLength(submitted)
    expect((await connectorPosition())?.size).toBe(initialPosition?.size)

    const wrong = await api('takeover.flatten_all', params, '000000')
    expect(wrong.status).toBe(401)
    expect(wrong.json.error).toMatchObject({ code: 5003, name: 'AUTH_FAILED' })
    expect(h.sim.submitted).toHaveLength(submitted)
    expect((await connectorPosition())?.size).toBe(initialPosition?.size)

    const allowed = await api('takeover.flatten_all', params, TEST_PIN)
    expect(allowed.status).toBe(200)
    expect(allowed.json.result.closeOrders).toBe(1)
    expect(h.sim.submitted).toHaveLength(submitted + 1)
    const submittedIntent = h.sim.submitted[submitted]?.intent
    expect(submittedIntent).toMatchObject({ accountId: h.paper.accountId, instrumentId: BTC, side: 'sell', reduceOnly: true })
    expect((await h.k.bus.snapshot(h.paper, { maxAgeMs: 0 })).positions).toEqual([])

    const order = h.k.orders.list({ accountId: h.paper.accountId, limit: 1000 }).find((candidate) => candidate.accountId === h.paper.accountId && candidate.reduceOnly && candidate.side === 'sell')
    expect(order).toBeDefined()
    const persistedOrder = h.k.orders.get(order!.orderId)
    expect(persistedOrder).toMatchObject({ orderId: order!.orderId, accountId: h.paper.accountId, side: 'sell', reduceOnly: true, status: 'filled' })
    const fills = h.k.orders.fills({ accountId: h.paper.accountId, orderId: order!.orderId, limit: 1000 })
    expect(fills.length).toBeGreaterThan(0)
    expect(fills.every((fill) => fill.accountId === h.paper.accountId && fill.orderId === order!.orderId)).toBe(true)
    const orderEntries = h.k.ledger.query({ types: ['order.submitted'], accountId: h.paper.accountId, orderId: order!.orderId, limit: 1000 })
    const fillEntries = h.k.ledger.query({ types: ['fill'], accountId: h.paper.accountId, orderId: order!.orderId, limit: 1000 })
    expect(orderEntries.length).toBeGreaterThan(0)
    expect(fillEntries.length).toBeGreaterThan(0)
    expect([...orderEntries, ...fillEntries].every((entry) => entry.subject.accountId === h.paper.accountId && entry.subject.orderId === order!.orderId)).toBe(true)
  })

  it('uses the same HALT PIN rule for HTTP proposal approval', async () => {
    const agent = await makeAgent(h, 'auto_limited')
    const opened = await h.k.trading.place({ intent: { ...reduceIntent(), side: 'buy', reduceOnly: false } }, agent.ctx())
    expect(opened.order?.status).toBe('filled')
    h.k.tstate.set({ type: 'account', id: h.paper.accountId }, 'HALTED', 'B3 fixture', h.human().origin)
    const before = h.sim.submitted.length
    const proposed = await h.k.trading.place({ intent: reduceIntent() }, agent.ctx())
    expect(proposed.proposal?.status).toBe('pending')
    expect(h.sim.submitted).toHaveLength(before)

    const approved = await api('proposal.approve', { id: proposed.proposal!.proposalId }, TEST_PIN)
    expect(approved.status).toBe(200)
    expect(approved.json.result.status).toBe('executed')
    expect(h.sim.submitted).toHaveLength(before + 1)
  })

  it('rejects an agent opening during HALT and keeps the internal kill path available', async () => {
    const agent = await makeAgent(h, 'paper')
    h.k.tstate.set({ type: 'account', id: h.paper.accountId }, 'HALTED', 'B3 fixture', h.human().origin)
    const before = h.sim.submitted.length
    const opened = await h.k.trading.place({ intent: { ...reduceIntent(), side: 'buy', reduceOnly: false } }, agent.ctx())
    expect(opened.order?.status).toBe('denied')
    expect(h.sim.submitted).toHaveLength(before)

    await enableLive(h)
    const killed = await h.k.takeover.kill('B3 system stop', { principal: { kind: 'service' }, origin: systemOrigin('B3 system stop') })
    expect(killed.ok).toBe(true)
  })

  it('keeps ordinary ACTIVE orders on the session proof path without requiring PIN', async () => {
    const result = await api('order.place', { intent: { ...reduceIntent(), side: 'buy', reduceOnly: false } })
    expect(result.status).toBe(200)
    expect(result.json.result.order.status).toBe('filled')
    expect(h.sim.submitted).toHaveLength(1)
  })
})
