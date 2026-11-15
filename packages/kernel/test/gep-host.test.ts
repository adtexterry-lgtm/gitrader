// SPDX-License-Identifier: CPAL-1.0
// 内核作为 GEP 宿主（模式 A）与 D 的 engine-core 真联调：stdio 子进程拉起 → 装入 ema-cross 夹具策略 → 喂夹具 K 线 → 引擎发订单意图 →
// 内核风控 → 模拟场所成交 → 账本两条（意图 / 结果）带 origin → 事件回流引擎；HALTED 广播后引擎不再发意图；denyLlmLiveEntries 对 engine 来源不生效。
// 离线、夹具、临时 HOME；只按自己持有的子进程句柄收尾。
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { buildEngine } from '../../engine-core/build.mjs'
import type { Candle } from '../src/proto'
import { ORG_SCOPE } from '../src/trading-state'
import { BTC } from './helpers/fake-connector'
import { enableLive, makeHarness } from './helpers/harness'
import type { Harness } from './helpers/harness'

let bundle = ''
let buildDir = ''
beforeAll(async () => {
  buildDir = mkdtempSync(join(tmpdir(), 'gitrader-gep-host-'))
  bundle = await buildEngine(join(buildDir, 'engine-core.mjs'))
}, 60_000)
afterAll(() => {
  if (!buildDir) return
  const tempRoot = resolve(tmpdir())
  const ownedDir = resolve(buildDir)
  if (ownedDir !== buildDir || ownedDir === tempRoot || !ownedDir.startsWith(`${tempRoot}${sep}`)) {
    throw new Error('Refusing to remove an unowned or non-temporary engine build directory')
  }
  rmSync(ownedDir, { recursive: true, force: true })
})

