// SPDX-License-Identifier: CPAL-1.0
// 收口报告里的每个遗留问题至少一条用例（CLOSE-B6-ibkr / CLOSE-B6-alpaca / CLOSE-B56-rest / CLOSE-batch3-leaf）。
// 这些用例不追求「都对」，追求「判不出来时不猜、需要人时明确说要人」。
import { describe, expect, it } from 'vitest'
import { reconcile } from '../src/reconcile'
import { classifyVenueStatus } from '../src/status'
import { codes, finding, findings, input, localFill, localOrder, longPosition, NOW, options, venueFill, venueOpen } from './helpers'
import { alpaca, hyperliquid, ibkr } from './fixtures/venues'

describe('IBKR 遗留（CLOSE-B6-ibkr「需要主会话决定」4）', () => {
  it('不查 completedOrders：已撤单重启后 found:false → 只能标「无法判定」，不写「丢失」', () => {
    const report = reconcile(input({
      orders: [ibkr.local({ createdAt: NOW - 600_000 })],
      venue: { openOrders: [], historyOrders: undefined, unavailable: ['historyOrders'] },
    }), options())
    const f = finding(report, 'local_open_venue_missing')
    expect(f?.tags).toContain('coverage_limited')
    expect(f?.detail).toContain('不提供历史订单')
    expect(f?.detail).toContain('从未到达场所')
    expect(f?.advice.requiresHuman).toBe(true)
  })

  it('按成交找到时状态一律报 Filled：成交量小于原量时标 terminal_status_partial', () => {
    const order = ibkr.local({ filledSize: '40' })
    const report = reconcile(input({
      orders: [order],
      fills: [{ ...ibkr.fill({ size: '40' }), orderId: order.orderId }],
      venue: { openOrders: [], historyOrders: [ibkr.history('Filled', { filledSize: '40', origSize: '100' })], fills: [ibkr.fill({ size: '40' })] },
    }), options())
    const f = finding(report, 'local_open_venue_filled')
    expect(f?.tags).toContain('terminal_status_partial')
    expect(f?.detail).toContain('不等于整单成交')
    expect(report.inferredFills).toHaveLength(0)
  })

  it('ExecId 更正（只改最后一段）未合并 → 两笔同量成交 + 场所两份报告互相矛盾', () => {
    const report = reconcile(input({
      orders: [ibkr.local({ filledSize: '100' })],
      fills: [ibkr.fill({ size: '100', venueFillId: '0000e1a7.6713b2c4.01.01' })],
      venue: {
        openOrders: [],
        historyOrders: [ibkr.history('Filled', { filledSize: '100' })],
        fills: [
          ibkr.fill({ size: '100', venueFillId: '0000e1a7.6713b2c4.01.01' }),
          ibkr.fill({ size: '100', venueFillId: '0000e1a7.6713b2c4.01.02' }),
        ],
      },
    }), options())
    expect(report.dedupe.accepted).toHaveLength(2)
    const f = finding(report, 'fill_total_exceeds_order')
    expect(f?.tags).toContain('venue_reports_disagree')
    expect(f?.detail).toContain('200')
    expect(f?.advice.requiresHuman).toBe(true)
  })

  it('下单后崩溃、账本没来得及记场所单号：靠 orderRef 找回已成交单并推断出成交', () => {
    const report = reconcile(input({
      orders: [ibkr.local({ venueOrderId: null, filledSize: '0' })],
      venue: {
        openOrders: [],
        historyOrders: [ibkr.history('Filled', { filledSize: '100', origSize: '100', avgFillPrice: '190.1' })],
        fills: [],
      },
    }), options())
    const f = finding(report, 'local_open_venue_filled')
    expect(f?.subject.orderId).toBe('ib-o1')
    expect(report.inferredFills).toHaveLength(1)
    const inferred = report.inferredFills[0]
    expect(inferred?.size).toBe('100')
    expect(inferred?.price).toBe('190.1')
    expect(inferred?.inferred).toBe(true)
    expect(inferred?.basis.length).toBeGreaterThan(0)
  })

  it('TWS 手动成交不在 fills 里：持仓差只能靠持仓报告发现，且不许凭空推断成交', () => {
    const report = reconcile(input({
      orders: [],
      venue: { openOrders: [], historyOrders: [], fills: [], positions: [ibkr.position({ size: '100' })] },
    }), options())
    const f = finding(report, 'position_missing_locally')
    expect(f?.advice.action).toBe('review_position')
    expect(codes(report)).not.toContain('fill_missing_inferred')
    expect(report.inferredFills).toHaveLength(0)
  })
})

