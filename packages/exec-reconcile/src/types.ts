// SPDX-License-Identifier: CPAL-1.0
// 对账的输入 / 输出形状。
//
// 输入只有两种「视图」：
//   · 本地视图（LocalView）= 账本此刻相信的挂单 / 成交 / 持仓快照；
//   · 场所视图（VenueView）= 连接器能给出的挂单 / 历史订单 / 成交 / 持仓。
// 输出只有「差异 + 建议」，没有任何写入口：改账由内核按人定的规则执行（红线：模型不碰钱）。
//
// 字段只收对账用得到的部分，是协议类型（VenueOpenOrder / VenueFill / Position）的子集，
// 由内核在调用处映射；映射约定见 README「与内核的接口」。

export type Ms = number
export type Side = 'buy' | 'sell'
export type PositionSide = 'long' | 'short'
export type MarginMode = 'cross' | 'isolated' | 'strictIsolated' | 'noCross'

/** 本地订单状态，与协议 ORDER_STATUSES 一致。 */
export const LOCAL_ORDER_STATUSES = [
  'new', 'submitted', 'open', 'untriggered', 'partially_filled', 'filled', 'cancelled', 'expired', 'rejected', 'denied',
] as const
export type LocalOrderStatus = (typeof LOCAL_ORDER_STATUSES)[number]

/** 终结状态：账本认为这张单不会再动了。 */
export const TERMINAL_ORDER_STATUSES: readonly LocalOrderStatus[] = ['filled', 'cancelled', 'expired', 'rejected', 'denied']

export function isTerminalStatus(status: LocalOrderStatus): boolean {
  return TERMINAL_ORDER_STATUSES.includes(status)
}

/** 账本侧订单视图。数量一律十进制字符串，基础资产单位。 */
export interface LocalOrderView {
  orderId: string
  clientOrderId: string
  /** 账本最后一次记下的场所单号；改单链上的早期单号放 links。 */
  venueOrderId?: string | null
  instrumentId: string
  side: Side
  type: string
  /** 下单数量（原量）。 */
  size: string
  /** 账本累计已成交数量（= 本账已入账成交之和）。 */
  filledSize: string
  price?: string | null
  triggerPrice?: string | null
  status: LocalOrderStatus
  reduceOnly?: boolean
  marginMode?: MarginMode
  createdAt: Ms
  updatedAt?: Ms
  closedAt?: Ms
}

/** 账本侧成交视图。venueFillId 是场所成交号（缺失时为空串）。 */
export interface LocalFillView {
  venueFillId: string
  orderId?: string | null
  clientOrderId?: string | null
  venueOrderId?: string | null
  instrumentId: string
  side: Side
  price: string
  size: string
  fee?: string
  liquidity?: 'maker' | 'taker'
  ts: Ms
}

/** 账本侧持仓视图。side 是方向，size 为正数。 */
export interface LocalPositionView {
  instrumentId: string
  side: PositionSide
  size: string
  entryPrice: string
  marginMode: MarginMode
}

export interface LocalView {
  accountId: string
  orders: readonly LocalOrderView[]
  fills: readonly LocalFillView[]
  positions: readonly LocalPositionView[]
  /** 这份账本视图的生成时刻。 */
  asOf: Ms
}

/** 场所报告种类（用于声明「场所给不出哪类报告」，结论要相应降级）。 */
export type VenueReportKind = 'openOrders' | 'historyOrders' | 'fills' | 'positions'

/** 场所侧订单视图：挂单报告与历史订单报告共用。status 保留上游原话，不翻译。 */
export interface VenueOrderView {
  venueOrderId: string
  clientOrderId?: string | null
  instrumentId: string
  side: Side
  /** 上游订单类型原话（Market / Limit / TAKE_PROFIT_MARKET …）。 */
  type?: string
  /** 未成交剩余量（场所口径 sz / leaves_qty）。 */
  size?: string
  /** 原始下单量（origSz / origQty / qty）。 */
  origSize?: string
  /** 场所累计成交量（executedQty / cumQty / cum_qty）。 */
  filledSize?: string
  /** 场所给的成交均价（avgPx / avgPrice）。有它才能给推断成交定价。 */
  avgFillPrice?: string | null
  price?: string | null
  triggerPrice?: string | null
  status: string
  reduceOnly?: boolean
  marginMode?: MarginMode
  createdAt?: Ms
  updatedAt?: Ms
  /** 这条报告来自挂单查询还是历史订单查询，写进证据。 */
  source: 'open' | 'history'
}

/** 场所侧成交视图。 */
export interface VenueFillView {
  venueFillId: string
  venueOrderId: string
  clientOrderId?: string | null
  instrumentId: string
  side: Side
  price: string
  size: string
  fee?: string
  ts: Ms
  liquidity?: 'maker' | 'taker'
}

