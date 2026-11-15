// SPDX-License-Identifier: CPAL-1.0
// R5 / GQ-58：主目录路径过长时 init / serve 失败，报错把人引向「权限 / 备份」
import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { longPathHint, openDb, sqlitePath } from '../src/db'

const win = process.platform === 'win32'

describe('GQ-58 长路径', () => {
  it('sqlitePath：短路径与 :memory: 原样；非 win32 原样', () => {
    expect(sqlitePath(':memory:')).toBe(':memory:')
    expect(sqlitePath(join(tmpdir(), 'x.sqlite'))).toBe(join(tmpdir(), 'x.sqlite'))
  })

  it.skipIf(!win)('win32：≥200 字符的库路径带 \\\\?\\ 前缀', () => {
    const p = join(tmpdir(), 'd'.repeat(220), 'gitrader.sqlite')
    expect(sqlitePath(p).startsWith('\\\\?\\')).toBe(true)
  })

  it.skipIf(!win)('win32：库路径 300 字符能创建、能写、能读（修前：unable to open database file）', () => {
    const root = mkdtempSync(join(tmpdir(), 'gr-lp-'))
    let deep = root
    while (deep.length < 300) deep = join(deep, 'd'.repeat(40))
    mkdirSync(join(deep, 'data'), { recursive: true })
    const file = join(deep, 'data', 'gitrader.sqlite')
    expect(file.length).toBeGreaterThan(256)
    const db = openDb(file)
    try {
      db.prepare('INSERT INTO meta(key,value) VALUES(?,?)').run('k', 'v')
      expect((db.prepare('SELECT value FROM meta WHERE key=?').get('k') as { value: string }).value).toBe('v')
    } finally { db.close() }
    rmSync(root, { recursive: true, force: true })
  })

  it.skipIf(!win)('win32：路径含中文也行', () => {
    const root = mkdtempSync(join(tmpdir(), 'gr-lp-'))
    let deep = join(root, '用户数据')
    while (deep.length < 260) deep = join(deep, '很长的目录名'.repeat(4))
    mkdirSync(join(deep, 'data'), { recursive: true })
    const db = openDb(join(deep, 'data', 'gitrader.sqlite'))
    db.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('longPathHint：短路径无提示；win32 长路径点名字符数', () => {
    expect(longPathHint('C:\\x\\gitrader.sqlite')).toBe('')
    if (win) expect(longPathHint('C:\\' + 'a'.repeat(250))).toMatch(/260/)
  })
})