describe('Alpaca 遗留（CLOSE-B6-alpaca「需要主会话决定」1、2）', () => {
  it('replace 后有链 → 用场所新单号认回同一张逻辑单，不产生孤儿挂单', () => {
    const report = reconcile(input({
      orders: [alpaca.local({ venueOrderId: 'ord-old', clientOrderId: 'gt-alpaca-1' })],
      venue: { openOrders: [alpaca.open({ venueOrderId: 'ord-new', clientOrderId: 'gt-alpaca-1' })], historyOrders: [] },
      links: [
        { clientOrderId: 'gt-alpaca-1', kind: 'submit', venueOrderId: 'ord-old', ts: NOW - 120_000 },
        { clientOrderId: 'gt-alpaca-1', kind: 'replace', previousVenueOrderId: 'ord-old', venueOrderId: 'ord-new', ts: NOW - 60_000 },
      ],
    }), options())
    expect(codes(report)).toContain('amend_chain_resolved')
    expect(codes(report)).not.toContain('venue_order_unmapped')
    expect(codes(report)).not.toContain('fill_orphan')
  })

  it('replace 后场所回的是场所生成的客户端单号、账本没有链 → 会被标出来交给人，不静默丢弃', () => {
    const report = reconcile(input({
      orders: [alpaca.local({ venueOrderId: 'ord-old', clientOrderId: 'gt-alpaca-1' })],
      venue: { openOrders: [alpaca.open({ venueOrderId: 'ord-new', clientOrderId: 'alpaca-gen-9' })], historyOrders: [] },
    }), options({ ownClientOrderIdPrefixes: ['gt-'] }))
    const f = finding(report, 'venue_order_external')
    expect(f).toBeDefined()
    expect(f!.advice.requiresHuman).toBe(true)
    expect(f!.detail).toContain('前缀')
    // 本地那张单在场所查不到，也要单独说出来（两条差异一起看才知道发生了什么）
    expect(codes(report)).toContain('local_open_venue_missing')
  })

  it('replace 后账本已记新单号、场所回的是场所生成的客户端单号且无链 → 按单号认回，码列表为空', () => {
    const report = reconcile(input({
      orders: [alpaca.local({ venueOrderId: 'ord-new', clientOrderId: 'gt-alpaca-1', filledSize: '0', size: '5' })],
      venue: {
        openOrders: [alpaca.open({ venueOrderId: 'ord-new', clientOrderId: 'alpaca-gen-9', status: 'open', filledSize: '0', size: '5', origSize: '5' })],
        historyOrders: [],
      },
    }), options())
    expect(codes(report)).toEqual([])
  })

  it('流与 REST 用同一累计量键、时间戳必须完全相等：时间相同价格不同 → 判冲突', () => {
    const report = reconcile(input({
      orders: [alpaca.local({ venueOrderId: 'ord-a', filledSize: '2' })],
      fills: [localFill({ venueFillId: 'ord-a:2', venueOrderId: 'ord-a', size: '2', price: '190.15', ts: NOW - 1_500 })],
      venue: {
        openOrders: [alpaca.open({ venueOrderId: 'ord-a', filledSize: '2' })],
        historyOrders: [],
        fills: [
          alpaca.fill({ venueFillId: 'ord-a:2', size: '2', price: '190.15', ts: NOW - 1_500 }),
          alpaca.fill({ venueFillId: 'ord-a:2', size: '2', price: '190.16', ts: NOW - 1_500 }),
        ],
      },
    }), options())
    const f = finding(report, 'fill_conflict')
    expect(f?.detail).toContain('190.15')
    expect(f?.detail).toContain('190.16')
  })
})

describe('批次 3 遗留（CLOSE-batch3-leaf「未修项」）', () => {
  it('没有 tradeId 时回退键不含累计量 → 明确写出「两笔真实成交可能被误判成重复」', () => {
    const report = reconcile(input({
      orders: [localOrder()],
      venue: { openOrders: [], historyOrders: [], fills: [venueFill({ venueFillId: '' }), venueFill({ venueFillId: '', size: '0.02' })] },
    }), options())
    const f = finding(report, 'fill_dedupe_key_fallback')
    expect(f?.detail).toContain('回退键')
    expect(f?.advice.action).toBe('fix_dedupe_key')
    // 回退键把数量也算进键里，所以两条不同量的成交各自成键、各自提示（不会被合并成一条）
    expect(findings(report, 'fill_dedupe_key_fallback')).toHaveLength(2)
    expect(report.dedupe.accepted).toHaveLength(2)
  })

  it('IOC 部分成交后撤销：不许判成拒单，缺口按本地最后成交价推断', () => {
    const report = reconcile(input({
      orders: [localOrder({ venueOrderId: '5', filledSize: '0.004' })],
      fills: [localFill({ orderId: 'o-1', venueOrderId: '5', size: '0.004', price: '79000.0' })],
      venue: {
        openOrders: [],
        historyOrders: [venueOpen({
          venueOrderId: '5', clientOrderId: 'gt-1', instrumentId: 'test:BTC', source: 'history',
          status: 'canceled', size: '0', origSize: '0.01', filledSize: '0.006', price: '79000.0',
        })],
        fills: [venueFill({ venueOrderId: '5', size: '0.004', price: '79000.0' })],
      },
    }), options())
    expect(codes(report)).toContain('local_open_venue_cancelled')
    expect(codes(report)).not.toContain('local_open_venue_rejected')
    const inferred = report.inferredFills[0]
    expect(inferred?.size).toBe('0.002')
    expect(inferred?.priceSource).toBe('local_last_fill_price')
  })
})

