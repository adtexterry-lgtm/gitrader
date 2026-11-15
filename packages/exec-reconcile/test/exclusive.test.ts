// SPDX-License-Identifier: CPAL-1.0
// 同一个缺口只报一次 / 撤单中仍是活单 / 推断成交带确定性 id / 毫秒级时间戳偏差 / 判不出时不给改账建议 / 单号冲突只报一次。
// 输入全部在用例里手写（不复用 fixtures/venues.ts），每个用例只钉一件事。
import { describe, expect, it } from 'vitest'
import { reconcile } from '../src/reconcile'
import { classifyVenueStatus } from '../src/status'
import { codes, finding, findings, input, localFill, localOrder, NOW, options, venueFill, venueOpen } from './helpers'

describe('同一个成交缺口只报一次', () => {
  it('场所部分成交、账本无成交 → 只有一条 record_fill，且是 fill_missing_inferred', () => {
    const report = reconcile(input({
      orders: [localOrder({ size: '1', filledSize: '0' })],
      venue: {
        openOrders: [venueOpen({ size: '0.5', filledSize: '0.5', avgFillPrice: '2001', status: 'PARTIALLY_FILLED' })],
        historyOrders: [],
      },
    }), options())
    const recordFill = report.findings.filter((f) => f.advice.action === 'record_fill')
    expect(recordFill).toHaveLength(1)
    expect(recordFill[0]?.code).toBe('fill_missing_inferred')
    expect(findings(report, 'order_filled_size_drift')).toHaveLength(0)
  })

  it('场所挂单不带 filledSize、账本已记 0.5 → 成交量漂移只报一条（带 venue_field_missing）', () => {
    const report = reconcile(input({
      orders: [localOrder({ filledSize: '0.5', status: 'partially_filled' })],
      fills: [localFill({ size: '0.5' })],
      venue: {
        openOrders: [venueOpen({ size: '0.5', filledSize: undefined, status: 'PARTIALLY_FILLED' })],
        historyOrders: [],
      },
    }), options())
    const drift = findings(report, 'order_filled_size_drift')
    expect(drift).toHaveLength(1)
    expect(drift[0]?.tags).toContain('venue_field_missing')
  })

  it('成交明细已入账、只是订单字段落后 → 成交量漂移带 ledger_order_field_stale，建议采纳场所值', () => {
    const report = reconcile(input({
      orders: [localOrder({ filledSize: '0' })],
      fills: [localFill({ size: '0.5' })],
      venue: {
        openOrders: [venueOpen({ filledSize: '0.5', avgFillPrice: '2001', status: 'PARTIALLY_FILLED' })],
        historyOrders: [],
      },
    }), options())
    const drift = findings(report, 'order_filled_size_drift')
    expect(drift).toHaveLength(1)
    expect(drift[0]?.tags).toContain('ledger_order_field_stale')
    expect(drift[0]?.advice.action).toBe('adopt_venue_state')
    expect(drift[0]?.advice.requiresHuman).toBe(true)
    expect(codes(report)).not.toContain('fill_missing_inferred')
  })
})

describe('撤单中 / 改单中仍是活单', () => {
  it('pending_cancel / PendingCancel / pending_replace / stopped 归到活单', () => {
    expect(classifyVenueStatus('pending_cancel')).toBe('open')
    expect(classifyVenueStatus('PendingCancel')).toBe('open')
    expect(classifyVenueStatus('pending_replace')).toBe('open')
    expect(classifyVenueStatus('stopped')).toBe('open')
  })

  it('真正结束的撤单类仍归到已撤', () => {
    expect(classifyVenueStatus('canceled')).toBe('cancelled')
    expect(classifyVenueStatus('PartiallyFilledCanceled')).toBe('cancelled')
    expect(classifyVenueStatus('marginCanceled')).toBe('cancelled')
    expect(classifyVenueStatus('Cancelled')).toBe('cancelled')
  })
})

