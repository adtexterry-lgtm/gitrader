// SPDX-License-Identifier: CPAL-1.0
// HTX 私有响应 → 统一模型（纯函数，无状态；不发请求、不读环境）。
// 两套信封的 data 形状都要认（v5 的 data 有时是对象、有时是数组；v1 的 data 是对象）：
//   余额   v5 `{equity, initial_margin, ..., details:[{currency,equity,available,...}]}` / v1 `[{margin_asset,margin_balance,margin_available,...}]`
//          —— 官方 v5 余额页注明账户级字段以 USD 计；v1 的保证金资产是 USDT；
//   持仓   v5 行：contract_code、position_side(long/short/both)、direction(buy/sell)、volume(张)、open_avg_price、
//          mark_price、profit_unreal、lever_rate、margin_mode；v1 行：cost_open / cost_hold / last_price；
//   订单   v1 行：order_id / order_id_str、client_order_id、direction、offset、volume、price、trade_volume、
//          status(1..8,11)、order_price_type、created_at；v5 行：side / type / state / created_time / reduce_only(bool)；
//   成交   v1 行：id、trade_volume、trade_price、trade_fee(付出为负)、create_date、role、real_profit、fee_asset；
//          v5 行：trade_id、trade_volume、trade_price、trade_fee、created_time、role、profit、fee_currency。
// 三处必须守住的细节（执行层教训 10）：
//   1) 成交去重键 = 场所唯一成交号（v1 `id` / v5 `trade_id`）；解析永不合成「近似 id」；
//   2) 方向与开平（offset）都原样保留：平仓行不因「仓位归零」被丢掉 —— 它是账本平仓的唯一凭据；
//   3) 数量一律换成**币数量**（venueSizeUnit = base）：volume(张) × 面值；
//      面值未知（没 start() 或合约不在表里）直接抛 INSTRUMENT_UNKNOWN —— 不按 1 折算。
import { asDecimal, makeProblem, normalizeDecimal } from '@gitrader/protocol'
import type { AccountId, Decimal, MarginSnapshot, Ms, Position } from '@gitrader/protocol'
import { cmpDec, mulDec, subDec } from '@gitrader/protocol/decimal'
import type { AccountSnapshot, VenueFill, VenueOpenOrder, VenueOrderStatus } from '@gitrader/protocol/connector'
import { ProblemError } from './errors'
import { contractsToBase } from './precision'

export const VENUE = 'htx'

/** 合约代码（BTC-USDT）↔ instrumentId（htx:BTC-USDT）。 */
export const upper = (s: string): string => s.trim().toUpperCase()

/**
 * 上游字段 → 文本。对象 / 数组 / 符号当缺失：`String({...})` 会回显 "[object Object]"，
 * 带坏 `toString` 的对象（JSON 里 `{"toString":0}` 就够）会让 `String()` 抛 TypeError，
 * 把畸形字段升级成解析崩溃。数字与布尔照旧转文本。
 */
export const textOf = (v: unknown): string => {
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return ''
}
export function instrumentIdOf(contractCode: string): string {
  return `${VENUE}:${upper(contractCode)}`
}
export function symbolOf(instrumentId: string): string {
  const prefix = `${VENUE}:`
  if (!instrumentId.startsWith(prefix)) throw new RangeError(`not an htx instrument id: ${instrumentId}`)
  const code = instrumentId.slice(prefix.length)
  if (code === '') throw new RangeError('empty contract code in instrument id')
  return code
}

/** 宽松十进制文本 → Decimal；非法 / 空串回落 '0'（HTX 用空串表示「没有值」）。 */
export function decimalOf(v: unknown): Decimal {
  if (typeof v === 'number') return Number.isFinite(v) ? normalizeDecimal(String(v)) : asDecimal('0')
  if (typeof v !== 'string' || v.trim() === '') return asDecimal('0')
  try {
    return normalizeDecimal(v.trim())
  } catch {
    return asDecimal('0')
  }
}

/** 绝对值（定点，不碰浮点）。 */
export function absDecimal(v: unknown): Decimal {
  const d = decimalOf(v)
  return cmpDec(d, '0') < 0 ? subDec('0', d) : d
}

