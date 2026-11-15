// SPDX-License-Identifier: Apache-2.0
import type { AccountEnvironment, AccountMode, Balance, MarginSnapshot } from '../model/account'
import type { Decimal, Ms } from '../model/decimal'
import type { AccountId, ExperimentId, InstanceId, InstrumentId, ProposalId } from '../model/ids'
import type { Origin, OriginActorType } from '../model/origin'
import type { Problem } from '../model/problem'
import type { Experiment } from '../model/signal'
import type { Fill, Order } from '../model/order'
import type { LedgerEntry } from '../ledger/entry'
import type { BacktestResult } from '../gep/backtest'
import type { StrategyInstance, StrategyInstanceStatus } from '../gep/methods'
import type { ForwardSnapshot, LabRun } from '../model/experiment'

export interface AccountAssetsView {
  accountId: AccountId
  balances: Balance[]
  margin: MarginSnapshot | null
  ts: Ms
}

export interface EquityHistoryParams { accountId: AccountId; from: Ms; to: Ms; step: '1m' | '1h' | '1d' }
export interface EquityHistoryView {
  /** [from, to)；t 是本内核取得完整新鲜账户快照后的观察时刻，不是权益变更时刻；分钟数据可按更粗粒度降采样，gaps 表示缺失区间且不插值。 */
  points: { t: Ms; equity: Decimal; available: Decimal }[]
  gaps: { from: Ms; to: Ms }[]
}

/** cursor 是内核提供的不透明分页值；limit 最大为 500。 */
export interface RecordsQueryParams {
  kind: 'fill' | 'order' | 'funding'
  accountId?: AccountId
  instrumentId?: InstrumentId
  actorType?: OriginActorType
  sinceTs?: Ms
  untilTs?: Ms
  cursor?: string
  limit?: number
}
/** origin 为 null 仅表示无法关联原订单；不得因此把成交归因为 human。 */
export type RecordFillView = Fill & { origin: Origin | null; proposalId?: ProposalId; ticket?: string }
/** funding records keep their actual LedgerEntry shape. */
export interface RecordsQueryView { items: (RecordFillView | Order | LedgerEntry)[]; next?: string; total?: number }

export interface EngineStrategyView {
  engineId: string
  instanceId: InstanceId
  strategyId: string
  version: string
  accountId: AccountId
  state: StrategyInstanceStatus
  params: StrategyInstance['params']
  /** Only map a problem when the real instance reports an error. */
  problem?: Problem
  lastFillTs?: Ms
  experimentId?: ExperimentId
}
export interface EngineStrategyFailureView { engineId: string; unavailable: true; problem: Problem }
/** 每个引擎独立呈现；不可用行不伪造策略或账户身份。 */
export type EngineStrategiesView = (EngineStrategyView | EngineStrategyFailureView)[]

/** engine.catalog：引擎已加载的策略与表单用参数（strategy.params 的 JSON Schema 映射而来；x-hidden 的不出现）。 */
export interface EngineCatalogParam {
  key: string; label: string; type: 'number' | 'integer' | 'boolean' | 'select' | 'text'; default: number | boolean | string | null
  min?: number; max?: number; step?: number; options?: string[]; help?: string
}
export interface EngineCatalogStrategy { id: string; name: string; nameZh?: string; version: string; desc: string; tags: string[]; params: EngineCatalogParam[] }
export interface EngineCatalogEntry { engineId: string; strategies: EngineCatalogStrategy[] }
export type EngineCatalogView = (EngineCatalogEntry | EngineStrategyFailureView)[]

/** portfolio.analysis：一个口径（实盘 / 纸面，永不合并）的组合分析；金额与比重全是十进制字符串。 */
export interface PortfolioShareView { key: string; exposure: Decimal; weight: Decimal }
export interface PortfolioPnlView { key: string; realized: Decimal; unrealized: Decimal; funding: Decimal; total: Decimal }
export interface PortfolioAnalysisView {
  scope: 'live' | 'paper'
  /** 本机存在的口径（界面据此决定要不要给切换）。 */
  scopes: ('live' | 'paper')[]
  valuationCcy: string
  accounts: number
  gross: Decimal
  byVenue: PortfolioShareView[]
  byStrategy: PortfolioPnlView[]
  byInstrument: PortfolioShareView[]
  /** 未计入汇总的持仓原因（`missing_fx: …` 等），原文。 */
  missing: string[]
}
export type PortfolioAnalysisResult = PortfolioAnalysisView | { unavailable: true; details: string[] }

export interface LabListView { items: Experiment[]; next?: string }
/** Preserve the existing forward records; runSummaries contain locally stored runs. */
export type LabGetView = Experiment & { runSummaries: LabRun[]; forwardSnapshots: ForwardSnapshot[] }
/** An offline local result; the caller should return an error when no result exists. */
export type LabRunView = BacktestResult

export interface VenueCatalogEntry { venue: string; kind: 'trading' | 'data'; verified: boolean; credentials: string[] }
export interface ConfigVenueView { id: string; environment: AccountEnvironment; enabled: boolean; symbols?: string[] }
export interface ConfigAccountView {
  accountId?: AccountId
  alias: string
  venue: string
  environment: AccountEnvironment
  mode: AccountMode
  paper?: { initialBalance: Decimal; ccy: string }
  signerRef?: string
  /** 每个值仅为环境变量句柄，不是凭据内容。 */
  credentials?: Record<string, string>
  owner?: { address?: string; accountRef?: string }
}
export interface ConfigNotifyView {
  channels: { id: string; plugin: string; minLevel: 'info' | 'warn' | 'critical'; params: Record<string, unknown> }[]
  rules?: { match: string; level: 'info' | 'warn' | 'critical'; channels: string[] }[]
  rateLimit?: { perChannelPerMinute: number; dedupeWindowSec: number }
}
export interface ConfigView {
  /** Safe projections, never the complete internal config object. */
  venues: ConfigVenueView[]
  accounts: ConfigAccountView[]
  notify: ConfigNotifyView
  handles: { path: string; handle: string; resolved: boolean }[]
  catalog: VenueCatalogEntry[]
}
/** 提供的数组整段替换；省略的配置段保持不变。 */
export interface ConfigVenuesSetParams { patch: { venues?: ConfigVenueView[]; accounts?: ConfigAccountView[] } }
export interface ConfigVenuesSetView { config: ConfigView; restartRequired: boolean }
export interface ConfigNotifySetParams { channels?: ConfigNotifyView['channels']; rules?: ConfigNotifyView['rules'] }
export interface ConfigNotifySetView { notify: ConfigNotifyView; restartRequired: boolean }
