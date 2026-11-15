// SPDX-License-Identifier: CPAL-1.0
// GQ-22：引擎握手后恢复策略实例。纸面账户自动恢复；实盘 / 影子 / 交易受限 / 现场状态不明只标记 needsRestart，绝不 start、不下单、不撤单。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { restoreInstances } from '../src/instance-restore'
import { runAs } from '../src/strategy-instances'
import type { InstanceOwner } from '../src/strategy-instances'
import { mkOrigin } from '../src/util/origin'
import { makeHarness } from './helpers/harness'
import type { Harness } from './helpers/harness'
import { BTC, LIVE_ADDR } from './helpers/fake-connector'

let h: Harness | undefined
let fixtureDir: string | undefined

const HUMAN: InstanceOwner = { kind: 'human', actor: 'user:usr_local' }
const GONE = 'acct_GONE0000000000000000000001'
const SHADOW = 'acct_SHAD0000000000000000000001'
const ENGINE = 'core'

afterEach(async () => {
  await h?.cleanup()
  h = undefined
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true })
  fixtureDir = undefined
})

const until = async (f: () => boolean, ms = 6000): Promise<void> => {
  for (let i = 0; i < ms / 20 && !f(); i++) await new Promise((r) => setTimeout(r, 20))
  expect(f()).toBe(true)
}
const restoreEntries = (): Array<{ payload: Record<string, unknown> }> =>
  h!.k.ledger.query({ types: ['engine.event'] }).filter((e) => (e.payload as { action?: unknown } | undefined)?.action === 'strategy.restore') as never

// ---------------------------------------------------------------------------------------------
// 一、单元：真内核（真账户表 / 真登记表 / 真账本 / 真交易状态），引擎连接与 callEngine 用替身
// ---------------------------------------------------------------------------------------------
async function unit(accountIds?: string[]) {
  h = await makeHarness({
    configure: (cfg) => cfg.accounts.push({ alias: 'shadow', venue: 'hyperliquid', environment: 'testnet', mode: 'shadow', accountId: SHADOW, owner: { address: LIVE_ADDR } }),
  })
  const bound = accountIds ?? [h.paper.accountId, h.liveAcct.accountId, SHADOW, GONE]
  vi.spyOn(h.k.gep, 'bindingOf').mockReturnValue({ accounts: bound.map((accountId) => ({ accountId, mandateId: 'mdt_x' })), instruments: [BTC] } as never)
  const starts: Array<Record<string, any>> = []
  h.k.gep.callEngine = vi.fn(async (_e: string, method: string, params: any) => {
    if (method === 'strategy.start') { starts.push(params); return { instanceId: params.instanceId } }
    throw new Error(`unexpected engine call ${method}`)
  }) as never
  const seed = (instanceId: string, accountId: string, params: Record<string, unknown> = { fast: 5 }): string => {
    h!.k.gep.instances.recordStart(ENGINE, { strategyId: 'ema-trend', accountId, instruments: [BTC], interval: '1m', params, mandateId: 'mdt_x' }, { instanceId },
      { owner: HUMAN, origin: mkOrigin('user:usr_local', 'test', 'ui') })
    return instanceId
  }
  const conn = (status: () => unknown = () => ({ instances: [] })) => ({ rpc: { call: vi.fn(async (method: string) => { if (method === 'strategy.status') return status(); throw new Error(`unexpected rpc ${method}`) }) } })
  const run = (c = conn()) => restoreInstances(h!.k.gep, c, ENGINE)
  const row = (id: string) => h!.k.gep.instances.get(id)!
  return { starts, seed, conn, run, row }
}

