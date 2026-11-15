// SPDX-License-Identifier: CPAL-1.0
import { describe, expect, it } from 'vitest'
import { buildCommands, dispatch, rankCommands, type CommandHost } from '../src/core/commands'

const host = (extra: Partial<CommandHost> = {}): CommandHost => ({ takeover: () => {}, go: () => {}, ...extra })

describe('r5 command palette entries', () => {
  it('adds ten page commands only when r5 is enabled', () => {
    const legacy = buildCommands(host())
    // fix-r4: C6 新增「撤销 Agent 钥匙…」命令，基础命令 4 → 5
    expect(legacy).toHaveLength(5)
    const enabled = buildCommands(host({ r5: true }))
    expect(enabled.filter((command) => command.group === '页面').map((command) => command.title)).toEqual([
      '打开总览', '打开图表', '打开记录', '打开资金', '打开策略', '打开实验', '打开插件', '打开交易所', '打开通知', '打开个性化',
    ])
  })

  it('撤销 Agent 钥匙命令只跳到设置 → 钥匙，不直接撤（fix-r4 C6）', async () => {
    const calls: unknown[][] = []
    const cmd = buildCommands(host({ go: (...args) => calls.push(args) })).find((c) => c.title === '撤销 Agent 钥匙…')!
    expect(cmd.group).toBe('Agent')
    expect(cmd.confirm).toBeFalsy()
    await dispatch(cmd, false)
    expect(calls).toEqual([['settings', 'keys']])
    expect(rankCommands(buildCommands(host()), 'agent钥匙')[0]?.id).toBe('agent:revoke_key')
  })

  it('routes pages with params for settings tabs and searches experiment/backtest keywords', async () => {
    const calls: unknown[][] = []
    const h = host({ r5: true, go: (...args) => calls.push(args) })
    await dispatch(buildCommands(h).find((command) => command.title === '打开交易所')!, true)
    await dispatch(buildCommands(h).find((command) => command.title === '打开通知')!, true)
    await dispatch(buildCommands(h).find((command) => command.title === '打开个性化')!, true)
    await dispatch(buildCommands(h).find((command) => command.title === '打开图表')!, true)
    expect(calls).toEqual([['settings', 'venues'], ['settings', 'notify'], ['settings', 'personal'], ['chart', undefined]])
    expect(rankCommands(buildCommands(h), 'huice')[0]?.title).toBe('打开实验')
    expect(rankCommands(buildCommands(h), 'tb')[0]?.title).toBe('打开图表')
    expect(rankCommands(buildCommands(h), 'sy')[0]?.title).toBe('打开实验')
  })

  it('GQ-11: Ctrl+K 搜「网格」「定投」「停止」能找到策略页', () => {
    const cmds = buildCommands(host({ r5: true }))
    for (const q of ['网格', 'wangge', 'grid', '定投', 'dca']) expect(rankCommands(cmds, q)[0]?.title, q).toBe('打开策略')
    expect(rankCommands(cmds, '停止').map((c) => c.title)).toContain('打开策略') // 「停止新开仓」排在前面，策略页也在结果里
  })

  it('lists instrument and experiment commands only for provided entries', async () => {
    const calls: unknown[][] = []
    const h = host({ r5: true, instruments: [{ id: 'x', name: 'BTC/USD' }], experiments: [{ id: 'e1', title: 'trial one' }], go: (...args) => calls.push(args) })
    const cmds = buildCommands(h)
    expect(cmds.find((command) => command.title === '跳到标的 BTC/USD')).toBeTruthy()
    expect(cmds.find((command) => command.title === '打开实验 trial one')).toBeTruthy()
    expect(buildCommands(host({ r5: true })).some((command) => command.title.startsWith('跳到标的 '))).toBe(false)
    await dispatch(cmds.find((command) => command.title === '打开实验 trial one')!, true)
    expect(calls).toEqual([['lab', 'e1']])
  })

  it('exposes optional host commands only when their capabilities are available', () => {
    const plain = buildCommands(host({ r5: true })).map((command) => command.id)
    expect(plain).not.toContain('nav:toggle')
    expect(plain).not.toContain('updown:toggle')
    expect(plain).not.toContain('standalone:toggle')
    const capable = buildCommands(host({ r5: true, toggleNav() {}, toggleUpdown() {}, standalone: { available: true, label: '独立模式', run() {} } }))
    expect(capable.map((command) => command.title)).toContain('独立模式')
    expect(capable.map((command) => command.title)).toContain('切换导航形态')
    expect(capable.map((command) => command.title)).toContain('切换涨跌配色')
  })
})