/** 有些字段是 number，有些是字符串；空串必须当缺失（Number('') === 0 是坑）。 */
export const num = (v: unknown): number => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN
  if (typeof v !== 'string') return NaN
  const s = v.trim()
  if (s === '') return NaN
  const n = Number(s)
  return Number.isFinite(n) ? n : NaN
}

/** 合约规格查询：contract_code → 一张的面值（币）。拿不到返回 undefined。 */
export type ContractSizeOf = (contractCode: string) => string | undefined

/** 张 → 币数量。面值未知（没 start() / 合约不在表里）时抛 INSTRUMENT_UNKNOWN，不按 1 折算。 */
export function baseSizeOf(volumeContracts: unknown, contractSize: string | undefined, contractCode = ''): Decimal {
  if (contractSize === undefined || !(Number(contractSize) > 0)) {
    throw new ProblemError(makeProblem('INSTRUMENT_UNKNOWN', `contract size unknown for ${contractCode || 'contract'}; call start() first`))
  }
  return contractsToBase(Math.abs(Math.round(Number(volumeContracts) || 0)), contractSize)
}
/** 成交去重键：场所 + 成交号（执行层唯一稳定的去重口径）。 */
export function fillDedupeKey(fill: { venueFillId: string }): string {
  return `${VENUE}|${fill.venueFillId}`
}

/** v1 订单状态码 → 协议口径（官方《合约订单信息》status 字段：1 准备提交 … 11 撤单中）。 */
export const ORDER_STATUS_MAP: Record<number, 'open' | 'partially_filled' | 'filled' | 'cancelled' | 'rejected' | 'expired'> = {
  1: 'open',
  2: 'open',
  3: 'open',
  4: 'partially_filled',
  5: 'cancelled',
  6: 'filled',
  7: 'cancelled',
  8: 'rejected',
  11: 'open',
}

/** 上游状态（数字或字符串）→ 协议口径；认不出按 unknown 处理，不猜。 */
export function orderStatusOf(raw: unknown): 'open' | 'partially_filled' | 'filled' | 'cancelled' | 'rejected' | 'expired' | 'unknown' {
  if (typeof raw === 'number' && Number.isFinite(raw)) return ORDER_STATUS_MAP[raw] ?? 'unknown'
  if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) return ORDER_STATUS_MAP[Number(raw.trim())] ?? 'unknown'
  const text = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  if (text === 'filled' || text === 'full_filled') return 'filled'
  if (text === 'partial_filled' || text === 'partially_filled') return 'partially_filled'
  if (text === 'canceled' || text === 'cancelled') return 'cancelled'
  if (text === 'rejected' || text === 'failed') return 'rejected'
  if (text === 'open' || text === 'submitted' || text === 'pending') return 'open'
  return 'unknown'
}

// ---- 账户 -------------------------------------------------------------------

export interface RawBalanceRow {
  currency?: string
  margin_asset?: string
  equity?: string
  margin_balance?: string
  margin_static?: string
  available?: string
  margin_available?: string
  available_margin?: string
  withdraw_available?: string
  margin_position?: string
  margin_frozen?: string
  initial_margin?: string
  maintenance_margin?: string
}

/** v5 的 data 是对象（账户级字段在顶层）；v1 的 data 是数组。 */
export interface RawBalanceEnvelope extends RawBalanceRow {
  details?: RawBalanceRow[]
  state?: string
  maintenance_margin_rate?: string
  profit_unreal?: string
}

function balanceRows(raw: unknown): RawBalanceRow[] {
  if (Array.isArray(raw)) return raw.filter((r): r is RawBalanceRow => !!r && typeof r === 'object')
  if (!raw || typeof raw !== 'object') return []
  const env = raw as RawBalanceEnvelope
  if (Array.isArray(env.details)) return env.details.filter((r): r is RawBalanceRow => !!r && typeof r === 'object')
  return [env as RawBalanceRow]
}

/** v5 的账户级字段在 data 顶层；v1 只有行级字段（返回空对象）。 */
function balanceTop(raw: unknown): RawBalanceEnvelope {
  if (Array.isArray(raw) || !raw || typeof raw !== 'object') return {}
  return raw as RawBalanceEnvelope
}

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/live_trading/htx_v5.py:53-115; adapted.
/**
 * 余额 → AccountSnapshot（只有余额与保证金；持仓由持仓端点单独取）。
 *   · v5：账户级 `equity / initial_margin / maintenance_margin / available_margin` 在 data 顶层，计值币种 USD；
 *   · v1：行级 `margin_balance / margin_position / margin_available`，计值币种 USDT。
 * available 用 `available` / `margin_available` / `available_margin`，三者都没有时退到 `withdraw_available`。
 */
