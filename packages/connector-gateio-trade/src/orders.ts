// SPDX-License-Identifier: CPAL-1.0
// OrderIntent → Gate.io USDT 永续线上请求体（纯函数，无网络、无签名；单测直接断言字节形状）。
// 口径来源（QD backend_api_python/app/services/live_trading/gate.py）：
//   · 市价单 :930-964：body = {contract, size, price:"0", tif:"ioc"}（+ reduce_only / text）；
//   · 限价单 :966-1007：body = {contract, size, price:<定点字符串>, tif:"gtc"}（+ reduce_only / text）；
//   · `size` 是**有符号张数**：base 数量 ÷ quanto_multiplier，份额化合约按 order_size_min 的精度截断并带
//     `X-Gate-Size-Decimal: 1`（QD :730-782）；
//   · `text` = 客户端订单号：32 位内核十六进制号编成 `t-` + base64url(16 字节)，其它字符串只留 `[0-9A-Za-z-_.]`
//     并补 `t-`，截到 28 字符（QD :91-104）；
//   · 触发单走 `POST /api/v4/futures/usdt/price_orders`（QD native_protection.py:273-322）：initial + trigger，
//     不带 text（Gate 触发单没有客户端单号）；
//   · 价格必须是定点文本（`_gate_decimal_text`，QD :32-38），绝不允许 1e-05 这种科学计数法。
// Gitrader 口径（工单通用教训 4）：**市价意图必须带 maxSlippageBps**，实际发「价带限价 + tif=ioc」
// （照 packages/connector-hyperliquid/src/orders.ts:122 与 limit-safety.ts），所以能力声明里 market = emulated。
import { randomBytes } from 'node:crypto'
import { makeProblem } from '@gitrader/protocol'
import type { Decimal, OrderIntent, Problem } from '@gitrader/protocol'
import { asDecimal, normalizeDecimal } from '@gitrader/protocol'
import { div, fx, mulDec, str } from '@gitrader/protocol/decimal'
import { ProblemError } from './errors'
import type { InstrumentRecord } from './parse'
import { applyBps, signedContracts, snapToTick, toFx, truncateToStep } from './precision'

/** Gate 永续的 `tif`：gtc / ioc / poc（只挂单）/ fok。 */
export type GateTif = 'gtc' | 'ioc' | 'poc' | 'fok'

export interface BuildOptions {
  /** 是否带 `X-Gate-Size-Decimal: 1`（由 signedContracts 决定，调用方可覆盖用于测试）。 */
  forceDecimalHeader?: boolean
}

/** 下单参考价（买卖价与中间价；陈旧时拒绝市价模拟）。 */
export interface PriceRef {
  bid?: number
  ask?: number
  mid?: number
  stale?: boolean
}

export interface TriggerFingerprint { contract: string; rule: 1 | 2; triggerPrice: Decimal; size: string }

export interface BuiltOrder {
  /** order = 普通单（/orders），price_order = 触发单（/price_orders）。 */
  kind: 'order' | 'price_order'
  /** 线上路径（普通单或触发单）。 */
  path: string
  body: Record<string, unknown>
  /** 原始（未编码）客户端订单号；普通单会再编成 `text`。 */
  clientOrderId: string
  /** 需要附加的请求头（份额化合约需要 `X-Gate-Size-Decimal`）。 */
  headers: Record<string, string>
  reduceOnly: boolean
  /** 价格 / 数量被规整时记录原值与新值，供回执展示。 */
  rounded?: { field: string; from: string; to: string }[]
  /** 原始 size（张数，带符号）与请求的币数量（诊断 / 测试用）。 */
  sizeContracts: string
  sizeBase: Decimal
  /** 原生合约名与张币乘数。 */
  contract: string
  contractSize: Decimal
  /** 普通单的 body.text（编码后的客户端订单号）。 */
  text?: string
  /** 触发单的指纹（3006 后按它找回触发单）。 */
  fingerprint?: TriggerFingerprint
}

export class OrderBuildError extends ProblemError {
  constructor(problem: Problem) {
    super(problem)
    this.name = 'OrderBuildError'
  }
}

