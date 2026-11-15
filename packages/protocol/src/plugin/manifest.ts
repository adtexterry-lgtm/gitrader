// SPDX-License-Identifier: Apache-2.0
// 契约 §3 插件清单 gitrader-plugin/1：字段、kind 枚举、权限枚举（默认拒绝）、签名与钉版本、GSP 签名请求。
import type { Decimal, Ms } from '../model/decimal'
import { isValidRange, satisfiesRange } from './semver'
import { MAX_TOOL_SCHEMA_BYTES, findUnsafePatterns } from './safe-pattern'
import { findSecretSolicitation } from './secret-solicit'
import type { Sha256Digest } from '../model/ids'
import type { VenueCapabilities } from '../model/instrument'
import type { EngineLaunch } from '../gep/launch'
import { PROTECTOR_KINDS, type ProtectorSpec } from '../model/risk'

export const PLUGIN_SCHEMA = 'gitrader-plugin/1'

export const PLUGIN_KINDS = [
  'connector', 'datasource', 'factor', 'decision-model', 'executor', 'protector', 'strategy', 'workflow-template', 'engine',
  'block', 'skill', 'layout-preset',
] as const
export type PluginKind = (typeof PLUGIN_KINDS)[number]

export const PLUGIN_PACKAGES = ['skill', 'block'] as const
export type PluginPackage = (typeof PLUGIN_PACKAGES)[number]

/** §3.3 可申请的权限；清单里没有声明的权限一律拒绝（默认拒绝）。 */
export const PLUGIN_PERMISSIONS = [
  'market.read', 'account.read', 'ledger.read', 'ledger.append', 'trade.paper', 'trade.propose', 'trade.live',
  'takeover.trigger', 'venue.credentials', 'net.fetch', 'fs.read.user', 'workspace.control', 'ui.block', 'notify.user',
] as const
export type PluginPermission = (typeof PLUGIN_PERMISSIONS)[number]

/** 永远不可授予：清单里出现即拒装。 */
export const NEVER_GRANTABLE_PERMISSIONS = [
  'withdraw', 'transfer', 'approval.decide', 'risk.relax', 'policy.write', 'mandate.issue', 'mandate.promote',
  'credential.read', 'plugin.install', 'risk.temporaryRelax',
] as const

const ALL_KINDS = PLUGIN_KINDS
/** 每个权限可由哪些 kind 申请（§3.3 表）。 */
export const PERMISSION_ALLOWED_KINDS: Record<PluginPermission, readonly PluginKind[]> = {
  'market.read': ALL_KINDS,
  'account.read': ALL_KINDS,
  'ledger.read': ALL_KINDS,
  'ledger.append': ALL_KINDS,
  'trade.paper': ['strategy', 'executor', 'engine'],
  'trade.propose': ['strategy', 'executor', 'engine'],
  'trade.live': ['executor', 'engine'],
  'takeover.trigger': ['protector', 'executor', 'engine', 'block'],
  'venue.credentials': ['connector'],
  'net.fetch': ['datasource', 'decision-model', 'connector', 'engine'],
  'fs.read.user': ['engine', 'factor', 'datasource'],
  'workspace.control': ['block', 'skill'],
  'ui.block': ['block'],
  'notify.user': ['protector', 'engine', 'block'],
}

/** 未签名插件（开发者模式）不得申请的权限。 */
export const UNSIGNED_FORBIDDEN_PERMISSIONS = ['trade.live', 'venue.credentials'] as const

/** `sidecar` = 任意语言的子进程（v0.1.2）；`python-sidecar` 是它的 Python 特例，保留以兼容。 */
export const PLUGIN_RUNTIME_TYPES = ['builtin', 'node', 'sidecar', 'python-sidecar', 'browser', 'stdio-mcp', 'remote-mcp', 'rest'] as const
export type PluginRuntimeType = (typeof PLUGIN_RUNTIME_TYPES)[number]

export const PLUGIN_REDISTRIBUTE = ['bundle', 'implement', 'user-install', 'reference-only'] as const
export type PluginRedistribute = (typeof PLUGIN_REDISTRIBUTE)[number]

