// SPDX-License-Identifier: CPAL-1.0
// 布局引擎（纯函数，不碰 DOM）：契约 §4.4 工作区 `gitrader-workspace/1` 与 §4.5 布局 API 的规则。
// 24 列网格、行数固定（视口即容器：壳把 rows 行均分到视口高度，所以拖拽缩放不会让行数增长，放不下就拒绝）。
// 所有操作返回新工作区（不改入参）；失败返回 {ok:false, code, message}，由调用方决定提示。
import type { Workspace, WorkspaceItem } from '@gitrader/blocks-sdk'
import { WORKSPACE_SCHEMA } from '@gitrader/blocks-sdk'
import { t as tr } from '../ui/lib/i18n.js'

export const GRID_COLS = 24
/** 默认行数：Demo 预设按 26 行设计；不够用时取内容的最大底边。 */
export const GRID_ROWS = 26

export type Actor = 'user' | 'agent'

export interface SizeLimits { minW: number; minH: number; defaultW: number; defaultH: number; maxW?: number | undefined; maxH?: number | undefined }
/** 由块引用查尺寸约束；查不到的块（未安装）返回 undefined，引擎按 1×1 下限处理。 */
export type SizeLookup = (blockRef: string) => SizeLimits | undefined

export interface Rect { x: number; y: number; w: number; h: number }

export interface Tile extends Rect {
  /** stack 名或 instanceId。 */
  key: string
  items: WorkspaceItem[]
  /** 当前显示的实例。 */
  activeId: string
  pinned: boolean
  stacked: boolean
}

export type LayoutErrorCode =
  | 'NOT_FOUND' | 'PINNED' | 'PINNED_OBSTRUCTED' | 'NO_SPACE' | 'OUT_OF_BOUNDS' | 'TOO_SMALL' | 'INVALID' | 'NOT_INSTALLED' | 'DUPLICATE'
export type LayoutResult<T = unknown> = ({ ok: true; ws: Workspace } & T) | { ok: false; code: LayoutErrorCode; message: string }

export interface LayoutCtx {
  actor: Actor
  sizeOf?: SizeLookup
  rows?: number
  cols?: number
}

const fail = (code: LayoutErrorCode, message: string): { ok: false; code: LayoutErrorCode; message: string } => ({ ok: false, code, message })

export const rowsOf = (ws: Workspace): number => Math.max(GRID_ROWS, ...ws.items.map((i) => i.y + i.h))
const colsOf = (ws: Workspace, ctx?: LayoutCtx): number => ctx?.cols ?? ws.grid?.cols ?? GRID_COLS

// ---- 瓦片 ---------------------------------------------------------------------------

/** 工作区条目 → 瓦片（同 stack 的条目合成一个瓦片，位置取第一个成员）。 */
export function tilesOf(ws: Workspace): Tile[] {
  const out: Tile[] = []
  const byStack = new Map<string, Tile>()
  for (const it of ws.items) {
    if (it.stack) {
      const t = byStack.get(it.stack)
      if (t) { t.items.push(it); if (it.active) t.activeId = it.instanceId; continue }
      const nt: Tile = { key: it.stack, x: it.x, y: it.y, w: it.w, h: it.h, items: [it], activeId: it.instanceId, pinned: false, stacked: true }
      byStack.set(it.stack, nt)
      out.push(nt)
    } else {
      out.push({ key: it.instanceId, x: it.x, y: it.y, w: it.w, h: it.h, items: [it], activeId: it.instanceId, pinned: !!it.pinned, stacked: false })
    }
  }
  for (const t of byStack.values()) if (!t.items.some((i) => i.active)) t.activeId = t.items[0]!.instanceId
  return out
}

const overlap = (a: Rect, b: Rect): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

/** 把瓦片的新矩形写回条目（同 stack 成员一起改）。 */
function withTileRects(ws: Workspace, rects: Map<string, Rect>): Workspace {
  return {
    ...ws,
    items: ws.items.map((it) => {
      const r = rects.get(it.stack ?? it.instanceId)
      return r ? { ...it, x: r.x, y: r.y, w: r.w, h: r.h } : it
    }),
  }
}

