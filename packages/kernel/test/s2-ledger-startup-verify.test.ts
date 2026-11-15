// SPDX-License-Identifier: CPAL-1.0
// S2（R3-09）：启动验账本链 + 成交投影；断链 / 投影不符 → 全局 HALTED 锁存（恢复时重验）；库文件不见 / 截断 / 打不开 → 拒绝启动说人话。
import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, readFileSync, rmSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { CRASH_PIN, makeCrashHarness, stopIntent } from './helpers/crash-points'
import type { CrashHarness } from './helpers/crash-points'
import { Kernel } from '../src/kernel'
import { fileProvider } from '../src/device-key'
import { FakeClock } from '../src/util/clock'
import { verifyLedgerDb } from '../src/ledger-integrity'
import { systemOrigin } from '../src/util/origin'
import { tx } from '../src/db'

let h: CrashHarness | undefined
afterEach(async () => { delete process.env.GITRADER_ACCEPT_NEW_LEDGER; await h?.cleanup(); h = undefined })

const dbPath = () => join(h!.home, 'data', 'gitrader.sqlite')
function tamper(sql: string[]): void {
  const db = new DatabaseSync(dbPath())
  for (const s of sql) db.exec(s)
  db.close()
}
const orgState = () => h!.world.k.tstate.effective([{ type: 'org', id: 'org_local' }])

async function tradedThenKilled(): Promise<void> {
  h = await makeCrashHarness()
  expect((await h.world.k.trading.place({ intent: stopIntent(h.paperAccountId()) }, h.world.human)).order?.status).toBe('filled')
  await new Promise((r) => setImmediate(r))
  h.kill()
}

describe('S2 ledger verification at startup', () => {
  it('broken chain at startup latches HALTED and resume re-verifies', async () => {
    await tradedThenKilled()
    tamper([
      'DROP TRIGGER ledger_no_update',
      `UPDATE ledger SET entry = replace(entry, '"size":"0.001"', '"size":"0.002"') WHERE type='fill'`,
      "CREATE TRIGGER ledger_no_update BEFORE UPDATE ON ledger BEGIN SELECT RAISE(ABORT, 'ledger is append-only'); END",
    ])
    const w = await h!.restart()
    const status = w.k.status() as { ledgerVerify: { ok: boolean; failure?: { seq: number; reason: string } }; tradingState: string }
    expect(status.ledgerVerify.ok).toBe(false)
    expect(status.tradingState).toBe('HALTED')
    expect(orgState().reasons[0]!.reason).toMatch(/账本哈希链在 seq \d+ 断开/)
    expect(w.k.healthSnapshot().ledgerVerify?.ok).toBe(false)
    const proof = w.k.pin.isSet() ? await w.k.auth.pinProof(w.human.principal, CRASH_PIN) : await w.k.auth.setupPin(w.human.principal, CRASH_PIN)
    await expect(w.k.takeover.resume({ type: 'org', id: 'org_local' }, 'try', proof, w.human)).rejects.toMatchObject({ problem: { name: 'TRADING_STATE' } })
    expect(orgState().state).toBe('HALTED')
    const placed = await w.k.trading.place({ intent: stopIntent(h!.paperAccountId(), { size: '0.002' as never }) }, w.human)
    expect(placed.order?.status).toBe('denied')
  })

  it('projection fill differing from ledger halts with named reason', async () => {
    await tradedThenKilled()
    tamper([`UPDATE fills SET doc = json_set(doc, '$.price', '1')`])
    const w = await h!.restart()
    const lv = w.k.healthSnapshot().ledgerVerify!
    expect(lv.ok).toBe(false)
    expect(lv.failure!.reason).toMatch(/^fill projection/)
    expect(orgState().reasons[0]!.reason).toMatch(/成交投影与账本不一致/)
  })

  it('missing ledger db with other state present refuses to create', async () => {
    await tradedThenKilled()
    for (const s of ['', '-wal', '-shm']) rmSync(dbPath() + s, { force: true })
    await expect(h!.restart()).rejects.toMatchObject({ problem: { name: 'STATE_FILE_CORRUPT', message: expect.stringMatching(/ledger database is missing.*账本数据库不见了/s) } })
    expect(existsSync(dbPath())).toBe(false)
    // R2-REL-11：纸面状态里有这笔成交留下的持仓时，光有 --accept-new-ledger 不放行，要再加 --reset-paper-state（命令行参数，测试里经 restart({ resetPaperState: true }) 传入）
    process.env.GITRADER_ACCEPT_NEW_LEDGER = '1'
    await expect(h!.restart()).rejects.toMatchObject({ problem: { name: 'STATE_FILE_CORRUPT', message: expect.stringContaining('--reset-paper-state') } })
    expect(existsSync(dbPath())).toBe(false)
    const w = await h!.restart({ resetPaperState: true })
    expect([...w.k.ledger.iterate()].some((e) => (e.payload as { kind?: string } | undefined)?.kind === 'ledger.restarted_empty')).toBe(true)
    expect(w.k.ledger.verify().ok).toBe(true)
  })

  it('truncated db gives a Chinese actionable error', async () => {
    await tradedThenKilled()
    tamper(['PRAGMA wal_checkpoint(TRUNCATE)'])
    const b = readFileSync(dbPath())
    writeFileSync(dbPath(), b.subarray(0, Math.floor(b.length / 2)))
    rmSync(dbPath() + '-wal', { force: true }); rmSync(dbPath() + '-shm', { force: true })
    const e = await h!.restart().then(() => undefined, (x: unknown) => x) as { problem?: { name: string; message: string } } | undefined
    if (e) {
      expect(e.problem?.name).toBe('STATE_FILE_CORRUPT')
      expect(e.problem?.message).toMatch(/账本数据库打不开|账本数据库不见了/)
      expect(e.problem?.message).toContain('gitrader.sqlite')
    } else {
      // SQLite 能打开前一半（页没坏到表头）时：验链必须抓到缺口
      expect(h!.world.k.healthSnapshot().ledgerVerify?.ok).toBe(false)
      expect(orgState().state).toBe('HALTED')
    }
  })

  it('clean 10k-entry ledger starts under budget', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gitrader-s2-'))
    try {
      const k = await Kernel.create({ home, clock: new FakeClock(), deviceKeyProvider: fileProvider, scrypt: { N: 1024, r: 8, p: 1 }, timers: false })
      tx(k.db, () => { for (let i = 0; i < 10_000; i++) k.ledger.append({ type: 'annotation', origin: systemOrigin('s2:fill'), subject: { orgId: 'org_local' }, payload: { i } }) })
      const full = verifyLedgerDb(k.db, { mode: 'full', now: 0 })
      const tail = verifyLedgerDb(k.db, { mode: 'tail', now: 0 })
      const auto = verifyLedgerDb(k.db, { mode: 'auto', now: 0 })
      console.log(`[s2-budget] entries=${full.count} full=${full.durationMs}ms tail=${tail.durationMs}ms (${tail.count} entries) auto=${auto.mode}/${auto.durationMs}ms`)
      expect(full.ok && tail.ok && auto.ok).toBe(true)
      expect(tail.count).toBeLessThan(2_000)
      expect(full.durationMs).toBeLessThan(2_000) // 安静环境目标 < 100 ms（数字见报告）；这里放宽以免负载下误红
      await k.stop()
    } finally { rmSync(home, { recursive: true, force: true }) }
  }, 120_000)
})
