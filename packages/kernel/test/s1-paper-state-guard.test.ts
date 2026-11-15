// SPDX-License-Identifier: CPAL-1.0
// S1（R3-05…R3-08）：纸面状态文件被删 / 截断 / 改值 / 写失败——拒绝使用并说人话，绝不新建空账、绝不覆盖原文件。
import { afterEach, describe, expect, it } from 'vitest'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { CRASH_PIN, makeCrashHarness, stopIntent } from './helpers/crash-points'
import type { CrashHarness, CrashWorld } from './helpers/crash-points'

let h: CrashHarness | undefined
afterEach(async () => { await h?.cleanup(); h = undefined })

const file = () => join(h!.home, 'paper-state.json')
const acctState = (w: CrashWorld) => w.k.tstate.effective([{ type: 'account', id: h!.paperAccountId() }])

async function withPosition(): Promise<CrashWorld> {
  h = await makeCrashHarness()
  const r = await h.world.k.trading.place({ intent: stopIntent(h.paperAccountId()) }, h.world.human)
  expect(r.order?.status).toBe('filled')
  await new Promise((resolve) => setImmediate(resolve)) // 让合并落盘的微任务跑完
  return h.world
}

async function expectRefused(w: CrashWorld, state: 'missing' | 'corrupt') {
  expect(w.k.paperStateHealth().state).toBe(state)
  expect(w.k.paperStateTrusted()).toBe(false)
  const st = acctState(w)
  expect(st.state).toBe('HALTED')
  expect(st.reasons[0]!.reason).toMatch(/纸面状态文件和账本对不上/)
  expect(w.k.healthSnapshot().stateFiles).toContainEqual({ kind: 'paper-state', state })
  expect(w.k.status().warnings).toEqual(expect.arrayContaining([expect.stringMatching(/paper state file refused/)]))
  // 不建空账户：读不到 10000 的「新」账户
  await expect(w.k.bus.snapshot(w.k.accounts.get(h!.paperAccountId()), { maxAgeMs: 0 })).rejects.toThrow()
  const placed = await w.k.trading.place({ intent: stopIntent(h!.paperAccountId(), { size: '0.002' as never }) }, w.human).catch((e: unknown) => e)
  expect(JSON.stringify(placed)).not.toMatch(/"status":"filled"/)
}