function limitsOf(tile: Tile, ctx: LayoutCtx): SizeLimits {
  // stack 的约束取各成员的交集：最大的下限、最小的上限。
  let minW = 1; let minH = 1; let maxW = Infinity; let maxH = Infinity
  for (const it of tile.items) {
    const l = ctx.sizeOf?.(it.block)
    if (!l) continue
    minW = Math.max(minW, l.minW); minH = Math.max(minH, l.minH)
    if (l.maxW) maxW = Math.min(maxW, l.maxW)
    if (l.maxH) maxH = Math.min(maxH, l.maxH)
  }
  return { minW, minH, defaultW: minW, defaultH: minH, ...(maxW < Infinity ? { maxW } : {}), ...(maxH < Infinity ? { maxH } : {}) }
}

/**
 * 把 moving 放到 want：与它相撞的瓦片向下推（可级联）；超出行数则失败。
 * Agent 操作不得推动或遮挡钉住块（§4.5）；人可以推（钉住只防 Agent）。
 */
function settle(tiles: Tile[], movingKey: string, want: Rect, ctx: LayoutCtx, rows: number): { rects: Map<string, Rect> } | { code: LayoutErrorCode; message: string } {
  const rects = new Map<string, Rect>(tiles.map((t) => [t.key, { x: t.x, y: t.y, w: t.w, h: t.h }]))
  rects.set(movingKey, { ...want })
  const pinned = new Set(tiles.filter((t) => t.pinned).map((t) => t.key))
  const queue = [movingKey]
  const guard = tiles.length * tiles.length + 10
  let steps = 0
  while (queue.length) {
    if (steps++ > guard) return { code: 'NO_SPACE', message: tr('放不下：布局无法容纳这次调整') }
    const k = queue.shift()!
    const r = rects.get(k)!
    for (const t of tiles) {
      if (t.key === k || t.key === movingKey && k !== movingKey) continue
      const o = rects.get(t.key)!
      if (!overlap(r, o)) continue
      if (pinned.has(t.key) && ctx.actor === 'agent') return { code: 'PINNED_OBSTRUCTED', message: tr('不得遮挡或推动钉住块') }
      const ny = r.y + r.h
      if (ny + o.h > rows) return { code: 'NO_SPACE', message: tr('放不下：下方没有空间可让位') }
      rects.set(t.key, { ...o, y: ny })
      queue.push(t.key)
    }
  }
  return { rects }
}

function clampRect(r: Rect, lim: SizeLimits, cols: number, rows: number): Rect | null {
  const w = Math.min(Math.max(r.w, lim.minW), lim.maxW ?? cols)
  const h = Math.min(Math.max(r.h, lim.minH), lim.maxH ?? rows)
  if (w > cols || h > rows) return null
  return { x: Math.min(Math.max(0, r.x), cols - w), y: Math.min(Math.max(0, r.y), rows - h), w, h }
}

// ---- 校验 ---------------------------------------------------------------------------

export interface LayoutIssue { code: string; message: string; instanceId?: string }

