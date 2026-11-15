// SPDX-License-Identifier: CPAL-1.0
// Bitget v2 mix 响应 → 协议模型（纯函数，无状态；不发请求、不读环境）。
// 行情 / 合约元数据解析 **Copied from packages/connector-bitget-data/src/parse.ts** (CPAL-1.0)，以数据包为准；
// 本文件补交易连接器需要的部分：订单状态映射、持仓 / 余额 / 挂单 / 成交 / 订单详情、私有流归一。
// 口径来源：QD backend_api_python/app/services/live_trading/bitget.py（详情 :919-995、成交 :939-963、持仓 :639-666）、
// 账户快照 :633-637、挂单 :open_orders.py:63-70,110-125（data.entrustedList + endId）、
// 私有流 :execution_streams/normalizers.py:185-249、手续费 :bitget_fees.py。
import { asDecimal, makeProblem, normalizeDecimal } from '@gitrader/protocol'
import { addDec, div, fx, mulDec, str, subDec } from '@gitrader/protocol/decimal'
import type {
  Balance, Decimal, Instrument, MarginSnapshot, Ms, Position, Problem, ProblemName,
} from '@gitrader/protocol'
import type { AccountId } from '@gitrader/protocol'
import type { VenueFill, VenueOpenOrder, VenueOrderStatus } from '@gitrader/protocol/connector'
import {
  instrumentIdOf as dataInstrumentIdOf, num, parseInstrument as parseDataInstrument, symbolOf as dataSymbolOf,
} from '@gitrader/connector-bitget-data'
import type { RawContract } from '@gitrader/connector-bitget-data'
import { feeOfFill, feeStorage } from './fees'
import { ProblemError } from './errors'

export { ProblemError }

export { CANDLE_PAGE, DEFAULT_BASE_URL, FUNDING_INTERVAL_MS, MAX_CANDLES, PRODUCT_TYPE, VENUE } from '@gitrader/connector-bitget-data'
export const MARGIN_COIN = 'USDT'
export const instrumentIdOf = dataInstrumentIdOf
export const symbolOf = dataSymbolOf
export const numOf = num

/** 交易连接器支持的订单类型 / 时效 / 触发价类型（标的层面声明，能力声明见 capabilities.ts）。 */
export const SUPPORTED_ORDER_TYPES = ['market', 'limit', 'stop_market', 'stop_limit', 'take_market', 'take_limit', 'trailing_stop'] as const
/** `alo` = post-only（Bitget 的 `force: post_only`；协议没有 post_only 枚举，统一按 alo 表达）。 */
export const SUPPORTED_TIF = ['gtc', 'ioc', 'fok', 'alo'] as const
export const SUPPORTED_TRIGGER_TYPES = ['mark'] as const
/** 触发单 / 追踪单走计划委托端点（QD bitget.py:41-50 的渠道码表也把 place-plan-order 列为下单端点）。 */
export const PLAN_ORDER_TYPES = ['stop_market', 'stop_limit', 'take_market', 'take_limit', 'trailing_stop'] as const

/** 带 Problem 的错误（包内单一实现，定义在 errors.ts）：内核按 problem.name / retryable 决定是否重试。 */
export function problemError(name: ProblemName, message: string, extra: Partial<Problem> = {}): ProblemError {
  return new ProblemError(makeProblem(name, message, extra))
}

/** 上游信封：`code === '00000'` 才是成功（QD bitget.py:251-258）。 */
export interface BitgetEnvelope<T> {
  code?: string
  msg?: string
  requestTime?: number | string
  data?: T
}

// ---- 数值 -------------------------------------------------------------------

/** 宽松十进制文本 → 规范形；缺失 / 非法回落 '0'（对账不因一个坏字段整体失败，与数据包 num 同思路）。 */
export function decimalOf(value: unknown): Decimal {
  if (typeof value === 'number') return Number.isFinite(value) ? normalizeDecimal(String(value)) : asDecimal('0')
  if (typeof value !== 'string') return asDecimal('0')
  const text = value.trim()
  if (text === '') return asDecimal('0')
  try {
    return normalizeDecimal(text)
  } catch {
    return asDecimal('0')
  }
}

