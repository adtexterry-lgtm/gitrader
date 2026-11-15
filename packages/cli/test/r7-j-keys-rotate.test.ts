// SPDX-License-Identifier: CPAL-1.0
// r7 WP-J GQ-42：gitrader keys rotate agent（PIN、旧令牌立即失效、令牌不打印）
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileProvider, Kernel } from '@gitrader/kernel'
import { main } from '../src/index'
import type { CliIo } from '../src/index'

const PIN = '482916'
let home: string
let out: string[]
let err: string[]

const io = (): CliIo => ({
  out: (s) => { out.push(s) }, err: (s) => { err.push(s) }, env: { GITRADER_HOME: home }, interactive: true, deviceKey: fileProvider,
  readSecret: async () => PIN,
})
const run = (argv: string[]): Promise<number> => main(argv, io())
const all = (): string => out.join('') + err.join('')
const tokenOf = (name: string): string => readFileSync(join(home, 'agent-tokens', `${name}.token`), 'utf8').trim()

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'gitrader-r7j-rotate-'))
  out = []; err = []
  expect(await run(['init'])).toBe(0)
  expect(await run(['keys', 'new', 'agent', 'ro', '--host', 'claude-code', '--tier', 'read_only', '--token-file'])).toBe(0)
  out = []; err = []
})
afterEach(() => { rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })

describe('keys rotate agent', () => {
  it('写出新令牌文件；输出里没有新旧令牌；旧令牌认不了、新令牌可用', async () => {
    const old = tokenOf('ro')
    expect(await run(['keys', 'rotate', 'agent', 'ro'])).toBe(0)
    const path = /已写入 (.+?)（令牌不打印）/.exec(all())![1]! // 同名不覆盖：默认写成新文件 ro-2.token
    const fresh = readFileSync(path, 'utf8').trim()
    expect(fresh).not.toBe(old)
    expect(all()).not.toContain(old)
    expect(all()).not.toContain(fresh)
    expect(all()).toContain('旧令牌立即失效')
    const k = await Kernel.create({ home, timers: false, deviceKeyProvider: fileProvider })
    try {
      expect(k.agents.verifyToken(old)).toBeNull()
      expect(k.agents.verifyToken(fresh)).not.toBeNull()
    } finally { await k.stop() }
  })

  it('--token-file 写到指定位置', async () => {
    const target = join(home, 'elsewhere.token')
    expect(await run(['keys', 'rotate', 'agent', 'ro', '--token-file', target])).toBe(0)
    expect(readFileSync(target, 'utf8').trim()).toMatch(/^gtk_/)
  })

  it('找不到名字：报错且不改令牌（反例）', async () => {
    const before = tokenOf('ro')
    expect(await run(['keys', 'rotate', 'agent', 'nope'])).not.toBe(0)
    expect(all()).toContain('没有这把 Agent 钥匙')
    expect(tokenOf('ro')).toBe(before)
  })

  it('已吊销的钥匙不能轮换（反例）', async () => {
    expect(await run(['keys', 'revoke', 'agent', 'ro'])).toBe(0)
    out = []; err = []
    expect(await run(['keys', 'rotate', 'agent', 'ro'])).not.toBe(0)
    expect(all()).toContain('已吊销')
  })
})
