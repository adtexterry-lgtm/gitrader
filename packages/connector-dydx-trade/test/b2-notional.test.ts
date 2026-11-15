// SPDX-License-Identifier: CPAL-1.0
import { describe, expect, it } from 'vitest'
import { parseInstruments } from '@gitrader/connector-dydx-data'
import type { Instrument } from '@gitrader/protocol'
import { mulDec } from '@gitrader/protocol/decimal'
import { DydxTradeConnector } from '../src/trading'

const NOW = 1_800_000_000_000

describe('B2 base-unit notional metadata', () => {
  it('injects the real dYdX data parser output into the trade connector market', () => {
    const parsed = parseInstruments({ markets: { 'BTC-USD': {
      clobPairId: '0', atomicResolution: -10, quantumConversionExponent: -9, stepBaseQuantums: '1000000',
      subticksPerTick: '100000', oraclePrice: '20000', tickSize: '0.1', stepSize: '0.01', status: 'ACTIVE',
    } } }, NOW)
    const source = {
      listInstruments: () => parsed,
      getInstrument: (id: string) => parsed.find((instrument) => instrument.instrumentId === id),
      quote: () => undefined, book: async () => { throw new Error('unused') }, candles: async () => [], context: async () => ({}),
      subscribe: () => () => undefined, status: () => ({ stale: false }),
    }
    const connector = new DydxTradeConnector({ market: source as never })
    const instrument = connector.getInstrument('dydx:BTC-USD') as Instrument
    expect(connector.listInstruments()).toContain(instrument)
    expect(instrument).toMatchObject({ venueSizeUnit: 'base', contractSize: '1' })
    expect(mulDec(mulDec('2.5', '12.4'), instrument.contractSize)).toBe('31')
  })
})
