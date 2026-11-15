// SPDX-License-Identifier: Apache-2.0
// 校验器：用 ajv（draft 2020-12）编译 schemas/*.json，导出 validateX()。
// 约定：未知字段放行（契约 §2.9 / §7.1），只检查契约写明的必填 / 枚举 / 格式；跨字段语义规则另有 check*() 函数，validatePluginManifest / validateWorkspace 已把两者合并。
import Ajv2020 from 'ajv/dist/2020'
import addFormats from 'ajv-formats'
import type { ErrorObject, ValidateFunction } from 'ajv'
import type { Account, AccountGroup, Balance, MarginSnapshot, Org } from './model/account'
import type { Fill, FundingPayment, Order, OrderIntent, Position } from './model/order'
import type { ReconcileAccountView, ReconcileConfirmInput, ReconcileConfirmResult, ReconcileEvidence, ReconcileFindingView, ReconcileResolutionInput, ReconcileResolutionReceipt, ReconcileResolveResult, ReconcileReviewItem, ReconcileSuggestion } from './model/execution-reconcile'
import type { OperationRateLimitConfig, ServerSecurityConfig } from './model/server-security'
import type { Instrument, SimVenueDeclaration, VenueCapabilities } from './model/instrument'
import type { Problem, RuleHit } from './model/problem'
import type { AccountSnapshot as ConnectorAccountSnapshot } from './connector/account'
import type { BookSnapshot } from './connector/market'
import type { Origin } from './model/origin'
import type { PrecheckResult, RiskPolicy } from './model/risk'
import { checkLossAttribution, type DecisionRecord, type Experiment, type LossAttribution, type Signal } from './model/signal'
import type { Mandate } from './agent/mandate'
import type { AgentKey, TakeoverRequest } from './agent/takeover'
import type { Proposal } from './agent/proposal'
import type { LedgerEntry, ModelTrainedPayload } from './ledger/entry'
import type { PluginManifest } from './plugin/manifest'
import type { BlockManifest } from './block/block'
import type { Workspace } from './block/workspace'
import type { AccountSummary, RiskStateSnapshot } from './block/payloads'
import type { BacktestResult, BacktestSpec } from './gep/backtest'
import type { Binding, EngineDescribe } from './gep/describe'
import type { EventsPushParams, MarketCandleData, MarketCandlesData } from './gep/events'
import type { GepHelloParams, GepHelloResult, OrderResult } from './gep/methods'
import type { JsonRpcMessage } from './gep/rpc'
import { checkPluginManifestIssues, registerSchemaCompiler, type PluginIssue } from './plugin/manifest'
import { checkWorkspace } from './block/workspace'
import { checkEngineLaunch, type EngineLaunch } from './gep/launch'
import type { KeyInfo, PresenceProof, SessionExchangeRequest, SessionExchangeResult, SettingsSnapshot, UiAuthParams, UiCommandParams, UiEventParams, UiQueryParams, UiSubscribeParams } from './ui/wire'
import { ALL_SCHEMAS } from './schema-registry'

export const SCHEMA_BASE = 'urn:gitrader:schema:'
export const modelId = (name: string): string => `${SCHEMA_BASE}model:0.1:${name}`
export const agentId = (name: string): string => `${SCHEMA_BASE}agent:0.1:${name}`
export const gepId = (name: string): string => `${SCHEMA_BASE}gep:0.1:${name}`
export const PLUGIN_SCHEMA_ID = `${SCHEMA_BASE}plugin:1`
export const BLOCK_SCHEMA_ID = `${SCHEMA_BASE}block:1`
export const WORKSPACE_SCHEMA_ID = `${SCHEMA_BASE}workspace:1`
export const WORKFLOW_SCHEMA_ID = `${SCHEMA_BASE}workflow:2`
export const LEDGER_SCHEMA_ID = `${SCHEMA_BASE}ledger:1`