export const PLUGIN_INSTALL_BY = ['bundle', 'user-consent', 'user-install', 'remote'] as const
export type PluginInstallBy = (typeof PLUGIN_INSTALL_BY)[number]

export const VENDOR_KINDS = ['builtin', 'partner', 'community', 'self'] as const
export type VendorKind = (typeof VENDOR_KINDS)[number]

export interface PluginVendor { id: string; name: string; kind: VendorKind; verified: boolean; url?: string | null }

export interface PluginLicense {
  spdx: string
  redistribute: PluginRedistribute
  notice: string
  commercialUse: boolean
  attribution?: string
  weightsLicense?: string
  /** LGPL / GPL 依赖逐个列出。 */
  dependencies?: { name: string; spdx: string; redistribute: PluginRedistribute }[]
}

export interface PluginDownload { name: string; source: string; sizeMB: number; sha256: Sha256Digest; consent: 'required' }

export interface PluginRuntime {
  type: PluginRuntimeType
  node?: string
  /** 仅 Python 旁车的可选便利：精确次版本，如 "3.12"（uv 托管）。其他语言不需要。 */
  python?: string
  native: boolean
  diskMB: number
  download?: PluginDownload[]
}

export interface PluginEntry {
  /** node / browser */
  module?: string
  export?: string
  element?: string
  /** python-sidecar */
  command?: string[]
  transport?: 'stdio' | 'ws' | 'wss'
  /** remote */
  url?: string
}

export interface PluginInstall {
  by: PluginInstallBy
  detect?: string
  lockfile?: string
  /** 必须为 true。 */
  requireHashes: true
}

export interface PluginMcp {
  transport: 'stdio' | 'http' | 'sse' | string
  url?: string
  command?: string[]
  tools: { allow: string[]; deny: string[] }
}

export interface PluginPin { kind: 'plugin' | 'pypi' | 'npm' | 'binary'; name: string; version: string; sha256: Sha256Digest }

export interface PluginSignature { alg: 'ed25519'; keyId: string; digest: Sha256Digest; sig: string }

// ---- r2：工具声明与证据（v0.1.9，见 docs/plugin-protocol.md §3.9 / §3.10）-------------------------

/** 暴露给 Agent 的一个工具。没写进 `tools[]` 的工具内核不转发。 */
export interface PluginTool {
  name: string
  desc: string
  tags: string[]
  /** JSON Schema（2020-12），`type` 必须是 `object`。 */
  input: Record<string, unknown>
  /** 声明了就校验返回值。 */
  output?: Record<string, unknown>
  /** 必须是 `manifest.permissions` 的子集；调用时逐项要已授予。 */
  permissions?: PluginPermission[]
}

/** 推荐语义标签（词表开放，自定义标签放行）。 */
export const PLUGIN_TOOL_TAGS = ['market', 'account', 'ledger', 'risk', 'backtest', 'signal', 'factor', 'data', 'utility', 'ui'] as const
export const PLUGIN_TOOL_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/

export const EVIDENCE_BASES = ['backtest', 'paper', 'live'] as const
export type EvidenceBasis = (typeof EVIDENCE_BASES)[number]

export interface EvidenceClaim {
  metric: string
  value: Decimal
  basis: EvidenceBasis
  window: { from: Ms; to: Ms }
  /** paper / live 必填：可核引用。 */
  ref?: string
  /** backtest 必填且非空：成本、滑点、数据来源与区间等。 */
  assumptions?: string[]
}

/** `claims` 必填但可为空数组——"没有数字"是诚实答案。 */
export interface PluginEvidence { claims: EvidenceClaim[]; notes?: string }

/** `id` 第一段必须等于它：全部等于 kind，唯一例外 `decision-model` → `decision`。 */
export const ID_PREFIX_OF_KIND: Record<PluginKind, string> = {
  connector: 'connector', datasource: 'datasource', factor: 'factor', 'decision-model': 'decision', executor: 'executor', protector: 'protector',
  strategy: 'strategy', 'workflow-template': 'workflow-template', engine: 'engine', block: 'block', skill: 'skill', 'layout-preset': 'layout-preset',
}

