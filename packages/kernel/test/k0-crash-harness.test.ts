// SPDX-License-Identifier: CPAL-1.0
// K0：崩溃点测试台自检。每个崩溃点：同 home 崩一次再启动，Kernel.create 能起、状态可观察、100 次重复稳定（不依赖墙钟）。
// 修复后的行为断言在 k1 / k2 / k3 / k4 各自的测试文件里；这里只验「台子」本身与崩溃后的原始落盘形态。
import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CRASH_PIN, makeCrashHarness, settle, stopIntent } from './helpers/crash-points'
import type { CrashHarness } from './helpers/crash-points'
import type { OrderIntent } from '../src/proto'

let h: CrashHarness | undefined
afterEach(async () => { await h?.cleanup(); h = undefined })

const paperFile = (home: string) => JSON.parse(readFileSync(join(home, 'paper-state.json'), 'utf8')) as { accounts: Array<{ orders: Array<{ role: string; status: string; waitingParent: boolean; filled: { $b: string } }> }> }

async function confirmAgent(h: CrashHarness) {
  const w = h.world
  const proof = w.k.pin.isSet() ? await w.k.auth.pinProof(w.human.principal, CRASH_PIN) : await w.k.auth.setupPin(w.human.principal, CRASH_PIN)
  const r = w.k.agents.createKey({ name: 'k0-confirm', host: 'other', tier: 'confirm', mandate: { accounts: [h.paperAccountId()], venueAllowlist: ['hyperliquid'], instrumentAllowlist: ['hyperliquid:BTC'], limits: { maxOrderNotional: '500', maxDailyNotional: '2000' } } as never }, proof, w.human.origin)
  const principal = w.k.auth.authenticateToken(r.token)!
  return { principal, origin: w.k.auth.originFor(principal, 'propose', 'mcp', '11111111-2222-4333-8444-555555555555') }
}

describe('K0 crash harness', () => {
  it('crash after order.submitted: restart works and the order is durable as submitted without a venue order', async () => {
    h = await makeCrashHarness()
    const crashed = h.arm('afterOrderSubmittedTx')
    const placed = settle(h.world.k.trading.place({ intent: stopIntent(h.paperAccountId()) }, h.world.human))
    await crashed
    const r = await placed
    expect(r.ok).toBe(false) // 死掉的内核：调用方看到 CrashError 或「database is not open」，都等于连接断开
    expect(String((r as { error: unknown }).error)).toMatch(/simulated kernel crash|database is not open/)
    const w = await h.restart()
    const ledger = [...w.k.ledger.iterate()].map((e) => e.type)
    expect(ledger).toContain('order.intent')
    expect(ledger).toContain('order.submitted')
    expect(w.k.ledger.verify().ok).toBe(true)
    expect(w.paper.orders(h.paperAccountId())).toHaveLength(0)
  })

  it('crash after the first venue event persisted: the venue fill is on disk, the kernel has no child order', async () => {
    h = await makeCrashHarness()
    const crashed = h.arm('afterVenueEvent', 1)
    const placed = settle(h.world.k.trading.place({ intent: stopIntent(h.paperAccountId()) }, h.world.human))
    await crashed
    await placed
    const state = paperFile(h.home)
    const parent = state.accounts[0]!.orders.find((o) => o.role === 'parent')!
    expect(parent.status).toBe('filled')
    const w = await h.restart()
    expect(w.k.ledger.verify().ok).toBe(true)
  })

  it('crash after bus.submit returned, before recordChildren', async () => {
    h = await makeCrashHarness()
    const crashed = h.arm('beforeRecordChildren')
    const placed = settle(h.world.k.trading.place({ intent: stopIntent(h.paperAccountId()) }, h.world.human))
    await crashed
    await placed
    const state = paperFile(h.home)
    expect(state.accounts[0]!.orders.find((o) => o.role === 'sl')).toMatchObject({ status: 'untriggered', waitingParent: false })
    const w = await h.restart()
    expect(w.k.ledger.verify().ok).toBe(true)
  })

  it.each(['afterProposalApprovedSaved', 'afterProposalDecidedLedger'] as const)('crash inside approve (%s): restart works', async (point) => {
    h = await makeCrashHarness()
    const agent = await confirmAgent(h)
    const intent: OrderIntent = { ...stopIntent(h.paperAccountId()), reason: 'k0 proposal' }
    const p = await h.world.k.trading.propose({ accountId: h.paperAccountId(), intents: [intent], reason: 'k0 proposal' }, agent)
    expect(p.status).toBe('pending')
    const crashed = h.arm(point)
    const approving = settle(h.world.k.trading.approve(p.ticket, h.world.sessionProof(), h.world.human))
    await crashed
    expect((await approving).ok).toBe(false)
    const w = await h.restart()
    expect(w.k.ledger.verify().ok).toBe(true)
    expect(w.k.trading.getProposal(p.proposalId)).toBeDefined()
  })

  // 缺省 20 轮（全套门禁里够快）；验收时用 K0_CYCLES=100 跑满 100 轮。
  const cycles = Number(process.env.K0_CYCLES ?? 20)
  it(`is deterministic: ${cycles} crash/restart cycles at afterOrderSubmittedTx never fail to boot`, async () => {
    h = await makeCrashHarness()
    let crashes = 0
    const states: string[] = []
    for (let i = 0; i < cycles; i++) {
      const crashed = h.arm('afterOrderSubmittedTx')
      const placed = settle(h.world.k.trading.place({ intent: stopIntent(h.paperAccountId(), { size: (0.001 + i * 0.00001).toFixed(5) as never }) }, h.world.human))
      // 订单没走到场所（例如被状态拒了）时崩溃点不会触发：那就手动杀，台子照样要能重启
      if (await Promise.race([crashed.then(() => true), placed.then(() => false)])) crashes++
      await placed
      await h.restart()
      states.push(h.world.k.tstate.effective([{ type: 'account', id: h.paperAccountId() }]).state)
      h.market.now += 1000
    }
    expect(h.world.k.ledger.verify().ok).toBe(true)
    // K2 之后：纸面孤儿单在重启时收敛，账户不再 HALTED，所以每一轮都能走到场所前的崩溃点
    expect({ crashes, halted: states.filter((s) => s === 'HALTED').length }).toEqual({ crashes: cycles, halted: 0 })
  }, 600_000)
})
