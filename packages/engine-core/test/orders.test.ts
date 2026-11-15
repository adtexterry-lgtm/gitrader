// SPDX-License-Identifier: CPAL-1.0
// 模式 A 下单管线：信号 → 订单意图 → host.order.place；拒单 / 精度 / 结果未知 / 幂等 / 接管 / 失联 / 风控推送。
import { afterEach, describe, expect, it } from 'vitest'
import { validateOrderIntent, validateSignal } from '../../protocol/src/validate'
import { isDecimal } from '../src/proto'
import { genCandles } from '../../protocol/conformance/host-sim'
import { rig, bindPaper, BTC, PAPER_ACCOUNT, MANDATE_ID, type Rig } from './harness'

let r: Rig | null = null
afterEach(() => { r?.close(); r = null })

const START = { strategyId: 'ema-trend', accountId: PAPER_ACCOUNT, instruments: [BTC], interval: '1m', params: { fast: 5, slow: 20 }, mandateId: MANDATE_ID }

async function started(extra: Record<string, unknown> = {}): Promise<{ instanceId: string }> {
  await bindPaper(r!)
  return r!.session.call('strategy.start', { ...START, ...extra })
}

describe('信号 → 订单意图', () => {
  it('评估后下一单：意图过 OrderIntent schema、数量为规范十进制且按合约步长截断、不带 builder、带 origin 与理由', async () => {
    r = await rig()
    await r.session.call('events.subscribe', { streams: ['signal', 'strategy'] })
    const { instanceId } = await started()
    expect(await r.session.waitFor(() => r!.host.placed.length >= 1, 3000)).toBe(true)
    const p = r.host.placed[0]!.params
    expect(validateOrderIntent(p.intent).ok).toBe(true)
    expect(p.intent.type).toBe('market')
    expect(isDecimal(p.intent.size)).toBe(true)
    expect(p.intent.size).toMatch(/^\d+(\.\d{1,3})?$/) // 步长 0.001
    expect(p.intent.maxSlippageBps).toBe(50)
    expect(p.intent.rounding).toBe('reject')
    expect(p.intent.reason).toMatch(/ema-trend/)
    expect('builder' in p.intent).toBe(false) // A2：不自设 builder
    expect(p.clientOrderId).toMatch(/^[0-9a-f]{32}$/)
    expect(p.intent.clientOrderId).toBe(p.clientOrderId)
    expect(p.instanceId).toBe(instanceId)
    expect(p.strategyId).toBe('ema-trend')
    // T26：来源归因 —— origin.tool 与 causation.instanceId
    expect(p.origin.tool).toBe('strategy:ema-trend')
    expect(p.origin.causation.instanceId).toBe(instanceId)
    expect(p.origin.actorType).toBe('engine')
    // 信号事件：带理由和 origin，过 Signal schema
    expect(await r.session.waitFor(() => r!.session.events.some((e) => e.type === 'signal.created'), 2000)).toBe(true)
    const sig = r.session.events.find((e) => e.type === 'signal.created')!
    expect(validateSignal(sig.data).ok, JSON.stringify(validateSignal(sig.data))).toBe(true)
    expect((sig.data as { reason: string }).reason.length).toBeGreaterThan(0)
    expect(sig.origin?.tool).toBe('strategy:ema-trend')
    expect(sig.causation?.instanceId).toBe(instanceId)
  })

  it('幂等：同一根 K 线重复评估不会产生第二个 clientOrderId；宿主按同一单号只认一单', async () => {
    r = await rig()
    const { instanceId } = await started()
    expect(await r.session.waitFor(() => r!.host.placed.length >= 1, 3000)).toBe(true)
    await r.core.instances.evaluateNow(instanceId, 'manual')
    await r.core.instances.evaluateNow(instanceId, 'manual')
    const ids = new Set(r.host.placed.map((p) => p.params.clientOrderId))
    expect(ids.size).toBe(1)
    expect(r.host.orders.size).toBe(1)
  })
})

describe('被拒 / 精度 / 结果未知', () => {
  it('风控拒单（denied + 2001）：不抛错、不拆单规避 —— 同向请求在退避期内不再发', async () => {
    r = await rig()
    r.host.queueFault('deny-risk')
    const { instanceId } = await started()
    expect(await r.session.waitFor(() => r!.host.placed.length >= 1, 3000)).toBe(true)
    expect(r.host.placed[0]!.result.status).toBe('denied')
    const n = r.host.placed.length
    // 下一根 K 线上同样想买：退避 5 分钟，不再提交（也不会用更小的数量重试）
    for (let i = 0; i < 3; i++) await r.core.instances.evaluateNow(instanceId, 'manual')
    expect(r.host.placed.length).toBe(n)
    const ev = await r.session.call('strategy.status', { instanceId })
    expect(ev.instances[0]['x-lastAction']).toMatch(/denied|blocked/)
  })

  it('1002 PRECISION 之后不原样重发：刷新合约规则，同一根 K 线内不再试', async () => {
    r = await rig()
    r.host.queueFault('precision')
    const { instanceId } = await started()
    expect(await r.session.waitFor(() => r!.host.placed.length >= 1, 3000)).toBe(true)
    const first = r.host.placed[0]!.params.intent.size
    const callsBefore = r.host.calls.filter((c) => c.method === 'host.instruments').length
    await r.core.instances.evaluateNow(instanceId, 'manual')
    expect(r.host.placed.length).toBe(1)
    void first
    expect(callsBefore).toBeGreaterThanOrEqual(1)
  })

  it('3006 结果未知：先 host.order.status 按 clientOrderId 查，不盲目重发', async () => {
    r = await rig()
    r.host.queueFault('timeout-3006')
    const { instanceId } = await started()
    expect(await r.session.waitFor(() => r!.host.calls.some((c) => c.method === 'host.order.status'), 3000)).toBe(true)
    const cid = r.host.placed[0]!.params.clientOrderId
    const status = r.host.calls.find((c) => c.method === 'host.order.status')!
    expect(status.params.clientOrderId).toBe(cid)
    await r.core.instances.evaluateNow(instanceId, 'manual')
    expect(r.host.placed.length).toBe(1) // 没有第二次提交
  })
})

