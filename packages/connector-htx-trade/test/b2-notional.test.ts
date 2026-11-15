// SPDX-License-Identifier: CPAL-1.0
import { describe, expect, it } from 'vitest'
import { mulDec } from '@gitrader/protocol/decimal'
import { parseContract } from '../src/market'
import { baseToContracts, contractsToBase } from '../src/precision'

describe('B2 base-unit notional metadata', () => {
  it('keeps the parsed contract face value in transport conversion', () => {
    const instrument = parseContract({ contract_code: 'BTC-USDT', contract_size: '0.001', price_tick: '0.1', contract_status: 1 }, 1_800_000_000_000)!
    expect(instrument).toMatchObject({ venueSizeUnit: 'base', contractSize: '1', size: { step: '0.001', min: '0.001' } })
    expect(mulDec(mulDec('0.02', '100'), instrument.contractSize)).toBe('2')
    const contracts = baseToContracts('0.02', '0.001')
    expect(contracts).toBe(20)
    expect(contractsToBase(contracts, '0.001')).toBe('0.02')
  })
})
