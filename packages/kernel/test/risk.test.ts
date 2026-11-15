// SPDX-License-Identifier: CPAL-1.0
// 风控闸：数字限额每一条、保护器叠加、三态、临时放宽、策略验签（失败即停）、日笔数 / 报撤单频率 / 防重复。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { OrderIntent, Fill } from '../src/proto'
import { Kernel } from '../src/kernel'
import { ORG_SCOPE } from '../src/trading-state'
import { mkOrigin } from '../src/util/origin'
import { D } from '../src/util/dec'
import { BTC, ETH } from './helpers/fake-connector'
import { enableLive, FAST_SCRYPT, makeAgent, makeHarness } from './helpers/harness'
import type { Harness } from './helpers/harness'

let h: Harness
beforeEach(async () => { h = await makeHarness() })
afterEach(async () => { await h.cleanup() })

const mk = (o: Partial<OrderIntent> = {}): OrderIntent => ({ accountId: h.paper.accountId as never, instrumentId: BTC, side: 'buy', type: 'market', size: '0.01' as never, leverage: 2, ...o } as OrderIntent)
const place = (o: Partial<OrderIntent> = {}, ctx = h.human()) => h.k.trading.place({ intent: mk(o) }, ctx)
const hits = (r: Awaited<ReturnType<typeof place>>): string[] => (r.order?.problem?.ruleHits ?? []).map((x) => x.code)
const ruleIds = (r: Awaited<ReturnType<typeof place>>): string[] => (r.order?.problem?.ruleHits ?? []).map((x) => x.ruleId)
const step = (s = 6): void => { h.clock.advance(s * 1000) }
const setLimits = async (limits: Record<string, unknown>, protectors?: unknown[]): Promise<void> => {
  const pin = await h.pinProof()
  h.k.risk.relax({ limits: limits as never, ...(protectors ? { protectors: protectors as never } : {}) }, pin, h.human('risk.relax').origin)
}
const COOLDOWN = { kind: 'cooldown', afterOpenSec: 5 }

