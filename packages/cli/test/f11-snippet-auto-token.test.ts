// SPDX-License-Identifier: CPAL-1.0
// ADR-22 A：mcp snippet --write 没给 --token-file 时，用 <home>/agent-tokens/ 里唯一的那把钥匙；
// 输出与 .mcp.json 只出现文件路径，不出现令牌明文。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { main } from '../src/index'
import type { CliIo } from '../src/index'
import { TOKEN_FILE_ENV } from '../src/snippets'

const TOKEN = `gtk_${'B'.repeat(52)}`
let home: string
let cwd: string
let startCwd: string
let out: string[]
let err: string[]

const io = (): CliIo => ({
  out: (s) => { out.push(s) },
  err: (s) => { err.push(s) },
  env: { GITRADER_HOME: home },
  interactive: false,
  readSecret: async () => { throw new Error('unexpected secret prompt') },
})

const run = (argv: string[]): Promise<number> => main(argv, io())
const all = (): string => out.join('') + err.join('')
const writeToken = (name: string): string => {
  const dir = join(home, 'agent-tokens')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, name)
  writeFileSync(file, `${TOKEN}\n`)
  return file
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'gitrader-f11-snippet-home-'))
  cwd = mkdtempSync(join(tmpdir(), 'gitrader-f11-snippet-cwd-'))
  startCwd = process.cwd()
  process.chdir(cwd)
  out = []
  err = []
})
afterEach(() => {
  process.chdir(startCwd)
  rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  rmSync(cwd, { recursive: true, force: true, maxRetries: 5 })
})

describe('F11 mcp snippet --write 自动用唯一令牌', () => {
  it('uses the single token file and prints its path', async () => {
    const tokenFile = writeToken('research.token')
    const code = await run(['mcp', 'snippet', 'claude-code', '--write'])
    expect(code).toBe(0)
    const mcpPath = join(cwd, '.mcp.json')
    expect(existsSync(mcpPath)).toBe(true)
    const text = readFileSync(mcpPath, 'utf8')
    const cfg = JSON.parse(text) as { mcpServers: { gitrader: { env: Record<string, string> } } }
    expect(cfg.mcpServers.gitrader.env[TOKEN_FILE_ENV]).toBe(resolve(tokenFile))
    expect(out.join('')).toContain(resolve(tokenFile))
    expect(all()).not.toContain(TOKEN)
    expect(text).not.toContain(TOKEN)
  })

  it('no token file: exits 1 and tells how to create a key', async () => {
    const code = await run(['mcp', 'snippet', 'claude-code', '--write'])
    expect(code).toBe(1)
    expect(err.join('')).toContain('还没有 Agent 钥匙：先运行 gitrader keys new agent <名字> --host claude-code --preset starter')
    expect(existsSync(join(cwd, '.mcp.json'))).toBe(false)
  })

  it('multiple token files: exits 1 and lists them', async () => {
    writeToken('a.token')
    writeToken('b.token')
    const code = await run(['mcp', 'snippet', 'claude-code', '--write'])
    expect(code).toBe(1)
    expect(err.join('')).toContain('找到 2 个令牌文件：a.token、b.token。请用 --token-file 选一个。')
    expect(existsSync(join(cwd, '.mcp.json'))).toBe(false)
    expect(all()).not.toContain(TOKEN)
  })
})
