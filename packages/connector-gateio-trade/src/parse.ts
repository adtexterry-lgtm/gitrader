// SPDX-License-Identifier: CPAL-1.0
// Gate.io USDT 永续响应 → 协议模型（纯函数，无状态；不发请求、不读环境）。
// 行情 / 合约元数据解析 **Copied from packages/connector-gateio-data/src/parse.ts** (CPAL-1.0)，以数据包为准；
// 本文件补交易连接器需要的部分：订单状态映射、持仓 / 余额 / 挂单 / 成交 / 订单详情、触发单（price_orders）、私有流归一。
// 口径来源：QD backend_api_python/app/services/live_trading/gate.py（合约元数据 :701-718、持仓 :860-870、
// 账户 :820-821、订单 :1014-1026、成交 :1028-1044、资金费 :673-694）、
// 触发单 :native_protection.py:273-322 / quick_trade/position_activity.py:121-136、
// 私有流 :execution_streams/normalizers.py、手续费 :execution_streams/normalizers.py:261-300。
// 单位：**对外一律「币数量」**（venueSizeUnit = base）。Gate 的 `size` 是张数，这里乘 quanto_multiplier 折成币数；
// 张币乘数拿不到就报 DATA_UNAVAILABLE，绝不按 1 折；反向换算只发生在 orders.ts（下单）与 parsePosition（读持仓）里。
import { asDecimal, makeProblem, normalizeDecimal } from '@gitrader/protocol'
import { addDec, div, fx, mulDec, str, subDec } from '@gitrader/protocol/decimal'
import type { Balance, Decimal, Instrument, MarginSnapshot, Ms, Position, Problem, ProblemName } from '@gitrader/protocol'
import type { AccountId } from '@gitrader/protocol'
import type { VenueFill, VenueOpenOrder, VenueOrderStatus } from '@gitrader/protocol/connector'
import {
  instrumentIdOf as dataInstrumentIdOf, num, parseInstrument as parseDataInstrument, symbolOf as dataSymbolOf,
} from '@gitrader/connector-gateio-data'
import type { RawContract } from '@gitrader/connector-gateio-data'
import { decodeClientOrderId } from './orders'

export {
  API_PREFIX, CANDLE_PAGE, DEFAULT_BASE_URL, FUNDING_INTERVAL_MS, MAX_CANDLES, VENUE,
} from '@gitrader/connector-gateio-data'
export const instrumentIdOf = dataInstrumentIdOf
export const symbolOf = dataSymbolOf
export const numOf = num

/** 交易连接器支持的订单类型（标的层面；能力声明见 capabilities.ts）。 */
export const SUPPORTED_ORDER_TYPES = ['market', 'limit', 'stop_market', 'stop_limit', 'take_market', 'take_limit'] as const
/** Gate 永续的 `tif`：gtc / ioc / fok / alo（alo = 只挂单，Gate 叫 poc）。 */
export const SUPPORTED_TIF = ['gtc', 'ioc', 'fok', 'alo'] as const
/** 触发价类型（price_orders 的 `trigger.price_type`：last / mark / index）。 */
export const SUPPORTED_TRIGGER_TYPES = ['mark', 'last', 'index'] as const

/** 带 Problem 的错误：内核按 problem.name / retryable 决定是否重试。 */
export class ProblemError extends Error {
  readonly problem: Problem
  constructor(problem: Problem) {
    super(problem.message)
    this.name = 'ProblemError'
    this.problem = problem
  }
}

export function problemError(name: ProblemName, message: string, extra: Partial<Problem> = {}): ProblemError {
  return new ProblemError(makeProblem(name, message, extra))
}

/**
 * 上游字段 → 文本。对象 / 数组 / 符号当缺失：`String({...})` 回显 "[object Object]"，
 * 带坏 `toString` 的对象（JSON 里 `{"toString":0}` 就够）会让 `String()` 抛 TypeError；
 * 非字符串直接 `.toLowerCase()` 同样是 TypeError。数字与布尔照旧转文本。
 */
export const textOf = (v: unknown): string => {
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return ''
}

// ---- 数值 -------------------------------------------------------------------

/** 宽松十进制文本 → 规范形；缺失 / 非法回落 '0'（对账不因一个坏字段整体失败）。 */
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

/** 有符号十进制：负数保留符号（持仓 / 现金流 / 成交方向需要）。 */
export function signedDecimalOf(value: unknown): Decimal {
  return decimalOf(value)
}

export const absDec = (d: Decimal): Decimal => (d.startsWith('-') ? asDecimal(d.slice(1)) : d)

/** contract → quanto_multiplier（拿不到返回 undefined；调用方不得按 1 折）。 */
export type MultiplierOf = (contract: string) => Decimal | undefined

/** 正的十进制；缺失 / 非法 / ≤ 0 → undefined。 */
export function positiveDecimalOf(value: unknown): Decimal | undefined {
  const d = decimalOf(value)
  return d === '0' || d.startsWith('-') ? undefined : d
}

/** 取乘数；拿不到就抛 DATA_UNAVAILABLE（QD gate.py:752-754 / :812-818 同样拒，绝不按 1 折）。 */
export function requireMultiplier(of: MultiplierOf, contract: string): Decimal {
  const m = of(contract)
  if (m === undefined) throw problemError('DATA_UNAVAILABLE', `quanto_multiplier unknown for ${contract}; refusing to convert Gate contracts to base size`)
  return m
}

