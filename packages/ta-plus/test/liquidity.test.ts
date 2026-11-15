// SPDX-License-Identifier: CPAL-1.0
// 流动性 / 位置指标的独立参照值。参照来源：
//   · volumeRatio：QuantDinger app/services/market/technical_indicators.py:157-163 的定义（当根量 / 前 period 根均量，
//     明确不含当根，注释给了「含当根会系统性压低比值」的理由）；期望值用可整除的整数手算；
//   · pricePosition：同文件 165-168 行的 (close−low)/(high−low)×100；区间边界用整数构造，结果可心算。
import { describe, expect, it } from 'vitest'
import type { Bar } from '../src/index'
import { pricePosition, volumeRatio } from '../src/index'

describe('量比 volumeRatio', () => {
  // 手算：[10,10,20]，period=2 → 基线 = (10+10)/2 = 10，当根 20 → 2.0
  it('[10,10,20] period=2 → 2.0', () => {
    const out = volumeRatio([10, 10, 20], 2)
    expect(out[0]).toBeNull()
    expect(out[1]).toBeNull()
    expect(out[2]).toBeCloseTo(2, 15)
  })

  // 口径核对：[5,15,15] period=2 → 基线 (5+15)/2 = 10 → 15/10 = 1.5。
  // 若把当根算进基线（参考实现 factors/registry.py 的做法）会是 15/((5+15+15)/3) = 1.2857…，本包不采用。
  it('基线不含当根：[5,15,15] → 1.5（含当根会是 1.2857…）', () => {
    expect(volumeRatio([5, 15, 15], 2)[2]).toBeCloseTo(1.5, 15)
  })

  it('基线均量为 0 时为 null（不产出 Infinity）', () => {
    expect(volumeRatio([0, 0, 5], 2)[2]).toBeNull()
  })
})

describe('价格位置 pricePosition', () => {
  // 手算：h=[10,12,14]，l=[8,9,10]，c=[9,11,13]，period=3 → hh=14，ll=8 → (13−8)/(14−8)×100 = 83.33333333333333
  it('三日区间 8..14、收盘 13 → 83.33333333333333', () => {
    const bars: Bar[] = [
      { o: 9, h: 10, l: 8, c: 9, v: 1 },
      { o: 11, h: 12, l: 9, c: 11, v: 1 },
      { o: 13, h: 14, l: 10, c: 13, v: 1 },
    ]
    expect(pricePosition(bars, 3)[2]).toBeCloseTo(83.33333333333333, 12)
  })

  it('区间高度为 0 → 50（中性值）', () => {
    const bars: Bar[] = Array.from({ length: 3 }, () => ({ o: 7, h: 7, l: 7, c: 7, v: 1 }))
    expect(pricePosition(bars, 3)[2]).toBeCloseTo(50, 15)
  })

  it('收盘落在区间底部 → 0，顶部 → 100', () => {
    const bars: Bar[] = [
      { o: 10, h: 11, l: 9, c: 10, v: 1 },
      { o: 10, h: 11, l: 9, c: 9, v: 1 },
      { o: 10, h: 11, l: 9, c: 11, v: 1 },
    ]
    expect(pricePosition(bars, 2)[1]).toBeCloseTo(0, 15)
    expect(pricePosition(bars, 2)[2]).toBeCloseTo(100, 15)
  })
})