/** 有符号十进制：负数保留符号（持仓 / 现金流需要）。 */
export function signedDecimalOf(value: unknown): Decimal {
  return decimalOf(value)
}

const absDec = (d: Decimal): Decimal => (d.startsWith('-') ? asDecimal(d.slice(1)) : d)
export { absDec }

// ---- 合约元数据 --------------------------------------------------------------

/** 交易连接器用的标的记录：协议 Instrument + 下单需要的精度与下限（tick / step 已是十进制字符串）。 */
export interface InstrumentRecord {
  instrument: Instrument
  symbol: string
  tick: Decimal
  step: Decimal
  minSize: Decimal
  minNotional?: Decimal
  maxLeverage?: number
  priceDecimals: number
  sizeDecimals: number
  contractSize: Decimal
}

function decimalsOfText(d: string): number {
  const i = d.indexOf('.')
  return i < 0 ? 0 : d.length - i - 1
}

/** 一条合约 → 记录。精度口径完全沿用数据包（pricePlace / priceEndStep / volumePlace），不重复推导。 */
export function parseInstrumentRecord(c: RawContract, now: Ms): InstrumentRecord | undefined {
  const instrument = parseDataInstrument(c, now)
  if (!instrument) return undefined
  return recordFromInstrument(instrument, c as unknown as Record<string, unknown>)
}

/** 已有协议 Instrument（例如数据包 listInstruments() 的产物）→ 交易记录；raw 只用来取 contractSize。 */
export function recordFromInstrument(instrument: Instrument, raw?: Record<string, unknown>): InstrumentRecord {
  // 数据连接器不下单，标的层面不声明可下单类型；交易连接器补上（能力声明另在 capabilities.ts）。
  const enriched: Instrument = {
    ...instrument,
    orderTypes: [...SUPPORTED_ORDER_TYPES],
    tif: [...SUPPORTED_TIF],
    triggerPriceTypes: [...SUPPORTED_TRIGGER_TYPES],
  }
  const tick = enriched.price.tick ?? asDecimal('0.00000001')
  const step = enriched.size.step
  const contractSize = decimalOf(raw?.['contractSize'] ?? raw?.['ctVal'] ?? '1')
  const minNotional = enriched.minNotional
  return {
    instrument: enriched,
    symbol: enriched.symbol,
    tick,
    step,
    minSize: enriched.size.min,
    ...(minNotional !== undefined ? { minNotional } : {}),
    ...(enriched.maxLeverage !== undefined ? { maxLeverage: enriched.maxLeverage } : {}),
    priceDecimals: enriched.price.maxDecimals ?? decimalsOfText(tick),
    sizeDecimals: enriched.size.decimals,
    contractSize: contractSize === '0' ? asDecimal('1') : contractSize,
  }
}

/** contracts 的 data 数组 → 记录（非 normal 的在数据包解析层已被剔除）。 */
export function parseInstrumentRecords(raw: unknown, now: Ms): InstrumentRecord[] {
  if (!Array.isArray(raw)) return []
  const out: InstrumentRecord[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const record = parseInstrumentRecord(entry as RawContract, now)
    if (record) out.push(record)
  }
  return out.sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0))
}

// ---- 订单状态 ----------------------------------------------------------------

export type MappedStatus = 'open' | 'partially_filled' | 'filled' | 'cancelled' | 'expired' | 'rejected' | 'untriggered'

