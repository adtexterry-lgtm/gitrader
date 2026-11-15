// SPDX-License-Identifier: CPAL-1.0
// 统一精度规则（契约 §1.3）：数量向零截断；价格不在合法刻度上 → 1002 PRECISION，除非 rounding: "passive"（买向下、卖向上，永不朝成交方向取整）；
// 名义额折算数量向零截断。精度一律来自 Instrument 能力声明，不写死。
import type { Decimal, Instrument, OrderIntent } from './proto'
import * as d from './util/dec'
import type { Dec } from './util/dec'
import { fail } from './util/errors'
import { newClientOrderId } from './util/ids'
import type { NormalizedIntent } from './connector'
import type { GateAccountView, RuleHit, Sha256Digest } from './proto'
import { gateTargetDigest } from './risk-gate/assemble'

const LIMIT_LIKE = new Set(['limit', 'stop_limit', 'take_limit'])
const TRIGGER_LIKE = new Set(['stop_market', 'stop_limit', 'take_market', 'take_limit', 'trailing_stop'])
const MARKET_LIKE = new Set(['market', 'stop_market', 'take_market'])

/** 该价格量级下允许的小数位数（tick 规则另算）。HL：≤5 位有效数字且小数位 ≤ maxDecimals；整数价恒合法。 */
function allowedDecimals(inst: Instrument, price: Dec): number {
  const maxDec = inst.price.maxDecimals ?? 8
  const sig = inst.price.sigFigs
  if (sig === undefined) return maxDec
  const ip = d.intDigits(price)
  if (ip >= sig) return 0
  if (ip > 0) return Math.min(maxDec, sig - ip)
  // 0.00xyz：前导零之后才算有效数字
  let zeros = 0
  let probe = d.mul(price, d.D('10'))
  while (d.lt(probe, d.ONE) && zeros < 40) { zeros++; probe = d.mul(probe, d.D('10')) }
  return Math.min(maxDec, zeros + sig)
}

function onTick(price: Dec, tick: Dec): boolean {
  const num = price.n * 10n ** BigInt(tick.s)
  const den = tick.n * 10n ** BigInt(price.s)
  return num % den === 0n
}

/** 返回规范化后的价格；不合法且非 passive → 抛 1002。 */
export function normalizePrice(inst: Instrument, raw: Decimal, side: 'buy' | 'sell', rounding: 'reject' | 'passive', field = 'price'): Decimal {
  const p = d.D(raw)
  if (d.lte(p, d.ZERO)) fail('PRECISION', `${field} must be positive`)
  if (inst.price.tick !== undefined) {
    const tick = d.D(inst.price.tick)
    if (onTick(p, tick)) return d.str(p)
    if (rounding !== 'passive') fail('PRECISION', `${field} ${raw} is not a multiple of tick ${inst.price.tick}`)
    // 向下取到 tick 的整数倍（买）/ 向上（卖）
    const k = d.div(p, tick, 0)
    const lower = d.mul(k, tick)
    return d.str(side === 'buy' ? lower : d.add(lower, tick))
  }
  const dec = allowedDecimals(inst, p)
  if (d.scaleOf(p) <= dec) return d.str(p)
  if (rounding !== 'passive') {
    fail('PRECISION', `${field} ${raw} exceeds allowed precision (${inst.price.sigFigs ?? '-'} significant figures, max ${inst.price.maxDecimals ?? '-'} decimals)`)
  }
  let r = side === 'buy' ? d.floorTo(p, dec) : d.ceilTo(p, dec)
  // 取整后量级变化可能改变允许小数位（如 99999.9 → 100000）；再收一次
  const dec2 = allowedDecimals(inst, r)
  if (d.scaleOf(r) > dec2) r = side === 'buy' ? d.floorTo(r, dec2) : d.ceilTo(r, dec2)
  if (d.lte(r, d.ZERO)) fail('PRECISION', `${field} ${raw} rounds to zero`)
  return d.str(r)
}

export interface NormalizeContext {
  /** 标记价（名义额折算数量、市价名义估算用）。 */
  mark?: Decimal
  /** 市价类缺省滑点上限（取自风控策略）。 */
  defaultMaxSlippageBps: number
  clientOrderId?: string
  /** Defer reduce-only venue and minimum-notional admission to deterministic gate stages. */
  deferRiskClassification?: boolean
  /** fix-r2 T6：内核时钟（毫秒）；给了就核对调用方自带的时间字段（早 60 s 以上 / 晚 5 s 以上拒绝）。 */
  now?: number
  /** fix-r2 T6：被丢弃的未知字段写进这里（回执 warnings 用）。 */
  warnings?: string[]
}

