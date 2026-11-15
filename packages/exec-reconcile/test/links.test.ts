// SPDX-License-Identifier: CPAL-1.0
// 单号映射：改单链解析、链断、歧义，以及「按单号认单」为什么必须先解析链。
import { describe, expect, it } from 'vitest'
import { buildLinkIndex, venueIdsOf } from '../src/links'
import { reconcile } from '../src/reconcile'
import { codes, finding, input, localOrder, NOW, options, venueOpen } from './helpers'
import type { AmendLink } from '../src/types'

const submit = (venueOrderId: string, ts: number, clientOrderId = 'gt-1'): AmendLink =>
  ({ clientOrderId, kind: 'submit', venueOrderId, ts })
const amend = (previousVenueOrderId: string, venueOrderId: string, ts: number, clientOrderId = 'gt-1'): AmendLink =>
  ({ clientOrderId, kind: 'amend', previousVenueOrderId, venueOrderId, ts })

describe('改单链解析', () => {
  it('三次改单后给出完整的场所单号链（客户端单号 → 场所单号）', () => {
    const links = [
      submit('v-1', NOW - 90_000),
      amend('v-1', 'v-2', NOW - 80_000),
      { ...amend('v-2', 'v-3', NOW - 70_000), kind: 'replace' as const },
    ]
    const report = reconcile(input({
      orders: [localOrder({ venueOrderId: 'v-3' })],
      venue: { openOrders: [venueOpen({ venueOrderId: 'v-1', filledSize: '0' })], historyOrders: [] },
      links,
    }), options())
    expect(report.links[0]?.venueOrderIds).toEqual(['v-1', 'v-2', 'v-3'])
    expect(codes(report)).toContain('amend_chain_resolved')
    expect(finding(report, 'amend_chain_resolved')?.advice.requiresHuman).toBe(false)
    expect(codes(report)).not.toContain('venue_order_unmapped')
  })

  it('场所还在用改单前的旧单号 → 靠链认回本地订单，不当成外部单', () => {
    const links = [submit('v-1', NOW - 90_000), amend('v-1', 'v-2', NOW - 80_000)]
    const report = reconcile(input({
      orders: [localOrder({ venueOrderId: 'v-2' })],
      venue: { openOrders: [venueOpen({ venueOrderId: 'v-1', filledSize: '0' })], historyOrders: [] },
      links,
    }), options())
    expect(codes(report)).toEqual(['amend_chain_resolved'])
  })

  it('链断（改单引用了没有记录的上一位单号）→ amend_chain_broken，需人工补齐', () => {
    const links: AmendLink[] = [{ clientOrderId: 'gt-1', kind: 'amend', previousVenueOrderId: 'v-0', venueOrderId: 'v-1', ts: NOW - 60_000 }]
    const report = reconcile(input({
      orders: [localOrder({ venueOrderId: 'v-1' })],
      venue: { openOrders: [venueOpen({ venueOrderId: 'v-1' })], historyOrders: [] },
      links,
    }), options())
    const f = finding(report, 'amend_chain_broken')
    expect(f?.advice.action).toBe('review_amend_chain')
    expect(f?.advice.requiresHuman).toBe(true)
  })

  it('同一场所单号被两条客户端单号认领 → 双向标歧义 + 单号冲突', () => {
    const links: AmendLink[] = [
      { clientOrderId: 'gt-1', kind: 'submit', venueOrderId: 'v-9', ts: NOW - 90_000 },
      { clientOrderId: 'gt-2', kind: 'submit', venueOrderId: 'v-9', ts: NOW - 80_000 },
    ]
    const report = reconcile(input({
      orders: [
        localOrder({ orderId: 'o-1', clientOrderId: 'gt-1', venueOrderId: 'v-9' }),
        localOrder({ orderId: 'o-2', clientOrderId: 'gt-2', venueOrderId: 'v-9' }),
      ],
      venue: { openOrders: [venueOpen({ venueOrderId: 'v-9', clientOrderId: 'gt-1' })], historyOrders: [] },
      links,
    }), options())
    expect(codes(report).filter((c) => c === 'amend_chain_ambiguous')).toHaveLength(2)
    expect(codes(report)).toContain('order_venue_id_conflict')
    expect(finding(report, 'order_venue_id_conflict')?.advice.action).toBe('halt_account_and_review')
  })

  it('链上声明的订单 id 与账本不一致 → 判歧义', () => {
    const links: AmendLink[] = [{ clientOrderId: 'gt-1', kind: 'submit', venueOrderId: 'v-1', ts: NOW - 60_000, orderId: 'o-OTHER' }]
    const report = reconcile(input({
      orders: [localOrder({ venueOrderId: 'v-1' })],
      venue: { openOrders: [venueOpen({ venueOrderId: 'v-1' })], historyOrders: [] },
      links,
    }), options())
    expect(codes(report)).toContain('amend_chain_ambiguous')
  })

  it('两张本地订单共用同一个场所单号 → 单号冲突（成交会记错单）', () => {
    const report = reconcile(input({
      orders: [
        localOrder({ orderId: 'o-1', clientOrderId: 'gt-1', venueOrderId: 'v-1' }),
        localOrder({ orderId: 'o-2', clientOrderId: 'gt-2', venueOrderId: 'v-1' }),
      ],
      venue: { openOrders: [venueOpen({ venueOrderId: 'v-1' })], historyOrders: [] },
    }), options())
    expect(codes(report)).toContain('order_venue_id_conflict')
  })

  it('venueIdsOf 覆盖自身单号与链上全部单号', () => {
    const base = input({
      orders: [localOrder({ venueOrderId: 'v-3' })],
      links: [submit('v-1', NOW - 90_000), amend('v-1', 'v-2', NOW - 80_000), amend('v-2', 'v-3', NOW - 70_000)],
    })
    const index = buildLinkIndex(base)
    const order = base.local.orders[0]!
    expect(venueIdsOf(index, order)).toEqual(['v-1', 'v-2', 'v-3'])
  })
})
