// SPDX-License-Identifier: CPAL-1.0
import { afterEach, describe, expect, it } from 'vitest'
import { makeHarness, makeAgent } from './helpers/harness'
import type { Harness } from './helpers/harness'
import type { Fill, LedgerEntry, Order } from '../src/proto'

let h: Harness | undefined
const TS = 1_798_761_600_000

async function view(name: string, params: Record<string, unknown>, principal = h!.session): Promise<unknown> {
  return h!.k.ops.call(h!.k, name, { principal, params, transport: 'ws', kind: 'query' })
}

function order(id: string, accountId = h!.paper.accountId, createdAt = TS, overrides: Partial<Order> = {}): Order {
  return {
    orderId: id as never, clientOrderId: `client-${id}`, accountId, instrumentId: 'hyperliquid:BTC' as never,
    side: 'buy', type: 'limit', tif: 'gtc', size: '5' as never, filledSize: '2' as never,
    price: '10' as never, status: 'partially_filled', fee: '0.01' as never,
    origin: h!.human('order.test').origin, createdAt, updatedAt: createdAt, ...overrides,
  }
}

function fill(id: string, orderId: string, accountId = h!.paper.accountId, ts = TS): Fill {
  return {
    fillId: id as never, orderId: orderId as never, clientOrderId: `client-${orderId}`, venueFillId: `venue-${id}`,
    accountId, instrumentId: 'hyperliquid:BTC' as never, side: 'buy', price: '10' as never, size: '2' as never,
    fee: '0.01' as never, feeCcy: 'USD', liquidity: 'maker', realizedPnl: '0' as never, ts,
  }
}

function addOrder(value: Order): void { h!.k.orders.upsert(value, '20', true) }
function addFill(value: Fill): void { expect(h!.k.orders.insertFill(value)).toBe(true) }

afterEach(async () => { await h?.cleanup(); h = undefined })

