// SPDX-License-Identifier: CPAL-1.0
// R6 B 包 B-5：实盘开仓以启动对账完成为前置（只许收紧）。
// 规则：实盘账户所在场所有后台连接登记、启动对账还没成功 → 开仓被风控拒绝（TRADING_STATE，原因 startup reconcile pending）；
// 减仓 / 平仓 / 撤单放行；纸面账户不受影响；对账失败或未决一直拒，直到某次对账成功。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { OrderIntent } from '../src/proto'
import { BTC } from './helpers/fake-connector'
import { enableLive, makeHarness } from './helpers/harness'
import type { Harness } from './helpers/harness'

let h: Harness
beforeEach(async () => { h = await makeHarness() })
afterEach(async () => { await h.cleanup() })

const until = async (f: () => boolean, ms = 3000): Promise<void> => { for (let i = 0; i < ms / 20 && !f(); i++) await new Promise((r) => setTimeout(r, 20)); expect(f()).toBe(true) }
const open = (accountId: string = h.liveAcct.accountId, o: Partial<OrderIntent> = {}): OrderIntent =>
  ({ accountId: accountId as never, instrumentId: BTC, side: 'buy', type: 'market', size: '0.001' as never, leverage: 2, reason: 'r6b live gate', ...o } as OrderIntent)
const pendingHit = (r: { ruleHits: Array<{ code: string; action: string; message?: string }> }) =>
  r.ruleHits.find((x) => x.code === 'TRADING_STATE' && x.action === 'deny' && (x.message ?? '').startsWith('startup reconcile pending'))
/** 后台连接登记了、start() 一直不返回：启动对账不会跑，场所处于「对账未完成」。 */
const hangingVenue = (): void => h.k.connectInBackground('hyperliquid', () => new Promise<void>(() => undefined))

describe('R6 B-5 实盘开仓以启动对账完成为前置', () => {
  it('[R6B-LG1] 对账没完成：实盘开仓被拒（TRADING_STATE / startup reconcile pending），一单也没到场所；对账完成后放行', async () => {
    await enableLive(h)
    let finish!: () => void
    h.k.connectInBackground('hyperliquid', () => new Promise<void>((resolve) => { finish = resolve }))
    expect(h.k.startupHold(h.liveAcct.accountId)).toBe('startup reconcile pending')
    expect(h.k.connectionStatus().find((c) => c.venue === 'hyperliquid')!.readiness.startupReconciled).toBe(false)

    const pre = await h.k.trading.precheckIntent(open(), h.human())
    expect(pre.verdict).toBe('deny')
    expect(pendingHit(pre)).toBeTruthy()
    const denied = await h.k.trading.place({ intent: open() }, h.human())
    expect(denied.order).toMatchObject({ status: 'denied', problem: { name: 'TRADING_STATE', message: expect.stringContaining('startup reconcile pending') } })
    expect(h.live.submitted).toHaveLength(0)
    // 内核自己的交易状态不因此出现假的 REDUCING（只有交易闸门看得到这条）
    expect((h.k.status() as { tradingState: string }).tradingState).toBe('ACTIVE')

    finish() // start() 返回 → 对该场所的实盘账户做启动对账
    await until(() => h.k.startupHold(h.liveAcct.accountId) === undefined)
    expect(h.k.connectionStatus().find((c) => c.venue === 'hyperliquid')!.readiness.startupReconciled).toBe(true)
    expect(pendingHit(await h.k.trading.precheckIntent(open(), h.human()))).toBeUndefined()
    expect((await h.k.trading.place({ intent: open() }, h.human())).order?.status).toBe('filled')
    expect(h.live.submitted).toHaveLength(1)
  })

  it('[R6B-LG2] 对账没完成：实盘减仓 / 平仓 / 撤单照常放行', async () => {
    await enableLive(h)
    // 场所还没登记后台连接时先建一个实盘持仓和一张挂单；之后场所进入「对账未完成」
    const resting = await h.k.trading.place({ intent: open(h.liveAcct.accountId, { side: 'sell', type: 'limit', price: '81000' as OrderIntent['price'] }) }, h.human())
    expect(resting.order?.status).toBe('open')
    h.clock.advance(6_000) // 两次开仓之间的冷却
    expect((await h.k.trading.place({ intent: open() }, h.human())).order?.status).toBe('filled')
    hangingVenue()
    expect(h.k.startupHold(h.liveAcct.accountId)).toBe('startup reconcile pending')

    const reduce = await h.k.trading.precheckIntent(open(h.liveAcct.accountId, { side: 'sell', reduceOnly: true }), h.human())
    expect(pendingHit(reduce)).toBeUndefined()
    expect(reduce.ruleHits.some((x) => x.code === 'TRADING_STATE' && x.action === 'deny')).toBe(false)
    expect((await h.k.trading.cancelAll({ accountId: h.liveAcct.accountId }, h.human())).cancelled).toBeGreaterThanOrEqual(1)
    const closed = await h.k.trading.closePosition({ accountId: h.liveAcct.accountId, instrumentId: BTC, reason: 'r6b close while pending' }, h.human())
    expect(closed.order?.status).toBe('filled')
    expect(closed.order?.reduceOnly).toBe(true)
  })

  it('[R6B-LG3] 对账成功之后不再拒；对账失败 / 未决一直拒，直到某次对账成功', async () => {
    await enableLive(h)
    h.live.reconcileResult = new Error('venue read failed') // 第一次对账读失败
    h.k.connectInBackground('hyperliquid', async () => undefined)
    await until(() => h.k.ledger.query({ types: ['startup.reconciled'] }).length >= 1)
    await until(() => !(h.k as unknown as { venueRec: Map<string, { running: boolean }> }).venueRec.get('hyperliquid')!.running)
    // 失败 = 未完成：继续拒，就绪度也如实报 false
    expect(h.k.startupHold(h.liveAcct.accountId)).toBe('startup reconcile pending')
    expect(h.k.connectionStatus().find((c) => c.venue === 'hyperliquid')!.readiness.startupReconciled).toBe(false)
    expect(pendingHit(await h.k.trading.precheckIntent(open(), h.human()))).toBeTruthy()

    // 退避没到：不重试；到了且这次读成功：放行
    h.live.reconcileResult = 'actual'
    h.k.venueTick()
    expect(h.k.startupHold(h.liveAcct.accountId)).toBe('startup reconcile pending')
    h.clock.advance(16_000)
    h.k.venueTick()
    await until(() => h.k.startupHold(h.liveAcct.accountId) === undefined)
    expect(h.k.connectionStatus().find((c) => c.venue === 'hyperliquid')!.readiness.startupReconciled).toBe(true)
  })

  it('[R6B-LG4] 纸面账户不受影响；没有后台连接登记的场所也不受影响', async () => {
    hangingVenue()
    expect(h.k.startupHold(h.paper.accountId)).toBeUndefined()
    const pre = await h.k.trading.precheckIntent(open(h.paper.accountId), h.human())
    expect(pendingHit(pre)).toBeUndefined()
    expect((await h.k.trading.place({ intent: open(h.paper.accountId) }, h.human())).order?.status).toBe('filled')

    // 同一个实盘账户，场所没登记后台连接（例如只靠 k.start() 的启动对账）：沿用原行为，不加新的拒绝
    const other = await makeHarness()
    try {
      expect(other.k.startupHold(other.liveAcct.accountId)).toBeUndefined()
      expect(pendingHit(await other.k.trading.precheckIntent(open(other.liveAcct.accountId), other.human()))).toBeUndefined()
    } finally { await other.cleanup() }
  })
})
