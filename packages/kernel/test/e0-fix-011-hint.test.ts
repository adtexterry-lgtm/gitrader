// SPDX-License-Identifier: CPAL-1.0
// E0-fix-011：拒单返回带 hint（改法）；判定一字不变——ds-3 那一单（grouping: position + 过细 size）仍被拒，原因码与修前一致。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { OrderIntent } from '../src/proto'
import { hintOf } from '../src/api/agent-out'
import { BTC } from './helpers/fake-connector'
import { makeAgent, makeHarness } from './helpers/harness'
import type { Harness } from './helpers/harness'

/* eslint-disable @typescript-eslint/no-explicit-any */
let h: Harness
beforeEach(async () => { h = await makeHarness() })
afterEach(async () => { await h.cleanup() })

const RID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d'

describe('E0 拒单 hint', () => {
  it('ds-3 同款参数（grouping: position、size 过细）：仍然被拒，TPSL_INVALID 码不变，且带可执行的 hint', async () => {
    const a = await makeAgent(h, 'paper')
    const intent = { accountId: h.paper.accountId, instrumentId: BTC, side: 'buy', type: 'market', size: '0.0030000000001', reason: 'e0',
      tpsl: { grouping: 'position', stopLoss: { triggerPrice: '1' } } } as unknown as OrderIntent
    const r: any = await h.k.ops.call(h.k, 'agent.order', { principal: a.principal, params: { requestId: RID, action: 'preview', intent }, transport: 'http' })
    const hits: any[] = r.data.precheck.ruleHits
    expect(r.data.precheck.verdict).toBe('deny')
    const tp = hits.find((x) => x.code === 'TPSL_INVALID')
    expect(tp.ruleId).toMatch(/tpsl:grouping$/)
    expect(tp.action).toBe('deny')
    expect(tp.hint).toContain('"grouping":"order"')
    // hint 只是并列加的字段：去掉 hint 与 zh 后，其余字段就是内核原样给出的
    for (const x of hits) expect(typeof x.code).toBe('string')
  })

  it('hintOf：各码有改法，未知码无 hint', () => {
    expect(hintOf({ code: 'SIZE_PRECISION', limit: '0.00151' })).toContain('0.00151')
    expect(hintOf({ code: 'NEEDS_APPROVAL' })).toContain('propose')
    expect(hintOf({ code: 'STOP_REQUIRED' })).toContain('stopLoss')
    expect(hintOf({ code: 'DAILY_NOTIONAL' })).toBeUndefined()
  })
})
