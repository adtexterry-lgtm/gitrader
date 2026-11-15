// SPDX-License-Identifier: CPAL-1.0
// E0-fix-011：任何子命令的 --help 退出码都是 0（含 agent 的各工具与动作）。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { main } from '../src/index'
import type { CliIo } from '../src/index'

let home: string
let out: string[]
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'gitrader-e0fix-')); out = [] })
afterEach(() => { rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
const run = (argv: string[]): Promise<number> => main(argv, {
  out: (s) => { out.push(s) }, err: (s) => { out.push(s) }, env: { GITRADER_HOME: home }, interactive: false,
  readSecret: async () => { throw new Error('unexpected secret prompt') },
} as CliIo)

describe('子命令 --help 退出 0', () => {
  it.each([
    ['agent', 'propose', '--help'], ['agent', 'propose', 'order', '--help'], ['agent', 'order', '--help'],
    ['keys', 'new', 'agent', '--help'], ['serve', '--detach', '--help'], ['open', '--help'], ['agent', 'propose', '-h'],
  ])('%s', async (...argv) => {
    expect(await run(argv)).toBe(0)
    expect(out.join('')).not.toBe('')
  })
})
