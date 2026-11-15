// SPDX-License-Identifier: CPAL-1.0
// 订单差异分类：本地挂单 ↔ 场所挂单 / 历史订单。每个用例只钉一件事，断言到「建议动作 + 是否需人工 + 证据」。
import { describe, expect, it } from 'vitest'
import { reconcile } from '../src/reconcile'
import { codes, finding, findings, input, localOrder, NOW, options, venueHistory, venueOpen } from './helpers'

describe('两边一致的挂单', () => {
  it('状态、价格、成交量都一样 → 没有差异（verdict clean）', () => {
    const report = reconcile(input({
      orders: [localOrder()],
      venue: { openOrders: [venueOpen()], historyOrders: [] },
    }), options())
    expect(report.findings).toEqual([])
    expect(report.verdict).toBe('clean')
    expect(report.counts.needsHuman).toBe(0)
  })

  it('价格漂移在容差内不算差异（100 vs 100.001，0.1 bp < 5 bp）', () => {
    const report = reconcile(input({
      orders: [localOrder({ price: '100' })],
      venue: { openOrders: [venueOpen({ price: '100.001' })], historyOrders: [] },
    }), options())
    expect(codes(report)).not.toContain('order_price_drift')
  })
})

describe('本地有、场所无（已撤 / 已成 / 丢失）', () => {
  it('场所历史订单显示已成 → mark_filled，且需人工', () => {
    const report = reconcile(input({
      orders: [localOrder({ filledSize: '0.1' })],
      fills: [{ venueFillId: 'f-1', orderId: 'o-1', venueOrderId: 'v-1', instrumentId: 'test:BTC', side: 'buy', price: '100', size: '0.1', ts: NOW - 20_000 }],
      venue: { openOrders: [], historyOrders: [venueHistory({ status: 'FILLED', filledSize: '0.1' })], fills: [
        { venueFillId: 'f-1', venueOrderId: 'v-1', instrumentId: 'test:BTC', side: 'buy', price: '100', size: '0.1', ts: NOW - 20_000 },
      ] },
    }), options())
    const f = finding(report, 'local_open_venue_filled')
    expect(f).toBeDefined()
    expect(f!.advice.action).toBe('mark_filled')
    expect(f!.advice.requiresHuman).toBe(true)
    expect(f!.severity).toBe('blocker')
    expect(f!.evidence.some((e) => e.report === 'venue.historyOrders' && e.field === 'status')).toBe(true)
    expect(report.verdict).toBe('blocked')
  })

  it('场所历史订单已撤 → mark_cancelled（注意级）', () => {
    const report = reconcile(input({
      orders: [localOrder()],
      venue: { openOrders: [], historyOrders: [venueHistory({ status: 'CANCELED', filledSize: '0' })] },
    }), options())
    const f = finding(report, 'local_open_venue_cancelled')
    expect(f?.advice.action).toBe('mark_cancelled')
    expect(f?.severity).toBe('warn')
  })

  it('EXPIRED 归到已撤一类（不新造状态词）', () => {
    const report = reconcile(input({
      orders: [localOrder()],
      venue: { openOrders: [], historyOrders: [venueHistory({ status: 'EXPIRED', filledSize: '0' })] },
    }), options())
    expect(codes(report)).toContain('local_open_venue_cancelled')
    expect(codes(report)).not.toContain('local_open_venue_missing')
  })

  it('场所拒单 → 按拒单处理并保留上游原话', () => {
    const report = reconcile(input({
      orders: [localOrder()],
      venue: { openOrders: [], historyOrders: [venueHistory({ status: 'REJECTED', filledSize: '0' })] },
    }), options())
    const f = finding(report, 'local_open_venue_rejected')
    expect(f?.detail).toContain('REJECTED')
    expect(f?.advice.action).toBe('mark_cancelled')
  })

  it('延迟窗口内查不到 → 只提醒等待重查，不判丢失、不需人工', () => {
    const report = reconcile(input({
      orders: [localOrder({ createdAt: NOW - 1_000, updatedAt: NOW - 1_000 })],
      venue: { openOrders: [], historyOrders: [] },
    }), options())
    const f = finding(report, 'order_unverified_within_latency')
    expect(f).toBeDefined()
    expect(f!.advice.action).toBe('wait_and_recheck')
    expect(f!.advice.requiresHuman).toBe(false)
    expect(codes(report)).not.toContain('local_open_venue_missing')
    expect(report.verdict).toBe('clean')
  })

  it('窗口外仍查不到 → 先查状态，需人工，不猜是已撤', () => {
    const report = reconcile(input({
      orders: [localOrder({ createdAt: NOW - 90_000, updatedAt: NOW - 90_000 })],
      venue: { openOrders: [], historyOrders: [] },
    }), options())
    const f = finding(report, 'local_open_venue_missing')
    expect(f?.advice.action).toBe('query_order_status')
    expect(f?.advice.requiresHuman).toBe(true)
    expect(f?.severity).toBe('blocker')
    expect(f?.detail).toContain('查不到')
  })

  it('场所声明不提供历史订单 → 结论降级为「无法判定」，并给出覆盖缺口', () => {
    const report = reconcile(input({
      orders: [localOrder({ createdAt: NOW - 90_000 })],
      venue: { openOrders: [], historyOrders: undefined, unavailable: ['historyOrders'] },
    }), options())
    const f = finding(report, 'local_open_venue_missing')
    expect(f?.tags).toContain('coverage_limited')
    expect(f?.detail).toContain('无法判定')
    expect(codes(report)).toContain('venue_report_unavailable')
  })

  it('场所声明给不出挂单报告 → 标 open_orders_unavailable，不写成「场所没有」', () => {
    const report = reconcile(input({
      orders: [localOrder()],
      venue: { openOrders: [], historyOrders: [], unavailable: ['openOrders'] },
    }), options())
    expect(finding(report, 'local_open_venue_missing')?.tags).toContain('open_orders_unavailable')
  })
})

