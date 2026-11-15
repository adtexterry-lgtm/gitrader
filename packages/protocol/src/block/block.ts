// SPDX-License-Identifier: Apache-2.0
// 契约 §4.1 块清单 gitrader-block/1、§4.2 块桥、§4.3 联动组。

export const BLOCK_SCHEMA = 'gitrader-block/1'

export const BLOCK_ISOLATION = ['inline', 'iframe'] as const
export type BlockIsolation = (typeof BLOCK_ISOLATION)[number]

/** 块可申请的权限子集（批准提案的能力不在可申请范围内，只由随内核发布的一方块内置）。 */
export const BLOCK_PERMISSIONS = ['market.read', 'account.read', 'ledger.read', 'takeover.trigger', 'workspace.control', 'net.fetch'] as const
export type BlockPermission = (typeof BLOCK_PERMISSIONS)[number]

export const LINK_GROUPS = ['symbol', 'account', 'timeRange', 'strategy', 'experiment'] as const
export type LinkGroupName = (typeof LINK_GROUPS)[number]
export type LinkMode = 'read' | 'readwrite'

/** 联动组的值类型：symbol = instrumentId，account = accountId，timeRange = {from,to}，strategy / experiment = id。 */
export interface LinkValues {
  symbol: string
  account: string
  timeRange: { from: number; to: number }
  strategy: string
  experiment: string
}

/** 事件主题（§4.2）。 */
export const BLOCK_TOPICS = [
  'market.quote', 'market.book', 'market.trades', 'market.candles', 'account.summary', 'account.positions', 'account.orders',
  'account.fills', 'proposal.*', 'risk.state', 'risk.denials', 'ledger.entry', 'engine.health', 'strategy.status', 'workspace.changed',
] as const
/** 联动主题 `link.<group>`。 */
export type BlockTopic = (typeof BLOCK_TOPICS)[number] | `link.${LinkGroupName}`

/** 命令（§4.2）。有副作用的命令必须来自人的点击（瞬时用户激活）。 */
export const BLOCK_COMMANDS = [
  'order.place', 'order.cancel', 'position.close', 'proposal.approve', 'proposal.reject', 'takeover.halt_new',
  'takeover.cancel_all', 'takeover.flatten_all', 'workspace.*', 'link.set', 'note.add', 'ui.openPolicyEditor',
] as const
export type BlockCommand = (typeof BLOCK_COMMANDS)[number]
/** 仅一方签名块可用，且按 §5.1 要求在场证明。 */
export const FIRST_PARTY_ONLY_COMMANDS = ['proposal.approve', 'proposal.reject'] as const

export interface BlockEventInput { topic: string; filter?: Record<string, unknown>; maxHz?: number }

export interface BlockVendor { name: string; url?: string | null }

export interface BlockManifest {
  schema: typeof BLOCK_SCHEMA
  /** `block.<vendor>.<name>`。 */
  id: string
  name: string
  version: string
  /**
   * v0.1.6 裁决：对象 `{name, url?}`（块的 id 里已有 vendor 段；完整的插件级 vendor 信息在插件清单里，块不重复）。
   * v0.1.1 ~ v0.1.5 曾要求完整的 PluginVendor（{id, name, kind, verified}），已改。
   */
  vendor: BlockVendor
  /** v0.1.6 裁决：SPDX 许可证标识字符串（如 "Apache-2.0"）。曾是对象，已改。 */
  license: string
  entry: { module: string; element: string }
  /** inline 仅限签名的一方块；第三方块强制 iframe（sandbox="allow-scripts"，不给 allow-same-origin）。 */
  isolation: BlockIsolation
  size: { minW: number; minH: number; defaultW: number; defaultH: number; maxW?: number; maxH?: number }
  inputs?: { events?: BlockEventInput[]; queries?: string[] }
  actions?: string[]
  permissions: BlockPermission[]
  linkGroups?: { group: LinkGroupName; mode: LinkMode }[]
  /** 钉住块：Agent 不能移除、隐藏或遮挡。 */
  pinned?: boolean
  /** 离线事件回放文件（相对块目录，数组，至少一个）；块不连内核也能渲染。 */
  fixtures: string[]
}

// ---- 块桥（§4.2）---------------------------------------------------------------------

export interface BridgeHelloParams { blockId: string; version: string; instanceId: string }
export interface BridgeHelloResult {
  permissions: BlockPermission[]
  links: Partial<LinkValues>
  theme: string
  locale: string
}
export interface BridgeMethods {
  'bridge.hello': { params: BridgeHelloParams; result: BridgeHelloResult }
  'bridge.subscribe': { params: { topic: string; filter?: Record<string, unknown> }; result: { subscriptionId: string } }
  'bridge.query': { params: { method: string; params?: Record<string, unknown> }; result: unknown }
  'bridge.command': { params: { action: string; params?: Record<string, unknown> }; result: unknown }
  'bridge.link.set': { params: { group: LinkGroupName; value: unknown }; result: { ok: true } }
}
export const BRIDGE_METHOD_NAMES = ['bridge.hello', 'bridge.subscribe', 'bridge.query', 'bridge.command', 'bridge.link.set'] as const

/** 经桥转给内核的命令，origin 由桥盖章：{actor: "user:<id>", tool: "block:<blockId>:<action>", via: "ui"}。 */
export function bridgeOriginTool(blockId: string, action: string): string {
  return `block:${blockId}:${action}`
}
