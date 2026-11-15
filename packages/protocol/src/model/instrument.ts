// SPDX-License-Identifier: Apache-2.0
// 契约 §1.4.4 Instrument、§1.5 能力声明、§7.3 行情类实体（行情类允许 JSON number）。
import type { Decimal, Ms } from './decimal'
import type { InstrumentId, VenueId } from './ids'

export const INSTRUMENT_KINDS = ['perp', 'spot', 'future', 'option', 'outcome'] as const
export type InstrumentKind = (typeof INSTRUMENT_KINDS)[number]

export const ASSET_CLASSES = ['crypto', 'stocks', 'indices', 'sectors', 'metals', 'commodities', 'fx', 'rates', 'private'] as const
export type AssetClass = (typeof ASSET_CLASSES)[number]

export const ORDER_TYPES = ['market', 'limit', 'stop_market', 'stop_limit', 'take_market', 'take_limit', 'trailing_stop', 'twap'] as const
export type OrderType = (typeof ORDER_TYPES)[number]

export const TIME_IN_FORCE = ['gtc', 'ioc', 'fok', 'alo', 'gtd'] as const
export type TimeInForce = (typeof TIME_IN_FORCE)[number]

export const TRIGGER_PRICE_TYPES = ['mark', 'last', 'index'] as const
export type TriggerPriceType = (typeof TRIGGER_PRICE_TYPES)[number]

export const MARGIN_MODES = ['cross', 'isolated', 'strictIsolated', 'noCross'] as const
export type MarginMode = (typeof MARGIN_MODES)[number]

export const INSTRUMENT_STATUSES = ['trading', 'reduce_only', 'halted', 'delisted'] as const
export type InstrumentStatus = (typeof INSTRUMENT_STATUSES)[number]

export interface InstrumentPriceRule {
  /** CEX 给 tick。 */
  tick?: Decimal
  /** HL 给 sigFigs: 5 + maxDecimals。 */
  sigFigs?: number
  maxDecimals?: number
}

export interface InstrumentSizeRule {
  step: Decimal
  decimals: number
  min: Decimal
}

export const SESSION_QUALITIES = ['regular', 'thin', 'closed'] as const
export type SessionQuality = (typeof SESSION_QUALITIES)[number]

/** v0.1.3：交易时段窗口。days 用 0–6（周日 = 0）；from / to 为 "HH:mm"（按 tz）。 */
export interface TradingSessionWindow {
  days: number[]
  from: string
  to: string
  quality: SessionQuality
  /** 该时段典型点差（基点）；缺省取 Instrument.typicalSpreadBps。 */
  typicalSpreadBps?: number
}

export interface Instrument {
  instrumentId: InstrumentId
  venue: VenueId
  /** 场所原生符号。 */
  symbol: string
  displaySymbol: string
  kind: InstrumentKind
  base: string
  quote: string
  settle: string
  /** M0 只承诺 linear。 */
  settlement: 'linear' | 'inverse'
  contractSize: Decimal
  venueSizeUnit: 'base' | 'contract'
  assetClass: AssetClass
  /** 场所内的子市场（HL 构建者 dex 名）。 */
  marketGroup?: string | null
  underlying?: { description: string; synthetic: boolean }
  status: InstrumentStatus
  price: InstrumentPriceRule
  size: InstrumentSizeRule
  minNotional?: Decimal
  maxLeverage?: number
  marginModes?: MarginMode[]
  orderTypes: OrderType[]
  tif: TimeInForce[]
  triggerPriceTypes: TriggerPriceType[]
  /** 永续必填。 */
  fundingIntervalMs?: Ms
  fees?: { maker: Decimal; taker: Decimal; source: 'venue' | 'tier' | 'assumed' }
  /** v0.1.3：交易时段（黄金等非加密标的的休市 / 薄流动性时段）。缺省 = 全天常规。 */
  sessions?: { tz: string; windows: TradingSessionWindow[] }
  /** v0.1.3：典型点差（基点），按时段可被窗口里的值覆盖。 */
  typicalSpreadBps?: number
  updatedAt: Ms
}

// ---- §1.5.1 VenueCapabilities ------------------------------------------------

export type SupportLevel = 'native' | 'emulated' | 'none'