describe('GQ-22 握手后恢复：单元', () => {
  it('(1) 纸面行恢复：带原 instanceId 与 params 重新 start，登记表里的 owner 不变，needsRestart 清除', async () => {
    const t = await unit()
    // 让 callEngine 替身像真的一样走登记表（recordStart 保留 prev.owner）
    h!.k.gep.callEngine = vi.fn(async (_e: string, _m: string, params: any) => {
      t.starts.push(params)
      h!.k.gep.instances.recordStart(ENGINE, params, { instanceId: params.instanceId }, undefined)
      return { instanceId: params.instanceId }
    }) as never
    t.seed('inst_P1', h!.paper.accountId, { fast: 5, slow: 20 })
    await t.run()
    expect(t.starts).toHaveLength(1)
    expect(t.starts[0]).toMatchObject({ instanceId: 'inst_P1', strategyId: 'ema-trend', accountId: h!.paper.accountId, instruments: [BTC], interval: '1m', params: { fast: 5, slow: 20 } })
    expect(t.row('inst_P1').owner).toEqual(HUMAN)
    expect(t.row('inst_P1').params).toEqual({ fast: 5, slow: 20 })
    expect(t.row('inst_P1').needsRestart).toBeUndefined()
    expect(t.row('inst_P1').desired).toBe('running')
  })

  it('(1b) 引擎里已经在跑的实例不重复 start', async () => {
    const t = await unit()
    t.seed('inst_P1', h!.paper.accountId)
    await t.run(t.conn(() => ({ instances: [{ instanceId: 'inst_P1', status: 'running' }] })))
    expect(t.starts).toHaveLength(0)
  })

  it('(2) 实盘 / 影子行不 start，needsRestart 同时出现在 status().engines[]、gep.status() 与 warnings', async () => {
    const t = await unit()
    t.seed('inst_L1', h!.liveAcct.accountId); t.seed('inst_S1', SHADOW)
    await t.run()
    expect(t.starts).toHaveLength(0)
    expect(t.row('inst_L1').needsRestart?.reason).toMatch(/实盘账户的策略不自动恢复/)
    expect(t.row('inst_S1').needsRestart?.reason).toMatch(/shadow/)
    const w = h!.k.status().warnings as string[]
    expect(w.some((x) => x.includes('inst_L1') && x.includes('实盘账户的策略不自动恢复'))).toBe(true)
    expect(w.some((x) => x.includes('inst_S1'))).toBe(true)
    expect(h!.k.gep.restartWarnings()).toHaveLength(2)
  })

  it('(3) 已删账户行跳过并标记，后续纸面行照常恢复', async () => {
    const t = await unit()
    t.seed('inst_A_gone', GONE); t.seed('inst_B_paper', h!.paper.accountId)
    await t.run()
    expect(t.row('inst_A_gone').needsRestart?.reason).toMatch(/not found/)
    expect(t.starts.map((s) => s.instanceId)).toEqual(['inst_B_paper'])
    expect(t.row('inst_B_paper').needsRestart).toBeUndefined()
  })

  it('(4) strategy.status 读失败或回得不成样子：全部 needsRestart，零 start，账本零新增', async () => {
    const t = await unit()
    t.seed('inst_P1', h!.paper.accountId); t.seed('inst_P2', h!.paper.accountId); t.seed('inst_L1', h!.liveAcct.accountId)
    const before = h!.k.ledger.query({}).length
    await t.run(t.conn(() => { throw new Error('boom') }))
    await t.run(t.conn(() => ({})))
    await t.run(t.conn(() => null))
    expect(t.starts).toHaveLength(0)
    for (const id of ['inst_P1', 'inst_P2', 'inst_L1']) expect(t.row(id).needsRestart?.reason).toMatch(/did not answer strategy.status/)
    expect(h!.k.ledger.query({}).length).toBe(before)
  })

  it('(5) 10 分钟内第 3 次仍试、第 4 次不试；过了窗口重新计数', async () => {
    const t = await unit()
    t.seed('inst_P1', h!.paper.accountId)
    for (let i = 1; i <= 3; i++) { await t.run(); expect(t.starts).toHaveLength(i) }
    expect(t.row('inst_P1').needsRestart).toBeUndefined()
    await t.run()
    expect(t.starts).toHaveLength(3)
    expect(t.row('inst_P1').needsRestart?.reason).toMatch(/3 times in the last 10 minutes/)
    h!.clock.advance(601_000)
    await t.run()
    expect(t.starts).toHaveLength(4)
    expect(t.row('inst_P1').needsRestart).toBeUndefined()
  })

  it('(6) 每次恢复账本恰好新增一条 engine.event strategy.restore；失败的不记', async () => {
    const t = await unit()
    t.seed('inst_P1', h!.paper.accountId); t.seed('inst_P2', h!.paper.accountId); t.seed('inst_L1', h!.liveAcct.accountId); t.seed('inst_G1', GONE)
    expect(restoreEntries()).toHaveLength(0)
    await t.run()
    const got = restoreEntries()
    expect(got).toHaveLength(2)
    expect(got.map((e) => e.payload.instanceId).sort()).toEqual(['inst_P1', 'inst_P2'])
    expect(got[0]!.payload).toMatchObject({ action: 'strategy.restore', strategyId: 'ema-trend', accountId: h!.paper.accountId })
    expect(h!.k.ledger.verify().ok).toBe(true)
  })

  it('HALTED 的提示文案写 HALTED，不写 REDUCING，且不 start', async () => {
    const t = await unit()
    t.seed('inst_P1', h!.paper.accountId)
    h!.k.tstate.set({ type: 'account', id: h!.paper.accountId }, 'HALTED', 'test hold', h!.human().origin)
    await t.run()
    expect(t.starts).toHaveLength(0)
    expect(t.row('inst_P1').needsRestart?.reason).toMatch(/HALTED/)
    expect(t.row('inst_P1').needsRestart?.reason).not.toMatch(/REDUCING/)
  })

  it('引擎绑定里没有该账户：只标记不 start', async () => {
    const t = await unit([])
    t.seed('inst_P1', h!.paper.accountId)
    await t.run()
    expect(t.starts).toHaveLength(0)
    expect(t.row('inst_P1').needsRestart?.reason).toMatch(/not bound/)
  })

  it('strategy.start 被引擎拒绝：标记 restore failed，后面的行照常处理', async () => {
    const t = await unit()
    t.seed('inst_A', h!.paper.accountId); t.seed('inst_B', h!.paper.accountId)
    h!.k.gep.callEngine = vi.fn(async (_e: string, _m: string, params: any) => {
      if (params.instanceId === 'inst_A') throw new Error('engine says no')
      t.starts.push(params); return { instanceId: params.instanceId }
    }) as never
    await t.run()
    expect(t.row('inst_A').needsRestart?.reason).toMatch(/restore failed: engine says no/)
    expect(t.starts.map((s) => s.instanceId)).toEqual(['inst_B'])
    expect(restoreEntries().map((e) => e.payload.instanceId)).toEqual(['inst_B'])
  })
})

