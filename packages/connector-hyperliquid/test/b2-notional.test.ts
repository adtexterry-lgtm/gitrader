// SPDX-License-Identifier: CPAL-1.0
import { describe, expect, it } from 'vitest'
import { mulDec } from '@gitrader/protocol/decimal'
import { HyperliquidConnector } from '../src/connector'
import { FX_NOW, FakeHl } from './helpers/fake-hl'

describe('B2 base-unit notional metadata', () => {
  it('uses the discovered Hyperliquid trading instrument and computes base-quantity notional', async () => {
    const fake = new FakeHl()
    const connector = new HyperliquidConnector({ environment: 'mainnet', fetchImpl: fake.fetch, useWs: false, discoveryIntervalMs: 0, clock: () => FX_NOW })
    try {
      await connector.market.refreshInstruments()
      const instrument = connector.getInstrument('hyperliquid:BTC')!
      expect(connector.listInstruments()).toContain(instrument)
      expect(instrument).toMatchObject({ venueSizeUnit: 'base', contractSize: '1' })
      expect(mulDec(mulDec('2.5', '12.4'), instrument.contractSize)).toBe('31')
    } finally { await connector.close() }
  })
})
