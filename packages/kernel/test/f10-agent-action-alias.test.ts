// SPDX-License-Identifier: CPAL-1.0
// ADR-22（A 半）：内核侧动作别名 —— 误写的动作名解析成正名（account get → summary），
// 不认识的给出正名清单与一行示例；别名只落在只读动作上，写动作照旧走级别检查。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { OrderIntent } from '../src/proto'
import { BTC } from './helpers/fake-connector'
import { enableLive, makeAgent, makeHarness } from './helpers/harness'
import type { Harness, TestAgent } from './helpers/harness'

let h: Harness
beforeEach(async () => { h = await makeHarness() })
afterEach(async () => { await h.cleanup() })

const RID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d'
interface Reply { data: any; session: any } // eslint-disable-line @typescript-eslint/no-explicit-any
const call = async (a: TestAgent, tool: string, params: Record<string, unknown> = {}): Promise<Reply> =>
  (await h.k.ops.call(h.k, `agent.${tool}`, { principal: a.principal, params: { requestId: RID, ...params }, transport: 'http' })) as Reply

interface Problemish { code: number; name: string; message: string }
/** 取内核 Problem（没报错就返回 null）。别名 / 提示文案的断言都走这一条。 */
const problemOf = (a: TestAgent, tool: string, params: Record<string, unknown> = {}): Promise<Problemish | null> =>
  call(a, tool, params).then(() => null, (e: { problem?: Problemish }) => e.problem ?? null)

const intentOf = (o: Partial<OrderIntent> = {}): OrderIntent =>
  ({ accountId: h.liveAcct.accountId as never, instrumentId: BTC, side: 'buy', type: 'market', size: '0.003' as never, leverage: 2, reason: 'funding flipped', ...o }) as OrderIntent

describe('动作别名解析成正名', () => {
  it('account get resolves to summary', async () => {
    const a = await makeAgent(h, 'paper')
    const viaAlias = await call(a, 'account', { action: 'get', accountId: h.paper.accountId })
    const viaName = await call(a, 'account', { action: 'summary', accountId: h.paper.accountId })
    // 时间类字段（ts）两次取值可能不同：比对键集合与账户字段，再比对其余非时间字段
    expect(Object.keys(viaAlias.data).sort()).toEqual(Object.keys(viaName.data).sort())
    expect(viaAlias.data.accountId).toBe(h.paper.accountId)
    expect(viaName.data.accountId).toBe(h.paper.accountId)
    const aliasRest: Record<string, unknown> = { ...viaAlias.data }
    const nameRest: Record<string, unknown> = { ...viaName.data }
    expect(typeof aliasRest.ts).toBe('number')
    delete aliasRest.ts
    delete nameRest.ts
    expect(aliasRest).toEqual(nameRest)
  })

  it('proposals status resolves to get', async () => {
    await enableLive(h)
    const a = await makeAgent(h, 'confirm')
    const p = await call(a, 'propose', { action: 'order', accountId: h.liveAcct.accountId, intents: [intentOf()], reason: 'funding flipped negative' })
    expect(p.data.status).toBe('pending')
    const byAlias = await call(a, 'proposals', { action: 'status', ticket: p.data.ticket })
    const byName = await call(a, 'proposals', { action: 'get', ticket: p.data.ticket })
    expect(byAlias.data.proposalId).toBe(p.data.proposalId)
    expect(byAlias.data).toEqual(byName.data)
  })
})

describe('未知 / 缺失动作的提示', () => {
  it('unknown action lists valid names and a suggestion', async () => {
    const a = await makeAgent(h, 'paper')
    const p = await problemOf(a, 'account', { action: 'summery' })
    expect(p).not.toBeNull()
    expect(p!.code).toBe(-32602)
    expect(p!.name).toBe('INVALID_PARAMS')
    expect(p!.message).toContain('(valid: list, summary,')
    expect(p!.message).toContain("Did you mean: summary → gitrader agent account summary --args '")
  })

  it('missing action shows an example', async () => {
    const a = await makeAgent(h, 'paper')
    const p = await problemOf(a, 'account', {})
    expect(p).not.toBeNull()
    expect(p!.code).toBe(-32602)
    expect(p!.message.startsWith('missing action for account (valid:')).toBe(true)
    expect(p!.message).toContain("Example: gitrader agent account list --args '")
  })
})

describe('别名只落在只读动作', () => {
  it('alias cannot reach a write action', async () => {
    const a = await makeAgent(h, 'paper')
    const before = h.k.ledger.query({ types: ['order.intent'] }).length
    const p = await problemOf(a, 'order', { action: 'submit' })
    expect(p).not.toBeNull()
    expect(p!.code).toBe(-32602)
    expect(p!.name).toBe('INVALID_PARAMS')
    expect(h.k.ledger.query({ types: ['order.intent'] }).length).toBe(before)
    expect(h.sim.submitted).toHaveLength(0)
  })
})
