// SPDX-License-Identifier: CPAL-1.0
// ⌘K 命令面板的命令表与排序（纯逻辑；面板 UI 在 shell/CommandPalette.jsx）。
// 最小检阅版只保留四条：停止新开仓 / 撤销挂单 / 全部平仓 / 打开设置（与风险块按钮、PIN 标题、toast 同名，IXD G8 / F3-3）。
// 留口（未实现，等总会话通知）：切标的、开关块、切预设、恢复交易、还原布局——加命令只需往 buildCommands 里追加，CommandHost 追加对应方法。
import type { TakeoverLevelName } from './host-api'
import { t } from '../ui/lib/i18n.js'

export type CommandGroup = string

export interface Command {
  id: string
  title: string
  group: CommandGroup
  /** 搜索用的额外词（拼音首字母、英文名）。 */
  keywords?: string[]
  /** 右侧提示。 */
  hint?: string
  /** 影响交易的命令：执行前要二次确认（回车确认，不弹窗）。 */
  confirm?: boolean
  run(): void | Promise<void>
}

/** 命令面板依赖的宿主能力（壳实现；测试用假实现）。 */
export interface CommandHost {
  takeover(level: TakeoverLevelName): void | Promise<void>
  go(page: 'workbench' | 'chart' | 'records' | 'funds' | 'plugins' | 'strategies' | 'lab' | 'settings' | 'about', param?: string): void
  r5?: boolean
  toggleNav?: () => void | Promise<void>
  toggleUpdown?: () => void | Promise<void>
  standalone?: { available: boolean; label: string; run: () => void | Promise<void> }
  /** 标的命令的条目（内核 instruments.search 的命中）：displaySymbol 优先用作标题，两个同名市场才分得清。 */
  instruments?: Array<{ id: string; name: string; displaySymbol?: string }>
  experiments?: Array<{ id: string; title: string }>
}

