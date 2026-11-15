// SPDX-License-Identifier: CPAL-1.0
// 块对内核的全部接口名集中在这一个文件（和壳的 host-api.ts 同一做法）：改名只改这里和各块清单的 inputs.queries / actions。
// 名字取自内核 ops.ts 现有的查询 / 命令；协议没有定义的标 TODO(protocol)，由主会话 / B 对齐。

export const Q = {
  accounts: 'account.list',
  summary: 'account.summary',
  positions: 'account.positions',
  orders: 'account.orders',
  fills: 'account.fills',
  riskState: 'risk.state',
  riskDenials: 'risk.denials',
  proposals: 'proposal.list',
  keys: 'agentkey.list',
  mandates: 'mandate.list',
  ledger: 'ledger.query',
  venues: 'venue.status',
  status: 'status',
} as const

export const T = {
  positions: 'account.positions',
  summary: 'account.summary',
  fills: 'account.fills',
  proposals: 'proposal.*',
  ledger: 'ledger.entry',
  risk: 'risk.state',
  denials: 'risk.denials',
  venues: 'venue.status',
  mandate: 'mandate.changed',
} as const

export const C = {
  approve: 'proposal.approve',
  reject: 'proposal.reject',
  /** TODO(protocol): 改档位 = 用新级别重签授权书（内核 mandate.update，需要 PIN），参数 {mandateId, input}。 */
  mandateUpdate: 'mandate.update',
  /** 大模型实盘开仓保护：deny=true 收紧（会话），deny=false 放宽（PIN）。TODO(protocol)：协议的人面动作名是 policy.allow_llm_live_entries。 */
  llmLive: 'risk.setLlmLiveEntries',
  /** 协议 UI 通道的恢复命令（ui/wire.ts）。TODO(protocol)：内核现用 risk.resume，名字待 B 对齐。 */
  resume: 'trading_state.resume',
  takeover: (level: string): string => `takeover.${level}`,
  /** TODO(protocol)：重连场所的命令，协议与内核都还没有。 */
  reconnect: 'venue.reconnect',
  /** r4 持仓卡行内动作（内核 ops.ts 会话权限）：平仓 / 部分平仓、挂止损单、撤单。 */
  closePosition: 'position.close',
  place: 'order.place',
  cancel: 'order.cancel',
} as const

export const ORG_SCOPE = { type: 'org' } as const

