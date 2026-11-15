// SPDX-License-Identifier: CPAL-1.0
// R3-20 跟进：CLI 装配的观察账户只读源（hyperliquidWatchSource）——按自己的 environment 读 /info 公开数据，
// 只暴露 accountState / openOrders / close，不连 WS、不碰 /exchange，速率预算与交易连接共用。全程假 HTTP，不联网。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConnectorBus, systemClock } from '@gitrader/kernel'
import type { Kernel } from '@gitrader/kernel'
import type { AccountRef } from '@gitrader/protocol/connector'
import { hyperliquidWatchSource } from '../src/connectors'
// 复用连接器包的离线假 Hyperliquid（只读夹具）
import { FX_NOW, FakeHl } from '../../connector-hyperliquid/test/helpers/fake-hl'

const WATCHED = '0x3333333333333333333333333333333333333333' as const
const ref = (): AccountRef => ({ accountId: 'acct_01WATCH', address: WATCHED })
const position = { type: 'oneWay', position: { coin: 'BTC', szi: '-0.01', leverage: { type: 'cross', value: 10 }, entryPx: '81000.0', positionValue: '800.0', unrealizedPnl: '10.0', liquidationPx: '90000.0', marginUsed: '80.0', cumFunding: { allTime: '0', sinceOpen: '0', sinceChange: '0' } } }
const chState = { marginSummary: { accountValue: '4321.5', totalNtlPos: '800', totalMarginUsed: '80' }, crossMaintenanceMarginUsed: '20', withdrawable: '4241.5', assetPositions: [position], time: FX_NOW }

afterEach(() => { vi.unstubAllGlobals() })

function setup(environment: 'mainnet' | 'testnet') {
  const hl = new FakeHl()
  hl.info.set('userAbstraction', () => 'default')
  hl.info.set('spotClearinghouseState', () => ({ balances: [] }))
  hl.info.set('frontendOpenOrders', () => [])
  hl.info.set('clearinghouseState', (b: { dex?: string }) => (b.dex ? { ...chState, marginSummary: { accountValue: '0', totalNtlPos: '0', totalMarginUsed: '0' }, crossMaintenanceMarginUsed: '0', withdrawable: '0', assetPositions: [] } : chState)) // 该地址只在主 dex 有仓；builder dex 空
  vi.stubGlobal('fetch', hl.fetch)
  const clock = systemClock
  const bus = new ConnectorBus(clock)
  const k = { bus, clock } as unknown as Kernel
  return { hl, bus, source: hyperliquidWatchSource(k, environment) }
}

describe('hyperliquidWatchSource', () => {
  it('主网只读源：读到该地址的公开状态；请求全是 /info、查的是这个地址、走的是主网；一次 /exchange 都没有', async () => {
    const { hl, bus, source } = setup('mainnet')
    let snapshot: Awaited<ReturnType<typeof source.accountState>> | undefined
    await vi.waitFor(async () => { snapshot = await source.accountState(ref()); expect(snapshot.stale).toBe(false) })
    expect(snapshot!.margin.equity).toBe('4321.5')
    expect(snapshot!.positions.map((p) => [p.instrumentId, p.side, p.size])).toEqual([['hyperliquid:BTC', 'short', '0.01']])
    expect(snapshot!.positions[0]!.markPrice).toBe('80000') // 没有行情：用持仓价值 ÷ 数量，不是开仓价 81000
    expect(await source.openOrders(ref())).toEqual([])
    expect(hl.calls.length).toBeGreaterThan(0)
    expect(hl.calls.filter((c) => c.endpoint === 'exchange')).toEqual([])
    expect(hl.calls.every((c) => !/testnet/.test(c.url))).toBe(true)
    expect(hl.calls.map((c) => c.body.type).filter((t) => t === 'perpDexs' || t === 'metaAndAssetCtxs')).toEqual(['perpDexs']) // 只做 dex 名单发现（HIP-3），不做标的发现
    const builderDexes = new Set(hl.infoCalls('clearinghouseState').map((c) => c.body.dex).filter(Boolean)).size
    expect(hl.calls.length).toBeLessThanOrEqual(8 + 1 + 2 * builderDexes) // 原 8 个 + perpDexs 1 次 + 每个 builder dex 各一次仓位 / 挂单
    expect(hl.infoCalls('clearinghouseState').every((c) => c.body.user === WATCHED)).toBe(true)
    expect(bus.budget('hyperliquid')?.usage()).toBeTruthy() // 用的是总线上与交易连接共用的那份预算
    await source.close()
  })

  it('测试网环境走测试网地址', async () => {
    const { hl, source } = setup('testnet')
    await vi.waitFor(async () => { expect((await source.accountState(ref())).stale).toBe(false) })
    expect(hl.calls.length).toBeGreaterThan(0)
    expect(hl.calls.every((c) => /testnet/.test(c.url))).toBe(true)
    await source.close()
  })

  it('只暴露读方法和 close：没有下单 / 撤单 / 签名相关的成员，也没有底层连接器', () => {
    const { source } = setup('mainnet')
    expect(Object.keys(source).sort()).toEqual(['accountState', 'close', 'openOrders'])
  })

  it('不 start：没有 WebSocket、没有后台定时器，close 之后不再有请求', async () => {
    const { hl, source } = setup('mainnet')
    await vi.waitFor(async () => { expect((await source.accountState(ref())).stale).toBe(false) })
    await source.close()
    const n = hl.calls.length
    await new Promise((r) => setTimeout(r, 300))
    expect(hl.calls.length).toBe(n)
  })
})
