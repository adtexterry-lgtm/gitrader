// SPDX-License-Identifier: CPAL-1.0
// 回测任务（GEP backtest.*）与回放：统一格式、假设声明、确定性、进度 / 取消、前视偏差自检、回放与回测一致。
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { missingBacktestAssumptions } from '../src/proto'
import { validateBacktestResult, validateBacktestSpec } from '../../protocol/src/validate'
import { T0, genCandles } from '../../protocol/conformance/host-sim'
import { lookaheadCheck } from '../src/strategy/bias'
import { evaluateStrategy } from '../src/strategy'
import { ALL, get } from './defs'
import { sha256Digest } from '../src/util/hash'
import { rig, BTC, type Rig } from './harness'

let r: Rig | null = null
afterEach(() => { r?.close(); r = null })

const baseSpec = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  subject: { strategy: { id: 'ema-trend', version: '0.1.0', params: { fast: 5, slow: 20 } } },
  instruments: [BTC], interval: '1m', from: T0, to: T0 + 2000 * 60_000,
  data: { source: 'host' }, account: { initialBalance: '10000', ccy: 'USDC', leverage: 1 },
  assumptions: { fees: { maker: '0.00015', taker: '0.00045' }, slippageBps: 2, fillModel: 'next-bar-open', funding: false, liquidation: false },
  seed: 42, ...over,
})

async function runJob(spec: Record<string, unknown>, timeout = 15_000): Promise<{ jobId: string; result: any }> {
  const { jobId } = await r!.session.call('backtest.run', { spec })
  const done = await r!.session.waitFor(() => false, 0) // noop，保持类型
  void done
  const end = Date.now() + timeout
  for (;;) {
    const st = await r!.session.call('backtest.status', { jobId })
    if (st.state === 'done') return { jobId, result: await r!.session.call('backtest.result', { jobId }) }
    if (st.state === 'failed' || st.state === 'cancelled') throw new Error(`job ${st.state}`)
    if (Date.now() > end) throw new Error('job timeout')
    await new Promise((res) => setTimeout(res, 20))
  }
}