const bad = (name: Parameters<typeof makeProblem>[0], message: string, extra: Partial<Problem> = {}): Problem => makeProblem(name, message, extra)
const fail = (p: Problem): never => {
  throw new OrderBuildError(p)
}

/**
 * Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/live_trading/gate.py:91-104; adapted.
 * Gate 的 `text`（客户端订单号）：只留 `[0-9A-Za-z-_.]`，补 `t-` 前缀，截到 28 字符。
 * 清洗后为空时用随机串兜底（绝不发空 text）。
 */
export function sanitizeText(id: string, maxLength = 28): string {
  const cleaned = [...id].filter((ch) => /[0-9A-Za-z\-_.]/.test(ch)).join('')
  const body = cleaned === '' ? `gt${randomBytes(6).toString('hex')}` : cleaned
  const prefixed = body.startsWith('t-') ? body : `t-${body}`
  return prefixed.slice(0, maxLength)
}

const HEX32 = /^[0-9a-f]{32}$/
/**
 * 内核的 clientOrderId 恒为 32 位小写十六进制（packages/kernel/src/normalize.ts:122），Gate 的 text 不计 t- 最多 28 字节、只许 [0-9A-Za-z-_.]：
 * 32 位十六进制 → `t-` + base64url(16 字节) = 24 字符，可逆；其它字符串照旧走 sanitizeText（QD gate.py:91-104）。
 */
export function encodeClientOrderId(id: string): string {
  return HEX32.test(id) ? `t-${Buffer.from(id, 'hex').toString('base64url')}` : sanitizeText(id)
}

/** Gate text → clientOrderId：能还原成 32 位十六进制就还原，否则原样（web / api / ao-… 这类外来单）；空 → null。 */
export function decodeClientOrderId(text: unknown): string | null {
  if (typeof text !== 'string' || text === '') return null
  const m = /^t-([A-Za-z0-9_-]{22})$/.exec(text)
  if (m !== null) {
    const hex = Buffer.from(m[1]!, 'base64url').toString('hex')
    if (HEX32.test(hex) && Buffer.from(hex, 'hex').toString('base64url') === m[1]) return hex
  }
  return text
}

/** 新的客户端订单号（32 位小写十六进制，与内核同形）。 */
export function newClientOrderId(): string {
  return randomBytes(16).toString('hex')
}

/** 时效 → Gate `tif`（Gate 永续 tif 有 gtc / ioc / poc（只挂单）/ fok）。 */
export function tifOf(intent: OrderIntent): GateTif {
  return intent.postOnly === true || intent.tif === 'alo' ? 'poc' : intent.tif === 'ioc' ? 'ioc' : intent.tif === 'fok' ? 'fok' : 'gtc'
}

/** 价格必须是定点文本：先规范化再要求不带指数（QD gate.py:32-38 的同一约束）。 */
function fixedPoint(label: string, raw: string): Decimal {
  if (toFx(raw) === undefined) return fail(bad('INVALID_PARAMS', `${label} is not a positive decimal number: ${JSON.stringify(raw)}`))
  const normalized = normalizeDecimal(raw)
  if (!/^-?\d+(\.\d+)?$/.test(normalized)) {
    return fail(bad('PRECISION', `${label} ${raw} must be a fixed-point decimal (Gate rejects scientific notation)`))
  }
  return normalized
}

function normalizePrice(
  label: string,
  raw: string,
  record: InstrumentRecord,
  mode: 'reject' | 'passive',
  side: 'buy' | 'sell',
  rounded: NonNullable<BuiltOrder['rounded']>,
): Decimal {
  const price = fixedPoint(label, raw)
  const tick = record.tick
  if (fx(price) % fx(tick) === 0n) return price
  if (mode === 'reject') {
    return fail(bad('PRECISION', `${label} ${raw} is not a multiple of tick ${tick} for ${record.symbol} (set rounding: 'passive' to snap it)`))
  }
  // passive：买单向下、卖单向上，永不朝成交方向取整
  const snapped = snapToTick(price, tick, side === 'buy' ? 'down' : 'up')
  if (toFx(snapped) === undefined) return fail(bad('PRECISION', `${label} ${raw} rounds to zero for ${record.symbol}`))
  rounded.push({ field: label, from: raw, to: snapped })
  return snapped
}

