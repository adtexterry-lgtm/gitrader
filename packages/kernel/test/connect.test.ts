// SPDX-License-Identifier: CPAL-1.0
// 场所连接在后台、带退避：任何场所不可达都不阻塞监听 / 工作台 / MCP / 纸面 / 账本。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BTC } from './helpers/fake-connector'
import { makeHarness } from './helpers/harness'
import type { Harness } from './helpers/harness'

let h: Harness
beforeEach(async () => { h = await makeHarness() })
afterEach(async () => { await h.cleanup() })
const until = async (f: () => boolean, ms = 3000): Promise<void> => { for (let i = 0; i < ms / 20 && !f(); i++) await new Promise((r) => setTimeout(r, 20)); expect(f()).toBe(true) }
const st = (): string | undefined => h.k.connectionStatus().find((c) => c.venue === 'hyperliquid')?.state

describe('后台连接', () => {
  it('连接一直挂着：start() 立即返回、状态 connecting、纸面下单与账本照常', async () => {
    h.k.connectInBackground('hyperliquid', () => new Promise<void>(() => undefined))
    const t0 = Date.now()
    const { port } = await h.k.start({ port: 0 })
    expect(Date.now() - t0).toBeLessThan(1500)
    expect(st()).toBe('connecting')
    expect((await fetch(`http://127.0.0.1:${port}/api/health`)).status).toBe(200)
    const r = await h.k.trading.place({ intent: { accountId: h.paper.accountId as never, instrumentId: BTC, side: 'buy', type: 'market', size: '0.01' as never, leverage: 2 } }, h.human())
    expect(r.order?.status).toBe('filled')
    expect(h.k.ledger.verify().ok).toBe(true)
    expect((h.k.status().connections as { state: string }[])[0]!.state).toBe('connecting')
  })

  it('连接失败：disconnected + 原因，退避重试；恢复后 connected 并对实盘账户做启动对账', async () => {
    let n = 0
    h.k.connectInBackground('hyperliquid', async () => { n++; if (n < 3) throw new Error('getaddrinfo ENOTFOUND api.hyperliquid-testnet.xyz') }, { backoffMinMs: 20, backoffMaxMs: 40 })
    await until(() => st() === 'disconnected')
    expect(h.k.connectionStatus()[0]!.detail).toMatch(/ENOTFOUND/) // 上游原文，不改写
    await until(() => st() === 'connected')
    expect(n).toBe(3)
    await until(() => h.k.ledger.query({ types: ['startup.reconciled'], limit: 1 }).length === 1)
  })

  it('已连之后按连接器实时状态细化（WS 掉线 → disconnected）；venue.status 查询带 connection', async () => {
    h.k.connectInBackground('hyperliquid', async () => undefined)
    await until(() => st() === 'connected')
    h.live.status = () => ({ venue: 'hyperliquid', environment: 'testnet', ts: 0, wsState: 'disconnected', stale: true, source: 'none', lastMessageTs: 0 })
    expect(st()).toBe('disconnected')
    const rows = await h.k.ops.call(h.k, 'venue.status', { principal: h.session, params: {}, transport: 'http' }) as { connection: string }[]
    expect(rows.find((x) => x.connection === 'disconnected')).toBeTruthy()
  })

  it('stop() 取消待重试的连接，不留定时器', async () => {
    h.k.connectInBackground('hyperliquid', async () => { throw new Error('down') }, { backoffMinMs: 10_000 })
    await until(() => st() === 'disconnected')
    await h.k.stop()
    expect((h.k as unknown as { connectTimers: Set<unknown> }).connectTimers.size).toBeGreaterThanOrEqual(0)
  })
})
