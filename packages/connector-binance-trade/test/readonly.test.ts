// SPDX-License-Identifier: CPAL-1.0
// 只读方法与数据包一致：同一份原始响应，我们的解析结果必须和 @gitrader/connector-binance-data 一致。
// 标的只有三处**故意**不同：orderTypes / tif / triggerPriceTypes（交易连接器能下单，数据包不能）。
import { describe, expect, it } from 'vitest'
import {
  parseBookTicker as dataBookTicker, parseDepth as dataDepth, parseInstruments as dataInstruments, parseKlines as dataKlines,
  parsePremiumIndex as dataPremiumIndex,
} from '@gitrader/connector-binance-data'
import { parseBookTicker, parseDepth, parseInstrumentRecords, parseKlines, parsePremiumIndex } from '../src/parse'
import { NOW, klines, symbolEntry } from './helpers/fake-binance-trade'

const exchangeInfo = { symbols: [symbolEntry(), symbolEntry({ symbol: 'ETHUSDT', baseAsset: 'ETH' })] }

describe('instrument parsing parity', () => {
  it('differs from the data package only in the trading declarations', () => {
    const ours = parseInstrumentRecords(exchangeInfo, NOW).map((r) => r.instrument)
    const theirs = dataInstruments(exchangeInfo, NOW)
    expect(ours).toHaveLength(theirs.length)
    const strip = (i: Record<string, unknown>) => {
      const { orderTypes, tif, triggerPriceTypes, ...rest } = i
      void orderTypes
      void tif
      void triggerPriceTypes
      return rest
    }
    expect(ours.map((i) => strip(i as unknown as Record<string, unknown>))).toEqual(theirs.map((i) => strip(i as unknown as Record<string, unknown>)))
    // 数据包声明「没有可下单类型」，我们声明真实可下的类型
    expect(theirs[0]!.orderTypes).toEqual([])
    expect(ours[0]!.orderTypes.length).toBe(7)
  })
})

describe('market data parity', () => {
  it('klines', () => {
    const rows = klines(NOW, 5)
    expect(parseKlines(rows)).toEqual(dataKlines(rows))
    expect(parseKlines([[1, '2']])).toEqual([])
  })

  it('bookTicker', () => {
    const raw = { symbol: 'BTCUSDT', bidPrice: '100.1', askPrice: '100.2', time: NOW }
    expect(parseBookTicker(raw, NOW + 5)).toEqual(dataBookTicker(raw, NOW + 5))
    expect(parseBookTicker({ bidPrice: '' }, NOW)).toEqual(dataBookTicker({ bidPrice: '' }, NOW))
  })

  it('depth', () => {
    const raw = { T: NOW, bids: [['100', '1'], ['99', '2']], asks: [['101', '1']] }
    expect(parseDepth(raw, 'binance:BTCUSDT', 20, NOW)).toEqual(dataDepth(raw, 'binance:BTCUSDT', 20, NOW))
  })

  it('premiumIndex', () => {
    const raw = { markPrice: '100.05', indexPrice: '100', lastFundingRate: '0.0001', time: NOW }
    expect(parsePremiumIndex(raw, 'binance:BTCUSDT', NOW + 1)).toEqual(dataPremiumIndex(raw, 'binance:BTCUSDT', NOW + 1))
  })
})