describe('数字限额（默认预设 杠杆≤3× · 单笔≤2,000 · 日亏≤3%）', () => {
  it('放行基线：成交、账本有 order.intent → order.submitted → order.accepted → fill，且带 origin 与预检结果', async () => {
    const r = await place()
    expect(r.order?.status).toBe('filled')
    const trail = h.k.ledger.trace({ orderId: r.order!.orderId }).map((e) => e.type)
    expect(trail).toEqual(['order.intent', 'order.submitted', 'order.accepted', 'fill'])
    const intent = h.k.ledger.trace({ orderId: r.order!.orderId })[0]!
    expect(intent.origin).toMatchObject({ actor: 'user:usr_local', actorType: 'human', via: 'ui' })
    expect(intent.precheck?.verdict).toBe('allow')
    expect(intent.precheck?.estimates.notional).toBe('800')
  })

  it('不变量 1：先写账本后发单——连接器被调用时，order.intent（带预检结果）已经落账', async () => {
    let seen: string[] = []
    let precheckSeen: unknown
    const orig = h.sim.submit.bind(h.sim)
    h.sim.submit = async (ctx, intents) => {
      const es = h.k.ledger.trace({ clientOrderId: intents[0]!.clientOrderId as string })
      seen = es.map((e) => e.type)
      precheckSeen = es[0]?.precheck
      return orig(ctx, intents)
    }
    const r = await place()
    expect(seen).toEqual(['order.intent', 'order.submitted'])
    expect(precheckSeen).toMatchObject({ verdict: 'allow' })
    // 发送结果再追加一条，二者用同一 orderId 关联
    expect(h.k.ledger.trace({ orderId: r.order!.orderId }).map((e) => e.type)).toContain('order.accepted')
  })

  it('杠杆：9× > 3× → 拒绝，撞了哪条规则入账（LEVERAGE，limit/actual 是十进制字符串）', async () => {
    const r = await place({ leverage: 9 })
    expect(r.order?.status).toBe('denied')
    expect(r.order?.problem).toMatchObject({ code: 2001, name: 'RULE_DENIED', category: 'RISK' })
    expect(hits(r)).toContain('LEVERAGE')
    const e = h.k.ledger.query({ types: ['risk.denied'], limit: 1 })[0]!
    expect(e.ruleHits![0]).toMatchObject({ code: 'LEVERAGE', limit: '3', actual: '9', unit: 'x', action: 'deny' })
    expect(e.precheck!.verdict).toBe('deny')
    expect(h.sim.submitted.length).toBe(0) // 被拒的单从未到过场所
  })

  it('单笔名义：2,400 > 2,000', async () => {
    expect(hits(await place({ size: '0.03' as never }))).toContain('ORDER_NOTIONAL')
  })

  it('单标的持仓 / 权益、总敞口 / 权益', async () => {
    await setLimits({ maxOrderNotional: '5000' })
    await place({ size: '0.0225' as never }) // 1800
    step()
    expect(hits(await place({ size: '0.0225' as never }))).toContain('POSITION_NOTIONAL') // 3600 > 3000
    await setLimits({ maxPositionNotionalRatio: '1', maxTotalNotionalRatio: '0.3' })
    expect(hits(await place({ instrumentId: ETH, size: '0.6' as never }))).toContain('TOTAL_NOTIONAL') // 1800 + 1440 = 3240 > 3000
  })

  it('持仓数', async () => {
    await setLimits({ maxOpenPositions: 1 })
    await place()
    step()
    expect(hits(await place({ instrumentId: ETH, size: '0.5' as never }))).toContain('OPEN_POSITIONS')
  })

  it('当日亏损：达到上限后开仓被拒，减仓照常放行', async () => {
    await place()
    step()
    h.sim.equity = D('9600') // 4% 亏损
    step()
    expect(hits(await place({ size: '0.005' as never }))).toContain('DAILY_LOSS')
    step()
    const close = await place({ side: 'sell', size: '0.01' as never, reduceOnly: true })
    expect(close.order?.status).toBe('filled')
  })

  it('当日名义额', async () => {
    await setLimits({ maxDailyNotional: '1500' })
    await place()
    step()
    expect(hits(await place({ size: '0.01001' as never }))).toContain('DAILY_NOTIONAL')
  })

  it('滑点：市价单自带的滑点上限超过策略 → 拒绝', async () => {
    expect(hits(await place({ maxSlippageBps: 200 }))).toContain('SLIPPAGE')
  })

  it('标的 / 场所白名单（空数组 = 不限）', async () => {
    await setLimits({ instrumentAllowlist: [BTC] })
    expect(hits(await place({ instrumentId: ETH, size: '0.5' as never }))).toContain('INSTRUMENT_NOT_ALLOWED')
    step()
    expect((await place()).order?.status).toBe('filled')
    await setLimits({ venueAllowlist: ['binance-usdm'], instrumentAllowlist: [] })
    step()
    expect(hits(await place())).toContain('VENUE_NOT_ALLOWED')
  })

  it('失败即拒：行情陈旧 / 取不到价格 → STALE_PRICE（2007，可重试）', async () => {
    h.live.frozenMarkTs = h.clock.now() - 10_000 // 行情来自账户所属场所的连接器
    const r = await place()
    expect(hits(r)).toContain('STALE_PRICE')
    expect(r.order?.problem).toMatchObject({ code: 2007, retryable: true })
    h.live.frozenMarkTs = null
    h.live.marks.delete(BTC)
    h.sim.marks.delete(BTC)
    expect(hits(await place())).toContain('STALE_PRICE')
  })

  it('保证金不足', async () => {
    h.sim.equity = D('500')
    expect(hits(await place({ leverage: 1 }))).toContain('INSUFFICIENT_MARGIN')
  })

  it('冷却（保护器）：5 s 内连开仓被拒，减仓不受限', async () => {
    await place()
    h.clock.advance(1000)
    expect(hits(await place({ size: '0.011' as never }))).toContain('COOLDOWN')
    expect((await place({ side: 'sell', size: '0.005' as never, reduceOnly: true })).order?.status).toBe('filled')
  })

  it('每分钟下单上限 / 场所权重预算（HL 1200 权重 / 分钟）', async () => {
    await setLimits({ maxOrdersPerMinute: 2 }, [])
    await place({ size: '0.011' as never })
    await place({ size: '0.012' as never })
    expect(hits(await place({ size: '0.013' as never }))).toContain('RATE_BUDGET')
    step(61)
    expect((await place({ size: '0.013' as never })).order?.status).toBe('filled')
    // 场所权重预算：连接器上报消耗，内核记账
    h.k.bus.reportWeight('hyperliquid', 1200)
    expect(h.k.bus.budget('hyperliquid')!.ratio()).toBeGreaterThanOrEqual(1)
    const live = await h.k.trading.place({ intent: mk({ accountId: h.liveAcct.accountId as never }) }, h.human())
    expect(hits(live)).toContain('RATE_BUDGET')
  })
})

