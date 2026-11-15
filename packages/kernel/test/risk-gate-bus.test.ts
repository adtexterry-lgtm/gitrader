// SPDX-License-Identifier: CPAL-1.0
import { describe, expect, it } from 'vitest'
import { canonicalize, type GateAction, type GateTarget, type GateTicket } from '@gitrader/protocol'
import { loadGateConformanceCases } from '../../protocol/conformance/risk-gate/load'
import { ConnectorBus } from '../src/connector'
import { FakeClock } from '../src/util/clock'
import type { Account } from '../src/proto'
import { FakeConnector, BTC } from './helpers/fake-connector'

const source = loadGateConformanceCases()[0]!.input.account as Account
const account = (): Account => ({ ...structuredClone(source), mode: 'paper', venue: 'hyperliquid', owner: source.owner ?? {} })
const ticket = (ticketId = 'tk-test'): GateTicket => ({ ticketId, precheckId: 'pck_test', bootId: 'boot-test', accountId: source.accountId, action: 'open', targetDigest: 'sha256:test', issuedAt: 1, expiresAt: 30_001, sig: 'sig' })

function harness(expected?: { action: GateAction; target: GateTarget }) {
  const clock = new FakeClock(1_000)
  const connector = new FakeConnector({ id: 'kernel-sim', clock })
  const bus = new ConnectorBus(clock)
  bus.register(connector)
  const consumed: { ticket?: GateTicket; accountId: string; action: GateAction; target: GateTarget }[] = []
  const violations: { accountId: string; action: GateAction; problem: { code?: number }; ticketId?: string }[] = []
  const used = new Set<string>()
  bus.setGateAuthority({ consume(t: GateTicket | undefined, accountId: string, action: GateAction, target: GateTarget) {
    if (!t || used.has(t.ticketId)) throw Object.assign(new Error('invalid ticket'), { problem: { code: 2010 } })
    if (expected && (action !== expected.action || canonicalize(target) !== canonicalize(expected.target))) throw Object.assign(new Error('wrong target'), { problem: { code: 2010 } })
    used.add(t.ticketId); consumed.push({ ticket: t, accountId, action, target })
    return { precheckId: t.precheckId, ticketId: t.ticketId, expiresAt: t.expiresAt }
  } } as never, (v) => { violations.push(v) })
  return { clock, connector, bus, consumed, violations }
}

const intent = (extra: Record<string, unknown> = {}) => ({ accountId: source.accountId, instrumentId: BTC, side: 'buy', type: 'limit', size: '1', price: '80000', tif: 'gtc', clientOrderId: 'cl-test', ...extra }) as never

