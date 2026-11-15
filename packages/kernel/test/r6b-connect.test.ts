// SPDX-License-Identifier: CPAL-1.0
// R6 B 包 R2-REL-02 / R1-PERF-08：start() 每次尝试有超时并按退避重试，尝试进行中「重连」也生效；
// 连接状态与就绪度（marketLive / primaryInstruments / catalogComplete / startupReconciled）跟着行情走，不等 start() 返回；status 与 venue_status 同一口径。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeAgent, makeHarness } from './helpers/harness'
import type { Harness } from './helpers/harness'

let h: Harness
beforeEach(async () => {
  h = await makeHarness()
  const simStatus = h.sim.status.bind(h.sim)
  h.sim.status = () => ({ ...simStatus(), venue: 'kernel-sim' }) // 假模拟场所默认自报 hyperliquid，和实盘假连接器撞名
})
afterEach(async () => { await h.cleanup() })

const until = async (f: () => boolean, ms = 3000): Promise<void> => { for (let i = 0; i < ms / 20 && !f(); i++) await new Promise((r) => setTimeout(r, 20)); expect(f()).toBe(true) }
const row = (venue: string) => h.k.connectionStatus().find((c) => c.venue === venue)!
const never = (): Promise<void> => new Promise<void>(() => undefined)

describe('R2-REL-02 start() 超时与重连', () => {
  it('[R6B-CN1] start() 一次尝试超时：按失败走退避重试（disconnected + 原因），下一轮成功就 connected', async () => {
    let n = 0
    h.k.connectInBackground('slow-venue', () => { n++; return n < 3 ? never() : Promise.resolve() }, { startTimeoutMs: 30, backoffMinMs: 10, backoffMaxMs: 20 })
    expect(row('slow-venue').state).toBe('connecting')
    await until(() => row('slow-venue').state === 'disconnected')
    expect(row('slow-venue').detail).toMatch(/did not finish within 30 ms/)
    await until(() => row('slow-venue').state === 'connected')
    expect(n).toBe(3) // 两次超时 + 一次成功
    expect(row('slow-venue').detail).toBeUndefined()
  })

  it('[R6B-CN1] 尝试进行中「重连」也生效：新一轮作废旧一轮，旧一轮之后才失败 / 返回都不再改状态', async () => {
    let n = 0
    let failFirst!: (e: Error) => void
    h.k.connectInBackground('retry-venue', () => {
      n++
      return n === 1 ? new Promise<void>((_, reject) => { failFirst = reject }) : Promise.resolve()
    }, { startTimeoutMs: 60_000, backoffMinMs: 5_000 })
    expect(row('retry-venue').state).toBe('connecting')
    expect(h.k.reconnect('retry-venue').state).toBe('connecting') // 第一轮还在跑，重连照样发起第二轮
    await until(() => row('retry-venue').state === 'connected')
    expect(n).toBe(2)
    failFirst(new Error('late failure of the superseded attempt'))
    await new Promise((r) => setTimeout(r, 40))
    expect(row('retry-venue')).toMatchObject({ state: 'connected' })
    expect(row('retry-venue').detail).toBeUndefined()
  })
})

describe('R2-REL-02 连接状态与就绪度', () => {
  it('[R6B-CN2] 行情已通、主标的已知：start() 还没返回 connected 就先成立；就绪度逐项如实；venue_status 与 status 取值一致', async () => {
    const fake = h.live as unknown as { readiness?: () => { primaryInstruments: boolean; catalogComplete: boolean } }
    let primary = false
    let catalog = false
    fake.readiness = () => ({ primaryInstruments: primary, catalogComplete: catalog }) // 像 HL 连接器那样自报目录就绪度
    h.k.connectInBackground('hyperliquid', never) // start() 一直挂着（HL：其余 dex 目录慢）

    // 行情 WS 已连（假连接器一直连着），但主标的还没到：不是 connected，对账也不开始
    h.k.venueTick()
    expect(row('hyperliquid')).toMatchObject({ state: 'connecting', readiness: { marketLive: true, primaryInstruments: false, catalogComplete: false, startupReconciled: false } })

    // 主标的到了：connected，启动对账立刻开始，完成后 startupReconciled 才为真；目录没完成不影响
    primary = true
    h.k.venueTick()
    expect(row('hyperliquid').state).toBe('connected')
    await until(() => row('hyperliquid').readiness.startupReconciled)
    expect(row('hyperliquid').readiness).toEqual({ marketLive: true, primaryInstruments: true, catalogComplete: false, startupReconciled: true })
    expect(row('hyperliquid').detail).toBeUndefined()
    expect(h.k.ledger.query({ types: ['startup.reconciled'] }).length).toBeGreaterThanOrEqual(1)

    // 行情掉了：状态跟着掉（不再是 connected），就绪度里 marketLive 变假
    const live = h.live.status.bind(h.live)
    h.live.status = () => ({ ...live(), wsState: 'disconnected' as const, stale: true })
    expect(row('hyperliquid').state).toBe('disconnected')
    expect(row('hyperliquid').readiness.marketLive).toBe(false)
    h.live.status = live
    catalog = true
    expect(row('hyperliquid').readiness.catalogComplete).toBe(true)
    expect(row('hyperliquid').state).toBe('connected')

    // status.connections[] 与 agent market.venue_status 用同一个答案
    const statusRow = (h.k.status().connections as Array<{ venue: string; state: string; readiness: unknown }>).find((c) => c.venue === 'hyperliquid')!
    const agent = await makeAgent(h, 'read_only')
    const reply = await h.k.ops.call(h.k, 'agent.market', { principal: agent.principal, params: { requestId: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d', action: 'venue_status' }, transport: 'http' }) as { data: Array<{ venue: string; connection: string; readiness: unknown; wsState: string }> }
    const venueRow = reply.data.find((v) => v.venue === 'hyperliquid')!
    expect(venueRow.connection).toBe(statusRow.state)
    expect(venueRow.readiness).toEqual(statusRow.readiness)
    expect(venueRow.wsState).toBe('connected') // 现有字段不动
    const ops = await h.k.ops.call(h.k, 'venue.status', { principal: h.session, params: {}, transport: 'http' }) as Array<{ venue: string; connection: string; readiness: unknown }>
    expect(ops.find((v) => v.venue === 'hyperliquid')).toMatchObject({ connection: statusRow.state, readiness: statusRow.readiness })
  })

  it('[R6B-CN2] start() 失败仍是 disconnected（不因行情已通而改口）；没有后台连接登记的场所 venue_status 也带这两个字段', async () => {
    h.k.connectInBackground('hyperliquid', async () => { throw new Error('boom') }, { backoffMinMs: 60_000 })
    await until(() => row('hyperliquid').state === 'disconnected')
    h.k.venueTick()
    expect(row('hyperliquid')).toMatchObject({ state: 'disconnected', detail: 'boom', readiness: { marketLive: false, startupReconciled: false } })
    const agent = await makeAgent(h, 'read_only')
    const reply = await h.k.ops.call(h.k, 'agent.market', { principal: agent.principal, params: { requestId: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d', action: 'venue_status' }, transport: 'http' }) as { data: Array<{ venue: string; connection: string; readiness: Record<string, unknown> }> }
    const sim = reply.data.find((v) => v.venue === 'kernel-sim')
    expect(sim).toBeTruthy()
    expect(sim!.connection).toBe('connected')
    expect(Object.keys(sim!.readiness).sort()).toEqual(['catalogComplete', 'marketLive', 'primaryInstruments', 'startupReconciled'])
  })
})
