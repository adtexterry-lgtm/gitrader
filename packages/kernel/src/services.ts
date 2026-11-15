// SPDX-License-Identifier: CPAL-1.0
// 壳用的小服务：设置（Agent 布局开关）与工作区（当前布局 / 已存布局 / 人最后保存的版本）。工作区是可导出的 JSON，落盘到 <home>/workspaces/。
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { makeProblem, validateWorkspace } from './proto'
import type { Docs } from './db'
import type { EventBus } from './events'
import { KernelError } from './util/errors'
import { writeFileAtomic } from './util/fsperm'
import type { Clock } from './util/clock'
import { assertSafeRelativePath, resolveConfinedPath } from './util/confined-path'

export class SettingsService {
  constructor(private docs: Docs) {}
  /** 「允许 Agent 调整布局」：打开后 MCP 才加载 workspace 工具（契约 §5.7）。默认关。 */
  agentLayout(): boolean { return this.docs.get<{ enabled: boolean }>('settings', 'agent_layout')?.enabled === true }
  setAgentLayout(enabled: boolean): void { this.docs.put('settings', 'agent_layout', { enabled }) }
}

export interface WorkspaceMeta { id: string; name: string; savedBy?: { actor: string; at: number } }
interface Current { workspace: unknown; revision: number }

const bad = (m: string): KernelError => new KernelError(makeProblem('INVALID_PARAMS', m))

export class WorkspaceService {
  constructor(private dir: string, private docs: Docs, private clock: Clock, private events: EventBus) {}

  private file(name: string, options: { mustExist?: boolean } = {}): string {
    try {
      if (name.includes('/') || name.includes('\\')) throw new Error('invalid workspace path')
      const safeName = assertSafeRelativePath(name)
      return resolveConfinedPath(this.dir, `${safeName}.json`, { anchorRoot: dirname(this.dir), ...options })
    } catch {
      throw bad('invalid workspace path')
    }
  }

  private check(ws: unknown): unknown {
    const v = validateWorkspace(ws)
    if (!v.ok) throw bad(`invalid workspace: ${v.issues.map((i) => `${i.path} ${i.message}`).join('; ')}`)
    return v.value
  }

  current(): Current | null { return this.docs.get<Current>('workspace', 'current') ?? null }

  update(ws: unknown, actor: string): Current {
    const value = this.check(ws)
    const next: Current = { workspace: value, revision: (this.current()?.revision ?? 0) + 1 }
    this.docs.put('workspace', 'current', next)
    this.events.publish('workspace.changed', { revision: next.revision, by: actor })
    return next
  }

  save(name: string, ws: unknown, actor: string, human: boolean): { meta: WorkspaceMeta } {
    const value = this.check(ws) as { id?: string }
    const f = this.file(name)
    mkdirSync(this.dir, { recursive: true })
    const meta: WorkspaceMeta = { id: String(value.id ?? name), name, savedBy: { actor, at: this.clock.now() } }
    writeFileAtomic(f, JSON.stringify(value, null, 2) + '\n')
    this.docs.put('workspace-meta', name, meta)
    if (human) this.docs.put('workspace', 'human-saved', { workspace: value, revision: 0 })
    this.events.publish('workspace.changed', { saved: name, by: actor })
    return { meta }
  }

  load(name: string): { workspace: unknown } {
    const f = this.file(name, { mustExist: true })
    try {
      return { workspace: this.check(JSON.parse(readFileSync(f, 'utf8'))) }
    } catch {
      throw bad('invalid workspace file')
    }
  }

  list(): WorkspaceMeta[] {
    if (!existsSync(this.dir)) return []
    const entries: WorkspaceMeta[] = []
    for (const file of readdirSync(this.dir)) {
      if (!file.endsWith('.json')) continue
      const name = file.slice(0, -5)
      try {
        this.file(name, { mustExist: true })
        entries.push(this.docs.get<WorkspaceMeta>('workspace-meta', name) ?? { id: name, name })
      } catch { /* Ignore unsafe and escaped workspace names. */ }
    }
    return entries
  }

  /** 一键还原到人最后保存的布局（人面专属，Agent 不能调）。 */
  revert(): Current {
    const h = this.docs.get<Current>('workspace', 'human-saved')
    if (!h) throw bad('there is no human-saved workspace to revert to')
    const next: Current = { workspace: h.workspace, revision: (this.current()?.revision ?? 0) + 1 }
    this.docs.put('workspace', 'current', next)
    this.events.publish('workspace.changed', { revision: next.revision, reverted: true })
    return next
  }
}
