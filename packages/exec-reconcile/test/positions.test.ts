// SPDX-License-Identifier: CPAL-1.0
// 持仓差异：按标的 × 方向 × 保证金模式，数量比较带容差。
import { describe, expect, it } from 'vitest'
import { classifyPositions } from '../src/positions'
import { reconcile } from '../src/reconcile'
import { resolveOptions } from '../src/tolerance'
import { codes, finding, input, longPosition, NOW, options, shortPosition, venuePositionOf } from './helpers'

const opts = resolveOptions({ now: NOW })

describe('持仓一致', () => {
  it('数量、方向、保证金模式都一样 → 没有持仓差异', () => {
    const found = classifyPositions(input({
      positions: [longPosition()],
      venue: { positions: [venuePositionOf(longPosition())] },
    }), opts)
    expect(found).toEqual([])
  })

  it('数量差在容差内不算不符', () => {
    const found = classifyPositions(input({
      positions: [longPosition({ size: '0.1' })],
      venue: { positions: [venuePositionOf(longPosition({ size: '0.1005' }))] },
    }), resolveOptions({ now: NOW, positionTolerance: '0.001' }))
    expect(found).toEqual([])
  })
})

describe('持仓不符', () => {
  it('数量不符 → review_position，需人工，并写出差额', () => {
    const found = classifyPositions(input({
      positions: [longPosition({ size: '0.1' })],
      venue: { positions: [venuePositionOf(longPosition({ size: '0.06' }))] },
    }), opts)
    const f = found.find((x) => x.code === 'position_size_mismatch')
    expect(f?.advice.action).toBe('review_position')
    expect(f?.detail).toContain('-0.04')
  })

  it('方向相反 → halt_account_and_review（继续按账本下单会变双向持仓）', () => {
    const found = classifyPositions(input({
      positions: [longPosition({ size: '0.1' })],
      venue: { positions: [venuePositionOf(shortPosition({ size: '0.1' }))] },
    }), opts)
    expect(found.map((f) => f.code)).toContain('position_side_mismatch')
    expect(found[0]?.advice.action).toBe('halt_account_and_review')
  })

  it('账本有、场所平 → position_missing_at_venue', () => {
    const found = classifyPositions(input({ positions: [longPosition()] }), opts)
    expect(found.map((f) => f.code)).toEqual(['position_missing_at_venue'])
  })

  it('场所有、账本无 → position_missing_locally', () => {
    const found = classifyPositions(input({ venue: { positions: [venuePositionOf(longPosition())] } }), opts)
    expect(found.map((f) => f.code)).toEqual(['position_missing_locally'])
  })

  it('保证金模式不符 → 单独报（数量一致也要报）', () => {
    const found = classifyPositions(input({
      positions: [longPosition({ marginMode: 'cross' })],
      venue: { positions: [venuePositionOf(longPosition({ marginMode: 'isolated' }))] },
    }), opts)
    expect(found.map((f) => f.code)).toEqual(['position_margin_mode_mismatch'])
  })

  it('开仓均价偏移超容差 → 提示级，不改账', () => {
    const found = classifyPositions(input({
      positions: [longPosition({ entryPrice: '100' })],
      venue: { positions: [venuePositionOf(longPosition({ entryPrice: '100.5' }))] },
    }), opts)
    const f = found.find((x) => x.code === 'position_entry_price_drift')
    expect(f?.severity).toBe('info')
    expect(f?.advice.requiresHuman).toBe(false)
  })

  it('场所按双向持仓报两条腿、账本是净额 → 只报持仓形状不符，不再按腿比数量 / 报缺失', () => {
    const found = classifyPositions(input({
      positions: [longPosition({ size: '0.1' })],
      venue: { positions: [venuePositionOf(longPosition({ size: '0.1' })), venuePositionOf(shortPosition({ size: '0.1' }))] },
    }), opts)
    const list = found.map((f) => f.code)
    expect(list).toEqual(['position_shape_mismatch'])
    expect(list).not.toContain('position_missing_locally')
  })

  it('账本两条腿、场所只有一条腿 → 也只报持仓形状不符，不再比数量', () => {
    const found = classifyPositions(input({
      positions: [longPosition({ size: '2' }), shortPosition({ size: '1' })],
      venue: { positions: [venuePositionOf(shortPosition({ size: '5' }))] },
    }), opts)
    expect(found.map((f) => f.code)).toEqual(['position_shape_mismatch'])
  })
})

describe('推断成交能解释的持仓差额', () => {
  it('差额与推断成交一致 → tags 标 explained_by_inferred_fill（仍要人确认）', () => {
    const found = classifyPositions(input({
      positions: [longPosition({ size: '0.1' })],
      venue: { positions: [venuePositionOf(longPosition({ size: '0.16' }))] },
    }), opts, [{ instrumentId: 'test:BTC', signedSize: '0.06' }])
    const f = found.find((x) => x.code === 'position_size_mismatch')
    expect(f?.tags).toContain('explained_by_inferred_fill')
    expect(f?.advice.requiresHuman).toBe(true)
  })

  it('端到端：成交缺口 → 推断成交 → 持仓差额被标注为同一笔', () => {
    const report = reconcile(input({
      orders: [{
        orderId: 'o-1', clientOrderId: 'gt-1', venueOrderId: 'v-1', instrumentId: 'test:BTC', side: 'buy',
        type: 'limit', size: '0.16', filledSize: '0.1', price: '100', status: 'partially_filled', createdAt: NOW - 60_000,
      }],
      fills: [{ venueFillId: 'f-1', orderId: 'o-1', venueOrderId: 'v-1', instrumentId: 'test:BTC', side: 'buy', price: '100', size: '0.1', ts: NOW - 30_000 }],
      positions: [longPosition({ size: '0.1' })],
      venue: {
        openOrders: [{
          venueOrderId: 'v-1', clientOrderId: 'gt-1', instrumentId: 'test:BTC', side: 'buy', size: '0', origSize: '0.16',
          filledSize: '0.16', avgFillPrice: '100', price: '100', status: 'partially_filled', source: 'open',
        }],
        historyOrders: [],
        fills: [{ venueFillId: 'f-1', venueOrderId: 'v-1', instrumentId: 'test:BTC', side: 'buy', price: '100', size: '0.1', ts: NOW - 30_000 }],
        positions: [venuePositionOf(longPosition({ size: '0.16' }))],
      },
    }), options())
    expect(codes(report)).toContain('fill_missing_inferred')
    expect(codes(report)).toContain('position_size_mismatch')
    expect(finding(report, 'position_size_mismatch')?.tags).toContain('explained_by_inferred_fill')
    expect(report.inferredFills).toHaveLength(1)
  })
})
