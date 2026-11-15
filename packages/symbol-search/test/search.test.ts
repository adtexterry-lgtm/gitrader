// SPDX-License-Identifier: CPAL-1.0
// 搜索：QD 的六档排序（代码精确 / 前缀 / 包含 / 名称包含 / 别名精确 / 别名包含）+ 本包补的模糊档、
// 扁平化归一化（btc/usdt → BTCUSDT）、自动补全（prefixOnly）、limit、空查询、跨场所确定性、findSymbol。
import { describe, expect, it } from 'vitest'
import { flatten, fuzzyScore, rankOf, searchSymbols } from '../src/search'
import { buildIndex } from '../src/record'
import { findSymbol, suggestSymbols } from '../src/search'
import { instrument } from './helpers/instruments'

const AAPL_AV = instrument({ venue: 'alphavantage', symbol: 'AAPL', assetClass: 'stocks', name: 'Apple Inc' })
const AAPL_PG = instrument({ venue: 'polygon', symbol: 'AAPL', assetClass: 'stocks', name: 'Apple Inc.' })
const BRKB = instrument({ venue: 'alphavantage', symbol: 'BRK.B', assetClass: 'stocks', name: 'Berkshire Hathaway Inc. Class B' })
const MSFT = instrument({ venue: 'alphavantage', symbol: 'MSFT', assetClass: 'stocks', name: 'Microsoft Corporation' })
const BTC_PERP = instrument({ venue: 'binance', symbol: 'BTCUSDT', kind: 'perp' })
const BTC_SPOT = instrument({ venue: 'binance', symbol: 'BTC/USDT' })
const OLD = instrument({ venue: 'polygon', symbol: 'OLD', assetClass: 'stocks', name: 'Old Delisted Co', status: 'delisted' })

const index = buildIndex({
  instruments: [AAPL_AV, AAPL_PG, BRKB, MSFT, BTC_PERP, BTC_SPOT, OLD],
  aliases: { 'alphavantage:AAPL': ['AAPL.US', '苹果'] },
  sortOrder: { 'alphavantage:MSFT': 5 },
})

const symbolsOf = (hits: ReturnType<typeof searchSymbols>): string[] => hits.map((h) => `${h.record.venue}:${h.record.symbol}`)

describe('search ranking', () => {
  it('puts the exact symbol first, then prefixes, then contains (QD rank 0 / 1 / 2)', () => {
    expect(searchSymbols(index, 'AAPL').map((h) => [h.rank, h.matchKind])[0]).toEqual([0, 'symbol-exact'])
    expect(symbolsOf(searchSymbols(index, 'AAPL', { limit: 5 }))).toEqual([
      'alphavantage:AAPL', 'polygon:AAPL',
    ])

    const btc = searchSymbols(index, 'BTC')
    expect(btc.map((h) => [h.record.symbol, h.rank, h.matchKind])).toEqual([
      ['BTCUSDT', 1, 'symbol-prefix'],
      ['BTC/USDT', 1, 'symbol-prefix'],
    ])
  })

  it('matches names as a lower tier and reports what it matched on', () => {
    const hits = searchSymbols(index, 'berkshire')
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ rank: 3, matchKind: 'name-contains', matchedOn: 'name' })
    expect(hits[0]!.record.symbol).toBe('BRK.B')
  })

  it('ranks an exact alias above a partial alias and keeps the hit alias', () => {
    expect(searchSymbols(index, '苹果')[0]).toMatchObject({ rank: 4, matchKind: 'alias-exact', matchedOn: 'alias', alias: '苹果' })
    const partial = searchSymbols(index, 'aapl.u')[0]!
    expect(partial).toMatchObject({ rank: 5, matchKind: 'alias-contains' })
    expect(partial.alias).toBe('AAPL.US')
    expect(partial.record.venue).toBe('alphavantage')
  })

  it('normalises slashes and dots so btc/usdt and brk-b still hit', () => {
    expect(symbolsOf(searchSymbols(index, 'btc/usdt'))).toEqual(['binance:BTCUSDT', 'binance:BTC/USDT'])
    expect(symbolsOf(searchSymbols(index, 'brk-b'))).toEqual(['alphavantage:BRK.B'])
    expect(flatten('brk.b')).toBe('BRKB')
  })

  it('falls back to fuzzy (subsequence or edit distance) only when nothing else matches', () => {
    const fuzzy = searchSymbols(index, 'MSFF')
    expect(fuzzy).toHaveLength(1)
    expect(fuzzy[0]).toMatchObject({ rank: 6, matchKind: 'fuzzy' })

    expect(searchSymbols(index, 'MSFF', { fuzzy: false })).toEqual([])
    expect(fuzzyScore('MSFF', 'MSFT')).toBeGreaterThanOrEqual(0)
    expect(fuzzyScore('zzzz', 'MSFT')).toBeLessThan(0)
    expect(rankOf(index.records[3]!, 'MSF')).toMatchObject({ kind: 'symbol-prefix' })
  })

  it('applies sortOrder before length and symbol (QD sort_order DESC)', () => {
    // 两个代码同长度：MSFT 的 sortOrder 5 让它排在 MSFL 一类同长度命中之前
    const widened = buildIndex({
      instruments: [MSFT, instrument({ venue: 'polygon', symbol: 'MSFX', assetClass: 'stocks', name: 'Msfx Corp' })],
      sortOrder: { 'alphavantage:MSFT': 5 },
    })
    expect(symbolsOf(searchSymbols(widened, 'MSF'))).toEqual(['alphavantage:MSFT', 'polygon:MSFX'])
  })

  it('hides delisted rows unless the filter asks for them', () => {
    expect(symbolsOf(searchSymbols(index, 'OLD'))).toEqual([])
    expect(symbolsOf(searchSymbols(index, 'OLD', { filter: { includeDelisted: true } }))).toEqual(['polygon:OLD'])
  })

  it('returns nothing for an empty or whitespace-only query (QD behaviour)', () => {
    expect(searchSymbols(index, '')).toEqual([])
    expect(searchSymbols(index, '   ')).toEqual([])
  })

  it('respects limit and defaults to 20', () => {
    expect(searchSymbols(index, 'a', { limit: 1 })).toHaveLength(1)
    const many = buildIndex({
      instruments: Array.from({ length: 30 }, (_, i) => instrument({
        venue: 'alphavantage',
        symbol: `AA${String(i).padStart(2, '0')}`,
        assetClass: 'stocks',
      })),
    })
    expect(searchSymbols(many, 'AA')).toHaveLength(20)
    expect(searchSymbols(many, 'AA', { limit: 5 })).toHaveLength(5)
  })
})

