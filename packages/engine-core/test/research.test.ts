// SPDX-License-Identifier: CPAL-1.0
// 研究作业表（第六轮 C 包）：x-gitrader.research.* 的校验、异步三步、摘要字节上限、分页、取消与失败。
// 计算由假 provider 代替（真实的寻优 / 因子计算在 packages/cli/test/research-*.test.ts 里测）。
import { afterEach, describe, expect, it } from 'vitest'
import { RESEARCH_CAPABILITY } from '../src/proto'
import type { OptimizeComputeInput, ResearchComputeHandle, ResearchComputeInput, ResearchOutcome, ResearchProvider } from '../src/runtime/research'
import { T0 } from '../../protocol/conformance/host-sim'
import { BTC, rig, type Rig } from './harness'

let r: Rig | null = null
afterEach(() => { r?.close(); r = null })

const spec = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  subject: { strategy: { id: 'ema-trend', version: '0.1.0', params: {} } },
  instruments: [BTC], interval: '1m', from: T0, to: T0 + 400 * 60_000, data: { source: 'host' }, account: { initialBalance: '10000', ccy: 'USDC', leverage: 1 },
  assumptions: { fees: { maker: '0.00015', taker: '0.00045' }, slippageBps: 2, fillModel: 'next-bar-open', funding: false, liquidation: false },
  seed: 42, space: { fast: { type: 'integer', min: 5, max: 15, step: 5 } }, search: { kind: 'grid' }, validation: { kind: 'holdout', holdoutBars: 100 }, ...over,
})

/** 假 provider：compute 返回一个由测试手动放行的 Promise；记下收到的输入。 */
function fake(): ResearchProvider & { inputs: ResearchComputeInput[]; release(o?: Partial<ResearchOutcome>): void; fail(e: Error): void; cancelled: number } {
  let resolve: (o: ResearchOutcome) => void = () => undefined
  let reject: (e: Error) => void = () => undefined
  const p = {
    inputs: [] as ResearchComputeInput[], cancelled: 0,
    release: (o: Partial<ResearchOutcome> = {}) => resolve({ summary: { searchKind: 'grid', warnings: ['from provider'] }, parts: { trials: [{ i: 1 }, { i: 2 }, { i: 3 }] }, ...o }),
    fail: (e: Error) => reject(e),
    checkOptimize: (plan: { space: unknown }) => ('nope' in (plan.space as object) ? { error: 'space has parameter(s) the strategy does not declare: nope' } : { total: 4 }),
    compute(input: ResearchComputeInput, hooks: { progress(d: number, t?: number): void }): ResearchComputeHandle {
      p.inputs.push(input)
      hooks.progress(2, 8)
      return { done: new Promise<ResearchOutcome>((res, rej) => { resolve = res; reject = rej }), cancel: () => { p.cancelled++; reject(new Error('cancelled')) } }
    },
  }
  return p
}

const call = async <T = any>(method: string, params: Record<string, unknown>): Promise<T> => { // eslint-disable-line @typescript-eslint/no-explicit-any
  const o = await r!.session.request(method, params)
  if (!o.ok) throw Object.assign(new Error(`${method}: ${o.error.message}`), { problem: o.error.data ?? { code: o.error.code, message: o.error.message } })
  return o.result as T
}
const until = async (jobId: string, want: string): Promise<any> => { // eslint-disable-line @typescript-eslint/no-explicit-any
  for (let i = 0; i < 200; i++) { const s = await call('x-gitrader.research.status', { jobId }); if (s.state === want) return s; await new Promise((res) => setTimeout(res, 10)) }
  throw new Error(`job never reached ${want}`)
}
const err = async (p: Promise<unknown>): Promise<any> => p.then(() => { throw new Error('expected an error') }, (e) => e) // eslint-disable-line @typescript-eslint/no-explicit-any

describe('能力声明', () => {
  it('注入 provider 才声明 x-gitrader.research；没注入时方法回 5002', async () => {
    r = await rig({ research: fake() })
    const d = await call('engine.describe', {})
    expect(d.capabilities[RESEARCH_CAPABILITY]).toBe(true)
    r.close()
    r = await rig()
    expect((await call('engine.describe', {})).capabilities[RESEARCH_CAPABILITY]).toBeUndefined()
    expect((await err(call('x-gitrader.research.run', { kind: 'optimize', spec: spec() }))).problem.code).toBe(5002)
  })
})

