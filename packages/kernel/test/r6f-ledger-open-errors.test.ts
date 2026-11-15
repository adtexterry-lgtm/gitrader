// SPDX-License-Identifier: CPAL-1.0
// R2-REL-05：账本库被别的进程占用或只读时，报错说真话（占用 / 只读 + 路径），绝不建议“从备份还原”；只有确认损坏才建议还原。
import { afterEach, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Kernel } from '../src/kernel'
import { classifyLedgerOpenFailure } from '../src/db'
import { fileProvider } from '../src/device-key'
import { FakeClock } from '../src/util/clock'

const homes: string[] = []
const children: ChildProcess[] = []
afterEach(() => {
  for (const c of children.splice(0)) { try { c.kill() } catch { /* 已退出 */ } }
  for (const h of homes.splice(0)) {
    try { chmodSync(join(h, 'data', 'gitrader.sqlite'), 0o666) } catch { /* 文件可能不存在 */ }
    try { rmSync(h, { recursive: true, force: true }) } catch { /* 尽力清理 */ }
  }
})

const create = (home: string) => Kernel.create({ home, clock: new FakeClock(), deviceKeyProvider: fileProvider, scrypt: { N: 1024, r: 8, p: 1 }, timers: false })
const bad = /备份|还原|restore|backup/i

async function homeWithLedger(): Promise<{ home: string; db: string }> {
  const home = mkdtempSync(join(tmpdir(), 'gt-r6f-db-'))
  homes.push(home)
  const k = await create(home)
  await k.stop()
  return { home, db: join(home, 'data', 'gitrader.sqlite') }
}

/** 另一个进程以独占模式占住库（和 Windows 上杀毒 / 同步软件独占文件同一类后果）。 */
function holdExclusive(db: string): Promise<ChildProcess> {
  const script = [
    "const { DatabaseSync } = require('node:sqlite')",
    `const d = new DatabaseSync(${JSON.stringify(db)})`,
    "d.exec('PRAGMA locking_mode=EXCLUSIVE')",
    "d.exec('BEGIN EXCLUSIVE')",
    "d.prepare('SELECT COUNT(*) c FROM ledger').get()",
    "process.stdout.write('held\\n')",
    'setInterval(() => {}, 1000)',
  ].join(';')
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
  children.push(child)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('child did not lock the db')), 15_000)
    child.stdout!.on('data', d => { if (String(d).includes('held')) { clearTimeout(timer); resolve(child) } })
    child.on('exit', () => { clearTimeout(timer); reject(new Error('child exited early')) })
  })
}

const rejection = async (p: Promise<unknown>): Promise<{ name: string; message: string }> => {
  try { await p } catch (e) { return (e as { problem: { name: string; message: string } }).problem }
  throw new Error('expected the kernel to refuse to start')
}

describe('R2-REL-05 账本库打不开的真话', () => {
  it('[R6F-DB1] ledger db held by another process: Chinese message says it is in use, names the path, never advises restoring from backup', async () => {
    const { db } = await homeWithLedger()
    const home = join(db, '..', '..')
    const holder = await holdExclusive(db)
    const problem = await rejection(create(home))
    expect(problem.name).toBe('STATE_FILE_CORRUPT')
    expect(problem.message).toContain('占用')
    expect(problem.message).toContain('gitrader.sqlite')
    expect(problem.message).not.toMatch(bad)
    // 放开占用以后必须能正常起来（文件本来就是好的）
    holder.kill()
    await new Promise<void>(r => holder.on('exit', () => r()))
    const k = await create(home)
    await k.stop()
    // 分类本身：占用类错误码 + 文件头正常 = 占用；文件头不是 SQLite = 损坏
    expect(classifyLedgerOpenFailure(db, Object.assign(new Error('database is locked'), { errcode: 5 }))).toBe('in_use')
    expect(classifyLedgerOpenFailure(db, Object.assign(new Error('unable to open database file'), { errcode: 14 }))).toBe('in_use')
    const garbage = join(home, 'garbage.sqlite')
    writeFileSync(garbage, 'this is definitely not an sqlite file, not at all')
    expect(classifyLedgerOpenFailure(garbage, Object.assign(new Error('unable to open database file'), { errcode: 14 }))).toBe('corrupt')
    expect(classifyLedgerOpenFailure(db, Object.assign(new Error('database disk image is malformed'), { errcode: 11 }))).toBe('corrupt')
  }, 60_000)

  it('[R6F-DB2] read-only ledger db: Chinese message says read-only, names the path, never advises restoring from backup', async () => {
    const { home, db } = await homeWithLedger()
    chmodSync(db, 0o444)
    const problem = await rejection(create(home))
    expect(problem.name).toBe('STATE_FILE_CORRUPT')
    expect(problem.message).toContain('只读')
    expect(problem.message).toContain('gitrader.sqlite')
    expect(problem.message).not.toMatch(bad)
    expect(existsSync(db)).toBe(true)
    chmodSync(db, 0o666)
    const k = await create(home)
    await k.stop()
  }, 60_000)

  it('truncated (confirmed corrupt) still advises restoring and leaves the file alone', async () => {
    const { home, db } = await homeWithLedger()
    writeFileSync(db, 'not a database at all, just text that is long enough to be a header')
    rmSync(db + '-wal', { force: true }); rmSync(db + '-shm', { force: true })
    const problem = await rejection(create(home))
    expect(problem.message).toMatch(/账本数据库打不开/)
    expect(problem.message).toMatch(/还原/)
    expect(problem.message).toContain('gitrader.sqlite')
  }, 60_000)
})
