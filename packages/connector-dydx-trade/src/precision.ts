// SPDX-License-Identifier: CPAL-1.0
// 数量 / 价格的链上整数化（quantums / subticks）。全部走 @gitrader/protocol 的定点十进制，不做浮点运算。
// 公式（docs.dydx.xyz/concepts/trading/quantums）：
//   quantums = size × 10^(-atomicResolution)，且必须是 stepBaseQuantums 的整数倍
//   subticks = price × 10^(-(atomicResolution - quantumConversionExponent - (-6)))，且必须是 subticksPerTick 的整数倍
// 最后一式里的 -(-6) 是 USDC 的 atomic resolution（1e-6）；dYdX 文档的「1 subtick = 1e-14 USDC / 1e-10 BTC」就是这个式子。
// 取整遵守协议 OrderIntent.rounding（packages/protocol/src/model/order.ts：缺省 'reject'；'passive' = 买单向下、卖单向上）：
//   · 'reject'（缺省）：数量必须是 step 的整数倍、价格必须是 tick 的整数倍，否则拒绝（不偷偷改量改价）；
//   · 'passive'：数量向下截到 step；限价买单向下、卖单向上取到 tick（买单不往上、卖单不往下，避免变成 taker）；
//   · 'band'：市价价带专用（价带本身就是「最差可接受价」），买单向下、卖单向上取到 tick，与 rounding 无关。
// 取整结果小于一个 step / 一个 tick 一律拒绝（不再夹到最小档，夹档会把 0.00001 放大 10 倍）。
// 设计参照（只借「先乘幂、再按 tick 取整」的步骤，代码从零写）：
//   nautilus_trader crates/adapters/dydx/src/grpc/order.rs@55c0e820。
import { fx, str, type Fx } from '@gitrader/protocol/decimal'

/** 官方市场参数（Indexer /v4/perpetualMarkets 的 markets[ticker] 字段）。 */
export interface MarketParams {
  ticker: string
  clobPairId: number
  atomicResolution: number
  quantumConversionExponent: number
  stepBaseQuantums: number | bigint
  subticksPerTick: number
}

/** 数量取整口径：contract 的 'reject' / 'passive'（市价价带另外用 'band'）。 */
export type RoundingMode = 'reject' | 'passive'

const ONE = fx('1')
const TEN = fx('10')
const QUOTE_ATOMIC_RESOLUTION = -6

/** 10^n 的定点值（n 可为负）。 */
function pow10(n: number): Fx {
  let out = ONE
  const step = n >= 0 ? TEN : fx('0.1')
  for (let i = 0; i < Math.abs(n); i += 1) out = (out * step) / ONE
  return out
}

/** 把 x（定点）取整到 unit（定点）的整数倍，四舍五入（远离零）。 */
export function roundToMultiple(x: Fx, unit: Fx): Fx {
  if (unit <= 0n) throw new RangeError('unit must be positive')
  const q = x / unit
  const r = x - q * unit
  const half = unit / 2n
  if (r < 0n) return (-r >= half ? q - 1n : q) * unit
  return (r >= half ? q + 1n : q) * unit
}

/** 把 x（定点）向零截断到 unit（定点）的整数倍。 */
export function truncToMultiple(x: Fx, unit: Fx): Fx {
  if (unit <= 0n) throw new RangeError('unit must be positive')
  return (x / unit) * unit
}

/**
 * 数量 → quantums（整数）。
 * size 是基础资产单位（如 0.5 BTC）；不是 step 整数倍时按 rounding 处理，小于一个 step 直接拒绝。
 */
