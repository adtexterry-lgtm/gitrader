// SPDX-License-Identifier: CPAL-1.0
// MCP 工具 research 的内核侧（第六轮 C 包）：路由只凭 jobId、授权书账户范围、搜索 / 组合 / 回测报告、只读（不写交易类账本）。
// 引擎一侧（校验 / BUSY / 分页 / 取消）在 packages/engine-core/test/research.test.ts；这里用一条假的引擎连接验证内核的转发与访问控制。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RESEARCH_CAPABILITY, RESEARCH_LIMITS } from '../src/proto'
import { BTC } from './helpers/fake-connector'
import { makeAgent, makeHarness } from './helpers/harness'
import type { Harness, TestAgent } from './helpers/harness'

let h: Harness
beforeEach(async () => { h = await makeHarness() })
afterEach(async () => { await h.cleanup() })

interface Reply { data: any; session: any } // eslint-disable-line @typescript-eslint/no-explicit-any
const call = async (a: TestAgent, params: Record<string, unknown>): Promise<Reply> => (await h.k.ops.call(h.k, 'agent.research', { principal: a.principal, params, transport: 'http' })) as Reply

/** 往内核的 GEP 连接表里放一条「已握手」的假引擎，记下它收到的方法与参数。 */
function fakeEngine(capable = true, reply: (method: string, params: Record<string, unknown>) => unknown = () => ({ ok: true })): { calls: { method: string; params: any }[] } { // eslint-disable-line @typescript-eslint/no-explicit-any
  const calls: { method: string; params: any }[] = [] // eslint-disable-line @typescript-eslint/no-explicit-any
  const conns = (h.k.gep as unknown as { conns: Map<string, unknown> }).conns
  conns.set('fake-engine', { engineId: 'fake-engine', state: 'ready', describe: { capabilities: capable ? { [RESEARCH_CAPABILITY]: true } : {} }, rpc: { call: async (method: string, params: Record<string, unknown>) => { calls.push({ method, params }); return reply(method, params) } } })
  return { calls }
}

describe('工具可见性与说明', () => {
  it('只读钥匙也看得到 research；tool_help 回 loaded: true 和用法（动作、异步三步、分页）', async () => {
    const ro = await makeAgent(h, 'read_only')
    const r = await call(ro, { action: 'search', query: 'BTC' })
    expect(r.session.tools).toContain('research')
    const help = (await h.k.ops.call(h.k, 'agent.discover', { principal: ro.principal, params: { action: 'tool_help', tool: 'research' }, transport: 'http' })) as Reply
    expect(help.data).toMatchObject({ name: 'research', loaded: true, annotations: { readOnlyHint: true } })
    expect(help.data.guide).toMatch(/jobId/)
    expect(help.data.guide).toMatch(/cursor/)
    expect(help.data.actions.map((a: { name: string }) => a.name)).toHaveLength(9)
  })
  it('人面操作 research.call 只给会话 / service 主体，Agent 钥匙调不了', async () => {
    const a = await makeAgent(h, 'paper')
    await expect(h.k.ops.call(h.k, 'research.call', { principal: a.principal, params: { action: 'search', query: 'BTC' }, transport: 'http' })).rejects.toMatchObject({ problem: { name: 'AUTH_FAILED' } })
    const r = (await h.k.ops.call(h.k, 'research.call', { principal: h.session, params: { action: 'search', query: 'BTC' }, transport: 'http' })) as { items: { instrumentId: string }[] }
    expect(r.items.map((i) => i.instrumentId)).toContain(BTC)
  })
})

