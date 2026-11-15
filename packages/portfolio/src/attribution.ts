// SPDX-License-Identifier: CPAL-1.0
// 盈亏归因：按策略 / 场所 / 标的拆「已实现 + 未实现 + 资金费」。
// 口径：
//   realized  = 场所上报的 Position.realizedPnl（现金流符号），折到计价币；
//   unrealized= 用**注入价**重算（与估值同源，不复制场所的 unrealizedPnl）；
//   funding   = 场所上报的 Position.fundingSinceOpen，折到计价币；
//   total     = realized + unrealized + funding；
//   drift     = unrealized − venueUnrealized（场所上报值），供对账：大了就是价格口径不一致。
// 不变式：任何一个维度的桶之和必须等于 total（同精度 8 位下精确相等，测试守着）。
import type { Fx } from '@gitrader/protocol/decimal'
import { fx } from '@gitrader/protocol/decimal'
import { cmp, dec } from './decimal'
import type { Decimal, ValuedPosition } from './types'

export interface PnlBucket {
  readonly key: string
  readonly realized: Decimal
  readonly unrealized: Decimal
  readonly funding: Decimal
  readonly total: Decimal
  /** 场所上报的未实现盈亏（已折计价币），对账用，不参与 total。 */
  readonly venueUnrealized: Decimal
  /** unrealized − venueUnrealized。 */
  readonly drift: Decimal
  readonly positionCount: number
}

export interface AttributionReport {
  readonly total: PnlBucket
  readonly byStrategy: readonly PnlBucket[]
  readonly byVenue: readonly PnlBucket[]
  readonly byInstrument: readonly PnlBucket[]
}

interface Acc {
  realized: Fx
  unrealized: Fx
  funding: Fx
  venue: Fx
  count: number
}

const emptyAcc = (): Acc => ({ realized: 0n, unrealized: 0n, funding: 0n, venue: 0n, count: 0 })

function accumulate(acc: Acc, position: ValuedPosition): void {
  acc.realized += fx(position.realizedPnl)
  acc.unrealized += fx(position.unrealizedPnl)
  acc.funding += fx(position.funding)
  acc.venue += fx(position.venueUnrealizedPnl)
  acc.count += 1
}

function toBucket(key: string, acc: Acc): PnlBucket {
  return {
    key,
    realized: dec(acc.realized),
    unrealized: dec(acc.unrealized),
    funding: dec(acc.funding),
    total: dec(acc.realized + acc.unrealized + acc.funding),
    venueUnrealized: dec(acc.venue),
    drift: dec(acc.unrealized - acc.venue),
    positionCount: acc.count,
  }
}

function bucketize(positions: readonly ValuedPosition[], keyOf: (position: ValuedPosition) => string): PnlBucket[] {
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
    .sort((a, b) => cmp(fx(b.total), fx(a.total)) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
}

/** 按策略归因。没有策略标签的持仓落在 `unassigned` 桶。 */
export function attributionByStrategy(positions: readonly ValuedPosition[]): PnlBucket[] {
  return bucketize(positions, (position) => position.strategyId)
}

/** 按场所归因。 */
export function attributionByVenue(positions: readonly ValuedPosition[]): PnlBucket[] {
  return bucketize(positions, (position) => position.venue)
}

/** 按标的归因。 */
export function attributionByInstrument(positions: readonly ValuedPosition[]): PnlBucket[] {
  return bucketize(positions, (position) => position.instrumentId)
}

/** 总盈亏（单桶）。 */
export function attributionTotals(positions: readonly ValuedPosition[]): PnlBucket {
  const acc = emptyAcc()
  for (const position of positions) accumulate(acc, position)
  return toBucket('total', acc)
}

/** 一次出三张归因视图。 */
export function attributionOf(positions: readonly ValuedPosition[]): AttributionReport {
  return {
    total: attributionTotals(positions),
    byStrategy: attributionByStrategy(positions),
    byVenue: attributionByVenue(positions),
    byInstrument: attributionByInstrument(positions),
  }
}