/** 校验工作区是否满足契约 §4.4 的规则；空数组 = 合格。 */
export function validateWorkspace(ws: Workspace, sizeOf?: SizeLookup): LayoutIssue[] {
  const out: LayoutIssue[] = []
  const add = (code: string, message: string, instanceId?: string) => out.push({ code, message, ...(instanceId ? { instanceId } : {}) })
  if (ws.schema !== WORKSPACE_SCHEMA) add('SCHEMA', tr('schema 必须是 {0}', WORKSPACE_SCHEMA))
  const cols = ws.grid?.cols ?? GRID_COLS
  const rows = rowsOf(ws)
  const ids = new Set<string>()
  for (const it of ws.items) {
    if (ids.has(it.instanceId)) add('DUPLICATE', tr('实例 id 重复'), it.instanceId)
    ids.add(it.instanceId)
    if (![it.x, it.y, it.w, it.h].every(Number.isInteger) || it.w < 1 || it.h < 1 || it.x < 0 || it.y < 0) add('INVALID_RECT', tr('位置或尺寸不是合法的网格整数'), it.instanceId)
    if (it.x + it.w > cols) add('OUT_OF_BOUNDS', tr('超出 {0} 列', cols), it.instanceId)
    const l = sizeOf?.(it.block)
    if (l && (it.w < l.minW || it.h < l.minH)) add('TOO_SMALL', tr('小于块的最小尺寸 {0}×{1}', l.minW, l.minH), it.instanceId)
    if (l && ((l.maxW && it.w > l.maxW) || (l.maxH && it.h > l.maxH))) add('TOO_LARGE', tr('大于块的最大尺寸'), it.instanceId)
    if (it.pinned && it.stack) add('PINNED_STACKED', tr('钉住块必须独占瓦片，不得放进 stack'), it.instanceId)
  }
  const tiles = tilesOf(ws)
  for (const t of tiles) {
    if (t.stacked) {
      const act = t.items.filter((i) => i.active)
      if (act.length !== 1) add('STACK_ACTIVE', tr('stack「{0}」必须恰好一个 active（现有 {1}）', t.key, act.length))
      for (const m of t.items) if (m.x !== t.x || m.y !== t.y || m.w !== t.w || m.h !== t.h) add('STACK_RECT', tr('stack「{0}」成员位置尺寸不一致', t.key), m.instanceId)
    }
  }
  for (let i = 0; i < tiles.length; i += 1) for (let j = i + 1; j < tiles.length; j += 1) if (overlap(tiles[i]!, tiles[j]!)) add('OVERLAP', tr('瓦片「{0}」与「{1}」重叠', tiles[i]!.key, tiles[j]!.key))
  for (const it of ws.items) if (it.channel && !ws.channels[it.channel]) add('CHANNEL', tr('通道 {0} 未在 channels 中声明', it.channel), it.instanceId)
  if (!ws.statusBar?.pinned) add('STATUSBAR', tr('statusBar 必须钉住'))
  void rows
  return out
}

// ---- 操作 ---------------------------------------------------------------------------

const find = (ws: Workspace, instanceId: string): WorkspaceItem | undefined => ws.items.find((i) => i.instanceId === instanceId)
const tileOf = (ws: Workspace, key: string): Tile | undefined => tilesOf(ws).find((t) => t.key === key)

/** 拖动瓦片到 (x, y)（尺寸不变）。 */
export function moveTile(ws: Workspace, key: string, x: number, y: number, ctx: LayoutCtx): LayoutResult {
  const tiles = tilesOf(ws)
  const t = tiles.find((q) => q.key === key)
  if (!t) return fail('NOT_FOUND', tr('找不到这个块'))
  const rows = ctx.rows ?? rowsOf(ws)
  const want = clampRect({ x, y, w: t.w, h: t.h }, { minW: t.w, minH: t.h, defaultW: t.w, defaultH: t.h, maxW: t.w, maxH: t.h }, colsOf(ws, ctx), rows)
  if (!want) return fail('OUT_OF_BOUNDS', tr('超出网格'))
  const res = settle(tiles, key, want, ctx, rows)
  if ('code' in res) return fail(res.code, res.message)
  return { ok: true, ws: withTileRects(ws, res.rects) }
}

/** 调整瓦片尺寸（左上角不动）。钉住块不得小于其最小尺寸（对 Agent 与人一样）。 */
export function resizeTile(ws: Workspace, key: string, w: number, h: number, ctx: LayoutCtx): LayoutResult {
  const tiles = tilesOf(ws)
  const t = tiles.find((q) => q.key === key)
  if (!t) return fail('NOT_FOUND', tr('找不到这个块'))
  const lim = limitsOf(t, ctx)
  if (w < lim.minW || h < lim.minH) return fail('TOO_SMALL', tr('不能小于最小尺寸 {0}×{1}', lim.minW, lim.minH))
  const rows = ctx.rows ?? rowsOf(ws)
  const want = clampRect({ x: t.x, y: t.y, w, h }, lim, colsOf(ws, ctx), rows)
  if (!want) return fail('OUT_OF_BOUNDS', tr('超出网格'))
  const res = settle(tiles, key, want, ctx, rows)
  if ('code' in res) return fail(res.code, res.message)
  return { ok: true, ws: withTileRects(ws, res.rects) }
}

function findFree(tiles: Tile[], w: number, h: number, cols: number, rows: number): Rect | null {
  for (let y = 0; y + h <= rows; y += 1) {
    for (let x = 0; x + w <= cols; x += 1) {
      const r = { x, y, w, h }
      if (!tiles.some((t) => overlap(r, t))) return r
    }
  }
  return null
}