describe('日笔数上限（每账户 / 每 Agent 钥匙）', () => {
  it('账户级：超限拒绝并入账，第二天恢复', async () => {
    await setLimits({ maxDailyOrders: 2 }, [])
    await place({ size: '0.011' as never })
    await place({ size: '0.012' as never })
    const r = await place({ size: '0.013' as never })
    expect(hits(r)).toContain('RATE_BUDGET')
    expect(ruleIds(r).some((x) => x.endsWith('#maxDailyOrders'))).toBe(true)
    expect(h.k.ledger.query({ types: ['risk.denied'], limit: 1 })[0]!.ruleHits![0]!.unit).toBe('orders/day')
    h.clock.advance(26 * 3600_000)
    expect((await place({ size: '0.014' as never })).order?.status).toBe('filled')
  })

  it('每把 Agent 钥匙单独计数：A 钥匙用完不影响 B 钥匙', async () => {
    await setLimits({}, [])
    const a = await makeAgent(h, 'paper', { limits: { maxDailyOrders: 1 } as never })
    const b = await makeAgent(h, 'paper', { limits: { maxDailyOrders: 1 } as never })
    const it1 = mk({ reason: 'test' })
    expect((await h.k.trading.place({ intent: it1 }, a.ctx())).order?.status).toBe('filled')
    const second = await h.k.trading.place({ intent: mk({ reason: 'test', size: '0.011' as never }) }, a.ctx())
    expect(second.order?.status).toBe('denied')
    expect(second.order?.problem?.code).toBe(2004)
    expect((await h.k.trading.place({ intent: mk({ reason: 'test', size: '0.012' as never }) }, b.ctx())).order?.status).toBe('filled')
  })
})