/** 原生状态 → 内部状态集。键一律小写；不认识的返回 null（调用方按「未知」处理，不猜成 open）。 */
export const ORDER_STATUS_MAP: Record<string, MappedStatus> = {
  live: 'open',
  new: 'open',
  partially_filled: 'partially_filled',
  partial_filled: 'partially_filled',
  filled: 'filled',
  executed: 'filled',
  canceled: 'cancelled',
  cancelled: 'cancelled',
  cancel: 'cancelled',
  expired: 'expired',
  fail_execute: 'rejected',
  failed: 'rejected',
  rejected: 'rejected',
  not_triggered: 'untriggered',
  trigger: 'open',
  triggered: 'open',
  triggering: 'untriggered',
  in_progress: 'open',
}

export function mapOrderStatus(raw: string | undefined | null): MappedStatus | null {
  if (typeof raw !== 'string') return null
  const key = raw.trim().toLowerCase()
  return ORDER_STATUS_MAP[key] ?? null
}

/** 原生订单类型 → VenueOpenOrder.type（计划委托按 planType 区分触发形态）。 */
export function mapOpenOrderType(orderType: string | undefined, planType?: string): VenueOpenOrder['type'] {
  const t = (orderType ?? '').trim().toLowerCase()
  const p = (planType ?? '').trim().toLowerCase()
  if (p === 'loss_plan' || p === 'pos_loss') return 'stop_market'
  if (p === 'profit_plan' || p === 'pos_profit') return 'take_market'
  if (p === 'moving_plan' || p === 'track_plan') return 'unknown'
  if (t === 'limit') return 'limit'
  if (t === 'market') return 'unknown'
  if (t === 'stop') return 'stop_limit'
  if (t === 'stop_limit') return 'stop_limit'
  if (t === 'stop_market') return 'stop_market'
  if (t === 'take_profit') return 'take_limit'
  if (t === 'take_profit_limit') return 'take_limit'
  if (t === 'take_profit_market') return 'take_market'
  return 'unknown'
}

// ---- 持仓 -------------------------------------------------------------------

/** Bitget all-position 的一行（字段名照官方；持仓专用端点，不是账户汇总里的残缺字段）。 */
export interface RawPosition {
  symbol?: string
  marginCoin?: string
  holdSide?: string
  total?: string
  available?: string
  locked?: string
  marginSize?: string
  leverage?: string
  marketPrice?: string
  markPrice?: string
  avgPx?: string
  openPriceAvg?: string
  entryPrice?: string
  unrealizedPL?: string
  achievedProfits?: string
  realizedPL?: string
  liquidationPrice?: string
  keepMarginRate?: string
  marginMode?: string
  cTime?: string | number
  uTime?: string | number
}

export interface ParseContext {
  accountId: AccountId
  now: Ms
}

/**
 * 持仓行 → Position。只收 total > 0 的行（零仓位的平仓行在私有流归一里保留，见 normalizeBitgetEvent）；
 * `holdSide === 'net'`（单向）按 total 的符号判方向。initialMargin / maintenanceMargin 由 marginSize 与
 * keepMarginRate 折算（Bitget 不给绝对值，README 写明这是折算值）。
 */
