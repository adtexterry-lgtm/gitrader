// SPDX-License-Identifier: CPAL-1.0
import { describe, expect, it } from 'vitest'
import { mulDec } from '@gitrader/protocol/decimal'
import { instruments } from './helpers/harness'

describe('B2 base-unit notional metadata', () => {
  it('uses the delegated Bybit data parser output and computes base-quantity notional', () => {
    const instrument = instruments()[0]!
    expect(instrument).toMatchObject({ venueSizeUnit: 'base', contractSize: '1' })
    expect(mulDec(mulDec('2.5', '12.4'), instrument.contractSize)).toBe('31')
  })
})