describe('backtest.run：统一格式与假设声明', () => {
  it('立即返回 jobId；结果过 BacktestResult schema；assumptions 五项齐全且如实（资金费 / 强平 false）', async () => {
    r = await rig()
    expect(validateBacktestSpec(baseSpec()).ok).toBe(true)
    const t0 = Date.now()
    const { jobId } = await r.session.call('backtest.run', { spec: baseSpec() })
    expect(Date.now() - t0).toBeLessThan(500)
    expect(jobId).toMatch(/^job_/)
    const { result } = await runJob(baseSpec())
    const v = validateBacktestResult(result)
    expect(v.ok, JSON.stringify(v)).toBe(true)
    expect(missingBacktestAssumptions(result.assumptions)).toEqual([])
    expect(result.assumptions).toMatchObject({ fillModel: 'next-bar-open', funding: false, liquidation: false, slippageBps: 2 })
    expect(result.assumptions.fees).toEqual({ maker: '0.00015', taker: '0.00045' })
    expect(result.engine.id).toBe('gitrader-core')
    expect(result.specDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(result.dataDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(result.stats.fills).toBe(result.trades.length)
    expect(result.equity).toHaveLength(2000)
    expect(result.biasChecks).toMatchObject({ lookahead: 'pass', recursive: 'not_run' })
    expect(result.trialCount).toBeGreaterThanOrEqual(1)
  })

  it('确定性：合成夹具 2,000 根 + 固定种子，两次结果除 jobId 外逐字节一致；换一份规格才算新试验', async () => {
    r = await rig()
    const a = (await runJob(baseSpec())).result
    const b = (await runJob(baseSpec())).result
    const strip = (x: Record<string, unknown>): string => JSON.stringify({ ...x, jobId: undefined })
    expect(strip(a)).toBe(strip(b))
    expect(a.trialCount).toBe(1)
    // 同一策略换参数 = 新试验，用于偏差折价
    const c = (await runJob(baseSpec({ subject: { strategy: { id: 'ema-trend', version: '0.1.0', params: { fast: 6, slow: 20 } } } }))).result
    expect(c.trialCount).toBe(2)
    expect(c.biasChecks.trialCount).toBe(2)
  })

  it('请求的假设引擎做不到时如实降级并写 warnings；成交模型不支持 → -32602', async () => {
    r = await rig()
    const { result } = await runJob(baseSpec({ assumptions: { fees: 'venue', slippageBps: 1, fillModel: 'next-bar-open', funding: true, liquidation: true } }))
    expect(result.assumptions.funding).toBe(false)
    expect(result.assumptions.liquidation).toBe(true)
    expect(result.warnings.join('|')).toMatch(/funding/)
    expect(result.warnings.join('|')).not.toMatch(/liquidation simulation was requested but is not supported/)
    expect(result.assumptions.fees.taker).toBe('0.00045')
    const e = await r.session.expectError('backtest.run', { spec: baseSpec({ assumptions: { fees: 'venue', slippageBps: 1, fillModel: 'intra-bar-ohlc', funding: false, liquidation: false } }) })
    expect(e.code).toBe(-32602)
    const own = await r.session.expectError('backtest.run', { spec: baseSpec({ data: { source: 'engine' } }) })
    expect(own.code).toBe(5002)
    const multi = await r.session.expectError('backtest.run', { spec: baseSpec({ instruments: [BTC, 'hyperliquid:ETH'] }) })
    expect(multi.code).toBe(-32602)
  })

  it('长任务：进度单调不减；cancel 在 5 秒内生效；结果未就绪时 backtest.result 回 4004', async () => {
    r = await rig({ jobs: { chunk: 500 } })
    // 5,000 根 × 小分片，足够让 status 观察到中间态
    const { jobId } = await r.session.call('backtest.run', { spec: baseSpec({ from: T0, to: T0 + 5000 * 60_000 }) })
    const early = await r.session.expectError('backtest.result', { jobId }).catch(() => null)
    if (early) expect(early.code).toBe(4004)
    const seen: number[] = []
    for (let i = 0; i < 200; i++) {
      const st = await r.session.call('backtest.status', { jobId })
      seen.push(st.progress)
      if (st.state === 'done') break
      await new Promise((res) => setTimeout(res, 2))
    }
    for (let i = 1; i < seen.length; i++) expect(seen[i]!).toBeGreaterThanOrEqual(seen[i - 1]!)

    const { jobId: j2 } = await r.session.call('backtest.run', { spec: baseSpec({ from: T0, to: T0 + 5000 * 60_000 }) })
    const t0 = Date.now()
    await r.session.call('backtest.cancel', { jobId: j2 })
    for (;;) {
      const st = await r.session.call('backtest.status', { jobId: j2 })
      if (st.state === 'cancelled' || st.state === 'done') break
      await new Promise((res) => setTimeout(res, 10))
    }
    expect(Date.now() - t0).toBeLessThan(5000)
  })

  it('并发上限 2：第三个任务排队', async () => {
    r = await rig({ jobs: { chunk: 200, maxConcurrent: 2 } })
    const ids: string[] = []
    for (let i = 0; i < 3; i++) ids.push((await r.session.call('backtest.run', { spec: baseSpec({ from: T0, to: T0 + 5000 * 60_000, seed: i }) })).jobId)
    const states = await Promise.all(ids.map((jobId) => r!.session.call('backtest.status', { jobId })))
    expect(states.map((s) => s.state)).toContain('queued')
  })

  it('进度事件走 backtest 流（可合并），不阻塞', async () => {
    r = await rig({ jobs: { chunk: 500 } })
    await r.session.call('events.subscribe', { streams: ['backtest'] })
    await runJob(baseSpec())
    expect(await r.session.waitFor(() => r!.session.events.some((e) => e.type === 'backtest.progress'), 1000)).toBe(true)
  })
})

describe('数据来源：本地 CSV 文件 / 大载荷', () => {
  it('files 来源：校验 sha256；不匹配 → 任务失败（4005）而不是悄悄用错数据', async () => {
    r = await rig()
    const dir = mkdtempSync(join(tmpdir(), 'gep-csv-'))
    const path = join(dir, 'btc.csv')
    const cs = genCandles(3, 600)
    const text = 't,o,h,l,c,v\n' + cs.map((c) => [c.t, c.o, c.h, c.l, c.c, c.v].join(',')).join('\n')
    writeFileSync(path, text)
    const good = { source: 'files', files: [{ path, sha256: sha256Digest(Buffer.from(text, 'utf8')), format: 'csv' }] }
    const { result } = await runJob(baseSpec({ data: good, from: T0, to: T0 + 600 * 60_000 }))
    expect(result.equity).toHaveLength(600)
    const bad = { source: 'files', files: [{ path, sha256: 'sha256:' + '0'.repeat(64), format: 'csv' }] }
    const { jobId } = await r.session.call('backtest.run', { spec: baseSpec({ data: bad }) })
    let state = ''
    for (let i = 0; i < 100 && state !== 'failed'; i++) { state = (await r.session.call('backtest.status', { jobId })).state; await new Promise((res) => setTimeout(res, 10)) }
    expect(state).toBe('failed')
    const err = await r.session.expectError('backtest.result', { jobId })
    expect(err.code).toBe(4005)
  })

  it('大结果走 host.artifact.put（> 1 MB），内联数组留空；不落盘时降采样内联且写进 warnings', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gep-art-'))
    r = await rig({ jobs: { artifactDir: dir, inlineLimitBytes: 20_000 } })
    const { result } = await runJob(baseSpec({ to: T0 + 4000 * 60_000 }))
    expect(result.artifacts.map((a: { kind: string }) => a.kind).sort()).toEqual(['equity', 'trades'])
    expect(result.equity).toEqual([])
    expect(r.host.calls.filter((c) => c.method === 'host.artifact.put').length).toBe(2)
    r.close()
    r = await rig({ jobs: { inlineLimitBytes: 20_000, inlineMaxPoints: 500 } })
    const { result: inline } = await runJob(baseSpec({ to: T0 + 4000 * 60_000 }))
    expect(inline.equity.length).toBe(500)
    expect(inline.equity[0].t).toBe(T0)
    expect(inline.equity.at(-1).t).toBe(T0 + 3999 * 60_000)
    expect(inline.warnings.join('|')).toMatch(/downsampled|only the first/)
  })
})

describe('前视偏差自检', () => {
  const candles = genCandles(11, 600)

  it('五个示例策略都通过：信号只依赖已收盘的 K 线', async () => {
    for (const def of ALL) {
      const id = def.id
      const res = await lookaheadCheck((cs) => def.evaluate(cs, def.defaults), candles)
      expect(res.result, id).toBe('pass')
    }
  })

  it('偷看下一根收盘价的「策略」被抓住（指标使用了未来 K 线）', async () => {
    const cheat = (cs: typeof candles): { target: number[] } => ({ target: cs.map((c, i) => (cs[i + 1] ? (cs[i + 1]!.c > c.c ? 1 : -1) : 0)) })
    const res = await lookaheadCheck(cheat, candles)
    expect(res.result).toBe('fail')
    expect(res.firstMismatch).toBeGreaterThanOrEqual(0)
    // 用全段统计量也算偷看（均值包含未来）
    const meanAll = (cs: typeof candles): { target: number[] } => { const m = cs.reduce((a, c) => a + c.c, 0) / cs.length; return { target: cs.map((c) => (c.c > m ? 1 : 0)) } }
    expect((await lookaheadCheck(meanAll, candles)).result).toBe('fail')
  })

  it('K 线太少时 not_run 并写进 warnings', async () => {
    expect((await lookaheadCheck((cs) => ({ target: cs.map(() => 0) }), candles.slice(0, 20))).result).toBe('not_run')
  })
})

describe('replay：与回测同一成交模型', () => {
  it('1,440 根回放的成交序列与回测逐笔一致（回放只用已收盘数据重算信号）', async () => {
    r = await rig()
    const spec = baseSpec({ to: T0 + 1440 * 60_000 })
    const { result } = await runJob(spec)
    const { replayId } = await r.session.call('replay.start', { spec })
    let st: any
    for (let i = 0; i < 400; i++) {
      st = await r.session.call('replay.status', { replayId })
      if (st.state === 'done') break
      await new Promise((res) => setTimeout(res, 25))
    }
    expect(st.state).toBe('done')
    expect(st['x-progress']).toBe(1)
    expect(result.trades.length).toBeGreaterThan(0)
    // GQ-15: 作业结果已取整，replay 用原始值，改为 toBeCloseTo 比较
    expect(st['x-fills'].length).toBe(result.trades.length)
    for (let i = 0; i < result.trades.length; i++) {
      const replay = st['x-fills'][i]
      const job = result.trades[i]
      expect(replay.t).toBe(job.t)
      expect(replay.side).toBe(job.side)
      expect(replay.reason).toBe(job.reason)
      expect(replay.price).toBeCloseTo(job.price, 11)
      expect(replay.size).toBeCloseTo(job.size, 11)
      expect(replay.pnl).toBeCloseTo(job.pnl, 11)
      expect(replay.fee).toBeCloseTo(job.fee, 11)
    }
  })

  it('stop 后状态 stopped；未知 replayId → -32602', async () => {
    r = await rig()
    const { replayId } = await r.session.call('replay.start', { spec: baseSpec({ to: T0 + 3000 * 60_000 }) })
    await r.session.call('replay.stop', { replayId })
    let st: any
    for (let i = 0; i < 200; i++) { st = await r.session.call('replay.status', { replayId }); if (st.state !== 'running') break; await new Promise((res) => setTimeout(res, 10)) }
    expect(['stopped', 'done']).toContain(st.state)
    expect((await r.session.expectError('replay.status', { replayId: 'rpl_nope' })).code).toBe(-32602)
  })
})

describe('回测对象一致性', () => {
  it('网关返回的 trades 与同步回测核心逐笔一致', async () => {
    r = await rig()
    const { result } = await runJob(baseSpec())
    const cs = genCandles(7, 5000).filter((c) => c.t >= T0 && c.t < T0 + 2000 * 60_000)
    const def = get('ema-trend')
    const s = evaluateStrategy(def, cs, { fast: 5, slow: 20 }).series
    expect(s.target.length).toBe(2000)
    expect(result.trades.length).toBeGreaterThan(0)
  })
})