export function parseAccountSnapshot(
  raw: unknown,
  accountId: AccountId,
  now: Ms,
  accountModel: 'standard' | 'unified' | 'portfolio' = 'unified',
): AccountSnapshot {
  const rows = balanceRows(raw)
  const top = balanceTop(raw)
  const balances = rows.flatMap((row) => {
    const asset = upper(textOf(row.currency ?? row.margin_asset ?? 'USDT'))
    if (asset === '') return []
    const total = decimalOf(row.equity ?? row.margin_balance ?? row.margin_static)
    const available = decimalOf(row.available ?? row.margin_available ?? row.available_margin ?? row.withdraw_available)
    const hold = cmpDec(total, available) > 0 ? subDec(total, available) : asDecimal('0')
    return [{ accountId, asset, total, available, hold, ts: now }]
  })
  const primary = rows[0] ?? {}
  const equity = decimalOf(top.equity ?? primary.equity ?? primary.margin_balance ?? primary.margin_static)
  const available = decimalOf(top.available_margin ?? primary.available ?? primary.margin_available ?? primary.available_margin ?? primary.withdraw_available)
  const initialMargin = decimalOf(top.initial_margin ?? primary.initial_margin ?? primary.margin_position)
  const maintenanceMargin = decimalOf(top.maintenance_margin ?? primary.maintenance_margin)
  const ratio = Number(equity) > 0 ? (Number(initialMargin) / Number(equity)).toFixed(8) : '0'
  const margin: MarginSnapshot = {
    accountId,
    model: accountModel,
    // 官方 v5 余额页注明 equity 等字段以 USD 计；v1 的保证金资产是 USDT。
    valuationCcy: accountModel === 'standard' ? 'USDT' : 'USD',
    equity,
    initialMargin,
    maintenanceMargin,
    available,
    marginRatio: decimalOf(ratio),
    leverage: 0,
    ts: now,
  }
  return { accountModel, balances, margin, positions: [], ts: now, source: 'rest', availableDeductsOpenOrders: true }
}

// ---- 持仓 -------------------------------------------------------------------

export interface RawPosition {
  contract_code?: string
  symbol?: string
  direction?: string
  position_side?: string
  volume?: string | number
  available?: string | number
  cost_open?: string
  cost_hold?: string
  open_avg_price?: string
  mark_price?: string
  last_price?: string
  profit_unreal?: string
  profit_rate?: string
  lever_rate?: string | number
  margin_mode?: string
  position_margin?: string
  liquidation_price?: string
  liq_price?: string
  created_at?: string | number
  created_time?: string | number
  updated_at?: string | number
  updated_time?: string | number
  position_mode?: string
}

function positionRows(raw: unknown): RawPosition[] {
  if (Array.isArray(raw)) return raw.filter((r): r is RawPosition => !!r && typeof r === 'object')
  if (!raw || typeof raw !== 'object') return []
  const env = raw as { positions?: unknown; list?: unknown; data?: unknown; contract_code?: string }
  for (const key of ['positions', 'list', 'data'] as const) {
    const nested = env[key]
    if (Array.isArray(nested)) return nested.filter((r): r is RawPosition => !!r && typeof r === 'object')
  }
  return typeof env.contract_code === 'string' ? [env as RawPosition] : []
}

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/live_trading/htx_v5.py:118-142; adapted.
/**
 * 一行持仓 → Position（volume = 0 的槽位跳过；数量换成币）。
 * 官方字段：v5 入场价 `open_avg_price`、标记价 `mark_price`、方向看 `position_side`（long/short）否则看 `direction`；
 * v1 只有 `cost_open / cost_hold` 与 `last_price`。
 */
