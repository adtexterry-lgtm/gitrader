// SPDX-License-Identifier: CPAL-1.0
import { describe, expect, it } from 'vitest'
import { mulDec } from '@gitrader/protocol/decimal'
import { buildOrderParams } from '../src/orders'
import { defaultBudget, OkxTradeConnector } from '../src/connector'
import { API_KEY, API_SECRET, BASE_URL, FakeOkxTrade, NOW, PASSPHRASE } from './helpers/fake-okx-trade'

describe('B2 base-unit notional metadata', () => {
  it('uses the connector trading view and preserves ctVal for contract transport', async () => {
    const fake = new FakeOkxTrade()
    const connector = new OkxTradeConnector({
      apiKey: API_KEY, apiSecret: API_SECRET, passphrase: PASSPHRASE, baseUrl: BASE_URL,
      fetchImpl: fake.fetch, clock: () => NOW, budget: defaultBudget(() => NOW), onWarn: () => {},
    })
    await connector.start()
    try {
      const instrument = connector.getInstrument('okx:BTC-USDT-SWAP')!
      const record = connector.recordOf(instrument.instrumentId)!
      expect(instrument).toMatchObject({ venueSizeUnit: 'base', contractSize: '1' })
      expect(mulDec(mulDec('0.02', '100'), instrument.contractSize)).toBe('2')
      const built = buildOrderParams({
        accountId: 'acct_okx_b2' as never, instrumentId: instrument.instrumentId, side: 'buy', type: 'limit',
        size: '0.02' as never, price: '100' as never,
      }, record)
      expect(record.ctVal).toBe('0.01')
      expect(built.body.sz).toBe('2')
    } finally { await connector.close() }
  })
})