describe('B2-04A real read views', () => {
  it('account.assets returns balances and margin from one routed snapshot; empty balances are valid', async () => {
    h = await makeHarness()
    const ts = TS
    const balance = { accountId: h.paper.accountId, asset: 'USD', total: '50.00', available: '45.00', hold: '5.00', ts }
    let calls = 0
    h.sim.accountState = async () => { calls++; return { balances: [balance], margin: null, ts } as never }
    const result = await view('account.assets', { accountId: h.paper.accountId }) as { accountId: string; balances: unknown[]; margin: unknown; ts: number }
    expect(result).toEqual({ accountId: h.paper.accountId, balances: [balance], margin: null, ts })
    expect(calls).toBe(1)

    h.sim.accountState = async () => ({ balances: [], margin: null, ts } as never)
    await expect(view('account.assets', { accountId: h.paper.accountId })).resolves.toMatchObject({ balances: [], margin: null, ts })
    await expect(view('account.assets', { accountId: 'acct_unknown' })).rejects.toMatchObject({ problem: { name: 'ACCOUNT_NOT_BOUND' } })
    const agent = await makeAgent(h, 'read_only')
    await expect(view('account.assets', { accountId: h.paper.accountId }, agent.principal)).rejects.toMatchObject({ problem: { name: 'AUTH_FAILED' } })
    expect(calls).toBe(1)
  })

  it('account.assets rejects stale, truncated, not-ok and connector failures instead of returning empty balances', async () => {
    h = await makeHarness()
    for (const failure of [{ stale: true }, { truncated: true }, { ok: false }]) {
      h.sim.accountState = async () => ({ balances: [], margin: null, ts: TS, ...failure } as never)
      await expect(view('account.assets', { accountId: h.paper.accountId })).rejects.toMatchObject({ problem: { name: 'DATA_UNAVAILABLE' } })
    }
    h.sim.accountState = async () => { throw new Error('fixture connector failure') }
    await expect(view('account.assets', { accountId: h.paper.accountId })).rejects.toThrow()
  })

  it('records.query fills retain the real partial order state and joined attribution', async () => {
    h = await makeHarness()
    const proposalId = 'prop_sample' as never
    const row = order('ord_partial', h.paper.accountId, TS, { proposalId })
    addOrder(row)
    addFill(fill('fill_partial', row.orderId, row.accountId))
    addFill(fill('fill_orphan', 'ord_missing', row.accountId))
    const direct = order('ord_direct', row.accountId, TS, { proposalId: undefined })
    addOrder(direct)
    addFill(fill('fill_direct', direct.orderId, row.accountId))
    const blankProposalId = 'prop_blank' as never
    const blankProposalOrder = order('ord_blank_ticket', row.accountId, TS, { proposalId: blankProposalId })
    addOrder(blankProposalOrder)
    addFill(fill('fill_blank_ticket', blankProposalOrder.orderId, row.accountId))
    for (const ticket of ['', '   ', '\t\r\n\v\f']) {
      h.k.ledger.append({
        type: 'proposal.decided', origin: row.origin,
        subject: { proposalId, ticket: ticket as never, accountId: row.accountId }, payload: { decision: 'approved' },
      })
    }
    h.k.ledger.append({
      type: 'proposal.decided', origin: row.origin,
      subject: { proposalId, ticket: 'T-PROPOSAL-0001', accountId: row.accountId }, payload: { decision: 'approved' },
    })
    for (const ticket of ['', ' \t\r\n']) {
      h.k.ledger.append({
        type: 'proposal.decided', origin: row.origin,
        subject: { proposalId: blankProposalId, ticket: ticket as never, accountId: row.accountId }, payload: { decision: 'approved' },
      })
    }
    h.k.ledger.append({
      type: 'order.accepted', origin: row.origin,
      subject: { accountId: row.accountId, orderId: row.orderId }, payload: { status: 'partially_filled', gate: { ticketId: 'T-20261022-0001' } },
    })
    h.k.ledger.append({
      type: 'order.accepted', origin: direct.origin,
      subject: { accountId: direct.accountId, orderId: direct.orderId }, payload: { gate: { ticketId: 'T-GATE-ONLY-0001' } },
    })

    const fills = await view('records.query', { kind: 'fill', accountId: row.accountId, actorType: 'human' }) as { items: Array<Record<string, unknown>> }
    expect(fills.items).toHaveLength(3)
    expect(fills.items.find((item) => item.fillId === 'fill_partial')).toMatchObject({ fillId: 'fill_partial', origin: row.origin, proposalId, ticket: 'T-PROPOSAL-0001' })
    expect(fills.items.find((item) => item.fillId === 'fill_direct')).not.toHaveProperty('ticket')
    expect(fills.items.find((item) => item.fillId === 'fill_blank_ticket')).not.toHaveProperty('ticket')
    const orphan = await view('records.query', { kind: 'fill', accountId: row.accountId, instrumentId: 'hyperliquid:BTC', sinceTs: TS, untilTs: TS + 1 }) as { items: Array<Record<string, unknown>> }
    expect(orphan.items).toHaveLength(4)
    expect(orphan.items.find((item) => item.fillId === 'fill_orphan')).toMatchObject({ origin: null })
    await expect(view('records.query', { kind: 'fill', accountId: row.accountId, untilTs: TS })).resolves.toMatchObject({ items: [] })

    const orders = await view('records.query', { kind: 'order', accountId: row.accountId }) as { items: Order[] }
    expect(orders.items[0]).toEqual(row)
    expect(orders.items[0]).toMatchObject({ status: 'partially_filled', size: '5', filledSize: '2' })
  })

  it('records.query uses stable same-time cursors and binds them to filters', async () => {
    h = await makeHarness()
    for (const id of ['fill_a', 'fill_b', 'fill_c']) {
      const row = order(`ord_${id}`)
      addOrder(row)
      addFill(fill(id, row.orderId))
    }
    const first = await view('records.query', { kind: 'fill', accountId: h.paper.accountId, limit: 2 }) as { items: Array<{ fillId: string }>; next?: string }
    expect(first.items.map((item) => item.fillId)).toEqual(['fill_c', 'fill_b'])
    expect(first.next).toEqual(expect.any(String))
    const second = await view('records.query', { kind: 'fill', accountId: h.paper.accountId, limit: 2, cursor: first.next }) as { items: Array<{ fillId: string }>; next?: string }
    expect(second.items.map((item) => item.fillId)).toEqual(['fill_a'])
    expect(second.next).toBeUndefined()
    await expect(view('records.query', { kind: 'fill', accountId: h.liveAcct.accountId, limit: 2, cursor: first.next })).rejects.toMatchObject({ problem: { name: 'INVALID_PARAMS' } })
    await expect(view('records.query', { kind: 'fill', accountId: h.paper.accountId, limit: 2, cursor: 'not-a-valid-cursor!' })).rejects.toMatchObject({ problem: { name: 'INVALID_PARAMS' } })
  })

  it('records.query validates filters and filters before paging across more than 1000 unrelated rows', async () => {
    h = await makeHarness()
    for (let i = 0; i < 1001; i++) addOrder(order(`ord_noise_${String(i).padStart(4, '0')}`, h.paper.accountId, TS - i))
    const target = order('ord_target', h.liveAcct.accountId, TS - 5)
    addOrder(target)
    const result = await view('records.query', { kind: 'order', accountId: h.liveAcct.accountId, limit: 1 }) as { items: Order[] }
    expect(result.items).toEqual([target])
    for (const params of [
      { kind: 'unknown' }, { kind: 'order', limit: 0 }, { kind: 'order', limit: 501 }, { kind: 'order', limit: 1.5 },
      { kind: 'fill', sinceTs: -1 }, { kind: 'fill', sinceTs: TS + 1, untilTs: TS }, { kind: 'fill', actorType: 'robot' },
      { kind: 'fill', accountId: ' ' },
    ]) await expect(view('records.query', params)).rejects.toMatchObject({ problem: { name: 'INVALID_PARAMS' } })
    await expect(view('records.query', { kind: 'fill', sinceTs: TS, untilTs: TS })).resolves.toMatchObject({ items: [] })
    await expect(view('records.query', { kind: 'fill', accountId: 'acct_missing' })).resolves.toMatchObject({ items: [] })
  })

  it('records.query funding returns the actual append-only ledger entry', async () => {
    h = await makeHarness()
    const entry: LedgerEntry = h.k.ledger.append({
      type: 'funding', origin: h.human('funding.test').origin,
      subject: { accountId: h.paper.accountId, instrumentId: 'hyperliquid:BTC' as never },
      payload: { payment: '-0.25', ccy: 'USD' },
    })
    const result = await view('records.query', { kind: 'funding', accountId: h.paper.accountId }) as { items: LedgerEntry[] }
    expect(result.items).toEqual([entry])
    await expect(view('records.query', { kind: 'order', accountId: h.liveAcct.accountId })).resolves.toMatchObject({ items: [] })
  })
})
