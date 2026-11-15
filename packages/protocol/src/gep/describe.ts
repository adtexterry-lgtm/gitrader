// SPDX-License-Identifier: Apache-2.0
// 契约 §2.3 engine.describe、能力位总表；§2.6 Binding（模式 A / B）。
import type { Ms } from '../model/decimal'
import type { AccountId, BindingId, MandateId, PolicyId, Sha256Digest } from '../model/ids'
import type { VenueCapabilities } from '../model/instrument'

export const GEP_CAPABILITY_KEYS = [
  'execution.modeA', 'execution.modeB', 'market.useHost', 'market.own', 'strategy', 'strategy.hotUpdate', 'backtest',
  'backtest.fillModels', 'replay', 'events.resume', 'events.retention', 'risk.cooperative', 'halt.levels', 'builder.attach',
  'decision.log',
] as const
export type GepCapabilityKey = (typeof GEP_CAPABILITY_KEYS)[number]

/** 已知能力位或 `x-<vendor>.<名>` 厂商扩展。宿主只按能力位判断功能，不按版本号判断。 */
export function isKnownCapability(name: string): boolean {
  return (GEP_CAPABILITY_KEYS as readonly string[]).includes(name) || /^x-[a-z0-9-]+\.[A-Za-z0-9_.-]+$/.test(name)
}

export interface EngineCapabilities {
  'execution.modeA'?: boolean
  'execution.modeB'?: boolean
  'market.useHost'?: boolean
  'market.own'?: boolean
  strategy?: boolean
  'strategy.hotUpdate'?: boolean
  backtest?: boolean
  'backtest.fillModels'?: string[]
  replay?: boolean
  'events.resume'?: boolean
  'events.retention'?: { minEvents: number; minMs: Ms }
  'risk.cooperative'?: boolean
  /** 必须含 halt_new。 */
  'halt.levels'?: ('halt_new' | 'cancel_all' | 'flatten_all')[]
  'builder.attach'?: boolean
  'decision.log'?: boolean
  [vendorExtension: `x-${string}`]: unknown
}

export interface EngineIdentity {
  id: string
  name: string
  version: string
  vendor: { id: string; name: string; kind: 'builtin' | 'partner' | 'community' | 'self'; verified: boolean; url?: string | null }
  license: string
  runtime: string
}

export interface EngineStrategyEntry {
  id: string
  name: string
  version: string
  kind: string
  paramsSchemaRef?: string
}

export interface EngineDescribe {
  engine: EngineIdentity
  protocol: { version: string; transports: ('stdio' | 'ws' | 'wss')[] }
  capabilities: EngineCapabilities
  /** 模式 B 引擎自连的场所能力声明。 */
  venues: VenueCapabilities[]
  data?: { intervals: string[]; maxHistoryBars: number }
  strategies?: EngineStrategyEntry[]
  limits?: { maxConcurrentBacktests?: number; maxStrategyInstances?: number }
  /** 回测假设如实声明；funding: false 与 liquidation: false 必须在结果页显示。 */
  assumptions?: { backtest?: Record<string, unknown> }
  /** §7.2 弃用项。 */
  deprecated?: string[]
}

// ---- Binding（engine.bind 参数） --------------------------------------------------

export type BindingMode = 'A' | 'B'

export interface BindingAccount {
  accountId: AccountId
  mode: BindingMode
  mandateId: MandateId
  /** 模式 B 必须声明签名者地址或 Key 指纹（未声明或与宿主 / 其他绑定重复即拒绑，5xxx / 1005 视情形）。契约正文要求声明但没给字段名：A 追加（见 CHANGELOG）。 */
  signer?: { address?: string; fingerprint?: string }
}

export interface Binding {
  bindingId: BindingId
  accounts: BindingAccount[]
  data: { source: 'host' | 'engine'; instruments: string[] }
  policies: { policyId: PolicyId; version: number; digest: Sha256Digest }[]
  builder?: { attachedBy: 'host' | 'engine' }
  heartbeatMs: number
}

export interface BindResult { bindingId: BindingId; effective: Binding; warnings: string[] }

/** 能力位与模式的一致性检查，返回问题列表（空 = 通过）。 */
export function checkBindingAgainstDescribe(binding: Binding, describe: EngineDescribe): string[] {
  const problems: string[] = []
  const cap = describe.capabilities
  for (const a of binding.accounts) {
    if (a.mode === 'A' && !cap['execution.modeA']) problems.push(`account ${a.accountId}: engine does not declare execution.modeA`)
    if (a.mode === 'B') {
      if (!cap['execution.modeB']) problems.push(`account ${a.accountId}: engine does not declare execution.modeB`)
      if (cap['risk.cooperative'] !== true) problems.push(`account ${a.accountId}: mode B requires risk.cooperative = true`)
      if (!a.signer?.address && !a.signer?.fingerprint) problems.push(`account ${a.accountId}: mode B requires a declared signer (address or fingerprint)`)
    }
  }
  const signers = binding.accounts.filter((a) => a.mode === 'B').map((a) => a.signer?.address ?? a.signer?.fingerprint)
  if (new Set(signers.filter(Boolean)).size < signers.filter(Boolean).length) problems.push('mode B signers must not be shared between bindings')
  if (binding.data.source === 'host' && !cap['market.useHost']) problems.push('engine does not declare market.useHost')
  if (binding.data.source === 'engine' && !cap['market.own']) problems.push('engine does not declare market.own')
  return problems
}