export function newInstanceId(blockRef: string, existing: Iterable<string>): string {
  const id = blockRef.split('@')[0]!.split('.').pop()!.replace(/[^a-z0-9]+/gi, '_').toLowerCase()
  const used = new Set(existing)
  for (let n = 1; ; n += 1) { const c = `bi_${id}_${n}`; if (!used.has(c)) return c }
}

export interface AddOptions { at?: Rect | 'auto'; channel?: string; config?: Record<string, unknown>; instanceId?: string; pinned?: boolean }

/**
 * 加块。at 缺省 / 'auto'：先在空位里找默认尺寸，再试最小尺寸；都没有就叠进最大的非钉住瓦片当标签。
 * 只能放已安装的块（sizeOf 查不到即 NOT_INSTALLED）。给了具体 at 则按 moveTile 的规则让位。
 */
export function addBlock(ws: Workspace, blockRef: string, opts: AddOptions, ctx: LayoutCtx): LayoutResult<{ instanceId: string }> {
  const lim = ctx.sizeOf?.(blockRef)
  if (!lim) return fail('NOT_INSTALLED', tr('这个块没有安装'))
  const cols = colsOf(ws, ctx)
  const rows = ctx.rows ?? rowsOf(ws)
  const instanceId = opts.instanceId ?? newInstanceId(blockRef, ws.items.map((i) => i.instanceId))
  if (find(ws, instanceId)) return fail('DUPLICATE', tr('实例 id 已存在'))
  const channel = opts.channel ?? 'A'
  const base = { instanceId, block: blockRef, channel, config: opts.config ?? {}, ...(opts.pinned ? { pinned: true } : {}) }
  const tiles = tilesOf(ws)
  if (opts.at && opts.at !== 'auto') {
    const want = clampRect(opts.at, lim, cols, rows)
    if (!want) return fail('OUT_OF_BOUNDS', tr('超出网格'))
    const res = settle([...tiles, { ...want, key: instanceId, items: [], activeId: instanceId, pinned: !!opts.pinned, stacked: false }], instanceId, want, ctx, rows)
    if ('code' in res) return fail(res.code, res.message)
    const moved = withTileRects(ws, res.rects)
    return { ok: true, instanceId, ws: { ...moved, items: [...moved.items, { ...base, ...want }] } }
  }
  const spot = findFree(tiles, lim.defaultW, lim.defaultH, cols, rows) ?? findFree(tiles, lim.minW, lim.minH, cols, rows)
  if (spot) return { ok: true, instanceId, ws: { ...ws, items: [...ws.items, { ...base, ...spot }] } }
  if (opts.pinned) return fail('NO_SPACE', tr('放不下：钉住块必须独占瓦片'))
  const host = tiles.filter((t) => !t.pinned).sort((a, b) => b.w * b.h - a.w * a.h)[0]
  if (!host) return fail('NO_SPACE', tr('放不下：没有可叠放的块'))
  const hostLim = limitsOf(host, ctx)
  if (lim.minW > host.w || lim.minH > host.h || hostLim.maxW && lim.minW > hostLim.maxW) return fail('NO_SPACE', tr('放不下：空位和可叠放的块都不够大'))
  const stackName = host.stacked ? host.key : `stk_${host.key}`
  const items = ws.items.map((it) => (it.instanceId === host.key && !host.stacked ? { ...it, stack: stackName, active: false } : host.stacked && it.stack === stackName ? { ...it, active: false } : it))
  const added: WorkspaceItem = { ...base, x: host.x, y: host.y, w: host.w, h: host.h, stack: stackName, active: true }
  return { ok: true, instanceId, ws: { ...ws, items: [...items, added] } }
}

/** 移除一个实例。钉住块不可移除（对 Agent；人要先取消钉住）。stack 里只剩一个时自动解散 stack。 */
export function removeInstance(ws: Workspace, instanceId: string, ctx: LayoutCtx): LayoutResult {
  const it = find(ws, instanceId)
  if (!it) return fail('NOT_FOUND', tr('找不到这个块'))
  if (it.pinned) return fail('PINNED', tr('钉住块不可移除'))
  let items = ws.items.filter((i) => i.instanceId !== instanceId)
  if (it.stack) items = normalizeStack(items, it.stack, it.active ? 'reassign' : 'keep')
  void ctx
  return { ok: true, ws: { ...ws, items } }
}