/** 原始 /contracts 行 → contract → quanto_multiplier（含 in_delisting 的合约：下市中的持仓也要能折算）。 */
export function multipliersOf(raw: unknown): Map<string, Decimal> {
  const out = new Map<string, Decimal>()
  for (const row of Array.isArray(raw) ? raw : []) {
    if (row === null || typeof row !== 'object') continue
    const r = row as { name?: unknown; quanto_multiplier?: unknown }
    const m = positiveDecimalOf(r.quanto_multiplier)
    if (typeof r.name === 'string' && r.name !== '' && m !== undefined) out.set(r.name, m)
  }
  return out
}

/** Gate 的时间字段是**秒**（可带小数）：`"1539852480.123"` → 毫秒。 */
export function msOfSeconds(value: unknown, fallback: Ms): Ms {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.round(value * 1000)
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    if (Number.isFinite(n) && n > 0) return Math.round(n * 1000)
  }
  return fallback
}

/** 有的字段已经是毫秒（≥ 1e11 视为毫秒）：两种都给时按量级判断。 */
export function msOfEither(value: unknown, fallback: Ms): Ms {
  const raw = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN
  if (!Number.isFinite(raw) || raw <= 0) return fallback
  return Math.round(raw >= 100_000_000_000 ? raw : raw * 1000)
}

// ---- 合约元数据 --------------------------------------------------------------

/** 交易连接器用的标的记录：协议 Instrument + 下单需要的张数口径。 */
export interface InstrumentRecord {
  instrument: Instrument
  symbol: string
  /** `order_price_round`：最小价格变动。 */
  tick: Decimal
  /** `order_size_min` 原值（**张**，可能是 "0.1" 这种份额化合约）。 */
  orderSizeMin: string
  /** `quanto_multiplier`：一张 = 多少币。 */
  contractSize: Decimal
  /** 最小下单币数量 = order_size_min × contractSize。 */
  minSizeBase: Decimal
  maxLeverage?: number
  priceDecimals: number
  /** 张数的小数位（order_size_min 的 dp）。 */
  sizeDecimals: number
}

function decimalsOfText(d: string): number {
  const i = d.indexOf('.')
  return i < 0 ? 0 : d.length - i - 1
}

/** 一条合约 → 记录。行情侧的精度（tick / step / min）沿用数据包，不重复推导。 */
export function parseInstrumentRecord(c: RawContract, now: Ms): InstrumentRecord | undefined {
  const instrument = parseDataInstrument(c, now)
  if (!instrument) return undefined
  return recordFromInstrument(instrument, c as unknown as Record<string, unknown>)
}

/**
 * 已有协议 Instrument（例如数据包 listInstruments() 的产物）→ 交易记录。
 * `raw` 取 `quanto_multiplier`（张币乘数，必需）与 `order_size_min`（张数下限原值）。
 */
export function recordFromInstrument(instrument: Instrument, raw: Record<string, unknown>): InstrumentRecord | undefined {
  const contractSize = positiveDecimalOf(raw['quanto_multiplier'])
  // 缺乘数 = 不可交易：拿不到正的乘数就跳过，绝不按 1 折。
  if (contractSize === undefined) return undefined
  const orderSizeMin = positiveDecimalOf(raw['order_size_min']) ?? asDecimal('1')
  // 数量单位是币（venueSizeUnit = base）：对内核必须报 contractSize = 1——
  // 内核名义额 = size × price × contractSize（packages/kernel/src/normalize.ts:115）；
  // 张币乘数只留在 record.contractSize。
  const enriched: Instrument = {
    ...instrument,
    contractSize: asDecimal('1'),
    orderTypes: [...SUPPORTED_ORDER_TYPES],
    tif: [...SUPPORTED_TIF],
    triggerPriceTypes: [...SUPPORTED_TRIGGER_TYPES],
  }
  const tick = instrument.price.tick ?? asDecimal('0.00000001')
  return {
    instrument: enriched,
    symbol: instrument.symbol,
    tick,
    orderSizeMin,
    contractSize,
    minSizeBase: mulDec(orderSizeMin, contractSize),
    ...(enriched.maxLeverage !== undefined ? { maxLeverage: enriched.maxLeverage } : {}),
    priceDecimals: instrument.price.maxDecimals ?? decimalsOfText(tick),
    sizeDecimals: decimalsOfText(orderSizeMin),
  }
}

/** /contracts 的 data 数组 → 记录（非 normal 的在数据包解析层已被剔除）。 */
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

/**
 * 原生状态 → 内部状态集（Gate 永续只给 `open` / `finished` / `cancelled`，细节在 `finish_as`）。
 * 键一律小写；不认识的返回 null（调用方按「未知」处理，不猜成 open）。
 */
export const ORDER_STATUS_MAP: Record<string, MappedStatus> = {
  open: 'open',
  finished: 'filled',
  cancelled: 'cancelled',
  canceled: 'cancelled',
  expire: 'expired',
  expired: 'expired',
}