describe('起作业之前的同步校验：INVALID_PARAMS，不建作业', () => {
  const cases: [string, string, Record<string, unknown>][] = [
    ['缺 validation', 'optimize', (() => { const s = spec(); delete s.validation; return s })()],
    ['walk_forward 给 holdout 计划', 'walk_forward', spec()],
    ['space 里有策略没声明的参数（provider 查出）', 'optimize', spec({ space: { nope: { type: 'integer', min: 1, max: 3 } } })],
    ['缺 space', 'optimize', (() => { const s = spec(); delete s.space; return s })()],
    ['seed 不是整数', 'optimize', spec({ seed: 1.5 })],
    ['不是策略（工作流）', 'optimize', spec({ subject: { workflow: { id: 'x', version: 1 } } })],
    ['未知策略', 'optimize', spec({ subject: { strategy: { id: 'no-such', version: '1', params: {} } } })],
  ]
  for (const [name, kind, s] of cases) {
    it(name, async () => {
      const p = fake()
      r = await rig({ research: p })
      const e = await err(call('x-gitrader.research.run', { kind, spec: s }))
      expect(e.problem.code).toBe(-32602)
      expect(p.inputs).toHaveLength(0)
    })
  }
  it('kind 不认识 / spec 不是对象', async () => {
    r = await rig({ research: fake() })
    expect((await err(call('x-gitrader.research.run', { kind: 'hyperopt', spec: spec() }))).problem.code).toBe(-32602)
    expect((await err(call('x-gitrader.research.run', { kind: 'optimize', spec: 'x' }))).problem.code).toBe(-32602)
  })
  it('walk_forward + walk-forward 计划被接受', async () => {
    r = await rig({ research: fake() })
    const j = await call('x-gitrader.research.run', { kind: 'walk_forward', spec: spec({ validation: { kind: 'walk-forward', trainBars: 100, testBars: 50 } }) })
    expect(j).toMatchObject({ kind: 'walk_forward' })
    expect(typeof j.jobId).toBe('string')
  })
})

describe('异步三步 + 摘要 + 分页', () => {
  it('未完成 BUSY；完成后摘要带 counts、jobId、上下文；status 带 progress', async () => {
    const p = fake()
    r = await rig({ research: p })
    const j = await call('x-gitrader.research.run', { kind: 'optimize', spec: spec() })
    await until(j.jobId, 'running')
    expect((await err(call('x-gitrader.research.result', { jobId: j.jobId }))).problem.code).toBe(4004)
    await new Promise((res) => setTimeout(res, 30))
    const st = await call('x-gitrader.research.status', { jobId: j.jobId })
    expect(st).toMatchObject({ jobId: j.jobId, kind: 'optimize', state: 'running', progress: { done: 2, total: 8 } })
    const input = p.inputs[0] as OptimizeComputeInput
    expect(input.sim).toMatchObject({ initialCash: 10000, leverage: 1, feeRate: 0.00045, slippageBps: 2 })
    expect(input.seed).toBe(42)
    expect(input.candles.length).toBeGreaterThan(100)
    p.release()
    await until(j.jobId, 'done')
    const sum = await call('x-gitrader.research.result', { jobId: j.jobId })
    expect(sum).toMatchObject({ jobId: j.jobId, kind: 'optimize', searchKind: 'grid', counts: { trials: 3 }, hypothetical: true, strategy: { id: 'ema-trend' }, instrumentId: BTC, interval: '1m' })
    expect(sum.warnings).toContain('from provider')
    expect('trials' in sum).toBe(false)
    expect(Buffer.byteLength(JSON.stringify(sum))).toBeLessThan(8000)
    expect((await call('x-gitrader.research.status', { jobId: j.jobId })).progress).toEqual({ done: 8, total: 8 })
  })

  it('分页：total 必给，最后一页没有 next，同 cursor 同页，part 不存在 / 越界游标 INVALID_PARAMS', async () => {
    const p = fake()
    r = await rig({ research: p })
    const j = await call('x-gitrader.research.run', { kind: 'optimize', spec: spec() })
    await until(j.jobId, 'running')
    p.release({ parts: { trials: Array.from({ length: 9 }, (_, i) => ({ i })) } })
    await until(j.jobId, 'done')
    const first = await call('x-gitrader.research.result', { jobId: j.jobId, part: 'trials', limit: 4 })
    expect(first).toMatchObject({ total: 9, next: '4' })
    expect(first.items).toHaveLength(4)
    const again = await call('x-gitrader.research.result', { jobId: j.jobId, part: 'trials', limit: 4, cursor: first.next })
    expect(again.items.map((x: any) => x.i)).toEqual([4, 5, 6, 7]) // eslint-disable-line @typescript-eslint/no-explicit-any
    expect((await call('x-gitrader.research.result', { jobId: j.jobId, part: 'trials', limit: 4, cursor: first.next })).items).toEqual(again.items)
    const last = await call('x-gitrader.research.result', { jobId: j.jobId, part: 'trials', limit: 4, cursor: again.next })
    expect(last).toEqual({ items: [{ i: 8 }], total: 9 })
    expect((await err(call('x-gitrader.research.result', { jobId: j.jobId, part: 'folds' }))).problem.code).toBe(-32602)
    expect((await err(call('x-gitrader.research.result', { jobId: j.jobId, part: 'trials', cursor: '99' }))).problem.code).toBe(-32602)
    expect((await err(call('x-gitrader.research.result', { jobId: j.jobId, part: 'trials', limit: 0 }))).problem.code).toBe(-32602)
    expect((await err(call('x-gitrader.research.result', { jobId: 'rsh_nope' }))).problem.code).toBe(-32602)
  })

  it('一页按序列化长度装：大条目少给几条并带 next，不截断', async () => {
    const p = fake()
    r = await rig({ research: p })
    const j = await call('x-gitrader.research.run', { kind: 'optimize', spec: spec() })
    await until(j.jobId, 'running')
    const big = Array.from({ length: 30 }, (_, i) => ({ i, pad: 'x'.repeat(5000) }))
    p.release({ parts: { trials: big } })
    await until(j.jobId, 'done')
    const page = await call('x-gitrader.research.result', { jobId: j.jobId, part: 'trials', limit: 1000 })
    expect(page.items.length).toBeLessThan(30)
    expect(JSON.stringify(page).length).toBeLessThan(60_000)
    expect(page.next).toBe(String(page.items.length))
    expect(page.items.every((x: any) => x.pad.length === 5000)).toBe(true) // eslint-disable-line @typescript-eslint/no-explicit-any
  })

  it('摘要超过 8000 字节：先压缩 warnings，压不下来就如实失败', async () => {
    const p = fake()
    r = await rig({ research: p })
    const a = await call('x-gitrader.research.run', { kind: 'optimize', spec: spec() })
    await until(a.jobId, 'running')
    p.release({ summary: { warnings: Array.from({ length: 80 }, (_, i) => `w${i} ${'y'.repeat(300)}`) } })
    await until(a.jobId, 'done')
    const sum = await call('x-gitrader.research.result', { jobId: a.jobId })
    expect(Buffer.byteLength(JSON.stringify(sum))).toBeLessThan(8000)
    expect(sum.warnings.length).toBeLessThanOrEqual(5)
    const b = await call('x-gitrader.research.run', { kind: 'optimize', spec: spec() })
    await until(b.jobId, 'running')
    p.release({ summary: { blob: 'z'.repeat(9000) } })
    await until(b.jobId, 'done')
    expect((await err(call('x-gitrader.research.result', { jobId: b.jobId }))).problem.code).toBe(4003)
  })
})