// ---------------------------------------------------------------------------------------------
// 二、端到端：真子进程引擎（内存里记实例，进程重启即丢）+ 真握手
// ---------------------------------------------------------------------------------------------
const fixture = `
import readline from 'node:readline'
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n')
const inst = new Map()
let beat
for await (const line of readline.createInterface({ input: process.stdin })) {
  let req
  try { req = JSON.parse(line) } catch { continue }
  if (req.id === undefined) continue
  const p = req.params ?? {}
  switch (req.method) {
    case 'gep.hello': send(req.id, { version: '0.1.0', sessionId: 'rs_' + process.pid }); break
    case 'engine.describe': send(req.id, { engine: { id: 'fixture', name: 'GQ-22 fixture', version: '1', vendor: { id: 'test', name: 'test', kind: 'community', verified: false }, license: 'Apache-2.0', runtime: 'node' }, protocol: { version: '0.1.0', transports: ['stdio'] }, capabilities: { 'execution.modeA': true }, venues: [] }); break
    case 'events.subscribe':
      send(req.id, { subscriptions: [] })
      if (!beat) beat = setInterval(() => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'gep.heartbeat', params: { ts: Date.now() } }) + '\\n'), 10)
      break
    case 'engine.bind': send(req.id, { bindingId: 'bind_rs', warnings: [] }); break
    case 'strategy.start': inst.set(p.instanceId, { instanceId: p.instanceId, strategyId: p.strategyId, accountId: p.accountId, instruments: p.instruments, status: 'running' }); send(req.id, { instanceId: p.instanceId, status: 'running' }); break
    case 'strategy.status': send(req.id, { instances: [...inst.values()] }); break
    case 'strategy.stop': inst.delete(p.instanceId); send(req.id, { status: 'stopped' }); break
    default: send(req.id, {})
  }
}
`

