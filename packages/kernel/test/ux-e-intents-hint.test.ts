// SPDX-License-Identifier: CPAL-1.0
// UX-E0-ds1：order.preview 收到 intents（propose 的写法）却没有 intent 时，报错直接指路到 propose.order。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BTC } from './helpers/fake-connector'
import { makeAgent, makeHarness } from './helpers/harness'
import type { Harness } from './helpers/harness'

let h: Harness
beforeEach(async () => { h = await makeHarness() })
afterEach(async () => { await h.cleanup() })
const RID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d'

describe('order 收到 intents 没有 intent', () => {
  it('preview：仍是 INVALID_PARAMS，文案点名 intent 与 propose.order', async () => {
    const a = await makeAgent(h, 'paper')
    const params = { requestId: RID, action: 'preview', accountId: h.paper.accountId, intents: [{ accountId: h.paper.accountId, instrumentId: BTC, side: 'buy', type: 'market', size: '0.003', reason: 't' }] }
    const e = await h.k.ops.call(h.k, 'agent.order', { principal: a.principal, params, transport: 'http' }).then(() => null, (x: { problem?: { name: string; message: string } }) => x.problem ?? null)
    expect(e?.name).toBe('INVALID_PARAMS')
    expect(e?.message).toContain('intent is required')
    expect(e?.message).toContain('propose.order')
    expect(e?.message).toContain('"intents"')
  })
})
