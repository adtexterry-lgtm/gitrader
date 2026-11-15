// SPDX-License-Identifier: CPAL-1.0
// 容差与时间窗：所有比较都带容差参数，不写死「等于」。
//
// 为什么必须带：账本与场所是两台机器、两条链路（REST 与私有流）给出的时间戳，
// 时钟偏差与回报延迟会让「刚刚下的单」在场所视图里看起来不存在，
// 把正常在途判成丢失是启动对账最常见的误判来源。
// 设计参照：nautilus_trader crates/live/src/node/reconciliation.rs（对账轮询间隔与在途单检查）
//           与 crates/live/src/execution/manager.rs（按账户设置持仓对账容差）@55c0e820
import { commonScaled, absDecimal, withinTolerance, parseDecimal, compareDecimal } from './decimal'
import type { ReconcileOptions } from './types'

export interface ResolvedOptions {
  now: number
  clockSkewMs: number
  venueLatencyMs: number
  sizeTolerance: string
  positionTolerance: string
  priceToleranceBps: number
  fillLookbackMs: number
  staleAfterMs: number
  ownClientOrderIdPrefixes: readonly string[]
  dedupeFallback: 'accept_with_risk' | 'needs_human'
}

export const DEFAULT_CLOCK_SKEW_MS = 2_000
export const DEFAULT_VENUE_LATENCY_MS = 5_000
export const DEFAULT_PRICE_TOLERANCE_BPS = 5
export const DEFAULT_FILL_LOOKBACK_MS = 24 * 60 * 60 * 1_000
export const DEFAULT_STALE_AFTER_MS = 60 * 1_000

/** 补齐缺省容差；负数一律拒绝（负容差等于没有容差，宁可报错也不静默接受）。 */
export function resolveOptions(options: ReconcileOptions): ResolvedOptions {
  if (!Number.isFinite(options.now)) throw new TypeError('options.now must be a finite epoch-ms number')
  const clockSkewMs = options.clockSkewMs ?? DEFAULT_CLOCK_SKEW_MS
  const venueLatencyMs = options.venueLatencyMs ?? DEFAULT_VENUE_LATENCY_MS
  const sizeTolerance = options.sizeTolerance ?? '0'
  const positionTolerance = options.positionTolerance ?? sizeTolerance
  const priceToleranceBps = options.priceToleranceBps ?? DEFAULT_PRICE_TOLERANCE_BPS
  const fillLookbackMs = options.fillLookbackMs ?? DEFAULT_FILL_LOOKBACK_MS
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS
  for (const [name, value] of [
    ['clockSkewMs', clockSkewMs], ['venueLatencyMs', venueLatencyMs], ['priceToleranceBps', priceToleranceBps],
    ['fillLookbackMs', fillLookbackMs], ['staleAfterMs', staleAfterMs],
  ] as const) {
    if (!Number.isFinite(value) || value < 0) throw new RangeError(`options.${name} must be a non-negative finite number`)
  }
  if (parseDecimal(sizeTolerance).neg) throw new RangeError('options.sizeTolerance must not be negative')
  if (parseDecimal(positionTolerance).neg) throw new RangeError('options.positionTolerance must not be negative')
  return {
    now: options.now,
    clockSkewMs: Math.trunc(clockSkewMs),
    venueLatencyMs: Math.trunc(venueLatencyMs),
    sizeTolerance,
    positionTolerance,
    priceToleranceBps,
    fillLookbackMs: Math.trunc(fillLookbackMs),
    staleAfterMs: Math.trunc(staleAfterMs),
    ownClientOrderIdPrefixes: options.ownClientOrderIdPrefixes ?? [],
    dedupeFallback: options.dedupeFallback ?? 'accept_with_risk',
  }
}

/** 在途窗口总宽度：场所延迟 + 允许的时钟偏差。 */
export function inFlightWindowMs(opts: ResolvedOptions): number {
  return opts.venueLatencyMs + opts.clockSkewMs
}

/** 这个时刻是否还在在途窗口内（太新，场所看不到属正常）。 */
export function isWithinLatency(ts: number | undefined, opts: ResolvedOptions): boolean {
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return false
  const age = opts.now - ts
  if (age < 0) return true // 时间在未来（在下单时钟偏差内），按在途处理
  return age <= inFlightWindowMs(opts)
}

/** 时间戳是否超出允许的时钟偏差落在未来。 */
export function isBeyondClockSkew(ts: number, opts: ResolvedOptions): boolean {
  return ts - opts.now > opts.clockSkewMs
}

/** 时间戳是否早于回补窗口。 */
export function isBeforeLookback(ts: number, opts: ResolvedOptions): boolean {
  return opts.now - ts > opts.fillLookbackMs
}

/** 视图是否不新鲜。 */
export function isStale(asOf: number, opts: ResolvedOptions): boolean {
  return opts.now - asOf > opts.staleAfterMs
}

/**
 * 数量是否在容差内相等：|a-b| <= tolerance，十进制精确比较。
 *
 * 容差的小数位可以比 a、b 都长（'5' vs '6' 配 '0.0001' 是文档示例），
 * 所以不能把两个数先缩放到 max(a,b) 的小数位、再把容差塞进同一个标度——
 * 那样容差的小数位会被当成整数位（'0.0001' 变成 1 个单位，5 vs 6 判一致）。
 * 这里委托给 withinTolerance：先精确做减法，再按各自的小数位补齐后比大小。
 * 负容差抛 RangeError（与 resolveOptions 入口拒绝负容差同口径，不静默放过）。
 */
export function sizeEqual(a: string, b: string, tolerance: string): boolean {
  return withinTolerance(a, b, tolerance)
}

/**
 * 价格相对漂移是否超出容差（基点）。用未缩放整数比较：
 *   |a - b| * 10_000 > |b| * bps
 * 全程 BigInt，不经浮点。b 为 0 时只有 a 也为 0 才算一致。
 */
export function priceDriftBeyondBps(a: string, b: string, bps: number): boolean {
  const { a: x, b: y } = commonScaled(a, b)
  const diff = x >= y ? x - y : y - x
  const base = y >= 0n ? y : -y
  if (base === 0n) return diff !== 0n
  return diff * 10_000n > base * BigInt(Math.trunc(bps))
}

/** 价格漂移的基点值（向下取整），用于写进给人看的说明。 */
export function driftBps(a: string, b: string): number {
  const { a: x, b: y } = commonScaled(a, b)
  const diff = x >= y ? x - y : y - x
  const base = y >= 0n ? y : -y
  if (base === 0n) return diff === 0n ? 0 : Number.POSITIVE_INFINITY
  return Number((diff * 10_000n) / base)
}

/** 浮点毫秒差（只用于时间），返回绝对值。 */
export function msDistance(a: number, b: number): number {
  return Math.abs(a - b)
}

/** 这个时刻是否比参考时刻早超过容差（时间先后判定带时钟偏差）。 */
export function isEarlierBeyondSkew(a: number, b: number, opts: ResolvedOptions): boolean {
  return b - a > opts.clockSkewMs
}

/** 中文数值比较结果描述，供 detail 拼句。 */
export function describeDelta(a: string, b: string): string {
  const cmp = compareDecimal(a, b)
  if (cmp === 0) return '相等'
  return cmp > 0 ? `${absDecimal(a)} 多于 ${absDecimal(b)}` : `${absDecimal(b)} 多于 ${absDecimal(a)}`
}