describe('推断成交带确定性 id', () => {
  const data = (localSize: string) => input({
    orders: [localOrder({ filledSize: localSize })],
    fills: localSize === '0' ? [] : [localFill({ size: localSize })],
    venue: {
      openOrders: [venueOpen({ filledSize: '0.2', avgFillPrice: '100', status: 'PARTIALLY_FILLED' })],
      historyOrders: [],
    },
  })

  it('同一缺口重复对账 → id 相同且以 inferred: 开头', () => {
    const first = reconcile(data('0'), options())
    const second = reconcile(data('0'), options())
    expect(first.inferredFills).toHaveLength(1)
    expect(first.inferredFills[0]?.id).toBe(second.inferredFills[0]?.id)
    expect(first.inferredFills[0]?.id.startsWith('inferred:')).toBe(true)
    expect(finding(first, 'fill_missing_inferred')?.subject.venueFillId).toBe(first.inferredFills[0]?.id)
  })

  it('账本成交合计变了 → id 跟着变', () => {
    const first = reconcile(data('0'), options())
    const second = reconcile(data('0.1'), options())
    expect(second.inferredFills).toHaveLength(1)
    expect(second.inferredFills[0]?.id).not.toBe(first.inferredFills[0]?.id)
  })
})

describe('同一成交号只差毫秒级时间戳', () => {
  const report = (driftMs: number) => reconcile(input({
    orders: [localOrder({ filledSize: '0.05', status: 'partially_filled' })],
    fills: [localFill({ size: '0.05' })],
    venue: {
      openOrders: [venueOpen({ filledSize: '0.05', status: 'partially_filled' })],
      historyOrders: [],
      fills: [
        venueFill({ venueFillId: 'f-1', size: '0.05', price: '100', ts: NOW - 1_000 }),
        venueFill({ venueFillId: 'f-1', size: '0.05', price: '100', ts: NOW - 1_000 + driftMs }),
      ],
    },
  }), options())

  it('相差 3 ms（在时钟偏差内）→ 按重复处理，标 ts_drift_within_skew', () => {
    const duplicated = report(3)
    expect(codes(duplicated)).not.toContain('fill_conflict')
    const f = finding(duplicated, 'fill_duplicate')
    expect(f?.tags).toContain('ts_drift_within_skew')
    expect(f?.detail).toContain('3 ms')
    expect(f?.detail).toContain('时间完全相等')
  })

  it('相差 5000 ms（超出时钟偏差）→ 仍是 fill_conflict', () => {
    const conflict = report(5_000)
    expect(codes(conflict)).toContain('fill_conflict')
    expect(codes(conflict)).not.toContain('fill_duplicate')
  })
})

describe('判不出的不给改账建议', () => {
  it('场所状态归一为 unknown → query_order_status，不猜、不许改成不需人工', () => {
    const report = reconcile(input({
      orders: [localOrder()],
      venue: { openOrders: [venueOpen({ status: 'MysteryState' })], historyOrders: [] },
    }), options())
    const f = finding(report, 'order_state_drift')
    expect(f?.advice.action).toBe('query_order_status')
    expect(f?.advice.requiresHuman).toBe(true)
  })

  it('终态已成但成交量小于原量 → query_order_status，先查成交明细再改状态', () => {
    const report = reconcile(input({
      orders: [localOrder({ size: '100', filledSize: '40', status: 'open' })],
      fills: [localFill({ size: '40', price: '190.1' })],
      venue: {
        openOrders: [],
        historyOrders: [venueOpen({
          source: 'history', status: 'Filled', filledSize: '40', origSize: '100', size: '0', avgFillPrice: '190.1',
        })],
        fills: [],
      },
    }), options())
    const f = finding(report, 'local_open_venue_filled')
    expect(f?.tags).toContain('terminal_status_partial')
    expect(f?.advice.action).toBe('query_order_status')
    expect(f?.advice.requiresHuman).toBe(true)
  })
})

describe('同一场所单号冲突只报一次', () => {
  it('两张本地订单共用同一个场所单号 → order_venue_id_conflict 恰好 1 条', () => {
    const report = reconcile(input({
      orders: [
        localOrder({ orderId: 'o-1', clientOrderId: 'gt-1', venueOrderId: 'V9' }),
        localOrder({ orderId: 'o-2', clientOrderId: 'gt-2', venueOrderId: 'V9' }),
      ],
      venue: { openOrders: [], historyOrders: [] },
    }), options())
    expect(findings(report, 'order_venue_id_conflict')).toHaveLength(1)
  })
})
