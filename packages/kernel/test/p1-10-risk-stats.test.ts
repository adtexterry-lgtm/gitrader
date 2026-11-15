// SPDX-License-Identifier: CPAL-1.0
import { afterEach, describe, expect, it } from 'vitest'
import { makeHarness } from './helpers/harness'
import type { Harness } from './helpers/harness'
import { mkOrigin } from '../src/util/origin'
import type { RuleCode } from '../src/proto'

let h: Harness | undefined
afterEach(async () => { await h?.cleanup() })

const hit = (code: RuleCode) => ({
  ruleId: `pol_1#${code}`, code, limit: '1' as never, actual: '2' as never, unit: 'x', action: 'deny' as const, scope: 'account',
})

const appendGate = (harness: Harness, actor: string, clientOrderId: string, verdict: 'deny' | 'review', codes: RuleCode[], path = 'direct'): void => {
  harness.k.ledger.append({
    type: 'annotation',
    origin: mkOrigin(actor as never, 'test.gate', 'internal'),
    subject: { accountId: 'acct_test' as never, clientOrderId },
    payload: { gate: { decision: { verdict, ruleHits: codes.map(hit), targetDigest: `sha256:${clientOrderId}` }, snapshot: { dryRun: false, path } } },
  })
}

describe('risk stats by actor and rule', () => {
  it('keeps the old totals', async () => {
    h = await makeHarness()
    appendGate(h, 'agent:key_a', 'c1', 'deny', ['DAILY_LOSS'])
    appendGate(h, 'agent:key_a', 'c1', 'deny', ['ORDER_NOTIONAL'])
    appendGate(h, 'agent:key_b', 'c2', 'review', ['NEEDS_APPROVAL'])
    appendGate(h, 'agent:key_b', 'c3', 'deny', ['STALE_PRICE'], 'ask')
    const stats = h.k.risk.stats()
    expect(stats.denied).toBe(1)
    expect(stats.review).toBe(1)
    expect(stats.deduplicatedBy).toBe('accountId+clientOrderId')
    expect(stats.byRule).toEqual({ DAILY_LOSS: 1, NEEDS_APPROVAL: 1 })
  })

  it('buckets by actor and rule', async () => {
    h = await makeHarness()
    appendGate(h, 'agent:key_a', 'a1', 'deny', ['DAILY_LOSS', 'DAILY_LOSS', 'ORDER_NOTIONAL'])
    appendGate(h, 'agent:key_a', 'a2', 'deny', ['DAILY_LOSS'])
    appendGate(h, 'agent:key_b', 'b1', 'deny', ['STALE_PRICE'])
    appendGate(h, 'agent:key_b', 'b2', 'review', ['NEEDS_APPROVAL'])
    const stats = h.k.risk.stats()
    expect(stats.byActor['agent:key_a']).toEqual({ denied: 2, review: 0, rules: { DAILY_LOSS: 2, ORDER_NOTIONAL: 1 } })
    expect(stats.byActor['agent:key_b']).toEqual({ denied: 1, review: 1, rules: { STALE_PRICE: 1, NEEDS_APPROVAL: 1 } })
    expect(stats.byRule).toEqual({ DAILY_LOSS: 2, ORDER_NOTIONAL: 1, STALE_PRICE: 1, NEEDS_APPROVAL: 1 })
  })
})
