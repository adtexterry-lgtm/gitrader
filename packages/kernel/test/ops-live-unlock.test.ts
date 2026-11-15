// SPDX-License-Identifier: CPAL-1.0
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Principal } from '../src/auth'
import type { OrderIntent } from '../src/proto'
import { BTC } from './helpers/fake-connector'
import { enableLive, makeAgent, makeHarness, TEST_PIN } from './helpers/harness'
import type { Harness } from './helpers/harness'

let h: Harness
beforeEach(async () => { h = await makeHarness() })
afterEach(async () => { await h.cleanup() })

const intent = (accountId: string = h.liveAcct.accountId, overrides: Partial<OrderIntent> = {}): OrderIntent => ({
  accountId: accountId as OrderIntent['accountId'], instrumentId: BTC, side: 'buy', type: 'market',
  size: '0.001' as OrderIntent['size'], reason: 'manual unlock regression', ...overrides,
})
const stopIntent = (accountId = h.liveAcct.accountId): OrderIntent => intent(accountId, {
  side: 'sell', type: 'stop_market', triggerPrice: '75000' as OrderIntent['triggerPrice'], reduceOnly: true,
})
const call = (name: string, params: Record<string, unknown>, pin?: string, principal: Principal = h.session): Promise<unknown> =>
  h.k.ops.call(h.k, name, { principal, params, transport: 'ws', kind: 'command', ...(pin === undefined ? {} : { pin }) })
const unlocks = () => h.k.ledger.query({ types: ['session.unlocked'] })
const liveCounts = () => ({
  submitted: h.live.submitted.length, cancelled: h.live.cancelCalls.length, cancelledAll: h.live.cancelAllCalls.length,
})
const openLive = async (): Promise<void> => {
  await enableLive(h)
  expect((await h.k.trading.place({ intent: intent() }, h.human())).order?.status).toBe('filled')
}
const pendingLive = async (): Promise<string> => {
  await enableLive(h)
  const result = await h.k.trading.place({ intent: intent(h.liveAcct.accountId, { type: 'limit', price: '79000' as OrderIntent['price'] }) }, h.human())
  expect(result.order?.status).toBe('open')
  return result.order!.orderId
}

