// SPDX-License-Identifier: CPAL-1.0
// R5 / GQ-07：配置整份不见而目录已用过 → 拒绝启动（fail-closed）；显式 --rebuild-config 才重建，且沿用旧 accountId。
import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { homeStateEvidence, homePaths, initHome } from '../src/config'
import { openDb } from '../src/db'
import { makeCrashHarness, stopIntent } from './helpers/crash-points'
import type { CrashHarness } from './helpers/crash-points'

let h: CrashHarness | undefined
const extra: string[] = []
afterEach(async () => { await h?.cleanup(); h = undefined; for (const d of extra.splice(0)) rmSync(d, { recursive: true, force: true }) })

/** 起一个有账本、有纸面持仓的目录，然后停掉。 */
async function usedHome(): Promise<{ home: string; accountId: string; ledgerCount: number }> {
  h = await makeCrashHarness()
  const accountId = h.paperAccountId()
  const r = await h.world.k.trading.place({ intent: stopIntent(accountId) }, h.world.human)
  expect(r.order?.status).toBe('filled')
  await new Promise((resolve) => setImmediate(resolve))
  const ledgerCount = h.world.k.ledger.count()
  h.kill()
  return { home: h.home, accountId, ledgerCount }
}

describe('GQ-07 配置不见 + 目录已用过', () => {
  it('Kernel.create 拒绝启动（STATE_FILE_CORRUPT），点名文件与证据，且不创建 gitrader.json', async () => {
    const { home } = await usedHome()
    rmSync(join(home, 'gitrader.json'))
    await expect(h!.restart()).rejects.toMatchObject({ problem: { name: 'STATE_FILE_CORRUPT' } })
    const e = (await h!.restart().catch((x: unknown) => x)) as { problem: { message: string } }
    expect(e.problem.message).toMatch(/gitrader\.json is missing/)
    expect(e.problem.message).toMatch(/--rebuild-config/)
    expect(e.problem.message).toMatch(/data\/gitrader\.sqlite/)
    expect(existsSync(join(home, 'gitrader.json'))).toBe(false)           // 绝不悄悄新建
  })

  it('正例：全新目录照常创建；init 只建了目录（keys/ 空）不算「用过」', () => {
    const home = mkdtempSync(join(tmpdir(), 'gr-e-new-')); extra.push(home)
    expect(homeStateEvidence(home)).toEqual([])
    initHome(home)                                    // 建目录 + 配置
    rmSync(homePaths(home).config)                    // 删掉配置，但库 / 密钥都还没生成过
    expect(homeStateEvidence(home)).toEqual([])
    expect(() => initHome(home)).not.toThrow()
    expect(existsSync(homePaths(home).config)).toBe(true)
  })

  it('反例：只剩任何一种证据文件，都拒绝', () => {
    for (const rel of [['data', 'gitrader.sqlite'], ['keys', 'install-key.json'], ['keys', 'pin.json'], ['keys', 'keystore.json'], ['paper-state.json']]) {
      const home = mkdtempSync(join(tmpdir(), 'gr-e-ev-')); extra.push(home)
      initHome(home); rmSync(homePaths(home).config)
      mkdirSync(join(home, ...rel.slice(0, -1)), { recursive: true })
      writeFileSync(join(home, ...rel), '{}')
      expect(() => initHome(home), rel.join('/')).toThrowError(/gitrader\.json is missing/)
    }
  })

  it('--rebuild-config：沿用账本里的纸面账户 id，不写账本，旧状态原样在', async () => {
    const { home, accountId, ledgerCount } = await usedHome()
    rmSync(join(home, 'gitrader.json'))
    const r = initHome(home, { rebuildConfig: true })
    expect(r.config.accounts.find((a) => a.alias === 'paper')?.accountId).toBe(accountId)
    // Check ledger count hasn't changed after initHome
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(homePaths(home).db, { readOnly: true })
    const countAfterInit = (db.prepare('SELECT COUNT(*) c FROM ledger').get() as { c: number }).c
    db.close()
    expect(countAfterInit).toBe(ledgerCount)  // initHome 不写账本
    const w = await h!.restart()
    expect(w.k.accounts.find('paper')?.accountId).toBe(accountId)
    expect(w.k.ledger.count()).toBeGreaterThanOrEqual(ledgerCount)  // 启动可能有验证写入，但不应该少
    expect(w.k.paperStateHealth().state).toBe('ok')
  })

  it('长路径（库路径正好 272 字符）：--rebuild-config 仍能从账本找回 acct_OLD1', () => {
    const root = mkdtempSync(join(tmpdir(), 'gr-e-lp-')); extra.push(root)
    let home = root
    const dbLen = () => join(home, 'data', 'gitrader.sqlite').length
    while (dbLen() + 41 < 272) home = join(home, 'd'.repeat(40))
    home = join(home, 'd'.repeat(272 - dbLen() - 1))
    expect(join(home, 'data', 'gitrader.sqlite').length).toBe(272)
    initHome(home)
    const db = openDb(homePaths(home).db)
    db.prepare('INSERT INTO ledger(id,ts,recorded_at,type,actor,account_id,entry,hash) VALUES(?,?,?,?,?,?,?,?)')
      .run('l1', 1, 1, 'test', 'human', 'acct_OLD1', '{}', 'h1')
    db.close()
    rmSync(homePaths(home).config)
    const r = initHome(home, { rebuildConfig: true })
    expect(r.config.accounts[0]!.accountId).toBe('acct_OLD1')
  })

  it('库文件存在但读不出来：--rebuild-config 拒绝（STATE_FILE_CORRUPT），不写 gitrader.json', () => {
    const home = mkdtempSync(join(tmpdir(), 'gr-e-corrupt-')); extra.push(home)
    initHome(home)
    rmSync(homePaths(home).config)
    mkdirSync(join(home, 'data'), { recursive: true })
    writeFileSync(homePaths(home).db, 'this is not a sqlite database')
    let err: unknown
    try { initHome(home, { rebuildConfig: true }) } catch (e) { err = e }
    expect((err as { problem: { name: string; message: string } }).problem.name).toBe('STATE_FILE_CORRUPT')
    expect((err as { problem: { message: string } }).problem.message).toMatch(/cannot be read/)
    expect(existsSync(homePaths(home).config)).toBe(false)                     // 拒绝，不写新配置
    expect(readFileSync(homePaths(home).db, 'utf8')).toBe('this is not a sqlite database')  // 坏库原样不碰
  })

  it('多个候选 id（已被旧 bug 打过的目录）：必须 --account-id 指定，且只能从候选里选', async () => {
    const { home, accountId } = await usedHome()
    // 造第二个 id：把 paper-state.json 里再塞一个账户（模拟旧 bug 留下的「第三个身份」）
    const file = join(home, 'paper-state.json')
    const state = JSON.parse(readFileSync(file, 'utf8')) as { accounts: Array<{ id: string }> }
    state.accounts.push({ ...state.accounts[0]!, id: 'acct_OTHER00000000000000000001' })
    writeFileSync(file, JSON.stringify(state))
    rmSync(join(home, 'gitrader.json'))
    expect(() => initHome(home, { rebuildConfig: true })).toThrowError(/--account-id/)
    expect(() => initHome(home, { rebuildConfig: true, accountId: 'acct_NOT_IN_THIS_HOME00000000' })).toThrow()
    expect(initHome(home, { rebuildConfig: true, accountId }).config.accounts[0]!.accountId).toBe(accountId)
  })
})
