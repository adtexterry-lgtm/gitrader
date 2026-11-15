// SPDX-License-Identifier: CPAL-1.0
// 接管三档 / 杀开关 / 死人开关（Agent 心跳 + 场所级 scheduleCancel）/ HALT 哨兵（入口拒绝 + 向引擎广播 halt）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { OrderIntent } from '../src/proto'
import { ORG_SCOPE } from '../src/trading-state'
import { BTC } from './helpers/fake-connector'
import { enableLive, makeAgent, makeHarness } from './helpers/harness'
import type { Harness } from './helpers/harness'

let h: Harness
beforeEach(async () => { h = await makeHarness() })
afterEach(async () => { await h.cleanup() })

const mk = (o: Partial<OrderIntent> = {}): OrderIntent => ({ accountId: h.paper.accountId as never, instrumentId: BTC, side: 'buy', type: 'market', size: '0.01' as never, leverage: 2, ...o } as OrderIntent)
const acct = (): { type: 'account'; id: string } => ({ type: 'account', id: h.paper.accountId })
const positions = async () => (await h.sim.accountState({ accountId: h.paper.accountId } as never)).positions

describe('接管三档', () => {
  beforeEach(async () => { await h.k.trading.place({ intent: mk() }, h.human()); h.clock.advance(11_000); await h.k.trading.place({ intent: mk({ type: 'limit', price: '70000' as never, size: '0.011' as never }) }, h.human()) })

  it('T1 停止新开仓：REDUCING，不撤单不平仓（暂停不等于平仓）；全程入账，takeover 条目带 ruleHits（可为空）', async () => {
    const r = await h.k.takeover.execute({ level: 'halt_new', scope: acct(), reason: 'looking at news' }, h.human('ui:statusbar.halt_new'))
    expect(r).toMatchObject({ level: 'halt_new', stateAfter: 'REDUCING', cancelled: 0, ok: true })
    expect(h.sim.cancelAllCalls.length).toBe(0)
    expect((await positions()).length).toBe(1)
    expect(h.k.tstate.get(acct())).toBe('REDUCING')
    const trail = h.k.ledger.query({ takeoverId: r.takeoverId, order: 'asc' })
    expect(trail.map((e) => e.type)).toEqual(['takeover.requested', 'takeover.applied', 'takeover.completed'])
    expect(trail.every((e) => Array.isArray(e.ruleHits))).toBe(true)
    expect(trail[0]!.payload).toMatchObject({ reason: 'looking at news', level: 'halt_new' })
  })

  it('T2 撤销挂单：默认保留只减仓的止盈止损（逐单撤，不用全撤）；keepProtective:false 才全撤；持仓不动', async () => {
    h.sim.orders.push({ venueOrderId: 'vo-prot', clientOrderId: 'cd'.repeat(16), accountId: h.paper.accountId, instrumentId: BTC, side: 'sell', type: 'stop_market', size: '0.01', price: null, reduceOnly: true, isTrigger: true, status: 'open', createdAt: 0 })
    const r = await h.k.takeover.execute({ level: 'cancel_all', scope: acct(), reason: 'x' }, h.human())
    expect(r.cancelled).toBe(1)
    expect(h.sim.cancelAllCalls.length).toBe(0)
    expect(h.sim.cancelCalls.flat().map((t) => t.venueOrderId)).not.toContain('vo-prot')
    expect(h.sim.orders.find((o) => o.venueOrderId === 'vo-prot')!.status).toBe('open') // 保护单还在
    expect((await positions()).length).toBe(1)
    const r2 = await h.k.takeover.execute({ level: 'cancel_all', scope: acct(), reason: 'x', keepProtective: false }, h.human())
    expect(r2.cancelled).toBeGreaterThanOrEqual(1)
    expect(h.sim.cancelAllCalls.length).toBe(1)
    expect(h.sim.orders.find((o) => o.venueOrderId === 'vo-prot')!.status).toBe('cancelled')
  })

  it('T3 全部平仓：撤单 + 只减仓市价单平掉全部持仓，完成后 HALTED', async () => {
    const ctx = h.human('ui:statusbar.flatten_all')
    if (ctx.principal.kind !== 'session') throw new Error('T3 requires a session principal')
    const r = await h.k.takeover.execute({ level: 'flatten_all', scope: acct(), reason: 'before macro release' }, ctx)
    expect(r).toMatchObject({ ok: true, stateAfter: 'HALTED', cancelled: 1, closeOrders: 1 })
    expect((await positions()).length).toBe(0)
    expect(h.k.tstate.get(acct())).toBe('HALTED')
    const closing = h.sim.submitted.at(-1)!
    expect(closing.intent).toMatchObject({ reduceOnly: true, type: 'market', side: 'sell' })
    const actor = `user:${ctx.principal.userId}`
    expect(h.k.ledger.query({ types: ['order.intent'], limit: 1 })[0]!.origin).toMatchObject({ actor, actorType: 'human', requestId: ctx.origin.requestId })
    expect(closing.ctx.gate).toMatchObject({ ticketId: expect.any(String), precheckId: expect.any(String) })
    const closeEntry = h.k.ledger.query({ types: ['order.intent'], limit: 1 })[0]!
    expect(closeEntry.payload).toMatchObject({ gate: { ticketId: closing.ctx.gate?.ticketId, decision: { precheckId: closing.ctx.gate?.precheckId }, snapshot: { actorClass: 'human', originActorType: 'human' }, target: { kind: 'order', intent: { clientOrderId: closing.intent.clientOrderId } } } })
    expect(closeEntry.subject.precheckId).toBe(closing.ctx.gate?.precheckId)
    const done = h.k.ledger.query({ types: ['takeover.completed'], limit: 1 })[0]!
    expect(done.payload).toMatchObject({ tradingStateAfter: 'HALTED', closeOrders: 1 })
    expect(done.subject.takeoverId).toBe(r.takeoverId)
    expect(done.origin.requestId).toBe(ctx.origin.requestId)
  })

  it('T3 平不掉：退避重试 3 次后告警人，takeover.failed 入账，状态停在 REDUCING 不假装完成', async () => {
    h.sim.closeFills = false
    const alerts: unknown[] = []
    h.k.events.subscribe('takeover.alert', (e) => alerts.push(e.data))
    const before = h.sim.submitted.length
    const r = await h.k.takeover.execute({ level: 'flatten_all', scope: acct(), reason: 'x' }, h.human())
    expect(r.ok).toBe(false)
    expect(r.remaining?.[0]).toMatchObject({ instrumentId: BTC })
    expect(h.sim.submitted.length - before).toBe(4) // 首次 + 3 次重试
    expect(h.k.tstate.get(acct())).toBe('REDUCING')
    expect(alerts.length).toBe(1)
    expect(h.k.ledger.query({ types: ['takeover.failed'] }).length).toBe(1)
  })

  it('reason 必填；未知档位被拒', async () => {
    await expect(h.k.takeover.execute({ level: 'halt_new', scope: acct(), reason: ' ' }, h.human())).rejects.toThrow(/reason/)
    await expect(h.k.takeover.execute({ level: 'nuke' as never, scope: acct(), reason: 'x' }, h.human())).rejects.toThrow(/unknown takeover/)
  })

  it('恢复 ACTIVE 只有人 + PIN；Agent 没有 resume 入口', async () => {
    await h.k.takeover.execute({ level: 'halt_new', scope: acct(), reason: 'x' }, h.human())
    await expect(h.k.takeover.resume(acct(), 'ok', h.sessionProof(), h.human())).rejects.toThrow(/PIN/)
    const a = await makeAgent(h, 'paper')
    await expect(h.k.ops.call(h.k, 'trading_state.resume', { principal: a.principal, params: { reason: 'x' }, transport: 'http', pin: 'whatever1' })).rejects.toMatchObject({ problem: { code: 5003 } })
    await h.k.takeover.resume(acct(), 'all clear', await h.pinProof(), h.human())
    expect(h.k.tstate.get(acct())).toBe('ACTIVE')
  })
})