/** `finish_as` 细化了 finished 的语义（filled / cancelled / ioc / stp / reduce_only 等）。 */
export const FINISH_AS_MAP: Record<string, MappedStatus> = {
  filled: 'filled',
  cancelled: 'cancelled',
  ioc: 'cancelled',
  auto_deleveraging: 'cancelled',
  liquidated: 'cancelled',
  reduce_only: 'cancelled',
  stp: 'cancelled',
  unknown: 'cancelled',
}

export function mapOrderStatus(raw: string | undefined | null, finishAs?: string | undefined | null): MappedStatus | null {
  if (typeof raw !== 'string') return null
  const key = raw.trim().toLowerCase()
  const mapped = ORDER_STATUS_MAP[key] ?? null
  if (key === 'finished' && typeof finishAs === 'string') {
    const refined = FINISH_AS_MAP[finishAs.trim().toLowerCase()]
    if (refined !== undefined && refined !== 'filled') return refined
  }
  return mapped
}

/** 原生普通单 → VenueOpenOrder.type（触发单走 parsePriceOrder，不经这里）。 */
export function mapOpenOrderType(raw: string | undefined): VenueOpenOrder['type'] {
  const t = textOf(raw).trim().toLowerCase()
  if (t === 'limit' || t === '') return 'limit'
  if (t === 'market') return 'unknown'
  return 'unknown'
}

// ---- 持仓 -------------------------------------------------------------------

/** /futures/usdt/positions 的一行（字段名照官方；这是**持仓专用端点**，不是账户汇总里的残缺字段）。 */
export interface RawPosition {
  contract?: string
  size?: string | number
  leverage?: string | number
  cross_leverage_limit?: string | number
  mode?: string
  entry_price?: string
  mark_price?: string
  value?: string
  margin?: string
  maintenance_rate?: string
  maintenance_margin?: string
  unrealised_pnl?: string
  unrealized_pnl?: string
  realised_pnl?: string
  realized_pnl?: string
  liq_price?: string
  liqPrice?: string
  risk_limit_table?: string
  leverage_max?: string | number
  funding_rate?: string
  open_time?: string | number
  create_time?: string | number
  update_time?: string | number
}

/**
 * Gate apiv4：leverage = 0 是全仓（杠杆上限在 cross_leverage_limit），> 0 是逐仓（QD gate.py:899-910 同一约定）。
 * 铁律：杠杆缺失 / 非数字时**显式报错**（4005 DATA_UNAVAILABLE），绝不把 NaN 带进 Position
 * —— NaN 参与保证金 / 风险比较时全部为 false，闸门会静默放行。
 */
export function marginOfPositionRow(row: { leverage?: unknown; cross_leverage_limit?: unknown }): { mode: 'cross' | 'isolated'; leverage: number } {
  const lev = num(row.leverage)
  // leverage 读不出来时不许推断：NaN 会落进「全仓」分支，而全仓分支的 leverage 只是上限，
  // downstream 可能据此发 leverage=0 的改杠杆请求（在 Gate 上会把逐仓切成全仓）→ 直接 4005。
  if (!Number.isFinite(lev)) {
    throw problemError('DATA_UNAVAILABLE', `Gate position row has no usable leverage (leverage=${String(row.leverage)} is missing or not a number); refusing to infer the margin mode from cross_leverage_limit`)
  }
  const isolated = lev > 0
  const raw = isolated ? lev : num(row.cross_leverage_limit)
  const leverage = Math.round(raw)
  if (!Number.isFinite(leverage)) {
    throw problemError('DATA_UNAVAILABLE', `Gate position row has no usable leverage (leverage=${String(row.leverage)}, cross_leverage_limit=${String(row.cross_leverage_limit)}); refusing to carry NaN into Position`)
  }
  return { mode: isolated ? 'isolated' : 'cross', leverage }
}

export interface ParseContext {
  accountId: AccountId
  now: Ms
}

/**
 * 杠杆必须是有限数字：NaN / Infinity 会让保证金与风险比较全部为 false（闸门静默放行）。
 * marginOfPositionRow 已经拒绝缺失值，这里在 `Math.max` 之前再挡一次（双保险，不进 Position）。
 */
function finiteLeverage(leverage: number, where: string): number {
  if (!Number.isFinite(leverage)) {
    throw problemError('DATA_UNAVAILABLE', `Gate ${where}: leverage is not a finite number; refusing to publish a position with NaN leverage`)
  }
  return leverage
}

/**
 * 持仓行 → Position。
 *   · `size` 是**有符号张数**：正 = 多，负 = 空（QD gate.py:796-818 先取绝对值再乘 quanto_multiplier）；
 *   · 双仓模式下 `mode` 为 `dual_long` / `dual_short`，方向以它为准确认；
 *   · 零仓位行丢弃（`size == 0`）；
 *   · `value` 是名义价值（币 × 标记价），没有就用 mark_price × size 自己算；
 *   · 保证金模式 / 杠杆看持仓行的 `leverage` / `cross_leverage_limit`（leverage = 0 = 全仓）；
 *   · 维持保证金优先用 `maintenance_margin`，否则按 `maintenance_rate × 名义额` 折算，两者都没有就不给。
 */