export interface PluginManifest {
  schema: typeof PLUGIN_SCHEMA
  /** `<kind>.<vendor>.<name>`，字符集 [a-z0-9.-]。 */
  id: string
  package: PluginPackage
  kind: PluginKind
  name: string
  desc: string
  tags: string[]
  /** 精确语义化版本。 */
  version: string
  vendor: PluginVendor
  source: { repo: string; commit: string; sha256: Sha256Digest; fetchedAt: Ms; inspiredBy?: string }
  license: PluginLicense
  runtime: PluginRuntime
  entry?: PluginEntry
  install: PluginInstall
  /** 缺省 = 全部拒绝。 */
  permissions: PluginPermission[]
  /** 声明 net.fetch 时必填。 */
  net?: { hosts: string[] }
  secrets?: string[]
  config?: Record<string, unknown>
  privacy: { hosted: boolean; sends: ('watchlist' | 'positions' | 'addresses' | 'orders')[] }
  tos?: { commercial: boolean; redistribute: boolean; attribution: string }
  mcp?: PluginMcp
  /** 按 kind；connector 为 {venue, capabilities}。 */
  provides: Record<string, unknown> & { venue?: string; capabilities?: VenueCapabilities }
  /** r2 新增：暴露给 Agent 的工具清单（§3.9）。 */
  tools?: PluginTool[]
  instances?: { multiple: boolean; ordered: boolean; max?: number }
  ui?: { blocks: (Record<string, unknown> | string)[] }
  /** kind = engine 必填。 */
  engine?: { gep: { versions: string[]; transports: ('stdio' | 'ws' | 'wss')[]; modes: ('A' | 'B')[] }; /** 语言无关的启动配置（v0.1.2）。 */ launch?: EngineLaunch }
  /** r2：定型为 `{claims, notes?}`（原 `Record<string, unknown>`）。 */
  evidence?: PluginEvidence
  protector?: { rules?: ProtectorSpec[]; pre?: boolean; budgetMs?: number }
  fixtures: { offline: string[]; smoke: string[] }
  risk?: { disclosure: string; worstCase: string; builderAttribution: 'off' }
  requires?: PluginPin[]
  compat: { gitrader: string; gep?: string; pluginSchema: string }
  /** 发布必填；未签名只能在开发者模式安装。 */
  signature?: PluginSignature
}

/** 实例绑定（内核对象，不在清单里）：同 kind 的实例按 order 依次生效（保护器全部叠加，任一拒绝即拒绝）。 */
export interface PluginInstanceBinding {
  instanceId: string
  pluginId: string
  version: string
  sha256: Sha256Digest
  scope: { accountIds?: string[]; groupId?: string }
  order: number
  config: Record<string, unknown>
  enabled: boolean
}

// ---- 结构化清单问题（r2）---------------------------------------------------------------------

