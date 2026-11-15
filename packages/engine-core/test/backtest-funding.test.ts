// SPDX-License-Identifier: CPAL-1.0
// 回测接线（协议 0.1.13）：资金费点 / 强平 / 成交量上限从 spec 进模拟器，实际采用值回写 assumptions，
// 结果带 stats 四项与 funding[]；资金费点可来自宿主方法或 files[].kind="funding" 文件。
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Candle } from '../src/types'
import { makeProblem } from '../src/proto'
import { HostApi } from '../src/runtime/host-api'
import { loadFunding } from '../src/runtime/data'
import type { ResolvedSpec } from '../src/runtime/spec'
import { runBacktest } from '../src/strategy'
import type { StrategyDef } from '../src/strategy/types'
import { sha256Digest } from '../src/util/hash'
import { T0 } from '../../protocol/conformance/host-sim'
import { rig, strategyDir, BTC, type Rig } from './harness'

const STEP = 60_000
const BARS = 40

let r: Rig | null = null
const dirs: string[] = []
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
  r?.close()
  r = null
})

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'gitrader-bt-funding-'))
  dirs.push(d)
  return d
}

/** 40 根平价 K 线（收盘 = price），成交量足够大，不触发成交量上限。 */
const flat = (price = 100, volume = 1e9): Candle[] =>
  Array.from({ length: BARS }, (_, i) => ({ t: T0 + i * STEP, o: price, h: price, l: price, c: price, v: volume }))

/** 「一直满仓做多」的夹具策略：装进策略文件夹，走真实的 loader。 */
const LONG_SOURCE = `// SPDX-License-Identifier: CPAL-1.0
// 测试夹具：每根 K 线的目标仓位都是 1（多头满仓）。
type Candle = { t: number; o: number; h: number; l: number; c: number; v: number }
type SignalSeries = { target: number[]; reasons: string[]; overlays: Record<string, Array<number | null>>; warmup: number }

const strategy = {
  id: 'always-long',
  name: 'Always long (test fixture)',
  version: '0.1.0',
  desc: 'Fixture: target 1 on every bar, used to pin funding, liquidation and volume-cap wiring.',
  tags: [],
  params: [],
  evaluate(candles: Candle[]): SignalSeries {
    return { target: candles.map(() => 1), reasons: candles.map(() => 'long'), overlays: {}, warmup: 0 }
  },
}

export default strategy
`

function longStrategyDir(): string {
  const dir = tempDir()
  const path = join(dir, 'always-long.ts')
  writeFileSync(path, LONG_SOURCE)
  return strategyDir([path])
}

/** 宿主对资金费历史的回答：给点，或按「没有这个方法」回。 */
type FundingReply = { points: Array<{ t: number; rate: number }> } | 'method-not-found'

/**
 * 把宿主的行情 / 资金费历史换成测试夹具：行情用给定 K 线，资金费按 reply 回答。
 * 只替换这两个方法，其余仍走假宿主的实现。
 */
function patchHost(host: Rig['host'], candles: readonly Candle[], reply: FundingReply): void {
  const base = host.handle.bind(host)
  host.handle = (method: string, params: any) => {
    if (method === 'host.market.history') {
      return { result: { candles: candles.map((c) => [c.t, c.o, c.h, c.l, c.c, c.v]), source: 'synthetic', complete: true } }
    }
    if (method === 'host.market.fundingHistory') {
      if (reply === 'method-not-found') return { error: makeProblem('METHOD_NOT_FOUND', 'unknown host method host.market.fundingHistory') }
      return { result: { points: reply.points, complete: true } }
    }
    return base(method, params)
  }
}

