// SPDX-License-Identifier: CPAL-1.0
// S1 / ADR-16：纸面状态坏了之后按账本重建——重建后现金 = 账本推算（初始 + Σ已实现 − Σ手续费 + Σ资金费），持仓与止损挂单都在。
import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { CRASH_PIN, makeCrashHarness, stopIntent } from './helpers/crash-points'
import type { CrashHarness } from './helpers/crash-points'
import { PaperVenue } from '../../venue-paper/src/venue'
import { paperLedgerFacts, rebuildPaperStateFromLedger } from '../src/paper-rebuild'
import * as d from '../src/util/dec'

let h: CrashHarness | undefined
afterEach(async () => { await h?.cleanup(); h = undefined })

const file = () => join(h!.home, 'paper-state.json')

describe('S1 rebuild-from-ledger', () => {
  it('rebuilt equity equals the ledger expectation, positions and the live stop survive', async () => {
    h = await makeCrashHarness()
    const acct = h.paperAccountId()
    let w = h.world
    expect((await w.k.trading.place({ intent: stopIntent(acct, { size: '0.002' as never }) }, w.human)).order?.status).toBe('filled')
    h.market.setPrice('hyperliquid:BTC', 80500)
    expect((await w.k.trading.place({ intent: { accountId: acct, instrumentId: 'hyperliquid:BTC', side: 'sell', type: 'market', size: '0.001', reduceOnly: true, reason: 'take some profit' } as never }, w.human)).order?.status).toBe('filled')
    await new Promise((r) => setImmediate(r))
    const before = JSON.parse(readFileSync(file(), 'utf8')) as { accounts: Array<{ cash: { $b: string } }> }
    const { expectations } = paperLedgerFacts(w.k)
    h.kill()
    // 坏掉：截断
    const raw = readFileSync(file())
    writeFileSync(file(), raw.subarray(0, raw.length - 3))
    w = await h.restart()
    expect(w.k.paperStateHealth().state).toBe('corrupt')
    // 停服务（这里直接用这台没注册纸面状态的内核做离线重建）
    const r = rebuildPaperStateFromLedger(w.k, (facts) => new PaperVenue({ market: h!.market, clock: () => h!.market.now }).rebuildFromLedgerFacts(facts as never))
    expect(r.backup).toBeDefined()
    expect(existsSync(r.backup!)).toBe(true)
    expect(readdirSync(h.home).some((f) => f.startsWith('paper-state.json.corrupt-'))).toBe(true)
    expect([...w.k.ledger.iterate()].some((e) => (e.payload as { kind?: string } | undefined)?.kind === 'paper.rebuilt')).toBe(true)
    w = await h.restart()
    expect(w.k.paperStateHealth().state).toBe('ok')
    const exp = r.expectations.find((x) => x.accountId === acct)!
    expect(exp).toMatchObject({ cash: expectations.find((x) => x.accountId === acct)!.cash, netSize: { 'hyperliquid:BTC': '0.001' } })
    const after = JSON.parse(readFileSync(file(), 'utf8')) as { accounts: Array<{ id: string; cash: { $b: string } }> }
    const fxScale = 10n ** 18n
    const cash = (v: { $b: string }) => d.D(`${BigInt(v.$b) / fxScale}.${(BigInt(v.$b) % fxScale).toString().padStart(18, '0')}`)
    expect(d.eq(cash(after.accounts.find((a) => a.id === acct)!.cash), d.D(exp.cash))).toBe(true)
    // 重建前的现金（内核真算的）与账本推算一致到 1e-6：重建没有丢钱也没多出钱
    expect(d.lte(d.abs(d.sub(cash(before.accounts[0]!.cash), d.D(exp.cash))), d.D('0.000001'))).toBe(true)
    const audit = w.k.paperAudit()
    expect(audit.accounts.find((a) => a.accountId === acct)).toMatchObject({ ok: true, diffs: [] })
    const snap = await w.k.bus.snapshot(w.k.accounts.get(acct), { maxAgeMs: 0 })
    expect(snap.positions[0]).toMatchObject({ side: 'long' })
    expect(Number(snap.positions[0]!.size)).toBeCloseTo(0.001, 9)
    expect(w.paper.orders(acct, { live: true }).filter((o) => o.reduceOnly && o.type === 'stop_market')).toHaveLength(1)
    // 账户仍停着（坏过的状态要人确认）；PIN 恢复后能交易
    const proof = w.k.pin.isSet() ? await w.k.auth.pinProof(w.human.principal, CRASH_PIN) : await w.k.auth.setupPin(w.human.principal, CRASH_PIN)
    await w.k.takeover.resume({ type: 'account', id: acct }, 'rebuilt from ledger', proof, w.human)
    h.market.now += 6_000 // 开仓冷却 5 s
    h.market.setPrice('hyperliquid:BTC', 80500)
    expect((await w.k.trading.place({ intent: stopIntent(acct, { size: '0.001' as never }) }, w.human)).order?.status).toBe('filled')
    expect(w.k.ledger.verify().ok).toBe(true)
  })
})
