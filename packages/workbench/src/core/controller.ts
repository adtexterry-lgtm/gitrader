// SPDX-License-Identifier: CPAL-1.0
// 工作区控制器：持有当前工作区，人的每次编辑走布局引擎校验后落到内核（经 WorkspaceApi），
// Agent 经内核改布局时收到 workspace.changed 并应用，同时给人一条可撤销的提示（契约 §4.5）。
import type { Workspace, WorkspaceChangedEvent, WorkspaceItem, WorkspaceMeta } from '@gitrader/blocks-sdk'
import {
  addBlock, applyPreset, arrangeItems, dropUninstalled, moveTile, removeInstance, resizeTile, setActive, setChannel, setConfig, setPinned, stackInto, unstack, validateWorkspace,
  type AddOptions, type LayoutCtx, type LayoutResult, type Rect, type SizeLookup,
} from './workspace'
import { DEFAULT_PRESET, presetWorkspace, type PresetId } from './presets'
import type { WorkspaceApi } from './host-api'
import { isMethodMissing } from './host-api'

export interface AgentNotice { by: string; reason?: string; at: number }

export interface ControllerOptions {
  api: WorkspaceApi
  sizeOf: SizeLookup
  /** 本地存储兜底：内核没有 workspace 接口时用（开发期 / 内核未就绪）。 */
  fallback?: { get(): Workspace | null; set(ws: Workspace): void }
  /** 当前用户 id，用于 savedBy。 */
  user?: string
  now?: () => number
  /** 编辑落盘的防抖毫秒；测试传 0。 */
  debounceMs?: number
}

export type Listener = (ws: Workspace) => void

/** 一个操作的结果：成功时已应用并排队落盘。 */
export type OpResult = { ok: true; instanceId?: string } | { ok: false; code: string; message: string }

export class WorkspaceController {
  private ws: Workspace
  private subs = new Set<Listener>()
  private noticeSubs = new Set<(n: AgentNotice | null) => void>()
  private errorSubs = new Set<(e: Error) => void>()
  private revision = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private inflight: Promise<void> = Promise.resolve()
  private offline = false
  notice: AgentNotice | null = null

  constructor(private readonly o: ControllerOptions) {
    this.ws = this.fresh(DEFAULT_PRESET)
  }

  private now(): number { return (this.o.now ?? Date.now)() }
  private ctx(actor: LayoutCtx['actor'] = 'user'): LayoutCtx { return { actor, sizeOf: this.o.sizeOf } }
  private fresh(preset: PresetId): Workspace { return { ...presetWorkspace(preset), id: 'ws_default', name: presetWorkspace(preset).name } }

  get(): Workspace { return this.ws }
  /** 内核没有工作区接口，当前只在本机浏览器里存。 */
  get isLocalOnly(): boolean { return this.offline }

  subscribe(fn: Listener): () => void { this.subs.add(fn); return () => { this.subs.delete(fn) } }
  /** 布局落盘失败（内核拒绝 / 断线）：原文交给界面 toast，不吞掉。 */
  onSaveError(fn: (e: Error) => void): () => void { this.errorSubs.add(fn); return () => { this.errorSubs.delete(fn) } }
  onNotice(fn: (n: AgentNotice | null) => void): () => void { this.noticeSubs.add(fn); return () => { this.noticeSubs.delete(fn) } }

  private emit(): void { for (const f of this.subs) f(this.ws) }
  private setNotice(n: AgentNotice | null): void { this.notice = n; for (const f of this.noticeSubs) f(n) }

  /** 启动：读内核当前工作区；没有就用默认预设并写回。 */
  async init(): Promise<void> {
    try {
      const cur = await this.o.api.current()
      if (cur) { this.ws = cur.workspace; this.revision = cur.revision } else { this.ws = this.fresh(DEFAULT_PRESET); await this.push() }
    } catch (e) {
      if (!isMethodMissing(e)) throw e
      this.offline = true
      this.ws = this.o.fallback?.get() ?? this.fresh(DEFAULT_PRESET)
    }
    this.emit()
  }

  /** 内核连不上：先用本机布局干活，不再往内核推（避免每次编辑都报错）。 */
  goLocal(): void { this.offline = true }

  /** 内核重新可用：以内核当前布局为准（本机离线期间的编辑被覆盖——内核才是权威）。 */
  async resync(): Promise<void> { this.offline = false; await this.init() }

  // ---- 编辑（人） ----
  private commit(res: LayoutResult, actor: LayoutCtx['actor'] = 'user'): OpResult {
    if (!res.ok) return { ok: false, code: res.code, message: res.message }
    void actor
    this.ws = this.stamp(res.ws)
    this.emit()
    this.schedulePush()
    return { ok: true, ...('instanceId' in res ? { instanceId: (res as { instanceId: string }).instanceId } : {}) }
  }

  private stamp(ws: Workspace): Workspace {
    return { ...ws, savedBy: { actor: `user:${this.o.user ?? 'usr_local'}`, at: this.now() } }
  }

  /** 拖动预览（不提交）：返回放下后的整体布局或失败原因。 */
  previewMove(key: string, x: number, y: number): LayoutResult { return moveTile(this.ws, key, x, y, this.ctx()) }
  previewResize(key: string, w: number, h: number): LayoutResult { return resizeTile(this.ws, key, w, h, this.ctx()) }