/** `code` 只在语义检查产生的问题上有值（插件清单的 `PluginIssueCode`）；JSON Schema 层的问题没有。 */
export interface ValidationIssue { path: string; message: string; keyword: string; code?: string }
export type ValidationResult<T> = { ok: true; value: T } | { ok: false; issues: ValidationIssue[] }

const ajv = new Ajv2020({ allErrors: true, strict: true, strictTypes: false, strictTuples: false, strictRequired: false })
addFormats(ajv)
for (const schema of ALL_SCHEMAS) ajv.addSchema(schema)

/** 全部已注册 schema 的 $id。 */
export function listSchemaIds(): string[] {
  return ALL_SCHEMAS.map((s) => String(s['$id'])).sort()
}

function toIssues(errors: ErrorObject[] | null | undefined): ValidationIssue[] {
  return (errors ?? []).map((e) => ({ path: e.instancePath || '/', message: e.message ?? 'invalid', keyword: e.keyword }))
}

const cache = new Map<string, ValidateFunction>()
function compiled(ref: string): ValidateFunction {
  let v = cache.get(ref)
  if (!v) {
    v = ref.includes('#') ? ajv.compile({ $ref: ref }) : (ajv.getSchema(ref) as ValidateFunction | undefined)
    if (!v) throw new Error(`unknown schema ${ref}`)
    cache.set(ref, v)
  }
  return v
}

/** 按 $id（可带 #/$defs/… 片段）校验任意数据。 */
export function validateBySchemaId(ref: string, data: unknown): ValidationResult<unknown> {
  const v = compiled(ref)
  return v(data) ? { ok: true, value: data } : { ok: false, issues: toIssues(v.errors) }
}

function make<T>(ref: string, extra?: (value: T) => (string | PluginIssue)[]): (data: unknown) => ValidationResult<T> {
  return (data) => {
    const v = compiled(ref)
    if (!v(data)) return { ok: false, issues: toIssues(v.errors) }
    const problems = extra?.(data as T) ?? []
    if (problems.length > 0) {
      return {
        ok: false,
        issues: problems.map((p): ValidationIssue =>
          typeof p === 'string' ? { path: '/', message: p, keyword: 'semantic' } : { path: p.path, message: p.message, keyword: 'semantic', code: p.code }),
      }
    }
    return { ok: true, value: data as T }
  }
}

/**
 * 编译一份 JSON Schema（draft 2020-12）成校验函数；用独立的 Ajv 实例（strict:false，带 formats），不污染内置 schema 注册表。
 * schema 不合法 / 编译失败抛 Error；含 `$async`（任何层级）的异步 schema 一律拒绝（异步校验器返回 Promise，会绕过校验并让未处理的拒绝拖垮进程）。调用方自己缓存返回的函数。
 */
export function compileSchema(schema: Record<string, unknown>): (data: unknown) => ValidationResult<unknown> {
  const todo: unknown[] = [schema]
  while (todo.length > 0) {
    const x = todo.pop()
    if (typeof x !== 'object' || x === null) continue
    if (!Array.isArray(x) && '$async' in x) throw new Error('async schemas are not supported')
    todo.push(...Object.values(x))
  }
  const own = new Ajv2020({ allErrors: true, strict: false })
  addFormats(own)
  const v = own.compile(schema)
  if ((v as { $async?: boolean }).$async === true) throw new Error('async schemas are not supported')
  return (data) => (v(data) ? { ok: true, value: data } : { ok: false, issues: toIssues(v.errors) })
}
registerSchemaCompiler(compileSchema)

