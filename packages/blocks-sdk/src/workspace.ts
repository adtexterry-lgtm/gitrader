// SPDX-License-Identifier: Apache-2.0
// 契约 §4.4 工作区 `gitrader-workspace/1` 与 §4.5 布局 API 的类型。
// TODO(protocol): 待 @gitrader/protocol 的 block/ 落地后 re-export。

import type { LinkGroup } from './manifest'

export const WORKSPACE_SCHEMA = 'gitrader-workspace/1' as const

export type Stack = string

export interface WorkspaceItem {
  instanceId: string
  /** `block.<vendor>.<name>@<version>` */
  block: string
  x: number
  y: number
  w: number
  h: number
  /** 联动通道名（`A` / `B` / …）。 */
  channel?: string
  /** 同一 stack 的块共享位置、以标签切换。 */
  stack?: Stack
  /** stack 内当前显示的标签；每个 stack 恰好一个。 */
  active?: boolean
  pinned?: boolean
  config?: Record<string, unknown>
}

export interface WorkspaceChannel {
  symbol?: string
  account?: string
  timeRange?: { from: number; to: number }
  strategy?: string
  experiment?: string
}

export interface WorkspaceStatusBar {
  block: string
  pinned: true
  takeover: string[]
}

export interface Workspace {
  schema: typeof WORKSPACE_SCHEMA
  id: string
  name: string
  grid: { cols: number; rowHeight: number }
  channels: Record<string, WorkspaceChannel>
  items: WorkspaceItem[]
  statusBar: WorkspaceStatusBar
  popouts: string[]
  savedBy?: { actor: string; at: number }
}

export interface WorkspaceMeta {
  id: string
  name: string
  savedBy?: { actor: string; at: number }
}

export type { LinkGroup }

/** `workspace.changed` 事件载荷（TODO(protocol)：契约只列了主题名，载荷形状是本包约定）。 */
export interface WorkspaceChangedEvent {
  workspace: Workspace
  /** 谁改的：`user:<id>` / `agent:<keyId>`。 */
  by: string
  /** 单调递增版本号，壳用它丢弃自己刚发出的回声。 */
  revision?: number
  reason?: string
}