/** OrderIntent 的已知键（协议 model/order.ts）；其余键不进规范化意图、不进账本载荷、不进摘要。 */
const ORDER_INTENT_KEYS = new Set([
  'accountId', 'instrumentId', 'side', 'type', 'size', 'notional', 'price', 'triggerPrice', 'triggerType', 'tif', 'reduceOnly', 'postOnly', 'leverage',
  'marginMode', 'maxSlippageBps', 'tpsl', 'expiresAt', 'clientOrderId', 'rounding', 'allowAdjust', 'reason', 'legId', 'exitPlanId', 'ocoGroupId', 'trailing',
])
/** 调用方自带的时间字段（ADR-21）：只当备注，但和内核时钟差太多就拒绝（防倒填 / 防伪造时间）。 */
export const CALLER_TIME_KEYS = ['ts', 'timestamp', 'createdAt', 'clientTs', 'sentAt'] as const
export const CALLER_TS_PAST_TOLERANCE_MS = 60_000
export const CALLER_TS_FUTURE_TOLERANCE_MS = 5_000

function callerTimeMs(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v < 1e11 ? v * 1000 : v // 小于 1e11 按秒算
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v)
    if (Number.isFinite(n)) return n < 1e11 ? n * 1000 : n
    const t = Date.parse(v)
    return Number.isFinite(t) ? t : undefined
  }
  return undefined
}

export function checkCallerTimestamps(intent: Record<string, unknown>, now: number): void {
  for (const key of CALLER_TIME_KEYS) {
    const t = callerTimeMs(intent[key])
    if (t === undefined) continue
    if (t < now - CALLER_TS_PAST_TOLERANCE_MS || t > now + CALLER_TS_FUTURE_TOLERANCE_MS) {
      const diff = Math.round(t - now)
      fail('INVALID_PARAMS', `caller timestamp ${key} differs from the kernel clock by ${diff} ms (allowed: up to ${CALLER_TS_PAST_TOLERANCE_MS} ms earlier, ${CALLER_TS_FUTURE_TOLERANCE_MS} ms later); the ledger only uses the kernel clock. 调用方时间与内核时钟相差过大（早于 60 秒或晚于 5 秒会被拒），账本只认内核时钟`)
    }
  }
}

