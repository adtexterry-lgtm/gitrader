// SPDX-License-Identifier: CPAL-1.0
// 插件页的视图模型：把内核 plugin.list 的回包规整成分组行。纯函数，无 DOM。
// K-r5-0：回包里的本机绝对路径 dir 在这里第一步剥掉——视图模型、缓存、夹具都不得含它。
// 缺字段（K-r5-3：source / audit / health；清单里的 net.hosts / secrets / files 现在不在 plugin.list 里）一律标「未接通」+ 字段名，不猜、不补。

import { t as tr } from '@gitrader/workbench/i18n'
export type PluginGroupId = 'trading' | 'data' | 'engine' | 'notify' | 'block' | 'tool'
export const GROUP_ORDER: readonly PluginGroupId[] = ['trading', 'data', 'engine', 'notify', 'block', 'tool']
export const GROUP_LABEL: Record<PluginGroupId, string> = {
  trading: tr('交易连接器'), data: tr('行情数据源'), engine: tr('策略引擎'), notify: tr('通知通道'), block: tr('工作台块'), tool: tr('工具'),
}

export const PERMISSION_LABEL: Record<string, string> = {
  'market.read': tr('读行情'), 'account.read': tr('读账户'), 'ledger.read': tr('读账本'), 'ledger.append': tr('写账本'),
  'trade.paper': tr('纸面交易'), 'trade.propose': tr('提交提案'), 'trade.live': tr('实盘交易'), 'takeover.trigger': tr('触发接管'),
  'venue.credentials': tr('场所凭据'), 'net.fetch': tr('网络访问'), 'fs.read.user': tr('读用户文件'), 'workspace.control': tr('控制工作区'),
  'ui.block': tr('界面块'), 'notify.user': tr('通知用户'),
}

/** 字段缺失 = 未接通：field 是缺的字段名（界面照写）。 */
export type Cell<T> = { wired: true; value: T } | { wired: false; field: string }
const val = <T>(value: T): Cell<T> => ({ wired: true, value })
const off = (field: string): { wired: false; field: string } => ({ wired: false, field })

export type HealthTone = 'ok' | 'warn' | 'down' | 'idle'
export type Level = 'ok' | 'warn' | 'fail'
export interface AuditGroup { label: string; level: Level }
export interface Compliance { level: Level; count: number; groups: AuditGroup[]; notes: { id: string; detail: string; level: Level }[] }

export interface PluginRow {
  id: string
  name: string
  version: string
  /** 清单 license.spdx；没有 / 空串 = 未声明。 */
  license: string
  group: PluginGroupId
  /** 连接器的场所（图标用）；没有就 null。 */
  venue: string | null
  unverified: boolean
  source: Cell<string>
  hosts: Cell<string[]>
  files: Cell<string[]>
  secrets: Cell<string[]>
  health: { label: string; tone: HealthTone; detail: Cell<string> }
  /** 内核校验没过（ok:false）= 失败；有 audit 回包时按 audit；否则未接通。 */
  compliance: Cell<Compliance>
  capabilities: string[]
  /** 清单声明的全部权限 / 尚未授予的权限（授权 = 把声明的全部交给内核）。 */
  declared: string[]
  pending: string[]
  enabled: boolean
  /** 内核的生命周期状态（ready / degraded / stopped …）。 */
  state: string
  ok: boolean
  /** 内核校验没过的原文（不改写）。 */
  issues: string[]
  signed: boolean
  trusted: boolean
}

export interface PluginGroup { id: PluginGroupId; label: string; rows: PluginRow[] }
export interface PluginsView { rows: PluginRow[]; groups: PluginGroup[]; count: number }

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const LICENSE_MISSING = tr('未声明')
/** 清单 license 是 {spdx, …}；兼容内核直接给字符串。缺失 / 空串 = 未声明。 */
function licenseOf(v: unknown): string {
  if (typeof v === 'string') return v.trim() || LICENSE_MISSING
  if (isRec(v)) return str(v.spdx).trim() || str(v.name).trim() || LICENSE_MISSING
  return LICENSE_MISSING
}

/** 清单 id 形如 `<kind>.<vendor>.<name>`（decision-model 的前缀是 decision）。回包没带 kind（校验没过的包）时用前缀。 */
const KIND_OF_PREFIX: Record<string, string> = { decision: 'decision-model' }
function kindOf(r: Record<string, unknown>): string {
  if (typeof r.kind === 'string' && r.kind) return r.kind
  const p = str(r.id).split('.')[0] ?? ''
  return KIND_OF_PREFIX[p] ?? p
}