export function parsePosition(row: RawPosition, ctx: ParseContext): Position | undefined {
  const symbol = typeof row.symbol === 'string' ? row.symbol : undefined
  if (!symbol) return undefined
  const total = signedDecimalOf(row.total)
  const size = absDec(total)
  if (size === '0') return undefined
  const markPrice = decimalOf(row.markPrice ?? row.marketPrice)
  const entryPrice = decimalOf(row.avgPx ?? row.openPriceAvg ?? row.entryPrice)
  const notional = mulDecSafe(markPrice, size)
  const leverage = Math.max(1, Math.round(num(row.leverage) || 1))
  const holdSide = (row.holdSide ?? '').toLowerCase()
  const side: Position['side'] = holdSide === 'long' ? 'long' : holdSide === 'short' ? 'short' : total.startsWith('-') ? 'short' : 'long'
  const marginSize = decimalOf(row.marginSize)
  const keepMarginRate = decimalOf(row.keepMarginRate)
  const maintenance = mulDecSafe(notional, keepMarginRate)
  const liquidation = decimalOf(row.liquidationPrice)
  const openedAt = toMs(row.cTime, ctx.now)
  const updatedAt = toMs(row.uTime, ctx.now)
  return {
    accountId: ctx.accountId,
    instrumentId: instrumentIdOf(symbol),
    side,
    size,
    entryPrice,
    markPrice,
    notional,
    unrealizedPnl: signedDecimalOf(row.unrealizedPL),
    realizedPnl: signedDecimalOf(row.achievedProfits ?? row.realizedPL),
    leverage,
    marginMode: (row.marginMode ?? '').toLowerCase() === 'isolated' ? 'isolated' : 'cross',
    initialMargin: marginSize,
    maintenanceMargin: maintenance,
    liquidationPrice: liquidation !== '0' ? liquidation : null,
    // Bitget 持仓不暴露累计资金费；不编数字（README 写明）。
    fundingSinceOpen: asDecimal('0'),
    openedAt,
    updatedAt,
  }
}

export function parsePositions(raw: unknown, ctx: ParseContext): Position[] {
  if (!Array.isArray(raw)) return []
  const out: Position[] = []
  for (const row of raw) {
    if (!row || typeof row !== 'object') continue
    const position = parsePosition(row as RawPosition, ctx)
    if (position) out.push(position)
  }
  return out
}

// ---- 账户 -------------------------------------------------------------------

/** Bitget /api/v2/mix/account/accounts 的一行（每个保证金币种一行）。 */
export interface RawAccountRow {
  marginCoin?: string
  locked?: string
  available?: string
  crossedMaxAvailable?: string
  isolatedMaxAvailable?: string
  maxTransferOut?: string
  accountEquity?: string
  usdtEquity?: string
  unrealizedPL?: string
  totalEquity?: string
}

export interface ParsedAccount {
  balances: Balance[]
  margin: MarginSnapshot
}

/**
 * 账户行 → 余额 + 保证金快照。
 * 可用余额取 `available`（缺失回落 crossedMaxAvailable）；总权益取 accountEquity（缺失回落 usdtEquity / totalEquity）。
 * 持仓已从持仓端点单独取到 → initialMargin / maintenanceMargin 由调用方传入的持仓汇总，不在账户行里猜。
 */
export function parseAccount(raw: unknown, ctx: ParseContext, positions: readonly Position[] = []): ParsedAccount {
  const rows = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? [raw] : []
  const balances: Balance[] = []
  let equity = asDecimal('0')
  let available = asDecimal('0')
  for (const entry of rows) {
    if (!entry || typeof entry !== 'object') continue
    const row = entry as RawAccountRow
    const asset = (row.marginCoin ?? '').toUpperCase()
    if (asset === '') continue
    const total = decimalOf(row.accountEquity ?? row.totalEquity ?? row.usdtEquity)
    const avail = decimalOf(row.available ?? row.crossedMaxAvailable ?? '0')
    const hold = decimalOf(row.locked ?? '0')
    balances.push({ accountId: ctx.accountId, asset, total, available: avail, hold, ts: ctx.now })
    if (asset === MARGIN_COIN) {
      equity = total
      available = avail
    }
  }
  let initialMargin = asDecimal('0')
  let maintenanceMargin = asDecimal('0')
  let leverage = 0
  for (const p of positions) {
    initialMargin = addDecSafe(initialMargin, p.initialMargin ?? asDecimal('0'))
    maintenanceMargin = addDecSafe(maintenanceMargin, p.maintenanceMargin ?? asDecimal('0'))
    leverage = Math.max(leverage, p.leverage)
  }
  const marginRatio = equity !== '0' ? divDecSafe(maintenanceMargin, equity) : asDecimal('0')
  return {
    balances,
    margin: {
      accountId: ctx.accountId,
      model: 'standard',
      valuationCcy: MARGIN_COIN,
      // Bitget 的 accountEquity 已含未实现盈亏 —— 不再叠加 unrealizedPL（叠加会重复计一次）。
      equity,
      initialMargin,
      maintenanceMargin,
      available,
      marginRatio,
      leverage: leverage === 0 ? 1 : leverage,
      ts: ctx.now,
    },
  }
}

