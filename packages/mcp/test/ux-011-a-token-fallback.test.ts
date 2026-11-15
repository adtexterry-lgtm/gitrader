// SPDX-License-Identifier: CPAL-1.0
// UX-02：照官方流程（--token-file 建钥匙）做完后，`gitrader-mcp --check` 不用再手动设 GITRADER_AGENT_TOKEN_FILE：
// 令牌回退到 <GITRADER_HOME>/agent-tokens/ 里唯一的 .token 文件（与 `gitrader agent …` 一致）；报错中英双语，不再说「printed once」。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/client'

const TOKEN = `gtk_${'A'.repeat(52)}`
let home: string
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'gitrader-mcp-fb-')) })
afterEach(() => { rmSync(home, { recursive: true, force: true }) })
const tokens = (name: string, text: string): void => { mkdirSync(join(home, 'agent-tokens'), { recursive: true }); writeFileSync(join(home, 'agent-tokens', name), text) }

describe('令牌回退到 agent-tokens 里唯一的文件', () => {
  it('没有环境变量、没有 GITRADER_AGENT_TOKEN_FILE：认 GITRADER_HOME 下唯一的 .token', () => {
    const cfg = resolveConfig({ GITRADER_HOME: home })
    expect(() => cfg.token()).toThrow(/no agent key configured/)
    tokens('claude-code.token', `${TOKEN}\n`)
    expect(cfg.token()).toBe(TOKEN) // 每次调用现读：钥匙可以晚于宿主创建
  })

  it('环境变量、显式令牌文件都优先于回退', () => {
    tokens('claude-code.token', TOKEN)
    const other = `gtk_${'B'.repeat(52)}`
    expect(resolveConfig({ GITRADER_HOME: home, GITRADER_AGENT_TOKEN: other }).token()).toBe(other)
    const f = join(home, 'explicit.token')
    writeFileSync(f, other)
    expect(resolveConfig({ GITRADER_HOME: home, GITRADER_AGENT_TOKEN_FILE: f }).token()).toBe(other)
  })

  it('多个令牌文件：不猜，报错并让人指定', () => {
    tokens('a.token', TOKEN)
    tokens('b.token', TOKEN)
    expect(() => resolveConfig({ GITRADER_HOME: home }).token()).toThrow(/GITRADER_AGENT_TOKEN_FILE/)
  })

  it('报错中英双语、带建钥匙的命令（用启动器名），不再说令牌「printed once」', () => {
    const msgs: string[] = []
    for (const env of [{ GITRADER_HOME: home }, { GITRADER_HOME: home, GITRADER_AGENT_TOKEN_FILE: join(home, 'nope.token') }, { GITRADER_HOME: home, GITRADER_AGENT_TOKEN: 'gtk_bad' }]) {
      try { resolveConfig(env).token() } catch (e) { msgs.push((e as Error).message) }
    }
    expect(msgs).toHaveLength(3)
    for (const m of msgs) { expect(m).toMatch(/[一-龥]/); expect(m).not.toContain('printed once') }
    expect(msgs[0]).toContain('gitrader keys new agent <名字> --host claude-code --preset starter --token-file')
    try { resolveConfig({ GITRADER_HOME: home, GITRADER_LAUNCHER: 'C:\\my pkg\\gitrader.cmd' }).token() } catch (e) { expect((e as Error).message).toContain('"C:\\my pkg\\gitrader.cmd" keys new agent') }
  })
})