describe('异步作业：校验归属后凭 jobId 转给引擎', () => {
  it('optimize / walk_forward / factor_report 起作业；status / result / cancel 带 jobId；result 的 part / limit / cursor 原样转发', async () => {
    const a = await makeAgent(h, 'paper')
    const eng = fakeEngine(true, (m) => (m.endsWith('.run') ? { jobId: 'rsh_X', kind: 'optimize', state: 'queued' } : { state: 'done' }))
    const spec = { subject: { strategy: { id: 'ema-cross' } }, space: {}, validation: { kind: 'holdout', holdoutBars: 5 } }
    expect((await call(a, { action: 'optimize', spec })).data).toMatchObject({ jobId: 'rsh_X' })
    await call(a, { action: 'walk_forward', spec })
    await call(a, { action: 'factor_report', spec: { instruments: [BTC] } })
    await call(a, { action: 'status', jobId: 'rsh_X' })
    await call(a, { action: 'result', jobId: 'rsh_X' })
    await call(a, { action: 'result', jobId: 'rsh_X', part: 'trials', limit: 4, cursor: '8' })
    await call(a, { action: 'cancel', jobId: 'rsh_X' })
    expect(eng.calls.map((c) => c.method)).toEqual(['x-gitrader.research.run', 'x-gitrader.research.run', 'x-gitrader.research.run', 'x-gitrader.research.status', 'x-gitrader.research.result', 'x-gitrader.research.result', 'x-gitrader.research.cancel'])
    expect(eng.calls.map((c) => c.params.kind).slice(0, 3)).toEqual(['optimize', 'walk_forward', 'factor_report'])
    expect(eng.calls[2]!.params.spec).toEqual({ instruments: [BTC] })
    expect(eng.calls[4]!.params).toEqual({ jobId: 'rsh_X' })
    expect(eng.calls[5]!.params).toEqual({ jobId: 'rsh_X', part: 'trials', limit: 4, cursor: '8' })
    expect(eng.calls[6]!.params).toEqual({ jobId: 'rsh_X' })
  })
  it('缺 spec / jobId、part 写错 → INVALID_PARAMS，且没打扰引擎', async () => {
    const a = await makeAgent(h, 'paper')
    const eng = fakeEngine()
    for (const p of [{ action: 'optimize' }, { action: 'optimize', spec: 'x' }, { action: 'status' }, { action: 'result', jobId: 'j', part: 'bogus' }, { action: 'cancel', jobId: '' }]) {
      await expect(call(a, p)).rejects.toMatchObject({ problem: { name: 'INVALID_PARAMS' } })
    }
    expect(eng.calls).toHaveLength(0)
  })
  it('引擎的错误原样透传（BUSY / INVALID_PARAMS）；没有引擎 → VENUE_UNAVAILABLE；引擎没声明研究能力 → CAPABILITY_UNSUPPORTED', async () => {
    const a = await makeAgent(h, 'paper')
    h.k.research.recordJob('j', h.k.auth.operationRateKey(a.principal)!) // P2-5：作业要归这把钥匙，status / result / cancel 才转给引擎
    await expect(call(a, { action: 'status', jobId: 'j' })).rejects.toMatchObject({ problem: { name: 'VENUE_UNAVAILABLE' } })
    const conns = (h.k.gep as unknown as { conns: Map<string, unknown> }).conns
    fakeEngine(false)
    await expect(call(a, { action: 'status', jobId: 'j' })).rejects.toMatchObject({ problem: { name: 'CAPABILITY_UNSUPPORTED' } })
    conns.clear()
    const { KernelError } = await import('../src/util/errors')
    const { makeProblem } = await import('../src/proto')
    fakeEngine(true, () => { throw new KernelError(makeProblem('BUSY', 'job is running', { retryable: true })) })
    await expect(call(a, { action: 'result', jobId: 'j' })).rejects.toMatchObject({ problem: { name: 'BUSY', retryable: true } })
  })
})

