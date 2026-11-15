// SPDX-License-Identifier: CPAL-1.0
// r7 WP-J GQ-47：令牌目录为空时不再断言「没有钥匙」，并提示 --token-file；unigit 片段给了 --token-file 就不再要求手工粘贴。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { main } from '../src/index'
import type { CliIo } from '../src/index'

let home: string
let cwd: string
let startCwd: string
let out: string[]
let err: string[]
const io = (): CliIo => ({ out: (s) => { out.push(s) }, err: (s) => { err.push(s) }, env: { GITRADER_HOME: home }, interactive: false, readSecret: async () => { throw new Error('unexpected secret prompt') } })
const run = (argv: string[]): Promise<number> => main(argv, io())

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'gitrader-r7j-snip-home-'))
  cwd = mkdtempSync(join(tmpdir(), 'gitrader-r7j-snip-cwd-'))
  startCwd = process.cwd()
  process.chdir(cwd)
  out = []; err = []
})
afterEach(() => {
  process.chdir(startCwd)
  rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  rmSync(cwd, { recursive: true, force: true, maxRetries: 5 })
})

describe('GQ-47 snippet 文案', () => {
  it('home 下没有令牌文件：提示 --token-file，不只说「没有钥匙」', async () => {
    expect(await run(['mcp', 'snippet', 'claude-code', '--write'])).toBe(1)
    const e = err.join('')
    expect(e).toContain('--token-file')
    expect(e).toContain('gitrader keys new agent <名字>')
  })
  it('unigit 片段：给了 --token-file 不要求再粘贴（正例）；没给时保留（反例）', async () => {
    await run(['mcp', 'snippet', 'unigit', '--token-file', join(cwd, 'x.token')])
    expect(out.join('')).not.toContain('Set-Content')
    out.length = 0
    await run(['mcp', 'snippet', 'unigit'])
    expect(out.join('')).toContain('Set-Content')
  })
})
