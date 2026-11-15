// SPDX-License-Identifier: CPAL-1.0
// fix-r4 C3：`gitrader ledger export` 不给 --out 时目录名用本地时间 gitrader-ledger-YYYYMMDD-HHmmss，并带 账单.csv。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileProvider } from '@gitrader/kernel'
import { main } from '../src/index'
import type { CliIo } from '../src/index'

let home: string
let out: string[]

const io = (): CliIo => ({
  out: (s) => { out.push(s) },
  err: (s) => { out.push(s) },
  env: { GITRADER_HOME: home },
  interactive: false,
  deviceKey: fileProvider,
  readSecret: async () => { throw new Error('unexpected prompt') },
})
const run = (argv: string[]): Promise<number> => main(argv, io())

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'gitrader-exp-name-'))
  out = []
  expect(await run(['init', '--no-pin'])).toBe(0)
})
afterEach(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))

describe('gitrader ledger export 默认目录名', () => {
  it('本地时间命名、含 账单.csv；连续导出不重名也不覆盖', async () => {
    expect(await run(['ledger', 'export'])).toBe(0)
    expect(await run(['ledger', 'export'])).toBe(0)
    const dirs = readdirSync(join(home, 'exports'))
    expect(dirs).toHaveLength(2)
    for (const d of dirs) {
      expect(d).toMatch(/^gitrader-ledger-\d{8}-\d{6}(-\d+)?$/)
      expect(existsSync(join(home, 'exports', d, '账单.csv'))).toBe(true)
      expect(existsSync(join(home, 'exports', d, 'manifest.json'))).toBe(true)
    }
    expect(out.join('')).toContain('账单.csv')
  })

  it('--redact 不生成账单.csv，输出里也不把它当成产出文件列出', async () => {
    out = []
    expect(await run(['ledger', 'export', '--redact', '--out', 'red'])).toBe(0)
    expect(existsSync(join(home, 'exports', 'red', '账单.csv'))).toBe(false)
    expect(out.join('')).not.toMatch(/trade-log\.md\s+账单\.csv/)
  })
})