export function parsePosition(row: RawPosition, accountId: AccountId, now: Ms, contractSizeOf: ContractSizeOf = () => undefined): Position | null {
  const code = upper(textOf(row.contract_code ?? row.symbol))
  if (code === '') return null
  const volume = num(row.volume)
  if (!Number.isFinite(volume) || volume === 0) return null
  const size = baseSizeOf(volume, contractSizeOf(code), code)
  const direction = textOf(row.direction).trim().toLowerCase()
  const side = textOf(row.position_side).trim().toLowerCase()
  const short = side === 'short' ? true : side === 'long' ? false : direction === 'sell'
  const markPrice = decimalOf(row.mark_price ?? row.last_price)
  const opened = num(row.created_at ?? row.created_time)
  const updated = num(row.updated_at ?? row.updated_time)
  const liq = num(row.liquidation_price ?? row.liq_price)
  return {
    accountId,
    instrumentId: instrumentIdOf(code),
    side: short ? 'short' : 'long',
    size,
    entryPrice: decimalOf(row.open_avg_price ?? row.cost_open ?? row.cost_hold),
    markPrice,
    notional: absDecimal(mulDec(String(size), String(markPrice))),
    unrealizedPnl: decimalOf(row.profit_unreal),
    realizedPnl: asDecimal('0'),
    leverage: Math.max(1, Math.round(num(row.lever_rate) || 1)),
    marginMode: textOf(row.margin_mode).trim().toLowerCase() === 'isolated' ? 'isolated' : 'cross',
    liquidationPrice: Number.isFinite(liq) && liq > 0 ? decimalOf(row.liquidation_price ?? row.liq_price) : null,
    fundingSinceOpen: asDecimal('0'),
    openedAt: Number.isFinite(opened) && opened > 0 ? Math.round(opened) : now,
    updatedAt: Number.isFinite(updated) && updated > 0 ? Math.round(updated) : now,
  }
}

export function parsePositions(raw: unknown, accountId: AccountId, now: Ms, contractSizeOf: ContractSizeOf = () => undefined): Position[] {
  const out: Position[] = []
  for (const row of positionRows(raw)) {
    const parsed = parsePosition(row, accountId, now, contractSizeOf)
    if (parsed) out.push(parsed)
  }
  return out
}

// ---- 订单 -------------------------------------------------------------------

export interface RawOrder {
  /** v5 挂单数组里的查询号。 */
  id?: number | string
  order_id?: number | string
  order_id_str?: string
  client_order_id?: number | string
  contract_code?: string
  symbol?: string
  side?: string
  direction?: string
  offset?: string
  volume?: string | number
  trade_volume?: string | number
  price?: string
  order_price_type?: string
  type?: string
  status?: number | string
  state?: string
  lever_rate?: string | number
  created_at?: string | number
  created_time?: string | number
  fee?: string
  reduce_only?: number | string | boolean
  tp_trigger_price?: string
  sl_trigger_price?: string
}

/** 挂单类型：本包只发 limit / ioc / fok / post_only 与止盈止损委托，其余按 unknown。 */
export function mapOpenOrderType(row: RawOrder): VenueOpenOrder['type'] {
  const priceType = textOf(row.order_price_type ?? row.type).trim().toLowerCase()
  if (row.tp_trigger_price !== undefined || row.sl_trigger_price !== undefined) {
    return priceType === 'limit' ? 'take_limit' : 'take_market'
  }
  return priceType === 'limit' || priceType === 'post_only' ? 'limit' : priceType === '' ? 'unknown' : 'limit'
}

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/live_trading/htx.py:944-969; adapted.
/**
 * 挂单一行 → VenueOpenOrder（剩余量 = volume − trade_volume，单位换成币）。
 * v1 行：direction / offset / order_price_type / created_at / reduce_only(int)；
 * v5 行：side / type / created_time / reduce_only(bool) / 字符串 volume 与 trade_volume。
 */