export function parsePosition(row: RawPosition, ctx: ParseContext, contractSize: Decimal): Position | undefined {
  const contract = typeof row.contract === 'string' ? row.contract : undefined
  if (!contract) return undefined
  const contractsSigned = signedDecimalOf(row.size)
  if (contractsSigned === '0') return undefined
  const mode = textOf(row.mode).toLowerCase()
  const negative = contractsSigned.startsWith('-')
  const side: Position['side'] = mode === 'dual_long' ? 'long' : mode === 'dual_short' ? 'short' : negative ? 'short' : 'long'
  const sizeBase = mulDec(absDec(contractsSigned), contractSize)
  if (sizeBase === '0') return undefined
  const markPrice = decimalOf(row.mark_price)
  const entryPrice = decimalOf(row.entry_price)
  const valueRaw = decimalOf(row.value)
  const notional = valueRaw !== '0' ? absDec(valueRaw) : mulDec(sizeBase, markPrice)
  const margin = marginOfPositionRow(row)
  const leverage = Math.max(1, finiteLeverage(margin.leverage, 'position'))
  const initialMargin = decimalOf(row.margin)
  const liqRaw = decimalOf(row.liq_price ?? row.liqPrice)
  const rate = positiveDecimalOf(row.maintenance_rate)
  const mm = positiveDecimalOf(row.maintenance_margin) ?? (rate !== undefined && notional !== '0' ? mulDec(notional, rate) : undefined)
  return {
    accountId: ctx.accountId,
    instrumentId: instrumentIdOf(contract),
    side,
    size: sizeBase,
    entryPrice,
    markPrice,
    notional,
    unrealizedPnl: signedDecimalOf(row.unrealised_pnl ?? row.unrealized_pnl),
    realizedPnl: signedDecimalOf(row.realised_pnl ?? row.realized_pnl),
    leverage,
    marginMode: margin.mode,
    initialMargin,
    ...(mm !== undefined ? { maintenanceMargin: mm } : {}),
    liquidationPrice: liqRaw !== '0' ? absDec(liqRaw) : null,
    // Gate 持仓不暴露累计资金费；不编数字（README 写明）。
    fundingSinceOpen: asDecimal('0'),
    openedAt: msOfEither(row.open_time ?? row.create_time, ctx.now),
    updatedAt: msOfEither(row.update_time, ctx.now),
  }
}

/** 持仓数组 → Position[]；`multiplierOf` 是 contract → quanto_multiplier，拿不到就报错。 */
export function parsePositions(raw: unknown, ctx: ParseContext, multiplierOf: MultiplierOf): Position[] {
  if (!Array.isArray(raw)) return []
  const out: Position[] = []
  for (const row of raw) {
    if (!row || typeof row !== 'object') continue
    const item = row as RawPosition
    const contract = typeof item.contract === 'string' ? item.contract : ''
    if (contract === '') continue
    if (signedDecimalOf(item.size) === '0') continue
    const position = parsePosition(item, ctx, requireMultiplier(multiplierOf, contract))
    if (position) out.push(position)
  }
  return out
}

// ---- 账户 -------------------------------------------------------------------

/** /futures/usdt/accounts 的响应（单个对象，不是数组）。 */
export interface RawAccount {
  currency?: string
  total?: string
  unrealised_pnl?: string
  unrealized_pnl?: string
  position_margin?: string
  order_margin?: string
  available?: string
  point?: string
  bonus?: string
  in_dual_mode?: boolean
  position_mode?: string
  enable_credit?: boolean
  margin_mode?: string
  cross_leverage_limit?: string
}

export interface ParsedAccount {
  balances: Balance[]
  margin: MarginSnapshot
  /** Gate 的 `single` / `dual` / `dual_plus`；缺失回落 in_dual_mode 推导，仍取不到为空串。 */
  positionMode: string
}

/**
 * 账户 → 余额 + 保证金快照。
 *   · 可用余额取 `available`（Gate 的可用保证金，不是 total）；
 *   · 冻结 = position_margin + order_margin（Gate 用这两个字段表示占用）；
 *   · Gate FuturesAccount.total 不含未实现盈亏（官方字段说明：total = 累计出入金 + 已实现盈亏 + 资金费 + 手续费 + 返佣）；
 *     权益 = total + unrealised_pnl；Balance.total 仍是 `total`；
 *   · 初始保证金按持仓汇总（`initialMargin` 来自持仓行的 margin）；
 *   · 维持保证金 = 各持仓 `maintenanceMargin` 之和（持仓行给了 maintenance_rate / maintenance_margin 才算得出；都没有时为 0）。
 */
