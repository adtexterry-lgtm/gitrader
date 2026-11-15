// SPDX-License-Identifier: CPAL-1.0
// 过滤（场所 / 类型 / 资产类别 / 报价货币 / 连接器 / 下架）与挑选校验（QD watchlist.py:validate_watchlist_pair 的四条规则）。
import { describe, expect, it } from 'vitest'
import { matchesFilter, normalizeSymbol, validateSelection } from '../src/filter'
import { buildIndex, recordOf } from '../src/record'
import { searchSymbols } from '../src/search'
import { instrument } from './helpers/instruments'

const AAPL = instrument({ venue: 'alphavantage', symbol: 'AAPL', assetClass: 'stocks', name: 'Apple Inc' })
const BRKB = instrument({ venue: 'alphavantage', symbol: 'BRK.B', assetClass: 'stocks', name: 'Berkshire Hathaway Inc. Class B' })
const BTC_PERP = instrument({ venue: 'binance', symbol: 'BTCUSDT', kind: 'perp' })
const BTC_SPOT = instrument({ venue: 'binance', symbol: 'BTC/USDT' })
const OLD = instrument({ venue: 'polygon', symbol: 'OLD', assetClass: 'stocks', status: 'delisted' })

const index = buildIndex({ instruments: [AAPL, BRKB, BTC_PERP, BTC_SPOT, OLD] })
const symbolsOf = (hits: ReturnType<typeof searchSymbols>): string[] => hits.map((h) => `${h.record.venue}:${h.record.symbol}`)
const recordFor = (seed: Parameters<typeof instrument>[0]): ReturnType<typeof recordOf> =>
  recordOf(instrument(seed), seed.venue)

describe('filters', () => {
  it('filters by venue and by connector source', () => {
    expect(symbolsOf(searchSymbols(index, 'B', { filter: { venues: ['binance'] } })))
      .toEqual(['binance:BTCUSDT', 'binance:BTC/USDT'])
    expect(symbolsOf(searchSymbols(index, 'B', { filter: { sources: ['alphavantage'] } })))
      .toEqual(['alphavantage:BRK.B'])
  })

  it('filters by instrument kind (market type)', () => {
    expect(symbolsOf(searchSymbols(index, 'BTC', { filter: { kinds: ['perp'] } }))).toEqual(['binance:BTCUSDT'])
    expect(symbolsOf(searchSymbols(index, 'BTC', { filter: { kinds: ['spot'] } }))).toEqual(['binance:BTC/USDT'])
  })

  it('filters by asset class and by quote currency, single value or list', () => {
    expect(symbolsOf(searchSymbols(index, 'AA', { filter: { assetClass: 'stocks' } })))
      .toEqual(['alphavantage:AAPL'])
    expect(symbolsOf(searchSymbols(index, 'AA', { filter: { assetClass: ['crypto'] } }))).toEqual([])
    expect(symbolsOf(searchSymbols(index, 'BTC', { filter: { quote: 'usdt' } })))
      .toEqual(['binance:BTCUSDT', 'binance:BTC/USDT'])
    expect(symbolsOf(searchSymbols(index, 'BTC', { filter: { quote: ['USDC'] } }))).toEqual([])
  })

  it('treats delisted rows as excluded unless includeDelisted is true', () => {
    expect(symbolsOf(searchSymbols(index, 'OLD'))).toEqual([])
    expect(symbolsOf(searchSymbols(index, 'OLD', { filter: { includeDelisted: true } }))).toEqual(['polygon:OLD'])
  })

  it('matches everything when the filter is undefined', () => {
    const record = index.records[0]!
    expect(matchesFilter(record, undefined)).toBe(true)
    expect(matchesFilter(record, {})).toBe(true)
  })
})

describe('selection validation (watchlist semantics)', () => {
  it('normalises a symbol by trimming and upper-casing it', () => {
    expect(normalizeSymbol('  btc/usdt ')).toBe('BTC/USDT')
  })

  it('rejects an empty symbol', () => {
    const record = recordFor({ venue: 'binance', symbol: 'BTCUSDT', kind: 'perp' })
    expect(validateSelection({ ...record!, symbol: '' })).toEqual({ code: 'EMPTY_SYMBOL', message: 'Empty symbol' })
  })

  it('rejects a six-digit A-share-looking code unless it is a stock', () => {
    const cryptoCode = recordFor({ venue: 'binance', symbol: '600519' })!
    expect(validateSelection(cryptoCode)).toMatchObject({ code: 'CN_CODE_NOT_STOCK' })
    const stockCode = recordFor({ venue: 'alphavantage', symbol: '600519', assetClass: 'stocks' })!
    expect(validateSelection(stockCode)).toBeUndefined()
  })

  it('rejects a .HK code unless it is a stock', () => {
    const record = recordFor({ venue: 'binance', symbol: '0700.HK' })!
    expect(validateSelection(record)).toMatchObject({ code: 'HK_CODE_NOT_STOCK' })
    expect(validateSelection(recordFor({ venue: 'polygon', symbol: '0700.HK', assetClass: 'stocks' })!)).toBeUndefined()
  })

  it('rejects a crypto record that carries no quote currency (QD: must be BASE/QUOTE)', () => {
    const bare = recordFor({ venue: 'binance', symbol: 'BTC', quote: '' })!
    expect(validateSelection(bare)).toMatchObject({ code: 'CRYPTO_NOT_A_PAIR' })
    expect(validateSelection(recordFor({ venue: 'binance', symbol: 'BTCUSDT', kind: 'perp' })!)).toBeUndefined()
  })

  it('accepts a well-formed stock and a well-formed perp', () => {
    expect(validateSelection(index.byInstrumentId.get('alphavantage:AAPL')!)).toBeUndefined()
    expect(validateSelection(index.byInstrumentId.get('binance:BTCUSDT')!)).toBeUndefined()
    expect(validateSelection(index.byInstrumentId.get('binance:BTC/USDT')!)).toBeUndefined()
  })
})
