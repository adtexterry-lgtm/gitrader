// SPDX-License-Identifier: CPAL-1.0
// fix-r2 K1（R3-01）：活动流按证据写——意图只写「计划挂止损」；子单 order.accepted 才写「止损已挂上」；重启后补挂写「止损已补挂」。
import { describe, expect, it } from 'vitest'
import { ACCT_LIVE, NOW, O_CLAUDE, entry } from '../fixtures/scenarios'
import { entryToActivity, ACTIVITY_TYPES } from '../src/model-activity'

const subject = { accountId: ACCT_LIVE as never, instrumentId: 'hyperliquid:BTC' }
const intent = { accountId: ACCT_LIVE, instrumentId: 'hyperliquid:BTC', side: 'buy', type: 'market', size: '0.001', reason: 'k1', tpsl: { grouping: 'order', stopLoss: { triggerPrice: '78000' } } }

describe('K1 activity wording follows evidence', () => {
  it('no sl child → 计划挂止损', () => {
    const it = entryToActivity(entry(401, 'order.intent', O_CLAUDE, subject, { intent }, NOW))!
    expect(it.what).toContain('计划挂止损 78,000')
    expect(it.what).not.toMatch(/(^|，)挂止损/)
  })

  it('sl child accepted → 止损已挂上', () => {
    const it = entryToActivity(entry(402, 'order.accepted', O_CLAUDE, subject, { parentOrderId: 'ord_x', tpslRole: 'sl', status: 'untriggered', venueOrderId: 'sim-000002' }, NOW))!
    expect(it.what).toBe('止损已挂上')
    expect(it.result).toEqual({ label: '已挂上', tone: 'ok' })
  })

  it('protective stop re-placed after restart → 止损已补挂', () => {
    const origin = { actor: 'system:kernel', actorType: 'system', tool: 'startup:protect', requestId: '11111111-2222-4333-8444-555555555555', via: 'internal' }
    const it = entryToActivity(entry(403, 'order.accepted', origin as never, subject, { status: 'untriggered', venueOrderId: 'sim-000003' }, NOW))!
    expect(it.what).toMatch(/^止损已补挂/)
  })

  it('plain order acceptance stays out of the feed', () => {
    expect(ACTIVITY_TYPES).toContain('order.accepted')
    expect(entryToActivity(entry(404, 'order.accepted', O_CLAUDE, subject, { status: 'filled', venueOrderId: 'sim-000004' }, NOW))).toBeNull()
  })
})