/** 整理一个 stack：成员 <2 解散；active 不是恰好一个时指定第一个。 */
function normalizeStack(items: WorkspaceItem[], stack: string, mode: 'reassign' | 'keep'): WorkspaceItem[] {
  const members = items.filter((i) => i.stack === stack)
  if (members.length === 0) return items
  if (members.length === 1) return items.map((i) => (i.stack === stack ? stripStack(i) : i))
  const actives = members.filter((m) => m.active)
  if (mode === 'keep' && actives.length === 1) return items
  const first = (actives[0] ?? members[0])!.instanceId
  return items.map((i) => (i.stack === stack ? { ...i, active: i.instanceId === first } : i))
}

function stripStack(i: WorkspaceItem): WorkspaceItem {
  const { stack: _s, active: _a, ...rest } = i
  return rest
}

/** 切换 stack 内的当前标签。 */
export function setActive(ws: Workspace, instanceId: string): LayoutResult {
  const it = find(ws, instanceId)
  if (!it) return fail('NOT_FOUND', tr('找不到这个块'))
  if (!it.stack) return { ok: true, ws }
  return { ok: true, ws: { ...ws, items: ws.items.map((i) => (i.stack === it.stack ? { ...i, active: i.instanceId === instanceId } : i)) } }
}

/** 把实例叠进目标瓦片当标签。钉住块既不能被叠也不能叠别人（必须始终可见）。 */
export function stackInto(ws: Workspace, instanceId: string, targetKey: string, ctx: LayoutCtx): LayoutResult {
  const it = find(ws, instanceId)
  const target = tileOf(ws, targetKey)
  if (!it || !target) return fail('NOT_FOUND', tr('找不到这个块'))
  if (it.pinned || target.pinned) return fail('PINNED', tr('钉住块必须独占瓦片'))
  if (it.stack === targetKey || instanceId === targetKey) return { ok: true, ws }
  const lim = limitsOf({ ...target, items: [...target.items, it] }, ctx)
  if (target.w < lim.minW || target.h < lim.minH) return fail('TOO_SMALL', tr('目标瓦片放不下这个块的最小尺寸'))
  const stackName = target.stacked ? target.key : `stk_${target.key}`
  const oldStack = it.stack
  let items = ws.items.map((i) => {
    if (i.instanceId === instanceId) return { ...i, x: target.x, y: target.y, w: target.w, h: target.h, stack: stackName, active: true }
    if (i.instanceId === target.key && !target.stacked) return { ...i, stack: stackName, active: false }
    if (target.stacked && i.stack === stackName) return { ...i, active: false }
    return i
  })
  if (oldStack && oldStack !== stackName) items = normalizeStack(items, oldStack, 'reassign')
  return { ok: true, ws: { ...ws, items } }
}

/** 从 stack 里拆出来，放到空位（找不到空位则失败）。 */
export function unstack(ws: Workspace, instanceId: string, ctx: LayoutCtx): LayoutResult {
  const it = find(ws, instanceId)
  if (!it) return fail('NOT_FOUND', tr('找不到这个块'))
  if (!it.stack) return { ok: true, ws }
  const lim = ctx.sizeOf?.(it.block)
  const tiles = tilesOf(ws)
  const spot = findFree(tiles, lim?.defaultW ?? it.w, lim?.defaultH ?? it.h, colsOf(ws, ctx), ctx.rows ?? rowsOf(ws)) ?? (lim ? findFree(tiles, lim.minW, lim.minH, colsOf(ws, ctx), ctx.rows ?? rowsOf(ws)) : null)
  if (!spot) return fail('NO_SPACE', tr('放不下：没有空位可拆出'))
  const stack = it.stack
  let items = ws.items.map((i) => (i.instanceId === instanceId ? { ...stripStack(i), ...spot } : i))
  items = normalizeStack(items, stack, 'reassign')
  return { ok: true, ws: { ...ws, items } }
}