describe('报撤单频率与防重复报单', () => {
  it('默认值写在 gitrader.json 里：30 笔下单 / 分钟、60 次撤单 / 分钟、重复意图窗口 10 s', () => {
    const cfg = JSON.parse(readFileSync(join(h.home, 'gitrader.json'), 'utf8'))
    expect(cfg.risk.limits).toMatchObject({ maxOrdersPerMinute: 30, maxCancelsPerMinute: 60, duplicateIntentWindowSec: 10 })
    expect(h.k.risk.current()!.limits).toMatchObject({ maxOrdersPerMinute: 30, maxCancelsPerMinute: 60 })
  })

  it('撤单频率：每账户每分钟上限，超限拒绝并入账；接管发起的撤单不受限', async () => {
    // 第一段只验证撤单计数与 61 秒窗口恢复。
    await setLimits({ maxCancelsPerMinute: 2 }, [])
    const orders = []
    for (let i = 0; i < 4; i++) orders.push((await place({ type: 'limit', price: '70000' as never, size: `0.01${i}` as never, tif: 'gtc' })).order!)
    for (let i = 0; i < 2; i++) expect((await h.k.trading.cancel({ accountId: h.paper.accountId, orderId: orders[i]!.orderId }, h.human())).ok).toBe(true)
    await expect(h.k.trading.cancel({ accountId: h.paper.accountId, orderId: orders[2]!.orderId }, h.human())).rejects.toMatchObject({ problem: { code: 2008, retryable: true } })
    const denied = h.k.ledger.query({ types: ['risk.denied'], limit: 1 })[0]!
    expect(denied.ruleHits![0]).toMatchObject({ unit: 'cancels/min', limit: '2', actual: '3' })
    h.clock.advance(61_000)
    expect((await h.k.trading.cancel({ accountId: h.paper.accountId, orderId: orders[2]!.orderId }, h.human())).ok).toBe(true) // 窗口过后恢复
    // 接管发起的撤单不受频率限制（自保动作）：此时已用掉 1 次额度，再连撤也不被拦
    await h.k.trading.cancel({ accountId: h.paper.accountId, orderId: orders[3]!.orderId }, h.human())
    // 第二段使用合规挂单，只验证接管豁免计数；两单总额 2870 低于默认 3000 上限。
    const more = [(await place({ type: 'limit', price: '70000' as never, size: '0.020' as never })).order!, (await place({ type: 'limit', price: '70000' as never, size: '0.021' as never })).order!]
    expect(more.every((o) => o.status === 'open')).toBe(true)
    const tk = await h.k.takeover.execute({ level: 'cancel_all', scope: { type: 'account', id: h.paper.accountId }, reason: 'test' }, h.human())
    expect(tk.cancelled).toBe(2)
  })

  it('撤单频率也能按 Agent 钥匙单独设（授权书 limits.maxCancelsPerMinute）', async () => {
    const a = await makeAgent(h, 'paper', { limits: { maxCancelsPerMinute: 1 } as never })
    await setLimits({}, [])
    const o1 = (await h.k.trading.place({ intent: mk({ type: 'limit', price: '70000' as never, reason: 'x' }) }, a.ctx())).order!
    const o2 = (await h.k.trading.place({ intent: mk({ type: 'limit', price: '70001' as never, size: '0.011' as never, reason: 'x' }) }, a.ctx())).order!
    await h.k.trading.cancel({ accountId: h.paper.accountId, orderId: o1.orderId }, a.ctx())
    await expect(h.k.trading.cancel({ accountId: h.paper.accountId, orderId: o2.orderId }, a.ctx())).rejects.toMatchObject({ problem: { code: 2004 } })
  })

  it('clientOrderId 幂等：同 id 在窗口内重复提交返回原订单、不重发；参数不同的复用被拒；超窗口的旧 id 不能再用', async () => {
    const cloid = 'ab'.repeat(16)
    const a = await place({ clientOrderId: cloid })
    expect(a.order?.status).toBe('filled')
    const again = await place({ clientOrderId: cloid })
    expect(again.order?.orderId).toBe(a.order?.orderId)
    expect(h.sim.submitted.length).toBe(1)
    expect(h.k.ledger.query({ types: ['order.intent'] }).length).toBe(1)
    await expect(place({ clientOrderId: cloid, size: '0.02' as never })).rejects.toMatchObject({ problem: { code: -32602 } })
    h.clock.advance(11 * 60_000)
    await expect(place({ clientOrderId: cloid })).rejects.toMatchObject({ problem: { message: expect.stringContaining('idempotency window') } })
    expect(h.sim.submitted.length).toBe(1)
  })

  it('重复意图：同标的同方向同价同量在 10 s 内默认拒绝；窗口外放行；减仓不受限', async () => {
    await setLimits({}, []) // 去掉冷却，单独看重复意图
    await place()
    h.clock.advance(2000)
    const dup = await place()
    expect(dup.order?.status).toBe('denied')
    expect(ruleIds(dup).some((x) => x.endsWith('#duplicateIntent'))).toBe(true)
    h.clock.advance(11_000)
    expect((await place()).order?.status).toBe('filled')
    // 减仓重复（接管 / 平仓重试）不受限
    expect((await place({ side: 'sell', reduceOnly: true, size: '0.01' as never })).order?.status).toBe('filled')
    expect((await place({ side: 'sell', reduceOnly: true, size: '0.01' as never })).order?.status).toBe('filled')
  })

  it('重复意图窗口可以关闭，但关闭属于放宽：会话不行，PIN 才行', async () => {
    await setLimits({}, [])
    await expect(Promise.resolve().then(() => h.k.risk.tighten({ limits: { duplicateIntentWindowSec: 0 } as never }, h.sessionProof(), h.human().origin))).rejects.toThrow(/loosens/)
    await setLimits({ duplicateIntentWindowSec: 0 })
    await place()
    h.clock.advance(1000)
    expect((await place()).order?.status).toBe('filled')
  })
})