/** 清单问题码（字符串）。只追加，不复用。运行阶段数字码见 `PROBLEM_CODES`。 */
export const PLUGIN_ISSUE_CODES = [
  'MANIFEST_UNREADABLE', 'SCHEMA', 'ID_PREFIX_MISMATCH', 'VENDOR_ID_MISMATCH', 'DUPLICATE_ID', 'PACKAGE_KIND_MISMATCH',
  'PERMISSION_NEVER_GRANTABLE', 'PERMISSION_UNKNOWN', 'PERMISSION_KIND_MISMATCH', 'NET_HOSTS_EMPTY', 'FACTOR_HAS_NET', 'UNSIGNED_FORBIDDEN_PERMISSION',
  'KIND_REQUIRES_FIELD', 'TOOL_NAME_DUPLICATE', 'TOOL_SCHEMA_INVALID', 'TOOL_PERMISSION_UNDECLARED', 'TOOLS_NOT_CALLABLE',
  'EVIDENCE_BACKTEST_NEEDS_ASSUMPTIONS', 'EVIDENCE_FORWARD_NEEDS_REF', 'EVIDENCE_WINDOW_INVALID', 'PRIVACY_SENDS_WITHOUT_NET', 'PRIVACY_HOSTED_WITHOUT_NET',
  'PROMISE_LANGUAGE', 'REQUIRES_VERSION_INEXACT', 'HASH_MISMATCH', 'UNSIGNED_NOT_ALLOWED', 'SIGNATURE_KEY_UNTRUSTED', 'SIGNATURE_DIGEST_MISMATCH', 'SIGNATURE_INVALID',
  'ENTRY_MISSING', 'ENTRY_NOT_FOUND', 'ENTRY_ESCAPES', 'COMPAT_SCHEMA_UNSUPPORTED', 'COMPAT_RANGE_INVALID', 'COMPAT_GITRADER_UNSATISFIED', 'TOOL_SOLICITS_SECRET',
  'PROTECTOR_RULES_INVALID',
] as const
export type PluginIssueCode = (typeof PLUGIN_ISSUE_CODES)[number]

/** `path` 是指向清单字段的 JSON Pointer（如 `/permissions/1`）；`message` 的英文文本稳定，测试可断言。 */
export interface PluginIssue { code: PluginIssueCode; path: string; message: string; hint?: string }

