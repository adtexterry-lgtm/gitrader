// SPDX-License-Identifier: CPAL-1.0
// 敞口：按资产 / 场所 / 方向汇总估值后的持仓。
// 口径（写进 README 与测试）：
//   gross = Σ|带方向敞口|（多空不互抵）；net = Σ带方向敞口（同一资产跨场所、跨方向互抵）；
//   quantity = Σ带符号基础资产数量（多正空负），用于「资产」视图看真实币量。
import type { Fx } from '@gitrader/protocol/decimal'
import { fx } from '@gitrader/protocol/decimal'
import { cmp, dec } from './decimal'
import type { Decimal, ValuedPosition } from './types'

export interface ExposureBucket {
  readonly key: string
  readonly gross: Decimal
  readonly net: Decimal
  readonly long: Decimal
  readonly short: Decimal
  /** 带符号基础资产数量。 */
  readonly quantity: Decimal
  readonly positionCount: number
}

export interface ExposureDirection {
  readonly long: Decimal
  readonly short: Decimal
  readonly net: Decimal
  readonly gross: Decimal
}

export interface ExposureReport {
  readonly totals: ExposureBucket
  readonly byAsset: readonly ExposureBucket[]
  readonly byVenue: readonly ExposureBucket[]
  readonly byInstrument: readonly ExposureBucket[]
  readonly byDirection: ExposureDirection
}

interface Acc {
  gross: Fx
  net: Fx
  long: Fx
  short: Fx
  quantity: Fx
  count: number
}

const emptyAcc = (): Acc => ({ gross: 0n, net: 0n, long: 0n, short: 0n, quantity: 0n, count: 0 })

function accumulate(acc: Acc, position: ValuedPosition): void {
  const signed = fx(position.signedExposure)
  acc.gross += signed < 0n ? -signed : signed
  acc.net += signed
  if (signed < 0n) acc.short += -signed
  else acc.long += signed
  acc.quantity += fx(position.baseQuantity)
  acc.count += 1
}

function toBucket(key: string, acc: Acc): ExposureBucket {
  return {
    key,
    gross: dec(acc.gross),
    net: dec(acc.net),
    long: dec(acc.long),
    short: dec(acc.short),
    quantity: dec(acc.quantity),
    positionCount: acc.count,
  }
}

function bucketize(positions: readonly ValuedPosition[], keyOf: (position: ValuedPosition) => string): ExposureBucket[] {
  const groups = new Map<string, Acc>()
  for (const position of positions) {
    const key = keyOf(position)
    let acc = groups.get(key)
    if (acc === undefined) {
      acc = emptyAcc()
      groups.set(key, acc)
    }
    accumulate(acc, position)
  }
  return [...groups.entries()]
    .map(([key, acc]) => toBucket(key, acc))
    .sort((a, b) => cmp(fx(b.gross), fx(a.gross)) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
}

/** 按基础资产（base）汇总。跨场所、跨账户的同一资产在这里合并。 */
export function exposureByAsset(positions: readonly ValuedPosition[]): ExposureBucket[] {
  return bucketize(positions, (position) => position.base)
}

/** 按场所汇总。 */
export function exposureByVenue(positions: readonly ValuedPosition[]): ExposureBucket[] {
  return bucketize(positions, (position) => position.venue)
}

/** 按标的汇总：同一标的跨账户、跨方向合并（净持仓看 net，毛敞口看 gross）。 */
export function exposureByInstrument(positions: readonly ValuedPosition[]): ExposureBucket[] {
  return bucketize(positions, (position) => position.instrumentId)
}

/** 按方向汇总：long / short 各自的名义和（正数），net = long − short，gross = long + short。 */
export function exposureByDirection(positions: readonly ValuedPosition[]): ExposureDirection {
  const acc = emptyAcc()
  for (const position of positions) accumulate(acc, position)
  return { long: dec(acc.long), short: dec(acc.short), net: dec(acc.net), gross: dec(acc.gross) }
}

/** 总敞口（单桶）。 */
export function exposureTotals(positions: readonly ValuedPosition[]): ExposureBucket {
  const acc = emptyAcc()
  for (const position of positions) accumulate(acc, position)
  return toBucket('total', acc)
}

/** 一次出三张敞口视图。 */
export function exposureOf(positions: readonly ValuedPosition[]): ExposureReport {
  return {
    totals: exposureTotals(positions),
    byAsset: exposureByAsset(positions),
    byVenue: exposureByVenue(positions),
    byInstrument: exposureByInstrument(positions),
    byDirection: exposureByDirection(positions),
  }
}
