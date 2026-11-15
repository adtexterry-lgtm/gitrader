// SPDX-License-Identifier: CPAL-1.0
// E0-8：CLI 侧只在本机终端里允许重置；确认短语不对就取消，且不动 keys/。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Kernel, fileProvider } from '@gitrader/kernel'
import { cmdPinReset } from '../src/pin-reset'
import type { CliIo } from '../src/index'

const FAST_SCRYPT = { N: 1 << 10, r: 8, p: 1 }
const args = { cmd: ['pin', 'reset'], flags: {} }

let home: string
let out: string[]
let err: string[]
let prompts: string[]
let answer: string | undefined

const io = (over: Partial<CliIo> = {}): CliIo => ({
  out: (s) => { out.push(s) },
  err: (s) => { err.push(s) },
  env: { GITRADER_HOME: home },
  interactive: false,
  deviceKey: fileProvider,
  readSecret: async (prompt) => {
    prompts.push(prompt)
    if (answer === undefined) throw new Error('unexpected secret prompt')
    return answer
  },
  ...over,
})

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'gitrader-e0-8-cli-'))
  out = []
  err = []
  prompts = []
  answer = undefined
})
afterEach(() => { rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })

async function setPin(): Promise<void> {
  const k = await Kernel.create({ home, scrypt: FAST_SCRYPT, deviceKeyProvider: fileProvider, timers: false })
  try { await k.auth.setupPinLocalTerminal('482916') } finally { await k.stop() }
}

describe('gitrader pin reset（CLI）', () => {
  it('refuses without tty', async () => {
    await setPin()
    expect(await cmdPinReset(home, args, io())).toBe(2)
    expect(err.join('')).toContain('重置 PIN 只能在本机终端里由你本人完成')
    expect(existsSync(join(home, 'keys', 'pin.json'))).toBe(true)
    // 从 stdin 喂 PIN 的自动化路径也不行
    const stdinIo = io({ interactive: true, env: { GITRADER_HOME: home, GITRADER_PIN_STDIN: '1' } })
    expect(await cmdPinReset(home, args, stdinIo)).toBe(2)
  })

  it('service still running: tells user to gitrader stop before any prompt, keys untouched', async () => {
    await setPin()
    const keysBefore = readdirSync(join(home, 'keys')).sort()
    answer = '我确认重置 PIN'
    const live = async () => ({ port: 1234, pid: 1, token: 't', startedAt: 1, version: 'x', baseUrl: 'http://127.0.0.1:1234' })
    expect(await cmdPinReset(home, args, io({ interactive: true }), { liveService: live })).toBe(1)
    expect(prompts).toHaveLength(0)
    expect(out.join('')).not.toContain('重置 PIN 会做这些事')
    expect(err.join('')).toContain('服务还在运行（端口 1234）。先运行 gitrader stop 停掉它，再重置 PIN。')
    expect(err.join('')).not.toContain('error:')
    expect(readdirSync(join(home, 'keys')).sort()).toEqual(keysBefore)
  })

  it('non-interactive stays exit code 2 even when the service is running', async () => {
    await setPin()
    const live = async () => ({ port: 1234, pid: 1, token: 't', startedAt: 1, version: 'x', baseUrl: 'http://127.0.0.1:1234' })
    expect(await cmdPinReset(home, args, io(), { liveService: live })).toBe(2)
    expect(err.join('')).toContain('重置 PIN 只能在本机终端里由你本人完成')
  })

  it('wrong confirmation cancels', async () => {
    await setPin()
    answer = '我还没想好'
    expect(await cmdPinReset(home, args, io({ interactive: true }))).toBe(1)
    expect(out.join('')).toContain('已取消')
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain('我确认重置 PIN')
    expect(out.join('')).toMatch(/账本、历史记录与签名身份保留/)
    expect(existsSync(join(home, 'keys', 'pin.json'))).toBe(true)
  })
})