export function parseAccount(raw: unknown, ctx: ParseContext, positions: readonly Position[] = []): ParsedAccount {
  const row = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as RawAccount) : {}
  const asset = (textOf(row.currency) || 'USDT').toUpperCase()
  const total = decimalOf(row.total)
  const upnl = signedDecimalOf(row.unrealised_pnl ?? row.unrealized_pnl)
  const equity = addDec(total, upnl)
  const available = decimalOf(row.available)
  const positionMargin = decimalOf(row.position_margin)
  const orderMargin = decimalOf(row.order_margin)
  const hold = addDec(positionMargin, orderMargin)
  const balances: Balance[] = []
  if (total !== '0' || available !== '0' || hold !== '0') {
    balances.push({ accountId: ctx.accountId, asset, total, available, hold, ts: ctx.now })
  }
  let initialMargin = positionMargin
  if (initialMargin === '0') {
    for (const p of positions) {
      if (p.initialMargin !== undefined) initialMargin = addDec(initialMargin, p.initialMargin)
    }
  }
  let leverage = 0
  for (const p of positions) leverage = Math.max(leverage, p.leverage)
  let maintenanceMargin = asDecimal('0')
  for (const p of positions) if (p.maintenanceMargin !== undefined) maintenanceMargin = addDec(maintenanceMargin, p.maintenanceMargin)
  const mode = typeof row.position_mode === 'string' && row.position_mode !== ''
    ? row.position_mode.trim().toLowerCase()
    : row.in_dual_mode === true ? 'dual' : row.in_dual_mode === false ? 'single' : ''
  return {
    balances,
    margin: {
      accountId: ctx.accountId,
      model: 'standard',
      valuationCcy: asset,
      equity,
      initialMargin,
      maintenanceMargin,
      available,
      // 协议口径是「维持保证金 / 权益」；两边都是 0 时就是 0。
      marginRatio: fx(equity) > 0n ? asDecimal(str(div(fx(maintenanceMargin), fx(equity)))) : asDecimal('0'),
      leverage: leverage === 0 ? 1 : leverage,
      ts: ctx.now,
    },
    positionMode: mode,
  }
}

// ---- 挂单 -------------------------------------------------------------------

/** GET /futures/usdt/orders 的一行。`size` / `left` 都是**张数**（size 有符号）。 */
export interface RawOrder {
  id?: string | number
  id_string?: string
  text?: string
  contract?: string
  size?: string | number
  left?: string | number
  price?: string
  fill_price?: string
  status?: string
  finish_as?: string
  reduce_only?: boolean
  is_reduce_only?: boolean
  create_time?: string | number
  update_time?: string | number
  finish_time?: string | number
  type?: string
  role?: string
  fee?: string
  point_fee?: string
  filled_total?: string
}

/**
 * Gate 原生 status 只有 open / finished（细节在 finish_as）；落成内核 mapVenueStatus 认得的词，原文留在 raw。
 */
export function orderStatusWord(row: { status?: unknown; finish_as?: unknown; size?: unknown; left?: unknown }): string {
  const s = textOf(row.status).trim().toLowerCase()
  const size = absDec(decimalOf(row.size))
  const left = absDec(decimalOf(row.left))
  if (s === 'open') return fx(left) < fx(size) ? 'partially_filled' : 'open'
  if (s === 'finished') return textOf(row.finish_as).trim().toLowerCase() === 'filled' || left === '0' ? 'filled' : 'cancelled'
  return s
}

/** 挂单行 → VenueOpenOrder（剩余量 = |left| 张 × quanto_multiplier）。 */
export function parseOpenOrder(row: RawOrder, now: Ms, contractSize: Decimal): VenueOpenOrder | undefined {
  const contract = typeof row.contract === 'string' ? row.contract : undefined
  if (!contract) return undefined
  const orderId = row.id_string ?? row.id
  if (orderId === undefined || orderId === '') return undefined
  const sizeContracts = absDec(decimalOf(row.size))
  const leftContracts = absDec(decimalOf(row.left))
  const origSize = mulDec(sizeContracts, contractSize)
  const remaining = mulDec(leftContracts, contractSize)
  const price = decimalOf(row.price)
  return {
    instrumentId: instrumentIdOf(contract),
    venueOrderId: String(orderId),
    clientOrderId: decodeClientOrderId(row.text),
    side: decimalOf(row.size).startsWith('-') ? 'sell' : 'buy',
    type: mapOpenOrderType(row.type),
    price: price !== '0' ? price : null,
    triggerPrice: null,
    size: remaining,
    origSize,
    reduceOnly: row.reduce_only === true || row.is_reduce_only === true,
    isTrigger: false,
    createdAt: msOfEither(row.create_time, now),
  }
}

export function parseOpenOrders(raw: unknown, now: Ms, multiplierOf: MultiplierOf): VenueOpenOrder[] {
  if (!Array.isArray(raw)) return []
  const out: VenueOpenOrder[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const row = entry as RawOrder
    const contract = typeof row.contract === 'string' && row.contract !== '' ? row.contract : ''
    if (contract === '') continue
    const order = parseOpenOrder(row, now, requireMultiplier(multiplierOf, contract))
    if (order) out.push(order)
  }
  return out.sort((a, b) => a.createdAt - b.createdAt)
}

// ---- 成交 -------------------------------------------------------------------

/** GET /futures/usdt/my_trades 的一行（`size` 是**有符号张数**；平仓行 `close_size` 有值）。 */
export interface RawFill {
  id?: string | number
  create_time?: string | number
  create_time_ms?: string | number
  contract?: string
  order_id?: string
  size?: string | number
  price?: string
  role?: string
  text?: string
  fee?: string
  point_fee?: string
  close_size?: string | number
}

/** 成交行的时间戳（create_time_ms 优先，否则 create_time 按秒）：早于 sinceMs 的行要在查乘数之前就丢掉。 */
export function fillTsOf(row: { create_time?: unknown; create_time_ms?: unknown }, now: Ms): Ms {
  return row.create_time_ms !== undefined ? msOfEither(row.create_time_ms, now) : msOfSeconds(row.create_time, now)
}