describe('Hyperliquid 遗留（账户模式 / cloid 缺失）', () => {
  it('cloid 只在部分单上有：场所没回客户端单号的挂单不擅自当成我们的单', () => {
    const report = reconcile(input({
      orders: [],
      venue: { openOrders: [hyperliquid.open({ clientOrderId: null })], historyOrders: [], fills: [] },
    }), options())
    expect(finding(report, 'venue_order_unmapped')?.tags).toContain('client_id_missing')
  })

  it('「marginCanceled」这类上游原话能归到已撤（状态归一表覆盖得到）', () => {
    expect(classifyVenueStatus('marginCanceled')).toBe('cancelled')
    expect(classifyVenueStatus('unknownOid')).toBe('unknown')
  })
})

describe('部分成交只记了一半（local_open_venue_partially_recorded 两条产出路径）', () => {
  it('历史订单报告只有部分成交、没有终结状态 → 建议补记成交', () => {
    const report = reconcile(input({
      orders: [localOrder()],
      venue: {
        openOrders: [],
        historyOrders: [venueOpen({ source: 'history', status: 'partially_filled', filledSize: '0.04', size: '0.06' })],
        fills: [],
      },
    }), options())
    const f = finding(report, 'local_open_venue_partially_recorded')
    expect(f).toBeDefined()
    expect(f?.advice.action).toBe('record_fill')
    expect(f?.advice.requiresHuman).toBe(true)
  })

  it('只有成交、没有订单报告 → 同样建议补记，带 fills_only', () => {
    const report = reconcile(input({
      orders: [localOrder()],
      venue: { openOrders: [], historyOrders: [], fills: [venueFill({ size: '0.04' })] },
    }), options())
    const f = finding(report, 'local_open_venue_partially_recorded')
    expect(f?.tags).toContain('fills_only')
    expect(f?.advice.action).toBe('record_fill')
  })
})

describe('批次 5 / 6 其余遗留（CLOSE-B56-rest）', () => {
  it('成交回补被截断 → 单独提示，缺口推断不可全信', () => {
    const report = reconcile(input({
      orders: [localOrder({ filledSize: '0' })],
      venue: { openOrders: [venueOpen({ filledSize: '0.01' })], historyOrders: [], truncated: true },
    }), options())
    const f = finding(report, 'venue_fills_truncated')
    expect(f?.advice.action).toBe('query_order_status')
    expect(f?.detail).toContain('截断')
  })

  it('账本视图过期 → snapshot_stale，先刷新再判', () => {
    const report = reconcile(input({ orders: [localOrder()], localAsOf: NOW - 3_600_000 }), options({ staleAfterMs: 60_000 }))
    const stale = findings(report, 'snapshot_stale')
    expect(stale.length).toBeGreaterThanOrEqual(1)
    expect(stale[0]?.advice.action).toBe('wait_and_recheck')
  })

  it('场所给不出成交报告 → 明说覆盖缺口，不对已成交量下结论', () => {
    const report = reconcile(input({
      orders: [localOrder({ filledSize: '0.05' })],
      venue: { openOrders: [venueOpen()], historyOrders: [], unavailable: ['fills'] },
    }), options())
    const f = findings(report, 'venue_report_unavailable').find((x) => x.tags?.includes('fills'))
    expect(f).toBeDefined()
    expect(f?.advice.requiresHuman).toBe(true)
    expect(codes(report)).not.toContain('fill_missing_inferred')
  })

  it('持仓只按数量判不够：方向与保证金模式各自能独立报出来', () => {
    const report = reconcile(input({
      positions: [longPosition({ marginMode: 'cross' })],
      venue: { positions: [{ ...longPosition({ marginMode: 'isolated' }) }] },
    }), options())
    expect(codes(report)).toEqual(['position_margin_mode_mismatch'])
  })
})
