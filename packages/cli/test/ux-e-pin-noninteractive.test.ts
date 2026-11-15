// SPDX-License-Identifier: CPAL-1.0
// UX-E0-ds2：没有交互终端时碰到「要 PIN」，终端文案不能再指向网页的「弹出的 PIN 层」，也不能诱导 Agent 重启服务。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileProvider } from '@gitrader/kernel'
import { main, runServe } from '../src/index'
import type { CliIo } from '../src/index'
import { formatFatal } from '../src/fatal'

let home: string
let out: string[]
let err: string[]
let secrets: string[]
const io = (over: Partial<CliIo> = {}): CliIo => ({
  out: (s) => { out.push(s) }, err: (s) => { err.push(s) }, env: { GITRADER_HOME: home, GITRADER_LANG: 'zh' }, interactive: false, deviceKey: fileProvider,
  readSecret: async () => secrets.shift() ?? '', ...over,
})
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'gitrader-ux-e-')); out = []; err = []; secrets = [] })
afterEach(() => { rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })

describe('非交互终端的「要 PIN」文案', () => {
  it('open --print 没拿到 PIN：中文 / 英文都说 Agent 不能代输、让用户自己运行 open、别重启，不出现「弹出」', async () => {
    await main(['init', '--no-pin'], io())
    const h = await runServe(home, { io: io(), connectors: false })
    try {
      await h.kernel.auth.setupPinLocalTerminal('482916')
      for (const lang of ['zh', 'en'] as const) {
        err = []
        expect(await main(['open', '--print', '--lang', lang], io({ env: { GITRADER_HOME: home, GITRADER_LAUNCHER: 'gitrader' } }))).toBe(1)
        const t = err.join('')
        expect(t).not.toContain('弹出')
        expect(t).not.toContain('popup')
        if (lang === 'zh') { expect(t).toContain('不能代输'); expect(t).toContain('gitrader open'); expect(t).toContain('不要重启服务') }
        else { expect(t).toMatch(/cannot type it for you/i); expect(t).toContain('gitrader open'); expect(t).toMatch(/do not restart/i); expect(t).not.toMatch(/[一-龥]/) }
      }
    } finally { await h.stop() }
  })

  it('顶层失败分支（其他命令）：非交互 + 要 PIN 同样换文案；交互终端不动', () => {
    const e = Object.assign(new Error('x'), { problem: { name: 'ATTESTATION_REQUIRED', message: 'a presence proof (PIN) is required for this action' } })
    const zh = formatFatal(e, { nonInteractive: true, lang: 'zh', env: {} })
    expect(zh).toContain('不能代输'); expect(zh).not.toContain('弹出'); expect(zh).toContain('gitrader open')
    const en = formatFatal(e, { nonInteractive: true, lang: 'en', env: { GITRADER_LAUNCHER: 'C:\p\gitrader.cmd' } })
    expect(en).toMatch(/cannot type it for you/i); expect(en).toContain('C:\p\gitrader.cmd open'); expect(en).not.toMatch(/[一-龥]/)
    expect(formatFatal(e, { lang: 'zh', env: {} })).toContain('弹出的 PIN 层')
  })
})