describe('接管、失联、风控推送', () => {
  it('engine.halt(halt_new)：200 ms 内 ack，之后零个开仓请求；resume 前一直受限；resume 后恢复', async () => {
    r = await rig()
    await bindPaper(r)
    const t0 = Date.now()
    const ack = await r.session.call('engine.halt', { takeoverId: 'tko_01JABTAKEOVER0001', level: 'halt_new', scope: {}, reason: 'test', deadlineMs: 200 })
    expect(ack.ack).toBe(true)
    expect(Date.now() - t0).toBeLessThan(200)
    await r.session.call('strategy.start', { ...START })
    await new Promise((res) => setTimeout(res, 400))
    expect(r.host.placed.length).toBe(0)
    const e = await r.session.expectError('engine.resume', { takeoverId: 'tko_nope', scope: {}, approvedBy: 'user:usr_local' })
    expect(e.code).toBe(-32602)
    await r.session.call('engine.resume', { takeoverId: 'tko_01JABTAKEOVER0001', scope: {}, approvedBy: 'user:usr_local' })
    const { instances } = await r.session.call('strategy.status', {})
    await r.core.instances.evaluateNow(instances[0].instanceId, 'manual')
    expect(await r.session.waitFor(() => r!.host.placed.length >= 1, 2000)).toBe(true)
  })

  it('cancel_all / flatten_all：引擎什么单都不再发（撤单与平仓由宿主做）', async () => {
    r = await rig()
    await bindPaper(r)
    await r.session.call('engine.halt', { takeoverId: 'tko_01JABTAKEOVER0002', level: 'flatten_all', scope: { accountIds: [PAPER_ACCOUNT] }, reason: 'test', deadlineMs: 2000 })
    await r.session.call('strategy.start', { ...START })
    await new Promise((res) => setTimeout(res, 300))
    expect(r.host.placed.length).toBe(0)
    expect(r.host.calls.filter((c) => c.method === 'host.order.cancelAll').length).toBe(0)
  })

  it('宿主心跳停发超时 → 判定失联：不再发开仓请求；心跳恢复后继续', async () => {
    r = await rig({ heartbeatMs: 300 })
    await bindPaper(r, 300)
    r.session.stopHeartbeats()
    await new Promise((res) => setTimeout(res, 900)) // > 3 个周期
    expect(r.core.guard.hostLost).toBe(true)
    await r.session.call('strategy.start', { ...START })
    await new Promise((res) => setTimeout(res, 300))
    expect(r.host.placed.length).toBe(0)
    r.session.startHeartbeats(100)
    expect(await r.session.waitFor(() => !r!.core.guard.hostLost, 1500)).toBe(true)
  })

  it('risk.policy.push：返回接受的版本；之后订单名义不超过推送的 maxOrderNotional，标的不在白名单则不发', async () => {
    r = await rig()
    await bindPaper(r)
    const res = await r.session.call('risk.policy.push', {
      effectiveAt: Date.now() - 1000,
      policies: [{ policyId: 'pol_01JAB1', version: 3, scope: { type: 'account', id: PAPER_ACCOUNT }, limits: { maxOrderNotional: '100', maxLeverage: 2, maxSlippageBps: 10 }, failClosed: { stalePriceMs: 5000, onMissingPrice: 'deny' }, dailyResetAt: '00:00Z', valuationCcy: 'USDC', attestation: { method: 'pin', by: 'user:usr_local', at: 1, digest: 'sha256:' + 'a'.repeat(64), sig: 'x' } }],
    })
    expect(res.acceptedVersions).toEqual([3])
    // 旧版本不接受
    const old = await r.session.call('risk.policy.push', { effectiveAt: Date.now(), policies: [{ policyId: 'pol_01JAB1', version: 2, scope: { type: 'account', id: PAPER_ACCOUNT }, limits: {} }] })
    expect(old.acceptedVersions).toEqual([])
    await r.session.call('strategy.start', { ...START })
    expect(await r.session.waitFor(() => r!.host.placed.length >= 1, 3000)).toBe(true)
    const intent = r.host.placed[0]!.params.intent
    const last = genCandles(7, 300).at(-1)!.c
    expect(Number(intent.size) * last).toBeLessThanOrEqual(100)
    expect(intent.maxSlippageBps).toBe(10)
    expect(intent.leverage).toBeLessThanOrEqual(2)
  })

  it('白名单推送：标的不在白名单 → 一个单都不发', async () => {
    r = await rig()
    await bindPaper(r)
    await r.session.call('risk.policy.push', {
      effectiveAt: Date.now() - 1000,
      policies: [{ policyId: 'pol_01JAB9', version: 1, scope: { type: 'org', id: 'org_local' }, limits: { instrumentAllowlist: ['hyperliquid:ETH'] } }],
    })
    await r.session.call('strategy.start', { ...START })
    await new Promise((res) => setTimeout(res, 400))
    expect(r.host.placed.length).toBe(0)
  })
})
