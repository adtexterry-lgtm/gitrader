// SPDX-License-Identifier: CPAL-1.0
// R3-02：mcp snippet 支持 cursor / generic（mcpServers JSON）；令牌只以文件路径出现；片段末尾的工具数从协议的加载表算出来。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { MCP_BUDGET, mcpToolsForLevel } from '@gitrader/protocol'
import { fileProvider } from '@gitrader/kernel'
import { main, toolCountLine } from '../src/index'
import type { CliIo } from '../src/index'
import { ALL_SNIPPET_HOSTS, renderSnippet } from '../src/snippets'

let home: string
let out: string[]
let err: string[]
const io = (): CliIo => ({ out: (s) => { out.push(s) }, err: (s) => { err.push(s) }, env: { GITRADER_HOME: home }, interactive: false, deviceKey: fileProvider, readSecret: async () => { throw new Error('unexpected secret prompt') } })
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'gitrader-snippet-')); out = []; err = [] })
afterEach(() => { rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })

const jsonOf = (text: string): { mcpServers: { gitrader: { command: string; args: string[]; env: Record<string, string> } } } => {
  const body = text.split(/\r?\n/).filter((l) => !/^\s*(#|\/\/)/.test(l)).join('\n')
  return JSON.parse(body.slice(body.indexOf('{'), body.lastIndexOf('}') + 1))
}

describe('mcp snippet cursor / generic', () => {
  it.each(['cursor', 'generic'])('%s：mcpServers.gitrader 有 command / args / env，令牌文件路径在 env 里，令牌明文不出现', async (host) => {
    const tokenFile = resolve(home, 'agent.token')
    expect(await main(['mcp', 'snippet', host, '--token-file', tokenFile], io())).toBe(0)
    const text = out.join('')
    const g = jsonOf(text).mcpServers.gitrader
    expect(typeof g.command).toBe('string')
    expect(g.args.length).toBe(1)
    expect(g.env.GITRADER_HOME).toBe(resolve(home))
    expect(g.env.GITRADER_AGENT_TOKEN_FILE).toBe(tokenFile)
    expect(text).not.toMatch(/gtr_[A-Za-z0-9_-]{10,}/)
    expect(text).not.toMatch(/GITRADER_AGENT_TOKEN"\s*:/) // 不用「令牌明文」那个变量
  })

  it('cursor 写明放到 .cursor/mcp.json（项目级）或 ~/.cursor/mcp.json', async () => {
    expect(await main(['mcp', 'snippet', 'cursor', '--token-file', join(home, 't')], io())).toBe(0)
    expect(out.join('')).toMatch(/\.cursor[\\/]mcp\.json/)
    expect(out.join('')).toContain('~/.cursor/mcp.json')
  })

  it('没给 --token-file 也不落明文：用提示路径', () => {
    for (const host of ['cursor', 'generic'] as const) {
      const text = renderSnippet({ host, node: '/usr/bin/node', mcpEntry: '/opt/gitrader-mcp.js', home: '/h' })
      expect(jsonOf(text).mcpServers.gitrader.env.GITRADER_AGENT_TOKEN_FILE).toMatch(/agent-tokens/)
    }
  })

  it('help 的 mcp snippet 一行列出 cursor 和 generic；未知宿主的 usage 也列出', async () => {
    expect(await main(['help'], io())).toBe(0)
    const line = out.join('').split('\n').find((l) => l.includes('mcp snippet')) ?? ''
    expect(line).toContain('cursor')
    expect(line).toContain('generic')
    out = []
    expect(await main(['mcp', 'snippet', 'bogus'], io())).toBe(1)
    expect(err.join('')).toContain(ALL_SNIPPET_HOSTS.join('|'))
  })
})

describe('片段末尾的工具数', () => {
  it('来自协议的加载表，不是写死的', () => {
    const line = toolCountLine()
    const ro = mcpToolsForLevel('L0').length
    const paper = mcpToolsForLevel('L1').length
    expect(line).toContain(`read-only ${ro},`)
    expect(line).toContain(`auto ${paper} (+`)
    expect(ro).toBe(MCP_BUDGET.defaultLoadL0)
    expect(paper).toBe(MCP_BUDGET.defaultLoadL1Plus)
  })

  it('每个宿主的 snippet 命令输出末尾都带这一行', async () => {
    for (const host of ALL_SNIPPET_HOSTS) {
      out = []
      expect(await main(['mcp', 'snippet', host, '--token-file', join(home, 't')], io())).toBe(0)
      expect(out.join('')).toContain(toolCountLine())
    }
  })
})
