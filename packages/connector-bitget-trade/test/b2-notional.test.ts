// SPDX-License-Identifier: CPAL-1.0
import { describe, expect, it } from 'vitest'
import { parseInstruments } from '@gitrader/connector-bitget-data'
import { mulDec } from '@gitrader/protocol/decimal'
import { contractRow, NOW } from './helpers/fake-bitget'

describe('B2 base-unit notional metadata', () => {
  it('uses the delegated Bitget data parser and computes base-quantity notional', () => {
    const instrument = parseInstruments([contractRow()], NOW)[0]!
    expect(instrument).toMatchObject({ venueSizeUnit: 'base', contractSize: '1' })
    expect(mulDec(mulDec('2.5', '12.4'), instrument.contractSize)).toBe('31')
  })
})
