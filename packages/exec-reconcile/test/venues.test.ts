// SPDX-License-Identifier: CPAL-1.0
// 真实回报形状 × 对账场景：每个连接器至少两个（这里给三个），形状与取值都来自各包测试夹具（见 fixtures/venues.ts 的来源注释）。
import { describe, expect, it } from 'vitest'
import { reconcile } from '../src/reconcile'
import { codes, finding, input, NOW, options } from './helpers'
import { ALL_VENUES, type VenueShape } from './fixtures/venues'

/** 每个场所历史上的「已成」原话（大小写与拼法都照上游）。 */
const FILLED_STATUS: Record<string, string> = {
  hyperliquid: 'filled',
  binance: 'FILLED',
  okx: 'filled',
  bybit: 'Filled',
  bitget: 'filled',
  gateio: 'finished/filled',
  alpaca: 'filled',
  ibkr: 'Filled',
}

describe.each(ALL_VENUES.map((v) => [v.name, v] as const))('%s', (name: string, venue: VenueShape) => {
  it('场景一：状态与累计成交量一致 → 没有差异', () => {
    const open = venue.open()
    const filled = open.filledSize ?? '0'
    const order = venue.local({ filledSize: filled, status: filled === '0' ? 'open' : 'partially_filled' })
    const localFills = filled === '0' ? [] : [{ ...venue.fill({ size: filled }), orderId: order.orderId }]
    const report = reconcile(input({
      orders: [order],
      fills: localFills,
      venue: {
        openOrders: [open],
        historyOrders: [],
        fills: filled === '0' ? [] : [venue.fill({ size: filled })],
        positions: [],
      },
    }), options())
    // Alpaca 的成交号由「订单号 + 累计成交量」合成，这会额外带出一条键风险提示（预期之内）
    const expected = name === 'alpaca' ? ['fill_dedupe_key_cumulative'] : []
    expect(codes(report)).toEqual(expected)
    // Alpaca 那条键风险提示会让人看一眼，所以结论是「要注意」，不是「无差异」
    expect(report.verdict).toBe(name === 'alpaca' ? 'attention' : 'clean')
  })

  it('场景二：场所已成、账本仍当在挂 → 建议按成交处理', () => {
    const status = FILLED_STATUS[name] ?? 'filled'
    const report = reconcile(input({
      orders: [venue.local()],
      venue: { openOrders: [], historyOrders: [venue.history(status)], fills: [], positions: [] },
    }), options())
    const f = finding(report, 'local_open_venue_filled')
    expect(f).toBeDefined()
    expect(f!.advice.requiresHuman).toBe(true)
    expect(f!.detail).toContain(status)
  })

  it('场景三：场所有挂单、账本没有 → 归属未知，交给人确认', () => {
    const report = reconcile(input({
      orders: [],
      venue: { openOrders: [venue.open()], historyOrders: [], fills: [], positions: [] },
    }), options())
    expect(codes(report)).toContain('venue_order_unmapped')
    expect(finding(report, 'venue_order_unmapped')?.advice.requiresHuman).toBe(true)
  })
})

describe('跨场所的形状差异（同一份判定逻辑吃不同原话）', () => {
  it('Gate 的 finished/cancelled 归到已撤，不归到已成', () => {
    const venue = ALL_VENUES.find((v) => v.name === 'gateio')!
    const report = reconcile(input({
      orders: [venue.local()],
      venue: { openOrders: [], historyOrders: [venue.history('finished/cancelled', { filledSize: '0' })], fills: [], positions: [] },
    }), options())
    expect(codes(report)).toContain('local_open_venue_cancelled')
    expect(codes(report)).not.toContain('local_open_venue_filled')
  })

  it('Bybit 的 PartiallyFilledCanceled 视为已撤（带部分成交）', () => {
    const venue = ALL_VENUES.find((v) => v.name === 'bybit')!
    const report = reconcile(input({
      orders: [venue.local({ filledSize: '0.004' })],
      fills: [venue.fill({ size: '0.004' })],
      venue: {
        openOrders: [],
        historyOrders: [venue.history('PartiallyFilledCanceled', { filledSize: '0.004' })],
        fills: [venue.fill({ size: '0.004' })],
        positions: [],
      },
    }), options({ now: NOW }))
    expect(codes(report)).toContain('local_open_venue_cancelled')
  })

  it('IBKR 的 ApiCancelled 也算已撤（不是拒单）', () => {
    const venue = ALL_VENUES.find((v) => v.name === 'ibkr')!
    const report = reconcile(input({
      orders: [venue.local()],
      venue: { openOrders: [], historyOrders: [venue.history('ApiCancelled', { filledSize: '0' })], fills: [], positions: [] },
    }), options())
    expect(codes(report)).toContain('local_open_venue_cancelled')
    expect(codes(report)).not.toContain('local_open_venue_rejected')
  })

  it('Hyperliquid 的 marginCanceled / sibling 类状态落到已撤（含 cancel 子串）', () => {
    const venue = ALL_VENUES.find((v) => v.name === 'hyperliquid')!
    const report = reconcile(input({
      orders: [venue.local()],
      venue: { openOrders: [], historyOrders: [venue.history('marginCanceled')], fills: [], positions: [] },
    }), options())
    expect(codes(report)).toContain('local_open_venue_cancelled')
  })
})
