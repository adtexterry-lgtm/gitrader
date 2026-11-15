// SPDX-License-Identifier: CPAL-1.0
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { main } from '../src/index'
import type { CliIo } from '../src/index'
import { fileProvider } from '@gitrader/kernel'
import { isWeakPin, validatePinShape } from '../../kernel/src/pin'

let home: string
let out: string[]
let err: string[]
let secrets: string[]
let prompts: string[]

const io = (over: Partial<CliIo> = {}): CliIo => ({
  out: (s) => { out.push(s) }, err: (s) => { err.push(s) }, env: { GITRADER_HOME: home }, interactive: false, deviceKey: fileProvider,
  readSecret: async (prompt) => {
    prompts.push(prompt)
    const s = secrets.shift()
    if (s === undefined) throw new Error('unexpected secret prompt')
    return s
  },
  ...over,
})
const run = (argv: string[], over: Partial<CliIo> = {}): Promise<number> => main(argv, io(over))
const text = (): string => out.join('')

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'gitrader-e0-11-'))
  out = []; err = []; secrets = []; prompts = []
})
afterEach(() => { rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })

describe('gitrader init PIN 体验', () => {
  it('short PIN is rejected at first entry and re-asked', async () => {
    secrets = ['123', '482916', '482916']
    expect(await run(['init'], { interactive: true })).toBe(0)
    expect(err.join('')).toContain('PIN 要 6–12 位数字，或 8–64 位的口令')
    expect(prompts.filter((p) => p.includes('设置 PIN'))).toHaveLength(2)
    expect(existsSync(join(home, 'keys', 'pin.json'))).toBe(true)
  })

  it('mismatch re-asks only the second entry', async () => {
    secrets = ['482916', '111111', '482916']
    expect(await run(['init'], { interactive: true })).toBe(0)
    expect(err.join('')).toContain('两次输入不一致，请重输第二遍')
    expect(prompts.filter((p) => p.includes('设置 PIN'))).toHaveLength(1)
    expect(prompts.filter((p) => p.includes('再输一遍'))).toHaveLength(2)
    expect(existsSync(join(home, 'keys', 'pin.json'))).toBe(true)
  })

  it('weak PIN asks for confirmation', async () => {
    secrets = ['111111', 'n', '246810', '246810']
    expect(await run(['init'], { interactive: true })).toBe(0)
    expect(prompts.some((p) => p.includes('这个 PIN 容易被猜到，仍要使用吗？(y/N)'))).toBe(true)
    expect(prompts.filter((p) => p.includes('设置 PIN'))).toHaveLength(2)
    expect(existsSync(join(home, 'keys', 'pin.json'))).toBe(true)
  })

  it('PIN_STDIN reads two lines at once', async () => {
    expect(await run(['init'], {
      interactive: false,
      env: { GITRADER_HOME: home, GITRADER_PIN_STDIN: '1' },
      readStdin: async () => '482916\n482916\n',
    })).toBe(0)
    expect(prompts).toHaveLength(0)
    expect(existsSync(join(home, 'keys', 'pin.json'))).toBe(true)
  })

  it('init --no-pin non-interactive does not contradict itself', async () => {
    expect(await run(['init', '--no-pin'])).toBe(0)
    expect(text()).toContain('稍后在浏览器里设 PIN')
    expect(text()).not.toContain('请之后在终端里运行 gitrader init')
    expect(text()).not.toContain('PIN 未设置')
    expect(existsSync(join(home, 'keys', 'pin.json'))).toBe(false)
  })

  it('init without --no-pin non-interactive points to the browser or an interactive terminal', async () => {
    expect(await run(['init'])).toBe(0)
    expect(text()).toContain('PIN 未设置：当前不是交互终端。可以先 gitrader serve，在浏览器里设 PIN；或在交互终端运行 gitrader init')
    expect(text()).not.toContain('请之后在终端里运行 gitrader init')
  })

  it('init --help creates no files', async () => {
    expect(await run(['init', '--help'])).toBe(0)
    expect(text()).toContain('--no-pin')
    expect(existsSync(join(home, 'gitrader.json'))).toBe(false)
    expect(existsSync(join(home, 'keys'))).toBe(false)
  })

  it('serve --help starts nothing', async () => {
    expect(await run(['serve', '--help'])).toBe(0)
    expect(existsSync(join(home, 'gitrader.json'))).toBe(false)
    expect(existsSync(join(home, 'service.json'))).toBe(false)
  })
})

describe('PIN 纯函数', () => {
  it('validatePinShape and isWeakPin', () => {
    const reason = 'PIN 要 6–12 位数字，或 8–64 位的口令'
    for (const ok of ['482916', '123456789012', 'passphrase']) expect(validatePinShape(ok)).toBeUndefined()
    for (const bad of ['', '12345', 'a'.repeat(65)]) expect(validatePinShape(bad)).toBe(reason)
    for (const weak of ['000000', '111111', '123456', '654321', '012345', '987654', '0123456789']) expect(isWeakPin(weak)).toBe(true)
    for (const strong of ['482916', '123457', '112233', '135790', 'abcdefgh', '120934']) expect(isWeakPin(strong)).toBe(false)
  })
})
