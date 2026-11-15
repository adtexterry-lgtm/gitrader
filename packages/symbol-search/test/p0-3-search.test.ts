// SPDX-License-Identifier: CPAL-1.0
// dex 同名市场：搜主市场代码时主市场排前面，搜带 dex 前缀的名字能命中该 dex 的记录。
import { describe, expect, it } from 'vitest'
import { buildIndex } from '../src/record'
import { searchSymbols } from '../src/search'
import { instrument } from './helpers/instruments'

const MAIN = { ...instrument({ venue: 'hyperliquid', symbol: 'BTC', kind: 'perp', name: 'Bitcoin perpetual' }), displaySymbol: 'BTC-PERP' }
const DEX = {
  ...instrument({ venue: 'hyperliquid', symbol: 'sekaw:BTC', kind: 'perp', name: 'Bitcoin perpetual', marketGroup: 'sekaw' }),
  displaySymbol: 'sekaw:BTC-PERP',
}

// dex 记录的场所内权重更高：同分时仍然主市场在前
const index = buildIndex({ instruments: [DEX, MAIN], sortOrder: { 'hyperliquid:sekaw:BTC': 10 } })

const idsOf = (query: string): string[] => searchSymbols(index, query).map((hit) => hit.record.instrumentId)

describe('dex-aware ranking', () => {
  it('BTC-PERP ranks main market first', () => {
    expect(idsOf('BTC-PERP')[0]).toBe('hyperliquid:BTC')
    expect(idsOf('BTC')[0]).toBe('hyperliquid:BTC')
    // 名称同分（rank 3）时主市场也在前
    expect(idsOf('Bitcoin')[0]).toBe('hyperliquid:BTC')
  })

  it('dex query hits dex market', () => {
    expect(idsOf('sekaw:BTC')).toEqual(['hyperliquid:sekaw:BTC'])
    expect(idsOf('sekaw')).toEqual(['hyperliquid:sekaw:BTC'])
  })
})
