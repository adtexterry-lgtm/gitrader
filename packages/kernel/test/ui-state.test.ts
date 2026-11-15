// SPDX-License-Identifier: CPAL-1.0
// 壳 / 块要的内核状态：risk.state.usage[]、account.summary.dayStartEquity、venue.reconnect、trading_state.resume（及旧别名）、session.link、授权书降级语义。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { validateAccountSummary, validateRiskStateSnapshot } from '../src/proto'
import { ORG_SCOPE } from '../src/trading-state'
import { BTC } from './helpers/fake-connector'
import { TEST_PIN, makeAgent, makeHarness } from './helpers/harness'
import type { Harness } from './helpers/harness'

let h: Harness
beforeEach(async () => { h = await makeHarness() })
afterEach(async () => { await h.cleanup() })
const q = (name: string, params: Record<string, unknown> = {}, pin?: string): Promise<any> => h.k.ops.call(h.k, name, { principal: h.session, params, transport: 'ws', ...(pin ? { pin } : {}) }) // eslint-disable-line @typescript-eslint/no-explicit-any
const mk = (o: Record<string, unknown> = {}): any => ({ accountId: h.paper.accountId, instrumentId: BTC, side: 'buy', type: 'market', size: '0.01', leverage: 2, ...o }) // eslint-disable-line @typescript-eslint/no-explicit-any

describe('risk.state.usage / account.summary.dayStartEquity（protocol v0.1.6 载荷）', () => {
  it('usage 项带 key / used / limit / unit / ratio / scope / window，随下单增长；整份快照过 protocol 校验器', async () => {
    await h.pinProof()
    h.k.risk.tighten({ limits: { maxDailyOrders: 10 } as never }, h.sessionProof(), h.human().origin)
    await h.k.trading.place({ intent: mk() }, h.human())
    const st = await q('risk.state')
    const get = (key: string) => st.usage.find((u: any) => u.key === key && u.scope === 'account:paper') // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(get('maxDailyOrders')).toMatchObject({ used: '1', limit: '10', unit: 'count', ratio: '0.1', window: 'day' })
    expect(get('maxLeverage')).toMatchObject({ used: '2', limit: '3', unit: 'x', window: 'now' })
    expect(get('maxOpenPositions')).toMatchObject({ used: '1', limit: '3' })
    expect(get('maxPositionNotionalRatio')).toMatchObject({ used: '0.08', limit: '0.3', unit: 'ratio' })
    expect(get('maxDailyNotional')).toBeUndefined() // 没设上限的维度不报
    expect(get('maxOrdersPerMinute')).toMatchObject({ used: '1', limit: '30', window: 'minute' })
    for (const u of st.usage) expect(typeof u.used).toBe('string')
    expect(validateRiskStateSnapshot({ tradingState: st.tradingState, reasons: st.reasons, policyVersion: st.policyVersion, denyLlmLiveEntries: st.denyLlmLiveEntries, usage: st.usage, ts: st.ts }).ok).toBe(true)
  })

  it('account.summary 带 dayStartEquity：当日首次建立，之后不随权益变；换日重新建立', async () => {
    const a = await q('account.summary', { accountId: h.paper.accountId })
    expect(a.dayStartEquity).toBe('10000')
    const { D } = await import('../src/util/dec')
    h.sim.equity = D('9800')
    const b = await q('account.summary', { accountId: h.paper.accountId })
    expect(b).toMatchObject({ equity: '9800', dayStartEquity: '10000' })
    expect(validateAccountSummary(b).ok).toBe(true)
    h.clock.advance(26 * 3600_000)
    expect((await q('account.summary', { accountId: h.paper.accountId })).dayStartEquity).toBe('9800')
  })
})

describe('venue.reconnect / trading_state.resume / session.link', () => {
  it('venue.reconnect：立刻重试后台连接（退避从头算）；没有后台连接的场所报不支持', async () => {
    let n = 0
    h.k.connectInBackground('hyperliquid', async () => { n++; if (n === 1) throw new Error('down') }, { backoffMinMs: 60_000 })
    for (let i = 0; i < 100 && h.k.connectionStatus()[0]?.state !== 'disconnected'; i++) await new Promise((r) => setTimeout(r, 20))
    expect(h.k.connectionStatus()[0]!.state).toBe('disconnected')
    await q('venue.reconnect', { venue: 'hyperliquid' })
    for (let i = 0; i < 100 && h.k.connectionStatus()[0]?.state !== 'connected'; i++) await new Promise((r) => setTimeout(r, 20))
    expect(h.k.connectionStatus()[0]!.state).toBe('connected')
    expect(n).toBe(2)
    await expect(q('venue.reconnect', { venue: 'nowhere' })).rejects.toMatchObject({ problem: { code: 5002 } })
  })

  it('trading_state.resume 是正名（要 PIN），risk.resume 是旧名别名', async () => {
    await h.pinProof()
    for (const name of ['trading_state.resume', 'risk.resume']) {
      h.k.tstate.set(ORG_SCOPE, 'REDUCING', 'test', h.human().origin)
      await expect(q(name, { scope: { type: 'org' } })).rejects.toMatchObject({ problem: { code: 1010 } })
      await q(name, { scope: { type: 'org' } }, TEST_PIN)
      expect(h.k.tstate.get(ORG_SCOPE)).toBe('ACTIVE')
    }
  })

  it('session.link：要 PIN 在场；返回带一次性启动令牌的本地 URL，用一次作废；Agent 调不了', async () => {
    await h.pinProof()
    await h.k.start({ port: 0 })
    await expect(q('session.link')).rejects.toMatchObject({ problem: { code: 1010 } })
    const r = await q('session.link', {}, TEST_PIN)
    const url = new URL(r.url)
    expect(url.hostname).toBe('127.0.0.1')
    const t = url.searchParams.get('launch')!
    expect(t).toMatch(/^boot_/)
    expect(r.ttlSec).toBe(120)
    expect(h.k.auth.exchangeBoot(t).sessionToken).toMatch(/^ses_/)
    expect(() => h.k.auth.exchangeBoot(t)).toThrow()
    const a = await makeAgent(h, 'paper')
    await expect(h.k.ops.call(h.k, 'session.link', { principal: a.principal, params: {}, transport: 'http', pin: TEST_PIN })).rejects.toMatchObject({ problem: { code: 5003 } })
  })
})

describe('授权书降级语义', () => {
  it('downgraded = 降到更低一级且仍然有效（level 就是降级后的那一级）；expired / revoked 才视同 L0；到期照样会被 tick 处理', async () => {
    const a = await makeAgent(h, 'confirm')
    const sys = h.human('mandate.downgrade').origin
    h.k.agents.downgrade(a.mandate.mandateId, 'L1', 'self protect', sys)
    expect(h.k.agents.getMandate(a.mandate.mandateId)).toMatchObject({ level: 'L1', status: 'downgraded' })
    expect(h.k.agents.effective(a.mandate.mandateId)).toMatchObject({ level: 'L1', status: 'downgraded' })
    const r = await h.k.trading.place({ intent: mk({ reason: 'x', size: '0.005' }) }, a.ctx())
    expect(r.order?.status).toBe('filled') // 降级后仍是纸面可用
    h.clock.advance(31 * 86_400_000)
    h.k.agents.tick()
    expect(h.k.agents.effective(a.mandate.mandateId)!.level).toBe('L0')
    expect(h.k.agents.getMandate(a.mandate.mandateId)!.status).toBe('expired')
  })
})
