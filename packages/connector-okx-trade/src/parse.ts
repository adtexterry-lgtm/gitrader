// SPDX-License-Identifier: CPAL-1.0
// OKX 响应 → 统一模型。三块：
//   1) 标的 / 行情解析：**直接复用** `@gitrader/connector-okx-data`（那份为准，不复制）；
//      本文件只在它之上包一层「交易记录」：ctVal（contractSize）与张步长 lotContracts；
//   2) 订单状态映射：普通单 live / partially_filled / filled / canceled / mmp_canceled 与算法单
//      live / pause / canceled / order_failed / partially_failed → 协议状态集；
//   3) 私有流归一：orders / orders-algo 逐行一条事件，positions / account / login / error 各一条。
//      ctVal 未知时所有「币」字段为 null，绝不回落成张数。
import { asDecimal, normalizeDecimal } from '@gitrader/protocol'
import { mulDec, subDec } from '@gitrader/protocol/decimal'
import type { Decimal, Instrument, Ms, OrderStatus, OrderType, TimeInForce, TriggerPriceType } from '@gitrader/protocol'
import { parseInstruments } from '@gitrader/connector-okx-data'
import { divFloor, toFx } from './precision'

export const VENUE = 'okx'
/** OKX 公共 / 私有 REST 缺省基址（演示盘同主机，靠头区分）。 */
export const DEFAULT_BASE_URL = 'https://www.okx.com'
/** 本连接器能下的订单类型（capabilities 与标的口径同一份）。 */
export const SUPPORTED_ORDER_TYPES: OrderType[] = ['market', 'limit', 'stop_market', 'stop_limit', 'take_market', 'take_limit', 'trailing_stop']
export const SUPPORTED_TIF: TimeInForce[] = ['gtc', 'ioc', 'fok', 'alo']
/** OKX 触发单按标记价触发，没有 last / index 可选项。 */
export const SUPPORTED_TRIGGER_TYPES: TriggerPriceType[] = ['mark']
/** 交易连接器附加在标的上的可下类型（数据包里这些字段是空的）。 */
export const TRADING_ORDER_TYPES = SUPPORTED_ORDER_TYPES

export const instrumentIdOf = (symbol: string): string => `${VENUE}:${symbol}`

/** `okx:<instId>` → 场所原生 instId；不是本场所的 id 就拒绝（避免把别的场所符号发到 OKX）。 */
export function symbolOf(instrumentId: string): string {
  const i = instrumentId.indexOf(':')
  if (i <= 0 || i === instrumentId.length - 1 || instrumentId.slice(0, i) !== VENUE) {
    throw new RangeError(`not a ${VENUE} instrument id: ${JSON.stringify(instrumentId)}`)
  }
  return instrumentId.slice(i + 1)
}

/** 标的记录：协议 Instrument + 场所原生 instId + 每张对应的币数量（ctVal）。 */
export interface InstrumentRecord {
  instrument: Instrument
  symbol: string
  /** OKX 的 ctVal：一张 = 多少标的币。数据包把它放在 Instrument.contractSize。 */
  ctVal: Decimal
  /** 张的最小步长（= Instrument.size.step / ctVal，即上游 lotSz）。 */
  lotContracts: Decimal
  /** 最小张数（= Instrument.size.min / ctVal，即上游 minSz）。 */
  minContracts: Decimal
}

/** 协议 `Instrument` → 交易记录；ctVal 缺失或非正时返回 undefined（不猜，宁可拒单）。 */
export function recordOf(instrument: Instrument): InstrumentRecord | undefined {
  const ctVal = toFx(String(instrument.contractSize))
  if (ctVal === undefined) return undefined
  const lotContracts = divFloor(String(instrument.size.step), String(instrument.contractSize))
  const minContracts = divFloor(String(instrument.size.min), String(instrument.contractSize))
  return {
    instrument,
    symbol: instrument.symbol,
    ctVal: instrument.contractSize,
    lotContracts,
    minContracts,
  }
}

/**
 * /api/v5/public/instruments 的 data → 交易记录。**settleCcy 过滤在数据包里**：
 * 只收 `instType === 'SWAP'` 且 settleCcy 为 USDT / USDC 的线性合约（币本位 BTC-USD-SWAP 与交割合约一律跳过）。
 */
