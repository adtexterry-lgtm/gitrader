// SPDX-License-Identifier: CPAL-1.0
// K3（R3-03）：批准途中被杀，重启后提案不再停在 approved / executing；不自动重放任何订单。
import { afterEach, describe, expect, it } from 'vitest'
import { CRASH_PIN, makeCrashHarness, settle, stopIntent } from './helpers/crash-points'
import type { CrashHarness, CrashPoint } from './helpers/crash-points'
import { APPROVED_EXECUTE_WINDOW_MS } from '../src/trading'

let h: CrashHarness | undefined
afterEach(async () => { await h?.cleanup(); h = undefined })

async function proposal(h: CrashHarness) {
  const w = h.world
  const proof = w.k.pin.isSet() ? await w.k.auth.pinProof(w.human.principal, CRASH_PIN) : await w.k.auth.setupPin(w.human.principal, CRASH_PIN)
  const r = w.k.agents.createKey({ name: 'k3-confirm', host: 'other', tier: 'confirm', mandate: { accounts: [h.paperAccountId()], venueAllowlist: ['hyperliquid'], instrumentAllowlist: ['hyperliquid:BTC'], limits: { maxOrderNotional: '500', maxDailyNotional: '2000' } } as never }, proof, w.human.origin)
  const principal = w.k.auth.authenticateToken(r.token)!
  const ctx = { principal, origin: w.k.auth.originFor(principal, 'propose', 'mcp', '11111111-2222-4333-8444-555555555555') }
  const p = await w.k.trading.propose({ accountId: h.paperAccountId(), intents: [{ ...stopIntent(h.paperAccountId()), reason: 'k3' }], reason: 'k3' }, ctx)
  expect(p.status).toBe('pending')
  return p
}

async function crashApprove(point: CrashPoint) {
  h = await makeCrashHarness()
  const p = await proposal(h)
  const crashed = h.arm(point)
  const approving = settle(h.world.k.trading.approve(p.ticket, h.world.sessionProof(), h.world.human))
  await Promise.race([crashed, approving])
  if (!h.world.dead) h.kill()
  await approving
  const w = await h.restart()
  return { p, w, entries: () => [...w.k.ledger.iterate()] }
}

describe('K3 interrupted proposals converge', () => {
  it.each(Array.from({ length: 10 }, (_, i) => i))('approve save and ledger append are atomic (run %i)', async () => {
    const { p, w, entries } = await crashApprove('afterProposalApprovedSaved')
    // 崩在同一个事务里：两样都没落下，提案仍待批，可以再批
    expect(w.k.trading.getProposal(p.proposalId)?.status).toBe('pending')
    expect(entries().filter((e) => e.type === 'proposal.decided')).toHaveLength(0)
    expect(w.k.orders.list({ accountId: h!.paperAccountId() })).toHaveLength(0)
  })

  it('crash right after proposal.decided inside the approve transaction rolls back to pending', async () => {
    const { p, w, entries } = await crashApprove('afterProposalDecidedLedger')
    expect(w.k.trading.getProposal(p.proposalId)?.status).toBe('pending')
    expect(entries().filter((e) => e.type === 'proposal.decided')).toHaveLength(0)
  })

  it('approved without ledger record (left by an older kernel) is completed then expired, not replayed', async () => {
    h = await makeCrashHarness()
    const p = await proposal(h)
    const w0 = h.world
    w0.k.docs.put('proposal', p.proposalId, { ...w0.k.trading.getProposal(p.proposalId)!, status: 'approved', decision: { by: 'user:usr_local', at: h.market.now, attestation: { method: 'session', by: 'usr_local', at: h.market.now, digest: p.intentsDigest, sig: 'x' } } })
    const w = await h.restart()
    const entries = [...w.k.ledger.iterate()]
    expect(w.k.trading.getProposal(p.proposalId)?.status).toBe('expired')
    expect(entries.find((e) => e.type === 'proposal.decided')?.payload).toMatchObject({ decision: 'approved', recovered: true })
    expect(entries.some((e) => e.type === 'proposal.expired' && (e.payload as { reason?: string }).reason === 'interrupted')).toBe(true)
    expect(w.k.orders.list({ accountId: h.paperAccountId() })).toHaveLength(0)
  })

  it('executing without orders fails as interrupted and is not replayed', async () => {
    const { p, w, entries } = await crashApprove('afterOrderSubmittedTx')
    // 杀在下单的第一个事务之后：订单是 submitted 孤儿 → K2 收敛为 rejected；提案按订单终态走 execute_fail
    const after = w.k.trading.getProposal(p.proposalId)!
    expect(after.status).toBe('failed')
    expect(entries().filter((e) => e.type === 'order.intent')).toHaveLength(1)
    expect(w.k.orders.list({ accountId: h!.paperAccountId() }).filter((o) => o.status === 'filled')).toHaveLength(0)
    expect(w.k.trading.listProposals({ status: 'approved' })).toHaveLength(0)
    expect(w.k.trading.listProposals({ status: 'executing' })).toHaveLength(0)
  })

  it('executing with a filled order becomes executed', async () => {
    const { p, w } = await crashApprove('beforeRecordChildren')
    expect(w.k.trading.getProposal(p.proposalId)?.status).toBe('executed')
    expect(w.k.orders.list({ accountId: h!.paperAccountId() }).filter((o) => o.status === 'filled' && !o.parentOrderId)).toHaveLength(1)
  })

  it('a stale approved proposal expires by execute window in tick', async () => {
    h = await makeCrashHarness()
    const p = await proposal(h)
    const w = h.world
    const doc = { ...w.k.trading.getProposal(p.proposalId)!, status: 'approved' as const, decision: { by: 'user:usr_local', at: h.market.now } }
    w.k.docs.put('proposal', p.proposalId, doc)
    h.market.now += APPROVED_EXECUTE_WINDOW_MS + 1000
    await w.k.trading.tick()
    expect(w.k.trading.getProposal(p.proposalId)?.status).toBe('expired')
    expect([...w.k.ledger.iterate()].some((e) => e.type === 'proposal.expired' && (e.payload as { reason?: string }).reason === 'execute_window')).toBe(true)
  })
})