/** 场所侧持仓视图。 */
export interface VenuePositionView {
  instrumentId: string
  side: PositionSide
  size: string
  entryPrice: string
  marginMode: MarginMode
}

export interface VenueView {
  openOrders: readonly VenueOrderView[]
  /** 历史订单（已完成 / 已撤）。连接器查不到时留空并把 'historyOrders' 写进 unavailable。 */
  historyOrders?: readonly VenueOrderView[]
  fills: readonly VenueFillView[]
  positions: readonly VenuePositionView[]
  asOf: Ms
  /** 成交回补被场所上限截断（例如官方 2000 条上限）。 */
  truncated?: boolean
  /** 场所明确不提供 / 本次没查的报告；相关结论会降级成「需要人工」。 */
  unavailable?: readonly VenueReportKind[]
}

/** 改单链上的一条链接：一次下单 / 改单 / 撤单后，客户端单号与场所单号如何对应。 */
export interface AmendLink {
  clientOrderId: string
  /** 这次动作之后该单在场所的单号（撤单可为 null）。 */
  venueOrderId?: string | null
  /** 这次动作之前该单在场所的单号（改单 / 替换链的上一位）。 */
  previousVenueOrderId?: string | null
  kind: 'submit' | 'amend' | 'cancel' | 'replace'
  ts: Ms
  /** 本地订单 id（同一条链上应始终是同一张逻辑单）。 */
  orderId?: string
}

export interface ReconcileInput {
  local: LocalView
  venue: VenueView
  links?: readonly AmendLink[]
}

/** 全部差异码。新增码必须同时在 advice.ts 给出建议，否则编译期就会报错。 */
export const FINDING_CODES = [
  // 订单
  'local_open_venue_filled',
  'local_open_venue_cancelled',
  'local_open_venue_rejected',
  'local_open_venue_partially_recorded',
  'local_open_venue_missing',
  'local_terminal_venue_open',
  'order_state_drift',
  'order_filled_size_drift',
  'order_price_drift',
  'order_reduce_only_drift',
  'order_unverified_within_latency',
  // 单号映射
  'amend_chain_resolved',
  'amend_chain_broken',
  'amend_chain_ambiguous',
  'venue_order_unmapped',
  'venue_order_external',
  'order_venue_id_conflict',
  // 成交
  'fill_duplicate',
  'fill_conflict',
  'fill_orphan',
  'fill_missing_inferred',
  'fill_missing_unexplained',
  'fill_dedupe_key_fallback',
  'fill_dedupe_key_cumulative',
  'fill_recorded_excess',
  'fill_total_exceeds_order',
  'ledger_fill_duplicate',
  'fill_time_anomaly',
  // 持仓
  'position_size_mismatch',
  'position_missing_at_venue',
  'position_missing_locally',
  'position_side_mismatch',
  'position_shape_mismatch',
  'position_margin_mode_mismatch',
  'position_entry_price_drift',
  // 视图质量
  'snapshot_stale',
  'venue_fills_truncated',
  'venue_report_unavailable',
] as const
export type FindingCode = (typeof FINDING_CODES)[number]

export type Severity = 'info' | 'warn' | 'blocker'

/** 建议动作。全部是「建议」，内核拿到后按人定的规则决定是否执行。 */
export const ACTION_KINDS = [
  'none',
  'ignore_duplicate',
  'wait_and_recheck',
  'query_order_status',
  'mark_cancelled',
  'mark_filled',
  'record_fill',
  'adopt_venue_state',
  'review_amend_chain',
  'review_external_order',
  'review_unmapped_order',
  'review_position',
  'review_ledger_fills',
  'halt_account_and_review',
  'fix_dedupe_key',
  'informational',
] as const
export type ActionKind = (typeof ACTION_KINDS)[number]

/** 证据指向：哪份报告、哪条记录、哪个字段、什么值。 */
export interface Evidence {
  report:
    | 'local.orders'
    | 'local.fills'
    | 'local.positions'
    | 'venue.openOrders'
    | 'venue.historyOrders'
    | 'venue.fills'
    | 'venue.positions'
    | 'links'
    | 'options'
  /** 记录标识（单号 / 成交号 / 标的），便于人回溯。 */
  id: string
  field: string
  value: string
}

export interface Advice {
  action: ActionKind
  why: string
  /** true = 本包不替人做决定，必须人工确认后才能改账。 */
  requiresHuman: boolean
}

export interface FindingSubject {
  accountId: string
  instrumentId?: string
  orderId?: string
  clientOrderId?: string
  venueOrderId?: string
  venueFillId?: string
}

export interface Finding {
  code: FindingCode
  severity: Severity
  subject: FindingSubject
  /** 一句话说明差在哪（中文，给人看）。 */
  detail: string
  advice: Advice
  evidence: Evidence[]
  /** 推断类结论必须标 true，并在 basis 写清依据。 */
  inferred?: true
  basis?: string[]
  tags?: string[]
}