let h: Harness
const until = async (f: () => boolean, ms = 8000, what = 'condition'): Promise<void> => {
  for (let i = 0; i < ms / 25 && !f(); i++) await new Promise((r) => setTimeout(r, 25))
  if (!f()) throw new Error(`timeout waiting for ${what}`)
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const STEP = 60_000
const t0 = Math.floor(Date.now() / STEP) * STEP - 140 * STEP
/** 夹具 K 线：先跌 50 根再涨 40 根（快线上穿慢线 → 做多）。 */
function fixtureCandles(): Candle[] {
  const out: Candle[] = []
  let prev = 80400
  for (let i = 0; i < 90; i++) {
    const c = i < 50 ? 80400 - 16 * i : 79600 + 35 * (i - 50)
    out.push({ t: t0 + i * STEP, o: prev, h: Math.max(prev, c) + 3, l: Math.min(prev, c) - 3, c, v: 10 })
    prev = c
  }
  return out
}
const bar = (i: number, c: number, prev: number): Candle => ({ t: t0 + i * STEP, o: prev, h: Math.max(prev, c) + 3, l: Math.min(prev, c) - 3, c, v: 10 })

async function boot(extra: (cfg: Parameters<NonNullable<Parameters<typeof makeHarness>[0]>['configure'] & ((c: never) => void)>[0]) => void = () => undefined): Promise<void> {
  h = await makeHarness({
    kernel: { gep: { heartbeatMs: 500, heartbeatTimeoutMs: 20_000, callTimeoutMs: 8000, haltAckTimeoutMs: 2000 }, engines: { backoffMinMs: 50, backoffMaxMs: 200 } },
    configure: (cfg) => { cfg.engines.push({ id: 'core', enabled: true, launch: { command: process.execPath, args: [bundle, '--stdio'] } }); (extra as (c: unknown) => void)(cfg) },
  })
}

async function engineMandate(level: 'L1' | 'L3' | 'L2', accounts: string[], over: Record<string, unknown> = {}): Promise<string> {
  const pin = await h.pinProof()
  const base: Record<string, unknown> = { subject: { type: 'engine', id: 'core' }, level, accounts }
  if (level !== 'L1') Object.assign(base, { venueAllowlist: ['hyperliquid'], instrumentAllowlist: [BTC], limits: { maxOrderNotional: '1500', maxDailyNotional: '5000', ...(level === 'L3' ? { maxDailyLoss: '200', autoMaxOrderNotional: '1500' } : {}) } })
  return h.k.agents.issueMandate({ ...base, ...over } as never, pin, h.human('mandate.issue').origin).mandateId
}

afterEach(async () => { await h?.cleanup() })

describe('内核 ↔ engine-core（真子进程，GEP stdio）', { timeout: 60_000 }, () => {
  beforeEach(async () => {
    await boot()
    h.sim.candleData.set(BTC, fixtureCandles())
    // 策略文件夹由内核按配置交给引擎：<home>/engines/core/strategies（GITRADER_STRATEGIES_DIR）
    const dir = join(h.home, 'engines', 'core', 'strategies')
    mkdirSync(dir, { recursive: true })
    copyFileSync(join(__dirname, '..', '..', 'engine-core', 'test', 'fixtures', 'strategies', 'ema-cross.ts'), join(dir, 'ema-cross.ts'))
    h.live.candleData.set(BTC, fixtureCandles())
    h.k.engines.start('core')
    await until(() => h.k.gep.isReady('core'), 15_000, 'engine ready (gep.hello + engine.describe)')
  })

  async function bindPaper(): Promise<string> {
    const mdt = await engineMandate('L1', [h.paper.accountId])
    const r = await h.k.gep.bind('core', { accounts: [{ accountId: h.paper.accountId as never, mandateId: mdt }], instruments: [BTC] }, await h.pinProof())
    expect(r.bindingId).toMatch(/^bind_/)
    return mdt
  }
  const startStrategy = (mdt: string): Promise<unknown> => h.k.gep.callEngine('core', 'strategy.start', {
    strategyId: 'ema-trend', accountId: h.paper.accountId, instruments: [BTC], interval: '1m', params: { fast: 3, slow: 6, allowShort: true }, mandateId: mdt,
    sizing: { allocRatio: 0.1, allocCapNotional: 1500, leverage: 2, maxSlippageBps: 50, minStepNotional: 10 },
  })

  it('握手：gep.hello → engine.describe → 绑定 → risk.policy.push；策略文件夹由内核配置传入；引擎看得到夹具策略', async () => {
    const d = h.k.gep.describeOf('core')!
    expect(d.engine.id).toBeTruthy()
    expect(d.capabilities['execution.modeA']).toBe(true)
    const mdt = await bindPaper()
    const st = h.k.gep.status()[0]!
    expect(st).toMatchObject({ engineId: 'core', state: 'ready', bound: true, accounts: [h.paper.accountId] })
    expect((await h.k.gep.callEngine('core', 'strategy.list') as { strategies: { id: string }[] }).strategies.map((s) => s.id)).toContain('ema-trend')
    expect(mdt).toMatch(/^mdt_/)
    // 绑定要 PIN；Agent 面的操作调不了绑定
    await expect(h.k.gep.bind('core', { accounts: [{ accountId: h.paper.accountId as never, mandateId: mdt }], instruments: [BTC] }, h.sessionProof())).rejects.toThrow(/PIN/)
    expect(h.k.ledger.query({ types: ['engine.bound'] }).length).toBe(1)
  })

  it('全链路：装入策略 → 夹具 K 线 → 引擎发订单意图 → 内核风控 → 模拟场所成交 → 账本两条（意图 / 结果）带 origin → 事件回流引擎', async () => {
    const mdt = await bindPaper()
    await startStrategy(mdt)
    await until(() => h.k.ledger.query({ types: ['order.accepted'], limit: 1 }).length > 0, 15_000, 'engine order accepted by the kernel')

    // 1. 账本：意图 + 结果，同一个 orderId，origin 由内核盖章（engine / gep），tool 与 causation 来自引擎
    const intent = h.k.ledger.query({ types: ['order.intent'], order: 'asc' })[0]!
    const accepted = h.k.ledger.query({ types: ['order.accepted'], order: 'asc' })[0]!
    expect(intent.subject.orderId).toBe(accepted.subject.orderId)
    expect(intent.origin).toMatchObject({ actor: 'engine:core', actorType: 'engine', via: 'gep', tool: 'strategy:ema-trend' })
    expect(accepted.origin).toMatchObject({ actor: 'engine:core', actorType: 'engine', via: 'gep' })
    expect(intent.origin.causation).toMatchObject({ engineId: 'core', mandateId: mdt })
    expect(intent.origin.causation?.instanceId).toBeTruthy()
    expect(intent.precheck?.verdict).toBe('allow')
    // 2. 成交：纸面账户由模拟场所承接，持仓是做多
    const order = h.k.orders.list({ accountId: h.paper.accountId })[0]!
    expect(order).toMatchObject({ status: 'filled', side: 'buy', instrumentId: BTC })
    expect(order.origin.actorType).toBe('engine')
    expect(h.sim.submitted.length).toBe(1)
    expect(h.live.submitted.length).toBe(0)
    expect(h.k.ledger.query({ types: ['fill'], limit: 1 })[0]!.subject.orderId).toBe(order.orderId)
    // 3. 事件回流：订单 / 成交事件推给引擎，引擎确认（host.events.ack）
    await until(() => (h.k.gep.stats.pushed.order ?? 0) >= 1 && (h.k.gep.stats.pushed.fill ?? 0) >= 1, 5000, 'order+fill events pushed to the engine')
    await until(() => h.k.gep.stats.engineAckedUpTo >= 1, 5000, 'engine host.events.ack')
    // 4. 引擎方向的事件：策略状态进事件总线、信号进账本（engine-reported）
    await until(() => h.k.gep.stats.engineEventsSeen > 0, 5000, 'engine events')
    expect(h.k.ledger.verify().ok).toBe(true)
    expect(h.k.ledger.query({ types: ['signal.emitted'], limit: 1 })[0]?.attestation ?? 'engine-reported').toBe('engine-reported')
  })

  it('不信任引擎自报的来源：引擎在 origin 里填的 actor / actorType / via 一律被内核覆盖；风控照常拒绝越限的引擎单', async () => {
    const mdt = await bindPaper()
    // 日笔数上限收到 0（引擎自己的协作式风控只认单笔 / 杠杆 / 白名单这些，不认日笔数——强制风控在内核）：引擎的单被风控闸拒绝，结果以 denied + problem 回给引擎（不是 JSON-RPC 错误）
    h.k.risk.tighten({ limits: { maxDailyOrders: 0 } as never }, h.sessionProof(), h.human('risk.tighten').origin)
    await startStrategy(mdt)
    await until(() => h.k.ledger.query({ types: ['risk.denied'], limit: 1 }).length > 0, 15_000, 'risk.denied for an over-limit engine order')
    const denied = h.k.ledger.query({ types: ['risk.denied'], limit: 1 })[0]!
    expect(denied.origin).toMatchObject({ actor: 'engine:core', actorType: 'engine', via: 'gep' })
    expect(denied.ruleHits!.map((r) => r.ruleId).join()).toContain('maxDailyOrders')
    expect(h.sim.submitted.length).toBe(0)
  })

  it('HALTED 广播：引擎收到 engine.halt（cancel_all）并确认后不再发订单意图；人面 PIN 恢复后收到 engine.resume', async () => {
    const mdt = await bindPaper()
    await startStrategy(mdt)
    await until(() => h.sim.submitted.length >= 1, 15_000, 'first engine order')
    const feed = (i: number, c: number, prev: number, closed = true): number => h.k.gep.feedCandle(BTC, '1m', bar(i, c, prev), { closed })
    // 对照：跌穿 → 引擎翻空，又下一单（证明停掉之前这个策略确实会继续下单）
    let prev = 79600 + 35 * 39
    let i = 90
    for (let k = 0; k < 14; k++) { const c = prev - 400; expect(feed(i++, c, prev)).toBe(1); prev = c; await sleep(40) }
    await until(() => h.sim.submitted.length >= 2, 10_000, 'engine flips short before the halt')
    await sleep(200)

    // 收紧到 HALTED
    const before = h.k.gep.stats.orderPlace
    h.k.tstate.set(ORG_SCOPE, 'HALTED', 'drill', h.human('ui:kill').origin)
    await until(() => h.k.ledger.query({ types: ['engine.event'], limit: 5 }).some((e) => (e.payload as { haltAck?: boolean }).haltAck === true), 5000, 'engine.halt acked by the engine')
    const ack = h.k.ledger.query({ types: ['engine.event'], limit: 5 }).find((e) => (e.payload as { haltAck?: boolean }).haltAck === true)!
    expect(ack.payload).toMatchObject({ halt: true, level: 'cancel_all', acked: ['core'], unacked: [] })
    // 再来一波会让策略翻多的 K 线：引擎不再发任何订单意图（连被内核拒绝的尝试都没有）
    for (let k = 0; k < 16; k++) { const c = prev + 500; feed(i++, c, prev); prev = c; await sleep(40) }
    await sleep(800)
    expect(h.k.gep.stats.orderPlace).toBe(before)
    expect(h.sim.submitted.length).toBe(2)

    // 恢复只有人 + PIN；之后内核发 engine.resume
    await h.k.takeover.resume(ORG_SCOPE, 'all clear', await h.pinProof(), h.human('ui:resume'))
    await until(() => h.k.gep.stats.pushed.takeover !== undefined, 5000, 'takeover events')
    const snap = await h.k.gep.callEngine('core', 'strategy.status') as { instances: { status: string }[] }
    expect(snap.instances[0]!.status).toBe('running')
  })

  it('接管 T1（REDUCING）→ engine.halt halt_new；引擎失联（心跳超时）→ 对其账户 halt_new', async () => {
    await bindPaper()
    h.k.tstate.set({ type: 'account', id: h.paper.accountId }, 'REDUCING', 'test', h.human().origin)
    await until(() => h.k.ledger.query({ types: ['engine.event'], limit: 5 }).some((e) => (e.payload as { level?: string }).level === 'halt_new'), 5000, 'halt_new broadcast')
    await h.k.takeover.resume({ type: 'account', id: h.paper.accountId }, 'ok', await h.pinProof(), h.human())
    // 失联：把超时设成 0 → tick 判定
    const k2 = h.k as unknown as { gep: { o: { heartbeatTimeoutMs: number } } }
    k2.gep.o.heartbeatTimeoutMs = -1
    await h.k.tickOnce()
    expect(h.k.tstate.get({ type: 'account', id: h.paper.accountId })).toBe('REDUCING')
    expect(h.k.ledger.query({ types: ['engine.health_changed'], limit: 20 }).some((e) => (e.payload as { to?: string }).to === 'lost')).toBe(true)
    k2.gep.o.heartbeatTimeoutMs = 20_000
  })

  it('进程收尾：stop 只结束自己持有的子进程句柄，进程确实没了', async () => {
    const pid = h.k.engines.status().find((e) => e.id === 'core')!.pid!
    expect(pid).toBeGreaterThan(0)
    await h.k.engines.stop('core', 500)
    await sleep(100)
    expect(() => process.kill(pid, 0)).toThrow()
  })
})

describe('GEP engine.describe 握手超时', () => {
  it('默认允许 engine.describe 超过 5000 ms 后成功完成', async () => {
    h = await makeHarness({
      configure: (cfg) => cfg.engines.push({ id: 'slow-describe', enabled: true, launch: { command: process.execPath, args: [join(__dirname, 'fixtures', 'slow-describe-engine.mjs')], env: { DESCRIBE_DELAY_MS: '5200' } } }),
    })
    h.k.engines.start('slow-describe')
    await until(() => ['ready', 'failed'].includes(h.k.gep.status().find((s) => s.engineId === 'slow-describe')?.state ?? ''), 12_000, 'slow describe engine handshake')
    const status = h.k.gep.status().find((s) => s.engineId === 'slow-describe')!
    expect(status.state, status.detail).toBe('ready')
  }, 20_000)

  it('可配置的 describeTimeoutMs 会让延迟 describe 失败', async () => {
    h = await makeHarness({
      kernel: { gep: { describeTimeoutMs: 100 } },
      configure: (cfg) => cfg.engines.push({ id: 'slow-describe', enabled: true, launch: { command: process.execPath, args: [join(__dirname, 'fixtures', 'slow-describe-engine.mjs')], env: { DESCRIBE_DELAY_MS: '500' } } }),
    })
    h.k.engines.start('slow-describe')
    await until(() => ['ready', 'failed'].includes(h.k.gep.status().find((s) => s.engineId === 'slow-describe')?.state ?? ''), 3000, 'describe timeout handshake')
    expect(h.k.gep.status().find((s) => s.engineId === 'slow-describe')?.state).toBe('failed')
    expect(h.k.gep.status().find((s) => s.engineId === 'slow-describe')?.detail).toMatch(/engine\.describe.*100 ms/)
  }, 10_000)
})

// ---- 脚本引擎：最小 GEP 引擎，用来验证线上的来源盖章、授权书不足转提案、实盘路径 ---------------------------------------------
const SCRIPT_ENGINE = `
import { appendFileSync, readFileSync } from 'node:fs'
const out = process.env.SCRIPT_OUT, actions = JSON.parse(readFileSync(process.env.SCRIPT_IN, 'utf8'))
let buf = '', nid = 1000, accounts = {}
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
const pending = new Map()
const call = (method, params) => new Promise((res) => { const id = nid++; pending.set(id, res); send({ jsonrpc: '2.0', id, method, params }) })
const answer = (m) => {
  switch (m.method) {
    case 'gep.hello': return { version: '0.1', sessionId: 'ses_script', resumed: false, engine: { id: 'scripted', version: '0.0.1' } }
    case 'engine.describe': return { engine: { id: 'scripted', name: 'scripted', version: '0.0.1', vendor: { id: 'test', name: 'test', kind: 'self', verified: false }, license: 'Apache-2.0', runtime: 'node' }, protocol: { version: '0.1', transports: ['stdio'] }, capabilities: { 'execution.modeA': true, 'market.useHost': true, 'halt.levels': ['halt_new', 'cancel_all', 'flatten_all'] }, venues: [] }
    case 'engine.bind': setTimeout(run, 50); return { bindingId: m.params.bindingId, effective: m.params, warnings: [] }
    case 'events.subscribe': return { subscriptionId: 'sub_s', fromSeq: 0 }
    case 'risk.policy.push': return { acceptedVersions: (m.params.policies || []).map((p) => p.version) }
    case 'engine.halt': return { ack: true, appliedAt: Date.now() }
    case 'engine.resume': return { resumedAt: Date.now() }
    default: return {}
  }
}
const sub = (v) => typeof v === 'string' && v.startsWith('$') ? accounts[v.slice(1)] : Array.isArray(v) ? v.map(sub) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, sub(x)])) : v
async function run() {
  const d = await call('host.describe', {})
  for (const a of d.result.accounts) accounts[a.alias] = a.accountId
  for (const a of actions) {
    const r = await call(a.method, sub(a.params))
    appendFileSync(out, JSON.stringify({ method: a.method, ...r }) + '\\n')
  }
}
process.stdin.setEncoding('utf8')
process.stdin.on('data', (d) => {
  buf += d
  let i
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1)
    if (!line) continue
    const m = JSON.parse(line)
    if (m.method) { if (m.id !== undefined) send({ jsonrpc: '2.0', id: m.id, result: answer(m) }) }
    else if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
  }
})
setInterval(() => {}, 1000)
`

describe('脚本引擎（线上的来源盖章 / 授权书不足转提案 / 实盘路径）', { timeout: 40_000 }, () => {
  let out = ''
  const results = (): { method: string; result?: any; error?: any }[] => (existsSync(out) ? readFileSync(out, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []) // eslint-disable-line @typescript-eslint/no-explicit-any

  async function bootScripted(actions: unknown[]): Promise<void> {
    h = await makeHarness({
      kernel: { gep: { heartbeatMs: 500, callTimeoutMs: 5000 } },
      configure: (cfg) => {
        const dir = join(cfg.accounts.length ? process.env.TEMP ?? '.' : '.', `gep-script-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)
        mkdirSync(dir, { recursive: true })
        out = join(dir, 'out.jsonl')
        writeFileSync(join(dir, 'engine.mjs'), SCRIPT_ENGINE)
        writeFileSync(join(dir, 'actions.json'), JSON.stringify(actions))
        cfg.engines.push({ id: 'core', enabled: true, launch: { command: process.execPath, args: [join(dir, 'engine.mjs')], env: { SCRIPT_OUT: out, SCRIPT_IN: join(dir, 'actions.json') } } })
      },
    })
  }
  const live = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ accountId: '$live', clientOrderId: 'aa'.repeat(16), strategyId: 'scripted-strat', instanceId: 'inst_01TEST',
    intent: { accountId: '$live', instrumentId: BTC, side: 'buy', type: 'market', size: '0.003', leverage: 2, reason: 'scripted entry', ...(over.intent as object ?? {}) },
    origin: { actor: 'agent:ak_FORGED', actorType: 'llm-agent', via: 'mcp', tool: 'strategy:scripted', requestId: 'forged', causation: { instanceId: 'inst_01TEST' } }, ...Object.fromEntries(Object.entries(over).filter(([k]) => k !== 'intent')) })

  it('host.order.amend returns the modified order through a real GEP connection', async () => {
    const cloid = 'ce'.repeat(16)
    await bootScripted([
      { method: 'host.order.place', params: live({ accountId: '$paper', clientOrderId: cloid, intent: { accountId: '$paper', type: 'limit', price: '79000' } }) },
      { method: 'host.order.amend', params: { clientOrderId: cloid, price: '78500', size: '0.002' } },
    ])
    const submit = h.sim.submit.bind(h.sim)
    h.sim.submit = async (ctx, intents) => { const result = await submit(ctx, intents); h.clock.advance(6000); return result }
    h.sim.amend = async (ctx, req) => {
      h.sim.amendCalls.push({ ctx, req })
      const order = h.sim.orders.find((o) => o.clientOrderId === req.clientOrderId)!
      order.price = req.order.price!; order.size = req.order.size!
      return { acks: [{ intentIndex: 0, clientOrderId: cloid, venueOrderId: order.venueOrderId, status: 'open', filledSize: '0' as never, avgFillPrice: null, builder: { attached: false } }], receiptHash: 'ab'.repeat(32), requestWeight: 1 }
    }
    const mdt = await engineMandate('L1', [h.paper.accountId])
    await h.k.gep.bind('core', { accounts: [{ accountId: h.paper.accountId as never, mandateId: mdt }], instruments: [BTC] }, await h.pinProof())
    h.k.engines.start('core')
    await until(() => results().length >= 2, 15_000, 'scripted amend result')
    expect(results()[1]!.error).toBeUndefined()
    expect(results()[1]!.result).toMatchObject({ status: 'open', clientOrderId: cloid, order: { price: '78500', size: '0.002', origin: { actor: 'engine:core' } } })
    const entry = h.k.ledger.query({ types: ['order.amended'], limit: 1 })[0]!
    expect(entry.origin.actor).toBe('engine:core')
    expect((entry.payload as { gate: { decision: { action: string } } }).gate.decision.action).toBe('amend')
  })

  it('实盘：denyLlmLiveEntries 默认开着，但对 engine 来源不生效；引擎自报的 actor / actorType / via 被内核覆盖；订单经 API 钱包签名到场所', async () => {
    await bootScripted([{ method: 'host.order.place', params: live() }])
    await enableLive(h)
    expect(h.k.risk.current()!.denyLlmLiveEntries).toBe(true)
    const mdt = await engineMandate('L3', [h.liveAcct.accountId])
    await h.k.gep.bind('core', { accounts: [{ accountId: h.liveAcct.accountId as never, mandateId: mdt }], instruments: [BTC] }, await h.pinProof())
    h.k.engines.start('core')
    await until(() => results().length >= 1, 15_000, 'scripted order result')
    const r = results()[0]!
    expect(r.error).toBeUndefined()
    expect(r.result.status).toBe('filled')
    const intent = h.k.ledger.query({ types: ['order.intent'], limit: 1 })[0]!
    expect(intent.origin).toMatchObject({ actor: 'engine:core', actorType: 'engine', via: 'gep', tool: 'strategy:scripted' })
    expect(JSON.stringify(intent.origin)).not.toContain('FORGED')
    expect(intent.ruleHits ?? []).toEqual([])
    expect(h.live.submitted.length).toBe(1)
    expect(h.live.signatures.length).toBe(1) // 实盘单经内核签名器签名；引擎全程拿不到密钥
  })

  it('授权书额度不足 → 自动转提案（2009 + 票号）；host.proposal.create 一定进待审；批准仍是人面', async () => {
    await bootScripted([
      { method: 'host.order.place', params: live() },
      { method: 'host.proposal.create', params: { accountId: '$live', intents: [{ accountId: '$live', instrumentId: BTC, side: 'buy', type: 'market', size: '0.003', leverage: 2 }], reason: 'engine wants a human to look', strategyId: 's', instanceId: 'inst_01TEST', origin: { tool: 'node:act.propose' } } },
      { method: 'host.order.place', params: live({ clientOrderId: 'bb'.repeat(16), intent: { size: '0.003', leverage: 9 } }) },
    ])
    await enableLive(h)
    const mdt = await engineMandate('L2', [h.liveAcct.accountId])
    await h.k.gep.bind('core', { accounts: [{ accountId: h.liveAcct.accountId as never, mandateId: mdt }], instruments: [BTC] }, await h.pinProof())
    h.k.engines.start('core')
    await until(() => results().length >= 3, 15_000, 'three scripted results')
    const [place, create, over] = results() as [any, any, any] // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(place.result).toMatchObject({ status: 'denied', problem: { code: 2009, name: 'NEEDS_APPROVAL' } })
    expect(place.result.problem.message).toMatch(/T-\d{8}-0001/)
    expect(create.result).toMatchObject({ status: 'pending', ticket: expect.stringMatching(/^T-\d{8}-0002$/) })
    expect(over.result).toMatchObject({ status: 'denied', problem: { code: 2001 } }) // 杠杆 9 越限
    expect(h.live.submitted.length).toBe(0) // 批准前什么都没到场所
    const props = h.k.trading.listProposals({ status: 'pending' })
    expect(props.length).toBe(2)
    expect(props.every((p) => p.origin.actor === 'engine:core' && p.origin.actorType === 'engine' && p.origin.via === 'gep')).toBe(true)
    const done = await h.k.trading.approve(props[0]!.ticket, h.sessionProof(), h.human('ui:approve'))
    expect(done.status).toBe('executed')
    expect(h.live.submitted.length).toBe(1)
  })

  it('未绑定的账户 / 越权的账户：引擎的 host.* 调用被拒（ACCOUNT_NOT_BOUND），密钥类字段一律 5006', async () => {
    await bootScripted([
      { method: 'host.order.place', params: live({ accountId: '$paper', intent: { accountId: '$paper' } }) },
      { method: 'host.order.place', params: { ...live(), intent: { ...(live().intent as object), privateKey: '0x1234' } } },
    ])
    const mdt = await engineMandate('L1', [h.liveAcct.accountId])
    await h.k.gep.bind('core', { accounts: [{ accountId: h.liveAcct.accountId as never, mandateId: mdt }], instruments: [BTC] }, await h.pinProof())
    h.k.engines.start('core')
    await until(() => results().length >= 2, 15_000, 'two scripted results')
    const [unbound, secret] = results() as [any, any] // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(unbound.error.data.name).toBe('ACCOUNT_NOT_BOUND')
    expect(secret.error.code).toBe(5006)
    expect(JSON.stringify(h.k.ledger.query({ limit: 1000 }))).not.toContain('0x1234')
  })
})

