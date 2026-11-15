// SPDX-License-Identifier: CPAL-1.0
// 批 4 人物回归的发现：名字带到期日的合约从搜索里消失；实时推送的提案带 approvalNeedsPin。
import { describe, expect, it } from 'vitest'
import type { Instrument } from '../src/proto'
import { filterSearchHits, symbolExpiry } from '../src/ops'

const inst = (symbol: string, extra: Partial<Instrument> = {}): Instrument => ({ instrumentId: `hyperliquid:${symbol}`, symbol, displaySymbol: symbol, status: 'trading', ...extra } as unknown as Instrument)

describe('search hides dated contracts after expiry', () => {
  it('parses DDMMMYY in names', () => {
    expect(symbolExpiry('hb:BTC-29AUG25')).toBe(Date.UTC(2025, 7, 29))
    expect(symbolExpiry('BTC-PERP')).toBeUndefined()
    expect(symbolExpiry('sekaw:BTC-PERP')).toBeUndefined()
  })

  it('drops expired dated contracts and keeps future ones and perps', () => {
    const now = Date.UTC(2026, 9, 25)
    const kept = filterSearchHits([inst('hb:BTC-29AUG25'), inst('hb:BTC-26SEP25'), inst('hb:BTC-25DEC26'), inst('BTC')], now).map((i) => i.symbol)
    expect(kept).toEqual(['hb:BTC-25DEC26', 'BTC'])
  })

  it('a contract stays searchable through its expiry day', () => {
    expect(filterSearchHits([inst('hb:BTC-25OCT26')], Date.UTC(2026, 9, 25, 12))).toHaveLength(1)
  })
})