describe('GQ-22 握手后恢复：端到端（真引擎进程重启）', () => {
  it('引擎进程重启丢了实例：纸面实例自动回来（owner / params 不变、账本一条），实盘实例不 start 且在 status 与 warnings 里提示', async () => {
    fixtureDir = mkdtempSync(join(tmpdir(), 'gitrader-gq22-'))
    const script = join(fixtureDir, 'engine.mjs')
    writeFileSync(script, fixture, 'utf8')
    h = await makeHarness({ configure: (cfg) => cfg.engines.push({ id: 'fixture', enabled: true, launch: { command: process.execPath, args: [script] } }) })
    h.k.engines.start('fixture')
    await until(() => h!.k.gep.isReady('fixture'))

    const pin = await h.pinProof()
    const mandate = (level: 'L1' | 'L3', accountId: string): string => h!.k.agents.issueMandate({
      subject: { type: 'engine', id: 'fixture' }, level, accounts: [accountId],
      ...(level === 'L3' ? { venueAllowlist: ['hyperliquid'], instrumentAllowlist: [BTC], limits: { maxOrderNotional: '1000', maxDailyNotional: '5000', maxDailyLoss: '100', autoMaxOrderNotional: '300' } } : {}),
    } as never, pin, h!.human('mandate.issue').origin).mandateId
    const paperM = mandate('L1', h.paper.accountId)
    const liveM = mandate('L3', h.liveAcct.accountId)
    await h.k.gep.bind('fixture', { accounts: [{ accountId: h.paper.accountId as never, mandateId: paperM }, { accountId: h.liveAcct.accountId as never, mandateId: liveM }], instruments: [BTC] }, pin)

    // 人在纸面账户上启动一个实例（真走 callEngine → 登记表）；实盘行直接写登记表（实盘不能经 callEngine 启动）
    await runAs({ owner: HUMAN, origin: mkOrigin('user:usr_local', 'test', 'ui') }, () =>
      h!.k.gep.callEngine('fixture', 'strategy.start', { instanceId: 'inst_P1', strategyId: 'ema-trend', accountId: h!.paper.accountId, instruments: [BTC], interval: '1m', params: { fast: 7 }, mandateId: paperM }))
    h.k.gep.instances.recordStart('fixture', { strategyId: 'ema-trend', accountId: h.liveAcct.accountId, instruments: [BTC], params: {}, mandateId: liveM }, { instanceId: 'inst_L1' }, { owner: HUMAN, origin: mkOrigin('user:usr_local', 'test', 'ui') })
    expect((await h.k.gep.callEngine('fixture', 'strategy.status', {}) as { instances: unknown[] }).instances).toHaveLength(1)

    // 引擎进程重启：内存里的实例全丢，内核重新握手
    await h.k.engines.stop('fixture')
    await until(() => !h!.k.gep.isReady('fixture'))
    h.k.engines.start('fixture')
    await until(() => h!.k.gep.isReady('fixture'))
    await until(() => restoreEntries().length === 1)
    await until(() => h!.k.gep.instances.get('inst_L1')?.needsRestart !== undefined)

    const st = (await h.k.gep.callEngine('fixture', 'strategy.status', {}) as { instances: Array<{ instanceId: string }> }).instances
    expect(st.map((i) => i.instanceId)).toEqual(['inst_P1'])                       // 纸面回来了，实盘没有被 start
    const p1 = h.k.gep.instances.get('inst_P1')!
    expect(p1.owner).toEqual(HUMAN)
    expect(p1.params).toEqual({ fast: 7 })
    expect(p1.needsRestart).toBeUndefined()
    expect(restoreEntries()[0]!.payload).toMatchObject({ action: 'strategy.restore', instanceId: 'inst_P1', accountId: h.paper.accountId })

    const status = h.k.status() as { engines: Array<{ id: string; needsRestart?: Array<{ instanceId: string; reason: string }> }>; warnings: string[] }
    const eng = status.engines.find((e) => e.id === 'fixture')!
    expect(eng.needsRestart).toEqual([expect.objectContaining({ instanceId: 'inst_L1', strategyId: 'ema-trend', accountId: h.liveAcct.accountId, reason: expect.stringMatching(/实盘账户的策略不自动恢复/) })])
    expect(status.warnings.some((w) => w.includes('inst_L1'))).toBe(true)
    expect(status.warnings.some((w) => w.includes('inst_P1'))).toBe(false)
    expect(h.k.ledger.verify().ok).toBe(true)
  })
})
