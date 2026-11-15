// SPDX-License-Identifier: CPAL-1.0
// 审稿 P2-1：手动「重连」成功后要再做一次场所启动对账（离线期间的成交回补）；对账完成前实盘开仓照旧被拦。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { OrderIntent } from '../src/proto'
import { BTC } from './helpers/fake-connector'
import { enableLive, makeHarness } from './helpers/harness'
import type { Harness } from './helpers/harness'

let h: Harness
beforeEach(async () => { h = await makeHarness() })
afterEach(async () => { await h.cleanup() })

const until = async (f: () => boolean, ms = 3000): Promise<void> => { for (let i = 0; i < ms / 20 && !f(); i++) await new Promise((r) => setTimeout(r, 20)); expect(f()).toBe(true) }
const open = (): OrderIntent =>
  ({ accountId: h.liveAcct.accountId as never, instrumentId: BTC, side: 'buy', type: 'market', size: '0.001' as never, leverage: 2, reason: 'review p2-1' } as OrderIntent)

describe('审稿 P2-1 手动重连后再对账', () => {
  it('手动重连成功 → 启动对账再调一次；对账完成前实盘开仓被拒（startup reconcile pending），完成后放行', async () => {
    await enableLive(h)
    h.k.connectInBackground('hyperliquid', async () => undefined)
    await until(() => h.k.startupHold(h.liveAcct.accountId) === undefined) // 首次对账完成
    const firstCalls = h.live.startupSnapshotCalls
    expect(firstCalls).toBeGreaterThanOrEqual(1)

    // 之后的对账卡在门口：看得到「被调用」，也看得到「完成前开仓被拒」
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const real = h.live.startupSnapshot.bind(h.live)
    h.live.startupSnapshot = async (ref, since) => { await gate; return real(ref, since) }

    expect(h.k.reconnect('hyperliquid').venue).toBe('hyperliquid')
    await until(() => h.k.startupHold(h.liveAcct.accountId) === 'startup reconcile pending')
    const denied = await h.k.trading.place({ intent: open() }, h.human())
    expect(denied.order).toMatchObject({ status: 'denied', problem: { name: 'TRADING_STATE', message: expect.stringContaining('startup reconcile pending') } })
    expect(h.live.submitted).toHaveLength(0)

    release()
    await until(() => h.k.startupHold(h.liveAcct.accountId) === undefined)
    expect(h.live.startupSnapshotCalls).toBeGreaterThan(firstCalls) // 对账真的又调了一次
    expect((await h.k.trading.place({ intent: open() }, h.human())).order?.status).toBe('filled')
  })

  it('手动重连时上一轮对账还在跑：它跑完后紧接着再对一轮，不丢', async () => {
    await enableLive(h)
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const real = h.live.startupSnapshot.bind(h.live)
    let calls = 0
    h.live.startupSnapshot = async (ref, since) => { calls++; if (calls === 1) await gate; return real(ref, since) }
    h.k.connectInBackground('hyperliquid', async () => undefined)
    await until(() => calls === 1) // 第一轮对账卡住（running）
    h.k.reconnect('hyperliquid') // 重连成功时第一轮还在跑
    await until(() => (h.k as unknown as { venueRec: Map<string, { redo?: boolean }> }).venueRec.get('hyperliquid')?.redo === true)
    release()
    await until(() => calls >= 2 && h.k.startupHold(h.liveAcct.accountId) === undefined)
    expect(calls).toBe(2)
  })
})
