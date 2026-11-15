// SPDX-License-Identifier: CPAL-1.0
// 附带止损（tpsl）在活动流与审批卡上的文案：intent 文本追加止损 / 止盈，卡片带止损与最大亏损，保护行只按给出的字段拼。
import { describe, expect, it } from 'vitest'
import { ACCT_LIVE, NOW, O_CLAUDE, entry } from '../fixtures/scenarios'
import { entryToActivity, protectionLine, toPending } from '../src/model-activity'

const intent = (tpsl?: Record<string, unknown>): Record<string, unknown> => ({
  accountId: ACCT_LIVE, instrumentId: 'hyperliquid:BTC', side: 'buy', type: 'limit', size: '0.5', price: '64300', tif: 'gtc', reason: '按计划建仓',
  ...(tpsl ? { tpsl } : {}),
})

const proposalOf = (opts: { tpsl?: Record<string, unknown>; estimates?: Record<string, unknown> } = {}): Record<string, unknown> => ({
  proposalId: 'prop_tpsl_1', ticket: 'T-TPSL-1', kind: 'order', status: 'pending', accountId: ACCT_LIVE,
  intents: [intent(opts.tpsl)], intentsDigest: 'sha256:00', reason: '带止损的开仓',
  precheck: { precheckId: 'pck_tpsl_1', verdict: 'review', policyVersion: 3, ruleHits: [], estimates: opts.estimates ?? {}, expiresAt: NOW + 60_000 },
  expiresAt: NOW + 60_000, decision: null, execution: null, origin: O_CLAUDE,
})

describe('附带止损：活动流', () => {
  // fix-r2 K1：意图只是计划（R3-01：止损没挂上时活动流不能写成已挂）；「已挂上」由子单 order.accepted 出，见 k1-activity-wording.test.ts
  it('intent with stop loss mentions the stop', () => {
    const withSl = entry(301, 'order.intent', O_CLAUDE, { accountId: ACCT_LIVE as never, instrumentId: 'hyperliquid:BTC' }, { intent: intent({ stopLoss: { triggerPrice: '79437' }, grouping: 'order' }) }, NOW)
    expect(entryToActivity(withSl)!.what).toBe('提交订单 买入 0.5 BTC @ 64,300，计划挂止损 79,437（随开仓）')
    const withBoth = entry(302, 'order.intent', O_CLAUDE, { accountId: ACCT_LIVE as never, instrumentId: 'hyperliquid:BTC' }, { intent: intent({ stopLoss: { triggerPrice: '79437' }, takeProfit: { triggerPrice: '91250' }, grouping: 'order' }) }, NOW)
    expect(entryToActivity(withBoth)!.what).toBe('提交订单 买入 0.5 BTC @ 64,300，计划挂止损 79,437（随开仓），止盈 91,250')
    const plain = entry(303, 'order.intent', O_CLAUDE, { accountId: ACCT_LIVE as never, instrumentId: 'hyperliquid:BTC' }, { intent: intent() }, NOW)
    expect(entryToActivity(plain)!.what).toBe('提交订单 买入 0.5 BTC @ 64,300')
  })
})

describe('附带止损：审批卡字段', () => {
  it('pending card carries stop and max loss', () => {
    const card = toPending(proposalOf({
      tpsl: { stopLoss: { triggerPrice: '79437' }, takeProfit: { triggerPrice: '91250' }, grouping: 'order' },
      estimates: { notional: '32150', maxLoss: '1.604', feeEstimate: '3.21' },
    }))!
    expect(card.stopLoss).toBe('79437')
    expect(card.takeProfit).toBe('91250')
    expect(card.maxLoss).toBe('1.604')
    expect(card.feeEstimate).toBe('3.21')
    // 没有 tpsl / 估算时字段不出现
    const bare = toPending(proposalOf())!
    expect(bare.stopLoss).toBeUndefined()
    expect(bare.takeProfit).toBeUndefined()
    expect(bare.maxLoss).toBeUndefined()
    expect(bare.feeEstimate).toBeUndefined()
    expect('stopLoss' in bare).toBe(false)
    expect('maxLoss' in bare).toBe(false)
  })
})

describe('附带止损：保护行', () => {
  it('protection line formats', () => {
    // 有止损 + 有最大亏损
    expect(protectionLine({ stopLoss: '79437', maxLoss: '1.604' })).toBe('附带止损 79,437 · 最多亏 ≈ 1.6')
    // 有止损 + 止盈 + 有最大亏损
    expect(protectionLine({ stopLoss: '79437', takeProfit: '91250', maxLoss: '1.6' })).toBe('附带止损 79,437 · 止盈 91,250 · 最多亏 ≈ 1.6')
    // 只有止盈
    expect(protectionLine({ takeProfit: '91250' })).toBe('附带止盈 91,250')
    // 都没有
    expect(protectionLine({})).toBeNull()
  })
})