/**
 * 成交行 → VenueFill。
 *   · 去重键 = `id`（**成交号**，QD 的 execution_streams 同一口径；不用时间戳）；
 *   · `size` 的符号给方向：正 = 买入，负 = 卖出；
 *   · 手续费不再取反：Gate 的 fee 正 = 付出、负 = 返佣，与协议同号（QD execution_streams/normalizers.py:261-300 不取反；
 *     tests/test_execution_stream_normalizers.py:231-263 断言 fee "0.12" 记 0.12 支出）；`point_fee` 是点卡抵扣，不并入现金手续费（README 写明）；
 *   · 零数量但有成交号的行**保留**（平仓尾笔会这样），交给内核按号去重。
 */
export function parseFill(row: RawFill, now: Ms, contractSize: Decimal): VenueFill | undefined {
  const contract = typeof row.contract === 'string' ? row.contract : undefined
  if (!contract) return undefined
  const id = row.id === undefined || row.id === '' ? '' : String(row.id)
  const venueFillId = id === '' ? '' : `${contract}:${id}`
  const contractsSigned = decimalOf(row.size)
  const sizeBase = mulDec(absDec(contractsSigned), contractSize)
  if (venueFillId === '' && sizeBase === '0') return undefined
  return {
    venueFillId,
    venueOrderId: String(row.order_id ?? ''),
    clientOrderId: decodeClientOrderId(row.text),
    instrumentId: instrumentIdOf(contract),
    side: contractsSigned.startsWith('-') ? 'sell' : 'buy',
    price: decimalOf(row.price),
    size: sizeBase,
    fee: decimalOf(row.fee),
    feeCcy: 'USDT',
    liquidity: textOf(row.role).toLowerCase() === 'maker' ? 'maker' : 'taker',
    realizedPnl: asDecimal('0'),
    ts: fillTsOf(row, now),
    ...(isLiquidationText(row.text) ? { liquidation: true } : {}),
  }
}

/** Gate 期货订单 text 的保留值：liquidation（强平）/ auto_deleveraging（自动减仓）。 */
export function isLiquidationText(text: unknown): boolean { return text === 'liquidation' || text === 'auto_deleveraging' }

export function parseFills(raw: unknown, now: Ms, multiplierOf: MultiplierOf): VenueFill[] {
  if (!Array.isArray(raw)) return []
  const out: VenueFill[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const row = entry as RawFill
    const contract = typeof row.contract === 'string' && row.contract !== '' ? row.contract : ''
    if (contract === '') continue
    const fill = parseFill(row, now, requireMultiplier(multiplierOf, contract))
    if (fill) out.push(fill)
  }
  return out.sort((a, b) => a.ts - b.ts)
}

// ---- 单张订单详情 ------------------------------------------------------------

export interface RawOrderDetail extends RawOrder {
  finish_time?: string | number
}

/**
 * 详情行 → VenueOrderStatus。`status` 落成内核 mapVenueStatus 认得的词（原文留在 raw）；成交数量按
 * (|size| − |left|) × quanto_multiplier 折成币数（QD gate.py:1074-1090 的同一算法）。
 */
export function parseOrderDetail(data: unknown, contractSize: Decimal): VenueOrderStatus {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return { found: false }
  const row = data as RawOrderDetail
  const orderId = row.id_string ?? row.id
  const status = row.status
  if (orderId === undefined && status === undefined) return { found: false }
  const sizeContracts = absDec(decimalOf(row.size))
  const leftContracts = absDec(decimalOf(row.left))
  const filledContracts = subDec(sizeContracts, leftContracts)
  const filled = filledContracts.startsWith('-') ? asDecimal('0') : mulDec(filledContracts, contractSize)
  return {
    found: true,
    ...(status !== undefined ? { status: orderStatusWord(row) } : {}),
    ...(orderId !== undefined ? { venueOrderId: String(orderId) } : {}),
    filledSize: filled,
    raw: data,
  }
}

// ---- 触发单行（price_orders） ---------------------------------------------------

export interface RawPriceOrder {
  id?: unknown; id_string?: unknown; status?: unknown; finish_as?: unknown; create_time?: unknown; order_type?: unknown
  initial?: { contract?: unknown; size?: unknown; amount?: unknown; price?: unknown; tif?: unknown; reduce_only?: unknown; is_reduce_only?: unknown; auto_size?: unknown }
  trigger?: { price?: unknown; rule?: unknown; price_type?: unknown }
}

/** 触发单的 venueOrderId 一律带 `po:` 前缀（与普通单号区分，撤 / 查据此走 /price_orders）。 */
export const PRICE_ORDER_PREFIX = 'po:'
export function priceOrderIdOf(row: { id?: unknown; id_string?: unknown }): string | undefined {
  const id = row.id_string ?? row.id
  return id === undefined || id === null || String(id) === '' ? undefined : `${PRICE_ORDER_PREFIX}${String(id)}`
}

/**
 * price_orders 行 → VenueOpenOrder（QD quick_trade/position_activity.py:121-136 的口径）：
 * 方向 = initial.size（或 amount）的符号，size 为 0 时看 auto_size（close_long = 卖）；
 * rule 1 = 价格 ≥ 触发价、2 = 价格 ≤ 触发价：卖单 rule 2 是止损、rule 1 是止盈；买单反过来；initial.price 为 0 = 触发后市价。
 */
