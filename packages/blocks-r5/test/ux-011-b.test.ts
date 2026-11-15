// SPDX-License-Identifier: CPAL-1.0
// 0.1.1 客户体验修复 B 包（ux-011）：接入 Agent 后复制的配置提示（UX-08）、纸面授权文案（UX-30）。
import { afterEach, describe, expect, it } from 'vitest'
import { setLauncher } from '@gitrader/workbench/launcher'
import { tokenInstruction } from '../src/views/agent-grant'
import { toEventRow } from '../src/model-strategies'

afterEach(() => setLauncher(''))

describe('UX-08 接入 Agent 的配置提示', () => {
  it('默认（全局 gitrader）POSIX：单引号，格式不变', () => {
    expect(tokenInstruction('codex', String.raw`D:\a b\x.token`, false)).toBe(String.raw`请运行 gitrader mcp snippet codex --token-file 'D:\a b\x.token' 并按输出配置`)
  })
  it('win32 一律双引号（cmd 与 PowerShell 都认）', () => {
    expect(tokenInstruction('codex', String.raw`D:\a b\x.token`, true)).toBe(String.raw`请运行 gitrader mcp snippet codex --token-file "D:\a b\x.token" 并按输出配置`)
  })
  it('宿主「其它」写成 CLI 认的 generic', () => {
    expect(tokenInstruction('other', '/tmp/x.token')).toContain('mcp snippet generic --token-file')
  })
  it('便携包启动器（bin 下的 gitrader.cmd）：用启动器路径、路径双引号（cmd 不认单引号）', () => {
    setLauncher(String.raw`"E:\portable pkg\bin\gitrader.cmd"`)
    const text = tokenInstruction('claude-code', String.raw`D:\ui test\x.token`)
    expect(text).toBe(String.raw`请运行 "E:\portable pkg\bin\gitrader.cmd" mcp snippet claude-code --token-file "D:\ui test\x.token" 并按输出配置`)
    expect(text).not.toContain("'")
  })
})

describe('UX-30 引擎事件不露内部授权号', () => {
  const bound = (mode: 'paper' | 'live') => toEventRow({
    seq: 1, ts: 1, type: 'engine.bound', id: 'led_1', origin: { actor: 'user:usr_local' }, subject: { engineId: 'gitrader-core' },
    payload: { accounts: [{ accountId: 'acct_1', mandateId: 'mdt_01M7AAAA' }] },
  }, [{ accountId: 'acct_1', alias: 'paper', mode, venue: 'kernel-sim', environment: 'testnet' }])
  it('纸面账户：写「纸面授权」，没有 mdt_', () => {
    expect(bound('paper')).toMatchObject({ text: '绑定 gitrader-core · paper', note: '纸面授权' })
  })
  it('实盘账户：仍列授权书号（人要拿它去核对）', () => {
    expect(bound('live')?.note).toBe('授权书 mdt_01M7AAAA')
  })
})
