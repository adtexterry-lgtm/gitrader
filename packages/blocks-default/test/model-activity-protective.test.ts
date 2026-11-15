// SPDX-License-Identifier: CPAL-1.0
// 保护单文案（P1-5）：挂 / 改 / 触发止损；接管结果写「已撤 N 张，保留止损 M 张」；字段缺失回到原文案。
import { describe, expect, it } from 'vitest'
import { ACCT_LIVE, NOW, O_CLAUDE, entry } from '../fixtures/scenarios'
import { entryToActivity } from '../src/model-activity'

describe('保护单文案', () => {
  it('stop order intent says place stop', () => {
    const stop = entryToActivity(entry(401, 'order.intent', O_CLAUDE, { accountId: ACCT_LIVE as never, instrumentId: 'hyperliquid:BTC' }, {
      intent: { accountId: ACCT_LIVE, instrumentId: 'hyperliquid:BTC', side: 'sell', type: 'stop_market', size: '0.01', triggerPrice: '68000', reduceOnly: true },
    }, NOW))!
    expect(stop.what).toBe('挂止损 68,000')
    expect(stop.result).toEqual({ label: '通过预检', tone: 'ok' })
    const take = entryToActivity(entry(402, 'order.intent', O_CLAUDE, { accountId: ACCT_LIVE as never, instrumentId: 'hyperliquid:BTC' }, {
      intent: { accountId: ACCT_LIVE, instrumentId: 'hyperliquid:BTC', side: 'sell', type: 'limit', size: '0.01', triggerPrice: '72000', tpslRole: 'tp' },
    }, NOW))!
    expect(take.what).toBe('挂止盈 72,000')
    const amended = entryToActivity(entry(403, 'order.amended', O_CLAUDE, { accountId: ACCT_LIVE as never, orderId: 'ord_1' as never }, {
      before: { size: '0.01', triggerPrice: '68000' }, after: { size: '0.02', triggerPrice: '67500' },
    }, NOW))!
    expect(amended.what).toBe('改止损 67,500')
  })

  it('stop fill says stop triggered', () => {
    const stop = entryToActivity(entry(411, 'fill', O_CLAUDE, { accountId: ACCT_LIVE as never, instrumentId: 'hyperliquid:BTC' }, {
      price: '68000', size: '0.01', side: 'sell', tpslRole: 'sl',
    }, NOW))!
    expect(stop.what).toBe('止损触发成交 0.01 @ 68,000')
    expect(stop.result).toEqual({ label: '已成交', tone: 'ok' })
    const take = entryToActivity(entry(412, 'fill', O_CLAUDE, { accountId: ACCT_LIVE as never, instrumentId: 'hyperliquid:BTC' }, {
      price: '72000', size: '0.02', side: 'sell', type: 'take_limit',
    }, NOW))!
    expect(take.what).toBe('止盈触发成交 0.02 @ 72,000')
  })

  it('takeover result mentions kept stops', () => {
    const kept = entryToActivity(entry(421, 'takeover.completed', O_CLAUDE, { orgId: 'org_local' as never }, {
      level: 'cancel_all', cancelled: 2, keptProtective: 1,
    }, NOW))!
    expect(kept.what).toContain('已撤 2 张，保留止损 1 张')
    expect(kept.result).toEqual({ label: '已完成', tone: 'ok' })
    const none = entryToActivity(entry(422, 'takeover.applied', O_CLAUDE, { orgId: 'org_local' as never }, {
      level: 'cancel_all', cancelled: 3, keptProtective: 0,
    }, NOW))!
    expect(none.what).toContain('已撤 3 张')
    expect(none.what).not.toContain('保留止损')
  })

  it('missing fields fall back to old text', () => {
    const plain = entryToActivity(entry(431, 'order.intent', O_CLAUDE, { accountId: ACCT_LIVE as never, instrumentId: 'hyperliquid:BTC' }, {
      intent: { accountId: ACCT_LIVE, instrumentId: 'hyperliquid:BTC', side: 'sell', type: 'limit', size: '0.01', price: '68000' },
    }, NOW))!
    expect(plain.what).toBe('提交订单 卖出 0.01 BTC @ 68,000')
    const fill = entryToActivity(entry(432, 'fill', O_CLAUDE, { accountId: ACCT_LIVE as never, instrumentId: 'hyperliquid:BTC' }, {
      price: '68000', size: '0.01', side: 'sell',
    }, NOW))!
    expect(fill.what).toBe('成交 卖出 0.01 @ 68,000')
    const takeover = entryToActivity(entry(433, 'takeover.completed', O_CLAUDE, { orgId: 'org_local' as never }, {
      level: 'cancel_all', cancelled: 2,
    }, NOW))!
    expect(takeover.what).toBe('接管完成：撤销挂单')
  })
})
