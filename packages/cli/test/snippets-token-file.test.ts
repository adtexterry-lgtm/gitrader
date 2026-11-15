// SPDX-License-Identifier: CPAL-1.0
import { describe, expect, it } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TOKEN_FILE_ENV, renderSnippet, snippetFor } from '../src/snippets'

const base = { node: '/opt/gitrader/bin/node', mcpEntry: '/opt/gitrader/gitrader-mcp.js', home: '/home/someone/.gitrader' }
const tokenFile = '/home/someone/.gitrader/agent-tokens/research-box.token'

describe('snippet token file', () => {
  it('token file snippet has no plaintext token env', () => {
    for (const host of ['claude-code', 'codex', 'hermes'] as const) {
      const t = renderSnippet({ host, ...base, tokenFile })
      expect(t).toContain(TOKEN_FILE_ENV)
      expect(t).toContain(tokenFile)
      expect(t).not.toMatch(/GITRADER_AGENT_TOKEN\s*[:=]/)
      expect(t).not.toMatch(/gtk_[A-Z2-7]{10,}/)
    }
    const claude = renderSnippet({ host: 'claude-code', ...base, tokenFile })
    const json = JSON.parse(claude.slice(claude.indexOf('\n{\n') + 1, claude.lastIndexOf('}\n') + 1)) as {
      mcpServers: { gitrader: { env: Record<string, string> } }
    }
    expect(claude.indexOf('\n{\n')).toBeGreaterThan(0)
    expect(json.mcpServers.gitrader.env).toEqual({ GITRADER_HOME: base.home, [TOKEN_FILE_ENV]: tokenFile })
  })

  it('default snippet points to agent-tokens path', () => {
    const home = join(tmpdir(), 'gitrader-snippet-home')
    const t = snippetFor('codex', home)
    expect(t).toContain(TOKEN_FILE_ENV)
    expect(t).toContain('agent-tokens')
    expect(t).toContain('请替换为你的钥匙名')
    expect(t).toContain('.token')
    expect(t).not.toMatch(/GITRADER_AGENT_TOKEN\s*[:=]/)
  })
})