export function parseInstrumentRecords(raw: unknown, now: Ms): InstrumentRecord[] {
  return parseInstruments(raw, now).flatMap((instrument) => {
    const record = recordOf(instrument)
    return record ? [record] : []
  })
}

// ---- 订单状态 ---------------------------------------------------------------

/** OKX `state`（普通单）→ 协议状态集；认不出来返回 null（不猜）。 */
export const ORDER_STATE_MAP: Record<string, OrderStatus> = {
  live: 'open',
  partially_filled: 'partially_filled',
  filled: 'filled',
  canceled: 'cancelled',
  mmp_canceled: 'cancelled',
}

/** 算法单状态；effective / partially_effective 不映射（已触发，成交看子单 ordId）。 */
export const ALGO_STATE_MAP: Record<string, OrderStatus> = {
  live: 'untriggered',
  pause: 'untriggered',
  canceled: 'cancelled',
  order_failed: 'rejected',
  partially_failed: 'rejected',
}

const ADVANCED_ALGO_STATE_MAP: Record<string, OrderStatus> = {
  ...ALGO_STATE_MAP,
  effective: 'open',
  partially_effective: 'open',
}

export function mapOrderState(raw: unknown, channel: 'order' | 'algo' = 'order'): OrderStatus | null {
  if (typeof raw !== 'string') return null
  const table = channel === 'algo' ? ALGO_STATE_MAP : ORDER_STATE_MAP
  return table[raw] ?? null
}

/** 本轮响应里的状态是否仍算「挂在中（未终结）」。 */
export function isWorkingState(raw: unknown): boolean {
  return raw === 'live' || raw === 'partially_filled' || raw === 'partially_effective'
}

/** OKX ordType → 协议挂单类型（move_order_stop 在协议 VenueOpenOrder 里没有对应值，记 unknown）。 */
export function mapOpenOrderType(ordType: unknown): 'limit' | 'stop_market' | 'stop_limit' | 'take_market' | 'take_limit' | 'unknown' {
  switch (ordType) {
    case 'limit':
    case 'post_only':
    case 'fok':
    case 'ioc':
      return 'limit'
    case 'conditional':
      return 'stop_market'
    case 'trigger':
      return 'stop_market'
    case 'oco':
      return 'stop_market'
    default:
      return 'unknown'
  }
}

/** 宽松十进制文本 → Decimal；缺失 / 非法回落到 fallback（上游用空串表示「没有值」）。 */
export function decimalOf(v: unknown, fallback = '0'): Decimal {
  if (typeof v === 'string') {
    const s = v.trim()
    if (s !== '') {
      try {
        return normalizeDecimal(s)
      } catch {
        /* fall through */
      }
    }
  }
  if (typeof v === 'number' && Number.isFinite(v)) {
    try {
      return normalizeDecimal(String(v))
    } catch {
      /* fall through */
    }
  }
  return asDecimal(fallback)
}

export const num = (v: unknown): number => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN
  if (typeof v !== 'string') return NaN
  const s = v.trim()
  if (s === '') return NaN
  const n = Number(s)
  return Number.isFinite(n) ? n : NaN
}

/** 撤单候选：普通单给 ordId，算法单给 algoId；clOrdId 只是诊断用。 */
export interface PendingRef {
  instId: string
  venueOrderId: string
  clOrdId?: string
}

// ---- 私有流 ----------------------------------------------------------------

