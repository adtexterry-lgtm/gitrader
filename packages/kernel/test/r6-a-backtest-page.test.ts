// SPDX-License-Identifier: CPAL-1.0
// R1-PERF-02：Agent 回测结果的摘要 / 分页（内核 api/agent.ts 的 backtest result 动作用的 backtest-page.ts）。
import { describe, expect, it } from 'vitest'
import { backtestResultPart, loadBacktestResult } from '../src/api/backtest-page'

type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const MCP_CAP = 60_000
const equityOf = (n: number): Array<{ t: number; v: number }> => Array.from({ length: n }, (_, i) => ({ t: 1_700_000_000_000 + i * 3_600_000, v: 10_000 + Math.sin(i / 7) * 123.456789012345 }))
const tradesOf = (n: number): Json[] => Array.from({ length: n }, (_, i) => ({ t: 1_700_000_000_000 + i * 7_200_000, side: i % 2 ? 'sell' : 'buy', price: 80_123.456789 + i, size: 0.0123456789, fee: 0.0123456789, pnl: -3.14159265358979, reason: 'ema cross '.repeat(5) }))
const base = (extra: Json = {}): Json => ({
  jobId: 'job_1', runId: 'run_1', specDigest: 'sha256:a', dataDigest: 'sha256:b', strategySha256: 'sha256:c', trialCount: 1,
  stats: { trades: 3, fills: 6, finalEquity: 10_500 }, biasChecks: { lookahead: 'passed', recursive: 'not_run' },
  assumptions: { funding: false }, warnings: ['w1'], engine: { id: 'gitrader-core', version: '0.1.0' }, openPosition: null,
  artifacts: [], pack: { specDigest: 'sha256:a' }, ...extra,
})
const noArtifacts = { read: () => { throw new Error('should not read an artifact') } } as never
const entry = (full: Json) => ({ full, series: {} })
const run = (full: Json, args: Json = {}, artifacts: { read: (id: string) => Buffer } = noArtifacts) => backtestResultPart(entry(full), args, artifacts) as Json

describe('summary', () => {
  it('去掉 equity / trades / funding，改给 counts；其余顶层字段原样保留', () => {
    const full = base({ equity: equityOf(26_280), trades: tradesOf(2000), funding: [{ t: 1, rate: 0.0001, notional: 1, paid: 0.1 }] })
    const s = run(full)
    expect(s.equity).toBeUndefined()
    expect(s.trades).toBeUndefined()
    expect(s.funding).toBeUndefined()
    expect(s.counts).toEqual({ equity: 26_280, trades: 2000, funding: 1 })
    for (const k of ['stats', 'biasChecks', 'assumptions', 'warnings', 'trialCount', 'engine', 'dataDigest', 'specDigest', 'jobId', 'openPosition', 'artifacts', 'pack', 'strategySha256', 'runId']) expect(s[k], k).toEqual(full[k])
    expect(JSON.stringify(s).length).toBeLessThan(MCP_CAP)
    expect(s.hint).toContain('part')
  })

  it('引擎没带 biasChecks（Python 引擎）：摘要里如实补 not_run；带了的原样保留', () => {
    const { biasChecks: _b, ...py } = base({ equity: equityOf(3), trades: [] }) // eslint-disable-line @typescript-eslint/no-unused-vars
    expect(run(py).biasChecks).toEqual({ lookahead: 'not_run', recursive: 'not_run', trialCount: 1 })
    expect(run({ ...py, trialCount: 4 }).biasChecks.trialCount).toBe(4)
    expect(run(base({ equity: equityOf(3), trades: [] })).biasChecks).toEqual({ lookahead: 'passed', recursive: 'not_run' })
  })

  it('不给 part 也是 summary；funding 缺省 → counts.funding = 0', () => {
    const s = run(base({ equity: equityOf(5), trades: [] }), { part: 'summary' })
    expect(s.counts).toEqual({ equity: 5, trades: 0, funding: 0 })
  })
})

