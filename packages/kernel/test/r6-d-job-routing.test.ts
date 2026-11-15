// SPDX-License-Identifier: CPAL-1.0
// R3-14：backtest status / result / cancel 不带 engineId 时，按作业表转给启动这个作业的引擎（不再回误导性的 EXPERIMENT_EVIDENCE_INCOMPLETE）。
import { afterEach, describe, expect, it } from 'vitest'
import { LabService } from '../src/lab'
import type { BacktestSpec } from '../src/proto'
import { BTC } from './helpers/fake-connector'
import { makeHarness } from './helpers/harness'
import type { Harness } from './helpers/harness'

const harnesses: Harness[] = []
afterEach(async () => { await Promise.all(harnesses.splice(0).map((h) => h.cleanup())) })
const spec: BacktestSpec = {
  subject: { strategy: { id: 'sma-cross', version: '1', params: {} } }, instruments: [BTC], interval: '1h', from: 0, to: 10, data: { source: 'engine' },
  account: { initialBalance: '10000' as never, ccy: 'USD', leverage: 1 },
  assumptions: { fees: 'venue', slippageBps: 3, fillModel: 'next-bar-open', funding: false, liquidation: false }, seed: 1,
}

async function setup(jobIds: Record<string, string>) {
  const h = await makeHarness(); harnesses.push(h)
  const calls: Array<{ engine: string; method: string }> = []
  const raw = async (engine: string, method: string, params: any): Promise<any> => { // eslint-disable-line @typescript-eslint/no-explicit-any
    calls.push({ engine, method })
    if (method === 'strategy.list') return { strategies: [] }
    if (method === 'backtest.run') return { jobId: jobIds[engine] }
    if (method === 'backtest.status') return { state: 'running', jobId: params.jobId }
    if (method === 'backtest.cancel') return { state: 'cancelled', jobId: params.jobId }
    throw new Error(`unexpected ${method}`)
  }
  return { lab: new LabService(h.k, raw), calls }
}

describe('作业表路由', () => {
  it('在 python-engine 上启动的作业，不带 engineId（默认引擎是 gitrader-core）也能查状态和取消', async () => {
    const { lab, calls } = await setup({ 'python-engine': 'job-py-1' })
    const started = await lab.forward('python-engine', 'backtest.run', { spec })
    expect(started.jobId).toBe('job-py-1')
    calls.length = 0
    const st = await lab.forward('gitrader-core', 'backtest.status', { jobId: 'job-py-1' })
    expect(st).toMatchObject({ state: 'running', runId: started.runId })
    expect(calls).toEqual([{ engine: 'python-engine', method: 'backtest.status' }])
    expect(await lab.forward('gitrader-core', 'backtest.cancel', { jobId: 'job-py-1' })).toMatchObject({ state: 'cancelled' })
    expect(calls.at(-1)).toEqual({ engine: 'python-engine', method: 'backtest.cancel' })
  })

  it('给了对的引擎就用它；作业号查不到仍是原来的 EXPERIMENT_EVIDENCE_INCOMPLETE', async () => {
    const { lab, calls } = await setup({ 'gitrader-core': 'job-core-1' })
    await lab.forward('gitrader-core', 'backtest.run', { spec })
    calls.length = 0
    await lab.forward('gitrader-core', 'backtest.status', { jobId: 'job-core-1' })
    expect(calls).toEqual([{ engine: 'gitrader-core', method: 'backtest.status' }])
    await expect(lab.forward('gitrader-core', 'backtest.status', { jobId: 'no-such-job' })).rejects.toMatchObject({ problem: { name: 'EXPERIMENT_EVIDENCE_INCOMPLETE' } })
  })

  it('两个引擎恰好有同一个作业号时有歧义：保持调用方给的引擎，不乱转', async () => {
    const { lab, calls } = await setup({ 'engine-a': 'same-id', 'engine-b': 'same-id' })
    await lab.forward('engine-a', 'backtest.run', { spec })
    await lab.forward('engine-b', 'backtest.run', { spec })
    calls.length = 0
    await expect(lab.forward('gitrader-core', 'backtest.status', { jobId: 'same-id' })).rejects.toMatchObject({ problem: { name: 'EXPERIMENT_EVIDENCE_INCOMPLETE' } })
    expect(calls).toEqual([])
  })
})
