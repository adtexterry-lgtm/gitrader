// SPDX-License-Identifier: CPAL-1.0
// `gitrader mcp snippet claude-code --token-file <路径> --write`：把 gitrader 这一项并进当前目录的 .mcp.json（其它服务器原样保留）。
// 只写令牌文件路径，不写令牌明文；文件不是合法 JSON 时不覆盖，报错让人处理。
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { locateMcpEntry, TOKEN_FILE_ENV } from './snippets'

export function writeClaudeCodeMcp(o: { cwd: string; home: string; tokenFile: string; node?: string; mcpEntry?: string }): string {
  const path = resolve(o.cwd, '.mcp.json')
  let config: { mcpServers?: Record<string, unknown> } = {}
  if (existsSync(path)) {
    try { config = JSON.parse(readFileSync(path, 'utf8').replace(/^﻿/, '')) as typeof config } catch { throw new Error(`${path} 不是合法的 JSON，没有改动它；请先修好或改名后重试`) }
  }
  const mcpEntry = o.mcpEntry ?? locateMcpEntry(dirname(fileURLToPath(import.meta.url))).path
  const entry = { type: 'stdio', command: o.node ?? process.execPath, args: [mcpEntry], env: { GITRADER_HOME: resolve(o.home), [TOKEN_FILE_ENV]: resolve(o.tokenFile) } }
  config.mcpServers = { ...(config.mcpServers ?? {}), gitrader: entry }
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n')
  return path
}
