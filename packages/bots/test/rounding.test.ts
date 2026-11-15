// SPDX-License-Identifier: CPAL-1.0
import { describe, expect, it } from 'vitest'
import { runTemplate } from '../src'

const clean = (x: number): boolean => Number(x.toPrecision(15)) === x
const swing = Array.from({ length: 200 }, (_, i) => 1.0 + Math.sin(i / 5) * 0.08)
const mk = (ps: number[]) => ps.map((v, i) => ({ t: 1_730_000_000_000 + i * 3_600_000, o: v, h: v * 1.0005, l: v * 0.9995, c: v, v: 1 }))

describe('GQ-15 bots 金额取整', () => {
  it('网格 0.9-1.1、qty 0.1 / 0.3：notional、fee、realizedPnl、finalEquity、fees、equity 没有二进制尾差', () => {
    for (const qty of [0.1, 0.3]) {
      const run = runTemplate('grid', { lowerPrice: 0.9, upperPrice: 1.1, gridCount: 10, qtyPerGrid: qty, maxExposureNotional: 10_000 }, mk(swing), { feeRate: 0.0004 })
      expect(run.fills.length).toBeGreaterThan(0)
      for (const f of run.fills) { expect(clean(f.notional)).toBe(true); expect(clean(f.fee)).toBe(true) }
      for (const k of ['finalEquity', 'realizedPnl', 'fees', 'maxExposure'] as const) expect(clean(run[k])).toBe(true)
      for (const p of run.equity) expect(clean(p.v)).toBe(true)
    }
  })
  it('反例：价格与数量保持原值（不取整），数值仍与模板记账一致', () => {
    const run = runTemplate('grid', { lowerPrice: 0.9, upperPrice: 1.1, gridCount: 10, qtyPerGrid: 0.1, maxExposureNotional: 10_000 }, mk(swing))
    const f = run.fills[0]!
    expect(f.notional).toBeCloseTo(f.price * f.qty, 12)
    expect(run.realizedPnl).toBeCloseTo(run.snapshot.realizedPnl, 12)
  })
})