/** 推断成交：场所成交量比账本多出来的那部分，按场所给的均价推出来的一条成交。 */
export interface InferredFill {
  /** 确定性 id：同一缺口重复对账得到同一个 id，内核可据此对已确认入账的推断成交去重。 */
  id: string
  venueOrderId: string
  clientOrderId?: string | null
  instrumentId: string
  side: Side
  size: string
  price: string
  ts: Ms
  inferred: true
  /** 推断依据（人话，一条一句）。 */
  basis: string[]
  evidence: Evidence[]
  /** 定价来源：场所均价 / 账本最后一笔成交价（后者可信度低一档）。 */
  priceSource: 'venue_avg_fill_price' | 'local_last_fill_price'
}

export type DedupeKeyKind = 'venue_fill_id' | 'fallback_composite' | 'cumulative_quantity'

export interface FillKeyUse {
  venueFillId: string
  key: string
  kind: DedupeKeyKind
  venueOrderId: string
  /** 回退键 / 累计量键的风险说明；主键（场所成交号）不填。 */
  risk?: string
}

export interface FillDedupeResult {
  /** 去重后接受的成交（每个键的第一条）。 */
  accepted: VenueFillView[]
  /** 完全一致的重复到达。 */
  duplicates: Array<{ key: string; count: number; fill: VenueFillView }>
  /** 同键不同内容（内核会按 fill_id_conflict 处理）。 */
  conflicts: Array<{ key: string; existing: VenueFillView; incoming: VenueFillView }>
  /** 每个成交所用的键与风险。 */
  keys: FillKeyUse[]
}

/** 单号映射解析结果（客户端单号 → 场所单号链 → 本地订单）。 */
export interface LinkResolution {
  clientOrderId: string
  orderId?: string
  /** 按时间排好的场所单号链（含账本记下的那个）。 */
  venueOrderIds: string[]
  /** 链上有多个本地订单抢同一单号，或链自身前后矛盾。 */
  ambiguous: boolean
  /** 链断：上一位单号在链里出现，却没有对应的下单记录。 */
  broken: boolean
  evidence: Evidence[]
}

export interface ReconcileCounts {
  findings: number
  blocker: number
  warn: number
  info: number
  needsHuman: number
  inferredFills: number
  duplicateFills: number
  conflictingFills: number
}

export interface ReconcileCoverage {
  localOrders: number
  localFills: number
  localPositions: number
  venueOpenOrders: number
  venueHistoryOrders: number
  venueFills: number
  venuePositions: number
  /** 场所视图新鲜度（now - venue.asOf）。 */
  venueAgeMs: number
  truncated: boolean
  unavailable: VenueReportKind[]
}

/** 对账结论：clean 无差异；attention 有 warn 或需要人工；blocked 有 blocker。 */
export type Verdict = 'clean' | 'attention' | 'blocked'

export interface ReconcileReport {
  accountId: string
  /** 生成时刻（只取 options.now，不读系统时钟，保证可复现）。 */
  generatedAt: Ms
  verdict: Verdict
  findings: Finding[]
  links: LinkResolution[]
  inferredFills: InferredFill[]
  dedupe: FillDedupeResult
  /** findings 里 advice.requiresHuman 的那些，按严重度排序。 */
  needsHuman: Finding[]
  counts: ReconcileCounts
  coverage: ReconcileCoverage
  /** 本轮用到的容差参数，原样回显，便于人核对结论的依据。 */
  options: Required<ReconcileOptions>
}

export interface ReconcileOptions {
  /** 生成报告的「现在」。必填，不读系统时钟。 */
  now: Ms
  /** 允许的时钟偏差（ms）：场所时间比本地快这么多也算正常。 */
  clockSkewMs?: number
  /** 场所回报延迟（ms）：在这个窗口内场所没看到本地挂单不算丢失。 */
  venueLatencyMs?: number
  /** 数量容差（基础资产单位），成交量 / 持仓量比较用。 */
  sizeTolerance?: string
  /** 持仓数量容差；缺省等于 sizeTolerance。 */
  positionTolerance?: string
  /** 均价漂移的容差（基点，1 bp = 0.01%）。 */
  priceToleranceBps?: number
  /** 成交回补窗口（ms）：早于 now - fillLookbackMs 的成交不参与缺口推断。 */
  fillLookbackMs?: number
  /** 视图超过这么久没更新就算不新鲜（ms）。 */
  staleAfterMs?: number
  /** 「我们的」客户端单号前缀；命中才是内部单，未命中按外部单处理。 */
  ownClientOrderIdPrefixes?: readonly string[]
  /** 场所成交号缺失时：接受回退键（带风险标注）还是直接交给人。 */
  dedupeFallback?: 'accept_with_risk' | 'needs_human'
}