describe('Agent 的接管作用域不得超出其授权书', () => {
  it('可以对自己的授权书 / 账户做三档；不能碰 org 级，也不能碰授权书之外的账户', async () => {
    const a = await makeAgent(h, 'paper', { accounts: [h.paper.accountId as never] })
    const ok = await h.k.takeover.execute({ level: 'halt_new', scope: { type: 'mandate', id: a.mandate.mandateId }, reason: 'self protect' }, a.ctx('takeover'))
    expect(ok.ok).toBe(true)
    expect(h.k.ledger.query({ takeoverId: ok.takeoverId, limit: 1 })[0]!.origin).toMatchObject({ actor: `agent:${a.keyId}`, actorType: 'llm-agent' })
    await expect(h.k.takeover.execute({ level: 'halt_new', scope: ORG_SCOPE, reason: 'x' }, a.ctx())).rejects.toMatchObject({ problem: { code: 2004 } })
    await expect(h.k.takeover.execute({ level: 'cancel_all', scope: { type: 'account', id: h.liveAcct.accountId }, reason: 'x' }, a.ctx())).rejects.toMatchObject({ problem: { code: 2004 } })
    await expect(h.k.takeover.execute({ level: 'halt_new', scope: { type: 'mandate', id: 'mdt_someoneelse' }, reason: 'x' }, a.ctx())).rejects.toMatchObject({ problem: { code: 2004 } })
    const flat = await h.k.takeover.execute({ level: 'flatten_all', scope: { type: 'account', id: h.paper.accountId }, reason: 'self protect' }, a.ctx())
    expect(flat.ok).toBe(true)
    await expect(h.k.takeover.kill('x', a.ctx())).rejects.toMatchObject({ problem: { code: 2004 } })
  })
})