export function quantumsFor(size: string, params: MarketParams, rounding: RoundingMode = 'reject'): bigint {
  const sizeFx = fx(size)
  if (sizeFx <= 0n) throw new RangeError(`order size must be positive, got ${size}`)
  const step = fx(String(params.stepBaseQuantums))
  if (step <= 0n) throw new RangeError('stepBaseQuantums must be positive')
  // 两份定点相乘后是 1e36 刻度，除一次 ONE 归位到 1e18 刻度
  const raw = (sizeFx * pow10(-params.atomicResolution)) / ONE
  if (rounding === 'reject' && raw % ONE !== 0n) {
    throw new RangeError(`size ${size} is finer than one quantum (atomicResolution ${params.atomicResolution})`)
  }
  if (raw < step) throw new RangeError(`order size ${size} is smaller than one step (stepBaseQuantums ${str(step)})`)
  let q: Fx
  if (rounding === 'reject') {
    if (raw % step !== 0n) {
      throw new RangeError(`size ${size} is not a multiple of stepBaseQuantums ${str(step)}`)
    }
    q = raw
  } else {
    q = truncToMultiple(raw, step)
  }
  if (q < step) throw new RangeError(`order size ${size} is smaller than one step (stepBaseQuantums ${str(step)})`)
  return q / ONE
}

/** quantums → 人类可读数量（报表 / 对账用）。 */
export function sizeFromQuantums(quantums: bigint | number, params: MarketParams): string {
  const factor = pow10(-params.atomicResolution)
  return str((BigInt(quantums) * ONE * ONE) / factor)
}

/**
 * 价格 → subticks（整数）。
 * 'reject'：必须是 tick 整数倍；'passive'：买单向下、卖单向上；'band'：市价价带，买单向下、卖单向上。
 */
export function subticksFor(
  price: string,
  params: MarketParams,
  side: 'buy' | 'sell',
  rounding: RoundingMode | 'band' = 'reject',
): bigint {
  const priceFx = fx(price)
  if (priceFx <= 0n) throw new RangeError(`order price must be positive, got ${price}`)
  const exponent = -(params.atomicResolution - params.quantumConversionExponent - QUOTE_ATOMIC_RESOLUTION)
  const raw = (priceFx * pow10(-exponent)) / ONE
  const tick = fx(String(params.subticksPerTick))
  if (tick <= 0n) throw new RangeError('subticksPerTick must be positive')
  let st: Fx
  if (rounding === 'reject') {
    if (raw % tick !== 0n) {
      throw new RangeError(`price ${price} is not a multiple of subticksPerTick ${str(tick)}`)
    }
    st = raw
  } else {
    // passive / band：都在价带内侧取整（买单不往上、卖单不往下）
    st = truncToMultiple(raw, tick)
    if (side === 'sell' && st !== raw) st += tick
  }
  if (st < tick) throw new RangeError(`price ${price} rounds below one tick (subticksPerTick ${str(tick)})`)
  return st / ONE
}

/** subticks → 人类可读价格。 */
export function priceFromSubticks(subticks: bigint | number, params: MarketParams): string {
  const exponent = -(params.atomicResolution - params.quantumConversionExponent - QUOTE_ATOMIC_RESOLUTION)
  const factor = pow10(-exponent)
  return str((BigInt(subticks) * ONE * ONE) / factor)
}

/**
 * 市价单的价带限价（工单教训 4）：以参考价按 bps 向外放宽，返回人类可读价格字符串；
 * 调用方随后用 subticksFor(..., 'band') 变成整数并发 IOC。
 */
export function priceBand(refPrice: string, bps: number, side: 'buy' | 'sell'): string {
  if (!Number.isFinite(bps) || bps < 0) throw new RangeError(`maxSlippageBps must be a non-negative finite number, got ${bps}`)
  if (bps > 10_000) throw new RangeError(`maxSlippageBps looks wrong (${bps}); it is basis points, 10000 = 100%`)
  const ref = fx(refPrice)
  if (ref <= 0n) throw new RangeError(`reference price must be positive, got ${refPrice}`)
  const delta = (ref * fx(String(bps))) / fx('10000')
  return str(side === 'buy' ? ref + delta : ref - delta)
}

/** 是否是 tick 的整数倍（场所会拒非整数倍的价格）。 */
export function isOnTick(subticks: bigint | number, params: MarketParams): boolean {
  const tick = BigInt(params.subticksPerTick)
  return tick > 0n && BigInt(subticks) % tick === 0n
}

/** 是否是 step 的整数倍。 */
export function isOnStep(quantums: bigint | number, params: MarketParams): boolean {
  const step = BigInt(params.stepBaseQuantums)
  return step > 0n && BigInt(quantums) % step === 0n
}
