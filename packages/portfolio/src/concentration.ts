// SPDX-License-Identifier: CPAL-1.0
// 集中度：用**绝对敞口**（多空都算正）算赫芬达尔指数 HHI、等效持仓数、前 N 大占比。
// 为什么用绝对敞口而不是净敞口：同一标的多空各 100 万时净敞口为 0，但风险全压在一个标的上，
// 用净敞口会得出「完全不集中」的假结论。这条口径有反证用例守着（见 test/concentration.test.ts）。
import type { Fx } from '@gitrader/protocol/decimal'
import { fx } from '@gitrader/protocol/decimal'
import { cmp, dec, divOr } from './decimal'
import type { Decimal, ValuedPosition } from './types'

export type ConcentrationDimension = 'asset' | 'venue' | 'instrument' | 'strategy'

export interface ConcentrationBucket {
  readonly key: string
  /** 绝对敞口（计价币）。 */
  readonly exposure: Decimal
  /** 占组合总绝对敞口的比重（0..1）。 */
  readonly weight: Decimal
}

export interface ConcentrationReport {
  readonly dimension: ConcentrationDimension
  readonly gross: Decimal
  /** Σ wᵢ²，0..1；只有一笔时 = 1，完全分散时趋近 0。 */
  readonly hhi: Decimal
  /** 1 / HHI，即「等效持仓数」；空组合为 0。 */
  readonly effectiveN: Decimal
  readonly top1: Decimal
  readonly top3: Decimal
  readonly top5: Decimal
  readonly largest: ConcentrationBucket | null
  readonly buckets: readonly ConcentrationBucket[]
}

const KEY_OF: Record<ConcentrationDimension, (position: ValuedPosition) => string> = {
  asset: (position) => position.base,
  venue: (position) => position.venue,
  instrument: (position) => position.instrumentId,
  strategy: (position) => position.strategyId,
}

function absoluteExposure(position: ValuedPosition): Fx {
  const signed = fx(position.signedExposure)
  return signed < 0n ? -signed : signed
}

/** 单一维度的集中度。 */
export function concentration(positions: readonly ValuedPosition[], dimension: ConcentrationDimension): ConcentrationReport {
  const keyOf = KEY_OF[dimension]
  const grouped = new Map<string, Fx>()
  for (const position of positions) {
    const key = keyOf(position)
    grouped.set(key, (grouped.get(key) ?? 0n) + absoluteExposure(position))
  }
  const entries = [...grouped.entries()].sort((a, b) => cmp(b[1], a[1]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  let gross = 0n
  for (const [, value] of entries) gross += value

  const weighted = entries.map(([key, value]) => ({ key, value, weight: divOr(value, gross) }))
  let hhi = 0n
  for (const item of weighted) hhi = hhi + (item.weight * item.weight) / fx('1')
  const topK = (k: number): Fx => {
    let sum = 0n
    for (let i = 0; i < Math.min(k, weighted.length); i += 1) {
      const item = weighted[i]
      if (item !== undefined) sum += item.weight
    }
    return sum
  }

  const buckets: ConcentrationBucket[] = weighted.map((item) => ({
    key: item.key,
    exposure: dec(item.value),
    weight: dec(item.weight),
  }))
  const largest = buckets[0] ?? null
  return {
    dimension,
    gross: dec(gross),
    hhi: dec(hhi),
    effectiveN: hhi === 0n ? dec(0n) : dec(divOr(fx('1'), hhi)),
    top1: dec(topK(1)),
    top3: dec(topK(3)),
    top5: dec(topK(5)),
    largest,
    buckets,
  }
}

export interface ConcentrationAll {
  readonly byAsset: ConcentrationReport
  readonly byVenue: ConcentrationReport
  readonly byInstrument: ConcentrationReport
  readonly byStrategy: ConcentrationReport
}

/** 四个维度一次算完（「资金与资产」页的集中度卡片直接用）。 */
export function concentrationOf(positions: readonly ValuedPosition[]): ConcentrationAll {
  return {
    byAsset: concentration(positions, 'asset'),
    byVenue: concentration(positions, 'venue'),
    byInstrument: concentration(positions, 'instrument'),
    byStrategy: concentration(positions, 'strategy'),
  }
}