export function parseOpenOrder(row: RawOrder, contractSizeOf: ContractSizeOf = () => undefined, family: 'v1' | 'v5' = 'v1'): VenueOpenOrder | null {
  const code = upper(textOf(row.contract_code ?? row.symbol))
  if (code === '') return null
  const orderId = row.order_id_str !== undefined && row.order_id_str !== ''
    ? textOf(row.order_id_str)
    : row.order_id !== undefined && row.order_id !== null && textOf(row.order_id) !== '0'
      ? textOf(row.order_id)
      : ''
  if (orderId === '') return null
  const total = num(row.volume)
  const done = num(row.trade_volume)
  if (!Number.isFinite(total)) return null
  const remainingContracts = Math.max(0, Math.round(total) - (Number.isFinite(done) ? Math.round(done) : 0))
  const size = baseSizeOf(remainingContracts, contractSizeOf(code), code)
  const origSize = baseSizeOf(total, contractSizeOf(code), code)
  const created = num(family === 'v5' ? row.created_time ?? row.created_at : row.created_at ?? row.created_time)
  const price = num(row.price)
  const clientRaw = row.client_order_id
  const sideRaw = family === 'v5' ? row.side ?? row.direction : row.direction ?? row.side
  return {
    instrumentId: instrumentIdOf(code),
    venueOrderId: orderId,
    clientOrderId: clientRaw !== undefined && String(clientRaw) !== '' && String(clientRaw) !== '0' ? String(clientRaw) : null,
    side: String(sideRaw ?? '').trim().toLowerCase() === 'sell' ? 'sell' : 'buy',
    type: mapOpenOrderType(row),
    price: Number.isFinite(price) && price > 0 ? decimalOf(row.price) : null,
    triggerPrice: row.tp_trigger_price !== undefined
      ? decimalOf(row.tp_trigger_price)
      : row.sl_trigger_price !== undefined
        ? decimalOf(row.sl_trigger_price)
        : null,
    size,
    origSize,
    reduceOnly: row.reduce_only === true || row.reduce_only === 1 || row.reduce_only === '1' || textOf(row.offset) === 'close',
    isTrigger: row.tp_trigger_price !== undefined || row.sl_trigger_price !== undefined,
    createdAt: Number.isFinite(created) && created > 0 ? Math.round(created) : 0,
  }
}

/** 单张订单状态（v1 的 status 码 / v5 的 state 字符串都接；原样保留上游状态文本）。 */
export function parseOrderStatusResult(row: RawOrder | null | undefined, contractSizeOf: ContractSizeOf = () => undefined): VenueOrderStatus {
  if (!row || typeof row !== 'object') return { found: false }
  const orderId = row.order_id_str ?? row.order_id
  if (orderId === undefined || orderId === null || textOf(orderId) === '' || textOf(orderId) === '0') return { found: false }
  const rawStatus = row.status ?? row.state
  const filled = row.trade_volume !== undefined ? num(row.trade_volume) : NaN
  const code = upper(textOf(row.contract_code ?? row.symbol))
  const filledSize = baseSizeOf(Number.isFinite(filled) ? filled : 0, contractSizeOf(code), code)
  return {
    found: true,
    status: rawStatus !== undefined ? String(rawStatus) : orderStatusOf(rawStatus),
    venueOrderId: String(orderId),
    filledSize,
    raw: row,
  }
}

/** v1 订单查询的 data 可能是数组（官方 order_info 返回 list）。 */
export function firstOrderRow(raw: unknown): RawOrder | null {
  if (Array.isArray(raw)) {
    const first = raw.find((r) => r && typeof r === 'object')
    return (first as RawOrder | undefined) ?? null
  }
  if (raw && typeof raw === 'object') return raw as RawOrder
  return null
}

// ---- 成交 -------------------------------------------------------------------

/**
 * 成交行（两套官方字段并存）：
 *   v1 matchresults_exact：id / match_id / query_id / order_id / order_id_str / direction / offset /
 *     trade_volume / trade_price / trade_turnover / trade_fee / offset_profitloss / real_profit /
 *     create_date / role / fee_asset / margin_mode / reduce_only；
 *   v5 order/details：trade_id / id / order_id / side / position_side / order_type / type /
 *     trade_price / trade_volume / trade_turnover / trade_fee / role / fee_currency / profit / created_time。
 */
export interface RawTrade {
  /** v1 的唯一成交号；v5 的查询号。 */
  id?: number | string
  trade_id?: number | string
  match_id?: number | string
  query_id?: number | string
  contract_code?: string
  symbol?: string
  direction?: string
  side?: string
  offset?: string
  trade_volume?: string | number
  trade_price?: string
  trade_fee?: string
  create_date?: string | number
  created_time?: string | number
  role?: string
  fee_asset?: string
  fee_currency?: string
  real_profit?: string
  profit?: string
  order_id?: number | string
  order_id_str?: string
  client_order_id?: number | string
}

/** v1 成交记录端点的 data 形状（trades + 分页）；v5 的 data 直接是数组。 */
export interface RawTradesEnvelope {
  trades?: RawTrade[]
  remain_size?: number
  next_id?: number | string | null
}

