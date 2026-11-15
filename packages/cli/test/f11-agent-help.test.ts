// SPDX-License-Identifier: CPAL-1.0
// ADR-22 A：gitrader agent 的 --help 必须列全工具与动作；缺动作时打工具帮助；未知工具给建议。
// 经 main([...], io) 调用，覆盖 index.ts 的 --help 拦截块。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MCP_TOOLS } from '@gitrader/protocol'
import { main } from '../src/index'
import type { CliIo } from '../src/index'

let home: string
let out: string[]
let err: string[]
let fetchCalls: string[]

const io = (): CliIo => ({
  out: (s) => { out.push(s) },
  err: (s) => { err.push(s) },
  env: { GITRADER_HOME: home },
  interactive: false,
  readSecret: async () => { throw new Error('unexpected secret prompt') },
})

const run = (argv: string[]): Promise<number> => main(argv, io())

/** 假 fetch：记下调用；被调用就说明「不该连内核」的路径走错了。 */
const stubFetch = (): (() => void) => {
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(((url: string) => {
    fetchCalls.push(String(url))
    return Promise.reject(new Error('内核不该被调用'))
  }) as unknown as typeof fetch)
  return () => spy.mockRestore()
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'gitrader-f11-help-'))
  out = []
  err = []
  fetchCalls = []
})
afterEach(() => { rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })

describe('F11 gitrader agent --help', () => {
  it('gitrader agent --help lists every tool and action', async () => {
    const code = await run(['agent', '--help'])
    expect(code).toBe(0)
    const text = out.join('')
    for (const t of MCP_TOOLS) {
      expect(text).toContain(t.name)
      for (const act of t.actions) expect(text).toContain(act.name)
    }
    const accountLine = text.split('\n').find((l) => l.startsWith('  account  ')) ?? ''
    expect(accountLine).toContain('summary')
    expect(text).toContain('每个工具的参数示例：gitrader agent <工具> --help')
  })

  it('gitrader agent account --help lists usage lines', async () => {
    const code = await run(['agent', 'account', '--help'])
    expect(code).toBe(0)
    const text = out.join('')
    expect(text).toContain("gitrader agent account summary --args '")
    expect(text).toContain("gitrader agent account positions --args '")
    const actionLines = text.split('\n').filter((l) => l.includes('gitrader agent account '))
    expect(actionLines.some((l) => l.includes('account get'))).toBe(false)
  })

  it('tool alias works', async () => {
    expect(await run(['agent', 'account', '--help'])).toBe(0)
    const canonical = out.join('')
    out = []
    expect(await run(['agent', 'accounts', '--help'])).toBe(0)
    expect(out.join('')).toBe(canonical)
  })

  it('missing action prints the tool help and exits 2 without calling the kernel', async () => {
    const restore = stubFetch()
    try {
      const code = await run(['agent', 'account'])
      expect(code).toBe(2)
      expect(err.join('')).toContain("gitrader agent account summary --args '")
      expect(fetchCalls).toHaveLength(0)
    } finally { restore() }
  })

  it('unknown tool suggests the closest', async () => {
    const code = await run(['agent', 'acount', 'list'])
    expect(code).toBe(2)
    expect(err.join('')).toContain('是不是想用：account')
    expect(out).toHaveLength(0)
  })

  it('help has no side effects', async () => {
    const restore = stubFetch()
    try {
      expect(await run(['agent', 'account', '--help'])).toBe(0)
      expect(fetchCalls).toHaveLength(0)
      // 没有令牌文件也能拿到帮助，且不建任何目录
      expect(existsSync(join(home, 'agent-tokens'))).toBe(false)
      expect(existsSync(join(home, 'gitrader.json'))).toBe(false)
    } finally { restore() }
  })
})
