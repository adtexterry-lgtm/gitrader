// SPDX-License-Identifier: Apache-2.0
// 契约 §4.1 块清单 `gitrader-block/1`。
// 类型 re-export 自 @gitrader/protocol/types（浏览器安全的纯类型入口）；常量与校验在本包，值与 protocol 的 block/block.ts 一致。

import type { BlockManifest as ProtocolBlockManifest } from '@gitrader/protocol/types'

export const BLOCK_SCHEMA = 'gitrader-block/1' as const

/** 块可申请的权限（§4.1）。批准提案的能力不在可申请范围内，只由随内核发布的一方块内置。 */
export const BLOCK_PERMISSIONS = ['market.read', 'account.read', 'ledger.read', 'takeover.trigger', 'workspace.control', 'net.fetch'] as const
export type BlockPermission = (typeof BLOCK_PERMISSIONS)[number]

export const LINK_GROUPS = ['symbol', 'account', 'timeRange', 'strategy', 'experiment'] as const
export type LinkGroup = (typeof LINK_GROUPS)[number]

export type BlockIsolation = 'inline' | 'iframe'

/** 块清单 `gitrader-block/1`：类型以 @gitrader/protocol 为准（v0.1.6：vendor = {name, url?}，license = SPDX 字符串，fixtures = 数组）。 */
export type BlockManifest = ProtocolBlockManifest
export type BlockSize = BlockManifest['size']
export type BlockInputs = NonNullable<BlockManifest['inputs']>
export type BlockEventInput = NonNullable<BlockInputs['events']>[number]
export type BlockLinkDecl = NonNullable<BlockManifest['linkGroups']>[number]

// ---- 主题 / 命令 / 权限表（§4.2） ------------------------------------------------

export const EVENT_TOPICS = [
  'market.quote', 'market.book', 'market.trades', 'market.candles',
  'account.summary', 'account.positions', 'account.orders', 'account.fills',
  'proposal.*', 'risk.state', 'risk.denials', 'ledger.entry', 'engine.health', 'strategy.status', 'workspace.changed',
] as const

export const COMMAND_ACTIONS = [
  'order.place', 'order.cancel', 'position.close',
  'proposal.approve', 'proposal.reject',
  'takeover.halt_new', 'takeover.cancel_all', 'takeover.flatten_all',
  'workspace.*', 'link.set', 'note.add', 'ui.openPolicyEditor',
] as const

/** 只允许一方签名块（inline + trusted）发的命令（§4.1：批准提案不可申请）。 */
export const FIRST_PARTY_ONLY_ACTIONS: readonly string[] = [
  'proposal.approve', 'proposal.reject',
  'config.venues.set', 'config.notify.set', 'engine.bind', 'lab.stage', 'paper.reset',
    'plugin.grant', 'plugin.uninstall',
]

/** 不需要「来自人的点击」的命令：联动与布局只是界面组织，没有交易副作用。 */
export const NO_ACTIVATION_ACTIONS: readonly string[] = ['link.set']

/**
 * 主题 → 所需权限。TODO(protocol): 契约没给出映射，这是按 §4.1 权限名的推断：
 * market.* → market.read；account.* / proposal.* / risk.* / engine.* / strategy.* → account.read；ledger.* → ledger.read；
 * link.* 与 workspace.changed 不需要权限（联动靠 linkGroups 声明）。
 */
export function topicPermission(topic: string): BlockPermission | null {
  if (topic.startsWith('market.')) return 'market.read'
  if (topic.startsWith('account.') || topic.startsWith('proposal.') || topic.startsWith('risk.') || topic.startsWith('engine.') || topic.startsWith('strategy.')) return 'account.read'
  if (topic.startsWith('ledger.')) return 'ledger.read'
  return null
}

/** 命令 → 所需权限（推断，同上）。 */
export function actionPermission(action: string): BlockPermission | null {
  if (action.startsWith('takeover.')) return 'takeover.trigger'
  if (action.startsWith('workspace.')) return 'workspace.control'
  return null
}

/** 主题模式匹配：`proposal.*` 匹配 `proposal.created`；精确名只匹配自己。 */
export function topicMatches(pattern: string, topic: string): boolean {
  if (pattern === topic) return true
  if (pattern.endsWith('.*')) return topic === pattern.slice(0, -2) || topic.startsWith(pattern.slice(0, -1))
  return false
}

/** 命令模式匹配：`workspace.*` 匹配 `workspace.save`。 */
export const actionMatches = topicMatches

// ---- 校验 -------------------------------------------------------------------------

export interface ManifestIssue { path: string; message: string }

