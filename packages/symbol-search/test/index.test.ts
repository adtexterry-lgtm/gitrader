// SPDX-License-Identifier: CPAL-1.0
// 建索引：Instrument → SymbolRecord（名字取 underlying.description、别名 / 权重注入）、
// QD dedupe 键去重、跨连接器合并、indexFromConnectors。
import { describe, expect, it } from 'vitest'
import { buildIndex, dedupeKey, dedupeRecords, indexFromConnectors, mergeIndexes, recordOf } from '../src/record'
import { connectorOf, instrument } from './helpers/instruments'

const AAPL_AV = instrument({ venue: 'alphavantage', symbol: 'AAPL', assetClass: 'stocks', name: 'Apple Inc' })
const AAPL_PG = instrument({ venue: 'polygon', symbol: 'AAPL', assetClass: 'stocks', name: 'Apple Inc.' })
const BTC_PERP = instrument({ venue: 'binance', symbol: 'BTCUSDT', kind: 'perp' })
const BTC_SPOT = instrument({ venue: 'binance', symbol: 'BTC/USDT' })

describe('index building', () => {
  it('maps an instrument into a flat searchable record', () => {
    const index = buildIndex({ instruments: [AAPL_AV] })
    expect(index.records).toHaveLength(1)
    expect(index.records[0]).toEqual({
      instrumentId: 'alphavantage:AAPL',
      venue: 'alphavantage',
      symbol: 'AAPL',
      displaySymbol: 'AAPL',
      name: 'Apple Inc',
      aliases: [],
      kind: 'spot',
      assetClass: 'stocks',
      quote: 'USD',
      settle: 'USD',
      status: 'trading',
      marketGroup: null,
      sortOrder: 0,
      source: 'alphavantage',
    })
    expect(index.sources).toEqual(['alphavantage'])
  })

  it('takes aliases, display names and sort weights from the caller', () => {
    const index = buildIndex({
      instruments: [AAPL_AV],
      aliases: { 'alphavantage:AAPL': ['AAPL.US', '苹果'] },
      names: { 'alphavantage:AAPL': '苹果公司' },
      sortOrder: { 'alphavantage:AAPL': 7 },
    })
    expect(index.records[0]).toMatchObject({ name: '苹果公司', aliases: ['AAPL.US', '苹果'], sortOrder: 7 })
  })

  it('drops records without a symbol or venue instead of guessing one', () => {
    const broken = { ...AAPL_AV, symbol: '   ' }
    const noVenue = { ...AAPL_AV, venue: '' }
    expect(recordOf(broken, 'alphavantage')).toBeUndefined()
    expect(recordOf(noVenue, 'alphavantage')).toBeUndefined()
    expect(buildIndex({ instruments: [broken, noVenue, AAPL_AV] }).records).toHaveLength(1)
  })

  it('dedupes on the QD key (venue, symbol, kind, instrumentId)', () => {
    // 同一连接器交回重复行（分页重叠）时只留一条
    const index = buildIndex({ instruments: [AAPL_AV, AAPL_AV, AAPL_PG] })
    expect(index.records).toHaveLength(2)
    expect(index.records.map((r) => r.venue)).toEqual(['alphavantage', 'polygon'])
    expect(dedupeKey(index.records[0]!)).toBe('alphavantage|AAPL|spot|alphavantage:AAPL')
  })

  it('keeps spot and perp of the same coin apart (kind is part of the key)', () => {
    const index = buildIndex({ instruments: [BTC_PERP, BTC_SPOT] })
    expect(index.records.map((r) => `${r.symbol}:${r.kind}`)).toEqual(['BTCUSDT:perp', 'BTC/USDT:spot'])
    expect(dedupeRecords(index.records)).toHaveLength(2)
  })

  it('merges several connector indexes and unions their sources', () => {
    const merged = mergeIndexes([
      buildIndex({ instruments: [AAPL_AV, BTC_PERP] }),
      buildIndex({ instruments: [AAPL_PG, BTC_SPOT] }),
    ])
    expect(merged.records).toHaveLength(4)
    expect(merged.sources).toEqual(['alphavantage', 'binance', 'polygon'])
    expect(merged.byInstrumentId.get('polygon:AAPL')?.name).toBe('Apple Inc.')
  })

  it('builds one index across the registered connectors, honouring includeDelisted', () => {
    const delisted = instrument({ venue: 'polygon', symbol: 'OLD', assetClass: 'stocks', status: 'delisted' })
    const connectors = [connectorOf('alphavantage', [AAPL_AV]), connectorOf('binance', [BTC_PERP, BTC_SPOT])]
    const withStocks = indexFromConnectors([...connectors, connectorOf('polygon', [AAPL_PG, delisted])])
    expect(withStocks.sources).toEqual(['alphavantage', 'binance', 'polygon'])
    expect(withStocks.byInstrumentId.has('polygon:OLD')).toBe(false)

    const all = indexFromConnectors([connectorOf('polygon', [AAPL_PG, delisted])], { includeDelisted: true })
    expect(all.byInstrumentId.get('polygon:OLD')?.status).toBe('delisted')
  })

  it('is pure: two builds over the same input do not share mutable state', () => {
    const first = buildIndex({ instruments: [AAPL_AV] })
    const second = buildIndex({ instruments: [AAPL_AV] })
    expect(first.records).not.toBe(second.records)
    expect(first.records[0]).toEqual(second.records[0])
  })
})