/**
 * 数量：给了 size 用 size，否则按 notional / 参考价折算；一律向零截断到**币**步长（quanto_multiplier），
 * 再交给 signedContracts 折成张数。
 */
function resolveSizeBase(intent: OrderIntent, record: InstrumentRecord, priceForNotional: Decimal, ref: PriceRef): Decimal {
  // 按 order_size_min 的小数位定张数步长（QD gate.py:758-770），最小值另比 minSizeBase。
  const baseStep = mulDec(record.contractSize, record.sizeDecimals > 0 ? `0.${'0'.repeat(record.sizeDecimals - 1)}1` : '1')
  let raw: Decimal
  if (intent.size !== undefined) {
    if (toFx(intent.size) === undefined) return fail(bad('INVALID_PARAMS', `size is not a positive decimal number: ${JSON.stringify(intent.size)}`))
    raw = normalizeDecimal(intent.size)
  } else if (intent.notional !== undefined) {
    const mid = ref.mid
    const base = mid !== undefined && mid > 0 ? str(fx(mid)) : priceForNotional
    if (toFx(base) === undefined) {
      return fail(bad('STALE_PRICE', `no price to convert notional for ${intent.instrumentId}`, { retryAfterMs: 1_000 }))
    }
    raw = asDecimal(str(div(fx(intent.notional), fx(base))))
  } else {
    return fail(bad('INVALID_PARAMS', 'order needs size or notional'))
  }
  if (toFx(raw) === undefined) return fail(bad('INVALID_PARAMS', 'size must be greater than zero'))
  // 先按「最小可下币量」截断，保证后面折张数时不出现比 order_size_min 更细的量。
  const size = truncateToStep(raw, baseStep)
  if (size === '0') {
    return fail(bad('PRECISION', `size ${raw} is below the smallest orderable amount (${baseStep}) for ${record.symbol}`))
  }
  if (fx(size) < fx(record.minSizeBase)) {
    return fail(bad('PRECISION', `size ${size} is below the contract minimum ${record.minSizeBase} for ${record.symbol}`))
  }
  return size
}

export const PRICE_ORDERS_PATH = '/api/v4/futures/usdt/price_orders'
/** 30 天（QD native_protection.py:306-311 的 expiration）。 */
export const TRIGGER_EXPIRATION_SEC = 2_592_000
const PRICE_TYPE = { last: 0, mark: 1, index: 2 } as const
/** rule：1 = 价格 ≥ 触发价，2 = 价格 ≤ 触发价。止损买 / 止盈卖 = 1，止损卖 / 止盈买 = 2（QD native_protection.py:298 同义）。 */
export function triggerRule(type: string, side: 'buy' | 'sell'): 1 | 2 {
  const stop = type === 'stop_market' || type === 'stop_limit'
  return stop === (side === 'buy') ? 1 : 2
}

/**
 * 触发单（/price_orders）：触发后按市价成交（`price "0"` + ioc，与 QD 保护单同形），或按限价成交。
 * 市价类触发单不用 maxSlippageBps；trailing_stop / twap 仍 1004（QD 的 Gate 追踪是 `managed_by: strategy_runtime`，不是原生）。
 * price_orders 里整数张的 `initial.size` 是 int64 **数字**，份额化合约改用字符串 `initial.amount`；
 * **不发 text**——QD 不发，Gate 触发单没有客户端单号。
 */
