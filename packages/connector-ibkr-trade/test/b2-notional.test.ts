// SPDX-License-Identifier: CPAL-1.0
import { afterEach, describe, expect, it } from 'vitest'
import { mulDec } from '@gitrader/protocol/decimal'
import { makeHarness } from './helpers/harness'
import type { Harness } from './helpers/harness'

let h: Harness | undefined
afterEach(async () => { await h?.close(); h = undefined })

describe('B2 base-unit notional metadata', () => {
  it('uses the real qualified stock instrument and computes share notional', async () => {
    h = await makeHarness()
    const instrument = h.connector.listInstruments()[0]!
    expect(instrument).toMatchObject({ venueSizeUnit: 'base', contractSize: '1', assetClass: 'stocks' })
    expect(mulDec(mulDec('2.5', '123.45'), instrument.contractSize)).toBe('308.625')
  })
})
