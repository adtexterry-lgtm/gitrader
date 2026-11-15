// SPDX-License-Identifier: Apache-2.0
// 连接器接口（行情 / 账户 / 交易 / 能力声明 / 速率预算 / 死人开关）。第一方连接器与模拟场所都实现它。
// 契约 §3.6 只给了 GSP 的 connector.* 方法名（submit / cancel / amend / status / account / stream）；
// 本接口是进程内形状，底稿来自 C 的实现，GSP 传输只是把这些方法搬到 JSON-RPC 上（内核 → 连接器单向调用，连接器不能主动下单）。
import type { Ms } from '../model/decimal'
import type { ClientOrderId, InstrumentId, VenueId } from '../model/ids'
import type { Book, Candle, CandleInterval, Instrument, MarketContext, VenueCapabilities } from '../model/instrument'
import type { OrderIntent } from '../model/order'
import type { AccountSnapshot, StartupSnapshot, VenueOpenOrder, VenueOrderStatus } from './account'
import type { BookSnapshot, MarketStatus, RefreshBookOptions, StampedQuote, SubscriptionSpec, Unsubscribe, VenueEvent } from './market'
import type { Environment } from './signer'
import type { AccountRef, AmendRequest, CancelAck, CancelTarget, SubmitResult, TradeContext, VenueFill } from './trade'

/** 场所级死人开关的滚动刷新句柄。 */
export interface DeadmanHandle {
  stop(): Promise<void>
  stats(): { armedAt: Ms; refreshes: number; lastError: string | null; lastScheduledAt: Ms | null }
}

export interface VenueConnector {
  readonly venue: VenueId
  readonly environment: Environment
  describe(): VenueCapabilities

  // 行情
  listInstruments(opts?: { includeDelisted?: boolean }): Instrument[]
  getInstrument(id: InstrumentId): Instrument | undefined
  quote(id: InstrumentId): StampedQuote | undefined
  book(id: InstrumentId, depth?: number): Promise<Book>
  candles(id: InstrumentId, interval: CandleInterval, opts?: { n?: number; from?: Ms; to?: Ms }): Promise<Candle[]>
  context(id: InstrumentId): Promise<MarketContext>
  subscribe(spec: SubscriptionSpec, cb: (e: VenueEvent) => void): Unsubscribe
  status(): MarketStatus

  /**
   * 可选能力 `bookSnapshot`（v0.1.8；在 VenueCapabilities.bookSnapshot 里声明）：本地 L2 快照，同步、不联网。
   * 没有快照返回 undefined。模拟场所有它就零 REST 撮合；没有（回放夹具）就退回 await book()。
   */
  bookSnapshot?(id: InstrumentId): BookSnapshot | undefined
  /**
   * 可选能力 `bookSnapshot.refresh`：快照缺失 / 陈旧时的有界、限频兜底刷新（同一标的有最小间隔，最长等待 maxWaitMs）。
   * 失败或被限频时原样返回现有快照（可能 stale 或 undefined），由调用方决定拒绝；不抛错、不阻塞排队。
   */
  refreshBook?(id: InstrumentId, opts?: RefreshBookOptions): Promise<BookSnapshot | undefined>

  // 账户（只读）
  accountState(ref: AccountRef): Promise<AccountSnapshot>
  openOrders(ref: AccountRef): Promise<VenueOpenOrder[]>
  fills(ref: AccountRef, sinceMs: Ms, opts?: { instrumentId?: InstrumentId }): Promise<VenueFill[]>
  orderStatus(ref: AccountRef, key: { clientOrderId?: ClientOrderId; venueOrderId?: string; instrumentId?: InstrumentId }): Promise<VenueOrderStatus>
  startupSnapshot(ref: AccountRef, fillsSinceMs: Ms): Promise<StartupSnapshot>

  // 交易（内核发起；连接器自己不会下单）
  submit(ctx: TradeContext, intents: OrderIntent[]): Promise<SubmitResult>
  cancel(ctx: TradeContext, targets: CancelTarget[]): Promise<CancelAck[]>
  cancelAll(ctx: TradeContext, instrumentId?: InstrumentId): Promise<CancelAck[]>
  amend(ctx: TradeContext, req: AmendRequest): Promise<SubmitResult>
  setLeverage(ctx: TradeContext, instrumentId: InstrumentId, leverage: number, marginMode: 'cross' | 'isolated'): Promise<void>
  /** 场所级死人开关（HL：scheduleCancel，须在 5 s 之后、每天最多触发 10 次）；atMs = null 清除。 */
  scheduleCancel(ctx: TradeContext, atMs: Ms | null): Promise<void>

  /** 滚动刷新场所级死人开关：到点全撤，持仓不动。内核进程死亡 → 场所在 delaySec 内撤掉全部挂单。 */
  armDeadman?(ctx: TradeContext, opts?: { delaySec?: number; onError?: (e: Error) => void }): DeadmanHandle

  close(): Promise<void>
}

/** v0.1.8：场所 / 连接器是否声明了本地 L2 快照（bookSnapshot）与限频兜底刷新（bookSnapshot.refresh）。 */
export function supportsBookSnapshot(caps: VenueCapabilities): { snapshot: boolean; refresh: boolean } {
  const b = caps.bookSnapshot
  return { snapshot: b?.snapshot === true, refresh: b?.snapshot === true && b.refresh === true }
}

/** scheduleCancel 能力位：场所在 VenueCapabilities.deadman 里声明（method 为 schedule_cancel）。 */
export function supportsScheduleCancel(caps: VenueCapabilities): boolean {
  return caps.deadman?.method === 'schedule_cancel'
}