function buildTriggerOrder(intent: OrderIntent, record: InstrumentRecord, clientOrderId: string, opts: BuildOptions): BuiltOrder {
  if (intent.postOnly === true || intent.tif === 'alo' || intent.tif === 'fok') {
    return fail(bad('ORDER_TYPE_UNSUPPORTED', 'Gate.io trigger orders support gtc / ioc only'))
  }
  if (intent.triggerPrice === undefined) return fail(bad('INVALID_PARAMS', `${intent.type} orders need triggerPrice`))
  const mode = intent.rounding ?? 'reject'
  const rounded: NonNullable<BuiltOrder['rounded']> = []
  const triggerPrice = normalizePrice('triggerPrice', String(intent.triggerPrice), record, mode, intent.side, rounded)
  const limitType = intent.type === 'stop_limit' || intent.type === 'take_limit'
  let limitPrice = asDecimal('0')
  if (limitType) {
    if (intent.price === undefined) return fail(bad('INVALID_PARAMS', `${intent.type} orders need price`))
    limitPrice = normalizePrice('price', String(intent.price), record, mode, intent.side, rounded)
  }
  const sizeBase = resolveSizeBase(intent, record, limitType ? limitPrice : triggerPrice, {})
  const { size, decimalHeader } = signedContracts(sizeBase, intent.side, {
    contractSize: record.contractSize,
    orderSizeMin: record.orderSizeMin,
  })
  if (size === '0') {
    return fail(bad('PRECISION', `size ${sizeBase} resolves to zero contracts for ${record.symbol} (order_size_min = ${record.orderSizeMin})`))
  }
  const market = intent.type === 'stop_market' || intent.type === 'take_market'
  const initial: Record<string, unknown> = { contract: record.symbol, price: market ? '0' : limitPrice, tif: market ? 'ioc' : intent.tif === 'ioc' ? 'ioc' : 'gtc' }
  if (intent.reduceOnly === true) initial['reduce_only'] = true
  if (decimalHeader) initial['amount'] = size
  else initial['size'] = Number(size)
  const rule = triggerRule(intent.type, intent.side)
  const body: Record<string, unknown> = {
    initial,
    trigger: { strategy_type: 0, price_type: PRICE_TYPE[intent.triggerType ?? 'mark'], price: triggerPrice, rule, expiration: TRIGGER_EXPIRATION_SEC },
  }
  if (intent.reduceOnly === true) body['order_type'] = `plan-close-${intent.side === 'sell' ? 'long' : 'short'}-position`
  const headers: Record<string, string> = {}
  if (decimalHeader || opts.forceDecimalHeader === true) headers['X-Gate-Size-Decimal'] = '1'
  return {
    kind: 'price_order',
    path: PRICE_ORDERS_PATH,
    body,
    clientOrderId,
    headers,
    reduceOnly: intent.reduceOnly === true,
    ...(rounded.length > 0 ? { rounded } : {}),
    sizeContracts: size,
    sizeBase,
    contract: record.symbol,
    contractSize: record.contractSize,
    fingerprint: { contract: record.symbol, rule, triggerPrice, size },
  }
}

/**
 * 单个 OrderIntent → 线上请求。
 *   · market / limit 走 /orders；stop_* / take_* 走 /price_orders（触发单）；
 *   · 市价意图缺 `maxSlippageBps` → INVALID_PARAMS；有 → 价带限价 + `tif: 'ioc'`；
 *   · `price` 字段永远是字符串，市价模拟用价带价，永不发 `"0"`（Gate 的 `"0"` + ioc 是裸市价，无滑点上限）；
 *   · 保证金模式不在本函数检查（下单时绝不切模式，由 trading 读现状后判）。
 */
