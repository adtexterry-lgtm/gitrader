// SPDX-License-Identifier: CPAL-1.0
// P1-4（界面半）/ P1-7 / P1-9：待批队列排序、该钥匙上限占用、活动流选中票号（纯函数，不开浏览器）。
import { describe, expect, it } from 'vitest'
import type { PendingCard } from '../../blocks-default/src/model-activity'
import { feeLine, mandateLimitsOf, occupancy, orderQueue, pickByTicket } from '../src/views/pending'
import { ticketOf } from '../src/views/activity'

const card = (id: string, o: Partial<PendingCard> = {}): PendingCard => ({ proposalId: id, ticket: `T-20261024-${id}`, expiresAt: 1, ...o } as PendingCard)

describe('P1-4 队列：失败卡退到队尾', () => {
  it('failed card moves to the tail', () => {
    const cs = [card('0001'), card('0002'), card('0003')]
    expect(orderQueue(cs, new Set(['0001'])).map((c) => c.proposalId)).toEqual(['0002', '0003', '0001'])
    expect(orderQueue(cs, new Set()).map((c) => c.proposalId)).toEqual(['0001', '0002', '0003'])
    // 全是失败卡：保持原序，不丢卡
    expect(orderQueue(cs, new Set(['0001', '0002', '0003'])).map((c) => c.proposalId)).toEqual(['0001', '0002', '0003'])
  })
})

describe('P1-7 占用：该钥匙上限 + 手续费', () => {
  const c = card('0001', { notional: 161.52, feeEstimate: '0.0807', origin: { actor: 'agent:ak_1' } as never })
  const base = { card: c, usage: {}, totalNotional: 0, equity: null, delta: null }
  it('occupancy uses mandate cap', () => {
    // 钥匙单笔 300 / 全局 2000 → 取 300 并标「该钥匙上限」
    const row = occupancy({ ...base, limits: { maxOrderNotional: '2000' }, mandateLimits: { maxOrderNotional: '300' } }).find((o) => o.id === 'order')!
    expect(row.keyCap).toBe(true)
    expect(row.limit).toBe('300.00')
    expect(row.ratio).toBeCloseTo(161.52 / 300)
    // 钥匙比全局宽：仍取全局，不标
    const wide = occupancy({ ...base, limits: { maxOrderNotional: '200' }, mandateLimits: { maxOrderNotional: '300' } }).find((o) => o.id === 'order')!
    expect(wide.keyCap).toBeUndefined()
    expect(wide.limit).toBe('200.00')
    // 没有授权书：行为同旧
    expect(occupancy({ ...base, limits: { maxOrderNotional: '2000' } }).find((o) => o.id === 'order')!.keyCap).toBeUndefined()
    // 来源 agent:<keyId> → 该钥匙的授权书限额
    const keys = [{ keyId: 'ak_1', mandate: { limits: { maxOrderNotional: '300' } } }, { keyId: 'ak_2', mandate: null }] as never
    expect(mandateLimitsOf(c, keys)).toEqual({ maxOrderNotional: '300' })
    expect(mandateLimitsOf(card('x', { origin: { actor: 'agent:ak_2' } as never }), keys)).toBeNull()
    expect(mandateLimitsOf(card('x', { origin: null }), keys)).toBeNull()
  })
  it('fee line shows only with an estimate', () => {
    expect(feeLine(c)).toBe('手续费 ≈ 0.08')
    expect(feeLine(card('x'))).toBeNull()
  })
})

describe('P1-9 活动流选中待批票', () => {
  it('select event picks the ticket', () => {
    const cs = [card('0001'), card('0002'), card('0003')]
    expect(pickByTicket(cs, 'T-20261024-0002')).toBe('0002')
    expect(pickByTicket(cs, 'T-20261024-9999')).toBeNull() // 已决 / 已过期
    expect(pickByTicket(cs, undefined)).toBeNull()
  })
  it('activity row ticket comes from proposal rows only', () => {
    expect(ticketOf({ type: 'proposal.created', what: '提出提案 T-20261024-0012' })).toBe('T-20261024-0012')
    expect(ticketOf({ type: 'order.accepted', what: '下单 T-20261024-0012' })).toBeNull()
    expect(ticketOf({ type: 'proposal.created', what: '提出提案' })).toBeNull()
  })
})
