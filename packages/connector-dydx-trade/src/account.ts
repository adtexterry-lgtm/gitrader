// SPDX-License-Identifier: CPAL-1.0
// Indexer 私有响应 → 协议形状（账户快照 / 挂单 / 成交 / 启动对账）。
// 端点（docs.dydx.xyz/indexer-client/http；路径已对主网 Indexer 实探 200）：
//   GET /v4/addresses/{address}/subaccountNumber/{n}       → { subaccount: { equity, freeCollateral, assetPositions, openPerpetualPositions } }
//   GET /v4/perpetualPositions?address=&subaccountNumber=&status=OPEN → { positions: [...] }（持仓专用端点，教训 5）
//   GET /v4/orders?address=&subaccountNumber=&status=OPEN → [ ... ]（裸数组）
//   GET /v4/orders/{orderId} → 单行（不存在回 404）
//   GET /v4/fills?address=&subaccountNumber=&limit=&createdBeforeOrAtHeight= → { fills: [...] }
// 单号：Indexer 的订单 id 是 uuid v5，公式见 indexerOrderId；不是自编的规范串。
// 去重键（教训 10）：成交优先用 Indexer 的 fill.id；缺失时回退 `${orderId}:${createdAtHeight}:${size}:${price}`，
//   回退键在「同一块同一单多笔同价同量」时会撞车，README 已写风险。
import { createHash } from 'node:crypto'
import { asDecimal, type Decimal, type Ms } from '@gitrader/protocol'
import type { AccountSnapshot, VenueFill, VenueOpenOrder, VenueOrderStatus } from '@gitrader/protocol/connector'
import type { Balance, Position } from '@gitrader/protocol'
import { fx, str } from '@gitrader/protocol/decimal'

export const VENUE_PREFIX = 'dydx:'

/** Indexer 订单 UUID 的命名空间（v4-chain indexer/packages/postgres/src/helpers/uuid.ts）。 */
export const INDEXER_UUID_NAMESPACE = '0f9da948-a6fb-4c45-9edc-4685c3f3317d'

/**
 * RFC 4122 §4.3 name-based UUID（version 5）：sha1(namespace16 ‖ name UTF-8) 取前 16 字节，
 * 再写入版本号（b[6] 高 4 位 = 5）与变体位（b[8] 高 2 位 = 10），小写 8-4-4-4-12。
 */
