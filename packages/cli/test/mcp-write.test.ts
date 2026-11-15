// SPDX-License-Identifier: CPAL-1.0
// mcp snippet --write：并进 .mcp.json，只写令牌文件路径，保留其它服务器，坏 JSON 不覆盖。
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { writeClaudeCodeMcp } from '../src/mcp-write'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), 'gr-mcpw-')); dirs.push(d); return d }
const base = (cwd: string) => ({ cwd, home: join(cwd, 'home'), tokenFile: join(cwd, 'home', 'agent-tokens', 'a.token'), node: 'node', mcpEntry: join(cwd, 'mcp.js') })

describe('mcp snippet --write', () => {
  it('writes gitrader with a token file path and no token', () => {
    const cwd = tmp()
    const path = writeClaudeCodeMcp(base(cwd))
    const text = readFileSync(path, 'utf8')
    const j = JSON.parse(text) as { mcpServers: { gitrader: { env: Record<string, string> } } }
    expect(j.mcpServers.gitrader.env.GITRADER_AGENT_TOKEN_FILE).toContain('a.token')
    expect(text).not.toMatch(/gtk_/)
    expect(j.mcpServers.gitrader.env.GITRADER_AGENT_TOKEN).toBeUndefined()
  })

  it('keeps other servers', () => {
    const cwd = tmp()
    writeFileSync(join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'x' } } }))
    const j = JSON.parse(readFileSync(writeClaudeCodeMcp(base(cwd)), 'utf8')) as { mcpServers: Record<string, unknown> }
    expect(Object.keys(j.mcpServers).sort()).toEqual(['gitrader', 'other'])
  })

  it('refuses to overwrite broken json', () => {
    const cwd = tmp()
    writeFileSync(join(cwd, '.mcp.json'), '{ broken')
    expect(() => writeClaudeCodeMcp(base(cwd))).toThrow(/不是合法的 JSON/)
    expect(readFileSync(join(cwd, '.mcp.json'), 'utf8')).toBe('{ broken')
  })
})
