// SPDX-License-Identifier: CPAL-1.0
// 成交：重复到达、同号冲突、去重键风险、指向未知订单、缺口推断、账本多记。
import { describe, expect, it } from 'vitest'
import { reconcile } from '../src/reconcile'
import { codes, finding, input, localFill, localOrder, NOW, options, venueFill, venueOpen } from './helpers'

const baseOrder = localOrder({ orderId: 'o-1', clientOrderId: 'gt-1', venueOrderId: 'v-1', filledSize: '0' })

describe('成交去重', () => {
  it('同一成交号两次到达、内容一致 → ignore_duplicate（不需人工）', () => {
    const report = reconcile(input({
      orders: [baseOrder],
      fills: [localFill({ size: '0.05' })],
      venue: {
        openOrders: [venueOpen({ filledSize: '0.05', status: 'partially_filled' })],
        historyOrders: [],
        fills: [venueFill({ size: '0.05' }), venueFill({ size: '0.05' })],
      },
    }), options())
    const f = finding(report, 'fill_duplicate')
    expect(f?.advice.action).toBe('ignore_duplicate')
    expect(f?.advice.requiresHuman).toBe(false)
    expect(report.dedupe.accepted).toHaveLength(1)
    expect(report.dedupe.duplicates[0]?.count).toBe(2)
  })

  it('同一成交号两次到达、数量不同 → fill_conflict（停机级，内核会按成交号冲突处理）', () => {
    const report = reconcile(input({
      orders: [baseOrder],
      venue: {
        openOrders: [],
        historyOrders: [],
        fills: [venueFill({ size: '0.05' }), venueFill({ size: '0.06' })],
      },
    }), options())
    const f = finding(report, 'fill_conflict')
    expect(f?.severity).toBe('blocker')
    expect(f?.advice.action).toBe('halt_account_and_review')
    expect(f?.detail).toContain('0.05')
    expect(f?.detail).toContain('0.06')
    expect(report.dedupe.conflicts).toHaveLength(1)
  })

  it('场所没给成交号 → 回退键，并在差异里写明误判风险', () => {
    const report = reconcile(input({
      orders: [baseOrder],
      venue: {
        openOrders: [venueOpen({ filledSize: '0.05' })],
        historyOrders: [],
        fills: [venueFill({ venueFillId: '', size: '0.05' })],
      },
    }), options())
    const f = finding(report, 'fill_dedupe_key_fallback')
    expect(f?.advice.action).toBe('fix_dedupe_key')
    expect(f?.detail).toContain('回退键')
    expect(report.dedupe.keys[0]?.kind).toBe('fallback_composite')
    expect(report.dedupe.keys[0]?.risk).toContain('误判')
  })

  it('回退键配置为 needs_human 时不接受该成交', () => {
    const report = reconcile(input({
      orders: [baseOrder],
      venue: { openOrders: [], historyOrders: [], fills: [venueFill({ venueFillId: '' })] },
    }), options({ dedupeFallback: 'needs_human' }))
    expect(report.dedupe.accepted).toHaveLength(0)
    expect(finding(report, 'fill_dedupe_key_fallback')?.severity).toBe('blocker')
  })

  it('累计量合成的成交号（Alpaca 形状）→ 单独提示这层风险', () => {
    const order = localOrder({ venueOrderId: 'ord-a', clientOrderId: 'gt-a', filledSize: '2' })
    const report = reconcile(input({
      orders: [order],
      fills: [localFill({ orderId: order.orderId, venueFillId: 'ord-a:2', venueOrderId: 'ord-a', size: '2' })],
      venue: {
        openOrders: [venueOpen({ venueOrderId: 'ord-a', clientOrderId: 'gt-a', filledSize: '2', status: 'partially_filled' })],
        historyOrders: [],
        fills: [venueFill({ venueFillId: 'ord-a:2', venueOrderId: 'ord-a', clientOrderId: 'gt-a', size: '2' })],
      },
    }), options())
    const f = finding(report, 'fill_dedupe_key_cumulative')
    expect(f?.detail).toContain('累计成交量')
    expect(report.dedupe.keys[0]?.kind).toBe('cumulative_quantity')
  })

  it('累计量键两源时间戳相差超过允许的时钟偏差 → 仍判冲突', () => {
    const order = localOrder({ venueOrderId: 'ord-a', clientOrderId: 'gt-a' })
    const report = reconcile(input({
      orders: [order],
      venue: {
        openOrders: [],
        historyOrders: [],
        fills: [
          venueFill({ venueFillId: 'ord-a:2', venueOrderId: 'ord-a', size: '2', ts: NOW - 5_000 }),
          venueFill({ venueFillId: 'ord-a:2', venueOrderId: 'ord-a', size: '2', ts: NOW - 1_000 }),
        ],
      },
    }), options())
    expect(codes(report)).toContain('fill_conflict')
    expect(finding(report, 'fill_conflict')?.detail).toContain(String(NOW - 5_000))
  })

  it('账本里同一成交号已入账两次 → ledger_fill_duplicate', () => {
    const report = reconcile(input({
      orders: [baseOrder],
      fills: [localFill({ size: '0.05' }), localFill({ size: '0.05' })],
      venue: { openOrders: [], historyOrders: [] },
    }), options())
    const f = finding(report, 'ledger_fill_duplicate')
    expect(f?.advice.action).toBe('review_ledger_fills')
    expect(f?.detail).toContain('2 次')
  })
})

