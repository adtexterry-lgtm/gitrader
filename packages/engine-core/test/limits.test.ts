// SPDX-License-Identifier: CPAL-1.0
// 手数归一（4 ulp 吸附）与各周期回测窗口上限。
import { describe, expect, it } from 'vitest'
import { CANDLE_INTERVALS, GEP_LIMITS } from '../src/proto'
import { WINDOW_LIMITS, checkBacktestWindow, windowLimitFor } from '../src/runtime/limits'
import { normalizeLot } from '../src/util/decimal'

const MS_PER_DAY = 86_400_000

/** 测试侧独立写的周期毫秒表；1M 按 30 天算。 */
const INTERVAL_MS: Record<(typeof CANDLE_INTERVALS)[number], number> = {
  '1m': 60_000,
  '3m': 180_000,
  '5m': 300_000,
  '15m': 900_000,
  '30m': 1_800_000,
  '1h': 3_600_000,
  '2h': 7_200_000,
  '4h': 14_400_000,
  '8h': 28_800_000,
  '12h': 43_200_000,
  '1d': 86_400_000,
  '3d': 259_200_000,
  '1w': 604_800_000,
  '1M': 30 * MS_PER_DAY,
}

describe('normalizeLot：按 step 向下取整 + 4 ulp 吸附', () => {
  it('吸附到整手：0.30000000000000004 → 0.3（而非 0.2），1.0000000000000002 → 1', () => {
    expect(normalizeLot(0.30000000000000004, 0.1)).toBe(0.3)
    expect(normalizeLot(1.0000000000000002, 0.001)).toBe(1)
  })

  it('真分数不吸附：0.29 → 0.2', () => {
    expect(normalizeLot(0.29, 0.1)).toBe(0.2)
  })

  it('结果低于 minQty → 0；step ≤ 0 → 原值', () => {
    expect(normalizeLot(0.05, 0.1, 0.1)).toBe(0)
    expect(normalizeLot(-0.25, 0.1, 0.1)).toBe(0) // 负数按 value < minQty 判定也归 0（口径写进测试）
    expect(normalizeLot(5, 0)).toBe(5)
  })

  it('负数向零取整：-0.25 → -0.2（QD 的 _round_to_lot 也对 |value| 取 floor，一致）', () => {
    expect(normalizeLot(-0.25, 0.1)).toBe(-0.2)
  })
})

describe('WINDOW_LIMITS：QD 窗口表 + GEP maxHistoryLimit 封顶', () => {
  it('覆盖全部 14 个周期；每项 maxBars = QD 天数表的根数，maxSpanMs = maxBars × 周期毫秒（1M 按 30 天）', () => {
    const QD_BARS = { '1m': 43200, '3m': 14400, '5m': 51840, '15m': 35040, '30m': 17520, '1h': 26280, '2h': 13140, '4h': 6570, '8h': 3285, '12h': 2190, '1d': 1095, '3d': 365, '1w': 156, '1M': 36 }
    expect(WINDOW_LIMITS.map((limit) => limit.interval)).toEqual([...CANDLE_INTERVALS])
    expect(WINDOW_LIMITS.some((limit) => limit.maxBars > GEP_LIMITS.maxHistoryLimit)).toBe(true) // R1-PERF-04：与单页 5000 根脱钩
    expect(windowLimitFor('1M')!.maxBars).toBe(36) // 1M 按 30 天：3 年跨度上限 → 36 根（QD 原表口径）
    for (const interval of CANDLE_INTERVALS) {
      const limit = windowLimitFor(interval)
      expect(limit).toBeDefined()
      expect(limit!.maxBars).toBe(QD_BARS[interval])
      expect(limit!.maxSpanMs).toBe(limit!.maxBars * INTERVAL_MS[interval])
    }
  })

  it('未知周期 → undefined', () => {
    expect(windowLimitFor('bogus')).toBeUndefined()
  })
})

describe('checkBacktestWindow：按 bars 与 span 双重校验', () => {
  it('100 根 1h → ok，bars 100', () => {
    const r = checkBacktestWindow('1h', 0, 100 * 3_600_000)
    expect(r.ok).toBe(true)
    expect(r.bars).toBe(100)
  })

  it('26280 根 1h（3 年）→ ok；30000 根 1h 超上限 → ok false，reason 含 26280', () => {
    expect(checkBacktestWindow('1h', 0, 26_280 * 3_600_000).ok).toBe(true)
    const r = checkBacktestWindow('1h', 0, 30_000 * 3_600_000)
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('26280')
  })

  it('未知周期 → ok false', () => {
    expect(checkBacktestWindow('bogus', 0, 1).ok).toBe(false)
  })
})