const spec = (over: { account?: Record<string, unknown>; assumptions?: Record<string, unknown> } = {}): Record<string, unknown> => ({
  subject: { strategy: { id: 'always-long', version: '0.1.0', params: {} } },
  instruments: [BTC], interval: '1m', from: T0, to: T0 + BARS * STEP,
  data: { source: 'host' },
  account: { initialBalance: '100', ccy: 'USDC', leverage: 1, ...(over.account ?? {}) },
  assumptions: { fees: { maker: '0', taker: '0' }, slippageBps: 0, fillModel: 'next-bar-open', funding: false, liquidation: false, ...(over.assumptions ?? {}) },
  seed: 42,
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

const runJob = async (s: Record<string, unknown>): Promise<{ state: string; result: any }> => {
  const { jobId } = await r!.session.call<{ jobId: string }>('backtest.run', { spec: s })
  const state = await waitState(jobId)
  if (state !== 'done') return { state, result: null }
  return { state, result: await r!.session.call('backtest.result', { jobId }) }
}

/** 同步回测入口用的夹具策略（不经 loader）。 */
const LONG_DEF: StrategyDef = {
  id: 'always-long', name: 'Always long', version: '0.1.0', desc: 'fixture', tags: [], params: [], defaults: {},
  evaluate: (candles) => ({ target: candles.map(() => 1), reasons: candles.map(() => 'long'), overlays: {}, warmup: 0 }),
}

describe('资金费：全链路（宿主方法）', () => {
  it('assumptions.funding: true + 持仓期间单点 → fundingPaid 0.01、funding[] 一条（notional 100 / paid 0.01）、assumptions.funding 回写 true', async () => {
    r = await rig({ strategiesDir: longStrategyDir() })
    patchHost(r.host, flat(), { points: [{ t: T0 + 5 * STEP, rate: 0.0001 }] })
    const { state, result } = await runJob(spec({ assumptions: { funding: true } }))
    expect(state).toBe('done')
    expect(result.assumptions.funding).toBe(true)
    expect(result.stats.fundingPaid).toBe(0.01)
    expect(result.funding).toHaveLength(1)
    expect(result.funding[0]).toEqual({ t: T0 + 5 * STEP, rate: 0.0001, notional: 100, paid: 0.01 })
    // 资金费不入 trades，只从现金里扣：末期权益 100 − 0.01
    expect(result.stats.finalEquity).toBe(99.99)
    expect(result.trades.some((t: { reason: string }) => t.reason === 'funding')).toBe(false)
  })

  it('assumptions.funding: true 但宿主没有 fundingHistory → 回写 false、warnings 含 funding、fundingPaid 0、作业仍 done', async () => {
    r = await rig({ strategiesDir: longStrategyDir() })
    patchHost(r.host, flat(), 'method-not-found')
    const { state, result } = await runJob(spec({ assumptions: { funding: true } }))
    expect(state).toBe('done')
    expect(result.assumptions.funding).toBe(false)
    expect(result.warnings.join('|')).toContain('funding')
    expect(result.stats.fundingPaid).toBe(0)
    expect(result.funding).toBeUndefined()
  })
})

describe('资金费：files 里 kind="funding" 的 CSV', () => {
  it('按 kind 挑文件装载成功，数字与宿主路径一致；sha256 不符抛 DATA_UNAVAILABLE', async () => {
    const dir = tempDir()
    const candlePath = join(dir, 'candles.csv')
    const fundingPath = join(dir, 'funding.csv')
    const candles = flat()
    const candleText = 't,o,h,l,c,v\n' + candles.map((c) => [c.t, c.o, c.h, c.l, c.c, c.v].join(',')).join('\n')
    const fundingText = `t,rate\n${T0 + 5 * STEP},0.0001\n`
    writeFileSync(candlePath, candleText)
    writeFileSync(fundingPath, fundingText)
    const files = (fundingSha: string): unknown[] => [
      { path: candlePath, sha256: sha256Digest(Buffer.from(candleText, 'utf8')), format: 'csv', kind: 'candles' },
      { path: fundingPath, sha256: fundingSha, format: 'csv', kind: 'funding' },
    ]
    const resolved = (fundingSha: string): ResolvedSpec => ({
      spec: {
        assumptions: { fees: { maker: '0', taker: '0' }, slippageBps: 0, fillModel: 'next-bar-open', funding: true, liquidation: false },
        data: { source: 'files', files: files(fundingSha) },
      },
      instrumentId: BTC, interval: '1m', intervalMs: STEP, from: T0, to: T0 + BARS * STEP,
    } as unknown as ResolvedSpec)

    const host = new HostApi(() => null)
    const loaded = await loadFunding(resolved(sha256Digest(Buffer.from(fundingText, 'utf8'))), host)
    expect(loaded.applied).toBe(true)
    expect(loaded.source).toBe('files:csv')
    expect(loaded.points).toEqual([{ t: T0 + 5 * STEP, rate: 0.0001 }])

    const out = runBacktest(LONG_DEF, candles, {}, {
      initialCash: 100, leverage: 1, feeRate: 0, slippageBps: 0, funding: loaded.points,
    })
    expect(out.stats.fundingPaid).toBe(0.01)
    expect(out.funding).toHaveLength(1)
    expect(out.funding[0]!.notional).toBe(100)
    expect(out.funding[0]!.paid).toBe(0.01)

    const bad = resolved(sha256Digest(Buffer.from('other', 'utf8')))
    const err = await loadFunding(bad, host).then(() => null, (e: unknown) => e)
    expect((err as { problem?: { name?: string } } | null)?.problem?.name).toBe('DATA_UNAVAILABLE')
  })
})

describe('强平与维持保证金比例接线', () => {
  it('account.maintenanceMarginRatio 缺省回写 0.5 / leverage（5 → 0.1），显式给 0.2 回写 0.2', async () => {
    r = await rig({ strategiesDir: longStrategyDir() })
    patchHost(r.host, flat(), { points: [] })
    const byDefault = await runJob(spec({ account: { leverage: 5 } }))
    expect(byDefault.state).toBe('done')
    expect(byDefault.result.assumptions['x-maintenanceMarginRatio']).toBe(0.1)
    const given = await runJob(spec({ account: { leverage: 5, maintenanceMarginRatio: 0.2 } }))
    expect(given.state).toBe('done')
    expect(given.result.assumptions['x-maintenanceMarginRatio']).toBe(0.2)
  })

  it('assumptions.liquidation: true + 一根跌破维持保证金的 K 线 → liquidations 1，trades 里有 reason "liquidation"', async () => {
    const candles = flat()
    candles[5] = { t: T0 + 5 * STEP, o: 100, h: 100, l: 90, c: 95, v: 1e9 }
    r = await rig({ strategiesDir: longStrategyDir() })
    patchHost(r.host, candles, { points: [] })
    const { state, result } = await runJob(spec({ account: { leverage: 10 }, assumptions: { liquidation: true } }))
    expect(state).toBe('done')
    expect(result.stats.liquidations).toBe(1)
    expect(result.trades.filter((t: { reason: string }) => t.reason === 'liquidation')).toHaveLength(1)
  })

  it('穿仓夹具：assumptions.liquidation 回写 true、无「not supported」、自审现金差为 0、穿仓额写进 warnings', async () => {
    const candles = flat()
    candles[5] = { t: T0 + 5 * STEP, o: 100, h: 100, l: 80, c: 95, v: 1e9 }   // 10x 杠杆、保证金 100，最差价 80 跌穿破产价 90
    r = await rig({ strategiesDir: longStrategyDir() })
    patchHost(r.host, candles, { points: [] })
    const { state, result } = await runJob(spec({ account: { leverage: 10 }, assumptions: { liquidation: true } }))
    expect(state).toBe('done')
    expect(result.assumptions.liquidation).toBe(true)
    const w = result.warnings.join('|')
    expect(w).not.toMatch(/not supported/)
    expect(w).not.toMatch(/ledger audit mismatch/)
    expect(w).toMatch(/liquidation shortfall at t=\d+.*100/)
    const liq = result.trades.filter((t: { reason: string }) => t.reason === 'liquidation')
    expect(liq).toHaveLength(1)
    expect(liq[0].price).toBeCloseTo(90, 9)
    expect(result.stats.finalEquity).toBe(0)
  })

  it('反例：没请求强平时 assumptions.liquidation 仍是 false，同一夹具不强平', async () => {
    const candles = flat()
    candles[5] = { t: T0 + 5 * STEP, o: 100, h: 100, l: 80, c: 95, v: 1e9 }
    r = await rig({ strategiesDir: longStrategyDir() })
    patchHost(r.host, candles, { points: [] })
    const { result } = await runJob(spec({ account: { leverage: 10 }, assumptions: { liquidation: false } }))
    expect(result.assumptions.liquidation).toBe(false)
    expect(result.stats.liquidations).toBe(0)
  })
})

describe('成交量上限接线', () => {
  it('assumptions.maxVolumeShare: 0.1 + 成交量很小的 K 线 → unfilledShare > 0 且回写 0.1', async () => {
    r = await rig({ strategiesDir: longStrategyDir() })
    patchHost(r.host, flat(100, 0.5), { points: [] })
    const { state, result } = await runJob(spec({ assumptions: { maxVolumeShare: 0.1 } }))
    expect(state).toBe('done')
    expect(result.stats.unfilledShare).toBeGreaterThan(0)
    expect(result.assumptions.maxVolumeShare).toBe(0.1)
  })
})

describe('GQ-13 files 源两个文件：整条回测链', () => {
  const writeBoth = (fundingText: string) => {
    const dir = tempDir()
    const candleText = 't,o,h,l,c,v\n' + flat().map((c) => [c.t, c.o, c.h, c.l, c.c, c.v].join(',')).join('\n')
    const candlePath = join(dir, 'candles.csv')
    const fundingPath = join(dir, 'funding.csv')
    writeFileSync(candlePath, candleText)
    writeFileSync(fundingPath, fundingText)
    return {
      candle: { path: candlePath, sha256: sha256Digest(Buffer.from(candleText, 'utf8')), format: 'csv' },
      funding: { path: fundingPath, sha256: sha256Digest(Buffer.from(fundingText, 'utf8')), format: 'csv', kind: 'funding' },
    }
  }
  const withFiles = (files: unknown[], funding = true) => ({
    ...spec({ assumptions: { funding } }),
    data: { source: 'files', files },
  })

  it('两个文件（K 线 + funding）被接受，fundingPaid 等于手算 0.01，assumptions.funding 回写 true', async () => {
    const { candle, funding } = writeBoth(`t,rate\n${T0 + 5 * STEP},0.0001\n`)
    r = await rig({ strategiesDir: longStrategyDir() })
    const { state, result } = await runJob(withFiles([candle, funding]))
    expect(state).toBe('done')
    expect(result.assumptions.funding).toBe(true)
    expect(result.stats.fundingPaid).toBe(0.01)             // 100 名义 × 0.0001
    expect(result.warnings.join('|')).not.toMatch(/not supported/)
  })

  it('K 线条目显式写 kind:"candles" 也接受；funding 条目放在前面也接受', async () => {
    const { candle, funding } = writeBoth(`t,rate\n${T0 + 5 * STEP},0.0001\n`)
    r = await rig({ strategiesDir: longStrategyDir() })
    const { state, result } = await runJob(withFiles([funding, { ...candle, kind: 'candles' }]))
    expect(state).toBe('done')
    expect(result.stats.fundingPaid).toBe(0.01)
  })

  it('给了 funding 文件但 assumptions.funding=false：忽略并写 warning', async () => {
    const { candle, funding } = writeBoth(`t,rate\n${T0 + 5 * STEP},0.0001\n`)
    r = await rig({ strategiesDir: longStrategyDir() })
    const { state, result } = await runJob(withFiles([candle, funding], false))
    expect(state).toBe('done')
    expect(result.stats.fundingPaid).toBe(0)
    expect(result.warnings.join('|')).toMatch(/funding file was supplied but assumptions\.funding is false/)
  })

  it('反例：这些形状一律 -32602', async () => {
    const { candle, funding } = writeBoth('t,rate\n')
    r = await rig({ strategiesDir: longStrategyDir() })
    const bads: unknown[][] = [
      [],                                              // 空
      [funding],                                       // 只有 funding，没有 K 线
      [candle, { ...candle }],                         // 两个 K 线
      [candle, funding, { ...funding }],               // 三个
      [candle, { ...funding, kind: 'weird' }],         // 未知 kind
      [{ ...candle, format: 'parquet' }],              // 仍不收 parquet
    ]
    for (const files of bads) {
      const e = await r!.session.expectError('backtest.run', { spec: withFiles(files) })
      expect(e.code).toBe(-32602)
    }
  })
})

describe('GQ-15 回测结果金额取整', () => {
  const clean = (x: number): boolean => Number(x.toPrecision(15)) === x
  it('trades / equity / funding 里不再有 15 位有效数字以外的尾差', async () => {
    r = await rig({ strategiesDir: longStrategyDir() })
    patchHost(r.host, flat(), { points: [{ t: T0 + 5 * STEP, rate: 0.0001 }] })
    const s = spec({ assumptions: { funding: true, fees: { maker: '0', taker: '0.00045' }, slippageBps: 2 } })
    ;(s.account as Record<string, unknown>).initialBalance = '1000.37'
    const { state, result } = await runJob(s)
    expect(state).toBe('done')
    expect(result.trades.length).toBeGreaterThan(0)
    for (const t of result.trades) for (const k of ['price', 'size', 'pnl', 'fee'] as const) expect(clean(t[k])).toBe(true)
    for (const p of result.equity) expect(clean(p.v)).toBe(true)
    for (const f of result.funding) { expect(clean(f.notional)).toBe(true); expect(clean(f.paid)).toBe(true) }
  })
})
