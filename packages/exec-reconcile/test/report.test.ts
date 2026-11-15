// SPDX-License-Identifier: CPAL-1.0
// 报告的收口要求：结论分级、可复现、输入不被改、每条差异都有建议、渲染给人看得懂。
import { describe, expect, it } from 'vitest'
import { ADVICE, SEVERITY } from '../src/advice'
import { evidenceOf, findingsByCode, reconcile, validateInput } from '../src/reconcile'
import { renderReport } from '../src/render'
import { FINDING_CODES, type ReconcileInput } from '../src/types'
import { codes, input, localFill, localOrder, NOW, options, venueFill, venueOpen } from './helpers'

const cleanInput = (): ReconcileInput => input({ orders: [localOrder()], venue: { openOrders: [venueOpen()], historyOrders: [] } })

describe('结论分级', () => {
  it('没有差异 → clean', () => {
    expect(reconcile(cleanInput(), options()).verdict).toBe('clean')
  })
  it('只有提示级差异 → clean（不打扰人）', () => {
    const report = reconcile(input({
      orders: [localOrder({ createdAt: NOW - 1_000, updatedAt: NOW - 1_000 })],
      venue: { openOrders: [], historyOrders: [] },
    }), options())
    expect(codes(report)).toEqual(['order_unverified_within_latency'])
    expect(report.verdict).toBe('clean')
    expect(report.counts.needsHuman).toBe(0)
  })
  it('只有注意级差异 → attention', () => {
    const report = reconcile(input({
      orders: [localOrder()],
      venue: { openOrders: [], historyOrders: [venueOpen({ source: 'history', status: 'CANCELED', filledSize: '0' })] },
    }), options())
    expect(report.verdict).toBe('attention')
  })
  it('有阻断级差异 → blocked', () => {
    const report = reconcile(input({
      orders: [localOrder({ createdAt: NOW - 600_000 })],
      venue: { openOrders: [], historyOrders: [] },
    }), options())
    expect(report.verdict).toBe('blocked')
  })
})

