// SPDX-License-Identifier: Apache-2.0
// 契约 §2.5 事件流：信封、流表、规则。
import type { Ms } from '../model/decimal'
import type { AccountId, InstrumentId } from '../model/ids'
import type { Candle } from '../model/instrument'
import type { Causation, Origin } from '../model/origin'

export type StreamLoss = 'lossless' | 'conflatable' | 'lossy'
export type StreamDirection = 'both' | 'host_to_engine' | 'engine_to_host'

export interface StreamInfo { stream: string; direction: StreamDirection; loss: StreamLoss; note: string }

export const GEP_STREAMS = [
  { stream: 'order', direction: 'both', loss: 'lossless', note: '模式 A：宿主 → 引擎；模式 B：引擎 → 宿主' },
  { stream: 'fill', direction: 'both', loss: 'lossless', note: '成交' },
  { stream: 'position', direction: 'both', loss: 'lossless', note: 'position.opened / changed / closed' },
  { stream: 'funding', direction: 'both', loss: 'lossless', note: '资金费' },
  { stream: 'account', direction: 'both', loss: 'conflatable', note: '余额 / 保证金快照（保留最新）' },
  { stream: 'strategy', direction: 'engine_to_host', loss: 'lossless', note: '实例启停与错误' },
  { stream: 'signal', direction: 'engine_to_host', loss: 'lossless', note: '§1.4.11' },
  { stream: 'decision', direction: 'engine_to_host', loss: 'lossless', note: '§5.8' },
  { stream: 'backtest', direction: 'engine_to_host', loss: 'conflatable', note: '进度' },
  { stream: 'takeover', direction: 'host_to_engine', loss: 'lossless', note: '接管指令与状态' },
  { stream: 'policy', direction: 'host_to_engine', loss: 'lossless', note: '风控版本' },
  { stream: 'health', direction: 'engine_to_host', loss: 'conflatable', note: '指标' },
  { stream: 'log', direction: 'engine_to_host', loss: 'lossy', note: '已脱敏日志（带丢弃计数）' },
  { stream: 'market', direction: 'host_to_engine', loss: 'conflatable', note: '行情（用工作台行情时）' },
] as const satisfies readonly StreamInfo[]

export type GepStream = (typeof GEP_STREAMS)[number]['stream']
export const GEP_STREAM_NAMES = GEP_STREAMS.map((s) => s.stream) as readonly GepStream[]

export const ORDER_EVENT_TYPES = [
  'order.created', 'order.denied', 'order.submitted', 'order.accepted', 'order.rejected', 'order.untriggered',
  'order.triggered', 'order.amended', 'order.cancelled', 'order.expired', 'order.filled',
] as const
export type OrderEventType = (typeof ORDER_EVENT_TYPES)[number]
export const POSITION_EVENT_TYPES = ['position.opened', 'position.changed', 'position.closed'] as const
export type PositionEventType = (typeof POSITION_EVENT_TYPES)[number]

export interface GepEvent {
  /** 每个会话一个全局单调递增的 seq（跨流）。 */
  seq: number
  /** 全局唯一，用于去重。 */
  eventId: string
  stream: GepStream
  /** 类型名第一段必须等于 stream（`order.accepted`、`fill`、`strategy.started` …）。 */
  type: string
  /** 事件时间（毫秒）。 */
  ts: Ms
  /** 接收方另记的接收时间。 */
  recvTs?: Ms
  /** 纳秒级引擎可附。 */
  tsNs?: string
  accountId?: AccountId
  instrumentId?: InstrumentId
  data: Record<string, unknown>
  origin?: Origin
  causation?: Causation
  /** 可合并流被合并时带的合并条数。 */
  conflated?: number
}

/**
 * v0.1.5：宿主 -> 引擎的 `market` 流事件形状。事件信封上的 `instrumentId` 必填（标的在信封上，不在 data 里）。
 *   type = market.candle   data = { interval, candle, closed? }     单根 K 线；closed = true 表示这一根已收盘（引擎只在收盘时评估）
 *   type = market.candles  data = { interval, candles: Candle[], closed? }   批量历史 / 补发
 * 同一根形成中 K 线的更新（closed 缺省或 false）只更新、不触发评估。
 */
export interface MarketCandleData { interval: string; candle: Candle; closed?: boolean }
export interface MarketCandlesData { interval: string; candles: Candle[]; closed?: boolean }
export const MARKET_EVENT_TYPES = ['market.candle', 'market.candles'] as const
export type MarketEventType = (typeof MARKET_EVENT_TYPES)[number]

export interface EventsPushParams { sessionId: string; events: GepEvent[] }
/**
 * v0.1.5：事件确认的方法名统一为 `host.events.ack`（通知，参数 `{upToSeq}`），两个方向都用它：
 * 引擎确认宿主事件、宿主确认引擎事件，发的都是 `host.events.ack`。
 * 契约 §2.4 里引擎一侧的 `events.ack` 保留为已弃用别名：引擎与宿主都必须继续接受，但不应再发。
 */
export interface EventsAckParams { upToSeq: number }
export const EVENTS_ACK_METHOD = 'host.events.ack'
/** 已弃用别名 -> 规范名。 */
export const GEP_DEPRECATED_METHOD_ALIASES: Readonly<Record<string, string>> = { 'events.ack': 'host.events.ack' }
export interface HeartbeatParams { ts?: Ms; seq?: number }
export interface OverflowParams { stream?: GepStream; dropped?: number; ts?: Ms }

/** 事件类型的第一段（`order.accepted` → `order`）。 */
export function streamOfType(type: string): string {
  const i = type.indexOf('.')
  return i < 0 ? type : type.slice(0, i)
}

/** 该流是否无损（无损流永不丢弃，缓冲溢出必须发 gep.overflow）。 */
export function isLosslessStream(stream: GepStream): boolean {
  return GEP_STREAMS.find((s) => s.stream === stream)?.loss === 'lossless'
}

/** 检查事件序列：seq 严格递增且无重复、eventId 无重复、type 与 stream 一致。返回问题列表（空 = 通过）。 */
export function checkEventSequence(events: readonly GepEvent[], prevSeq = 0): string[] {
  const problems: string[] = []
  let last = prevSeq
  const seen = new Set<string>()
  for (const e of events) {
    if (!(e.seq > last)) problems.push(`seq ${e.seq} not strictly greater than ${last}`)
    last = Math.max(last, e.seq)
    if (seen.has(e.eventId)) problems.push(`duplicate eventId ${e.eventId}`)
    seen.add(e.eventId)
    if (streamOfType(e.type) !== e.stream) problems.push(`event ${e.eventId}: type ${e.type} does not belong to stream ${e.stream}`)
  }
  return problems
}
