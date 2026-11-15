// SPDX-License-Identifier: CPAL-1.0
// R3-20：观察账户按公开地址读账户状态——只用 /info（clearinghouseState 等），不需要任何钥匙，一次都不碰 /exchange；用假 HTTP，不联网。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWeightBudget } from '../src/budget'
import { HyperliquidConnector } from '../src/connector'
import type { AccountRef } from '@gitrader/protocol/connector'
import { FX_NOW, FakeHl, FakeWebSocket } from './helpers/fake-hl'

const WATCHED = '0x3333333333333333333333333333333333333333' as const
const ref = (): AccountRef => ({ accountId: 'acct_01WATCH', address: WATCHED })

afterEach(() => { FakeWebSocket.reset(); vi.useRealTimers() })

async function setup() {
  const hl = new FakeHl()
  const t = { now: FX_NOW }
  const c = new HyperliquidConnector({
    environment: 'mainnet', fetchImpl: hl.fetch, useWs: false, discoveryIntervalMs: 0, clock: () => t.now,
    budget: createWeightBudget({ clock: () => t.now, targetRatio: 1, sleep: async () => { throw new Error('budget wait in a test that should not wait') } }),
  })
  await c.market.refreshInstruments()
  hl.info.set('userAbstraction', () => 'default')
  hl.info.set('spotClearinghouseState', () => ({ balances: [] }))
  hl.info.set('frontendOpenOrders', () => [])
  hl.calls.length = 0
  return { hl, c }
}

const chState = (positions: unknown[]) => ({
  marginSummary: { accountValue: '1234.5', totalNtlPos: '800', totalMarginUsed: '80' },
  crossMaintenanceMarginUsed: '20', withdrawable: '900.25', assetPositions: positions, time: FX_NOW,
})
const zero = { marginSummary: { accountValue: '0', totalNtlPos: '0', totalMarginUsed: '0' }, crossMaintenanceMarginUsed: '0', withdrawable: '0', assetPositions: [], time: FX_NOW }
// 内核会按 dex 各查一次：只有主 dex（没有 dex 字段）有仓位
const mainDex = (positions: unknown[]) => (b: { dex?: string }) => (b.dex ? zero : chState(positions))
const pos = (coin: string, szi: string) => ({
  type: 'oneWay',
  position: { coin, szi, leverage: { type: 'cross', value: 10 }, entryPx: '80000.0', positionValue: '800.0', unrealizedPnl: '12.5', liquidationPx: '72000.0', marginUsed: '80.0', cumFunding: { allTime: '3.0', sinceOpen: '1.5', sinceChange: '1.5' } },
})

describe('按公开地址读账户（观察账户）', () => {
  it('clearinghouseState 映射成持仓和汇总；查的是这个地址；全程只有 info 请求，没有 exchange', async () => {
    const { hl, c } = await setup()
    hl.info.set('clearinghouseState', mainDex([pos('BTC', '0.01'), pos('ETH', '-0.5')]))
    let snapshot: Awaited<ReturnType<typeof c.accountState>> | undefined
    await vi.waitFor(async () => { snapshot = await c.accountState(ref()); expect(snapshot.stale).toBe(false) })
    expect(snapshot!.positions.map((p) => [p.instrumentId, p.side])).toEqual([['hyperliquid:BTC', 'long'], ['hyperliquid:ETH', 'short']])
    expect(snapshot!.margin.equity).toBe('1234.5')
    expect(snapshot!.margin.available).toBe('900.25')
    expect(hl.infoCalls('clearinghouseState').every((call) => call.body.user === WATCHED)).toBe(true)
    expect(hl.calls.filter((call) => call.endpoint === 'exchange')).toEqual([])
  })

  it('空地址（零持仓）读出来是 0 持仓，不报错', async () => {
    const { hl, c } = await setup()
    hl.info.set('clearinghouseState', mainDex([]))
    let snapshot: Awaited<ReturnType<typeof c.accountState>> | undefined
    await vi.waitFor(async () => { snapshot = await c.accountState(ref()); expect(snapshot.stale).toBe(false) })
    expect(snapshot!.positions).toEqual([])
    expect(hl.calls.filter((call) => call.endpoint === 'exchange')).toEqual([])
  })

  it('连接器的账户读方法不带签名器，读不需要钥匙：accountState / openOrders 的入参里没有 signer', async () => {
    const { c } = await setup()
    expect(c.accountState.length).toBe(1)
    expect(c.openOrders.length).toBe(1)
  })
})
