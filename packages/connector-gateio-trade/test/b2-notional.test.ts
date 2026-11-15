// SPDX-License-Identifier: CPAL-1.0
import { describe, expect, it } from 'vitest'
import { mulDec } from '@gitrader/protocol/decimal'
import { buildOrder } from '../src/orders'
import { parseInstrumentRecords } from '../src/parse'
import { contractRow, NOW } from './helpers/fake-gate'

describe('B2 base-unit notional metadata', () => {
  it('keeps Gate face value for contract transport while exposing base/1 metadata', () => {
    const record = parseInstrumentRecords([contractRow({ quanto_multiplier: '0.001', order_size_min: '1' })], NOW)[0]!
    expect(record.instrument).toMatchObject({ venueSizeUnit: 'base', contractSize: '1' })
    expect(mulDec(mulDec('0.02', '100'), record.instrument.contractSize)).toBe('2')
    const built = buildOrder({
      accountId: 'acct_gateio_b2' as never, instrumentId: record.instrument.instrumentId, side: 'buy', type: 'limit',
      size: '0.02' as never, price: '100' as never,
    }, record)
    expect(record.contractSize).toBe('0.001')
    expect(built.body.size).toBe('20')
    expect(built.contractSize).toBe('0.001')
  })
})