export function uuidv5(name: string, namespace: string): string {
  const nsHex = namespace.replace(/-/g, '')
  if (!/^[0-9a-fA-F]{32}$/.test(nsHex)) throw new TypeError(`invalid uuid namespace: ${namespace}`)
  const ns = new Uint8Array(16)
  for (let i = 0; i < 16; i += 1) ns[i] = parseInt(nsHex.slice(i * 2, i * 2 + 2), 16)
  const digest = new Uint8Array(createHash('sha1').update(Buffer.from(ns)).update(Buffer.from(name, 'utf8')).digest())
  const b = digest.subarray(0, 16)
  b[6] = (b[6]! & 0x0f) | 0x50
  b[8] = (b[8]! & 0x3f) | 0x80
  const s = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`
}

/**
 * Indexer 订单 id（uuid v5）：
 *   subaccountId = uuidv5(`${address}-${subaccountNumber}`)
 *   orderId      = uuidv5(`${subaccountId}-${clientId}-${clobPairId}-${orderFlags}`)
 * 来源：v4-chain indexer/packages/postgres/src/helpers/uuid.ts、stores/subaccount-table.ts、stores/order-table.ts。
 */
export function indexerOrderId(
  address: string,
  subaccountNumber: number,
  clientId: number,
  clobPairId: number,
  orderFlags: number,
): string {
  const subaccountId = uuidv5(`${address}-${subaccountNumber}`, INDEXER_UUID_NAMESPACE)
  return uuidv5(`${subaccountId}-${clientId}-${clobPairId}-${orderFlags}`, INDEXER_UUID_NAMESPACE)
}

/** ticker → instrumentId（与 @gitrader/connector-dydx-data 的映射一致）。 */
export function instrumentIdOf(ticker: string): string {
  return `${VENUE_PREFIX}${ticker}`
}

export function tickerOf(instrumentId: string): string {
  return instrumentId.startsWith(VENUE_PREFIX) ? instrumentId.slice(VENUE_PREFIX.length) : instrumentId
}

/** Indexer 的数字既可能是字符串也可能是 number；统一成规范十进制串，转换失败抛 TypeError。 */
export function dec(value: unknown, field: string): Decimal {
  if (typeof value === 'string' && value.length > 0) return asDecimal(str(fx(value)))
  if (typeof value === 'number' && Number.isFinite(value)) return asDecimal(str(fx(value)))
  throw new TypeError(`indexer field ${field} is not a decimal: ${JSON.stringify(value)}`)
}

export function decOr(value: unknown, field: string, fallback: string): Decimal {
  if (value === undefined || value === null || value === '') return asDecimal(fallback)
  return dec(value, field)
}

export function intOf(value: unknown, field: string): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
  if (typeof value === 'string' && value.length > 0) {
    const n = Number(value)
    if (Number.isFinite(n)) return Math.trunc(n)
  }
  throw new TypeError(`indexer field ${field} is not an integer: ${JSON.stringify(value)}`)
}

/** ISO 时间串 → 毫秒；已经是数字则原样取。 */
export function msOf(value: unknown): Ms {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.length > 0) {
    const t = Date.parse(value)
    if (Number.isFinite(t)) return t
  }
  return 0
}

interface RawAssetPosition { symbol?: string; size?: unknown; side?: string }
interface RawPerpPosition {
  market?: string
  status?: string
  side?: string
  size?: unknown
  entryPrice?: unknown
  exitPrice?: unknown
  realizedPnl?: unknown
  unrealizedPnl?: unknown
  netFunding?: unknown
  leverage?: unknown
  createdAt?: string
  createdAtHeight?: string | number
  sumOpen?: unknown
  sumClose?: unknown
}
export interface RawSubaccount {
  address?: string
  subaccountNumber?: number
  equity?: unknown
  freeCollateral?: unknown
  marginEnabled?: boolean
  updatedAtHeight?: string | number
  assetPositions?: Record<string, RawAssetPosition>
  openPerpetualPositions?: Record<string, RawPerpPosition>
}
export interface RawOrder {
  id?: string
  subaccountId?: string
  clientId?: string
  clobPairId?: string | number
  side?: string
  size?: unknown
  totalFilled?: unknown
  price?: unknown
  status?: string
  type?: string
  timeInForce?: string
  reduceOnly?: boolean
  postOnly?: boolean
  orderFlags?: string | number
  goodTilBlock?: string | number
  goodTilBlockTime?: string
  createdAt?: string
  updatedAt?: string
  createdAtHeight?: string | number
  clientMetadata?: string | number
  triggerPrice?: unknown
  market?: string
}
export interface RawFill {
  id?: string
  subaccountNumber?: number
  orderId?: string
  clientId?: string
  clientMetadata?: string | number
  market?: string
  marketType?: string
  side?: string
  liquidity?: string
  type?: string
  price?: unknown
  size?: unknown
  fee?: unknown
  createdAt?: string
  createdAtHeight?: string | number
  transactionHash?: string
}

/**
 * 上游字段 → 文本。对象 / 数组 / 符号当缺失：`String({...})` 回显 "[object Object]"，
 * 带坏 `toString` 的对象会让 `String()` 抛 TypeError；对非字符串直接 `.toUpperCase()`
 * 同样是 TypeError。数字与布尔照旧转文本。
 */
function textOf(v: unknown): string {
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return ''
}

/** 多空：优先看行里的 side（LONG / SHORT），没有 side 才看数量符号。 */
function sideOfPosition(rawSide: string | undefined, sizeFx: bigint): 'long' | 'short' {
  const s = textOf(rawSide).toUpperCase()
  if (s === 'LONG') return 'long'
  if (s === 'SHORT') return 'short'
  return sizeFx < 0n ? 'short' : 'long'
}

export interface ParsedAccount {
  snapshot: AccountSnapshot
  /** 解析器读到的原始 subaccount（诊断用，不落账）。 */
  raw: RawSubaccount
}

export function parseAccount(
  raw: RawSubaccount,
  opts: { accountId: string; ts: Ms; accountModel?: 'standard' },
): ParsedAccount {
  const ts = opts.ts
  const equity = decOr(raw.equity, 'equity', '0')
  const free = decOr(raw.freeCollateral, 'freeCollateral', '0')
  const usdc = Object.values(raw.assetPositions ?? {}).find((p) => textOf(p.symbol).toUpperCase() === 'USDC')
  const total = usdc === undefined ? equity : decOr(usdc.size, 'assetPositions.USDC.size', '0')
  const balances: Balance[] = [{
    accountId: opts.accountId as never,
    asset: 'USDC',
    total,
    available: free,
    hold: asDecimal(str(fx(String(total)) - fx(String(free)) > 0n ? fx(String(total)) - fx(String(free)) : 0n)),
    ts,
  }]

  const positions: Position[] = []
  for (const [ticker, p] of Object.entries(raw.openPerpetualPositions ?? {})) {
    const sizeRaw = fx(decOr(p.size, `${ticker}.size`, '0'))
    if (sizeRaw === 0n) continue
    const size = asDecimal(str(sizeRaw < 0n ? -sizeRaw : sizeRaw))
    const entry = decOr(p.entryPrice, `${ticker}.entryPrice`, '0')
    const mark = decOr(p.exitPrice, `${ticker}.exitPrice`, String(entry))
    const notionalFx = (fx(String(size)) * fx(String(mark))) / fx('1')
    positions.push({
      accountId: opts.accountId as never,
      instrumentId: instrumentIdOf(ticker) as never,
      side: sideOfPosition(p.side, sizeRaw),
      size,
      entryPrice: entry,
      markPrice: mark,
      notional: asDecimal(str(notionalFx)),
      unrealizedPnl: decOr(p.unrealizedPnl, `${ticker}.unrealizedPnl`, '0'),
      realizedPnl: decOr(p.realizedPnl, `${ticker}.realizedPnl`, '0'),
      // Indexer 的 subaccount 视图不保证给每仓杠杆；缺失写 0（未知），原始值仍留在 raw 里。
      leverage: p.leverage === undefined ? 0 : intOf(p.leverage, `${ticker}.leverage`),
      marginMode: 'cross',
      liquidationPrice: null,
      fundingSinceOpen: decOr(p.netFunding, `${ticker}.netFunding`, '0'),
      openedAt: msOf(p.createdAt),
      updatedAt: ts,
    })
  }

  // 维持保证金率 / 初始保证金：Indexer 私有接口不给分项，按 equity 与 freeCollateral 反推「已占用」写 initialMargin，
  // maintenanceMargin 留 0；marginRatio 取 0（内核以自己的风控为准，这里不编造比率）。
  const usedFx = fx(String(equity)) - fx(String(free)) > 0n ? fx(String(equity)) - fx(String(free)) : 0n
  const snapshot: AccountSnapshot = {
    accountModel: 'standard',
    balances,
    margin: {
      accountId: opts.accountId as never,
      model: 'standard',
      valuationCcy: 'USDC',
      equity,
      initialMargin: asDecimal(str(usedFx)),
      maintenanceMargin: asDecimal('0'),
      available: free,
      marginRatio: asDecimal('0'),
      leverage: 0,
      ts,
    },
    positions,
    ts,
    source: 'rest',
    availableDeductsOpenOrders: false,
  }
  return { snapshot, raw }
}

export function parsePositions(raw: RawPerpPosition[]): Position[] {
  const out: Position[] = []
  for (const p of raw) {
    const ticker = p.market ?? ''
    const sizeFx = fx(decOr(p.size, `${ticker}.size`, '0'))
    if (sizeFx === 0n) continue
    const size = asDecimal(str(sizeFx < 0n ? -sizeFx : sizeFx))
    const entry = decOr(p.entryPrice, `${ticker}.entryPrice`, '0')
    const mark = decOr(p.exitPrice, `${ticker}.exitPrice`, String(entry))
    out.push({
      accountId: '' as never,
      instrumentId: instrumentIdOf(ticker) as never,
      side: sideOfPosition(p.side, sizeFx),
      size,
      entryPrice: entry,
      markPrice: mark,
      notional: asDecimal(str((fx(String(size)) * fx(String(mark))) / fx('1'))),
      unrealizedPnl: decOr(p.unrealizedPnl, `${ticker}.unrealizedPnl`, '0'),
      realizedPnl: decOr(p.realizedPnl, `${ticker}.realizedPnl`, '0'),
      leverage: p.leverage === undefined ? 0 : intOf(p.leverage, `${ticker}.leverage`),
      marginMode: 'cross',
      liquidationPrice: null,
      fundingSinceOpen: decOr(p.netFunding, `${ticker}.netFunding`, '0'),
      openedAt: msOf(p.createdAt),
      updatedAt: msOf(p.createdAt),
    })
  }
  return out
}

const ORDER_TYPE_MAP: Record<string, VenueOpenOrder['type']> = {
  LIMIT: 'limit',
  MARKET: 'limit',
  STOP_LIMIT: 'stop_limit',
  STOP_MARKET: 'stop_market',
  TAKE_PROFIT_LIMIT: 'take_limit',
  TAKE_PROFIT_MARKET: 'take_market',
  TRAILING_STOP: 'unknown',
}

/**
 * 挂单：只用 status 为 OPEN / UNTRIGGERED 的行（调用方按端点过滤）。
 * clientOrderId 由调用方的映射给：未知（重启后 / 外来单）写 null，不拿十进制 clientId 充数。
 */
export function parseOrders(raw: RawOrder[], clientOrderIdOf?: (indexerOrderId: string) => string | null): VenueOpenOrder[] {
  const out: VenueOpenOrder[] = []
  for (const o of raw) {
    const status = textOf(o.status).toUpperCase()
    if (status !== 'OPEN' && status !== 'UNTRIGGERED' && status !== 'BEST_EFFORT_OPENED') continue
    const size = decOr(o.size, 'order.size', '0')
    const filled = decOr(o.totalFilled, 'order.totalFilled', '0')
    const remaining = str(fx(size) - fx(filled) > 0n ? fx(size) - fx(filled) : 0n)
    const type = ORDER_TYPE_MAP[textOf(o.type).toUpperCase()] ?? 'unknown'
    out.push({
      instrumentId: instrumentIdOf(o.market ?? '') as never,
      venueOrderId: o.id ?? '',
      clientOrderId: (o.id === undefined ? null : clientOrderIdOf?.(o.id) ?? null) as never,
      side: textOf(o.side).toUpperCase() === 'SELL' ? 'sell' : 'buy',
      type,
      price: type === 'limit' || type === 'stop_limit' || type === 'take_limit' ? decOr(o.price, 'order.price', '0') : null,
      triggerPrice: o.triggerPrice === undefined ? null : dec(o.triggerPrice, 'order.triggerPrice'),
      size: asDecimal(remaining),
      origSize: size,
      reduceOnly: o.reduceOnly === true,
      isTrigger: status === 'UNTRIGGERED',
      createdAt: msOf(o.createdAt),
    })
  }
  return out
}

export function parseFills(raw: RawFill[], clientOrderIdOf?: (indexerOrderId: string) => string | null): VenueFill[] {
  const out: VenueFill[] = []
  for (const f of raw) {
    const market = f.market ?? ''
    const orderId = f.orderId ?? ''
    const size = decOr(f.size, 'fill.size', '0')
    const price = decOr(f.price, 'fill.price', '0')
    const createdAt = msOf(f.createdAt)
    const height = f.createdAtHeight === undefined ? '' : textOf(f.createdAtHeight)
    // venueFillId / venueOrderId 是文本契约：上游给成对象 / 数组时按缺失处理，退回合成键，
    // 否则对象（连同里面的 NaN）会顺着去重键流到对账层。
    const venueFillId = textOf(f.id) !== ''
      ? textOf(f.id)
      : `${textOf(orderId)}:${height}:${size}:${price}`
    out.push({
      venueOrderId: textOf(f.orderId),
      clientOrderId: (f.orderId === undefined ? null : clientOrderIdOf?.(f.orderId) ?? null) as never,
      instrumentId: instrumentIdOf(market) as never,
      side: textOf(f.side).toUpperCase() === 'SELL' ? 'sell' : 'buy',
      price,
      size,
      fee: decOr(f.fee, 'fill.fee', '0'),
      feeCcy: 'USDC',
      liquidity: textOf(f.liquidity).toUpperCase() === 'MAKER' ? 'maker' : 'taker',
      // Indexer 的私有 fills 不给单笔已实现盈亏（在持仓 / PnL 端点里）；这里写 0 并保留原始行给对上账。
      realizedPnl: asDecimal('0'),
      venueFillId,
      ts: createdAt,
    })
  }
  return out
}

/** orderStatus 的结果：status 保留上游原文（不翻译，教训 10）。 */
export function statusOfOrder(raw: RawOrder): VenueOrderStatus {
  return {
    found: true,
    // 模型字段的类型是契约：上游把 status / id 给成对象或数字时不塞进 model，
    // 否则 venueOrderId 会带着一个对象（连同里面的 NaN）流到执行层。
    ...(typeof raw.status !== 'string' ? {} : { status: raw.status }),
    ...(typeof raw.id !== 'string' ? {} : { venueOrderId: raw.id }),
    filledSize: decOr(raw.totalFilled, 'order.totalFilled', '0'),
    raw,
  }
}

export const NOT_FOUND: VenueOrderStatus = { found: false }
