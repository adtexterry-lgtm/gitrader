// SPDX-License-Identifier: CPAL-1.0
import type { Instrument, InstrumentId, OrderStatus, OrderType, Position, Side, VenueId } from '@gitrader/protocol'
import type { BookSnapshot, VenueConnector } from '@gitrader/protocol/connector'

/**
 * 模拟场所吃的行情：真实连接器（HyperliquidConnector）或回放夹具（ReplayMarket）都满足它。
 * 就是 VenueConnector 里「行情」那一半，所以主网 / 测试网连接器可以直接传进来。
 */
/** 本地 L2 快照：协议 v0.1.8 的 `BookSnapshot`（由行情源的 WS l2Book 订阅维护，带 asOf 与 stale）。保留导出名，旧引用不用改。 */
export type { BookSnapshot }

export type PaperMarket = Pick<
  VenueConnector,
  'venue' | 'environment' | 'describe' | 'listInstruments' | 'getInstrument' | 'quote' | 'book' | 'candles' | 'context' | 'subscribe' | 'status'
> &
  /** 可选（protocol v0.1.8 的连接器可选能力 bookSnapshot / refreshBook）：有它时模拟场所只读本地快照，快照缺失 / 陈旧才有界兜底刷新；没有（回放夹具）就直接 await book()。 */
  Partial<Pick<VenueConnector, 'bookSnapshot' | 'refreshBook'>>

export interface PaperVenueOptions {
  market: PaperMarket
  /** 诊断警告出口；消息固定且不包含订单或响应原文。默认 console.warn。 */
  onWarn?: (message: string) => void
  /** 时钟；回放时传回放时间。默认 Date.now。 */
  clock?: () => number
  /** 纸面行情最大可接受年龄，默认 5000 ms。 */
  markStaleMs?: number
  /** 标的没有 fees 时的兜底费率（十进制字符串分数）。 */
  fees?: { maker: string; taker: string }
  /** 下单没给杠杆、该标的也没设过杠杆时用的杠杆，默认 1（Demo 行为）。 */
  defaultLeverage?: number
}

export interface PaperAccountSpec {
  accountId: string
  /** 初始资金（十进制字符串）。 */
  initialBalance: string
  /** 计价币，默认 USDC。 */
  ccy?: string
}

/** 订单视图：数值一律十进制字符串。 */
export interface PaperOrderView {
  venueOrderId: string
  clientOrderId: string
  accountId: string
  instrumentId: InstrumentId
  side: Side
  type: OrderType
  tif: 'gtc' | 'ioc' | 'alo'
  size: string
  filledSize: string
  price: string | null
  triggerPrice: string | null
  avgFillPrice: string | null
  fee: string
  reduceOnly: boolean
  leverage: number
  status: Extract<OrderStatus, 'open' | 'untriggered' | 'partially_filled' | 'filled' | 'cancelled' | 'rejected'>
  role: 'parent' | 'tp' | 'sl'
  parentVenueOrderId?: string
  /** v0.1.3：归属的子仓位（来自 OrderIntent.legId，子单继承）。 */
  legId?: string
  /** 被撤 / 被拒时的原因（模拟场所自己的文案，前缀 kernel-sim:）。 */
  reason?: string
  createdAt: number
  updatedAt: number
  closedAt?: number
}

export type PaperEvent =
  | { kind: 'order'; accountId: string; order: PaperOrderView }
  | { kind: 'fill'; accountId: string; legId?: string; venueOrderId: string; clientOrderId: string; fillId: string; instrumentId: InstrumentId; side: Side; price: string; size: string; fee: string; liquidity: 'maker' | 'taker'; realizedPnl: string; liquidation: boolean; ts: number }
  | { kind: 'position'; accountId: string; instrumentId: InstrumentId; position: Position | null }
  | { kind: 'funding'; accountId: string; instrumentId: InstrumentId; ts: number; rate: string; intervalMs: number; positionSize: string; amount: string }
  | { kind: 'liquidation'; accountId: string; instrumentId: InstrumentId; size: string; price: string; ts: number }

export type { Instrument, VenueId }

/** fix-r2 S1：按账本重建纸面状态的输入（由内核从账本与订单表整理；十进制都是字符串）。 */
export interface PaperRebuildFacts {
  orderSeq: number
  fillSeq: number
  accounts: Array<{
    accountId: string
    initialBalance: string
    ccy?: string
    createdAt: number
    fills: Array<{ instrumentId: InstrumentId; side: Side; price: string; size: string; fee: string; leverage: number; ts: number }>
    funding: Array<{ instrumentId: InstrumentId; amount: string; ts: number }>
    openOrders: Array<{
      venueOrderId: string; clientOrderId: string; instrumentId: InstrumentId; side: Side
      type: PaperOrderView['type']; tif: 'gtc' | 'ioc' | 'alo'; size: string; filledSize: string; price: string | null; triggerPrice: string | null
      reduceOnly: boolean; leverage: number; role: 'parent' | 'tp' | 'sl'; parentVenueOrderId?: string; waitingParent: boolean
      status: 'open' | 'untriggered' | 'partially_filled'; createdAt: number
    }>
  }>
}
