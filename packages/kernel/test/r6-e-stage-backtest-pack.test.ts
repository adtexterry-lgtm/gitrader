// SPDX-License-Identifier: CPAL-1.0
// R3-08：Agent（MCP）把实验推进到 backtest 要先有 backtest 证据包；人在工作台里推进不受影响；live_small 规则不变（只许收紧）。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeAgent, makeHarness } from './helpers/harness'
import type { Harness } from './helpers/harness'
import { LabService } from '../src/lab'
import type { ActorCtx } from '../src/trading'

const harnesses: Harness[] = []
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(harnesses.splice(0).map((h) => h.cleanup())) })

const ENGINE = 'lab-fixture'
const STRATEGY = `sha256:${'a'.repeat(64)}`
const assumptions = { fees: 'venue' as const, slippageBps: 3, fillModel: 'next-bar-open' as const, funding: false, liquidation: false }

async function setup() {
  const h = await makeHarness()
  harnesses.push(h)
  const raw = async (_engine: string, method: string): Promise<unknown> => {
    if (method === 'strategy.list') return { strategies: [{ id: 'strategy-fixture', version: '1', sha256: STRATEGY }] }
    throw new Error(`unexpected engine call ${method}`)
  }
  const lab = new LabService(h.k, raw as never)
  Object.defineProperty(h.k, 'lab', { configurable: true, value: lab })
  vi.spyOn(h.k.gep, 'status').mockReturnValue([{ engineId: ENGINE, state: 'ready', sessionId: 'fixture-session', bound: false, accounts: [], lost: false, placeCalls: 0, proposalCalls: 0 }])
  vi.spyOn(h.k.gep, 'callEngine').mockImplementation((id, method) => raw(id, method) as never)
  const agent = await makeAgent(h, 'paper')
  const create = (actor: ActorCtx) => lab.handle('create', {
    patch: { title: 'EMA', hypothesis: 'Observed input changes the measured outcome', subject: { strategy: { kind: 'strategy', id: 'strategy-fixture', version: '1' }, params: {} }, assumptions },
    engineId: ENGINE,
  }, actor) as Promise<{ experimentId: string; stage: string }>
  const stageEntries = (): number => Array.from(h.k.ledger.iterate()).filter((e) => e.type === 'experiment.stage_changed').length
  return { h, lab, agent, create, stageEntries }
}

describe('R3-08 Agent 推到 backtest 要证据包', () => {
  it('Agent（mcp）没有 backtest 证据包：EXPERIMENT_EVIDENCE_INCOMPLETE，阶段不变，不记阶段变更', async () => {
    const { lab, agent, create, stageEntries } = await setup()
    const actor = agent.ctx('experiment')
    const exp = await create(actor)
    await expect(lab.stage(exp.experimentId, 'backtest', actor)).rejects.toMatchObject({ problem: { name: 'EXPERIMENT_EVIDENCE_INCOMPLETE' } })
    expect(lab.load(exp.experimentId).stage).toBe('hypothesis')
    expect(stageEntries()).toBe(0)
  })

  it('经 handle("stage")（experiment 工具的入口）同样被拦', async () => {
    const { lab, agent, create } = await setup()
    const actor = agent.ctx('experiment')
    const exp = await create(actor)
    await expect(lab.handle('stage', { experimentId: exp.experimentId, to: 'backtest' }, actor)).rejects.toMatchObject({ problem: { name: 'EXPERIMENT_EVIDENCE_INCOMPLETE' } })
    expect(lab.load(exp.experimentId).stage).toBe('hypothesis')
  })

  it('只有 forward 之类的包不算：必须是 backtest 证据包', async () => {
    const { lab, agent, create } = await setup()
    const actor = agent.ctx('experiment')
    const exp = await create(actor)
    vi.spyOn(lab.runTable, 'packs').mockReturnValue([{ kind: 'forward' } as never])
    await expect(lab.stage(exp.experimentId, 'backtest', actor)).rejects.toMatchObject({ problem: { name: 'EXPERIMENT_EVIDENCE_INCOMPLETE' } })
  })

  it('有 backtest 证据包时 Agent 照常推进', async () => {
    const { lab, agent, create, stageEntries } = await setup()
    const actor = agent.ctx('experiment')
    const exp = await create(actor)
    vi.spyOn(lab.runTable, 'packs').mockReturnValue([{ kind: 'backtest' } as never])
    const next = await lab.stage(exp.experimentId, 'backtest', actor)
    expect(next.stage).toBe('backtest')
    expect(lab.load(exp.experimentId).stage).toBe('backtest')
    expect(stageEntries()).toBe(1)
  })

  it('人在工作台里（via=ui）推进不受这条影响', async () => {
    const { h, lab, create } = await setup()
    const actor = h.human('experiment')
    const exp = await create(actor)
    const next = await lab.stage(exp.experimentId, 'backtest', actor)
    expect(next.stage).toBe('backtest')
  })

  it('Agent 推 live_small 仍是 EXPERIMENT_TRANSITION_DENIED（人在工作台审），阶段不变', async () => {
    const { lab, agent, create } = await setup()
    const actor = agent.ctx('experiment')
    const exp = await create(actor)
    await expect(lab.stage(exp.experimentId, 'live_small', actor)).rejects.toMatchObject({ problem: { name: 'EXPERIMENT_TRANSITION_DENIED', message: expect.stringMatching(/human review in the workbench/) } })
    expect(lab.load(exp.experimentId).stage).toBe('hypothesis')
  })
})