export function buildCommands(h: CommandHost): Command[] {
  const commands: Command[] = [
    { id: 'agent:halt_new', title: t('停止新开仓'), group: 'Agent', keywords: ['pause', 'halt', 'zanting', t('暂停 Agent')], confirm: true, run: () => h.takeover('halt_new') },
    { id: 'agent:cancel_all', title: t('撤销挂单'), group: 'Agent', keywords: ['cancel', 'chexiao', t('撤全部')], confirm: true, run: () => h.takeover('cancel_all') },
    { id: 'agent:flatten_all', title: t('全部平仓'), group: 'Agent', keywords: ['flatten', 'pingcang', t('全平')], confirm: true, run: () => h.takeover('flatten_all') },
    { id: 'agent:revoke_key', title: t('撤销 Agent 钥匙…'), group: 'Agent', keywords: ['revoke', 'chexiao', 'agentkey', t('钥匙')], run: () => h.go('settings', 'keys') }, // 只跳到设置 → 钥匙，不直接撤
    { id: 'go:settings', title: t('打开设置'), group: t('设置'), keywords: ['settings', 'shezhi'], run: () => h.go('settings') },
  ]
  if (!h.r5) return commands

  const pages: Array<{ id: string; title: string; keywords: string[]; route: Parameters<CommandHost['go']>[0]; param?: string }> = [
    { id: 'workbench', title: t('总览'), keywords: ['zl', 'zonglan', 'overview', 'home'], route: 'workbench' },
    { id: 'chart', title: t('图表'), keywords: ['tb', 'tubiao', 'chart', t('行情')], route: 'chart' },
    { id: 'records', title: t('记录'), keywords: ['jl', 'jilu', 'records', t('成交')], route: 'records' },
    { id: 'funds', title: t('资金'), keywords: ['zj', 'zijin', 'funds', t('账户')], route: 'funds' },
    { id: 'strategies', title: t('策略'), keywords: ['cl', 'celue', 'strategy', t('网格'), 'wangge', 'grid', t('定投'), 'dingtou', 'dca', t('启动'), t('停止')], route: 'strategies' },
    { id: 'lab', title: t('实验'), keywords: ['sy', 'shiyan', t('实验'), t('回测'), 'hc', 'huice', 'backtest'], route: 'lab' },
    { id: 'plugins', title: t('插件'), keywords: ['cj', 'chajian', 'plugin'], route: 'plugins' },
    { id: 'venues', title: t('交易所'), keywords: ['jys', 'jiaoyisuo', 'venues', t('场所')], route: 'settings', param: 'venues' },
    { id: 'notifications', title: t('通知'), keywords: ['tz', 'tongzhi', 'notifications'], route: 'settings', param: 'notify' },
    { id: 'personal', title: t('个性化'), keywords: ['gxh', 'gexinghua', 'personal', t('偏好')], route: 'settings', param: 'personal' },
  ]
  commands.push(...pages.map((page) => ({ id: `go:${page.id}`, title: t('打开{0}', page.title), group: t('页面'), keywords: page.keywords, run: () => h.go(page.route, page.param) })))
  for (const instrument of h.instruments ?? []) commands.push({ id: `instrument:${instrument.id}`, title: t('跳到标的 {0}', instrument.displaySymbol ?? instrument.name), group: t('页面'), keywords: ['biaodi', instrument.id], run: () => h.go('chart', instrument.id) })
  for (const experiment of h.experiments ?? []) commands.push({ id: `experiment:${experiment.id}`, title: t('打开实验 {0}', experiment.title), group: t('页面'), keywords: ['shiyan', 'huice', experiment.id], run: () => h.go('lab', experiment.id) })
  // UX-23：搜「pin」要先落在设置 PIN 上（以前只有「全部平仓」的拼音 pingcang 命中，回车两次就平仓）
  commands.push({ id: 'go:pin', title: t('设置 PIN'), group: t('设置'), keywords: ['pin', 'mima', 'shezhipin', t('密码')], run: () => h.go('settings', 'keys') })
  if (h.toggleNav) commands.push({ id: 'toggle:nav', title: t('切换导航形态'), group: t('设置'), keywords: ['qiehuan', 'daohang'], run: () => h.toggleNav!() })
  if (h.toggleUpdown) commands.push({ id: 'toggle:updown', title: t('切换涨跌配色'), group: t('设置'), keywords: ['zhangdie', 'yanse'], run: () => h.toggleUpdown!() })
  if (h.standalone?.available) commands.push({ id: 'standalone:toggle', title: h.standalone.label, group: t('设置'), run: () => h.standalone!.run() })
  return commands
}

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, '')

/** 子序列匹配得分：越连续、越靠前越高；不匹配返回 -1。 */
function score(hay: string, q: string): number {
  if (!q) return 0
  const i = hay.indexOf(q)
  if (i >= 0) return 100 - Math.min(i, 50) + (i === 0 ? 20 : 0)
  let pos = 0; let gaps = 0; let last = -1
  for (const ch of q) {
    const j = hay.indexOf(ch, pos)
    if (j < 0) return -1
    if (last >= 0 && j !== last + 1) gaps += 1
    last = j; pos = j + 1
  }
  return Math.max(1, 40 - gaps * 6)
}

/** 排序：标题 / 关键词匹配；空查询按原顺序。 */
export function rankCommands(cmds: Command[], query: string): Command[] {
  const q = norm(query)
  if (!q) return cmds
  const scored: Array<{ c: Command; s: number }> = []
  for (const c of cmds) {
    let best = score(norm(c.title), q)
    // 影响交易的命令（confirm）靠拼音 / 英文关键词命中要降权：误打几个字母不该让「全部平仓」排第一；标题命中不受影响
    for (const k of c.keywords ?? []) best = Math.max(best, score(norm(k), q) - 5 - (c.confirm ? 30 : 0))
    if (best >= 0) scored.push({ c, s: best })
  }
  return scored.sort((a, b) => b.s - a.s).map((x) => x.c)
}

/**
 * 执行一条命令。需要二次确认的命令第一次调用只返回 'confirm'，由面板把这一行切到「回车确认」状态；
 * 第二次带 confirmed=true 才真正执行。执行错误原样抛给调用方（面板用 toast 显示上游原文）。
 */
export async function dispatch(cmd: Command, confirmed: boolean): Promise<'confirm' | 'done'> {
  if (cmd.confirm && !confirmed) return 'confirm'
  await cmd.run()
  return 'done'
}
