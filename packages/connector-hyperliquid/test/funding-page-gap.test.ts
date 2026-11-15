// SPDX-License-Identifier: CPAL-1.0
// 资金费历史翻页：页间至少隔 FUNDING_PAGE_GAP_MS（公开行情只读 <= 2 次/秒）；单页（不翻页）不等待。
import { describe, expect, it } from 'vitest'
import { HyperliquidConnector } from '../src/connector'
import { FUNDING_PAGE, FUNDING_PAGE_GAP_MS } from '../src/market'
import { FX_NOW, FakeHl } from './helpers/fake-hl'

const STEP = 3_600_000

function make() {
  const hl = new FakeHl()
  const c = new HyperliquidConnector({ environment: 'mainnet', fetchImpl: hl.fetch, useWs: false, discoveryIntervalMs: 0, clock: () => FX_NOW })
  return { hl, c }
}

describe('fundingHistory page gap', () => {
  it('waits between pages and not before the first one', async () => {
    expect(FUNDING_PAGE_GAP_MS).toBeGreaterThanOrEqual(500)
    const { hl, c } = make()
    await c.market.refreshInstruments()
    const from = FX_NOW - (FUNDING_PAGE + 20) * STEP
    hl.info.set('fundingHistory', (b) => {
      const out: Array<{ coin: string; fundingRate: string; premium: string; time: number }> = []
      for (let t = Math.ceil(b.startTime / STEP) * STEP; t <= b.endTime && out.length < FUNDING_PAGE; t += STEP) out.push({ coin: 'BTC', fundingRate: '0.00001', premium: '0.0001', time: t })
      return out
    })
    const started = Date.now()
    const out = await c.fundingHistory('hyperliquid:BTC', { from, to: FX_NOW })
    const elapsed = Date.now() - started
    expect(hl.infoCalls('fundingHistory')).toHaveLength(2)
    expect(out).toHaveLength(FUNDING_PAGE + 20)
    expect(elapsed).toBeGreaterThanOrEqual(FUNDING_PAGE_GAP_MS - 50)
  })

  it('a single page answers without the gap', async () => {
    const { hl, c } = make()
    await c.market.refreshInstruments()
    hl.info.set('fundingHistory', (b) => [{ coin: 'BTC', fundingRate: '0.00001', premium: '0.0001', time: b.startTime + 1 }])
    const started = Date.now()
    const out = await c.fundingHistory('hyperliquid:BTC', { from: FX_NOW - 10 * STEP, to: FX_NOW })
    expect(out).toHaveLength(1)
    expect(Date.now() - started).toBeLessThan(FUNDING_PAGE_GAP_MS)
  })
})