// ---- 统一模型 -------------------------------------------------------------------------------
export const validateOrigin = make<Origin>(modelId('Origin'))
export const validateRuleHit = make<RuleHit>(modelId('RuleHit'))
export const validateProblem = make<Problem>(modelId('Problem'))
export const validateInstrument = make<Instrument>(modelId('Instrument'))
export const validateVenueCapabilities = make<VenueCapabilities>(modelId('VenueCapabilities'))
export const validateSimVenueDeclaration = make<SimVenueDeclaration>(modelId('SimVenueDeclaration'))
export const validateOrg = make<Org>(modelId('Org'))
export const validateAccountGroup = make<AccountGroup>(modelId('AccountGroup'))
export const validateAccount = make<Account>(modelId('Account'))
export const validateBalance = make<Balance>(modelId('Balance'))
export const validateMarginSnapshot = make<MarginSnapshot>(modelId('MarginSnapshot'))
export const validateOrderIntent = make<OrderIntent>(modelId('OrderIntent'))
export const validateOrder = make<Order>(modelId('Order'))
export const validateFill = make<Fill>(modelId('Fill'))
export const validateReconcileEvidence = make<ReconcileEvidence>(modelId('ReconcileEvidence'))
export const validateReconcileFindingView = make<ReconcileFindingView>(modelId('ReconcileFindingView'))
export const validateReconcileSuggestion = make<ReconcileSuggestion>(modelId('ReconcileSuggestion'))
export const validateReconcileResolutionInput = make<ReconcileResolutionInput>(modelId('ReconcileResolutionInput'))
export const validateReconcileResolutionReceipt = make<ReconcileResolutionReceipt>(modelId('ReconcileResolutionReceipt'))
export const validateReconcileResolveResult = make<ReconcileResolveResult>(modelId('ReconcileResolveResult'))
export const validateReconcileReviewItem = make<ReconcileReviewItem>(modelId('ReconcileReviewItem'))
export const validateReconcileAccountView = make<ReconcileAccountView>(modelId('ReconcileAccountView'))
export const validateReconcileConfirmInput = make<ReconcileConfirmInput>(modelId('ReconcileConfirmInput'))
export const validateReconcileConfirmResult = make<ReconcileConfirmResult>(modelId('ReconcileConfirmResult'))
export const validateOperationRateLimitConfig = make<OperationRateLimitConfig>(modelId('OperationRateLimitConfig'))
export const validateServerSecurityConfig = make<ServerSecurityConfig>(modelId('ServerSecurityConfig'))
export const validatePosition = make<Position>(modelId('Position'))
export const validateBookSnapshot = make<BookSnapshot>(modelId('BookSnapshot'))
export const validateConnectorAccountSnapshot = make<ConnectorAccountSnapshot>(modelId('ConnectorAccountSnapshot'))
export const validateFundingPayment = make<FundingPayment>(modelId('FundingPayment'))
export const validateRiskPolicy = make<RiskPolicy>(modelId('RiskPolicy'))
export const validatePrecheckResult = make<PrecheckResult>(modelId('PrecheckResult'))
export const validateSignal = make<Signal>(modelId('Signal'))
export const validateExperiment = make<Experiment>(modelId('Experiment'))
export const validateDecisionRecord = make<DecisionRecord>(modelId('DecisionRecord'))
/** schema + 各项之和等于 totalLoss 的精确检查（v0.1.3）。 */
export const validateLossAttribution = make<LossAttribution>(modelId('LossAttribution'), checkLossAttribution)
export const validateModelTrainedPayload = make<ModelTrainedPayload>(modelId('ModelTrainedPayload'))

// ---- Agent 接口 -----------------------------------------------------------------------------
export const validateAgentKey = make<AgentKey>(agentId('AgentKey'))
export const validateMandate = make<Mandate>(agentId('Mandate'))
export const validateProposal = make<Proposal>(agentId('Proposal'))
export const validateTakeoverRequest = make<TakeoverRequest>(agentId('TakeoverRequest'))

// ---- 账本 / 插件 / 块 / 工作区 ----------------------------------------------------------------
export const validateLedgerEntry = make<LedgerEntry>(LEDGER_SCHEMA_ID)
/** schema + 语义规则（权限与 kind 矩阵、永不可授予、未签名限制等）。 */
export const validatePluginManifest = make<PluginManifest>(PLUGIN_SCHEMA_ID, checkPluginManifestIssues)
export const validateBlockManifest = make<BlockManifest>(BLOCK_SCHEMA_ID)
/** schema + 语义规则（stack 恰一个 active、钉住块不入 stack 等）。 */
export const validateWorkspace = make<Workspace>(WORKSPACE_SCHEMA_ID, checkWorkspace)
export const validateWorkflow = make<Record<string, unknown>>(WORKFLOW_SCHEMA_ID)