export interface VenueCapabilities {
  /** 场所 id。契约 §1.5.1 的键表没有这一项，但 `host.describe.venues[]` 需要它来区分各场所：A 追加（见 CHANGELOG）。 */
  venue: VenueId
  environments: ('mainnet' | 'testnet')[]
  instrumentKinds: InstrumentKind[]
  /** 各订单类型的支持方式。 */
  orderTypes: Partial<Record<OrderType, SupportLevel>>
  /** 场所静态规则声明；当前账户动态值由 AccountSnapshot.rules 提供。 */
  rules?: { maxOpenOrders?: { cap: number }; marketPriceBandBps?: number; minOrderNotional?: Decimal }
  /** 市价单是模拟时的实现方式，例如 HL：{method: 'ioc_limit'}。 */
  marketEmulation?: { method: string }
  tif: TimeInForce[]
  triggerPriceTypes: TriggerPriceType[]
  tpsl?: { attachToOrder: boolean; positionLevel: boolean; parentPartialCancel: 'cancel_children' | 'keep_children' | string }
  batch?: { maxOrders: number | null; atomic: boolean }
  amend?: SupportLevel
  cancelAll?: SupportLevel
  deadman?: { method: string; minDelaySec: number; maxTriggersPerDay: number }
  positionMode?: ('oneWay' | 'hedge')[]
  marginModes?: MarginMode[]
  accountModels?: string[]
  signers?: {
    type: 'api-wallet' | 'api-key' | string
    perAccount?: { unnamed: number; named: number }
    perSubaccountNamed?: number
    maxValidityDays?: number
    withdrawCapable: boolean
    noncePerSigner?: boolean
  }
  rateLimits?: { scope: string; model: 'weight' | 'volume' | 'count' | string; limit?: number; windowMs?: Ms; note?: string }[]
  wsLimits?: { maxConnections?: number; newPerMinute?: number; maxSubscriptions?: number; maxDistinctUsersInUserSubs?: number }
  clientOrderId?: { format: 'hex128' | string }
  builderFee?: {
    supported: boolean
    perpMaxTenthBps?: number
    spotMaxTenthBps?: number
    spotChargedSide?: 'buy' | 'sell'
    maxApprovalsPerUser?: number
    collectorAccountModel?: string
    collectorMinValue?: Decimal
  }
  history?: { maxCandles: number; pageLimit: number }
  withdrawPermissionCheck?: 'not_applicable' | 'supported' | 'unknown'
  /**
   * v0.1.8：本地 L2 快照能力（连接器实现可选方法 bookSnapshot / refreshBook）。snapshot = 有同步的本地快照；
   * refresh = 另有限频兜底刷新；staleAfterMs = 距上次更新超过多久算 stale（供使用方预估）。
   */
  bookSnapshot?: { snapshot: boolean; refresh: boolean; staleAfterMs?: number }
  /** `x-` 前缀的扩展键只用于展示与诊断，不得改变语义。 */
  [extension: `x-${string}`]: unknown
}

// ---- §1.5.3 模拟场所声明 ------------------------------------------------------

export interface SimVenueDeclaration {
  connector: 'kernel-sim'
  modes: ('paper' | 'shadow')[]
  mirrors: VenueId[]
  fillModel: {
    market: string
    bookShortfall: string
    noBook: string
    limit: string
    queuePosition: boolean
    latencyMs: number
    funding: string
    liquidation: string
    positionMode: string
    marginMode: string
  }
  knownGaps: string[]
}

// ---- 行情类（允许 number；§7.3） ----------------------------------------------

export const CANDLE_INTERVALS = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '8h', '12h', '1d', '3d', '1w', '1M'] as const
export type CandleInterval = (typeof CANDLE_INTERVALS)[number]

/** `{t,o,h,l,c,v}`，t = K 线开盘时间（毫秒）。 */
export interface Candle {
  t: Ms; o: number; h: number; l: number; c: number; v: number
  /** 成交量加权均价，仅场所提供时填写。 */
  vwap?: number
}
/** 资金费率历史点；rate / premium 为十进制比例字符串，t 为整数毫秒。 */
export interface FundingRatePoint { instrumentId: InstrumentId; t: Ms; rate: Decimal; premium?: Decimal }

export interface BookLevel { price: number; size: number; count?: number }
export interface Book { instrumentId: InstrumentId; ts: Ms; bids: BookLevel[]; asks: BookLevel[] }
/** 契约只给了 channel 名 `quote`，没给字段表：A 按最小必要集定义（见 OPEN-QUESTIONS）。 */
export interface Quote { instrumentId: InstrumentId; ts: Ms; bid: number; ask: number; last?: number }
export interface Trade { instrumentId: InstrumentId; ts: Ms; price: number; size: number; side: 'buy' | 'sell' }

export interface MarketContext {
  instrumentId: InstrumentId
  ts: Ms
  markPrice: number
  oraclePrice?: number
  midPrice?: number
  fundingRate?: number
  fundingIntervalMs?: Ms
  openInterest?: number
  dayNotionalVolume?: number
  prevDayPrice?: number
}

export interface VenueStatus {
  venue: VenueId
  environment: 'mainnet' | 'testnet'
  ts: Ms
  wsState: 'connected' | 'connecting' | 'disconnected'
  latencyMs?: { p50: number; p95: number }
  rateBudget?: { used: number; limit: number; windowMs: Ms }
}
