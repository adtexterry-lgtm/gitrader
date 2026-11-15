// SPDX-License-Identifier: CPAL-1.0
import { describe, expect, it } from 'vitest'
import { mulDec } from '@gitrader/protocol/decimal'
import { parseInstrumentRecords } from '../src/parse'
import { NOW, symbolEntry } from './helpers/fake-binance-trade'

describe('B2 base-unit notional metadata', () => {
  it('uses the production exchange-info parser and computes base-quantity notional', () => {
    const instrument = parseInstrumentRecords({ symbols: [symbolEntry()] }, NOW)[0]!.instrument
    expect(instrument).toMatchObject({ venueSizeUnit: 'base', contractSize: '1' })
    expect(mulDec(mulDec('2.5', '12.4'), instrument.contractSize)).toBe('31')
  })
})