describe('取消与失败', () => {
  it('cancel：立刻 cancelled，计算被停掉，result 回错误', async () => {
    const p = fake()
    r = await rig({ research: p })
    const j = await call('x-gitrader.research.run', { kind: 'optimize', spec: spec() })
    await until(j.jobId, 'running')
    await new Promise((res) => setTimeout(res, 30))
    expect(await call('x-gitrader.research.cancel', { jobId: j.jobId })).toMatchObject({ state: 'cancelled' })
    expect(p.cancelled).toBe(1)
    expect((await call('x-gitrader.research.status', { jobId: j.jobId })).state).toBe('cancelled')
    expect((await err(call('x-gitrader.research.result', { jobId: j.jobId }))).problem.message).toMatch(/cancelled/)
  })
  it('provider 抛错 → failed，result 回作业的错误', async () => {
    const p = fake()
    r = await rig({ research: p })
    const j = await call('x-gitrader.research.run', { kind: 'optimize', spec: spec() })
    await until(j.jobId, 'running')
    await new Promise((res) => setTimeout(res, 30))
    p.fail(new Error('boom in optimizer'))
    await until(j.jobId, 'failed')
    const e = await err(call('x-gitrader.research.result', { jobId: j.jobId }))
    expect(e.problem.code).toBe(4003)
    expect(e.problem.message).toContain('boom in optimizer')
  })
})

describe('factor_report 的规格校验', () => {
  const fspec = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ instruments: [BTC], interval: '1m', from: T0, to: T0 + 400 * 60_000, data: { source: 'host' }, horizon: 5, window: 40, ...over })
  it('合法规格起作业，provider 收到 horizon / window；非法规格 INVALID_PARAMS', async () => {
    const p = fake()
    r = await rig({ research: p })
    const j = await call('x-gitrader.research.run', { kind: 'factor_report', spec: fspec() })
    await until(j.jobId, 'running')
    await new Promise((res) => setTimeout(res, 30))
    expect(p.inputs[0]).toMatchObject({ kind: 'factor_report', horizon: 5, window: 40, quantiles: 5, top: 20 })
    for (const bad of [fspec({ instruments: [BTC, BTC] }), fspec({ horizon: 0 }), fspec({ from: T0 + 1, to: T0 }), fspec({ data: { source: 'engine' } })]) {
      expect((await err(call('x-gitrader.research.run', { kind: 'factor_report', spec: bad }))).problem.code).toBe(-32602)
    }
  })
})
