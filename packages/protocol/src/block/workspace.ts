// SPDX-License-Identifier: Apache-2.0
// 契约 §4.4 工作区 gitrader-workspace/1、§4.5 布局 API。
import type { Ms } from '../model/decimal'

export const WORKSPACE_SCHEMA = 'gitrader-workspace/1'

export interface WorkspaceItem {
  instanceId: string
  /** `block.<vendor>.<name>@<version>`。 */
  block: string
  x: number
  y: number
  w: number
  h: number
  /** 联动通道名（A / B / …）。 */
  channel?: string
  /** 同一 stack 的块共享位置、以标签切换。 */
  stack?: string
  /** 每个 stack 恰好一个 active。 */
  active?: boolean
  /** 钉住块必须独占瓦片、不得放进 stack。 */
  pinned?: boolean
  config: Record<string, unknown>
}

export interface Workspace {
  schema: typeof WORKSPACE_SCHEMA
  id: string
  name: string
  grid: { cols: number; rowHeight: number }
  /** 每个联动通道的当前值。 */
  channels: Record<string, { symbol?: string; account?: string; timeRange?: { from: number; to: number }; strategy?: string; experiment?: string }>
  items: WorkspaceItem[]
  /** 状态条在网格之外、始终钉住。 */
  statusBar: { block: string; pinned: true; takeover: ('halt_new' | 'cancel_all' | 'flatten_all')[] }
  popouts: { instanceId: string; [k: string]: unknown }[]
  savedBy: { actor: string; at: Ms }
}

/** 工作区语义检查：每个 stack 恰好一个 active；钉住块不在 stack；stack 内瓦片同位置；instanceId 唯一。返回问题列表。 */
export function checkWorkspace(ws: Workspace): string[] {
  const p: string[] = []
  const ids = new Set<string>()
  const stacks = new Map<string, WorkspaceItem[]>()
  for (const it of ws.items) {
    if (ids.has(it.instanceId)) p.push(`duplicate instanceId ${it.instanceId}`)
    ids.add(it.instanceId)
    if (it.pinned && it.stack) p.push(`${it.instanceId}: pinned block must not be in a stack`)
    if (it.x < 0 || it.y < 0 || it.w <= 0 || it.h <= 0 || it.x + it.w > ws.grid.cols) p.push(`${it.instanceId}: outside the ${ws.grid.cols}-column grid`)
    if (it.stack) stacks.set(it.stack, [...(stacks.get(it.stack) ?? []), it])
  }
  for (const [name, items] of stacks) {
    const active = items.filter((i) => i.active).length
    if (active !== 1) p.push(`stack ${name}: expected exactly one active item, got ${active}`)
    const first = items[0]
    if (first && items.some((i) => i.x !== first.x || i.y !== first.y || i.w !== first.w || i.h !== first.h)) p.push(`stack ${name}: items must share one position`)
  }
  return p
}

// ---- §4.5 布局 API ----------------------------------------------------------------------

export interface LayoutApiMethod { method: string; agentCallable: boolean; limit: string }

export const LAYOUT_API: readonly LayoutApiMethod[] = [
  { method: 'workspace.list', agentCallable: true, limit: '返回工作区、块实例、位置、钉住状态' },
  { method: 'workspace.add', agentCallable: true, limit: '只能放已安装的块；不得遮挡钉住块' },
  { method: 'workspace.remove', agentCallable: true, limit: '钉住块不可移除' },
  { method: 'workspace.arrange', agentCallable: true, limit: '钉住块必须保持可见且不小于 minW × minH' },
  { method: 'workspace.save', agentCallable: true, limit: '存档标 savedBy: agent:<keyId>；不得覆盖人保存的同名工作区' },
  { method: 'workspace.load', agentCallable: true, limit: '' },
  { method: 'workspace.popout', agentCallable: true, limit: '弹出到独立窗口并保持联动' },
  { method: 'workspace.focus', agentCallable: true, limit: '让人在检阅时跟着 Agent 看' },
  { method: 'workspace.revert', agentCallable: false, limit: '人面：一键还原到人最后保存的布局' },
]

/** Agent 改布局限频每 5 s 一次（防抖动，界面体验，不是 Agent 步数闸）。 */
export const LAYOUT_AGENT_MIN_INTERVAL_MS = 5_000

export interface WorkspaceAddParams { block: string; at?: { x: number; y: number; w: number; h: number } | 'auto'; channel?: string; config?: Record<string, unknown> }
export interface WorkspaceRemoveParams { instanceId: string }
export type WorkspaceArrangeParams = { preset: string } | { items: WorkspaceItem[] }
export interface WorkspaceSaveParams { name: string }
export interface WorkspaceLoadParams { name: string }
export interface WorkspacePopoutParams { instanceId: string }
export interface WorkspaceFocusParams { channel: string; symbol?: string; account?: string; timeRange?: { from: number; to: number } }
