// SPDX-License-Identifier: CPAL-1.0
// D4 / ADR-19（R3-21 R3-22）：受限钥匙的自保只平自己的仓、只收紧自己的授权书；人面全平照旧平全部。
import { afterEach, describe, expect, it } from 'vitest'
import { CRASH_PIN, makeCrashHarness } from './helpers/crash-points'
import type { CrashHarness } from './helpers/crash-points'
import type { ActorCtx } from '../src/trading'
import type { OrderIntent } from '../src/proto'

let h: CrashHarness | undefined
afterEach(async () => { await h?.cleanup(); h = undefined })

async function paperAgent(h: CrashHarness, name: string): Promise<{ ctx: ActorCtx; mandateId: string }> {
  const w = h.world
  const proof = w.k.pin.isSet() ? await w.k.auth.pinProof(w.human.principal, CRASH_PIN) : await w.k.auth.setupPin(w.human.principal, CRASH_PIN)
  const r = w.k.agents.createKey({ name, host: 'other', tier: 'paper', mandate: { accounts: [h.paperAccountId()] } as never }, proof, w.human.origin)
  const principal = w.k.auth.authenticateToken(r.token)!
  return { ctx: { principal, origin: w.k.auth.originFor(principal, 'order', 'mcp', '11111111-2222-4333-8444-55555555555' + name.length) }, mandateId: r.mandate.mandateId }
}

const open = (acct: string, instrumentId: string, size: string): OrderIntent => ({ accountId: acct, instrumentId, side: 'buy', type: 'market', size, reason: 'd4', tpsl: { grouping: 'order', stopLoss: { triggerPrice: instrumentId.endsWith('BTC') ? '78000' : '3400' } } } as unknown as OrderIntent)

describe('D4 restricted takeover scope', () => {
  async function twoOwners() {
    h = await makeCrashHarness()
    const acct = h.paperAccountId()
    const a = await paperAgent(h, 'agent-a')
    const b = await paperAgent(h, 'agent-bb')
    expect((await h.world.k.trading.place({ intent: open(acct, 'hyperliquid:BTC', '0.001') }, a.ctx)).order?.status).toBe('filled')
    h.market.now += 6_000
    h.market.setPrice('hyperliquid:BTC', 80000.5); h.market.setPrice('hyperliquid:ETH', 3500.5)
    expect((await h.world.k.trading.place({ intent: open(acct, 'hyperliquid:ETH', '0.01') }, b.ctx)).order?.status).toBe('filled')
    return { acct, a, b }
  }

  it('restricted agent flattens only its own instrument, skips the foreign one, tightening stays on its mandate', async () => {
    const { acct, a, b } = await twoOwners()
    const k = h!.world.k
    const rec = await k.takeover.execute({ level: 'flatten_all', scope: { type: 'account', id: acct }, reason: 'self protect' }, a.ctx)
    expect(rec.skipped).toEqual([{ accountId: acct, instrumentId: 'hyperliquid:ETH', reason: 'not_authorized' }])
    expect(rec.remaining).toEqual([])
    const snap = await k.bus.snapshot(k.accounts.get(acct), { maxAgeMs: 0 })
    expect(snap.positions.map((p) => p.instrumentId)).toEqual(['hyperliquid:ETH'])
    expect(k.tstate.get({ type: 'account', id: acct })).toBe('ACTIVE')
    expect(k.tstate.get({ type: 'mandate', id: a.mandateId })).not.toBe('ACTIVE')
    expect(k.tstate.get({ type: 'mandate', id: b.mandateId })).toBe('ACTIVE')
    // B 仍能正常下单
    h!.market.now += 6_000
    h!.market.setPrice('hyperliquid:ETH', 3500.5)
    const again = await k.trading.place({ intent: open(acct, 'hyperliquid:ETH', '0.02') }, b.ctx) // 换个数量：避开重复意图规则
    expect({ status: again.order?.status, why: again.order?.problem?.message }).toMatchObject({ status: 'filled' })
  })

  it('human flatten_all still closes everything', async () => {
    const { acct } = await twoOwners()
    const k = h!.world.k
    const proof = await k.auth.pinProof(h!.world.human.principal, CRASH_PIN)
    const rec = await k.takeover.execute({ level: 'flatten_all', scope: { type: 'account', id: acct }, reason: 'human flatten' }, { ...h!.world.human, proof })
    expect(rec.skipped).toBeUndefined()
    const snap = await k.bus.snapshot(k.accounts.get(acct), { maxAgeMs: 0 })
    expect(snap.positions).toHaveLength(0)
  })
})
