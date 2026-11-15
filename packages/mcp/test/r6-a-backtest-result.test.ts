// SPDX-License-Identifier: CPAL-1.0
// R1-PERF-02：backtest result 万一仍超 MCP 单次上限，先删 pack、再删 artifacts，stats / biasChecks / assumptions / counts / warnings 一律保留，
// 不再整体换成 {truncated:true}；其他工具（如 ledger）的通用截断不变。
import { describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { mcpToolsForLevel } from '@gitrader/protocol'
import { createGitraderMcp } from '../src/server'
import type { SessionInfo } from '../src/server'
import type { KernelReply } from '../src/client'

const session: SessionInfo = { keyId: 'ak_TEST', mandateId: 'mdt_TEST', level: 'L1', tier: 'x', status: 'active', allowAgentLayout: false, tools: mcpToolsForLevel('L1').map((t) => t.name) }
const summary = (extra: Record<string, unknown> = {}) => ({
  jobId: 'job_1', runId: 'run_1', specDigest: 'sha256:' + 'a'.repeat(64), dataDigest: 'sha256:' + 'b'.repeat(64),
  stats: { trades: 12, fills: 24, finalEquity: 10_432.5, sharpe: 1.2 },
  biasChecks: { lookahead: 'passed', recursive: 'not_run' },
  assumptions: { fees: { maker: '0.00015', taker: '0.00045' }, slippageBps: 2, fillModel: 'next-bar-open', funding: false, liquidation: false },
  warnings: ['equity and trades were delivered as artifacts'],
  counts: { equity: 26_280, trades: 24, funding: 0 },
  engine: { id: 'gitrader-core', version: '0.1.0' },
  ...extra,
})

function fakeKernel(data: unknown) {
  return {
    async call(op: string): Promise<KernelReply> {
      if (op === 'agent.session') return { ok: true, result: session }
      return { ok: true, result: { data, session } }
    },
  }
}
async function call(data: unknown, name: string, args: Record<string, unknown>, maxResultChars: number) {
  const mcp = createGitraderMcp({ client: fakeKernel(data), newRequestId: () => '11111111-2222-4333-8444-555555555555', maxResultChars })
  const [a, b] = InMemoryTransport.createLinkedPair()
  const host = new Client({ name: 'h', version: '0' }, { capabilities: {} })
  await mcp.refreshSession()
  await mcp.server.connect(b)
  await host.connect(a)
  const r = await host.callTool({ name, arguments: args })
  return JSON.parse((r.content as { text: string }[])[0]!.text) as Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
}

describe('R1-PERF-02 backtest result 的超限兜底', () => {
  it('超限：先删 pack 再删 artifacts，stats / biasChecks / assumptions / counts / warnings 全在，没有 truncated', async () => {
    const big = summary({ pack: { blob: 'p'.repeat(4000) }, artifacts: [{ artifactId: 'art_1', kind: 'equity' }, { artifactId: 'art_2', kind: 'trades' }] })
    const r = await call(big, 'backtest', { action: 'result', jobId: 'job_1' }, 700)
    expect(r.truncated).toBeUndefined()
    expect(r.pack).toBeUndefined()
    expect(r.artifacts).toBeUndefined()
    expect(r.stats).toMatchObject({ trades: 12, finalEquity: 10_432.5 })
    expect(r.counts).toEqual({ equity: 26_280, trades: 24, funding: 0 })
    expect(r.biasChecks).toBeDefined()
    expect(r.assumptions).toBeDefined()
    expect(r.warnings).toHaveLength(1)
  })

  it('只删 pack 就够了：artifacts 留着', async () => {
    const big = summary({ pack: { blob: 'p'.repeat(4000) }, artifacts: [{ artifactId: 'art_1', kind: 'equity' }] })
    const r = await call(big, 'backtest', { action: 'result', jobId: 'job_1' }, 2200)
    expect(r.pack).toBeUndefined()
    expect(r.artifacts).toHaveLength(1)
    expect(r.stats).toBeDefined()
  })

  it('删到只剩核心字段仍超限：照样给 stats 与 counts（宁可超一点，不丢数字）', async () => {
    const r = await call(summary(), 'backtest', { action: 'result', jobId: 'job_1' }, 50)
    expect(r.truncated).toBeUndefined()
    expect(r.stats).toBeDefined()
    expect(r.counts).toBeDefined()
  })

  it('没超限时原样给（pack 与 artifacts 都在）', async () => {
    const r = await call(summary({ pack: { a: 1 }, artifacts: [{ artifactId: 'art_1', kind: 'equity' }] }), 'backtest', { action: 'result', jobId: 'job_1' }, 60_000)
    expect(r.pack).toEqual({ a: 1 })
    expect(r.artifacts).toHaveLength(1)
  })

  it('分页的 items 页超限（不是带 stats 的摘要）仍走通用截断；其他工具（ledger）照旧截断', async () => {
    const page = await call({ items: Array.from({ length: 200 }, (_, i) => ({ t: i, v: i })), total: 200 }, 'backtest', { action: 'result', jobId: 'job_1', part: 'equity' }, 100)
    expect(page.truncated).toBe(true)
    const ledger = await call({ blob: 'x'.repeat(500), stats: { n: 1 } }, 'ledger', { action: 'query' }, 100)
    expect(ledger).toMatchObject({ truncated: true })
    expect(ledger.stats).toBeUndefined()
  })

})
