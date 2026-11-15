// SPDX-License-Identifier: CPAL-1.0
// 提案视图（proposal.list / proposal.get）追加 approvalNeedsPin：纸面账户批准不用 PIN；实盘或名义超过 presenceAboveNotional 才要。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { OrderIntent } from '../src/proto'
import { BTC } from './helpers/fake-connector'
import { makeAgent, makeHarness } from './helpers/harness'
import type { Harness } from './helpers/harness'

let h: Harness
beforeEach(async () => { h = await makeHarness() })
afterEach(async () => { await h.cleanup() })

const paperIntent = (size = '0.003'): OrderIntent =>
  ({ accountId: h.paper.accountId, instrumentId: BTC, side: 'buy', type: 'market', size, leverage: 2, reason: 'needs pin view' } as OrderIntent)

type ProposalView = { proposalId: string; approvalNeedsPin?: boolean }

const listView = async (): Promise<ProposalView[]> =>
  (await h.k.ops.call(h.k, 'proposal.list', { principal: h.session, params: {}, transport: 'ws' })) as ProposalView[]

const getView = async (id: string): Promise<ProposalView | null> =>
  (await h.k.ops.call(h.k, 'proposal.get', { principal: h.session, params: { id }, transport: 'ws' })) as ProposalView | null

describe('E0-7 提案视图的 approvalNeedsPin', () => {
  it('paper proposal view says no pin needed', async () => {
    const agent = await makeAgent(h, 'confirm') // limits.maxOrderNotional 500 → presenceAboveNotional 500
    const p = await h.k.trading.propose({ accountId: h.paper.accountId, intents: [paperIntent()], reason: 'paper below threshold' }, agent.ctx('propose'))
    expect(p.status).toBe('pending')
    expect(h.k.trading.approvalNeedsPin(p.proposalId)).toBe(false)

    const list = await listView()
    expect(list.find((x) => x.proposalId === p.proposalId)?.approvalNeedsPin).toBe(false)
    const one = await getView(p.proposalId)
    expect(one?.proposalId).toBe(p.proposalId)
    expect(one?.approvalNeedsPin).toBe(false)
    // 其它字段原样带出
    expect(one && 'ticket' in one).toBe(true)
    expect(await getView('prop_missing')).toBeNull()
  })

  it('live or over-threshold proposal view says pin needed', async () => {
    // 夹具：名义额超过该授权书的 presenceAboveNotional（纸面账户，同样的判定分支）
    const agent = await makeAgent(h, 'confirm', { approval: { presenceAboveNotional: '100' } as never })
    const p = await h.k.trading.propose({ accountId: h.paper.accountId, intents: [paperIntent()], reason: 'over threshold' }, agent.ctx('propose'))
    expect(p.status).toBe('pending')
    expect(h.k.trading.approvalNeedsPin(p.proposalId)).toBe(true)

    const list = await listView()
    expect(list.find((x) => x.proposalId === p.proposalId)?.approvalNeedsPin).toBe(true)
    const one = await getView(p.proposalId)
    expect(one?.proposalId).toBe(p.proposalId)
    expect(one?.approvalNeedsPin).toBe(true)
  })
})