describe('同步动作', () => {
  it('search：BTC 命中、limit + cursor 分页、没有命中是空列表而不是错误', async () => {
    const a = await makeAgent(h, 'read_only')
    const r = await call(a, { action: 'search', query: 'btc', limit: 1 })
    expect(r.data.items).toHaveLength(1)
    expect(r.data.items[0]).toMatchObject({ instrumentId: BTC, venue: 'hyperliquid', base: 'BTC' })
    expect(Object.keys(r.data.items[0]).sort()).toEqual(['base', 'instrumentId', 'kind', 'match', 'quote', 'score', 'symbol', 'venue'])
    expect(r.data.total).toBeGreaterThanOrEqual(1)
    const all = (await call(a, { action: 'search', query: '', limit: 5 })).data
    expect(all).toEqual({ items: [], total: 0 })
    expect((await call(a, { action: 'search', query: 'zzzzzzzz-nothing', limit: 5 })).data.total).toBe(0)
    await expect(call(a, { action: 'search', query: 'BTC', cursor: '9999' })).rejects.toMatchObject({ problem: { name: 'INVALID_PARAMS' } })
  })

  it('portfolio：缺省取授权书里第一个账户；不在授权书里的账户被拒；有持仓时给估值 / 敞口 / 集中度', async () => {
    const a = await makeAgent(h, 'paper', { accounts: [h.paper.accountId] as never })
    // 先在纸面账户下一笔，造出一个持仓
    await h.k.ops.call(h.k, 'agent.order', { principal: a.principal, params: { action: 'place', intent: { accountId: h.paper.accountId, instrumentId: BTC, side: 'buy', type: 'market', size: '0.003', leverage: 2, reason: 'portfolio test' } }, transport: 'http' })
    const r = await call(a, { action: 'portfolio' })
    expect(r.data.accountId).toBe(h.paper.accountId)
    expect(r.data).toMatchObject({ ccy: expect.any(String), missing: expect.any(Array) })
    expect(r.data.valuation.positions).toHaveLength(1)
    expect(r.data.valuation.positions[0]).toMatchObject({ instrumentId: BTC, side: 'long' })
    expect(Number(r.data.valuation.total)).toBeGreaterThan(0)
    expect(r.data.exposure.totals.positionCount).toBe(1)
    expect(r.data.concentration.byAsset.top1).toBeDefined()
    await expect(call(a, { action: 'portfolio', accountId: h.liveAcct.accountId })).rejects.toMatchObject({ problem: { name: 'MANDATE_LIMIT' } })
    await expect(call(a, { action: 'portfolio', accountId: 'acct_not_in_mandate' })).rejects.toMatchObject({ problem: { name: 'ACCOUNT_NOT_BOUND' } })
  })

  it('backtest_report：指标与 stats 完全相等，markdown 以 # 开头，超长截断，整包 ≤ 8000 字节；format json 不带 markdown', async () => {
    const a = await makeAgent(h, 'paper')
    const n = 3000
    const stats = { totalReturnRatio: 0.123456789012345, annualizedRatio: 0.5, maxDrawdownRatio: 0.0789, sharpe: 1.234567890123, winRatio: 0.55, trades: 200, fills: 410, finalEquity: 11234.5678901234, feesPaid: 98.7654321 }
    const equity = Array.from({ length: n }, (_, i) => ({ t: 1_700_000_000_000 + i * 3_600_000, v: 10000 + i * 0.4 + Math.sin(i / 7) * 50 }))
    const trades = Array.from({ length: 400 }, (_, i) => ({ t: 1_700_000_000_000 + i * 7_200_000, side: i % 2 ? 'sell' : 'buy', price: 100 + i, size: 1, pnl: i % 3 - 1, fee: 0.1, reason: `reason ${i}` }))
    const result = { jobId: 'job_X', stats, equity, trades, assumptions: { fees: { maker: '0.0002', taker: '0.0005' }, slippageBps: 3, fillModel: 'next-bar-open', funding: false, liquidation: false }, warnings: [] }
    let seen: unknown[] = []
    h.k.lab.forward = (async (...args: unknown[]) => { seen = args; return result }) as typeof h.k.lab.forward
    ;(h.k.gep as unknown as { conns: Map<string, unknown> }).conns.set('e', { engineId: 'e', state: 'ready', rpc: { call: async () => ({}) } })
    const r = (await call(a, { action: 'backtest_report', jobId: 'job_X' })).data
    expect(seen.slice(1, 3)).toEqual(['backtest.result', { jobId: 'job_X' }])
    for (const k of ['sharpe', 'totalReturnRatio', 'maxDrawdownRatio', 'finalEquity', 'fills', 'feesPaid']) expect(r.metrics[k], k).toBe((stats as Record<string, number>)[k])
    expect(r.markdown.trim().startsWith('#')).toBe(true)
    expect(r.markdown.length).toBeLessThanOrEqual(RESEARCH_LIMITS.reportMarkdownMaxChars)
    expect(Buffer.byteLength(JSON.stringify(r))).toBeLessThanOrEqual(RESEARCH_LIMITS.reportMaxBytes)
    expect(r.truncated).toBe(true)
    expect(r.headline).toMatch(/夏普|Sharpe|sharpe/i)
    const j = (await call(a, { action: 'backtest_report', jobId: 'job_X', format: 'json' })).data
    expect(j.markdown).toBeUndefined()
    expect(j.metrics.finalEquity).toBe(stats.finalEquity)
    // 大结果没有内联曲线 / 成交时：仍给出完整指标
    h.k.lab.forward = (async () => ({ ...result, equity: [], trades: [] })) as typeof h.k.lab.forward
    const slim = (await call(a, { action: 'backtest_report', jobId: 'job_X' })).data
    expect(slim.metrics.sharpe).toBe(stats.sharpe)
    expect(slim.markdown.trim().startsWith('#')).toBe(true)
  })
  it('backtest_report：回测作业的错误（不存在 / 没跑完）原样回给调用方，不回空报告', async () => {
    const a = await makeAgent(h, 'paper')
    ;(h.k.gep as unknown as { conns: Map<string, unknown> }).conns.set('e', { engineId: 'e', state: 'ready', rpc: { call: async () => ({}) } })
    await expect(call(a, { action: 'backtest_report', jobId: 'job_doesnotexist' })).rejects.toMatchObject({ problem: { name: expect.stringMatching(/EXPERIMENT_EVIDENCE_INCOMPLETE|INVALID_PARAMS/) } })
    await expect(call(a, { action: 'backtest_report' })).rejects.toMatchObject({ problem: { name: 'INVALID_PARAMS' } })
  })
})

describe('研究只读：不写任何账本条目', () => {
  it('跑完全部同步动作与转发动作，账本条数不变', async () => {
    const a = await makeAgent(h, 'paper')
    fakeEngine(true, () => ({ jobId: 'rsh_1', state: 'queued' }))
    const before = h.k.ledger.query({ limit: 10_000 }).length
    await call(a, { action: 'search', query: 'BTC' })
    await call(a, { action: 'portfolio' })
    await call(a, { action: 'optimize', spec: {} })
    await call(a, { action: 'status', jobId: 'rsh_1' })
    await call(a, { action: 'cancel', jobId: 'rsh_1' })
    expect(h.k.ledger.query({ limit: 10_000 }).length).toBe(before)
  })
})
