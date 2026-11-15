// SPDX-License-Identifier: CPAL-1.0
// R3-18：market venue_status 每个场所只给一条（内核模拟场所借用行情源状态，不再让 hyperliquid 出现两次）。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeAgent, makeHarness } from './helpers/harness'
import type { Harness } from './helpers/harness'

let h: Harness
beforeEach(async () => { h = await makeHarness() })
afterEach(async () => { await h.cleanup() })

describe('R3-18 venue_status 去重', () => {
  it('kernel-sim 与 hyperliquid 的状态都带 venue=hyperliquid：只回一条', async () => {
    expect(h.k.bus.list().map((c) => c.venue).sort()).toEqual(['hyperliquid', 'kernel-sim'])
    expect(h.sim.status().venue).toBe('hyperliquid') // 重复的来源
    const a = await makeAgent(h, 'read_only')
    const r = await h.k.ops.call(h.k, 'agent.market', { principal: a.principal, params: { action: 'venue_status' }, transport: 'http' }) as { data: { venue: string }[] }
    expect(r.data.map((s) => s.venue)).toEqual(['hyperliquid'])
  })

  it('不同场所各占一条，顺序不变', async () => {
    const a = await makeAgent(h, 'read_only')
    const other = Object.assign(Object.create(Object.getPrototypeOf(h.live)), h.live, { venue: 'binance', status: () => ({ ...h.live.status(), venue: 'binance' }) })
    h.k.bus.registerMarketSource(other)
    const r = await h.k.ops.call(h.k, 'agent.market', { principal: a.principal, params: { action: 'venue_status' }, transport: 'http' }) as { data: { venue: string }[] }
    expect(r.data.map((s) => s.venue)).toEqual(['binance', 'hyperliquid'])
  })
})