const ID_RE = /^block\.[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$/
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const ELEMENT_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isPosInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0

/** 校验块清单（不依赖 ajv；插件宿主装载时调用）。返回问题清单，空数组 = 通过。 */
export function validateBlockManifest(m: unknown): ManifestIssue[] {
  const out: ManifestIssue[] = []
  const bad = (path: string, message: string) => out.push({ path, message })
  if (!isObj(m)) return [{ path: '', message: '清单必须是对象' }]
  if (m.schema !== BLOCK_SCHEMA) bad('schema', `必须是 "${BLOCK_SCHEMA}"`)
  if (typeof m.id !== 'string' || !ID_RE.test(m.id)) bad('id', '形如 block.<vendor>.<name>')
  for (const k of ['name', 'license'] as const) if (typeof m[k] !== 'string' || !m[k]) bad(k, '必填字符串')
  if (!isObj(m.vendor) || typeof m.vendor.name !== 'string' || !m.vendor.name) bad('vendor', '必填：{name, url?}')
  if (typeof m.version !== 'string' || !SEMVER_RE.test(m.version)) bad('version', '必须是 semver')
  if (!isObj(m.entry) || typeof m.entry.module !== 'string' || typeof m.entry.element !== 'string') bad('entry', '需要 {module, element}')
  else if (!ELEMENT_RE.test(m.entry.element)) bad('entry.element', '自定义元素名必须含连字符且小写')
  if (m.isolation !== 'inline' && m.isolation !== 'iframe') bad('isolation', '必须是 inline 或 iframe')
  if (!isObj(m.size)) bad('size', '必填')
  else {
    const s = m.size
    for (const k of ['minW', 'minH', 'defaultW', 'defaultH']) if (!isPosInt(s[k])) bad(`size.${k}`, '必须是正整数')
    for (const k of ['maxW', 'maxH']) if (s[k] !== undefined && !isPosInt(s[k])) bad(`size.${k}`, '必须是正整数')
    if (isPosInt(s.minW) && isPosInt(s.defaultW) && s.defaultW < s.minW) bad('size.defaultW', '不能小于 minW')
    if (isPosInt(s.minH) && isPosInt(s.defaultH) && s.defaultH < s.minH) bad('size.defaultH', '不能小于 minH')
    if (isPosInt(s.maxW) && isPosInt(s.minW) && s.maxW < s.minW) bad('size.maxW', '不能小于 minW')
    if (isPosInt(s.maxH) && isPosInt(s.minH) && s.maxH < s.minH) bad('size.maxH', '不能小于 minH')
  }
  if (!Array.isArray(m.permissions)) bad('permissions', '必填数组')
  else for (const p of m.permissions) if (!(BLOCK_PERMISSIONS as readonly unknown[]).includes(p)) bad('permissions', `不可申请的权限：${String(p)}`)
  if (isObj(m.inputs)) {
    const ev = m.inputs.events
    if (ev !== undefined && !Array.isArray(ev)) bad('inputs.events', '必须是数组')
    else for (const [i, e] of (ev ?? []).entries()) {
      if (!isObj(e) || typeof e.topic !== 'string') bad(`inputs.events[${i}]`, '需要 topic')
      else if (e.maxHz !== undefined && !(typeof e.maxHz === 'number' && e.maxHz > 0)) bad(`inputs.events[${i}].maxHz`, '必须是正数')
    }
    if (m.inputs.queries !== undefined && !Array.isArray(m.inputs.queries)) bad('inputs.queries', '必须是数组')
  } else if (m.inputs !== undefined) bad('inputs', '必须是对象')
  if (m.actions !== undefined && !Array.isArray(m.actions)) bad('actions', '必须是数组')
  if (Array.isArray(m.actions) && m.isolation === 'iframe') {
    for (const a of m.actions) if (typeof a === 'string' && FIRST_PARTY_ONLY_ACTIONS.includes(a)) bad('actions', `${a} 只允许一方签名块`)
  }
  if (m.linkGroups !== undefined) {
    if (!Array.isArray(m.linkGroups)) bad('linkGroups', '必须是数组')
    else for (const [i, l] of m.linkGroups.entries()) {
      if (!isObj(l) || !(LINK_GROUPS as readonly unknown[]).includes(l.group) || (l.mode !== 'read' && l.mode !== 'readwrite')) bad(`linkGroups[${i}]`, '需要 {group, mode}')
    }
  }
  if (!Array.isArray(m.fixtures) || m.fixtures.length === 0 || m.fixtures.some((f) => typeof f !== 'string' || !f)) bad('fixtures', '必填：离线回放文件（数组，至少一个）')
  if (Array.isArray(m.permissions) && m.permissions.includes('net.fetch') && !(isObj(m.net) && Array.isArray(m.net.hosts) && m.net.hosts.length)) bad('net.hosts', '申请 net.fetch 必须列出主机')
  if (m.isolation === 'iframe' && m.pinned === true) bad('pinned', '钉住块只能是一方 inline 块')
  return out
}

/** 工作区条目里的 `block` 引用：`block.gitrader.chart@0.1.0`。 */
export function parseBlockRef(ref: string): { id: string; version: string | null } {
  const i = ref.lastIndexOf('@')
  return i > 0 ? { id: ref.slice(0, i), version: ref.slice(i + 1) } : { id: ref, version: null }
}
export const blockRef = (id: string, version: string): string => `${id}@${version}`