describe('两边都挂着但内容不一致', () => {
  it('场所累计成交量多于账本 → 只报缺成交（fill_missing_inferred），不再重复报成交量漂移', () => {
    const report = reconcile(input({
      orders: [localOrder()],
      venue: { openOrders: [venueOpen({ filledSize: '0.04', avgFillPrice: '100', status: 'PARTIALLY_FILLED' })], historyOrders: [] },
    }), options())
    const f = finding(report, 'fill_missing_inferred')
    expect(f?.advice.action).toBe('record_fill')
    expect(f?.detail).toContain('0.04')
    expect(f?.severity).toBe('blocker')
    expect(findings(report, 'order_filled_size_drift')).toHaveLength(0)
  })

  it('账本记的成交量多于场所 → 改单后场所重置了已成交量（带标记）', () => {
    const report = reconcile(input({
      orders: [localOrder({ filledSize: '0.05' })],
      fills: [{ venueFillId: 'f-1', orderId: 'o-1', venueOrderId: 'v-1', instrumentId: 'test:BTC', side: 'buy', price: '100', size: '0.05', ts: NOW - 20_000 }],
      venue: { openOrders: [venueOpen({ filledSize: '0' })], historyOrders: [] },
    }), options())
    const f = finding(report, 'order_filled_size_drift')
    expect(f?.tags).toContain('venue_reset_after_amend')
    expect(f?.detail).toContain('重置')
  })

  it('状态漂移：场所已部分成交、账本还是 open（成交量没差也报）', () => {
    const report = reconcile(input({
      orders: [localOrder({ status: 'open' })],
      venue: { openOrders: [venueOpen({ status: 'partially_filled', filledSize: '0' })], historyOrders: [] },
    }), options())
    expect(codes(report)).toContain('order_state_drift')
  })

  it('价格漂移超容差 → adopt_venue_state，需人工', () => {
    const report = reconcile(input({
      orders: [localOrder({ price: '100' })],
      venue: { openOrders: [venueOpen({ price: '100.5' })], historyOrders: [] },
    }), options())
    const f = finding(report, 'order_price_drift')
    expect(f?.advice.action).toBe('adopt_venue_state')
    expect(f?.detail).toContain('50')
  })

  it('只减仓标记不符 → 单独报（不加仓 / 只减仓语义会变）', () => {
    const report = reconcile(input({
      orders: [localOrder({ reduceOnly: true })],
      venue: { openOrders: [venueOpen({ reduceOnly: false })], historyOrders: [] },
    }), options())
    expect(codes(report)).toContain('order_reduce_only_drift')
  })
})