describe('可复现与纯函数', () => {
  it('生成时刻只取 options.now（不读系统时钟）', () => {
    const report = reconcile(cleanInput(), options({ now: 1_700_000_000_000 }))
    expect(report.generatedAt).toBe(1_700_000_000_000)
  })

  it('同一输入连续两次调用结果完全一致', () => {
    const data = input({
      orders: [localOrder({ filledSize: '0.04' })],
      fills: [localFill({ size: '0.04' })],
      venue: { openOrders: [venueOpen({ filledSize: '0.1', avgFillPrice: '99' })], historyOrders: [] },
    })
    const a = reconcile(data, options())
    const b = reconcile(data, options())
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('输入对象一个字段都不改（含嵌套数组与对象）', () => {
    const data = input({
      orders: [localOrder({ filledSize: '0.04' })],
      fills: [localFill({ size: '0.04' })],
      venue: {
        openOrders: [venueOpen({ filledSize: '0.1', avgFillPrice: '99' })],
        historyOrders: [],
        fills: [venueFill({ size: '0.04' })],
        positions: [],
      },
      links: [{ clientOrderId: 'gt-1', kind: 'submit', venueOrderId: 'v-1', ts: NOW - 90_000 }],
    })
    const before = JSON.stringify(data)
    reconcile(data, options())
    expect(JSON.stringify(data)).toBe(before)
  })

  it('容差参数原样回显，便于人核对结论依据', () => {
    const report = reconcile(cleanInput(), options({ sizeTolerance: '0.0001', positionTolerance: '0.001', priceToleranceBps: 12, clockSkewMs: 500 }))
    expect(report.options.sizeTolerance).toBe('0.0001')
    expect(report.options.positionTolerance).toBe('0.001')
    expect(report.options.priceToleranceBps).toBe(12)
    expect(report.options.clockSkewMs).toBe(500)
  })

  it('输入映射写错（数量不是十进制）立刻抛错，不产出错结论', () => {
    expect(() => validateInput(input({ orders: [localOrder({ size: 'abc' })] }))).toThrow(TypeError)
    expect(() => validateInput(input({ venue: { fills: [venueFill({ price: '1e5' })] } }))).toThrow(TypeError)
    expect(() => validateInput(input({ localAsOf: Number.NaN }))).toThrow(TypeError)
  })
})

describe('每条差异都有建议', () => {
  it('全部差异码都登记了建议与严重度（新增码不许漏）', () => {
    for (const code of FINDING_CODES) {
      const advice = ADVICE[code]
      expect(advice, code).toBeDefined()
      expect(advice.why.length, code).toBeGreaterThan(8)
      expect(typeof advice.requiresHuman, code).toBe('boolean')
      expect(SEVERITY[code], code).toBeDefined()
    }
  })

  it('推断类差异一定带 inferred 与依据，非推断类不带 inferred', () => {
    const report = reconcile(input({
      orders: [
        localOrder({ filledSize: '0.04' }),
        localOrder({ orderId: 'o-2', clientOrderId: 'gt-2', venueOrderId: 'v-2', createdAt: NOW - 600_000 }),
      ],
      fills: [localFill({ size: '0.04' })],
      venue: { openOrders: [venueOpen({ filledSize: '0.1', avgFillPrice: '99' })], historyOrders: [] },
    }), options())
    const inferred = findingsByCode(report, 'fill_missing_inferred')[0]
    expect(inferred?.inferred).toBe(true)
    expect(inferred?.basis?.length).toBeGreaterThanOrEqual(3)
    expect(inferred?.evidence.length).toBeGreaterThanOrEqual(3)
    const other = report.findings.find((f) => f.code !== 'fill_missing_inferred')
    expect(other).toBeDefined()
    expect(other?.inferred).toBeUndefined()
  })

  it('证据能指出「哪份报告、哪条记录、哪个字段」', () => {
    const report = reconcile(input({
      orders: [localOrder()],
      venue: { openOrders: [], historyOrders: [venueOpen({ source: 'history', status: 'FILLED', filledSize: '0.1' })] },
    }), options())
    const found = findingsByCode(report, 'local_open_venue_filled')[0]!
    const evidence = evidenceOf(found)
    expect(evidence.some((e) => e.report === 'venue.historyOrders' && e.field === 'status' && e.value === 'FILLED')).toBe(true)
    expect(evidence.some((e) => e.report === 'local.orders' && e.field === 'status')).toBe(true)
  })

  it('统计与清单自洽（needsHuman ⊆ findings，条数一致）', () => {
    const report = reconcile(input({
      orders: [localOrder({ createdAt: NOW - 600_000 }), localOrder({ orderId: 'o-2', clientOrderId: 'gt-2', venueOrderId: 'v-2' })],
      venue: { openOrders: [venueOpen({ venueOrderId: 'v-2', filledSize: '0.05' })], historyOrders: [] },
    }), options())
    expect(report.counts.findings).toBe(report.findings.length)
    expect(report.counts.blocker + report.counts.warn + report.counts.info).toBe(report.findings.length)
    expect(report.needsHuman.length).toBe(report.counts.needsHuman)
    for (const f of report.needsHuman) expect(f.advice.requiresHuman).toBe(true)
  })
})

describe('给人类看的渲染', () => {
  it('渲染里能看到结论、条数、建议动作与证据行', () => {
    const report = reconcile(input({
      orders: [localOrder({ createdAt: NOW - 600_000 })],
      venue: { openOrders: [], historyOrders: [] },
    }), options())
    const text = renderReport(report, { venueLabel: '测试场所' })
    expect(text).toContain('对账报告 · acct_01TEST')
    expect(text).toContain('测试场所')
    expect(text).toContain('有阻断差异')
    expect(text).toContain('local_open_venue_missing')
    expect(text).toContain('query_order_status')
    expect(text).toContain('证据：')
    expect(text).toContain('容差：')
  })

  it('推断成交单独一节，写清依据与定价来源', () => {
    const report = reconcile(input({
      orders: [localOrder({ filledSize: '0.04' })],
      fills: [localFill({ size: '0.04' })],
      venue: { openOrders: [venueOpen({ filledSize: '0.1', avgFillPrice: '99' })], historyOrders: [] },
    }), options())
    const text = renderReport(report)
    expect(text).toContain('推断成交（全部标 inferred，须人工确认后才能入账）')
    expect(text).toContain('venue_avg_fill_price')
    expect(text).toContain('场所订单')
  })

  it('差异过多时只列前 N 条并给出剩余条数（避免刷屏）', () => {
    const orders = Array.from({ length: 5 }, (_, i) => localOrder({ orderId: `o-${i}`, clientOrderId: `gt-${i}`, venueOrderId: `v-${i}`, createdAt: NOW - 600_000 }))
    const report = reconcile(input({ orders, venue: { openOrders: [], historyOrders: [] } }), options())
    const text = renderReport(report, { maxFindings: 2 })
    expect(text).toContain('其余 3 条未列出')
  })

  it('无差异时明确说一致（不写空话）', () => {
    const text = renderReport(reconcile(cleanInput(), options()))
    expect(text).toContain('两侧视图一致')
  })
})