// ---- 挂单 -------------------------------------------------------------------

/** orders-pending / orders-plan-pending 的一行（两个端点都用 `data.entrustedList`，QD open_orders.py:110-125）。 */
export interface RawEntrusted {
  orderId?: string
  clientOid?: string
  symbol?: string
  side?: string
  tradeSide?: string
  orderType?: string
  planType?: string
  planStatus?: string
  price?: string
  priceAvg?: string
  triggerPrice?: string
  size?: string
  baseVolume?: string
  totalProfits?: string
  status?: string
  reduceOnly?: string
  cTime?: string | number
  uTime?: string | number
}

/**
 * 挂单行 → VenueOpenOrder。
 * `isTrigger`：计划委托（或带 triggerPrice 的行）为 true；`reduceOnly` 认可 YES / true / 1，
 * 对冲模式下的 tradeSide=close 也算减仓（QD 的 holdSide 语义）；tpsl 计划行（loss_plan / profit_plan /
 * moving_plan / pos_loss / pos_profit）一律减仓（否则内核 keepProtective 全撤会把止损撤掉）。
 */
export function parseOpenOrder(row: RawEntrusted, now: Ms): VenueOpenOrder | undefined {
  const symbol = typeof row.symbol === 'string' ? row.symbol : undefined
  const orderId = row.orderId ?? row.clientOid
  if (!symbol || orderId === undefined || orderId === '') return undefined
  const size = decimalOf(row.size)
  const filled = decimalOf(row.baseVolume)
  const triggerPrice = decimalOf(row.triggerPrice)
  const reduce = String(row.reduceOnly ?? '').toLowerCase()
  const planType = (row.planType ?? '').toLowerCase()
  const reducingPlan = planType === 'loss_plan' || planType === 'profit_plan' || planType === 'moving_plan'
    || planType === 'pos_loss' || planType === 'pos_profit'
  return {
    instrumentId: instrumentIdOf(symbol),
    venueOrderId: String(orderId),
    clientOrderId: typeof row.clientOid === 'string' && row.clientOid !== '' ? row.clientOid : null,
    side: (row.side ?? '').toLowerCase() === 'sell' ? 'sell' : 'buy',
    type: mapOpenOrderType(row.orderType, row.planType),
    price: decimalOf(row.price) !== '0' ? decimalOf(row.price) : null,
    triggerPrice: triggerPrice !== '0' ? triggerPrice : null,
    // 剩余量 = size − baseVolume；上游异常导致负值时按 0（协议要非负）
    size: subDecSafe(size, filled).startsWith('-') ? asDecimal('0') : subDecSafe(size, filled),
    origSize: size,
    reduceOnly: reducingPlan || reduce === 'yes' || reduce === 'true' || reduce === '1' || (row.tradeSide ?? '').toLowerCase() === 'close',
    isTrigger: triggerPrice !== '0' || (row.planType ?? '') !== '',
    createdAt: toMs(row.cTime, now),
  }
}

/**
 * `data.entrustedList`（或直接数组）→ 挂单 + 原始行（供计划单撤单 / 查单用）；同时返回分页游标 endId。
 * Fail closed（QD open_orders.py:105-108）：对象里没有 `entrustedList` 键 / 不是对象 → 报错，
 * 不当作空表（否则对账会漏单）。`entrustedList: null` → 空。
 */