describe('成交指向未知订单', () => {
  it('成交落在账本没有的场所单号上 → fill_orphan，先认领订单', () => {
    const report = reconcile(input({
      orders: [baseOrder],
      venue: { openOrders: [], historyOrders: [], fills: [venueFill({ venueOrderId: 'v-unknown' })] },
    }), options())
    const f = finding(report, 'fill_orphan')
    expect(f?.advice.action).toBe('review_unmapped_order')
    expect(f?.detail).toContain('v-unknown')
  })
})

describe('成交缺口 → 推断成交（必须标 inferred 并写依据）', () => {
  it('场所有成交均价 → 按均价推出，priceSource = venue_avg_fill_price', () => {
    const report = reconcile(input({
      orders: [baseOrder],
      venue: {
        openOrders: [venueOpen({ filledSize: '0.1', avgFillPrice: '99', status: 'partially_filled' })],
        historyOrders: [],
      },
    }), options())
    const f = finding(report, 'fill_missing_inferred')
    expect(f?.inferred).toBe(true)
    expect(f?.basis?.length).toBeGreaterThanOrEqual(3)
    expect(f?.basis?.join(' ')).toContain('avgFillPrice')
    expect(report.inferredFills).toHaveLength(1)
    expect(report.inferredFills[0]).toMatchObject({
      size: '0.1', price: '99', priceSource: 'venue_avg_fill_price', inferred: true, side: 'buy',
    })
  })

  it('场所不给均价但有本地成交 → 借最后一笔成交价，依据里写明是替代价', () => {
    const report = reconcile(input({
      orders: [localOrder({ venueOrderId: 'v-1', filledSize: '0.04' })],
      fills: [localFill({ size: '0.04', price: '100' })],
      venue: {
        openOrders: [venueOpen({ filledSize: '0.1', status: 'partially_filled' })],
        historyOrders: [],
        fills: [venueFill({ size: '0.04', price: '100' })],
      },
    }), options())
    const inferred = report.inferredFills[0]
    expect(inferred?.priceSource).toBe('local_last_fill_price')
    expect(inferred?.size).toBe('0.06')
    expect(inferred?.basis.join(' ')).toContain('借')
  })

  it('既没场所均价、账本也没有成交 → 不猜价格，给 fill_missing_unexplained', () => {
    const report = reconcile(input({
      orders: [baseOrder],
      venue: { openOrders: [venueOpen({ filledSize: '0.1', status: 'partially_filled' })], historyOrders: [] },
    }), options())
    const f = finding(report, 'fill_missing_unexplained')
    expect(f?.severity).toBe('blocker')
    expect(f?.advice.action).toBe('halt_account_and_review')
    expect(report.inferredFills).toHaveLength(0)
  })

  it('差额在数量容差内不推断（避免把进位当缺口）', () => {
    const report = reconcile(input({
      orders: [localOrder({ filledSize: '0.1' })],
      fills: [localFill({ size: '0.1' })],
      venue: {
        openOrders: [venueOpen({ filledSize: '0.10004', avgFillPrice: '99', status: 'partially_filled' })],
        historyOrders: [],
        fills: [venueFill({ size: '0.1' })],
      },
    }), options({ sizeTolerance: '0.0001' }))
    expect(report.inferredFills).toHaveLength(0)
    expect(codes(report)).not.toContain('fill_missing_inferred')
  })

  it('账本已记成交多于场所 → fill_recorded_excess（多记，不能靠推断掩盖）', () => {
    const report = reconcile(input({
      orders: [localOrder({ filledSize: '0.1' })],
      fills: [localFill({ size: '0.1' })],
      venue: { openOrders: [venueOpen({ filledSize: '0.05', status: 'partially_filled' })], historyOrders: [] },
    }), options())
    const f = finding(report, 'fill_recorded_excess')
    expect(f?.advice.action).toBe('review_ledger_fills')
    expect(f?.detail).toContain('0.05')
  })
})

describe('成交时间', () => {
  it('成交时间超出允许的时钟偏差落在未来 → fill_time_anomaly', () => {
    const report = reconcile(input({
      orders: [baseOrder],
      venue: { openOrders: [], historyOrders: [], fills: [venueFill({ ts: NOW + 30_000 })] },
    }), options())
    expect(finding(report, 'fill_time_anomaly')?.tags).toContain('future')
  })

  it('成交早于回补窗口 → 只记提示级（属于更早的会话）', () => {
    const report = reconcile(input({
      orders: [baseOrder],
      fills: [localFill({ ts: NOW - 7200_000 })],
      venue: { openOrders: [], historyOrders: [], fills: [venueFill({ ts: NOW - 7200_000 })] },
    }), options({ fillLookbackMs: 3600_000 }))
    const f = finding(report, 'fill_time_anomaly')
    expect(f?.tags).toContain('outside_lookback')
    expect(f?.severity).toBe('info')
  })
})
