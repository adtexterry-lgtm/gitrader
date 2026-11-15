// SPDX-License-Identifier: Apache-2.0
// 连接器接口 · 行情订阅与场所状态。
import type { Decimal, Ms } from '../model/decimal'
import type { ClientOrderId, InstrumentId } from '../model/ids'
import type { Book, Candle, CandleInterval, MarketContext, Quote, VenueStatus } from '../model/instrument'
import type { Hex } from './signer'
import type { VenueFill } from './trade'

export type Unsubscribe = () => void

export type SubscriptionSpec =
  | { channel: 'mids' }
  | { channel: 'quote'; instrumentId: InstrumentId }
  | { channel: 'book'; instrumentId: InstrumentId }
  | { channel: 'candle'; instrumentId: InstrumentId; interval: CandleInterval }
  | { channel: 'context'; instrumentId: InstrumentId }
  | { channel: 'userFills'; address: Hex }
  | { channel: 'orderUpdates'; address: Hex }
  | { channel: 'instruments' }

/**
 * v0.1.8：本地 L2 快照（可选能力 bookSnapshot）。由行情源的 WS l2Book 订阅维护，同步读取、不联网；
 * asOf = 最后一次更新的时刻，stale = 距上次更新已超过行情源的陈旧阈值（调用方，比如模拟场所，遇到 stale 应拒绝撮合而不是用旧盘口成交）。
 */
export interface BookSnapshot { book: Book; asOf: Ms; stale: boolean }

/** refreshBook 的选项：最长等待（缺省 1000 ms）；预算不够就放弃，不排队阻塞。 */
export interface RefreshBookOptions { maxWaitMs?: number }

export type StampedQuote = Quote & { stale: boolean; ageMs: number }

export interface MarkPrice {
  price: Decimal
  ts: Ms
  source?: 'venue_mark' | 'last' | 'mid'
}

export type VenueEvent =
  | { channel: 'mids'; mids: Record<InstrumentId, number>; ts: Ms }
  | { channel: 'quote'; quote: StampedQuote }
  | { channel: 'book'; book: Book }
  | { channel: 'candle'; instrumentId: InstrumentId; interval: CandleInterval; candle: Candle }
  | { channel: 'context'; context: MarketContext }
  | { channel: 'userFills'; address: Hex; fills: VenueFill[]; isSnapshot: boolean }
  /** 追加字段缺失表示未提供，不代表 0。 */
  | { channel: 'orderUpdates'; address: Hex; updates: Array<{
    venueOrderId: string; clientOrderId: ClientOrderId | null; instrumentId: InstrumentId; status: string; ts: Ms
    side?: 'buy' | 'sell'; size?: Decimal; origSize?: Decimal; price?: Decimal; triggerPrice?: Decimal
    isTrigger?: boolean; reduceOnly?: boolean; createdAt?: Ms
  }> }
  | { channel: 'instruments'; added: InstrumentId[]; removed: InstrumentId[] }

export interface MarketStatus extends VenueStatus {
  /** 距上一条行情消息已超过陈旧阈值。 */
  stale: boolean
  source: 'ws' | 'rest' | 'none'
  lastMessageTs: number
}

/** 录制器接口：历史 K 线逐页回调，落盘由外部实现（fixtures 录制脚本、回测数据仓）。 */
export interface CandleRecorder {
  record(instrumentId: InstrumentId, interval: CandleInterval, candles: Candle[]): void | Promise<void>
}
