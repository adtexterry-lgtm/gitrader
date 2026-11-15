// SPDX-License-Identifier: CPAL-1.0
// R3-06：paper replay 在普通主目录里没有装配 -> 退出 help 和用户文档；命令在普通主目录里直接说清楚（非 0），回放主目录（paperReplay 夹具）里仍可用。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileProvider } from '@gitrader/kernel'
import { main } from '../src/index'
import type { CliIo } from '../src/index'

let home: string
let out: string[]
let err: string[]
const io = (): CliIo => ({
  out: (s) => { out.push(s) }, err: (s) => { err.push(s) }, env: { GITRADER_HOME: home }, interactive: false, deviceKey: fileProvider,
  readSecret: async () => { throw new Error('unexpected secret prompt') },
})
const run = (argv: string[]): Promise<number> => main(argv, io())

beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'gitrader-r6e-replay-')); out = []; err = [] })
afterEach(() => { rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })

describe('R3-06 paper replay 二选一：退出 help', () => {
  it('help 与 paper --help 里不再列 paper replay；其余 paper 子命令还在', async () => {
    expect(await run(['help'])).toBe(0)
    const help = out.join('')
    expect(help).not.toMatch(/paper replay/)
    expect(help).toMatch(/gitrader paper reset/)
    expect(help).toMatch(/gitrader paper rebuild-from-ledger/)
    out = []
    expect(await run(['paper', '--help'])).toBe(0)
    expect(out.join('')).not.toMatch(/paper replay/)
  })

  it('普通主目录里 paper replay start/status/stop 都以非 0 退出，并说清楚只存在于专用回放主目录', async () => {
    expect(await run(['init', '--no-pin'])).toBe(0)
    for (const argv of [
      ['paper', 'replay', 'start', 'ema-cross', '--account', 'paper', '--instrument', 'hyperliquid:BTC', '--interval', '1h'],
      ['paper', 'replay', 'status'],
      ['paper', 'replay', 'stop', 'job_x'],
    ]) {
      err = []
      expect(await run(argv), argv.join(' ')).not.toBe(0)
      expect(err.join('')).toMatch(/paper replay is not available in this home.*paperReplay/s)
      expect(err.join('')).not.toMatch(/5002|INTERNAL/)
    }
  })

  it('配了 paperReplay 的回放主目录不被这条拦：走到「先起本机服务」这一步', async () => {
    expect(await run(['init', '--no-pin'])).toBe(0)
    const cfgPath = join(home, 'gitrader.json')
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as Record<string, unknown>
    cfg.paperReplay = { fixture: 'fixture.json' }
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2))
    err = []
    expect(await run(['paper', 'replay', 'status'])).not.toBe(0)
    expect(err.join('')).toMatch(/start the local service before using paper replay/)
  })

  it('用户文档 04 / 05 / 10（中英）不再提供 paper replay start', () => {
    const root = join(__dirname, '..', '..', '..', 'docs', 'user')
    for (const f of ['04-回测与研究.md', '05-实盘与风控.md', '10-常见问题.md']) {
      for (const p of [join(root, f), join(root, 'en', f)]) {
        expect(existsSync(p), p).toBe(true)
        expect(readFileSync(p, 'utf8'), p).not.toMatch(/paper replay start/)
      }
    }
  })
})