describe('normalisation and input hardening', () => {
  it('matches a Chinese name and reports name-contains on name', () => {
    const idx = buildIndex({
      instruments: [instrument({ venue: 'alphavantage', symbol: '600519', assetClass: 'stocks', name: '贵州茅台' })],
    })
    const hits = searchSymbols(idx, '茅台')
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ matchKind: 'name-contains', matchedOn: 'name' })
    expect(hits[0]!.record.symbol).toBe('600519')
  })

  it('normalises full-width queries with NFKC', () => {
    const hits = searchSymbols(index, 'ＡＡＰＬ')
    expect(hits[0]!.record.symbol).toBe('AAPL')
    expect(hits[0]!.matchKind).toBe('symbol-exact')
  })

  it('returns [] for a 10000-character query without throwing', () => {
    const huge = 'A'.repeat(10_000)
    expect(() => searchSymbols(index, huge)).not.toThrow()
    expect(searchSymbols(index, huge)).toEqual([])
  })

  it('treats regex metacharacters as plain text', () => {
    for (const q of ['.', '*', '+', '?', '(', ')', '[', ']']) {
      expect(() => searchSymbols(index, q)).not.toThrow()
    }
  })

  it('falls back to 20 when limit is not finite', () => {
    const many = buildIndex({
      instruments: Array.from({ length: 30 }, (_, i) => instrument({
        venue: 'alphavantage',
        symbol: `AA${String(i).padStart(2, '0')}`,
        assetClass: 'stocks',
      })),
    })
    expect(searchSymbols(many, 'AA', { limit: Number.NaN }).length).toBeLessThanOrEqual(20)
    expect(searchSymbols(many, 'AA', { limit: Number.POSITIVE_INFINITY }).length).toBeLessThanOrEqual(20)
  })

  it('copies alias arrays so caller mutations do not change results', () => {
    const aliases: string[] = ['OLDCO']
    const idx = buildIndex({
      instruments: [instrument({ venue: 'polygon', symbol: 'OLDX', assetClass: 'stocks', name: 'Old X' })],
      aliases: { 'polygon:OLDX': aliases },
    })
    expect(searchSymbols(idx, 'OLDCO')[0]).toMatchObject({ matchKind: 'alias-exact', matchedOn: 'alias' })
    aliases.push('NEWCO')
    expect(searchSymbols(idx, 'NEWCO')).toEqual([])
    expect(searchSymbols(idx, 'OLDCO')).toHaveLength(1)
  })
})

describe('autocomplete and exact lookup', () => {
  it('suggests only exact / prefix hits', () => {
    expect(suggestSymbols(index, 'BTC').map((h) => h.record.symbol)).toEqual(['BTCUSDT', 'BTC/USDT'])
    expect(suggestSymbols(index, 'apple')).toEqual([])
    expect(suggestSymbols(index, 'aapl', 1)).toHaveLength(1)
  })

  it('finds one record across venues and honours a filter', () => {
    expect(findSymbol(index, 'aapl')?.venue).toBe('alphavantage')
    expect(findSymbol(index, 'btc/usdt', { filter: { kinds: ['spot'] } })?.symbol).toBe('BTC/USDT')
    expect(findSymbol(index, 'nope-nothing')).toBeUndefined()
  })
})
