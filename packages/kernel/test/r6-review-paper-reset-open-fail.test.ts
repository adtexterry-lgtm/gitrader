// SPDX-License-Identifier: CPAL-1.0
// 审稿 P2-3：--accept-new-ledger --reset-paper-state 时，新账本库打开失败，旧纸面状态仍在原处（不停在「已进 backups/、空账本没建成」的半截）。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { makeCrashHarness, stopIntent } from './helpers/crash-points'
import type { CrashHarness } from './helpers/crash-points'

const gate = vi.hoisted(() => ({ failOpen: false, failRestore: false }))
vi.mock('../src/db', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/db')>()
  return { ...real, openDb: (path: string) => { if (gate.failOpen) throw new Error('simulated: cannot create ledger db (disk full)'); return real.openDb(path) } }
})

vi.mock('../src/paper-integrity', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/paper-integrity')>()
  return { ...real, restorePaperState: (home: string, dir: string) => { if (gate.failRestore) throw new Error('simulated EPERM: cannot rename back'); return real.restorePaperState(home, dir) } }
})

let h: CrashHarness | undefined
afterEach(async () => { gate.failOpen = false; gate.failRestore = false; delete process.env.GITRADER_ACCEPT_NEW_LEDGER; await h?.cleanup(); h = undefined })

const dbPath = () => join(h!.home, 'data', 'gitrader.sqlite')
const paperFile = () => join(h!.home, 'paper-state.json')

describe('审稿 P2-3 纸面状态在账本打开成功之后才挪', () => {
  it('开库失败：paper-state.json（连同 .prev）原样留在原处，没有留下 backups/ 和空账本；之后正常重启仍能放行', async () => {
    h = await makeCrashHarness()
    expect((await h.world.k.trading.place({ intent: stopIntent(h.paperAccountId()) }, h.world.human)).order?.status).toBe('filled')
    await new Promise((r) => setImmediate(r))
    h.kill()
    for (const s of ['', '-wal', '-shm']) rmSync(dbPath() + s, { force: true })
    const before = readFileSync(paperFile())
    const prevPath = paperFile() + '.prev'
    const hadPrev = existsSync(prevPath)
    const prevBefore = hadPrev ? readFileSync(prevPath) : undefined

    process.env.GITRADER_ACCEPT_NEW_LEDGER = '1'
    gate.failOpen = true
    await expect(h.restart({ resetPaperState: true })).rejects.toMatchObject({ problem: { name: 'STATE_FILE_CORRUPT' } })
    expect(readFileSync(paperFile()).equals(before)).toBe(true)
    if (hadPrev) expect(readFileSync(prevPath).equals(prevBefore!)).toBe(true)
    expect(existsSync(join(h.home, 'backups'))).toBe(false)
    expect(existsSync(dbPath())).toBe(false)

    // 故障解除后同一条命令照常放行：旧状态这时才进 backups/
    gate.failOpen = false
    await h.restart({ resetPaperState: true })
    expect(existsSync(paperFile()) && readFileSync(paperFile()).equals(before)).toBe(false)
    expect(existsSync(join(h.home, 'backups'))).toBe(true)
  })

  it('N3 开库失败、旧状态搬回也失败：抛出的错误同时带开库的原始原因和搬回失败的原因，并写明旧状态现在在哪个备份目录（数据没丢）', async () => {
    h = await makeCrashHarness()
    expect((await h.world.k.trading.place({ intent: stopIntent(h.paperAccountId()) }, h.world.human)).order?.status).toBe('filled')
    await new Promise((r) => setImmediate(r))
    h.kill()
    for (const s of ['', '-wal', '-shm']) rmSync(dbPath() + s, { force: true })
    const before = readFileSync(paperFile())

    process.env.GITRADER_ACCEPT_NEW_LEDGER = '1'
    gate.failOpen = true
    gate.failRestore = true
    const err = await h.restart({ resetPaperState: true }).then(() => undefined, (e: unknown) => e) as { problem?: { name: string; message: string } } | undefined
    expect(err?.problem?.name).toBe('STATE_FILE_CORRUPT')
    const msg = err!.problem!.message
    expect(msg).toContain('cannot create ledger db') // 开库的原始原因还在
    expect(msg).toContain('simulated EPERM') // 搬回失败的原因也在
    const home = h.home
    const backup = readdirSync(join(home, 'backups')).map((n) => join(home, 'backups', n))
    expect(backup).toHaveLength(1)
    expect(msg).toContain(backup[0]!) // 写明旧状态现在在哪
    expect(readFileSync(join(backup[0]!, 'paper-state.json')).equals(before)).toBe(true)
    expect(existsSync(dbPath())).toBe(false)
  })
})
