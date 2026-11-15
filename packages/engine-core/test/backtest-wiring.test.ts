// SPDX-License-Identifier: CPAL-1.0
// 回测作业接线：窗口上限（INVALID_PARAMS + reason）、进度阶段名与单调性、账目自审 warning。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PROBLEM_CODES } from '../src/proto'
import * as ledgerAudit from '../src/strategy/ledger-audit'
import { T0 } from '../../protocol/conformance/host-sim'
import { rig, BTC, type Rig } from './harness'

let r: Rig | null = null
afterEach(() => {
  vi.restoreAllMocks()
  r?.close()
  r = null
})

const baseSpec = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  subject: { strategy: { id: 'ema-trend', version: '0.1.0', params: { fast: 5, slow: 20 } } },
  instruments: [BTC], interval: '1m', from: T0, to: T0 + 2000 * 60_000,
  data: { source: 'host' }, account: { initialBalance: '10000', ccy: 'USDC', leverage: 1 },
  assumptions: { fees: { maker: '0.00015', taker: '0.00045' }, slippageBps: 2, fillModel: 'next-bar-open', funding: false, liquidation: false },
  seed: 42, ...over,
})

const waitState = async (jobId: string, timeout = 15_000): Promise<string> => {
  const end = Date.now() + timeout
  for (;;) {
    const st = await r!.session.call<{ state: string }>('backtest.status', { jobId })
    if (st.state === 'done' || st.state === 'failed' || st.state === 'cancelled') return st.state
    if (Date.now() > end) throw new Error('job timeout')
    await new Promise((res) => setTimeout(res, 20))
  }
}

const runJob = async (spec: Record<string, unknown>): Promise<{ jobId: string; state: string; result: any }> => {
  const { jobId } = await r!.session.call<{ jobId: string }>('backtest.run', { spec })
  const state = await waitState(jobId)
  if (state !== 'done') return { jobId, state, result: null }
  return { jobId, state, result: await r!.session.call('backtest.result', { jobId }) }
}

const progressEvents = (jobId: string): Array<{ progress: number; stage: string; state: string }> =>
  r!.session.events
    .filter((e) => e.type === 'backtest.progress' && e.data.jobId === jobId)
    .map((e) => ({ progress: Number(e.data.progress), stage: String(e.data.stage), state: String(e.data.state) }))

describe('backtest 作业接线：窗口上限', () => {
  it('30000 根 1h 超窗口 → failed，问题码 INVALID_PARAMS，消息带 maxBars 26280', async () => {
    r = await rig()
    await r.session.call('events.subscribe', { streams: ['backtest'] })
    const { jobId } = await r.session.call<{ jobId: string }>('backtest.run', {
      spec: baseSpec({ interval: '1h', from: 0, to: 30_000 * 3_600_000 }),
    })
    expect(await waitState(jobId)).toBe('failed')
    const error = await r.session.expectError('backtest.result', { jobId })
    expect(error.code).toBe(PROBLEM_CODES.INVALID_PARAMS.code)
    expect(error.message).toContain('26280')
    // 失败事件经 setImmediate 异步投递，可能晚于状态轮询一拍
    expect(await r.session.waitFor(() => progressEvents(jobId).some((e) => e.state === 'failed'), 1000)).toBe(true)
  })
})

describe('backtest 作业接线：进度阶段', () => {
  it('stage 去重序列为 loading → signals → simulating → auditing → delivering → done，progress 单调不减且末值 1', async () => {
    r = await rig()
    await r.session.call('events.subscribe', { streams: ['backtest'] })
    const { jobId, state } = await runJob(baseSpec())
    expect(state).toBe('done')
    // 终态事件可能比 status 轮询晚到一拍
    expect(await r.session.waitFor(() => progressEvents(jobId).some((e) => e.state === 'done'), 1000)).toBe(true)
    const events = progressEvents(jobId)
    expect(events.length).toBeGreaterThan(0)
    const stages: string[] = []
    for (const e of events) if (stages[stages.length - 1] !== e.stage) stages.push(e.stage)
    expect(stages).toEqual(['loading', 'signals', 'simulating', 'auditing', 'delivering', 'done'])
    const done = events.filter((e) => e.state === 'done')
    expect(done).toHaveLength(1)
    for (let i = 1; i < events.length; i++) expect(events[i]!.progress).toBeGreaterThanOrEqual(events[i - 1]!.progress)
    expect(events[events.length - 1]!.progress).toBe(1)
    for (const e of events) expect(e.progress).toBeGreaterThanOrEqual(0)
    for (const e of events) expect(e.progress).toBeLessThanOrEqual(1)
  })
})

describe('backtest 作业接线：账目自审', () => {
  it('正常作业的 warnings 不含 ledger audit mismatch', async () => {
    r = await rig()
    const { result } = await runJob(baseSpec())
    expect(result.warnings.some((w: string) => w.includes('ledger audit mismatch'))).toBe(false)
    expect(result.warnings.some((w: string) => w.includes('ledger audit failed'))).toBe(false)
  })

  it('auditTrades 报现金差 5 → warnings 含 ledger audit mismatch；抛错 → 含 ledger audit failed，作业仍 done', async () => {
    r = await rig()
    const real = ledgerAudit.auditTrades
    vi.spyOn(ledgerAudit, 'auditTrades').mockImplementation(((trades: any, opts: any) => {
      const audit = real(trades, opts)
      return { ...audit, cash: { ...audit.cash, mismatch: 5 } }
    }) as typeof real)
    const mismatched = await runJob(baseSpec())
    expect(mismatched.state).toBe('done')
    expect(mismatched.result.warnings.some((w: string) => w.includes('ledger audit mismatch'))).toBe(true)
    expect(mismatched.result.warnings.find((w: string) => w.includes('ledger audit mismatch'))).toContain('cash Δ=5')

    vi.restoreAllMocks()
    vi.spyOn(ledgerAudit, 'auditTrades').mockImplementation((() => { throw new Error('boom') }) as typeof real)
    const failed = await runJob(baseSpec())
    expect(failed.state).toBe('done')
    expect(failed.result.warnings.some((w: string) => w.includes('ledger audit failed: boom'))).toBe(true)
  })
})