export function buildOrder(intent: OrderIntent, record: InstrumentRecord | undefined, ref: PriceRef = {}, opts: BuildOptions = {}): BuiltOrder {
  if (!record) return fail(bad('INSTRUMENT_UNKNOWN', `unknown instrument ${intent.instrumentId}`))
  if (record.instrument.status === 'delisted') return fail(bad('INSTRUMENT_UNKNOWN', `${intent.instrumentId} is delisted`))
  const type = intent.type
  if (!(record.instrument.orderTypes as string[]).includes(type)) {
    return fail(bad('ORDER_TYPE_UNSUPPORTED', `order type ${type} is not supported by this connector`))
  }
  if (intent.tpsl !== undefined) {
    // 父单 + 保护单不是一次请求能表达的；一律 1004，由内核成交后自行处理。
    return fail(bad('ORDER_TYPE_UNSUPPORTED', 'Gate.io attached stop/take orders are not implemented in this connector; submit the parent alone (tpsl.attachToOrder = false)'))
  }
  if (intent.tif === 'gtd') {
    return fail(bad('ORDER_TYPE_UNSUPPORTED', 'Gate.io perpetual orders have no gtd'))
  }

  const clientOrderId = intent.clientOrderId !== undefined ? String(intent.clientOrderId) : newClientOrderId()
  if (type === 'stop_market' || type === 'stop_limit' || type === 'take_market' || type === 'take_limit') {
    return buildTriggerOrder(intent, record, clientOrderId, opts)
  }
  if (type === 'market' && intent.postOnly === true) {
    return fail(bad('INVALID_PARAMS', 'post-only market orders are contradictory'))
  }

  const isBuy = intent.side === 'buy'
  const mode = intent.rounding ?? 'reject'
  const rounded: NonNullable<BuiltOrder['rounded']> = []

  // ---- 价格 ----
  let price: Decimal
  let tif: GateTif
  if (type === 'market') {
    // 教训 4：市价意图必须带 maxSlippageBps；实际发价带限价 + tif=ioc。
    if (intent.maxSlippageBps === undefined) {
      return fail(bad('INVALID_PARAMS', 'market orders need maxSlippageBps (no implicit default slippage)'))
    }
    if (!Number.isFinite(intent.maxSlippageBps) || intent.maxSlippageBps <= 0) {
      return fail(bad('INVALID_PARAMS', `maxSlippageBps must be a positive number (got ${String(intent.maxSlippageBps)})`))
    }
    const mid = ref.mid ?? (ref.bid !== undefined && ref.ask !== undefined ? (ref.bid + ref.ask) / 2 : undefined)
    if (mid === undefined || mid <= 0 || ref.stale === true) {
      return fail(bad('STALE_PRICE', `no fresh price for ${intent.instrumentId}; cannot emulate a market order`, { retryAfterMs: 1_000 }))
    }
    const band = applyBps(str(fx(mid)), intent.maxSlippageBps, isBuy ? 'up' : 'down')
    price = snapToTick(band, record.tick, isBuy ? 'down' : 'up')
    if (price === '0') return fail(bad('PRECISION', `market price band for ${intent.instrumentId} rounds to zero`))
    tif = 'ioc'
  } else {
    if (intent.price === undefined) return fail(bad('INVALID_PARAMS', `${type} orders need price`))
    price = normalizePrice('price', String(intent.price), record, mode, intent.side, rounded)
    tif = tifOf(intent)
  }

  // ---- 数量 ----
  const sizeBase = resolveSizeBase(intent, record, price, ref)
  const { size: sizeContracts, decimalHeader } = signedContracts(sizeBase, intent.side, {
    contractSize: record.contractSize,
    orderSizeMin: record.orderSizeMin,
  })
  if (sizeContracts === '0') {
    return fail(bad('PRECISION', `size ${sizeBase} resolves to zero contracts for ${record.symbol} (order_size_min = ${record.orderSizeMin})`))
  }

  const text = encodeClientOrderId(clientOrderId)
  const body: Record<string, unknown> = {
    contract: record.symbol,
    size: sizeContracts,
    price,
    tif,
  }
  if (intent.reduceOnly === true) body['reduce_only'] = true
  body['text'] = text

  const headers: Record<string, string> = {}
  if (decimalHeader || opts.forceDecimalHeader === true) headers['X-Gate-Size-Decimal'] = '1'

  return {
    kind: 'order',
    path: '/api/v4/futures/usdt/orders',
    body,
    clientOrderId,
    headers,
    reduceOnly: intent.reduceOnly === true,
    ...(rounded.length > 0 ? { rounded } : {}),
    sizeContracts,
    sizeBase,
    contract: record.symbol,
    contractSize: record.contractSize,
    text,
  }
}

/** 诊断：把 body 键排序（日志 / 断言用，不改请求）。 */
export function describeBody(body: Record<string, unknown>): string {
  return Object.keys(body).sort().map((k) => `${k}=${String(body[k])}`).join('&')
}