export function parseEntrustedPage(raw: unknown, now: Ms): { orders: VenueOpenOrder[]; rows: RawEntrusted[]; endId: string | null } {
  let list: unknown[]
  let container: { entrustedList?: unknown; endId?: unknown } | undefined
  if (Array.isArray(raw)) {
    list = raw
  } else {
    if (raw === null || typeof raw !== 'object') {
      throw new ProblemError(makeProblem('VENUE_UNAVAILABLE', 'bitget pending-orders response has no entrustedList; refusing to treat it as empty', { retryable: true }))
    }
    container = raw as { entrustedList?: unknown; endId?: unknown }
    const value = 'entrustedList' in container ? container.entrustedList : undefined
    if (!('entrustedList' in container)) {
      throw new ProblemError(makeProblem('VENUE_UNAVAILABLE', 'bitget pending-orders response has no entrustedList; refusing to treat it as empty', { retryable: true }))
    }
    if (value === null || value === undefined) {
      list = []
    } else if (Array.isArray(value)) {
      list = value
    } else {
      throw new ProblemError(makeProblem('VENUE_UNAVAILABLE', 'bitget pending-orders response has no entrustedList; refusing to treat it as empty', { retryable: true }))
    }
  }
  const orders: VenueOpenOrder[] = []
  const rows: RawEntrusted[] = []
  for (const row of list) {
    if (!row || typeof row !== 'object') continue
    const rawRow = row as RawEntrusted
    rows.push(rawRow)
    const order = parseOpenOrder(rawRow, now)
    if (order) orders.push(order)
  }
  const endId = container?.endId === undefined || container.endId === null || container.endId === '' ? null : String(container.endId)
  return { orders, rows, endId }
}

// ---- 成交 -------------------------------------------------------------------

export interface RawFill {
  tradeId?: string
  orderId?: string
  clientOid?: string
  symbol?: string
  side?: string
  price?: string
  baseVolume?: string
  size?: string
  fillPrice?: string
  fillTime?: string | number
  cTime?: string | number
  profit?: string
  fee?: string
  feeCoin?: string
  feeDetail?: unknown
  tradeScope?: string
  execType?: string
}

/**
 * 成交行 → VenueFill。venueFillId 用 `symbol:tradeId`（QD normalizers.py:201 `exchange_fill_id`），**不用时间戳**；
 * 手续费走 fees.ts（Bitget 负数 = 扣费，协议正 = 付出）；liquidity 认 tradeScope / execType（QD :245-247）。
 */
export function parseFill(row: RawFill, now: Ms): VenueFill | undefined {
  const symbol = typeof row.symbol === 'string' ? row.symbol : undefined
  const tradeId = row.tradeId ?? ''
  if (!symbol) return undefined
  if (tradeId === '' && decimalOf(row.baseVolume ?? row.size) === '0') return undefined
  const size = decimalOf(row.baseVolume ?? row.size)
  const price = decimalOf(row.fillPrice ?? row.price)
  const feeMap = feeOfFill(row as Record<string, unknown>, { receivedCurrency: MARGIN_COIN })
  const { fee, feeCcy } = feeStorage(row['feeDetail'] !== undefined ? row['feeDetail'] : { fee: row.fee, feeCoin: row.feeCoin ?? MARGIN_COIN }, { receivedCurrency: MARGIN_COIN })
  const scope = (row.tradeScope ?? row.execType ?? '').toLowerCase()
  return {
    venueFillId: tradeId === '' ? '' : `${symbol}:${tradeId}`,
    venueOrderId: String(row.orderId ?? ''),
    clientOrderId: typeof row.clientOid === 'string' && row.clientOid !== '' ? row.clientOid : null,
    instrumentId: instrumentIdOf(symbol),
    side: (row.side ?? '').toLowerCase() === 'sell' ? 'sell' : 'buy',
    price,
    size,
    fee,
    feeCcy: feeCcy === '' ? (Object.keys(feeMap)[0] ?? MARGIN_COIN) : feeCcy,
    liquidity: scope === 'maker' ? 'maker' : 'taker',
    realizedPnl: signedDecimalOf(row.profit),
    ts: toMs(row.fillTime ?? row.cTime, now),
  }
}