describe('三态与杀开关', () => {
  it('收紧随时可做；从 REDUCING / HALTED 恢复 ACTIVE 必须 PIN（会话不行）；每次变化入账', async () => {
    const pin = await h.pinProof()
    const o = h.human('state').origin
    h.k.tstate.set(ORG_SCOPE, 'REDUCING', 'test', o)
    expect(() => h.k.tstate.set(ORG_SCOPE, 'ACTIVE', 'back', o)).toThrow(/presence/)
    expect(() => h.k.tstate.set(ORG_SCOPE, 'ACTIVE', 'back', o, h.sessionProof())).toThrow(/PIN/)
    h.k.tstate.set(ORG_SCOPE, 'HALTED', 'worse', o)
    expect(() => h.k.tstate.set(ORG_SCOPE, 'REDUCING', 'less', o, h.sessionProof())).toThrow()
    h.k.tstate.set(ORG_SCOPE, 'ACTIVE', 'ok', o, pin)
    expect(h.k.ledger.query({ types: ['trading_state.changed'], order: 'asc' }).map((e) => (e.payload as any).to)).toEqual(['REDUCING', 'HALTED', 'ACTIVE'])
  })

  it('REDUCING 减仓无 PIN；HALTED 减仓需 PIN；开仓仍被拒（2002）', async () => {
    await place()
    step()
    for (const state of ['REDUCING', 'HALTED'] as const) {
      h.k.tstate.set(ORG_SCOPE, state, 't', h.human().origin)
      const r = await place({ size: '0.011' as never })
      expect(r.order?.status, state).toBe('denied')
      expect(r.order?.problem?.code, state).toBe(2002)
      const reductionIntent: Partial<OrderIntent> = { side: 'sell', size: '0.001' as never, reduceOnly: true }
      if (state === 'HALTED') {
        const beforePinAttempt = h.sim.submitted.length
        await expect(place(reductionIntent, h.human())).rejects.toMatchObject({ problem: { name: 'AUTH_FAILED' } })
        expect(h.sim.submitted).toHaveLength(beforePinAttempt)
      }
      const reductionCtx = state === 'HALTED' ? { ...h.human(), proof: await h.pinProof() } : h.human()
      const c = await place(reductionIntent, reductionCtx)
      expect(c.order?.status, state).toBe('filled')
      step()
      await h.k.tstate.set(ORG_SCOPE, 'ACTIVE', 'back', h.human().origin, await h.pinProof())
    }
  })

  it('杀开关：撤全部（含保护单）+ 整体 HALTED；恢复只有人 + PIN', async () => {
    await enableLive(h)
    await place({ type: 'limit', price: '70000' as never })
    const rec = await h.k.takeover.kill('manual stop', h.human('kill'))
    expect(rec.stateAfter).toBe('HALTED')
    expect(h.sim.cancelAllCalls.length).toBeGreaterThan(0) // keepProtective: false → 全撤（含保护单）走连接器的 cancelAll
    expect(h.k.tstate.get(ORG_SCOPE)).toBe('HALTED')
    await expect(h.k.takeover.resume(ORG_SCOPE, 'x', h.sessionProof(), h.human())).rejects.toThrow(/PIN/)
    await h.k.takeover.resume(ORG_SCOPE, 'all clear', await h.pinProof(), h.human())
    expect(h.k.tstate.get(ORG_SCOPE)).toBe('ACTIVE')
  })
})

