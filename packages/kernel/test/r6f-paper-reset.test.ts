// SPDX-License-Identifier: CPAL-1.0
// R2-REL-11：账本库不见了 + --accept-new-ledger + 非空 paper-state.json → 默认拒绝；只有显式 reset 才放行，旧状态移进 backups/。
import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { CRASH_PIN, makeCrashHarness, stopIntent } from './helpers/crash-points'
import type { CrashHarness } from './helpers/crash-points'
import { Kernel } from '../src/kernel'
import { fileProvider } from '../src/device-key'
import { FakeClock } from '../src/util/clock'
import { paperStateContent } from '../src/paper-integrity'

let h: CrashHarness | undefined
const envKeys = ['GITRADER_ACCEPT_NEW_LEDGER'] as const
afterEach(async () => { for (const k of envKeys) delete process.env[k]; await h?.cleanup(); h = undefined })

const dbPath = () => join(h!.home, 'data', 'gitrader.sqlite')
const paperFile = () => join(h!.home, 'paper-state.json')
void CRASH_PIN

/** 成交一笔 → 纸面状态里有持仓 → 杀内核 → 删库（账本不见了）。返回删库前后 paper-state.json 的原始字节。 */
async function ledgerGoneWithPosition(): Promise<Buffer> {
  h = await makeCrashHarness()
  expect((await h.world.k.trading.place({ intent: stopIntent(h.paperAccountId()) }, h.world.human)).order?.status).toBe('filled')
  await new Promise((r) => setImmediate(r))
  h.kill()
  for (const s of ['', '-wal', '-shm']) rmSync(dbPath() + s, { force: true })
  const before = readFileSync(paperFile())
  expect(paperStateContent(before.toString('utf8')).nonEmpty).toBe(true)
  return before
}

describe('R2-REL-11 新账本 + 非空纸面状态', () => {
  it('[R6F-PS1] --accept-new-ledger with non-empty paper state refuses to start and names --reset-paper-state and restoring the ledger', async () => {
    const before = await ledgerGoneWithPosition()
    process.env.GITRADER_ACCEPT_NEW_LEDGER = '1'
    const err = await h!.restart().then(() => undefined, (x: unknown) => x) as { problem?: { name: string; message: string } } | undefined
    expect(err?.problem?.name).toBe('STATE_FILE_CORRUPT')
    expect(err?.problem?.message).toContain('--reset-paper-state')
    expect(err?.problem?.message).toMatch(/保留|还原|restore/)
    // 拒绝时什么都不动：文件字节不变，也没留下空账本
    expect(readFileSync(paperFile()).equals(before)).toBe(true)
    expect(existsSync(dbPath())).toBe(false)
    expect(existsSync(join(h!.home, 'backups'))).toBe(false)
    // 之后不带参数仍被拒（走原有的“账本库不见了”）
    delete process.env.GITRADER_ACCEPT_NEW_LEDGER
    await expect(h!.restart()).rejects.toMatchObject({ problem: { name: 'STATE_FILE_CORRUPT', message: expect.stringMatching(/ledger database is missing/) } })
    expect(existsSync(dbPath())).toBe(false)
  })

  it('[R6F-PS1b] an environment variable is not an equivalent of --reset-paper-state: only the explicit parameter releases the guard', async () => {
    const before = await ledgerGoneWithPosition()
    process.env.GITRADER_ACCEPT_NEW_LEDGER = '1'
    process.env['GITRADER_RESET_' + 'PAPER_STATE'] = '1'
    try {
      await expect(h!.restart()).rejects.toMatchObject({ problem: { name: 'STATE_FILE_CORRUPT', message: expect.stringContaining('--reset-paper-state') } })
    } finally { delete process.env['GITRADER_RESET_' + 'PAPER_STATE'] }
    expect(readFileSync(paperFile()).equals(before)).toBe(true)
    expect(existsSync(dbPath())).toBe(false)
    expect(existsSync(join(h!.home, 'backups'))).toBe(false)
  })

  it('[R6F-PS2] --accept-new-ledger --reset-paper-state moves the old paper state into a backup directory and starts from the configured initial balance', async () => {
    const before = await ledgerGoneWithPosition()
    process.env.GITRADER_ACCEPT_NEW_LEDGER = '1'
    const w = await h!.restart({ resetPaperState: true }) // 显式参数（对应命令行 --reset-paper-state）
    // 旧文件（逐字节相同）在 backups/paper-state-<时间>/ 里
    const dirs = readdirSync(join(h!.home, 'backups')).filter(n => n.startsWith('paper-state-'))
    expect(dirs).toHaveLength(1)
    expect(readFileSync(join(h!.home, 'backups', dirs[0]!, 'paper-state.json')).equals(before)).toBe(true)
    // 新状态从初始资金开始：没有持仓、不是 unverifiedFirstUse
    const health = w.k.healthSnapshot().paperState
    expect(health.unverifiedFirstUse).toBeUndefined()
    expect(health.state).not.toBe('corrupt')
    // 账本照旧写了 ledger.restarted_empty 注记
    expect([...w.k.ledger.iterate()].some((e) => (e.payload as { kind?: string } | undefined)?.kind === 'ledger.restarted_empty')).toBe(true)
    await w.k.stop().catch(() => undefined)
    const after = JSON.parse(readFileSync(paperFile(), 'utf8')) as { accounts: { cash: unknown; initial: unknown; positions: { $m: unknown[] } }[] }
    expect(after.accounts.length).toBeGreaterThan(0)
    for (const a of after.accounts) {
      expect(a.positions.$m).toHaveLength(0)
      expect(a.cash).toEqual(a.initial)
    }
    expect(paperStateContent(readFileSync(paperFile(), 'utf8')).nonEmpty).toBe(false)
  })

  it('--reset-paper-state while the ledger exists is a parameter error and changes nothing', async () => {
    h = await makeCrashHarness()
    const before = readFileSync(paperFile())
    await expect(Kernel.create({ home: h.home, resetPaperState: true, acceptNewLedger: true, clock: new FakeClock(), deviceKeyProvider: fileProvider, scrypt: { N: 1024, r: 8, p: 1 }, timers: false }))
      .rejects.toMatchObject({ problem: { name: 'INVALID_PARAMS', message: expect.stringContaining('--reset-paper-state') } })
    expect(readFileSync(paperFile()).equals(before)).toBe(true)
    expect(existsSync(join(h.home, 'backups'))).toBe(false)
  })

  it('an empty paper state (fresh initial balance, no sequence numbers) is not blocked by --accept-new-ledger', () => {
    const fresh = JSON.stringify({ v: 1, orderSeq: 0, fillSeq: 0, accounts: [{ id: 'a', initial: { $b: '100' }, cash: { $b: '100' }, positions: { $m: [] }, orders: [{ status: 'filled' }] }] })
    expect(paperStateContent(fresh)).toEqual({ nonEmpty: false, reasons: [] })
    const moved = JSON.stringify({ v: 1, orderSeq: 0, fillSeq: 0, accounts: [{ id: 'a', initial: { $b: '100' }, cash: { $b: '90' }, positions: { $m: [] }, orders: [] }] })
    expect(paperStateContent(moved).nonEmpty).toBe(true)
    expect(paperStateContent('{broken').nonEmpty).toBe(true)
  })
})