describe('S1 paper state integrity', () => {
  it('missing file with prior fills refuses to rebuild', async () => {
    await withPosition()
    h!.kill()
    renameSync(file(), `${file()}.bak`)
    const w = await h!.restart()
    await expectRefused(w, 'missing')
    expect(existsSync(file())).toBe(false)
    await w.k.tickOnce()
    expect(existsSync(file())).toBe(false)
  })

  it('truncated file is never overwritten, even after the 60s save and shutdown flush', async () => {
    await withPosition()
    h!.kill()
    const b = readFileSync(file())
    writeFileSync(file(), b.subarray(0, b.length - 1))
    const size = statSync(file()).size
    const w = await h!.restart()
    await expectRefused(w, 'corrupt')
    expect(w.k.paperStateHealth().reason).toMatch(/截断|JSON/)
    h!.market.now += 70_000
    await w.k.tickOnce()
    expect(statSync(file()).size).toBe(size)
    await w.k.stop()
    expect(statSync(file()).size).toBe(size)
    h!.world.dead = true
  })

  it('digest mismatch (tampered cash) refuses import', async () => {
    await withPosition()
    h!.kill()
    const raw = readFileSync(file(), 'utf8')
    const tampered = raw.replace(/"cash":\{"\$b":"(\d)/, (_m, d: string) => `"cash":{"$b":"${(Number(d) + 1) % 10}`)
    expect(tampered).not.toBe(raw)
    writeFileSync(file(), tampered)
    const w = await h!.restart()
    await expectRefused(w, 'corrupt')
    expect(w.k.paperStateHealth().reasonEn).toMatch(/digest/)
    expect(readFileSync(file(), 'utf8')).toBe(tampered)
  })

  it('an older file whose sequence numbers are behind the ledger is refused even without a recorded digest', async () => {
    h = await makeCrashHarness()
    const before = readFileSync(file(), 'utf8')
    await h.world.k.trading.place({ intent: stopIntent(h.paperAccountId()) }, h.world.human)
    h.kill()
    writeFileSync(file(), before)
    const db = new DatabaseSync(join(h.home, 'data', 'gitrader.sqlite'))
    db.prepare("DELETE FROM meta WHERE key IN ('paper_state','paper_state_pending')").run() // 模拟升级前的老 home：库里还没有摘要
    db.close()
    const w = await h.restart()
    await expectRefused(w, 'corrupt')
    expect(w.k.paperStateHealth().reasonEn).toMatch(/older than the ledger/)
  })

  it('restoring the original file is accepted again and resume works with PIN', async () => {
    await withPosition()
    h!.kill()
    renameSync(file(), `${file()}.bak`)
    let w = await h!.restart()
    await expectRefused(w, 'missing')
    const proof = w.k.pin.isSet() ? await w.k.auth.pinProof(w.human.principal, CRASH_PIN) : await w.k.auth.setupPin(w.human.principal, CRASH_PIN)
    await expect(w.k.takeover.resume({ type: 'account', id: h!.paperAccountId() }, 'test', proof, w.human)).rejects.toMatchObject({ problem: { name: 'TRADING_STATE' } })
    h!.kill()
    renameSync(`${file()}.bak`, file())
    w = await h!.restart()
    expect(w.k.paperStateHealth().state).toBe('ok')
    const proof2 = await w.k.auth.pinProof(w.human.principal, CRASH_PIN)
    await w.k.takeover.resume({ type: 'account', id: h!.paperAccountId() }, 'restored', proof2, w.human)
    expect(acctState(w).state).toBe('ACTIVE')
    const snap = await w.k.bus.snapshot(w.k.accounts.get(h!.paperAccountId()), { maxAgeMs: 0 })
    expect(snap.positions).toHaveLength(1)
  })

  it('save failure sets dirty, retries, warns in receipt', async () => {
    h = await makeCrashHarness()
    const w = h.world
    rmSync(file())
    mkdirSync(file()) // 目录占住文件名：原子写的 rename 必失败
    const r = await w.k.trading.place({ intent: stopIntent(h.paperAccountId()) }, w.human)
    await new Promise((resolve) => setImmediate(resolve))
    const r2 = await w.k.trading.place({ intent: stopIntent(h.paperAccountId(), { size: '0.002' as never }) }, w.human)
    expect(w.k.paperStateHealth().dirty).toBe(true)
    expect([...(r.warnings ?? []), ...(r2.warnings ?? [])]).toContain('state_not_persisted')
    expect(w.k.healthSnapshot().warnings).toContain('paper state is not persisted yet (retrying)')
    rmSync(file(), { recursive: true, force: true })
    const deadline = Date.now() + 10_000
    while (w.k.paperStateHealth().dirty && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100))
    expect(w.k.paperStateHealth().dirty).toBe(false)
    expect(existsSync(file())).toBe(true)
    expect([...w.k.ledger.iterate()].some((e) => (e.payload as { kind?: string } | undefined)?.kind === 'paper.state_persisted')).toBe(true)
    // 再杀再启：持仓与账本成交数一致
    h.kill()
    const w2 = await h.restart()
    expect(w2.k.paperStateHealth().state).toBe('ok')
    const snap = await w2.k.bus.snapshot(w2.k.accounts.get(h.paperAccountId()), { maxAgeMs: 0 })
    const fills = w2.k.orders.fills({ accountId: h.paperAccountId() })
    const longSize = fills.reduce((s, f) => s + (f.side === 'buy' ? Number(f.size) : -Number(f.size)), 0)
    expect(Number(snap.positions[0]?.size ?? 0)).toBeCloseTo(longSize, 8)
  })

  it('fresh home without fills still creates account from config', async () => {
    h = await makeCrashHarness()
    expect(h.world.k.paperStateHealth().state).toBe('fresh')
    const snap = await h.world.k.bus.snapshot(h.world.k.accounts.get(h.paperAccountId()), { maxAgeMs: 0 })
    expect(Number(snap.equity)).toBeGreaterThan(0)
    const w = await h.restart()
    expect(w.k.paperStateHealth().state).toBe('ok')
    expect(acctState(w).state).toBe('ACTIVE')
  })

  it('keeps one previous good copy next to the file', async () => {
    await withPosition()
    expect(existsSync(`${file()}.prev`)).toBe(true)
    copyFileSync(`${file()}.prev`, join(h!.home, 'prev-copy.json'))
    expect(JSON.parse(readFileSync(join(h!.home, 'prev-copy.json'), 'utf8')).v).toBe(1)
  })
})
