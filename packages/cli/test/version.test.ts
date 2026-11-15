// SPDX-License-Identifier: CPAL-1.0
// gitrader --version：安装后的第一条自检命令，只打印版本、退出 0、不建目录。
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { main } from '../src/index'
import type { CliIo } from '../src/index'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

describe('gitrader --version', () => {
  it('prints the version, exits 0 and creates nothing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gr-ver-')); dirs.push(root)
    const home = join(root, 'home')
    const out: string[] = []
    const io: CliIo = { out: (s) => { out.push(s) }, err: () => undefined, env: { GITRADER_HOME: home }, interactive: false, readSecret: async () => '' }
    for (const argv of [['--version'], ['version'], ['-v']]) {
      out.length = 0
      expect(await main(argv, io)).toBe(0)
      expect(out.join('')).toMatch(/^gitrader \S+\n$/)
    }
    expect(existsSync(home)).toBe(false)
  })
})