  move(key: string, x: number, y: number): OpResult { return this.commit(moveTile(this.ws, key, x, y, this.ctx())) }
  resize(key: string, w: number, h: number): OpResult { return this.commit(resizeTile(this.ws, key, w, h, this.ctx())) }
  add(ref: string, opts: AddOptions = {}): OpResult { return this.commit(addBlock(this.ws, ref, opts, this.ctx())) }
  remove(instanceId: string): OpResult { return this.commit(removeInstance(this.ws, instanceId, this.ctx())) }
  activate(instanceId: string): OpResult { return this.commit(setActive(this.ws, instanceId)) }
  stack(instanceId: string, targetKey: string): OpResult { return this.commit(stackInto(this.ws, instanceId, targetKey, this.ctx())) }
  unstack(instanceId: string): OpResult { return this.commit(unstack(this.ws, instanceId, this.ctx())) }
  pin(instanceId: string, pinned: boolean): OpResult { return this.commit(setPinned(this.ws, instanceId, pinned, this.ctx())) }
  configure(instanceId: string, patch: Record<string, unknown>): OpResult { return this.commit(setConfig(this.ws, instanceId, patch)) }
  setChannel(instanceId: string, channel: string): OpResult { return this.commit(setChannel(this.ws, instanceId, channel)) }
  arrange(items: WorkspaceItem[]): OpResult { return this.commit(arrangeItems(this.ws, items, this.ctx())) }

  /** 联动通道的值变了（LinkHub.onAny 调用）：写回工作区 channels，随布局一起保存。 */
  setLink(channel: string, group: string, value: unknown): void {
    const cur = this.ws.channels[channel] ?? {}
    if (JSON.stringify((cur as Record<string, unknown>)[group]) === JSON.stringify(value)) return
    this.ws = this.stamp({ ...this.ws, channels: { ...this.ws.channels, [channel]: { ...cur, [group]: value } } })
    this.emit()
    this.schedulePush()
  }

  /** 套用内置预设（保留联动通道值）。 */
  usePreset(id: PresetId): OpResult {
    // 预设里有本机没装的块时，跳过这些块而不是整体失败。
    const next = dropUninstalled(applyPreset(this.ws, presetWorkspace(id)), this.o.sizeOf)
    const issues = validateWorkspace(next, this.o.sizeOf)
    if (issues.length) return { ok: false, code: 'INVALID', message: issues[0]!.message }
    return this.commit({ ok: true, ws: next })
  }

  /** 重置 = 回到默认预设（交易）。 */
  reset(): OpResult { return this.usePreset(DEFAULT_PRESET) }

  // ---- 保存 / 加载（经内核 API → ~/.gitrader/workspaces/*.json） ----
  async list(): Promise<WorkspaceMeta[]> {
    if (this.offline) return []
    return this.o.api.list()
  }

  async saveAs(name: string): Promise<WorkspaceMeta> {
    const ws = { ...this.ws, name, savedBy: { actor: `user:${this.o.user ?? 'usr_local'}`, at: this.now() } }
    this.ws = ws
    this.emit()
    await this.flush()
    return this.o.api.save(name, ws)
  }

  async loadNamed(name: string): Promise<OpResult> {
    const loaded = await this.o.api.load(name)
    // 已卸载的块（工作区里有、本机没装）：丢掉这些条目，其余照常加载。
    const ws = dropUninstalled(loaded, this.o.sizeOf)
    const issues = validateWorkspace(ws, this.o.sizeOf)
    if (issues.length) return { ok: false, code: 'INVALID', message: issues[0]!.message }
    return this.commit({ ok: true, ws })
  }

  /** 一键还原到人最后保存的布局。 */
  async revert(): Promise<void> {
    const st = await this.o.api.revert()
    this.ws = st.workspace
    this.revision = st.revision
    this.setNotice(null)
    this.emit()
  }

  // ---- Agent 改布局 ----
  /** 内核广播 workspace.changed：别人（Agent 或另一个窗口）改了布局。自己刚发出的回声按 revision 丢弃。 */
  onRemoteChange(ev: WorkspaceChangedEvent): void {
    if (ev.revision !== undefined && ev.revision <= this.revision) return
    if (ev.revision !== undefined) this.revision = ev.revision
    this.ws = ev.workspace
    this.emit()
    if (ev.by.startsWith('agent:')) this.setNotice({ by: ev.by, ...(ev.reason ? { reason: ev.reason } : {}), at: this.now() })
  }

  dismissNotice(): void { this.setNotice(null) }

  // ---- 落盘 ----
  private schedulePush(): void {
    if (this.o.debounceMs === 0) { this.queuePush(); return }
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => { this.timer = null; this.queuePush() }, this.o.debounceMs ?? 400)
  }

  private queuePush(): void {
    this.inflight = this.inflight.then(() => this.push()).catch((e: unknown) => { for (const f of this.errorSubs) f(e as Error) })
  }

  /** 立刻把待落盘的改动写完（保存 / 关闭前调用）。 */
  async flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; this.queuePush() }
    await this.inflight
  }

  private async push(): Promise<void> {
    if (this.offline) { this.o.fallback?.set(this.ws); return }
    try {
      const st = await this.o.api.update(this.ws)
      this.revision = st.revision
      // 内核可能规范化了布局（比如纠正钉住规则）：以内核返回为准。
      if (JSON.stringify(st.workspace) !== JSON.stringify(this.ws)) { this.ws = st.workspace; this.emit() }
    } catch (e) {
      if (isMethodMissing(e)) { this.offline = true; this.o.fallback?.set(this.ws); return }
      throw e
    }
  }

  /** 可放进某矩形的最近合法位置（拖拽落点预览用）。 */
  static snap(r: Rect, cols: number, rows: number): Rect {
    const w = Math.min(Math.max(1, r.w), cols); const h = Math.min(Math.max(1, r.h), rows)
    return { x: Math.min(Math.max(0, Math.round(r.x)), cols - w), y: Math.min(Math.max(0, Math.round(r.y)), rows - h), w, h }
  }
}