/** 承诺类用语。中文词按字符拼接 / \u 转义书写，避免文案扫描把词表本身当成违规文案。 */
export const PLUGIN_PROMISE_PATTERNS: readonly RegExp[] = [
  /保证收益|保本|必胜|躺赚|零风险|无风险/,
  new RegExp('稳' + '赚'),
  new RegExp('跑' + '赢'),
  /guaranteed\s+(?:profit|return)s?/i,
  /risk\s*-?\s*free/i,
  /can['’]?t\s*lose/i,
  /can\s*not\s*lose/i,
  /never\s*lose/i,
  /\bsure\s*win\b/i,
]

// ---- 匹配前归一化（防全角 / 字间空格 / 零宽字符 / 繁体 / 连字符变体绕过）-------------------------
const ZERO_WIDTH = /[​-‍﻿­]/
const HYPHEN_VARIANTS = /[‐-―−﹣－]/
const CJK = /[㐀-鿿]/
/** 只覆盖词表用到的繁体字。 */
const TRAD_TO_SIMP: Record<string, string> = {
  無: '无', 風: '风', 險: '险', 證: '证', 賺: '赚', 勝: '胜', 錢: '钱', 穩: '稳', 贏: '赢', 歸: '归', 並: '并', 沒: '没',
  鑰: '钥', 記: '记', 詞: '词', 碼: '码', 憑: '凭', 種: '种', 語: '语',
}

/** 归一化文本，并记下每个归一化字符对应原文的起点（UTF-16 下标），便于把命中映射回原文片段。 */
export function normalizeForScan(text: string): { s: string; at: number[] } {
  const chars: string[] = []
  const origin: number[] = []
  let pos = 0
  for (const cp of text) {
    for (let c of cp.normalize('NFKC')) {
      if (ZERO_WIDTH.test(c)) continue
      c = /\s/.test(c) ? ' ' : HYPHEN_VARIANTS.test(c) ? '-' : c.toLowerCase()
      c = TRAD_TO_SIMP[c] ?? c
      if (c === ' ' && chars[chars.length - 1] === ' ') continue // 连续空白折成一个
      for (const unit of c) { chars.push(unit); origin.push(pos) }
    }
    pos += cp.length
  }
  // 中日韩字符两侧的空格去掉（"保 证 收 益"）；拉丁词之间保留一个空格，否定词判断和 "ensure winners" 之类不被误伤
  let s = ''
  const at: number[] = []
  chars.forEach((c, k) => {
    if (c === ' ' && (CJK.test(s[s.length - 1] ?? '') || CJK.test(chars[k + 1] ?? ''))) return
    s += c
    at.push(origin[k]!)
  })
  return { s, at }
}

/** 否定词（紧邻命中片段之前）：诚实的风险披露如"不保证收益""not risk-free"不算承诺。 */
const NEGATED_BEFORE_ZH = /(?:不|非|没|无法|并非|不是)$/
const NEGATION_WORDS_EN = new Set(['not', 'no', 'never', 'cannot', "can't", "isn't", "aren't", "doesn't", "don't", "won't", 'without'])
function isNegatedBefore(text: string, start: number): boolean {
  if (NEGATED_BEFORE_ZH.test(text.slice(Math.max(0, start - 2), start))) return true
  const word = /([A-Za-z']+)[\s-]*$/.exec(text.slice(0, start).replace(/’/g, "'"))
  return word !== null && NEGATION_WORDS_EN.has(word[1]!.toLowerCase())
}

/**
 * 命中承诺类用语返回命中的原文片段，否则 null。匹配前先归一化（NFKC、去零宽与 CJK 字间空白、连字符变体统一、小写、少量繁转简）。
 * 命中片段紧邻否定词（不 / 非 / 没 / 无法 / 并非 / 不是；not / no / never / cannot / can't / without 等）时放行。
 */
export function findPromiseLanguage(text: string): string | null {
  const { s, at } = normalizeForScan(text)
  for (const re of PLUGIN_PROMISE_PATTERNS) {
    for (const hit of s.matchAll(new RegExp(re.source, `${re.flags}g`))) {
      if (isNegatedBefore(s, hit.index)) continue
      const last = hit.index + hit[0].length - 1
      let end = at[last + 1] ?? text.length
      if (end <= at[last]!) end = at[last]! + 1
      return text.slice(at[hit.index], end)
    }
  }
  return null
}

/**
 * 工具 schema 编译器。由 validate.ts 在加载时注册（manifest.ts 自己不引 ajv，保证 `./constants` 子路径可进浏览器）。
 * 只走 `./constants` 子路径时跳过"工具 schema 可编译"检查；内核加载 validate.ts（根入口）后自动注册。
 */
let schemaCompiler: ((schema: Record<string, unknown>) => unknown) | null = null
export function registerSchemaCompiler(fn: (schema: Record<string, unknown>) => unknown): void {
  schemaCompiler = fn
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * 清单的纯语义检查（JSON Schema 管不到的跨字段规则；不碰文件系统，也不管 compat）。返回问题列表，空 = 通过。
 * 兼容检查见 `checkPluginCompat`；哈希 / 签名 / 入口 / 重复 id 由内核扫描时判。
 */
export function checkPluginManifestIssues(m: PluginManifest): PluginIssue[] {
  const out: PluginIssue[] = []
  const add = (code: PluginIssueCode, path: string, message: string, hint?: string): void => {
    out.push(hint === undefined ? { code, path, message } : { code, path, message, hint })
  }
  const perms = new Set<string>(m.permissions)
  const permList = m.permissions as readonly string[]

  if (m.kind !== 'protector' && Object.prototype.hasOwnProperty.call(m, 'protector')) {
    add('PROTECTOR_RULES_INVALID', '/protector', 'only protector plugins may declare protector rules')
  }
  if (m.protector && Array.isArray(m.protector.rules)) {
    m.protector.rules.forEach((rule, i) => {
      if (rule && typeof rule === 'object' && Object.prototype.hasOwnProperty.call(rule, 'source')) {
        add('PROTECTOR_RULES_INVALID', `/protector/rules/${i}/source`, 'protector rules must not declare source; the kernel assigns it when merging')
      }
      const kind = rule && typeof rule === 'object' ? rule.kind : undefined
      if (typeof kind !== 'string' || kind === 'plugin' || !(PROTECTOR_KINDS as readonly string[]).includes(kind)) {
        add('PROTECTOR_RULES_INVALID', `/protector/rules/${i}/kind`, `protector rule kind "${String(kind)}" is not a built-in protector kind`)
      }
    })
  }

  // 身份
  const segs = typeof m.id === 'string' ? m.id.split('.') : []
  const prefix = ID_PREFIX_OF_KIND[m.kind]
  if (prefix !== undefined && segs[0] !== prefix) add('ID_PREFIX_MISMATCH', '/id', `id prefix "${segs[0] ?? ''}" must be "${prefix}" for kind ${m.kind}`, `rename the id to ${prefix}.<vendor>.<name>`)
  if (m.vendor && segs[1] !== m.vendor.id) add('VENDOR_ID_MISMATCH', '/id', `id vendor segment "${segs[1] ?? ''}" must equal vendor.id "${m.vendor.id}"`)
  if (m.package === 'skill' && m.kind !== 'skill') add('PACKAGE_KIND_MISMATCH', '/package', 'package skill requires kind skill')

  // 权限
  permList.forEach((perm, i) => {
    const path = `/permissions/${i}`
    if ((NEVER_GRANTABLE_PERMISSIONS as readonly string[]).includes(perm)) add('PERMISSION_NEVER_GRANTABLE', path, `permission ${perm} can never be granted`)
    else if (!(PLUGIN_PERMISSIONS as readonly string[]).includes(perm)) add('PERMISSION_UNKNOWN', path, `unknown permission ${perm}`)
    else if (!PERMISSION_ALLOWED_KINDS[perm as PluginPermission].includes(m.kind)) add('PERMISSION_KIND_MISMATCH', path, `kind ${m.kind} cannot request ${perm}`)
  })
  if (perms.has('net.fetch') && !(m.net && m.net.hosts.length > 0)) add('NET_HOSTS_EMPTY', '/net/hosts', 'net.fetch declared but net.hosts is empty')

  // kind 必填项
  if (m.kind === 'engine' && !m.engine) add('KIND_REQUIRES_FIELD', '/engine', 'kind engine requires engine.gep')
  if (m.kind === 'datasource' && !m.tos) add('KIND_REQUIRES_FIELD', '/tos', 'kind datasource requires tos')
  if ((m.runtime.type === 'stdio-mcp' || m.runtime.type === 'remote-mcp') && !m.mcp) add('KIND_REQUIRES_FIELD', '/mcp', 'MCP runtime requires mcp')
  if ((m.kind === 'strategy' || m.kind === 'factor' || m.kind === 'decision-model') && !m.evidence) add('KIND_REQUIRES_FIELD', '/evidence', `kind ${m.kind} requires evidence`)
  if ((m.kind === 'strategy' || m.kind === 'executor') && !m.risk) add('KIND_REQUIRES_FIELD', '/risk', `kind ${m.kind} requires risk`)
  if (m.kind === 'block' && !Array.isArray(m.ui?.blocks)) add('KIND_REQUIRES_FIELD', '/ui', 'kind block requires ui.blocks')
  if (m.kind === 'factor' && m.net) add('FACTOR_HAS_NET', '/net', 'factor must not configure remote endpoints (net)')
  if (!m.signature) {
    for (const f of UNSIGNED_FORBIDDEN_PERMISSIONS) {
      if (perms.has(f)) add('UNSIGNED_FORBIDDEN_PERMISSION', `/permissions/${permList.indexOf(f)}`, `unsigned plugin must not request ${f}`)
    }
  }
  ;(m.requires ?? []).forEach((r, i) => {
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(r.version)) add('REQUIRES_VERSION_INEXACT', `/requires/${i}/version`, `requires ${r.name}: version must be exact, got ${r.version}`)
  })

  // 工具
  const tools = Array.isArray(m.tools) ? m.tools : []
  if (m.runtime.type === 'browser' && tools.length > 0) add('TOOLS_NOT_CALLABLE', '/tools', 'browser plugins cannot declare tools (blocks work through the block bridge, not tool.call)')
  const seen = new Set<string>()
  tools.forEach((t, i) => {
    const base = `/tools/${i}`
    if (!PLUGIN_TOOL_NAME_RE.test(t.name)) add('TOOL_SCHEMA_INVALID', `${base}/name`, `tool name "${t.name}" must match ${PLUGIN_TOOL_NAME_RE.source}`)
    if (seen.has(t.name)) add('TOOL_NAME_DUPLICATE', `${base}/name`, `duplicate tool name ${t.name}`)
    seen.add(t.name)
    if (!isPlainObject(t.input) || t.input['type'] !== 'object') add('TOOL_SCHEMA_INVALID', `${base}/input`, `tool ${t.name}: input must be a JSON Schema object with type "object"`)
    for (const key of ['input', 'output'] as const) {
      const schema = t[key]
      if (schema === undefined || !isPlainObject(schema) || (key === 'input' && schema['type'] !== 'object')) continue
      const bad = (msg: string): void => add('TOOL_SCHEMA_INVALID', `${base}/${key}`, `tool ${t.name}: ${key} ${msg}`)
      let size = 0
      try { size = JSON.stringify(schema).length } catch { bad('schema cannot be serialized'); continue }
      if (size > MAX_TOOL_SCHEMA_BYTES) { bad(`schema is larger than ${MAX_TOOL_SCHEMA_BYTES / 1024} KB`); continue }
      if (key === 'input') {
        for (const hit of findSecretSolicitation(schema, `${base}/input`)) {
          add('TOOL_SOLICITS_SECRET', hit.path, `tool ${t.name}: parameter "${hit.hit}" asks for a secret; tool arguments must never carry keys, mnemonics, passwords or API secrets`, 'remove the parameter or reword the description; secrets stay in the kernel keystore and are never passed through tool arguments')
        }
      }
      const unsafe = findUnsafePatterns(schema)
      for (const u of unsafe) bad(`pattern "${u.pattern.length > 80 ? `${u.pattern.slice(0, 80)}…` : u.pattern}" is rejected: ${u.reason}`)
      if (unsafe.length > 0 || !schemaCompiler) continue
      try { schemaCompiler(schema) } catch (e) { bad(`schema does not compile: ${(e as Error).message}`) }
    }
    if (t.output !== undefined && !isPlainObject(t.output)) add('TOOL_SCHEMA_INVALID', `${base}/output`, `tool ${t.name}: output must be a JSON Schema object`)
    ;(t.permissions ?? []).forEach((p, j) => {
      if (!perms.has(p)) add('TOOL_PERMISSION_UNDECLARED', `${base}/permissions/${j}`, `tool ${t.name} needs permission ${p}, which is not declared in permissions`)
    })
  })

  // 证据
  const claims = Array.isArray(m.evidence?.claims) ? m.evidence!.claims : []
  claims.forEach((c, i) => {
    const path = `/evidence/claims/${i}`
    if (c.basis === 'backtest' && !(Array.isArray(c.assumptions) && c.assumptions.some((a) => typeof a === 'string' && a.trim() !== ''))) {
      add('EVIDENCE_BACKTEST_NEEDS_ASSUMPTIONS', path, 'backtest claims must list assumptions', 'state costs, slippage, data source and date range')
    }
    if ((c.basis === 'paper' || c.basis === 'live') && !(typeof c.ref === 'string' && c.ref.trim() !== '')) add('EVIDENCE_FORWARD_NEEDS_REF', path, `${c.basis} claims must carry a verifiable ref`)
    if (c.window && typeof c.window.from === 'number' && typeof c.window.to === 'number' && c.window.from >= c.window.to) add('EVIDENCE_WINDOW_INVALID', `${path}/window`, 'evidence window.from must be earlier than window.to')
  })

  // 隐私一致性
  if ((m.privacy?.sends?.length ?? 0) > 0 && !perms.has('net.fetch')) add('PRIVACY_SENDS_WITHOUT_NET', '/privacy/sends', 'privacy.sends is not empty but net.fetch is not requested')
  if (m.privacy?.hosted === true && !(perms.has('net.fetch') && m.net && m.net.hosts.length > 0)) add('PRIVACY_HOSTED_WITHOUT_NET', '/privacy/hosted', 'hosted plugin must request net.fetch and list net.hosts')

  // 承诺用语
  const promise = (text: unknown, path: string): void => {
    if (typeof text !== 'string') return
    const hit = findPromiseLanguage(text)
    if (hit !== null) add('PROMISE_LANGUAGE', path, `promise-like wording: "${hit}"`, 'remove wording that promises returns or removes risk')
  }
  promise(m.name, '/name')
  promise(m.desc, '/desc')
  tools.forEach((t, i) => promise(t.desc, `/tools/${i}/desc`))
  promise(m.risk?.disclosure, '/risk/disclosure')
  promise(m.risk?.worstCase, '/risk/worstCase')
  promise(m.evidence?.notes, '/evidence/notes')

  return out
}

/** 兼容检查（清单声明 vs 内核）。`supportedSchema` 是内核支持的清单 major，默认 `"1"`。 */
export function checkPluginCompat(m: PluginManifest, kernelVersion: string, supportedSchema = '1'): PluginIssue[] {
  const out: PluginIssue[] = []
  if (m.compat.pluginSchema !== supportedSchema) {
    out.push({ code: 'COMPAT_SCHEMA_UNSUPPORTED', path: '/compat/pluginSchema', message: `this kernel supports plugin schema "${supportedSchema}", got "${m.compat.pluginSchema}"` })
  }
  if (!isValidRange(m.compat.gitrader)) {
    out.push({ code: 'COMPAT_RANGE_INVALID', path: '/compat/gitrader', message: `compat.gitrader "${m.compat.gitrader}" is not a valid version range`, hint: 'use >=0.1.0 <0.2.0, ^0.1.0, ~0.1.0, an exact version or *' })
  } else if (!satisfiesRange(kernelVersion, m.compat.gitrader)) {
    out.push({ code: 'COMPAT_GITRADER_UNSATISFIED', path: '/compat/gitrader', message: `kernel ${kernelVersion} does not satisfy compat.gitrader "${m.compat.gitrader}"` })
  }
  return out
}

/** 同 `checkPluginManifestIssues`，只返回消息文本（旧接口，消息文本保持不变）。 */
export function checkPluginManifest(m: PluginManifest): string[] {
  return checkPluginManifestIssues(m).map((i) => i.message)
}

// ---- GSP 签名请求（连接器 → 内核）----------------------------------------------------------

export const GSP_VERSION = '0.1.0'
export const GSP_COMMON_METHODS = ['plugin.hello', 'plugin.describe', 'plugin.health', 'plugin.shutdown', 'tool.call'] as const
export const GSP_KIND_METHODS = [
  'datasource.fetch', 'factor.compute', 'decision.decide', 'protector.evaluate', 'executor.plan', 'executor.tick',
  'connector.submit', 'connector.cancel', 'connector.amend', 'connector.status', 'connector.account', 'connector.stream',
] as const

export const SIGNER_ALGS = ['hmac-sha256', 'hmac-sha512', 'ed25519', 'rsa-sha256', 'eip712-secp256k1'] as const
export type SignerAlg = (typeof SIGNER_ALGS)[number]

/** host.signer.sign 的参数：句柄不可导出；只在内核发起的 connector.* 调用（callId）期间有效，默认每次调用最多 4 次签名。 */
export interface SignerSignParams { handle: string; alg: SignerAlg; payload?: string; typedData?: Record<string, unknown>; callId: string }
export interface SignerSignResult { signature: string }
export const SIGNER_MAX_SIGNATURES_PER_CALL = 4

/** 生命周期状态（§3.5）。 */
export const PLUGIN_STATES = ['installed', 'starting', 'ready', 'degraded', 'stopping', 'stopped', 'failed'] as const
export type PluginState = (typeof PLUGIN_STATES)[number]
export const PLUGIN_HEALTH = { intervalMs: 10_000, timeoutMs: 3_000, failuresBeforeRestart: 3, backoffMinMs: 1_000, backoffMaxMs: 60_000, crashLimit: 5, crashWindowMs: 600_000, shutdownGraceMs: 5_000 } as const