describe('保护器（可叠加，触发后作用域 REDUCING 若干分钟，入账撞了哪条规则）', () => {
  it('连续失败熔断', async () => {
    await setLimits({}, [COOLDOWN, { kind: 'max_consecutive_failures', count: 2, pauseMin: 3 }])
    h.sim.script = ['reject', 'reject']
    const r1 = await place({ size: '0.011' as never })
    expect(r1.order?.status).toBe('rejected')
    expect(r1.order?.problem?.venue?.message).toBe('Order has invalid size.') // 上游原文，不改写
    step()
    await place({ size: '0.012' as never })
    step()
    const blocked = await place({ size: '0.013' as never })
    expect(blocked.order?.problem?.code).toBe(2006)
    expect(hits(blocked)).toContain('PROTECTOR')
    const trig = h.k.ledger.query({ types: ['protector.triggered'], limit: 1 })[0]!
    expect(trig.ruleHits![0]).toMatchObject({ code: 'PROTECTOR', limit: '2', actual: '2' })
    h.clock.advance(4 * 60_000)
    h.k.tstate.tick()
    expect((await place({ size: '0.013' as never })).order?.status).toBe('filled')
  })

  it('止损次数', async () => {
    await setLimits({}, [COOLDOWN, { kind: 'stoploss_guard', windowMin: 60, maxStoplosses: 2, pauseMin: 10, scope: 'account' }])
    const o1 = (await place({ type: 'stop_market', triggerPrice: '79000' as never, size: '0.011' as never, side: 'sell' })).order!
    step()
    const o2 = (await place({ type: 'stop_market', triggerPrice: '78000' as never, size: '0.012' as never, side: 'sell' })).order!
    const fill = (o: typeof o1, n: number): Fill => ({ fillId: `fill_s${n}` as never, orderId: o.orderId, clientOrderId: o.clientOrderId, venueFillId: `vf-stop-${n}`, accountId: h.paper.accountId as never, instrumentId: BTC, side: 'sell', price: '79000' as never, size: o.size, fee: '0' as never, feeCcy: 'USDC', liquidity: 'taker', realizedPnl: '-5' as never, ts: h.clock.now() })
    h.k.trading.applyFill(fill(o1, 1))
    expect(h.k.tstate.effective([{ type: 'account', id: h.paper.accountId }]).state).toBe('ACTIVE')
    h.k.trading.applyFill(fill(o2, 2))
    expect(h.k.tstate.effective([{ type: 'account', id: h.paper.accountId }]).state).toBe('REDUCING')
    expect(h.k.ledger.query({ types: ['protector.triggered'] }).length).toBe(1)
    expect(h.k.trading.applyFill(fill(o2, 2))).toBe(false) // 成交按 venueFillId 去重
  })

  it('回撤暂停', async () => {
    await setLimits({}, [COOLDOWN, { kind: 'drawdown_pause', windowHours: 1, maxDrawdownRatio: '0.05', pauseMin: 5 }])
    await place()
    step()
    h.sim.equity = D('9000')
    const r = await place({ size: '0.011' as never })
    expect(r.order?.status).toBe('denied')
    expect(r.order?.problem?.code).toBe(2006)
  })
})