/** 钉住 / 取消钉住——只有人能做（Agent 不能取消钉住，也不能自己钉）。钉住时必须不在 stack 里。 */
export function setPinned(ws: Workspace, instanceId: string, pinned: boolean, ctx: LayoutCtx): LayoutResult {
  if (ctx.actor !== 'user') return fail('PINNED', tr('只有人可以钉住或取消钉住'))
  const it = find(ws, instanceId)
  if (!it) return fail('NOT_FOUND', tr('找不到这个块'))
  if (pinned && it.stack) return fail('PINNED', tr('先把它从标签组里拆出来'))
  return { ok: true, ws: { ...ws, items: ws.items.map((i) => (i.instanceId === instanceId ? (pinned ? { ...i, pinned: true } : (({ pinned: _p, ...r }) => r)(i)) : i)) } }
}

export function setConfig(ws: Workspace, instanceId: string, patch: Record<string, unknown>): LayoutResult {
  if (!find(ws, instanceId)) return fail('NOT_FOUND', tr('找不到这个块'))
  return { ok: true, ws: { ...ws, items: ws.items.map((i) => (i.instanceId === instanceId ? { ...i, config: { ...(i.config ?? {}), ...patch } } : i)) } }
}

export function setChannel(ws: Workspace, instanceId: string, channel: string): LayoutResult {
  if (!find(ws, instanceId)) return fail('NOT_FOUND', tr('找不到这个块'))
  const channels = ws.channels[channel] ? ws.channels : { ...ws.channels, [channel]: {} }
  return { ok: true, ws: { ...ws, channels, items: ws.items.map((i) => (i.instanceId === instanceId ? { ...i, channel } : i)) } }
}

/**
 * 整体排布（`workspace.arrange {items}`）：新 items 必须通过校验；
 * 对 Agent 额外要求：原有钉住块都还在、仍钉住、独占瓦片、不小于最小尺寸（§4.5）。
 */
export function arrangeItems(ws: Workspace, items: WorkspaceItem[], ctx: LayoutCtx): LayoutResult {
  const next: Workspace = { ...ws, items }
  if (ctx.actor === 'agent') {
    for (const p of ws.items.filter((i) => i.pinned)) {
      const q = items.find((i) => i.instanceId === p.instanceId)
      if (!q || !q.pinned) return fail('PINNED', tr('钉住块必须保持在布局里'))
    }
  }
  const issues = validateWorkspace(next, ctx.sizeOf)
  if (issues.length) return fail('INVALID', issues[0]!.message)
  return { ok: true, ws: next }
}

/** 丢掉本机没装的块（sizeOf 查不到）；受影响的标签组重新整理（active 恰好一个，剩一个则解散）。 */
export function dropUninstalled(ws: Workspace, sizeOf: SizeLookup): Workspace {
  const gone = ws.items.filter((i) => !sizeOf(i.block))
  if (!gone.length) return ws
  let items = ws.items.filter((i) => sizeOf(i.block))
  for (const stack of new Set(gone.map((g) => g.stack).filter(Boolean) as string[])) items = normalizeStack(items, stack, 'reassign')
  return { ...ws, items }
}

/** 套用预设：保留当前联动通道的值（预设只管摆放），已有实例的 config 不保留（预设就是干净摆放）。 */
export function applyPreset(ws: Workspace, preset: Workspace): Workspace {
  const channels: Workspace['channels'] = { ...preset.channels }
  for (const [name, vals] of Object.entries(ws.channels)) channels[name] = { ...(channels[name] ?? {}), ...vals }
  return { ...preset, id: ws.id, name: ws.name, channels, ...(ws.savedBy ? { savedBy: ws.savedBy } : {}) }
}

/** 钉住块是否都在布局里且可见（给 Agent 改布局后的兜底校验）。 */
export function pinnedIntact(before: Workspace, after: Workspace, sizeOf?: SizeLookup): boolean {
  for (const p of before.items.filter((i) => i.pinned)) {
    const q = after.items.find((i) => i.instanceId === p.instanceId)
    if (!q || !q.pinned || q.stack) return false
    const l = sizeOf?.(q.block)
    if (l && (q.w < l.minW || q.h < l.minH)) return false
  }
  return true
}