export function parsePriceOrder(row: RawPriceOrder, now: Ms, contractSize: Decimal, clientIdOf: (venueOrderId: string) => string | null): VenueOpenOrder | undefined {
  const initial = row.initial ?? {}
  const trigger = row.trigger ?? {}
  const contract = typeof initial.contract === 'string' ? initial.contract : undefined
  const venueOrderId = priceOrderIdOf(row)
  if (!contract || venueOrderId === undefined) return undefined
  const signed = decimalOf(initial.size ?? initial.amount)
  const side: 'buy' | 'sell' = signed.startsWith('-') || initial.auto_size === 'close_long' ? 'sell' : 'buy'
  const rule = Number(trigger.rule)
  const stop = side === 'sell' ? rule === 2 : rule === 1
  const limitPrice = decimalOf(initial.price)
  const market = limitPrice === '0'
  const size = mulDec(absDec(signed), contractSize)
  const orderType = String(row.order_type ?? '')
  return {
    instrumentId: instrumentIdOf(contract),
    venueOrderId,
    clientOrderId: clientIdOf(venueOrderId),
    side,
    type: stop ? (market ? 'stop_market' : 'stop_limit') : (market ? 'take_market' : 'take_limit'),
    price: market ? null : limitPrice,
    triggerPrice: decimalOf(trigger.price),
    size,
    origSize: size,
    reduceOnly: initial.is_reduce_only === true || initial.reduce_only === true || orderType.startsWith('plan-close-') || orderType.startsWith('close-'),
    isTrigger: true,
    createdAt: msOfEither(row.create_time, now),
  }
}

export function parsePriceOrders(raw: unknown, now: Ms, multiplierOf: MultiplierOf, clientIdOf: (venueOrderId: string) => string | null): VenueOpenOrder[] {
  if (!Array.isArray(raw)) return []
  const out: VenueOpenOrder[] = []
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue
    const row = entry as RawPriceOrder
    const contract = typeof row.initial?.contract === 'string' ? row.initial.contract : ''
    if (contract === '') continue
    const order = parsePriceOrder(row, now, requireMultiplier(multiplierOf, contract), clientIdOf)
    if (order) out.push(order)
  }
  return out.sort((a, b) => a.createdAt - b.createdAt)
}

/** price_orders 的 status / finish_as → 内核认得的词。 */
export function priceOrderStatusWord(status: unknown, finishAs: unknown): string {
  const s = textOf(status).trim().toLowerCase()
  const f = textOf(finishAs).trim().toLowerCase()
  if (s === 'open' || s === 'inactive') return 'untriggered'
  if (s === 'finished') return f === 'succeeded' ? 'triggered' : f === 'expired' ? 'expired' : f === 'failed' ? 'rejected' : 'cancelled'
  if (s === 'invalid') return 'rejected'
  return s
}

// ---- 私有流归一 --------------------------------------------------------------

/** 私有流一条事件（保留成交号 = 去重键、执行类型、零仓位的平仓行）。 */
export interface GateExecEvent {
  channel: 'usertrades' | 'orders'
  venueFillId: string
  venueOrderId: string
  clientOrderId: string | null
  instrumentId: string
  side: 'buy' | 'sell'
  price: Decimal
  size: Decimal
  fee: Decimal
  feeCcy: string
  liquidity: 'maker' | 'taker'
  status: string
  mapped: MappedStatus | null
  ts: Ms
  /** 强平 / 自动减仓成交。 */
  liquidation?: true
}

/** 持仓推送一条（size 为 0 的平仓行保留为 side = 'flat'）。 */
export interface GatePositionEvent {
  instrumentId: string
  side: 'long' | 'short' | 'flat'
  size: Decimal
  marginMode: 'cross' | 'isolated'
  leverage: number
  entryPrice: Decimal
  ts: Ms
}

/** 余额推送一条：只有 balance（变动后的总额）与 change，没有「可用」。 */
export interface GateBalanceEvent {
  asset: string
  total: Decimal
  change: Decimal
  reason: string
  ts: Ms
}

/**
 * Gate 私有流 → 归一事件。
 * Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/execution_streams/normalizers.py; adapted.
 *   · 认 `futures.usertrades`（成交）/ `futures.orders`（订单）/ `futures.positions` / `futures.balances`，其它 channel 三个数组都为空；
 *   · **保留成交号**（`id`）作为去重键，也是内核 fillId 的来源；
 *   · **保留零数量的平仓行**：`size` 为 0 但有 `id` 时照样产出（平仓尾笔会这样），只有既无号又无量的才丢；
 *   · 执行类型（`role` maker / taker）原样带出；手续费与 Gate 同号（正 = 付出，不取反）；
 *   · `size` 的符号给方向，数量折成币数（张币乘数必需，拿不到就报 DATA_UNAVAILABLE）；
 *   · 零仓位的持仓推送保留为 side = 'flat'（这种行不查乘数）。
 */