describe('放宽 / 临时放宽 / 预设（数字，不用标签）', () => {
  it('临时放宽：PIN、≤24 小时、到期自动回收并入账', async () => {
    await setLimits({}, [])
    expect(hits(await place({ size: '0.0375' as never }))).toContain('ORDER_NOTIONAL') // 3000 > 2000
    const pin = await h.pinProof()
    expect(() => h.k.risk.temporaryRelax({ maxOrderNotional: '9000' as never }, h.clock.now() + 25 * 3600_000, pin, h.human().origin)).toThrow(/24 hours/)
    expect(() => h.k.risk.temporaryRelax({ maxOrderNotional: '9000' as never }, h.clock.now() + 3600_000, h.sessionProof(), h.human().origin)).toThrow(/PIN/)
    h.k.risk.temporaryRelax({ maxOrderNotional: '9000' as never }, h.clock.now() + 3600_000, pin, h.human().origin)
    expect((await place({ size: '0.0375' as never })).order?.status).toBe('filled')
    h.clock.advance(3601_000)
    expect(h.k.risk.tick()).toBe(true)
    expect(h.k.ledger.query({ types: ['policy.reverted'] }).length).toBe(1)
    expect(hits(await place({ size: '0.0376' as never }))).toContain('ORDER_NOTIONAL')
  })

  it('fix-r4 C1：临时放宽的 fields 只能含 RiskLimits 已知键；导出带 temporaryRelax、重启仍生效、到期 tick 后为 null 且有 policy.reverted', async () => {
    await setLimits({}, [])
    const pin = await h.pinProof()
    const until = h.clock.now() + 3600_000
    const before = h.k.ledger.query({ types: ['policy.relaxed'] }).length
    expect(() => h.k.risk.temporaryRelax({ maxOrderNotinal: '9000' } as never, until, pin, h.human().origin)).toThrow(/unknown risk limit field.*maxOrderNotinal/)
    expect(() => h.k.risk.temporaryRelax('x' as never, until, pin, h.human().origin)).toThrow(/fields must be an object/)
    expect(h.k.ledger.query({ types: ['policy.relaxed'] }).length).toBe(before) // 被拒的请求不入账、不改策略
    h.k.risk.temporaryRelax({ maxOrderNotional: '9000' as never }, until, pin, h.human().origin)
    const exported = () => (h.k.risk.exportPolicy() as { policy: { temporaryRelax: { fields: Record<string, string>; until: number } | null } }).policy.temporaryRelax
    expect(exported()).toMatchObject({ fields: { maxOrderNotional: '9000' }, until })
    // 同 home 重启：临时放宽仍在，限额仍是放宽后的值
    await h.k.stop()
    const k2 = await Kernel.create({ home: h.home, clock: h.clock, scrypt: FAST_SCRYPT, timers: false })
    try {
      expect((k2.risk.exportPolicy() as { policy: { temporaryRelax: { until: number } | null } }).policy.temporaryRelax).toMatchObject({ until })
      expect(k2.risk.effectiveLimits(h.clock.now()).maxOrderNotional).toBe('9000')
      h.clock.advance(3601_000)
      await k2.tickOnce()
      expect((k2.risk.exportPolicy() as { policy: { temporaryRelax: unknown } }).policy.temporaryRelax).toBeNull()
      expect(k2.ledger.query({ types: ['policy.reverted'] }).length).toBe(1)
    } finally { await k2.stop() }
  })

  it('ADR-33：放宽期间收紧 → 被收紧的键退出覆盖层、生效值 = 新基线；连续放宽两项会合并；比基线更严的“放宽”被拒', async () => {
    await setLimits({}, [])
    const pin = await h.pinProof()
    const until = h.clock.now() + 3600_000
    const overlay = () => (h.k.risk.exportPolicy() as { policy: { temporaryRelax: { fields: Record<string, unknown>; until: number } | null } }).policy.temporaryRelax
    h.k.risk.temporaryRelax({ maxOrderNotional: '9000' as never }, until, pin, h.human().origin)
    h.k.risk.temporaryRelax({ maxLeverage: 8 }, until + 1000, pin, h.human().origin)
    expect(overlay()).toMatchObject({ fields: { maxOrderNotional: '9000', maxLeverage: 8 }, until: until + 1000 }) // 两项都在，until 取后一次
    expect(() => h.k.risk.temporaryRelax({ maxOrderNotional: '100' as never }, until, pin, h.human().origin)).toThrow(/tighter than baseline.*maxOrderNotional/)
    expect(h.k.risk.effectiveLimits(h.clock.now()).maxOrderNotional).toBe('9000') // 被拒不改策略
    h.k.risk.tighten({ limits: { maxOrderNotional: '500' as never } }, h.sessionProof(), h.human().origin)
    expect(h.k.risk.effectiveLimits(h.clock.now()).maxOrderNotional).toBe('500')
    expect(overlay()!.fields).toEqual({ maxLeverage: 8 }) // 该键退出覆盖层，另一项仍在
    expect(h.k.ledger.query({ types: ['policy.changed'] }).map((e) => e.payload)).toContainEqual(expect.objectContaining({ change: 'tighten', clearedRelax: ['maxOrderNotional'] }))
    h.k.risk.tighten({ limits: { maxLeverage: 2 } }, h.sessionProof(), h.human().origin)
    expect(overlay()).toBeNull() // 覆盖层空了置 null
    expect(h.k.risk.effectiveLimits(h.clock.now()).maxLeverage).toBe(2)
  })

  it('预设是一组数字：id 由数字拼成；放宽到更大的预设要 PIN，收紧到更小的会话即可', async () => {
    await h.pinProof()
    const sesTok = h.k.auth.exchangeBoot(h.k.auth.mintBootToken()).sessionToken
    const ses = h.k.auth.authenticateToken(sesTok)!
    await expect(h.k.ops.call(h.k, 'risk.preset', { principal: ses, params: { presetId: 'p-lev10-o20000-d10' }, transport: 'http' })).rejects.toMatchObject({ problem: { code: 1010 } })
    await h.k.ops.call(h.k, 'risk.preset', { principal: ses, params: { presetId: 'p-lev10-o20000-d10' }, transport: 'http', pin: '482916' })
    expect(h.k.risk.current()!.limits.maxLeverage).toBe(10)
    await h.k.ops.call(h.k, 'risk.preset', { principal: ses, params: { presetId: 'p-lev3-o2000-d3' }, transport: 'http' })
    expect(h.k.risk.current()!.limits.maxLeverage).toBe(3)
  })

  it('Agent 没有任何入口改限额（风控服务只收人面证明）', async () => {
    const a = await makeAgent(h, 'paper')
    for (const name of ['risk.tighten', 'risk.relax', 'risk.preset', 'risk.temporaryRelax', 'risk.setLlmLiveEntries', 'trading_state.resume', 'mandate.update']) {
      await expect(h.k.ops.call(h.k, name, { principal: a.principal, params: {}, transport: 'http' }), name).rejects.toMatchObject({ problem: { code: 5003 } })
    }
  })
})