describe('manual live commands unlock through the human router', () => {
  it.each(['position.close', 'order.place', 'order.cancel', 'order.cancel_all'])(
    '%s requires PIN before any trading side effects while locked', async (name) => {
      const orderId = name === 'order.cancel' || name === 'order.cancel_all' ? await pendingLive() : undefined
      if (orderId === undefined) await openLive()
      h.k.keystore.lock()
      const counts = liveCounts()
      const ledgerBefore = [...h.k.ledger.iterate()]
      const params = name === 'order.place'
        ? { intent: stopIntent() }
        : { accountId: h.liveAcct.accountId, instrumentId: BTC, ...(name === 'order.cancel' ? { orderId } : {}) }

      await expect(call(name, params)).rejects.toMatchObject({ problem: { code: 1010, name: 'ATTESTATION_REQUIRED' } })

      expect(h.k.keystore.isUnlocked()).toBe(false)
      expect(liveCounts()).toEqual(counts)
      expect(unlocks()).toHaveLength(0)
      expect([...h.k.ledger.iterate()]).toEqual(ledgerBefore)
    },
  )

  it('rejects a wrong PIN without unlocking or submitting a close', async () => {
    await openLive()
    h.k.keystore.lock()
    const counts = liveCounts()

    await expect(call('position.close', { accountId: h.liveAcct.accountId, instrumentId: BTC }, TEST_PIN.split('').reverse().join('')))
      .rejects.toMatchObject({ problem: { code: 5003, name: 'AUTH_FAILED' } })

    expect(h.k.keystore.isUnlocked()).toBe(false)
    expect(liveCounts()).toEqual(counts)
    expect(unlocks()).toHaveLength(0)
  })

  it('unlocks and records ui presence before submitting a reduce-only market close', async () => {
    await openLive()
    h.k.keystore.lock()
    const submitted = h.live.submitted.length

    await expect(call('position.close', { accountId: h.liveAcct.accountId, instrumentId: BTC }, TEST_PIN))
      .resolves.toMatchObject({ order: { status: 'filled', reduceOnly: true, type: 'market' } })

    expect(h.k.keystore.isUnlocked()).toBe(true)
    expect(h.live.submitted).toHaveLength(submitted + 1)
    expect(h.live.submitted.at(-1)).toMatchObject({ signed: true, intent: { reduceOnly: true, type: 'market' } })
    expect(unlocks()).toHaveLength(1)
    expect(unlocks()[0]!.payload).toMatchObject({ via: 'ui' })
    const submittedEntry = h.k.ledger.query({ types: ['order.submitted'] })[0]!
    expect(unlocks()[0]!.seq).toBeLessThan(submittedEntry.seq)
  })

  it('unlocks and cancels the requested live order with the correct PIN', async () => {
    const orderId = await pendingLive()
    h.k.keystore.lock()
    const cancelled = h.live.cancelCalls.length

    await expect(call('order.cancel', { accountId: h.liveAcct.accountId, orderId }, TEST_PIN)).resolves.toEqual({ ok: true })

    expect(h.k.keystore.isUnlocked()).toBe(true)
    expect(h.live.cancelCalls).toHaveLength(cancelled + 1)
    expect(h.live.orders[0]!.status).toBe('cancelled')
    expect(unlocks()).toHaveLength(1)
    expect(unlocks()[0]!.payload).toMatchObject({ via: 'ui' })
  })

  it.each(['position.close', 'order.place'])('%s on paper needs no PIN and leaves the keystore locked', async (name) => {
    await enableLive(h)
    expect((await h.k.trading.place({ intent: intent(h.paper.accountId) }, h.human())).order?.status).toBe('filled')
    h.k.keystore.lock()
    const submitted = h.sim.submitted.length
    const params = name === 'order.place'
      ? { intent: stopIntent(h.paper.accountId) }
      : { accountId: h.paper.accountId, instrumentId: BTC }

    await expect(call(name, params)).resolves.toMatchObject({ order: { status: name === 'order.place' ? 'untriggered' : 'filled' } })

    expect(h.sim.submitted).toHaveLength(submitted + 1)
    expect(h.k.keystore.isUnlocked()).toBe(false)
    expect(unlocks()).toHaveLength(0)
  })

  it('places a live order without PIN when the keystore is already unlocked', async () => {
    await enableLive(h)
    await expect(call('order.place', { intent: intent() })).resolves.toMatchObject({ order: { status: 'filled' } })
    expect(h.live.submitted).toHaveLength(1)
    expect(h.k.keystore.isUnlocked()).toBe(true)
    expect(unlocks()).toHaveLength(0)
  })

  it('keeps the original signer error when PIN has never been set', async () => {
    expect(h.k.pin.isSet()).toBe(false)
    expect(h.k.keystore.isUnlocked()).toBe(false)
    // signerFor checks the lock before resolving a wallet; no wallet or PIN fixture is needed.
    // Trading preserves this failure on the rejected order instead of throwing it from place.
    await expect(call('order.place', { intent: intent() })).resolves.toMatchObject({
      order: { status: 'rejected', problem: { name: 'VENUE_AUTH', message: 'keystore is locked: unlock it with your PIN before live trading' } },
    })
    expect(h.k.pin.isSet()).toBe(false)
    expect(h.k.keystore.isUnlocked()).toBe(false)
    expect(h.live.submitted).toHaveLength(0)
    expect(unlocks()).toHaveLength(0)
  })

  it('preview remains read-only even with a valid human PIN proof', async () => {
    await enableLive(h)
    h.k.keystore.lock()
    const proof = await h.k.auth.pinProof(h.session, TEST_PIN, 'ui')

    await expect(h.k.trading.preview(intent(), { ...h.human(), proof })).resolves.toMatchObject({ precheck: { verdict: 'allow' } })

    expect(h.k.keystore.isUnlocked()).toBe(false)
    expect(h.live.submitted).toHaveLength(0)
    expect(unlocks()).toHaveLength(0)
  })

  it('rejects an Agent principal carrying the correct PIN before unlocking', async () => {
    await openLive()
    const agent = await makeAgent(h, 'confirm')
    h.k.keystore.lock()
    const counts = liveCounts()

    await expect(call('position.close', { accountId: h.liveAcct.accountId, instrumentId: BTC }, TEST_PIN, agent.principal))
      .rejects.toMatchObject({ problem: { name: 'AUTH_FAILED' } })

    expect(h.k.keystore.isUnlocked()).toBe(false)
    expect(liveCounts()).toEqual(counts)
    expect(unlocks()).toHaveLength(0)
  })

  it('rejects a service principal carrying the correct PIN before unlocking', async () => {
    await openLive()
    h.k.keystore.lock()
    const counts = liveCounts()
    await expect(call('position.close', { accountId: h.liveAcct.accountId, instrumentId: BTC }, TEST_PIN, { kind: 'service' }))
      .rejects.toMatchObject({ problem: { name: 'AUTH_FAILED' } })
    expect(h.k.keystore.isUnlocked()).toBe(false)
    expect(liveCounts()).toEqual(counts)
    expect(unlocks()).toHaveLength(0)
  })

  it('keeps the missing-intent error ahead of account and PIN checks', async () => {
    await enableLive(h)
    h.k.keystore.lock()
    await expect(call('order.place', {})).rejects.toMatchObject({ problem: { name: 'INVALID_PARAMS', message: 'intent is required' } })
    expect(h.k.keystore.isUnlocked()).toBe(false)
    expect(unlocks()).toHaveLength(0)
  })

  it('keeps the missing-account error for cancellation', async () => {
    await expect(call('order.cancel', {})).rejects.toMatchObject({ problem: { name: 'ACCOUNT_NOT_BOUND', message: 'no such account: undefined' } })
    expect(unlocks()).toHaveLength(0)
  })

  it('keeps the unknown-account error before asking for a PIN', async () => {
    await enableLive(h)
    h.k.keystore.lock()
    await expect(call('order.place', { intent: intent('missing-account') }))
      .rejects.toMatchObject({ problem: { name: 'ACCOUNT_NOT_BOUND', message: 'no such account: missing-account' } })
    expect(h.k.keystore.isUnlocked()).toBe(false)
    expect(unlocks()).toHaveLength(0)
  })
})
