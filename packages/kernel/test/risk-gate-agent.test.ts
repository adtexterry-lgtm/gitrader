// SPDX-License-Identifier: CPAL-1.0
import { afterEach, describe, expect, it } from 'vitest'
import { makeAgent, makeHarness } from './helpers/harness'
import type { Harness } from './helpers/harness'
import type { Account } from '../src/proto'
import { BTC } from './helpers/fake-connector'
import { mkOrigin } from '../src/util/origin'
import { newClientOrderId, newRequestId } from '../src/util/ids'

let h: Harness | undefined
afterEach(async () => { await h?.cleanup() })

describe('agent risk gate surfaces', () => {
  it('includes account group HALTED state in risk_status', async () => {
    h = await makeHarness()
    const agent = await makeAgent(h, 'paper')
    const groupId = 'grp_gate_status'
    const accounts = (h.k.accounts as unknown as { byId: Map<string, Account> }).byId
    accounts.set(h.paper.accountId, { ...h.paper, groupIds: [groupId] })
    h.k.tstate.set({ type: 'group', id: groupId }, 'HALTED', 'group maintenance', mkOrigin('user:usr_local', 'risk.state', 'ui'))
    const result = await h.k.ops.call(h.k, 'agent.risk_status', { principal: agent.principal, params: { requestId: newRequestId(), action: 'state' }, transport: 'http' }) as { data: { tradingState: string; reasons: Array<{ scope: { type: string; id: string }; state: string }> } }
    expect(result.data.tradingState).toBe('HALTED')
    expect(result.data.reasons).toContainEqual(expect.objectContaining({ scope: { type: 'group', id: groupId }, state: 'HALTED' }))
  })

  it('returns the signed GateDecision fields from order preview unchanged', async () => {
    h = await makeHarness()
    const agent = await makeAgent(h, 'paper')
    let signedDecision: unknown
    const decide = h.k.gate.decide.bind(h.k.gate)
    h.k.gate.decide = ((input) => { const decision = decide(input); signedDecision = decision; return decision }) as typeof h.k.gate.decide
    const result = await h.k.ops.call(h.k, 'agent.order', { principal: agent.principal, params: {
      requestId: newRequestId(), action: 'preview', intent: { accountId: h.paper.accountId, instrumentId: BTC, side: 'buy', type: 'limit', size: '0.001', price: '80000', tif: 'gtc', clientOrderId: newClientOrderId(), reason: 'preview gate fields' },
    }, transport: 'http' }) as { data: { precheck: unknown } }
    expect(result.data.precheck).toEqual(signedDecision)
    expect(result.data.precheck).toMatchObject({ decision: 'ALLOW', allowedActions: expect.any(Object), applied: [], attestation: { sig: expect.any(String) } })
  })
})