/** 六类映射：连接器里 id 名称段以 notify 开头（或带 notify_send 工具）= 通知通道，以 -data 结尾 = 行情数据源，其余 = 交易连接器。 */
export function groupOf(r: Record<string, unknown>): PluginGroupId {
  const kind = kindOf(r)
  const name = str(r.id).split('.').slice(2).join('.')
  if (kind === 'connector') {
    const tools = Array.isArray(r.tools) ? r.tools : []
    if (name.startsWith('notify') || tools.some((t) => isRec(t) && t.name === 'notify_send')) return 'notify'
    return name.endsWith('-data') ? 'data' : 'trading'
  }
  if (kind === 'datasource') return 'data'
  if (kind === 'engine' || kind === 'strategy' || kind === 'decision-model' || kind === 'executor') return 'engine'
  if (kind === 'block' || kind === 'layout-preset') return 'block'
  return 'tool'
}

const HEALTH: Record<string, { label: string; tone: HealthTone }> = {
  ready: { label: tr('正常'), tone: 'ok' }, degraded: { label: tr('降级'), tone: 'warn' }, failed: { label: tr('失败'), tone: 'down' },
  starting: { label: tr('启动中'), tone: 'idle' }, stopping: { label: tr('停止中'), tone: 'idle' }, stopped: { label: tr('未运行'), tone: 'idle' }, installed: { label: tr('未运行'), tone: 'idle' },
}

const AUDIT_GROUPS: [RegExp, string][] = [
  [/^manifest|^pkg-/, tr('清单')], [/^permissions/, tr('权限')], [/^secrets/, tr('密钥')], [/^tools/, tr('工具名')],
  [/^spdx|^license/, tr('许可证')], [/^readme/, 'README'], [/^tests/, tr('测试')], [/^notify/, tr('通知契约')],
]
const worse = (a: Level, b: Level): Level => (a === 'fail' || b === 'fail' ? 'fail' : a === 'warn' || b === 'warn' ? 'warn' : 'ok')

/** audit.findings = plugin-audit.mjs 的 checks（{id, ok, severity: 'fail'|'warn', detail}），通过的也在里面。 */
function auditOf(a: unknown): Cell<Compliance> {
  if (!isRec(a) || !Array.isArray(a.findings)) return off('audit')
  const by = new Map<string, Level>()
  const notes: Compliance['notes'] = []
  for (const f of a.findings) {
    if (!isRec(f)) continue
    const id = str(f.id)
    const level: Level = f.ok === true ? 'ok' : f.severity === 'warn' ? 'warn' : 'fail'
    const label = AUDIT_GROUPS.find(([re]) => re.test(id))?.[1] ?? id
    by.set(label, worse(by.get(label) ?? 'ok', level))
    if (level !== 'ok') notes.push({ id, detail: str(f.detail), level })
  }
  const level = [...by.values()].reduce<Level>(worse, 'ok')
  return val({ level, count: notes.length, groups: [...by].map(([label, l]) => ({ label, level: l })), notes })
}

function row(r: Record<string, unknown>, unverified: ReadonlySet<string>): PluginRow {
  const id = str(r.id)
  const group = groupOf(r)
  const declared = strs(r.permissions)
  const issues = strs(r.issues)
  const ok = r.ok !== false
  const state = HEALTH[str(r.state)] ?? { label: str(r.state) || tr('未运行'), tone: 'idle' as const }
  const h = isRec(r.health) ? r.health : null
  // health 回包在（哪怕是空对象）= 接通，没有可说的就没有详情；整个字段缺 = 未接通
  const detail = !h ? null : typeof h.detail === 'string' ? h.detail : typeof h.latencyMs === 'number' ? `${h.latencyMs} ms` : ''
  const net = isRec(r.net) ? strs(r.net.hosts) : null
  const files = Array.isArray(r.files) ? strs(r.files) : null
  const tail = id.split('.').slice(2).join('.')
  // 场所图标只给「连接器」类插件（数据源插件没有场所，按名字显示）
  const venue = kindOf(r) === 'connector' && (group === 'trading' || group === 'data') ? (str(isRec(r.provides) ? r.provides.venue : '') || tail.replace(/-(trade|data)$/, '')) || null : null
  const compliance: Cell<Compliance> = !ok
    ? val({ level: 'fail', count: Math.max(1, issues.length), groups: [], notes: issues.map((detail) => ({ id: 'validation', detail, level: 'fail' as const })) })
    : auditOf(r.audit)
  return {
    id, name: str(r.name) || tail || id, version: str(r.version),
    license: licenseOf(r.license ?? (isRec(r.manifest) ? r.manifest.license : undefined)), group, venue,
    unverified: venue !== null && unverified.has(venue),
    source: typeof r.source === 'string' && r.source ? val(r.source) : off('source'),
    hosts: net ? val(net) : declared.includes('net.fetch') ? off('net.hosts') : val([]),
    files: files ? val(files) : declared.includes('fs.read.user') ? off('files') : val([]),
    secrets: Array.isArray(r.secrets) ? val(strs(r.secrets)) : off('secrets'),
    health: { label: state.label, tone: state.tone, detail: detail !== null ? val(detail) : off('health') },
    compliance,
    capabilities: declared.map((p) => PERMISSION_LABEL[p] ?? p),
    declared,
    pending: strs(r.pending),
    enabled: r.enabled === true,
    state: str(r.state) || 'installed',
    ok, issues,
    signed: r.signed === true,
    trusted: r.trusted === true,
  }
}

