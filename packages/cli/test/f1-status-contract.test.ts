// SPDX-License-Identifier: CPAL-1.0
// F1 契约（Owner 批准）：gitrader status 只要正常查出了状态（没 init / 服务没起 / 在运行）就退出 0，输出写明状态与下一步命令；
// 只有查不出状态（数据目录读不了等）才非 0。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { main } from '../src/index'
import type { CliIo } from '../src/index'
import { fileProvider } from '@gitrader/kernel'

let home: string
let out: string[]
const io = (): CliIo => ({
  out: (s) => { out.push(s) }, err: () => undefined, env: { GITRADER_HOME: home }, interactive: false, deviceKey: fileProvider,
  readSecret: async () => { throw new Error('unexpected secret prompt') },
})
const run = (argv: string[]): Promise<number> => main(argv, io())
const text = (): string => out.join('')

beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'gitrader-f1-')); out = [] })
afterEach(() => { rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })

describe('F1 status 退出码契约', () => {
  it('已初始化、服务没起：人读与 --json 都退出 0，写明状态与 gitrader serve --detach', async () => {
    await run(['init', '--no-pin']); out = []
    expect(await run(['status'])).toBe(0)
    expect(text()).toMatch(/服务没在运行/)
    expect(text()).toContain('gitrader serve --detach')
    out = []
    expect(await run(['status', '--json'])).toBe(0)
    expect(JSON.parse(text())).toMatchObject({ running: false, configured: true, state: 'stopped', next: 'gitrader serve --detach' })
  })

  it('没 init：人读与 --json 都退出 0，写明状态与 gitrader init', async () => {
    const fresh = mkdtempSync(join(tmpdir(), 'gitrader-f1-noinit-'))
    try {
      expect(await run(['status', '--home', fresh])).toBe(0)
      expect(text()).toMatch(/还没初始化/)
      expect(text()).toContain('gitrader init')
      out = []
      expect(await run(['status', '--json', '--home', fresh])).toBe(0)
      expect(JSON.parse(text())).toMatchObject({ running: false, configured: false, initialized: false, state: 'not_initialized', next: 'gitrader init' })
    } finally { rmSync(fresh, { recursive: true, force: true }) }
  })

  it('查不出状态（数据目录路径本身是个文件）：仍然非 0', async () => {
    const file = join(home, 'not-a-dir'); writeFileSync(file, 'x')
    expect(await run(['status', '--json', '--home', file])).not.toBe(0)
  })
})