/** 订单事件：state 原样保留，status 是协议映射（认不出来为 null）。 */
export interface OkxOrderEvent {
  kind: 'order'
  channel: 'orders' | 'orders-algo'
  instrumentId: string
  venueOrderId: string
  clientOrderId: string | null
  /** 上游原话（live / filled / canceled / …）。 */
  state: string
  status: OrderStatus | null
  side: 'buy' | 'sell'
  posSide: 'net' | 'long' | 'short' | null
  /** 已成交张数与折成币的数量（ctVal 未知时币字段为 null）。 */
  filledContracts: Decimal
  filledBase: Decimal | null
  avgPrice: Decimal | null
  tradeId: string | null
  /** 本笔成交张数与折成币的数量。 */
  fillContracts: Decimal
  fillBase: Decimal | null
  fillPrice: Decimal | null
  /** 累计手续费（取反成「正 = 付出」）。 */
  fee: Decimal
  feeCcy: string | null
  /** 本笔手续费（取反）。 */
  fillFee: Decimal
  fillFeeCcy: string | null
  pnl: Decimal | null
  fillPnl: Decimal | null
  liquidity: 'maker' | 'taker' | null
  reduceOnly: boolean
  ts: Ms
  raw: unknown
}

export interface OkxAccountEvent {
  kind: 'account'
  channel: 'account' | 'positions' | 'balance_and_position'
  ts: Ms
  raw: unknown
}

export interface OkxErrorEvent { kind: 'error'; code: string; msg: string; raw: unknown }
export interface OkxLoginEvent { kind: 'login'; ok: boolean; raw: unknown }
export interface OkxSubscribedEvent { kind: 'subscribed'; channel: string; raw: unknown }
export interface OkxUnknownEvent { kind: 'unknown'; channel: string; raw: unknown }

export type OkxUserEvent =
  | OkxOrderEvent
  | OkxAccountEvent
  | OkxErrorEvent
  | OkxLoginEvent
  | OkxSubscribedEvent
  | OkxUnknownEvent

/**
 * OKX 私有 WS 的一帧 → 中性事件数组（payload 不是对象才 null）。
 *   · `{event:'login', success:true}` / `{event:'error', code, msg}` / `{event:'subscribe', arg:{channel}}`；
 *   · `{arg:{channel:'orders'|'orders-algo'}, data:[…]}` → 每行一条 order 事件（无 instId 的行跳过，可得 []）；
 *   · positions / account / balance_and_position → 一条 account 事件。
 */