describe('风控文档是用户签名的文档（失败即停）', () => {
  async function restart(): Promise<Kernel> {
    await h.k.stop()
    return Kernel.create({ home: h.home, clock: h.clock, scrypt: FAST_SCRYPT, timers: false })
  }

  it('被篡改（数据库里把单笔上限改大）→ 重启后 HALTED，开仓被拒', async () => {
    await h.k.stop()
    const raw = new DatabaseSync(join(h.home, 'data', 'gitrader.sqlite'))
    raw.exec(`UPDATE docs SET doc=json_set(doc,'$.limits.maxOrderNotional','99999999') WHERE coll='policy'`)
    raw.close()
    const k2 = await Kernel.create({ home: h.home, clock: h.clock, scrypt: FAST_SCRYPT, timers: false })
    try {
      expect(k2.risk.integrity.ok).toBe(false)
      expect(k2.tstate.get(ORG_SCOPE)).toBe('HALTED')
      expect(k2.warnings.join(' ')).toMatch(/failed verification/)
    } finally { await k2.stop() }
  })

  it('被删除（账本里出现过、现在没了）→ 重启后 HALTED，不会被悄悄重新播种', async () => {
    await h.k.stop()
    const raw = new DatabaseSync(join(h.home, 'data', 'gitrader.sqlite'))
    raw.exec(`DELETE FROM docs WHERE coll='policy'`)
    raw.close()
    const k2 = await Kernel.create({ home: h.home, clock: h.clock, scrypt: FAST_SCRYPT, timers: false })
    try {
      expect(k2.risk.current()).toBeUndefined()
      expect(k2.tstate.get(ORG_SCOPE)).toBe('HALTED')
    } finally { await k2.stop() }
  })

  it('gitrader.json 里写更宽的限额会被忽略并提示；写更严的会生效（系统签名版本）', async () => {
    const cfgPath = join(h.home, 'gitrader.json')
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
    const v0 = h.k.risk.current()!.version
    cfg.risk.limits.maxOrderNotional = '999999'
    writeFileSync(cfgPath, JSON.stringify(cfg))
    let k2 = await restart()
    expect(k2.risk.current()!.version).toBe(v0)
    expect(k2.risk.current()!.limits.maxOrderNotional).toBe('2000')
    expect(k2.warnings.join(' ')).toMatch(/looser/)
    await k2.stop()
    cfg.risk.limits.maxOrderNotional = '1000'
    writeFileSync(cfgPath, JSON.stringify(cfg))
    k2 = await Kernel.create({ home: h.home, clock: h.clock, scrypt: FAST_SCRYPT, timers: false })
    expect(k2.risk.current()!.limits.maxOrderNotional).toBe('1000')
    expect(k2.risk.current()!.attestation.method).toBe('system')
    expect(k2.risk.integrity.ok).toBe(true)
    await k2.stop()
  })

  it('非强签名版本不得比最近一次强签名版本更宽（伪造 session / system 版本最多造成更严）', async () => {
    await setLimits({ maxOrderNotional: '2500' }) // 强签名 pin 版本
    const cur = h.k.risk.current()!
    await h.k.stop()
    const raw = new DatabaseSync(join(h.home, 'data', 'gitrader.sqlite'))
    // 伪造一个 system 版本把上限放大：摘要对不上签名 → 验签失败
    const forged = { ...cur, version: cur.version + 1, limits: { ...cur.limits, maxOrderNotional: '90000' }, attestation: { ...cur.attestation, method: 'system' } }
    raw.prepare(`INSERT INTO docs(coll,id,ver,doc,updated_at) VALUES('policy',?,?,?,0)`).run(cur.policyId, forged.version, JSON.stringify(forged))
    raw.close()
    const k2 = await Kernel.create({ home: h.home, clock: h.clock, scrypt: FAST_SCRYPT, timers: false })
    try { expect(k2.tstate.get(ORG_SCOPE)).toBe('HALTED') } finally { await k2.stop() }
  })
})

void mkOrigin