describe('死人开关', () => {
  it('Agent 心跳：超时（没有任何已认证调用、也没有 mandate.heartbeat）→ 授权书降级 + 按授权书接管；已认证调用算存活', async () => {
    const a = await makeAgent(h, 'auto_limited')
    h.clock.advance(100_000)
    expect(h.k.agents.verifyToken(a.token)).not.toBeNull() // 任何已认证调用都算存活
    h.clock.advance(100_000)
    await h.k.tickOnce()
    expect(h.k.agents.effective(a.mandate.mandateId)!.level).toBe('L3') // 距上次调用只有 100 s < 180 s
    h.k.agents.heartbeat(a.mandate.mandateId) // 显式心跳
    h.clock.advance(170_000)
    await h.k.tickOnce()
    expect(h.k.agents.effective(a.mandate.mandateId)!.level).toBe('L3')
    h.clock.advance(20_000) // 共 190 s 无任何动静
    await h.k.tickOnce()
    await new Promise((r) => setTimeout(r, 50)) // 接管是异步的
    expect(h.k.agents.effective(a.mandate.mandateId)!.level).toBe('L0')
    expect(h.k.ledger.query({ types: ['mandate.downgraded'], limit: 1 })[0]!.payload).toMatchObject({ from: 'L3', to: 'L0' })
    expect(h.k.tstate.get({ type: 'mandate', id: a.mandate.mandateId })).toBe('REDUCING') // 默认 onTimeout: 降到 L0 + halt_new
    const order = await h.k.trading.place({ intent: mk({ reason: 'x' }) }, a.ctx())
    expect(order.order?.status).toBe('denied')
  })

  it('场所级常驻看门狗：只有“有实盘挂单”或“有实盘授权书”才续期；每 10 分钟把取消时间推到 20 分钟后；没解锁钱包就不设；没东西可看就清除', async () => {
    await enableLive(h)
    await h.k.tickOnce()
    expect(h.live.scheduleCalls.length).toBe(0) // 没有实盘挂单，也没有实盘授权书
    const o = await h.k.trading.place({ intent: { accountId: h.liveAcct.accountId as never, instrumentId: BTC, side: 'buy', type: 'limit', price: '70000' as never, size: '0.01' as never, tif: 'gtc' } }, h.human())
    expect(o.order?.status).toBe('open')
    await h.k.tickOnce()
    expect(h.live.scheduleCalls).toEqual([{ atMs: h.clock.now() + 20 * 60_000, signed: true }])
    h.clock.advance(9 * 60_000)
    await h.k.tickOnce()
    expect(h.live.scheduleCalls.length).toBe(1) // 还没到续期时间
    h.clock.advance(61_000)
    await h.k.tickOnce()
    expect(h.live.scheduleCalls.length).toBe(2)
    expect(h.live.scheduleCalls[1]!.atMs).toBe(h.clock.now() + 20 * 60_000) // 续期：往后推，不是触发
    expect(h.sim.scheduleCalls.length).toBe(0) // 模拟场所不需要
    // 挂单没了、也没有授权书 → 清除
    await h.k.trading.cancelAll({ accountId: h.liveAcct.accountId }, h.human())
    for (const x of h.live.orders) { x.status = 'cancelled'; h.k.trading.onOrderUpdate(h.liveAcct.accountId, { venueOrderId: x.venueOrderId, clientOrderId: x.clientOrderId, status: 'cancelled' }) } // 真连接器会推 orderUpdates
    await h.k.tickOnce()
    expect(h.live.scheduleCalls.at(-1)).toEqual({ atMs: null, signed: true })
    // 实盘授权书（L2+ 覆盖该账户）也会让看门狗续期
    await makeAgent(h, 'confirm')
    h.clock.advance(11 * 60_000)
    await h.k.tickOnce()
    expect(h.live.scheduleCalls.at(-1)!.atMs).toBe(h.clock.now() + 20 * 60_000)
    // 钱包锁着就不设
    const before = h.live.scheduleCalls.length
    h.k.keystore.lock()
    h.clock.advance(11 * 60_000)
    await h.k.tickOnce()
    expect(h.live.scheduleCalls.length).toBe(before)
  })

  it('HALTED 立即触发：账户进入 HALTED → 该实盘账户立刻设最短延迟的“到点全撤”', async () => {
    await enableLive(h)
    h.k.tstate.set({ type: 'account', id: h.liveAcct.accountId }, 'HALTED', 'drill', h.human().origin)
    await new Promise((r) => setTimeout(r, 50))
    expect(h.live.scheduleCalls.at(-1)).toEqual({ atMs: h.clock.now() + 7000, signed: true })
    expect(h.k.ledger.query({ types: ['annotation'], limit: 1 })[0]!.payload).toMatchObject({ deadman: 'trip' })
    // 纸面账户 HALTED 不碰实盘
    const n = h.live.scheduleCalls.length
    h.k.tstate.set({ type: 'account', id: h.paper.accountId }, 'HALTED', 'drill', h.human().origin)
    await new Promise((r) => setTimeout(r, 50))
    expect(h.live.scheduleCalls.length).toBe(n)
  })

  it('杀开关：撤全部 + HALTED + 场所级到点全撤（最短延迟 + 余量）；入账', async () => {
    await enableLive(h)
    const r = await h.k.takeover.kill('manual stop', h.human('ui:kill'))
    expect(r.stateAfter).toBe('HALTED')
    expect(h.live.cancelAllCalls.length).toBeGreaterThan(0) // 杀开关：keepProtective:false 全撤
    expect(h.live.scheduleCalls.at(-1)).toEqual({ atMs: h.clock.now() + 7000, signed: true }) // minDelaySec 5 + 2 s
    expect(h.k.ledger.query({ types: ['annotation'], limit: 1 })[0]!.payload).toMatchObject({ deadman: 'trip', ok: true })
  })

  it('kill 在首个异步等待前同步记录唯一 requested 并进入 HALTED', async () => {
    await enableLive(h)
    let finishTrip!: (armed: number) => void
    const tripWait = new Promise<number>(resolve => { finishTrip = resolve })
    vi.spyOn(h.k.deadman, 'trip').mockReturnValue(tripWait)
    const eventOrder: string[] = []
    const unsubscribe = h.k.events.subscribe('ledger.entry', event => {
      const entry = event.data as { type?: string }
      if (entry.type === 'takeover.requested' || entry.type === 'trading_state.changed') eventOrder.push(entry.type)
    })
    const ctx = h.human('ui:kill')
    const pending = h.k.takeover.kill('manual stop', ctx)
    try {
      const requested = h.k.ledger.query({ types: ['takeover.requested'], order: 'asc' })
      expect(requested).toHaveLength(1)
      expect(h.k.tstate.get(ORG_SCOPE)).toBe('HALTED')
      expect(eventOrder).toEqual(['takeover.requested', 'trading_state.changed'])
      expect(requested[0]).toMatchObject({
        subject: { takeoverId: expect.any(String), orgId: 'org_local' },
        origin: { requestId: ctx.origin.requestId },
        payload: { level: 'cancel_all', scope: ORG_SCOPE, reason: 'kill switch: manual stop' },
      })
      finishTrip(0)
      const result = await pending
      expect(result.takeoverId).toBe(requested[0]!.subject.takeoverId)
    } finally {
      unsubscribe()
      finishTrip(0)
      await pending.catch(() => undefined)
    }
  })

  it('requested append 失败仍先 HALTED 并尝试 deadman，但不进入撤单路径', async () => {
    await enableLive(h)
    const appendFailure = new Error('requested append fixture failure')
    let appendAttempts = 0
    const append = h.k.ledger.append.bind(h.k.ledger)
    const appendSpy = vi.spyOn(h.k.ledger, 'append').mockImplementation(input => {
      if (input.type === 'takeover.requested') { appendAttempts++; throw appendFailure }
      return append(input)
    })
    let finishTrip!: (armed: number) => void
    const tripWait = new Promise<number>(resolve => { finishTrip = resolve })
    const tripSpy = vi.spyOn(h.k.deadman, 'trip').mockReturnValue(tripWait)
    const ctx = h.human('ui:kill')
    const pending = h.k.takeover.kill('manual stop', ctx)
    try {
      expect(h.k.tstate.get(ORG_SCOPE)).toBe('HALTED')
      const explicitTrips = tripSpy.mock.calls.filter(([reason]) => reason === 'kill switch: manual stop')
      expect(explicitTrips).toHaveLength(1)
      expect(explicitTrips[0]?.[1]).toMatchObject({ principal: ctx.principal, origin: { requestId: ctx.origin.requestId } })
      finishTrip(0)
      await expect(pending).rejects.toBe(appendFailure)
      expect(appendAttempts).toBe(1)
      expect(h.sim.cancelAllCalls).toHaveLength(0)
      expect(h.live.cancelAllCalls).toHaveLength(0)
    } finally {
      finishTrip(0)
      appendSpy.mockRestore()
      tripSpy.mockRestore()
      await pending.catch(() => undefined)
    }
  })
})