export function normalizeUserEvents(payload: unknown, ctValOf?: (instId: string) => Decimal | undefined, now: Ms = Date.now()): OkxUserEvent[] | null {
  if (!payload || typeof payload !== 'object') return null
  const frame = payload as { event?: unknown; success?: unknown; code?: unknown; msg?: unknown; arg?: { channel?: unknown }; data?: unknown }
  if (typeof frame.event === 'string') {
    if (frame.event === 'login') {
      const ok = frame.code === undefined ? frame.success === true : String(frame.code) === '0'
      return [{ kind: 'login', ok, raw: payload }]
    }
    if (frame.event === 'error') {
      return [{
        kind: 'error',
        code: frame.code === undefined ? '' : String(frame.code),
        msg: typeof frame.msg === 'string' ? frame.msg : '',
        raw: payload,
      }]
    }
    if (frame.event === 'subscribe' || frame.event === 'unsubscribe') {
      return [{ kind: 'subscribed', channel: typeof frame.arg?.channel === 'string' ? frame.arg.channel : '', raw: payload }]
    }
  }
  const channel = typeof frame.arg?.channel === 'string' ? frame.arg.channel : ''
  const advancedChannel = channel === 'algo-advance' || channel === 'advance-algo-orders'
  if (channel === 'orders' || channel === 'orders-algo' || advancedChannel) {
    const rows = Array.isArray(frame.data) ? frame.data : []
    const out: OkxUserEvent[] = []
    for (const item of rows) {
      if (!item || typeof item !== 'object') continue
      const row = item as Record<string, unknown>
      const instId = typeof row.instId === 'string' ? row.instId : ''
      if (instId === '') continue
      const ctVal = ctValOf?.(instId)
      const filledContracts = decimalOf(row.accFillSz ?? '0')
      const fillContracts = decimalOf(row.fillSz ?? '0')
      const filledBase = ctVal === undefined ? null : mulDec(String(filledContracts), String(ctVal))
      const fillBase = ctVal === undefined ? null : mulDec(String(fillContracts), String(ctVal))
      const avg = num(row.avgPx ?? row.fillPx)
      const fillPx = num(row.fillPx)
      const posSideRaw = typeof row.posSide === 'string' ? row.posSide : ''
      const posSide = posSideRaw === 'long' || posSideRaw === 'short' || posSideRaw === 'net' ? posSideRaw : null
      const side = typeof row.side === 'string' && row.side.toLowerCase() === 'sell' ? 'sell' : 'buy'
      let ts = now
      const timestamps = advancedChannel
        ? [row.uTime, row.pTime, row.cTime]
        : [row.fillTime, row.uTime, row.cTime]
      for (const candidate of timestamps) {
        const parsed = num(candidate)
        if (Number.isFinite(parsed) && parsed > 0) {
          ts = parsed
          break
        }
      }
      const state = typeof row.state === 'string' ? row.state : ''
      const orderChannel = channel === 'orders' ? 'orders' : 'orders-algo'
      const clientOrderId = orderChannel === 'orders'
        ? (typeof row.clOrdId === 'string' && row.clOrdId !== '' ? row.clOrdId : null)
        : (typeof row.algoClOrdId === 'string' && row.algoClOrdId !== ''
          ? row.algoClOrdId
          : (typeof row.clOrdId === 'string' && row.clOrdId !== '' ? row.clOrdId : null))
      const execType = typeof row.execType === 'string' ? row.execType.toUpperCase() : ''
      out.push({
        kind: 'order',
        channel: orderChannel,
        instrumentId: instrumentIdOf(instId),
        venueOrderId: String(orderChannel === 'orders' ? (row.ordId ?? '') : (row.algoId ?? '')),
        clientOrderId,
        state,
        status: orderChannel === 'orders'
          ? mapOrderState(state, 'order')
          : advancedChannel ? (ADVANCED_ALGO_STATE_MAP[state] ?? null) : mapOrderState(state, 'algo'),
        side,
        posSide,
        filledContracts,
        filledBase,
        avgPrice: Number.isFinite(avg) && avg > 0 ? decimalOf(row.avgPx ?? row.fillPx) : null,
        tradeId: typeof row.tradeId === 'string' && row.tradeId !== '' ? row.tradeId : null,
        fillContracts,
        fillBase,
        fillPrice: Number.isFinite(fillPx) && fillPx > 0 ? decimalOf(row.fillPx) : null,
        fee: subDec('0', decimalOf(row.fee ?? '0')),
        feeCcy: typeof row.feeCcy === 'string' && row.feeCcy !== '' ? row.feeCcy : null,
        fillFee: subDec('0', decimalOf(row.fillFee ?? '0')),
        fillFeeCcy: typeof row.fillFeeCcy === 'string' && row.fillFeeCcy !== '' ? row.fillFeeCcy : null,
        pnl: row.pnl === undefined || row.pnl === '' ? null : decimalOf(row.pnl),
        fillPnl: row.fillPnl === undefined || row.fillPnl === '' ? null : decimalOf(row.fillPnl),
        liquidity: execType === 'M' ? 'maker' : execType === 'T' ? 'taker' : null,
        reduceOnly: row.reduceOnly === 'true'
          || (posSide === 'long' && side === 'sell')
          || (posSide === 'short' && side === 'buy'),
        ts: Number.isFinite(ts) && ts > 0 ? ts : now,
        raw: row,
      })
    }
    return out
  }
  if (channel === 'positions' || channel === 'account' || channel === 'balance_and_position') {
    const rows = Array.isArray(frame.data) ? frame.data : []
    const ts = rows.length > 0 && rows[0] && typeof rows[0] === 'object' ? num((rows[0] as { uTime?: unknown }).uTime) : NaN
    return [{ kind: 'account', channel, ts: Number.isFinite(ts) && ts > 0 ? ts : now, raw: payload }]
  }
  return [{ kind: 'unknown', channel, raw: payload }]
}

/** 文本帧 → 事件数组（JSON 解析失败返回 null，不抛）。 */
export function parseUserStreamMessage(
  text: string,
  ctValOf?: (instId: string) => Decimal | undefined,
  now = Date.now(),
): OkxUserEvent[] | null {
  try {
    return normalizeUserEvents(JSON.parse(text) as unknown, ctValOf, now)
  } catch {
    return null
  }
}