export function parseFills(raw: unknown, now: Ms): VenueFill[] {
  const container = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as { fillList?: unknown }) : undefined
  const list = Array.isArray(raw) ? raw : container?.fillList
  const out: VenueFill[] = []
  if (!Array.isArray(list)) return out
  for (const row of list) {
    if (!row || typeof row !== 'object') continue
    const fill = parseFill(row as RawFill, now)
    if (fill) out.push(fill)
  }
  return out.sort((a, b) => a.ts - b.ts)
}

// ---- 单张订单详情 ------------------------------------------------------------

export interface RawOrderDetail {
  orderId?: string
  clientOid?: string
  symbol?: string
  side?: string
  orderType?: string
  state?: string
  status?: string
  priceAvg?: string
  baseVolume?: string
  filledQty?: string
  size?: string
  fillPrice?: string
  fee?: string
  feeCoin?: string
  feeDetail?: unknown
  cTime?: string | number
}

/** 详情行 → VenueOrderStatus（`status` 原样保留上游字符串，不翻译；QD bitget.py:965-995）。 */
export function parseOrderDetail(data: unknown): VenueOrderStatus {
  if (!data || typeof data !== 'object') return { found: false }
  const row = data as RawOrderDetail
  const orderId = row.orderId
  const status = row.state ?? row.status
  if (orderId === undefined && status === undefined) return { found: false }
  const filled = decimalOf(row.baseVolume ?? row.filledQty ?? '0')
  return {
    found: true,
    ...(status !== undefined ? { status: String(status) } : {}),
    ...(orderId !== undefined ? { venueOrderId: String(orderId) } : {}),
    filledSize: filled,
    raw: data,
  }
}

// ---- 私有流归一 --------------------------------------------------------------

/** 私有流一条执行事件（保留成交号 = 去重键、执行类型、持仓方向）。 */
export interface BitgetExecEvent {
  channel: 'fill' | 'orders'
  venueFillId: string
  venueOrderId: string
  clientOrderId: string | null
  instrumentId: string
  side: 'buy' | 'sell'
  holdSide: 'long' | 'short' | ''
  price: Decimal
  size: Decimal
  cumSize: Decimal | null
  fee: Decimal
  feeCcy: string
  /** 逐币明细（正 = 付出）；多币时 fee = '0' 且 feeCcy = 'MIXED'，明细看这里。 */
  fees: Record<string, Decimal>
  realizedPnl: Decimal
  liquidity: 'maker' | 'taker'
  status: string
  mapped: MappedStatus | null
  ts: Ms
}

/**
 * Bitget 私有流（WS `fill` / `orders` 通道）→ 归一事件。
 * Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/execution_streams/normalizers.py:185-249; adapted.
 *   · 只有 `arg.channel` 是 fill / orders 才认（:187-188）；SPOT 与 mix 的字段名不同（:194-200）；
 *   · **保留零数量的平仓行**：qty <= 0 且没有 tradeId 才丢（:201-203）——成交号是去重键；
 *   · 手续费同时支持 feeDetail 列表与 fillFee / fee 平铺字段（:204-223）；
 *   · 方向 / 持仓方向 / 执行类型原样带出（:232-247）。
 */