describe('分页', () => {
  const pagesOf = (full: Json, part: string, limit: number, artifacts?: { read: (id: string) => Buffer }) => {
    const e = entry(full)
    const items: Json[] = []
    const sizes: number[] = []
    let cursor: string | undefined
    for (let i = 0; i < 2000; i++) {
      const p = backtestResultPart(e, { part, limit, ...(cursor ? { cursor } : {}) }, artifacts ?? noArtifacts) as Json
      sizes.push(JSON.stringify(p).length)
      items.push(...p.items)
      expect(p.total).toBe((full[part] as unknown[]).length || p.total)
      cursor = p.next
      if (!cursor) return { items, sizes, pages: i + 1 }
    }
    throw new Error('did not terminate')
  }

  it('equity：26280 点按 limit 1000 翻页拼回逐点相同；每页 < 60,000 字符；最后一页没有 next', () => {
    const equity = equityOf(26_280)
    const r = pagesOf(base({ equity, trades: [] }), 'equity', 1000)
    expect(r.items).toEqual(equity)
    expect(Math.max(...r.sizes)).toBeLessThan(MCP_CAP)
    expect(r.pages).toBeGreaterThan(20) // 受字符预算约束，少给几条也带 next
  })

  it('trades：每条很长时一页只给装得下的条数，仍然翻得完、不截断', () => {
    const trades = tradesOf(3000)
    const r = pagesOf(base({ equity: [], trades }), 'trades', 1000)
    expect(r.items).toEqual(trades)
    expect(Math.max(...r.sizes)).toBeLessThan(MCP_CAP)
  })

  it('limit 小于预算时按 limit 给；total 恒等于 counts；同一 cursor 两次是同一页', () => {
    const full = base({ equity: equityOf(250), trades: tradesOf(7), funding: [] })
    const e = entry(full)
    const p1 = backtestResultPart(e, { part: 'equity', limit: 100 }, noArtifacts) as Json
    expect(p1.items).toHaveLength(100)
    expect(p1.total).toBe(250)
    expect(p1.next).toBe('100')
    const again = backtestResultPart(e, { part: 'equity', limit: 100, cursor: '100' }, noArtifacts)
    expect(backtestResultPart(e, { part: 'equity', limit: 100, cursor: '100' }, noArtifacts)).toEqual(again)
    const last = backtestResultPart(e, { part: 'equity', limit: 100, cursor: '200' }, noArtifacts) as Json
    expect(last.items).toHaveLength(50)
    expect(last.next).toBeUndefined()
    expect((backtestResultPart(e, { part: 'trades' }, noArtifacts) as Json).total).toBe((backtestResultPart(e, {}, noArtifacts) as Json).counts.trades)
    expect(backtestResultPart(e, { part: 'funding' }, noArtifacts)).toEqual({ items: [], total: 0 })
  })

  it('经 host.artifact.put 交付（内联数组为空）：从 artifact 取回完整序列，摘要的 counts 也对', () => {
    const equity = equityOf(40_000)
    const trades = tradesOf(500)
    const store = new Map([['art_eq', Buffer.from(JSON.stringify(equity))], ['art_tr', Buffer.from(JSON.stringify(trades))]])
    let reads = 0
    const artifacts = { read: (id: string) => { reads++; return store.get(id)! } }
    const full = base({ equity: [], trades: [], artifacts: [{ artifactId: 'art_eq', kind: 'equity' }, { artifactId: 'art_tr', kind: 'trades' }] })
    const e = entry(full)
    expect((backtestResultPart(e, {}, artifacts) as Json).counts).toEqual({ equity: 40_000, trades: 500, funding: 0 })
    const got: Json[] = []
    let cursor: string | undefined
    do {
      const p = backtestResultPart(e, { part: 'equity', limit: 1000, ...(cursor ? { cursor } : {}) }, artifacts) as Json
      got.push(...p.items)
      cursor = p.next
    } while (cursor)
    expect(got).toEqual(equity)
    expect(reads).toBe(2) // 每个 artifact 只读 / 解析一次，翻页不重复读
  })

  it('入参不对 → INVALID_PARAMS', () => {
    const e = entry(base({ equity: equityOf(5) }))
    const code = (args: Json): string => { try { backtestResultPart(e, args, noArtifacts); return 'no error' } catch (x) { return (x as { problem?: { name?: string } }).problem?.name ?? String(x) } }
    expect(code({ part: 'bogus' })).toBe('INVALID_PARAMS')
    expect(code({ part: 'equity', limit: 0 })).toBe('INVALID_PARAMS')
    expect(code({ part: 'equity', limit: 1001 })).toBe('INVALID_PARAMS')
    expect(code({ part: 'equity', limit: 1.5 })).toBe('INVALID_PARAMS')
    expect(code({ part: 'equity', cursor: 'abc' })).toBe('INVALID_PARAMS')
    expect(code({ part: 'equity', cursor: '-1' })).toBe('INVALID_PARAMS')
    expect(code({ part: 'equity', limit: '2' })).toBe('no error') // 数字字符串当数字（命令行传来的）
  })
})

describe('loadBacktestResult 缓存', () => {
  it('同一钥匙 + 同一作业只向引擎要一次完整结果；别的授权书不共用；只留最近几份', async () => {
    const owner = {}
    let fetches = 0
    const fetch = (id: string) => async () => { fetches++; return base({ jobId: id, equity: equityOf(3) }) }
    const a1 = await loadBacktestResult(owner, 'mdt_A|core|job_1', fetch('job_1'))
    const a2 = await loadBacktestResult(owner, 'mdt_A|core|job_1', fetch('job_1'))
    expect(a2).toBe(a1)
    expect(fetches).toBe(1)
    await loadBacktestResult(owner, 'mdt_B|core|job_1', fetch('job_1'))
    expect(fetches).toBe(2)
    for (let i = 2; i < 8; i++) await loadBacktestResult(owner, `mdt_A|core|job_${i}`, fetch(`job_${i}`))
    const before = fetches
    await loadBacktestResult(owner, 'mdt_A|core|job_1', fetch('job_1')) // 早已被挤出
    expect(fetches).toBe(before + 1)
  })

  it('取结果失败不缓存（作业没跑完时下次重来）', async () => {
    const owner = {}
    let n = 0
    const f = async () => { n++; if (n === 1) throw new Error('not done'); return base({ equity: [] }) }
    await expect(loadBacktestResult(owner, 'k', f)).rejects.toThrow('not done')
    expect((await loadBacktestResult(owner, 'k', f)).full.jobId).toBe('job_1')
    expect(n).toBe(2)
  })
})
