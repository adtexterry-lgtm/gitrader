// SPDX-License-Identifier: CPAL-1.0
// 非默认 dex（HIP-3）的币名本身带前缀：displaySymbol 带上 dex，主市场不加，同名的两个市场才分得清。
import { describe, expect, it } from 'vitest'
import { buildInstrumentRecords } from '../src/parse'

const NOW = 1_792_468_800_000

/** 最小 meta 夹具：一个币 + 一条上下文（上下文内容对 displaySymbol 无影响）。 */
const metaOf = (name: string): unknown => [{ universe: [{ name, szDecimals: 5, maxLeverage: 20 }] }, [{}]]

describe('displaySymbol and dex', () => {
  it('non-default dex gets dex prefix', () => {
    const [rec] = buildInstrumentRecords(metaOf('sekaw:BTC'), 'sekaw', 1, NOW)
    expect(rec!.instrument.displaySymbol).toBe('sekaw:BTC-PERP')
    expect(rec!.instrument.marketGroup).toBe('sekaw')
  })

  it('default dex unchanged', () => {
    const [rec] = buildInstrumentRecords(metaOf('BTC'), '', 0, NOW)
    expect(rec!.instrument.displaySymbol).toBe('BTC-PERP')
    expect(rec!.instrument.marketGroup).toBeNull()
  })
})
