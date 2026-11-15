// SPDX-License-Identifier: CPAL-1.0
// 待批卡片带出内核的 approvalNeedsPin；字段缺失（老内核）时批准键仍画锁。
import { describe, expect, it } from 'vitest'
import { ACCT_LIVE, NOW, O_CLAUDE } from '../fixtures/scenarios'
import { showsApproveLock, toPending } from '../src/model-activity'

const intent = (): Record<string, unknown> => ({
  accountId: ACCT_LIVE, instrumentId: 'hyperliquid:BTC', side: 'buy', type: 'limit', size: '0.5', price: '64300', tif: 'gtc', reason: '按计划建仓',
})

const proposalOf = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  proposalId: 'prop_pin_1', ticket: 'T-PIN-1', kind: 'order', status: 'pending', accountId: ACCT_LIVE,
  intents: [intent()], intentsDigest: 'sha256:00', reason: '批准要不要 PIN',
  precheck: { precheckId: 'pck_pin_1', verdict: 'review', policyVersion: 3, ruleHits: [], estimates: {}, expiresAt: NOW + 60_000 },
  expiresAt: NOW + 60_000, decision: null, execution: null, origin: O_CLAUDE,
  ...extra,
})

describe('待批卡片的 approvalNeedsPin', () => {
  it('pending card carries approvalNeedsPin', () => {
    expect(toPending(proposalOf({ approvalNeedsPin: false }))!.approvalNeedsPin).toBe(false)
    expect(showsApproveLock(toPending(proposalOf({ approvalNeedsPin: false }))!)).toBe(false)
    expect(toPending(proposalOf({ approvalNeedsPin: true }))!.approvalNeedsPin).toBe(true)
    expect(showsApproveLock(toPending(proposalOf({ approvalNeedsPin: true }))!)).toBe(true)
    // 非布尔值忽略（不写进卡片）
    expect(toPending(proposalOf({ approvalNeedsPin: 'yes' }))!.approvalNeedsPin).toBeUndefined()
  })

  it('missing flag keeps lock for old kernels', () => {
    const card = toPending(proposalOf())!
    expect(card.approvalNeedsPin).toBeUndefined()
    expect(showsApproveLock(card)).toBe(true)
  })
})
