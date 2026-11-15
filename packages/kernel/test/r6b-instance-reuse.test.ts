// SPDX-License-Identifier: CPAL-1.0
// R6 B 包 R2-REL-09：engines start_strategy 带 instanceId = 重启这个实例（同一个 id，needsRestart 和状态警告一并清掉）；
// 正在跑 / 不存在 / strategyId、accountId 对不上都报 INVALID_PARAMS，什么也不启动。不带 instanceId 的行为不变。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkOrigin } from '../src/util/origin'
import { BTC } from './helpers/fake-connector'
import { makeAgent, makeHarness } from './helpers/harness'
import type { Harness, TestAgent } from './helpers/harness'

const PAPER2 = 'acct_PAP20000000000000000000001'
const ENGINE = 'core'
const RID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d'

let h: Harness
let agent: TestAgent
let starts: Array<Record<string, any>> // eslint-disable-line @typescript-eslint/no-explicit-any
let engineRunning: Array<{ instanceId: string; status: string }>

beforeEach(async () => {
  h = await makeHarness({ configure: (cfg) => cfg.accounts.push({ alias: 'paper2', venue: 'hyperliquid', environment: 'testnet', mode: 'paper', accountId: PAPER2, paper: { initialBalance: '10000', ccy: 'USDC' } }) })
  agent = await makeAgent(h, 'paper', { accounts: [h.paper.accountId, PAPER2] as never })
  starts = []
  engineRunning = []
  h.k.gep.callEngine = vi.fn(async (_e: string, method: string, params: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
    if (method === 'strategy.status') return { instances: engineRunning }
    if (method !== 'strategy.start') throw new Error(`unexpected engine call ${method}`)
    starts.push(params)
    const instanceId = params.instanceId ?? 'inst_NEW1'
    h.k.gep.instances.recordStart(ENGINE, params, { instanceId })
    return { instanceId, status: 'running' }
  }) as never
})
afterEach(async () => { await h.cleanup() })

const call = async (params: Record<string, unknown>): Promise<{ data: any }> => // eslint-disable-line @typescript-eslint/no-explicit-any
  (await h.k.ops.call(h.k, 'agent.engines', { principal: agent.principal, params: { requestId: RID, action: 'start_strategy', engineId: ENGINE, strategyId: 'ema-trend', accountId: h.paper.accountId, instruments: [BTC], interval: '1m', params: { fast: 5 }, ...params }, transport: 'http' })) as { data: any } // eslint-disable-line @typescript-eslint/no-explicit-any
const seed = (instanceId: string, accountId: string = h.paper.accountId): void => {
  h.k.gep.instances.recordStart(ENGINE, { strategyId: 'ema-trend', accountId, instruments: [BTC], interval: '1m', params: { fast: 5 }, mandateId: 'mdt_x' }, { instanceId },
    { owner: { kind: 'agent', keyId: agent.keyId, mandateId: agent.mandate.mandateId }, origin: mkOrigin('user:usr_local', 'test', 'ui') })
}

describe('R2-REL-09 start_strategy 带旧 instanceId', () => {
  it('[R6B-SI1] needsRestart 的实例：同一个 id 重新启动，needsRestart 条目和状态警告一并清掉；stopped 的同理；不带 instanceId 照旧新建', async () => {
    seed('inst_N1')
    h.k.gep.instances.markNeedsRestart('inst_N1', 'restore failed: test')
    expect(h.k.gep.restartWarnings().some((w) => w.includes('inst_N1'))).toBe(true)
    expect((h.k.status().warnings as string[]).some((w) => w.includes('inst_N1'))).toBe(true)

    const r = await call({ instanceId: 'inst_N1' })
    expect(r.data.instanceId).toBe('inst_N1')
    expect(starts).toHaveLength(1)
    expect(starts[0]).toMatchObject({ instanceId: 'inst_N1', strategyId: 'ema-trend', accountId: h.paper.accountId })
    expect(h.k.gep.instances.get('inst_N1')!.needsRestart).toBeUndefined()
    expect(h.k.gep.instances.get('inst_N1')!.desired).toBe('running')
    expect(h.k.gep.instances.get('inst_N1')!.owner).toMatchObject({ kind: 'agent', keyId: agent.keyId }) // 归属不变
    expect(h.k.gep.restartWarnings()).toHaveLength(0)
    expect((h.k.status().warnings as string[]).some((w) => w.includes('inst_N1'))).toBe(false)

    seed('inst_S1')
    h.k.gep.instances.recordStop('inst_S1')
    expect((await call({ instanceId: 'inst_S1' })).data.instanceId).toBe('inst_S1')
    expect(h.k.gep.instances.get('inst_S1')!.desired).toBe('running')

    expect((await call({})).data.instanceId).toBe('inst_NEW1') // 不带 instanceId：沿用原来的新建
    expect(starts[2]!.instanceId).toBeUndefined()
  })

  it('[R6B-SI2] 不存在 / 正在跑 / strategyId 或 accountId 对不上：INVALID_PARAMS，一个 strategy.start 都不发', async () => {
    seed('inst_N1')
    h.k.gep.instances.markNeedsRestart('inst_N1', 'restore failed: test')
    const ghost = 'inst_01ZZZZZZZZZZZZZZZZZZZZZZZZ'
    await expect(call({ instanceId: ghost })).rejects.toMatchObject({ problem: { name: 'INVALID_PARAMS', message: expect.stringContaining(`unknown instanceId ${ghost}`) } })

    engineRunning = [{ instanceId: 'inst_N1', status: 'running' }]
    await expect(call({ instanceId: 'inst_N1' })).rejects.toMatchObject({ problem: { name: 'INVALID_PARAMS', message: 'instance inst_N1 is already running' } })
    engineRunning = []

    await expect(call({ instanceId: 'inst_N1', strategyId: 'momentum-roc' })).rejects.toMatchObject({ problem: { name: 'INVALID_PARAMS', message: expect.stringContaining('strategyId') } })
    await expect(call({ instanceId: 'inst_N1', accountId: PAPER2 })).rejects.toMatchObject({ problem: { name: 'INVALID_PARAMS', message: expect.stringContaining('accountId') } })
    await expect(call({ instanceId: 'inst_N1', engineId: 'other-engine' })).rejects.toBeTruthy() // 别的引擎里没有这个实例，不会被当成它的

    expect(starts).toHaveLength(0)
    expect(h.k.gep.instances.get('inst_N1')!.needsRestart).toBeDefined() // 什么都没动
    expect(h.k.gep.instances.get(ghost)).toBeUndefined()
  })

  it('[R6B-SI2] 问不到引擎现场（strategy.status 读失败）不猜、不启动', async () => {
    seed('inst_N1')
    const orig = h.k.gep.callEngine
    h.k.gep.callEngine = vi.fn(async (e: string, method: string, params: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
      if (method === 'strategy.status') return {}
      return orig.call(h.k.gep, e, method, params)
    }) as never
    await expect(call({ instanceId: 'inst_N1' })).rejects.toMatchObject({ problem: { name: 'VENUE_UNAVAILABLE' } })
    expect(starts).toHaveLength(0)
  })
})
