// SPDX-License-Identifier: CPAL-1.0
// portfolio.analysis（WP-I I-5a）：一个口径下全部账户的持仓 → 场所 / 策略 / 标的；只读、不写账本、实盘纸面不合并。
// engine.catalog 的用例在 b2-views-engine-lab.test.ts（复用那里的 RPC 假引擎）。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeAgent, makeHarness, type Harness } from './helpers/harness'
import { BTC } from './helpers/fake-connector'

let h: Harness
beforeEach(async () => { h = await makeHarness() })
afterEach(async () => { await h.cleanup() })

const view = (params: Record<string, unknown>, principal = h.session) => h.k.ops.call(h.k, 'portfolio.analysis', { principal, params, transport: 'ws', kind: 'query' }) as Promise<any>
async function buy(instrumentId: string, size: string): Promise<void> {
  const a = await makeAgent(h, 'paper', { accounts: [h.paper.accountId] as never })
  await h.k.ops.call(h.k, 'agent.order', { principal: a.principal, params: { action: 'place', intent: { accountId: h.paper.accountId, instrumentId, side: 'buy', type: 'market', size, leverage: 2, reason: 'portfolio view test' } }, transport: 'http' })
}

describe('portfolio.analysis', () => {
  it('rolls up paper positions by venue, strategy and instrument with decimal strings', async () => {
    await buy(BTC, '0.003')
    const r = await view({ scope: 'paper' })
    expect(r).toMatchObject({ scope: 'paper', accounts: 1, missing: [] })
    expect(r.scopes).toEqual(['live', 'paper'])
    expect(r.byVenue.length).toBeGreaterThan(0)
    expect(r.byInstrument).toMatchObject([{ key: BTC, weight: expect.stringMatching(/^1(.0+)?$/) }])
    expect(r.byStrategy).toMatchObject([{ key: 'unassigned' }])
    for (const b of [...r.byVenue, ...r.byInstrument]) { expect(typeof b.exposure).toBe('string'); expect(typeof b.weight).toBe('string') }
    expect(typeof r.gross).toBe('string')
    expect(JSON.stringify(r)).not.toMatch(/\d\.\d{17}/)
  })

  it('never mixes live and paper accounts (反例)', async () => {
    await buy(BTC, '0.003')
    const live = await view({ scope: 'live' })
    expect(live.scope).toBe('live')
    expect(live.byInstrument).toEqual([])
    await expect(view({ scope: 'both' })).rejects.toMatchObject({ problem: { name: 'INVALID_PARAMS' } })
  })

  it('returns unavailable + the raw reason instead of throwing when nothing can be valued (反例)', async () => {
    const pos = { accountId: h.liveAcct.accountId, instrumentId: 'hyperliquid:NOPE', side: 'long', size: '1', entryPrice: '10', markPrice: '10', unrealizedPnl: '0', leverage: 1, ts: h.clock.now() }
    h.live.positions.set(h.liveAcct.accountId, [pos as never])
    const r = await view({ scope: 'live' })
    expect(r).toMatchObject({ unavailable: true })
    expect(r.details[0]).toMatch(/^unknown_instrument: hyperliquid:NOPE/)
  })

  it('an empty paper scope is an empty analysis, not an error', async () => {
    const r = await view({ scope: 'paper' })
    expect(r).toMatchObject({ scope: 'paper', byVenue: [], byStrategy: [], byInstrument: [], missing: [] })
  })

  it('is human-only and does not write the ledger', async () => {
    await buy(BTC, '0.003')
    const agent = await makeAgent(h, 'read_only')
    await expect(view({}, agent.principal)).rejects.toMatchObject({ problem: { name: 'AUTH_FAILED' } })
    const before = h.k.ledger.query({ limit: 10_000 }).length
    await view({})
    expect(h.k.ledger.query({ limit: 10_000 }).length).toBe(before)
  })
})