export function normalizeGateEvent(
  payload: unknown,
  opts: { now?: Ms; contractSize: MultiplierOf },
): { channel: string; events: GateExecEvent[]; positions: GatePositionEvent[]; balances: GateBalanceEvent[] } {
  const body = payload !== null && typeof payload === 'object' ? (payload as { channel?: unknown; result?: unknown }) : {}
  const channelRaw = String(body.channel ?? '')
  const channel = channelRaw.replace(/^futures\./, '')
  const now = opts.now ?? Date.now()
  const rows = Array.isArray(body.result) ? body.result : []
  const events: GateExecEvent[] = []
  const positions: GatePositionEvent[] = []
  const balances: GateBalanceEvent[] = []
  if (channel !== 'usertrades' && channel !== 'orders' && channel !== 'positions' && channel !== 'balances') {
    return { channel: channelRaw, events, positions, balances }
  }
  for (const item of rows) {
    if (item === null || typeof item !== 'object') continue
    const row = item as Record<string, unknown>
    if (channel === 'positions') {
      const contract = String(row['contract'] ?? '')
      if (contract === '') continue
      const signed = signedDecimalOf(row['size'])
      const margin = marginOfPositionRow(row)
      const leverage = Math.max(1, finiteLeverage(margin.leverage, 'positions stream'))
      const ts = msOfEither(row['time_ms'] ?? row['time'], now)
      const entryPrice = decimalOf(row['entry_price'])
      if (signed === '0') {
        positions.push({ instrumentId: instrumentIdOf(contract), side: 'flat', size: asDecimal('0'), marginMode: margin.mode, leverage, entryPrice, ts })
        continue
      }
      const mode = textOf(row['mode']).toLowerCase()
      const side: GatePositionEvent['side'] = mode === 'dual_long' ? 'long' : mode === 'dual_short' ? 'short' : signed.startsWith('-') ? 'short' : 'long'
      positions.push({
        instrumentId: instrumentIdOf(contract),
        side,
        size: mulDec(absDec(signed), requireMultiplier(opts.contractSize, contract)),
        marginMode: margin.mode,
        leverage,
        entryPrice,
        ts,
      })
      continue
    }
    if (channel === 'balances') {
      balances.push({
        asset: (textOf(row['currency']) || 'USDT').toUpperCase(),
        total: decimalOf(row['balance']),
        change: signedDecimalOf(row['change']),
        reason: String(row['type'] ?? row['text'] ?? ''),
        ts: msOfEither(row['time_ms'] ?? row['time'], now),
      })
      continue
    }
    const contractsSigned = decimalOf(row['size'])
    const id = row['id'] === undefined || row['id'] === '' ? '' : String(row['id'])
    if (id === '' && contractsSigned === '0') continue
    const contract = String(row['contract'] ?? '')
    if (contract === '') continue
    const status = String(row['status'] ?? '')
    const usertrades = channel === 'usertrades'
    events.push({
      channel: usertrades ? 'usertrades' : 'orders',
      venueFillId: usertrades && id !== '' ? `${contract}:${id}` : '',
      venueOrderId: usertrades ? String(row['order_id'] ?? '') : String(row['id_string'] ?? row['id'] ?? ''),
      clientOrderId: decodeClientOrderId(row['text']),
      instrumentId: instrumentIdOf(contract),
      side: contractsSigned.startsWith('-') ? 'sell' : 'buy',
      price: decimalOf(row['price'] ?? row['fill_price']),
      size: mulDec(absDec(contractsSigned), requireMultiplier(opts.contractSize, contract)),
      fee: decimalOf(row['fee']),
      feeCcy: 'USDT',
      liquidity: textOf(row['role']).toLowerCase() === 'maker' ? 'maker' : 'taker',
      status,
      mapped: mapOrderStatus(status, String(row['finish_as'] ?? '')),
      ts: row['create_time_ms'] !== undefined
        ? msOfEither(row['create_time_ms'], now)
        : msOfSeconds(row['create_time'] ?? row['update_time'] ?? row['finish_time'], now),
      ...(usertrades && isLiquidationText(row['text']) ? { liquidation: true } : {}),
    })
  }
  return { channel: channelRaw, events, positions, balances }
}

// ---- 资金费 -----------------------------------------------------------------

/** GET /futures/usdt/account_book（type=fund）的一行。 */
export interface RawFundingRow {
  id?: string
  time?: string | number
  contract?: string
  change?: string
  type?: string
}

export interface FundingRow {
  id: string
  contract: string
  /** 现金流符号（正 = 收到）。Gate 的 `change` 已是现金流符号。 */
  amount: Decimal
  asset: string
  ts: Ms
}

/** 资金费流水（QD gate.py:673-694 的同一端点与字段）。 */
export function parseFundingRows(raw: unknown, fallbackContract = ''): FundingRow[] {
  const rows = Array.isArray(raw) ? raw : []
  const out: FundingRow[] = []
  for (const entry of rows) {
    if (!entry || typeof entry !== 'object') continue
    const row = entry as RawFundingRow
    const amount = signedDecimalOf(row.change)
    const ts = msOfSeconds(row.time, 0)
    out.push({
      id: String(row.id ?? `${ts}:${amount}`),
      contract: String(row.contract ?? fallbackContract),
      amount,
      asset: 'USDT',
      ts,
    })
  }
  return out.sort((a, b) => a.ts - b.ts)
}
