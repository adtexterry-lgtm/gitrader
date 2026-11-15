// SPDX-License-Identifier: CPAL-1.0
// 0.1.1 客户体验修复 B 包（ux-011）：启动器名 K1、健康快照版本 K2、账户显示 K4、命令面板降权、PIN 表单文案。纯函数 / 源码层断言；真窗口另有截图。
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildCommands, rankCommands, type CommandHost } from '../src/core/commands'
import { readHealth } from '../src/core/health'
import { cli, getLauncher, launcherIsWindows, setLauncher } from '../src/core/launcher'
import { t, setLang } from '../src/ui/lib/i18n.js'
// @ts-expect-error The JSX shell component is outside the package TypeScript compilation boundary.
import { requestRows } from '../src/shell/AgentRequestCard.jsx'

const src = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')
const host = (extra: Partial<CommandHost> = {}): CommandHost => ({ takeover: () => {}, go: () => {}, ...extra })

describe('UX-04 启动器名（K1）', () => {
  it('没告知就是 gitrader；告知后命令文案换成启动器，只换命令名', () => {
    setLauncher(undefined)
    expect(getLauncher()).toBe('gitrader')
    expect(cli('gitrader open')).toBe('gitrader open')
    setLauncher(String.raw`"E:\portable pkg\bin\gitrader.cmd"`)
    expect(cli('gitrader open')).toBe(String.raw`"E:\portable pkg\bin\gitrader.cmd" open`)
    expect(cli('gitrader')).toBe(String.raw`"E:\portable pkg\bin\gitrader.cmd"`)
    expect(cli('npm gitrader open')).toBe('npm gitrader open')
    expect(launcherIsWindows()).toBe(true)
    setLauncher('/usr/local/bin/gitrader')
    expect(launcherIsWindows()).toBe(false)
    setLauncher('')
    expect(getLauncher()).toBe('gitrader')
  })
  it('壳与块里的命令文案都经 cli() 拼出（不再写死）', () => {
    expect(src('../src/shell/Shell.jsx')).toMatch(/cli\(RELINK_CMD\)/)
    expect(src('../src/shell/Shell.jsx')).toMatch(/cli\('gitrader serve'\)/)
    expect(src('../src/shell/Settings.jsx')).toMatch(/cli\(RESTART_CMD\)/)
    expect(src('../../blocks-r5/src/views/agent-grant.tsx')).toMatch(/getLauncher\(\)/)
    expect(src('../../blocks-r5/src/views/venues.tsx')).toMatch(/cli\(RESTART_CMD\)/)
  })
})

describe('UX-06 关于页版本取自健康快照（K2）', () => {
  it('readHealth 取 version / launcher，读不到的字段缺省', async () => {
    const ok = (body: unknown) => (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch
    expect(await readHealth(ok({ version: '0.1.1', launcher: String.raw`C:\g\gitrader.cmd`, ok: true }))).toEqual({ version: '0.1.1', launcher: String.raw`C:\g\gitrader.cmd` })
    expect(await readHealth(ok({ ok: true }))).toEqual({})
    expect(await readHealth((async () => new Response('x', { status: 503 })) as unknown as typeof fetch)).toEqual({})
  })
  it('关于页不再读构建期的包版本号，改读健康快照', () => {
    const about = src('../src/shell/About.jsx')
    expect(about).toContain('readHealth')
    expect(about).not.toContain('__GITRADER_VERSION__')
    expect(src('../build.mjs')).not.toContain('__GITRADER_VERSION__')
  })
})

describe('UX-14 接入请求卡：账户 = 别名 + 纸面/实盘，额度带单位（K4）', () => {
  const req = { requestId: 'akr_demo', state: 'pending', createdAt: 1000, expiresAt: 61000, input: {
    name: '演示助手', host: 'codex', tier: 'confirm', expiresInDays: 30,
    mandate: { accounts: ['acct_01M7ABCDEF', 'acct_01M7ZZZZZZ'], venueAllowlist: ['hyperliquid'], instrumentAllowlist: ['BTC'], limits: { maxOrderNotional: '200', maxDailyNotional: '1000' } },
  } }
  const accounts = [{ accountId: 'acct_01M7ABCDEF', alias: 'paper', mode: 'paper' }]
  it('有账户资料：别名 + 纸面；资料缺失：退回 id 后 6 位；额度行带 USDC', () => {
    const rows = requestRows(req, 1000, { accounts, unit: 'USDC' }).rows
    expect(rows.find((r: string[]) => r[0] === '账户')![1]).toBe('paper · 纸面、ZZZZZZ')
    expect(rows.find((r: string[]) => r[0] === '单笔 / 日额（USDC）')![1]).toBe('200 / 1000')
  })
  it('不给上下文时保持旧输出（既有断言）', () => {
    const rows = requestRows(req, 1000).rows
    expect(rows.find((r: string[]) => r[0] === '账户')![1]).toBe('acct_01M7ABCDEF、acct_01M7ZZZZZZ')
  })
})

describe('UX-23 命令面板：搜 pin 不再把「全部平仓」排第一', () => {
  const cmds = buildCommands(host({ r5: true }))
  it('pin → 设置 PIN 在前；全平仍可用拼音完整输入找到', () => {
    expect(rankCommands(cmds, 'pin')[0]?.id).toBe('go:pin')
    expect(rankCommands(cmds, 'PIN')[0]?.id).toBe('go:pin')
    expect(rankCommands(cmds, 'pingcang')[0]?.id).toBe('agent:flatten_all')
    expect(rankCommands(cmds, '平仓')[0]?.id).toBe('agent:flatten_all')
  })
  it('危险动作靠拼音首段命中时排在导航之后', () => {
    const ids = rankCommands(cmds, 'pin').map((c) => c.id)
    expect(ids.indexOf('go:pin')).toBeLessThan(ids.indexOf('agent:flatten_all'))
  })
})

describe('UX-07 PIN 表单：规则提示、人话错误、禁用态', () => {
  const settings = src('../src/shell/Settings.jsx')
  it('错误走 pinErrorText（中文映射），表单旁有规则提示', () => {
    expect(settings).toContain('pinErrorText')
    expect(settings).toContain('6–12 位数字，或 8–64 位口令')
  })
  it('英文界面的新增文案都有词条', () => {
    setLang('en')
    expect(t('6–12 位数字，或 8–64 位口令')).not.toMatch(/[一-龥]/)
    expect(t('PIN 要 6–12 位数字，或 8–64 位口令')).not.toMatch(/[一-龥]/)
    expect(t('试错次数过多，已暂时锁定 · ')).not.toMatch(/[一-龥]/)
    setLang('zh')
  })
})
