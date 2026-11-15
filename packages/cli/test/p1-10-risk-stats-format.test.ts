// SPDX-License-Identifier: CPAL-1.0
import { describe, expect, it } from 'vitest'
import { formatRiskStats } from '../src/risk-stats'
import type { RiskStats } from '../../kernel/src/risk'

const stats: RiskStats = {
  denied: 4,
  review: 1,
  deduplicatedBy: 'accountId+clientOrderId',
  byActor: {
    'agent:key_a': { denied: 2, review: 0, rules: { DAILY_LOSS: 2 } },
    'agent:key_b': { denied: 2, review: 1, rules: { ORDER_NOTIONAL: 2, NEEDS_APPROVAL: 1 } },
  },
  byRule: { DAILY_LOSS: 1, ORDER_NOTIONAL: 3, STALE_PRICE: 2 },
}

describe('risk stats chinese formatting', () => {
  it('formats by actor in chinese', () => {
    const out = formatRiskStats(stats, 'actor', { 'agent:key_a': '交易助手', 'agent:key_b': '研究助手' })
    expect(out).toContain('交易助手：拦 2（日亏上限 2）· 转人工 0')
    expect(out).toContain('研究助手：拦 2（单笔上限 2、需人批准 1）· 转人工 1')
    expect(out.indexOf('研究助手')).toBeLessThan(out.indexOf('交易助手'))
  })

  it('formats by rule sorted', () => {
    expect(formatRiskStats(stats, 'rule', {})).toBe('单笔上限：3\n行情陈旧：2\n日亏上限：1')
  })
})