function tradeRows(raw: unknown): RawTrade[] {
  if (Array.isArray(raw)) return raw.filter((r): r is RawTrade => !!r && typeof r === 'object')
  if (!raw || typeof raw !== 'object') return []
  const env = raw as { trades?: unknown; data?: unknown; order_id?: unknown; id?: unknown; trade_id?: unknown }
  if (Array.isArray(env.trades)) return env.trades.filter((r): r is RawTrade => !!r && typeof r === 'object')
  if (Array.isArray(env.data)) return env.data.filter((r): r is RawTrade => !!r && typeof r === 'object')
  // 单行形状（v1 / v5 都是数组，这里只做容错）
  return env.order_id !== undefined || env.id !== undefined || env.trade_id !== undefined ? [env as RawTrade] : []
}

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/live_trading/htx.py:1020-1069; adapted.
/**
 * 成交记录一行 → VenueFill。
 *   · 去重键 = 场所成交号（v1 `id` / v5 `trade_id`）；
 *   · v1 的 `trade_fee` 对扣费是负数（官方示例 -2.42778），协议要「正 = 付出」，所以取反；
 *   · v5 的 `trade_fee` 官方示例是正数（0.01884），按原样保存——符号未经真网核实；
 *   · 数量一律 trade_volume（张）× 面值。
 */
export function parseTrade(
  row: RawTrade,
  now: Ms,
  contractSizeOf: ContractSizeOf = () => undefined,
  family: 'v1' | 'v5' = 'v1',
): VenueFill | null {
  const code = upper(textOf(row.contract_code ?? row.symbol))
  if (code === '') return null
  const tradeId = family === 'v5' ? row.trade_id ?? row.id : row.id
  if (tradeId === undefined || tradeId === null || String(tradeId) === '') return null
  const volume = num(row.trade_volume)
  if (!Number.isFinite(volume) || volume <= 0) return null
  const size = baseSizeOf(volume, contractSizeOf(code), code)
  const ts = num(family === 'v5' ? row.created_time : row.create_date)
  const feeRaw = decimalOf(row.trade_fee)
  // v1 的 trade_fee 是「付出为负」；取成协议的正 = 付出。v5 官方示例为正，原样保存。
  const fee = family === 'v1' && cmpDec(feeRaw, '0') !== 0 ? subDec('0', feeRaw) : feeRaw
  const role = textOf(row.role).trim().toLowerCase()
  const orderId = row.order_id_str ?? row.order_id
  const clientRaw = row.client_order_id
  const sideRaw = family === 'v5' ? row.side ?? row.direction : row.direction ?? row.side
  return {
    venueFillId: String(tradeId),
    venueOrderId: orderId !== undefined && orderId !== null ? String(orderId) : '',
    clientOrderId: clientRaw !== undefined && String(clientRaw) !== '' && String(clientRaw) !== '0' ? String(clientRaw) : null,
    instrumentId: instrumentIdOf(code),
    side: String(sideRaw ?? '').trim().toLowerCase() === 'sell' ? 'sell' : 'buy',
    price: decimalOf(row.trade_price),
    size,
    fee,
    feeCcy: upper(String(family === 'v5' ? row.fee_currency ?? 'USDT' : row.fee_asset ?? 'USDT')),
    liquidity: role === 'maker' ? 'maker' : 'taker',
    realizedPnl: decimalOf(family === 'v5' ? row.profit : row.real_profit),
    ts: Number.isFinite(ts) && ts > 0 ? Math.round(ts) : now,
  }
}

export function parseTrades(raw: unknown, now: Ms, contractSizeOf: ContractSizeOf = () => undefined, family: 'v1' | 'v5' = 'v1'): VenueFill[] {
  const out: VenueFill[] = []
  for (const row of tradeRows(raw)) {
    const parsed = parseTrade(row, now, contractSizeOf, family)
    if (parsed) out.push(parsed)
  }
  return out
}

/** 平仓标志：offset=close（双向）或有已实现盈亏（单向平仓）都算平仓行。 */
export function isClosingTrade(row: RawTrade): boolean {
  if (textOf(row.offset).trim().toLowerCase() === 'close') return true
  const profit = num(row.real_profit ?? row.profit)
  return Number.isFinite(profit) && profit !== 0
}

/** 协议 Decimal 的零值（诊断 / 测试用同一个来源）。 */
export const ZERO = asDecimal('0')
