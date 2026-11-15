// SPDX-License-Identifier: CPAL-1.0
// 0.1.1 客户体验修复 B 包（ux-011）：被拦的提案合成一行（UX-20）、交易所连接状态同源（UX-10）。
import { describe, expect, it } from 'vitest'
import { activityOf, tidyActivity } from '../src/model-activity'
import { normalizeVenues } from '../src/model-risk'
import { entry, O_CLAUDE } from '../fixtures/scenarios'

describe('UX-20 被拦的提案只出一行', () => {
  const t0 = 1_700_000_000_000
  const created = entry(10, 'proposal.created', O_CLAUDE, { ticket: 'T-1', instrumentId: 'hyperliquid:BTC' }, { reason: '额度超限' }, t0, { precheck: { verdict: 'deny' } as never })
  const denied = entry(11, 'risk.denied', O_CLAUDE, { instrumentId: 'hyperliquid:BTC' }, { problem: { message: '额度超限' } }, t0 + 5)
  it('提案被拦截 + 同时落账的「订单被拦截」合成提案那一行', () => {
    const rows = tidyActivity(activityOf([created, denied]))
    expect(rows.map((r) => r.type)).toEqual(['proposal.created'])
    expect(rows[0]!.result?.label).toBe('被拦截')
  })
  it('不相干的拦截（别的标的 / 隔了很久）不合并', () => {
    const o2 = { ...O_CLAUDE, requestId: '00000000-0000-4000-8000-00000000aaaa' }
    const other = entry(12, 'risk.denied', o2, { instrumentId: 'hyperliquid:ETH' }, { problem: { message: 'x' } }, t0 + 5, {})
    const late = entry(13, 'risk.denied', { ...o2, requestId: '00000000-0000-4000-8000-00000000bbbb' }, { instrumentId: 'hyperliquid:BTC' }, { problem: { message: 'x' } }, t0 + 60_000, {})
    const rows = tidyActivity(activityOf([created, other, late], 50))
    expect(rows.filter((r) => r.type === 'risk.denied')).toHaveLength(2) // ETH 与 60 秒后的 BTC 各一行
  })
  it('没有被拦的提案时原样不动', () => {
    expect(tidyActivity(activityOf([denied]))).toHaveLength(1)
  })
})

describe('UX-10 顶栏 / 状态条的连接状态与设置页表格同源', () => {
  it('以 connection 为准（内核已按连接器实时状态细化），没有才退回 wsState；两者都没有才「未知」', () => {
    const [a, b, c, d] = normalizeVenues([
      { venue: 'hyperliquid', connection: 'disconnected', wsState: 'connecting' },
      { venue: 'x', wsState: 'connected' },
      { venue: 'y' },
      { venue: 'z', connection: 'connected', wsState: 'connected' },
    ])
    expect([a!.ws, a!.wsText]).toEqual(['err', '已断开'])
    expect([b!.ws, b!.wsText]).toEqual(['ok', '已连接'])
    expect([c!.ws, c!.wsText]).toEqual(['unknown', '未知'])
    expect(d!.ws).toBe('ok')
  })
})