describe('ConnectorBus ticket guard', () => {
  it('rejects a missing ticket before any connector method is reached for every write', async () => {
    const { bus, connector, violations } = harness()
    const writes = [
      () => bus.submit(account(), intent()),
      () => bus.cancel(account(), { instrumentId: BTC, orderId: 'ord-test', clientOrderId: 'cl-test' } as never),
      () => bus.cancelAll(account()),
      () => bus.scheduleCancel(account(), 2_000),
      () => bus.setLeverage(account(), BTC, 2, 'cross'),
      () => bus.amend(account(), intent()),
    ]
    for (const write of writes) await expect(write()).rejects.toMatchObject({ problem: { code: 2010 } })
    expect(connector.submitted).toHaveLength(0)
    expect(connector.cancelCalls).toHaveLength(0)
    expect(connector.cancelAllCalls).toHaveLength(0)
    expect(connector.scheduleCalls).toHaveLength(0)
    expect(connector.accountStateCalls).toBe(0)
    expect(connector.openOrdersCalls).toBe(0)
    expect(violations).toHaveLength(6)
    expect(() => bus.setGateAuthority({ consume: () => undefined } as never)).toThrow()
  })

  it('binds actual submit arguments and places consumed metadata in TradeContext', async () => {
    const { bus, connector, consumed } = harness()
    const t = ticket()
    await bus.submit(account(), intent({ reduceOnly: true }), { ticket: t } as never)
    expect(consumed[0]).toMatchObject({ ticket: t, action: 'reduce', target: { kind: 'order', intent: { clientOrderId: 'cl-test', reduceOnly: true } } })
    expect(connector.submitted[0]?.ctx.gate).toEqual({ precheckId: 'pck_test', ticketId: 'tk-test', expiresAt: 30_001 })
    await expect(bus.submit(account(), intent(), { ticket: t } as never)).rejects.toMatchObject({ problem: { code: 2010 } })
    expect(connector.submitted).toHaveLength(1)
  })

  it('rejects a ticket bound to different actual arguments before connector invocation', async () => {
    const expectedIntent = intent()
    const { bus, connector } = harness({ action: 'open', target: { kind: 'order', intent: expectedIntent } as never })
    await expect(bus.submit(account(), intent({ size: '2' }), { ticket: ticket('tk-bound') } as never)).rejects.toMatchObject({ problem: { code: 2010 } })
    expect(connector.submitted).toHaveLength(0)
  })

  it('allows only one concurrent submit to consume the same ticket', async () => {
    const { bus, connector } = harness()
    const t = ticket('tk-race')
    const results = await Promise.allSettled([
      bus.submit(account(), intent(), { ticket: t } as never),
      bus.submit(account(), intent(), { ticket: t } as never),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1)
    expect(connector.submitted).toHaveLength(1)
  })

  it('requires bound cancel IDs and passes the bound venue ID through to the connector', async () => {
    const { bus, connector, consumed } = harness()
    await expect(bus.cancel(account(), { instrumentId: BTC, venueOrderId: 'vo-unbound' })).rejects.toMatchObject({ problem: { code: 2010 } })
    await bus.cancel(account(), { instrumentId: BTC, orderId: 'ord-test', clientOrderId: 'cl-test', venueOrderId: 'vo-test', tpslRole: 'tp' } as never, { ticket: ticket() } as never)
    expect(consumed[0]?.action).toBe('cancel')
    expect(consumed[0]?.target).toEqual({ kind: 'cancel', targets: [{ orderId: 'ord-test', clientOrderId: 'cl-test', tpslRole: 'tp' }] })
    expect(connector.cancelCalls[0]?.[0]).toEqual({ instrumentId: BTC, clientOrderId: 'cl-test', venueOrderId: 'vo-test' })
    expect(connector.cancelContexts[0]?.gate?.ticketId).toBe('tk-test')
  })

  it('audits missing or whitespace-only canonical cancel IDs once before connector calls', async () => {
    const { bus, connector, violations } = harness()
    await expect(bus.cancel(account(), { instrumentId: BTC, clientOrderId: 'cl-test' }, { ticket: undefined })).rejects.toMatchObject({ problem: { code: 2010 } })
    await expect(bus.cancel(account(), { instrumentId: BTC, orderId: '  ', clientOrderId: 'cl-test' }, { ticket: undefined })).rejects.toMatchObject({ problem: { code: 2010 } })
    await expect(bus.cancel(account(), { instrumentId: BTC, orderId: 'ord-test', clientOrderId: '   ' }, { ticket: undefined })).rejects.toMatchObject({ problem: { code: 2010 } })
    expect(violations).toHaveLength(3)
    expect(connector.cancelCalls).toHaveLength(0)
  })

  it('guards cancel-all, schedule arm/disarm, leverage, and amend with their actual operation targets', async () => {
    const { bus, connector, consumed } = harness()
    await bus.cancelAll(account(), { keepProtective: false, instrumentId: BTC, ticket: ticket() } as never)
    await bus.scheduleCancel(account(), null, undefined, ticket('tk-disarm'))
    await bus.scheduleCancel(account(), 2_000, undefined, ticket('tk-arm'))
    await bus.setLeverage(account(), BTC, 3, 'isolated', { ticket: ticket('tk-lev') } as never)
    await bus.amend(account(), intent({ size: '2' }), { ticket: ticket('tk-amend') } as never)
    expect(consumed.map((x) => [x.action, x.target.kind])).toEqual([['cancel_protective', 'cancel_all'], ['deadman_disarm', 'deadman'], ['deadman_arm', 'deadman'], ['leverage', 'leverage'], ['amend', 'order']])
    expect(connector.scheduleCalls.map((x) => x.atMs)).toEqual([null, 2_000])
    expect(connector.scheduleGateCalls.map((x) => x.ctxGate?.ticketId)).toEqual(['tk-disarm', 'tk-arm'])
    expect(connector.leverageCalls[0]).toMatchObject({ instrumentId: BTC, leverage: 3, marginMode: 'isolated' })
    expect(connector.leverageCalls[0]?.ctx.gate?.ticketId).toBe('tk-lev')
    expect(connector.amendCalls[0]?.ctx.gate?.ticketId).toBe('tk-amend')
    expect(connector.cancelAllContexts[0]?.gate?.ticketId).toBe('tk-test')
  })

  it('preserves stop-loss orders while canceling take-profit and ordinary orders', async () => {
    const { bus, connector } = harness()
    const a = account()
    connector.orders.push(
      { venueOrderId: 'vo-sl', clientOrderId: 'cl-sl', accountId: a.accountId, instrumentId: BTC, side: 'sell', type: 'stop_market', size: '1', price: null, reduceOnly: true, isTrigger: true, status: 'open', createdAt: 1 },
      { venueOrderId: 'vo-tp', clientOrderId: 'cl-tp', accountId: a.accountId, instrumentId: BTC, side: 'sell', type: 'take_limit', size: '1', price: '81000', reduceOnly: true, isTrigger: true, status: 'open', createdAt: 1 },
      { venueOrderId: 'vo-limit', clientOrderId: 'cl-limit', accountId: a.accountId, instrumentId: BTC, side: 'buy', type: 'limit', size: '1', price: '79000', reduceOnly: false, isTrigger: false, status: 'open', createdAt: 1 },
    )
    await bus.cancelAll(a, { ticket: ticket() } as never)
    expect(connector.orders.filter((o) => o.status === 'open').map((o) => o.clientOrderId)).toEqual(['cl-sl'])
  })
})