/**
 * plugin.list 回包 → 视图。只复制白名单里的字段（`dir` 本机路径从不进入输出）；回包不是数组 = 抛错，由调用方按「读取失败」显示。
 * unverified：venue.status 里标了「未验证」的场所集合。
 */
export function normalizePlugins(raw: unknown, unverified: ReadonlySet<string> = new Set()): PluginsView {
  if (!Array.isArray(raw)) throw new Error(tr('plugin.list 回包不是数组'))
  const rows = raw.filter(isRec).map((r) => row(r, unverified))
  const groups = GROUP_ORDER.map((id) => ({ id, label: GROUP_LABEL[id], rows: rows.filter((x) => x.group === id) })).filter((g) => g.rows.length > 0)
  return { rows, groups, count: rows.length }
}

/** venue.status 回包 → 标了未验证的场所 id 集合；形状不对就当空集合。 */
export function unverifiedVenues(raw: unknown): Set<string> {
  const out = new Set<string>()
  if (Array.isArray(raw)) for (const v of raw) if (isRec(v) && v.unverified === true && typeof v.venue === 'string') out.add(v.venue)
  return out
}

/**
 * 启用计划：有尚未授予的权限 = 放宽，先走就地确认；授权把清单声明的全部权限交给内核（已授予的内核会合并）。
 * 没有待授予权限时只启用（内核 grant 的 permissions: [] 语义），不重复交一遍已授予的权限。
 */
export function enablePlan(r: PluginRow): { widen: boolean; added: string[]; params: { id: string; permissions: string[] } } {
  const widen = r.pending.length > 0
  return { widen, added: r.pending.map((p) => PERMISSION_LABEL[p] ?? p), params: { id: r.id, permissions: widen ? r.declared : [] } }
}

/**
 * 是否走 PIN：待授予权限 = 新增或放宽，界面把命令交给现有 PIN 层（内核回 ATTESTATION_REQUIRED 时壳弹 PIN）。
 * 没有待授予权限 = 只启用，会话即可，不弹 PIN。
 */
export function enableAsksPin(r: PluginRow): boolean {
  return r.pending.length > 0
}

/** 进程在跑（或正在起）的状态。 */
export const RUNNING: ReadonlySet<string> = new Set(['ready', 'degraded', 'starting'])

export interface ToggleStep { action: 'plugin.grant' | 'plugin.start' | 'plugin.stop'; params: Record<string, unknown>; ok: string }

/**
 * 「启用」开关 = 是否在运行（GQ-55）。内核没有停用命令（授权不可撤销，只有卸载），所以开关只用 grant / start / stop：
 * 未授权 → 授权再启动（放宽权限走就地确认 + PIN）；已授权 → 在跑就停、没跑就起。
 * 工作台块与版面预设（group 'block'）没有进程：开关只反映是否已授权，授权后没有可做的。
 */
export function togglePlan(r: PluginRow): { checked: boolean; needsPin: boolean; steps: ToggleStep[] } {
  const runs = r.group !== 'block'
  const checked = runs ? r.enabled && RUNNING.has(r.state) : r.enabled
  const start: ToggleStep = { action: 'plugin.start', params: { id: r.id }, ok: tr('已启动 {0}', r.name) }
  if (!r.enabled) return { checked: false, needsPin: enableAsksPin(r), steps: [{ action: 'plugin.grant', params: enablePlan(r).params, ok: tr('已启用 {0}', r.name) }, ...(runs ? [start] : [])] }
  if (!runs) return { checked, needsPin: false, steps: [] }
  return { checked, needsPin: false, steps: [checked ? { action: 'plugin.stop', params: { id: r.id }, ok: tr('已停止 {0}', r.name) } : start] }
}