export function normalizeIntent(intent: OrderIntent, inst: Instrument, ctx: NormalizeContext): NormalizedIntent {
  if (intent.instrumentId !== inst.instrumentId) fail('INSTRUMENT_UNKNOWN', `instrument mismatch: ${intent.instrumentId}`)
  if (inst.status === 'halted' || inst.status === 'delisted') fail('INSTRUMENT_UNKNOWN', `instrument ${inst.instrumentId} is ${inst.status}`)
  if (inst.status === 'reduce_only' && !intent.reduceOnly && !ctx.deferRiskClassification) fail('INSTRUMENT_UNKNOWN', `instrument ${inst.instrumentId} is reduce-only`)
  if (intent.side !== 'buy' && intent.side !== 'sell') fail('INVALID_PARAMS', 'side must be buy|sell')
  if (!inst.orderTypes.includes(intent.type)) fail('ORDER_TYPE_UNSUPPORTED', `${inst.instrumentId} does not support order type ${intent.type}`)
  const tif = intent.tif ?? (MARKET_LIKE.has(intent.type) ? 'ioc' : 'gtc')
  if (!inst.tif.includes(tif)) fail('ORDER_TYPE_UNSUPPORTED', `${inst.instrumentId} does not support tif ${tif}`)
  if (intent.postOnly && tif !== 'alo' && tif !== 'gtc') fail('INVALID_PARAMS', 'postOnly requires tif gtc or alo')
  const rounding = intent.rounding ?? 'reject'

  if (ctx.now !== undefined) checkCallerTimestamps(intent as unknown as Record<string, unknown>, ctx.now)
  const unknownKeys = Object.entries(intent).filter(([k, v]) => v !== undefined && !ORDER_INTENT_KEYS.has(k)).map(([k]) => k)
  if (unknownKeys.length) ctx.warnings?.push(`已忽略未知字段：${unknownKeys.join(', ')}（ignored unknown fields）`)
  const out: Record<string, unknown> = Object.fromEntries(Object.entries(intent).filter(([k, v]) => v !== undefined && ORDER_INTENT_KEYS.has(k)))
  delete out.notional
  out.tif = tif

  let price: Decimal | undefined
  if (LIMIT_LIKE.has(intent.type)) {
    if (intent.price === undefined) fail('INVALID_PARAMS', `${intent.type} requires price`)
    price = normalizePrice(inst, intent.price as Decimal, intent.side, rounding)
    out.price = price
  } else delete out.price
  if (TRIGGER_LIKE.has(intent.type)) {
    if (intent.triggerPrice === undefined) fail('INVALID_PARAMS', `${intent.type} requires triggerPrice`)
    out.triggerPrice = normalizePrice(inst, intent.triggerPrice as Decimal, intent.side, rounding, 'triggerPrice')
    out.triggerType = intent.triggerType ?? 'mark'
    if (!inst.triggerPriceTypes.includes(out.triggerType as 'mark')) fail('ORDER_TYPE_UNSUPPORTED', `${inst.instrumentId} does not support trigger type ${String(out.triggerType)}`)
  }

  // 附带止损止盈：两条腿的触发价同受精度规则；止损腿用父单 side，止盈腿用相反 side，passive 取整永远朝离参考价更远一侧。
  if (intent.tpsl !== undefined) {
    const tpsl: NonNullable<OrderIntent['tpsl']> = { ...intent.tpsl }
    const legs: Array<['stopLoss' | 'takeProfit', 'buy' | 'sell']> = [
      ['stopLoss', intent.side],
      ['takeProfit', intent.side === 'buy' ? 'sell' : 'buy'],
    ]
    for (const [leg, side] of legs) {
      const raw = tpsl[leg]
      if (raw === undefined) continue
      tpsl[leg] = { ...raw, triggerPrice: normalizePrice(inst, raw.triggerPrice, side, rounding, `tpsl.${leg}.triggerPrice`) }
    }
    out.tpsl = tpsl
  }

  // 数量：size 优先；否则 notional / 参考价，向零截断到 size.decimals
  let size: Dec
  if (intent.size !== undefined) size = ctx.deferRiskClassification ? d.D(intent.size) : d.truncTo(d.D(intent.size), inst.size.decimals)
  else if (intent.notional !== undefined) {
    const ref = price ?? ctx.mark
    if (ref === undefined) fail('DATA_UNAVAILABLE', 'notional order needs a reference price but none is available')
    const converted = d.div(d.D(intent.notional), d.mul(d.D(ref as Decimal), d.D(inst.contractSize)))
    size = ctx.deferRiskClassification ? converted : d.truncTo(converted, inst.size.decimals)
  } else fail('INVALID_PARAMS', 'order requires size or notional')
  size = size!
  if (d.lte(size, d.ZERO) || !ctx.deferRiskClassification && d.lt(size, d.D(inst.size.min))) fail('MIN_NOTIONAL', `size ${d.str(size)} is below the minimum ${inst.size.min} for ${inst.instrumentId}`)
  out.size = d.str(size)
  const ref = price ?? ctx.mark
  if (ref !== undefined && inst.minNotional !== undefined && !intent.reduceOnly && !ctx.deferRiskClassification) {
    const notional = d.mul(d.mul(size, d.D(ref as Decimal)), d.D(inst.contractSize))
    if (d.lt(notional, d.D(inst.minNotional))) fail('MIN_NOTIONAL', `notional ${d.str(notional)} is below the minimum ${inst.minNotional}`)
  }

  if (MARKET_LIKE.has(intent.type)) out.maxSlippageBps = intent.maxSlippageBps ?? ctx.defaultMaxSlippageBps
  out.clientOrderId = intent.clientOrderId ?? ctx.clientOrderId ?? newClientOrderId()
  if (!/^[0-9a-f]{32}$/.test(out.clientOrderId as string)) fail('INVALID_PARAMS', 'clientOrderId must be 32 lowercase hex characters')
  return out as unknown as NormalizedIntent
}

export function normalizeRiskTarget(
  intent: NormalizedIntent,
  positions: GateAccountView['positions'],
  reservedReductionSize?: Decimal,
): { intent: NormalizedIntent; action: 'open' | 'reduce'; originalTargetDigest?: Sha256Digest; warnings: RuleHit[] } {
  const explicitReduction = intent.reduceOnly === true
  const position = positions.find((item) => item.instrumentId === intent.instrumentId)
  const oppositeSide = (position?.side === 'long' && intent.side === 'sell') || (position?.side === 'short' && intent.side === 'buy')
  const availableReduction = position
    ? d.max(d.ZERO, d.sub(d.D(position.size), d.D(reservedReductionSize ?? '0')))
    : d.ZERO
  const inferredReduction = !explicitReduction && oppositeSide && d.lte(d.D(intent.size), availableReduction)
  const action = explicitReduction || inferredReduction ? 'reduce' : 'open'
  const next = { ...intent }
  let changed = false

  if (inferredReduction && next.reduceOnly !== true) {
    next.reduceOnly = true
    changed = true
  }

  const warnings: RuleHit[] = []
  if (action === 'reduce' && next.leverage !== undefined) {
    const oldLeverage = next.leverage
    delete next.leverage
    changed = true
    warnings.push({ ruleId: 'gate#reduceLeverage', code: 'LEVERAGE', action: 'warn', limit: d.str(d.D('0')), actual: d.str(d.D(String(oldLeverage))), unit: 'x', scope: 'account' })
  }

  return {
    intent: next,
    action,
    ...(changed ? { originalTargetDigest: gateTargetDigest({ kind: 'order', intent }) } : {}),
    warnings,
  }
}