describe('不变量 4：HALT 哨兵', () => {
  const engineScript = (dir: string): string => {
    mkdirSync(dir, { recursive: true })
    const f = join(dir, 'engine.mjs')
    writeFileSync(f, `import { appendFileSync } from 'node:fs'
process.stdin.setEncoding('utf8')
process.stdin.on('data', (d) => appendFileSync(${JSON.stringify(join(dir, 'received.log'))}, d))
setInterval(() => {}, 1000)
`)
    return f
  }

  it('进入 HALTED 后：除撤单 / 平仓 / 接管外一切新动作在内核入口即拒；并向所有已连引擎广播 engine.halt', async () => {
    await enableLive(h)
    const dir = join(h.home, 'e1')
    h.k.config.engines.push({ id: 'my-engine', enabled: true, launch: { command: process.execPath, args: [engineScript(dir)] } })
    h.k.engines.load(h.k.config.engines)
    h.k.engines.start('my-engine')
    for (let i = 0; i < 50 && h.k.engines.status().find((e) => e.id === 'my-engine')?.state !== 'ready'; i++) await new Promise((r) => setTimeout(r, 50))
    await h.k.trading.place({ intent: mk() }, h.human())
    h.k.tstate.set(ORG_SCOPE, 'HALTED', 'drill', h.human('ui:kill').origin)
    // 广播
    for (let i = 0; i < 50 && !existsSync(join(dir, 'received.log')); i++) await new Promise((r) => setTimeout(r, 50))
    for (let i = 0; i < 60 && !readFileSync(join(dir, 'received.log'), 'utf8').includes('engine.halt'); i++) await new Promise((r) => setTimeout(r, 50))
    const lines = readFileSync(join(dir, 'received.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    expect(lines[0].method).toBe('gep.hello') // 内核先发 gep.hello（这个脚本引擎不是 GEP 引擎，不会回）
    const line = lines.find((l) => l.method === 'engine.halt')
    expect(line).toMatchObject({ jsonrpc: '2.0', method: 'engine.halt', params: { level: 'cancel_all', reason: 'drill', deadlineMs: 200 } })
    for (let i = 0; i < 60 && !h.k.ledger.query({ types: ['engine.event'], limit: 1 }).length; i++) await new Promise((r) => setTimeout(r, 50)) // 账本记录紧跟在写出之后，满载时稍晚
    expect(h.k.ledger.query({ types: ['engine.event'], order: 'asc', limit: 5 })[0]!.payload).toMatchObject({ halt: true, sent: ['my-engine'] })
    // 入口拒绝：新开仓、提案、引擎 / 插件 / 钥匙等新动作
    h.clock.advance(11_000)
    const open = await h.k.trading.place({ intent: mk({ size: '0.011' as never }) }, h.human())
    expect(open.order?.status).toBe('denied')
    expect(h.sim.submitted.length).toBe(1)
    const a = await makeAgent(h, 'paper')
    const prop = await h.k.trading.propose({ accountId: h.paper.accountId, intents: [mk({ reason: 'x' })], reason: 'x' }, a.ctx('propose'))
    expect(prop.status).toBe('denied')
    expect(() => h.k.assertNotHalted('x')).toThrow(/HALTED/)
    const ses = h.session
    for (const [name, params] of [['engine.start', { id: 'my-engine' }], ['plugin.call', { id: 'x', tool: 't' }], ['plugin.start', { id: 'x' }]] as const) {
      await expect(h.k.ops.call(h.k, name, { principal: ses, params, transport: 'http' }), name).rejects.toMatchObject({ problem: { code: 2002 } })
    }
    await h.pinProof()
    await expect(h.k.ops.call(h.k, 'agentkey.create', { principal: ses, params: { name: 'n', host: 'codex', tier: 'paper', mandate: { accounts: [h.paper.accountId] } }, transport: 'http', pin: '482916' })).rejects.toMatchObject({ problem: { code: 2002 } })
    // 撤单 / 平仓 / 接管照常
    const closeIntent = mk({ side: 'sell', reduceOnly: true })
    const beforePinAttempt = h.sim.submitted.length
    await expect(h.k.trading.place({ intent: closeIntent }, h.human())).rejects.toMatchObject({ problem: { name: 'AUTH_FAILED' } })
    expect(h.sim.submitted).toHaveLength(beforePinAttempt)
    expect((await h.k.trading.place({ intent: closeIntent }, { ...h.human(), proof: await h.pinProof() })).order?.status).toBe('filled')
    await expect(h.k.takeover.execute({ level: 'cancel_all', scope: ORG_SCOPE, reason: 'x' }, h.human())).resolves.toMatchObject({ ok: true })
    await h.k.engines.stopAll(500)
  })
})