describe('本地已终结、场所仍在挂（幽灵敞口）', () => {
  it('账本记 filled、场所还挂着 → halt_account_and_review', () => {
    const report = reconcile(input({
      orders: [localOrder({ status: 'filled', filledSize: '0.1', closedAt: NOW - 10_000 })],
      fills: [{ venueFillId: 'f-1', orderId: 'o-1', venueOrderId: 'v-1', instrumentId: 'test:BTC', side: 'buy', price: '100', size: '0.1', ts: NOW - 10_000 }],
      venue: { openOrders: [venueOpen({ filledSize: '0.1', status: 'open' })], historyOrders: [] },
    }), options())
    const f = finding(report, 'local_terminal_venue_open')
    expect(f?.advice.action).toBe('halt_account_and_review')
    expect(f?.severity).toBe('blocker')
  })
})

describe('场所有、本地无（外部下单 / 重启前下的单）', () => {
  it('单号像是我们的、账本没认领 → 需人工确认归属', () => {
    const report = reconcile(input({
      orders: [],
      venue: { openOrders: [venueOpen({ venueOrderId: 'v-9', clientOrderId: 'gt-9', instrumentId: 'test:ETH' })], historyOrders: [] },
    }), options({ ownClientOrderIdPrefixes: ['gt-'] }))
    const f = finding(report, 'venue_order_unmapped')
    expect(f?.advice.action).toBe('review_unmapped_order')
    expect(f?.advice.requiresHuman).toBe(true)
    expect(f?.detail).toContain('gt-9')
  })

  it('客户端单号不属于我们的前缀 → 按外部下单处理，不自动接管', () => {
    const report = reconcile(input({
      orders: [],
      venue: { openOrders: [venueOpen({ venueOrderId: 'v-9', clientOrderId: 'web-7', instrumentId: 'test:ETH' })], historyOrders: [] },
    }), options({ ownClientOrderIdPrefixes: ['gt-'] }))
    const f = finding(report, 'venue_order_external')
    expect(f?.advice.action).toBe('review_external_order')
    expect(f?.advice.requiresHuman).toBe(true)
    expect(codes(report)).not.toContain('venue_order_unmapped')
  })

  it('场所没回客户端单号 → 按「归属未知」交给人', () => {
    const report = reconcile(input({
      orders: [],
      venue: { openOrders: [venueOpen({ venueOrderId: 'v-9', clientOrderId: null })], historyOrders: [] },
    }), options())
    expect(finding(report, 'venue_order_unmapped')?.tags).toContain('client_id_missing')
  })

  it('未配前缀时一律按未知归属处理（不擅自判成外部单）', () => {
    const report = reconcile(input({
      orders: [],
      venue: { openOrders: [venueOpen({ venueOrderId: 'v-9', clientOrderId: 'whatever-1' })], historyOrders: [] },
    }), options())
    expect(codes(report)).toContain('venue_order_unmapped')
    expect(codes(report)).not.toContain('venue_order_external')
  })
})

describe('多条差异同时存在时不互相覆盖', () => {
  it('两张单各自的问题分别列出', () => {
    const report = reconcile(input({
      orders: [
        localOrder({ orderId: 'o-1', clientOrderId: 'gt-1', venueOrderId: 'v-1' }),
        localOrder({ orderId: 'o-2', clientOrderId: 'gt-2', venueOrderId: 'v-2', createdAt: NOW - 90_000 }),
      ],
      venue: { openOrders: [venueOpen({ venueOrderId: 'v-1', filledSize: '0.02', avgFillPrice: '100' })], historyOrders: [] },
    }), options())
    expect(findings(report, 'fill_missing_inferred')).toHaveLength(1)
    expect(findings(report, 'local_open_venue_missing')).toHaveLength(1)
    expect(report.counts.findings).toBeGreaterThanOrEqual(2)
  })
})