export function normalizeBitgetEvent(payload: unknown, opts: { now?: Ms } = {}): { channel: string; events: BitgetExecEvent[] } {
  const body = payload && typeof payload === 'object' ? (payload as { arg?: unknown; data?: unknown }) : {}
  const arg = body.arg && typeof body.arg === 'object' ? (body.arg as { channel?: unknown; instType?: unknown }) : {}
  const channel = String(arg.channel ?? '')
  if (channel !== 'fill' && channel !== 'orders') return { channel, events: [] }
  const instType = String(arg.instType ?? '').toUpperCase()
  const isSpot = instType === 'SPOT'
  const isOrder = channel === 'orders'
  const rows = Array.isArray(body.data) ? body.data : []
  const events: BitgetExecEvent[] = []
  for (const item of rows) {
    if (!item || typeof item !== 'object') continue
    const row = item as Record<string, unknown>
    const qty = decimalOf(
      isSpot && !isOrder ? row['size'] : row['fillQty'] ?? row['baseVolume'] ?? row['execQty'] ?? row['size'],
    )
    const fillId = String(row['tradeId'] ?? row['execId'] ?? '')
    if (qty === '0' && fillId === '') continue
    const symbol = String(row['symbol'] ?? arg.instType ?? '')
    const rawStatus = String(row['status'] ?? row['state'] ?? '')
    const mapped = mapStatusOfFill(rawStatus, isOrder)
    const fees = feeOfFill(row, { receivedCurrency: MARGIN_COIN })
    const keys = Object.keys(fees)
    const single = keys.length === 1 ? keys[0]! : ''
    // 多币不求和（不同币相加无意义，照 QD fee_storage: '0' + 'MIXED'），逐币明细在 fees 里。
    const fee = keys.length === 1 ? fees[keys[0]!]! : asDecimal('0')
    const feeCcy = keys.length === 0 ? '' : keys.length === 1 ? single : 'MIXED'
    const scope = String(row['tradeScope'] ?? row['execType'] ?? '').toLowerCase()
    events.push({
      channel,
      venueFillId: fillId === '' ? '' : `${symbol}:${fillId}`,
      venueOrderId: String(row['orderId'] ?? row['ordId'] ?? ''),
      clientOrderId: String(row['clientOid'] ?? row['clOrdId'] ?? '') || null,
      instrumentId: instrumentIdOf(symbol),
      side: String(row['side'] ?? '').toLowerCase() === 'sell' ? 'sell' : 'buy',
      holdSide: ((): BitgetExecEvent['holdSide'] => {
        const hold = String(row['posSide'] ?? row['holdSide'] ?? '').toLowerCase()
        return hold === 'long' || hold === 'short' ? hold : ''
      })(),
      price: decimalOf(
        isSpot && !isOrder ? row['priceAvg'] : row['fillPrice'] ?? row['price'] ?? row['execPrice'],
      ),
      size: qty,
      cumSize: row['accBaseVolume'] === undefined ? null : decimalOf(row['accBaseVolume']),
      fee,
      feeCcy,
      fees,
      realizedPnl: signedDecimalOf(row['profit']),
      liquidity: scope === 'maker' ? 'maker' : 'taker',
      status: rawStatus,
      mapped,
      ts: toMs(row['cTime'] as string | number | undefined ?? row['uTime'] as string | number | undefined ?? row['fillTime'] as string | number | undefined, opts.now ?? Date.now()),
    })
  }
  return { channel, events }
}

function mapStatusOfFill(status: string, isOrder: boolean): MappedStatus | null {
  const mapped = mapOrderStatus(status)
  if (mapped !== null) return mapped
  if (status === '') return isOrder ? null : 'filled'
  return null
}

// ---- 小工具 -----------------------------------------------------------------

function toMs(value: string | number | undefined | null, fallback: Ms): Ms {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value)
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    if (Number.isFinite(n)) return Math.round(n)
  }
  return fallback
}

function mulDecSafe(a: Decimal, b: Decimal): Decimal {
  return mulDec(a, b)
}

function addDecSafe(a: Decimal, b: Decimal): Decimal {
  return addDec(a, b)
}

function subDecSafe(a: Decimal, b: Decimal): Decimal {
  return subDec(a, b)
}

function divDecSafe(a: Decimal, b: Decimal): Decimal {
  const denom = fx(b)
  return denom === 0n ? asDecimal('0') : asDecimal(str(div(fx(a), denom)))
}