// ---- GEP ------------------------------------------------------------------------------------
export const validateEngineDescribe = make<EngineDescribe>(gepId('EngineDescribe'))
export const validateEngineLaunch = make<EngineLaunch>(gepId('EngineLaunch'), checkEngineLaunch)
export const validateBinding = make<Binding>(gepId('Binding'))
export const validateGepHelloParams = make<GepHelloParams>(gepId('GepHelloParams'))
export const validateGepHelloResult = make<GepHelloResult>(gepId('GepHelloResult'))
export const validateMarketCandleData = make<MarketCandleData>(`${gepId('Methods')}#/$defs/MarketCandleData`)
export const validateMarketCandlesData = make<MarketCandlesData>(`${gepId('Methods')}#/$defs/MarketCandlesData`)
export const validateEventsPush = make<EventsPushParams>(gepId('EventsPushParams'))
export const validateBacktestSpec = make<BacktestSpec>(gepId('BacktestSpec'))
export const validateBacktestResult = make<BacktestResult>(gepId('BacktestResult'))
export const validateOrderResult = make<OrderResult>(gepId('OrderResult'))
export const validateJsonRpcRequest = make<JsonRpcMessage>(gepId('JsonRpcRequest'))
export const validateJsonRpcNotification = make<JsonRpcMessage>(gepId('JsonRpcNotification'))
export const validateJsonRpcResponse = make<JsonRpcMessage>(gepId('JsonRpcResponse'))

// ---- UI 通道（壳 ↔ 内核，v0.1.3）-------------------------------------------------------------
export const uiId = (name: string): string => `${SCHEMA_BASE}ui:0.1:${name}`
export const validateSessionExchangeRequest = make<SessionExchangeRequest>(uiId('SessionExchangeRequest'))
export const validateSessionExchangeResult = make<SessionExchangeResult>(uiId('SessionExchangeResult'))
export const validateUiAuthParams = make<UiAuthParams>(uiId('UiAuthParams'))
export const validateUiSubscribeParams = make<UiSubscribeParams>(uiId('UiSubscribeParams'))
export const validateUiQueryParams = make<UiQueryParams>(uiId('UiQueryParams'))
export const validateUiCommandParams = make<UiCommandParams>(uiId('UiCommandParams'))
export const validateUiEventParams = make<UiEventParams>(uiId('UiEventParams'))
export const validatePresenceProof = make<PresenceProof>(uiId('PresenceProof'))
export const validateSettingsSnapshot = make<SettingsSnapshot>(uiId('SettingsSnapshot'))
export const validateRiskStateSnapshot = make<RiskStateSnapshot>(uiId('RiskStateSnapshot'))
export const validateAccountSummary = make<AccountSummary>(uiId('AccountSummary'))
export const validateKeyInfo = make<KeyInfo>(uiId('KeyInfo'))

const methodsId = gepId('Methods')
/** 校验某个方法（或通知）的 params。未知方法返回 ok:false。 */
export function validateGepParams(method: string, params: unknown): ValidationResult<unknown> {
  return validateMethodPart(method, 'params', params ?? {})
}
/** 校验某个方法的 result。 */
export function validateGepResult(method: string, result: unknown): ValidationResult<unknown> {
  return validateMethodPart(method, 'result', result)
}
function validateMethodPart(method: string, part: 'params' | 'result', data: unknown): ValidationResult<unknown> {
  const ref = `${methodsId}#/$defs/${method}:${part}`
  try {
    return validateBySchemaId(ref, data)
  } catch {
    return { ok: false, issues: [{ path: '/', message: `no ${part} schema for method ${method}`, keyword: 'unknownMethod' }] }
  }
}

/** 把校验问题压成一行可读文本（测试与日志用）。 */
export function formatIssues(issues: readonly ValidationIssue[]): string {
  return issues.map((i) => `${i.path} ${i.message}`).join('; ')
}
