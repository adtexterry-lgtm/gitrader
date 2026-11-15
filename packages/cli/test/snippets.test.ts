// SPDX-License-Identifier: CPAL-1.0
// 宿主接入片段：格式可解析、绝对路径、令牌绝不出现明文、带验证命令。
import { describe, expect, it } from 'vitest'
import { SNIPPET_HOSTS, checkCommand, locateMcpEntry, renderSnippet, unigitTokenFile } from '../src/snippets'

const WIN = { node: 'C:\\Program Files\\Gitrader\\node.exe', mcpEntry: 'C:\\Program Files\\Gitrader\\gitrader-mcp.js', home: 'C:\\home\\someone\\.gitrader' }
const POSIX = { node: '/opt/gitrader/bin/node', mcpEntry: '/opt/gitrader/gitrader-mcp.js', home: '/home/someone/.gitrader' }
const TOKEN_LIKE = /gtk_[A-Z2-7]{10,}|svc_|boot_|ses_/

describe('renderSnippet', () => {
  it.each(SNIPPET_HOSTS)('%s：不含令牌明文，只引用 GITRADER_AGENT_TOKEN（或令牌文件）', (host) => {
    for (const base of [WIN, POSIX]) {
      const t = renderSnippet({ host, ...base })
      expect(t).not.toMatch(TOKEN_LIKE)
      expect(t).toMatch(/GITRADER_AGENT_TOKEN/)
      // claude-code 是 JSON，反斜杠按 JSON 转义；其余宿主原样
      const lit = host === 'claude-code' ? (x: string) => JSON.stringify(x).slice(1, -1) : (x: string) => x
      expect(t).toContain(lit(base.home))
      expect(t).toContain(lit(base.mcpEntry))
      expect(t).toContain('--check')
    }
  })

  it('Claude Code：.mcp.json 是合法 JSON，路径原样（含空格与反斜杠），令牌用 ${VAR} 引用', () => {
    const t = renderSnippet({ host: 'claude-code', ...WIN })
    const start = t.indexOf('\n{\n') + 1
    const end = t.lastIndexOf('}\n') + 1
    const json = JSON.parse(t.slice(start, end)) as { mcpServers: { gitrader: { type: string; command: string; args: string[]; env: Record<string, string> } } }
    const g = json.mcpServers.gitrader
    expect(g).toMatchObject({ type: 'stdio', command: WIN.node, args: [WIN.mcpEntry] })
    expect(g.env).toEqual({ GITRADER_HOME: WIN.home, GITRADER_AGENT_TOKEN: '${GITRADER_AGENT_TOKEN}' })
  })

  it('Codex：config.toml 的 mcp_servers 段，用字面量字符串写 Windows 路径，env_vars 转发令牌变量', () => {
    const t = renderSnippet({ host: 'codex', ...WIN })
    expect(t).toContain('[mcp_servers.gitrader]')
    expect(t).toContain(`command = '${WIN.node}'`)
    expect(t).toContain(`args = ['${WIN.mcpEntry}']`)
    expect(t).toContain('env_vars = ["GITRADER_AGENT_TOKEN"]')
    expect(t).toContain(`GITRADER_HOME = '${WIN.home}'`)
  })

  it('Hermes：mcp_servers.gitrader 的 stdio 条目，令牌用 ${VAR} 引用', () => {
    const t = renderSnippet({ host: 'hermes', ...POSIX })
    expect(t).toContain('mcp_servers:\n  gitrader:\n    command: \'/opt/gitrader/bin/node\'')
    expect(t).toContain("GITRADER_AGENT_TOKEN: '${GITRADER_AGENT_TOKEN}'")
  })

  it('UNIGIT：profile 补丁形状（宿主自己的 process.execPath + ELECTRON_RUN_AS_NODE），令牌走文件，failOnStartupError 为 false', () => {
    const t = renderSnippet({ host: 'unigit', ...WIN })
    expect(t).toContain("id: unigit-gitrader-mcp")
    expect(t).toContain("command: !!js 'process.execPath'")
    expect(t).toContain("ELECTRON_RUN_AS_NODE: '1'")
    expect(t).toContain('failOnStartupError: false')
    expect(t).toContain(`GITRADER_AGENT_TOKEN_FILE: '${unigitTokenFile(WIN.home).replace(/'/g, "''")}'`)
    expect(t).toContain('official.gitrader-mcp')
  })

  it('入口文件不存在时提示先构建，仍给出带绝对路径的配置', () => {
    const t = renderSnippet({ host: 'codex', ...POSIX, mcpBuilt: false })
    expect(t).toMatch(/还不存在/)
    expect(t).toContain(POSIX.mcpEntry)
  })

  it('验证命令带引号，路径含空格也能直接粘贴', () => {
    expect(checkCommand(WIN)).toBe(`"${WIN.node}" "${WIN.mcpEntry}" --check`)
  })

  it('文案里没有禁词', () => {
    for (const host of SNIPPET_HOSTS) expect(renderSnippet({ host, ...POSIX })).not.toMatch(/Comfy|WalletConnect|保守|激进/)
  })
})

describe('locateMcpEntry', () => {
  it('依次找：与 CLI 同目录 → 产品布局兄弟目录 → 仓库布局；都没有就给仓库布局的绝对路径并标未构建', () => {
    const here = process.platform === 'win32' ? 'C:\\g\\cli\\dist' : '/g/cli/dist'
    const none = locateMcpEntry(here, () => false)
    expect(none.built).toBe(false)
    expect(none.path).toMatch(/mcp[\\/]dist[\\/]gitrader-mcp\.js$/)
    const same = locateMcpEntry(here, (p) => /cli[\\/]dist[\\/]gitrader-mcp\.js$/.test(p))
    expect(same).toMatchObject({ built: true })
    expect(same.path).toMatch(/cli[\\/]dist[\\/]gitrader-mcp\.js$/)
    const sibling = locateMcpEntry(here, (p) => /cli[\\/]mcp[\\/]gitrader-mcp\.js$/.test(p))
    expect(sibling.built).toBe(true)
    // 绝对路径
    expect(/^([A-Za-z]:)?[\\/]/.test(none.path)).toBe(true)
  })
})
