// SPDX-License-Identifier: CPAL-1.0
// 统计与区间类指标的独立参照值。参照来源：
//   · avgDev：TA-Lib ta_AVGDEV.c:186-204（窗口内对简单平均的平均绝对偏差，除以 period）；[1..5] 手算 1.2；
//   · variance：TA-Lib ta_VAR.c 在 nbDev=1 时的口径（总体方差），[1..5] 总体 2 / 样本 2.5 为教科书已知值；
//   · bop：TA-Lib ta_BOP.c:106（(close−open)/(high−low)，无窗口）；单根 bar 手算；
//   · adxr：TA-Lib ta_ADXR.c:170-177（(ADX[k]+ADX[k−(period−1)])/2）；输入用给定的 ADX 序列手算。
import { describe, expect, it } from 'vitest'
import type { Bar, Series } from '../src/index'
import { adxr, avgDev, bop, variance } from '../src/index'

describe('平均绝对偏差 avgDev', () => {
  // 手算 [1..5] period=5：均值 3，偏差 2,1,0,1,2 → 和 6 → 6/5 = 1.2
  it('[1,2,3,4,5] period=5 → 1.2', () => {
    expect(avgDev([1, 2, 3, 4, 5], 5)[4]).toBeCloseTo(1.2, 15)
  })

  it('[2,4] period=2 → 1（均值 3，各偏 1）', () => {
    expect(avgDev([2, 4], 2)[1]).toBeCloseTo(1, 15)
  })

  it('窗口外为 null，输出等长', () => {
    const out = avgDev([1, 2, 3, 4, 5], 3)
    expect(out.length).toBe(5)
    expect(out.slice(0, 2)).toEqual([null, null])
  })
})

describe('滚动方差 variance', () => {
  // 手算 [1..5]：均值 3，平方和 4+1+0+1+4 = 10 → 总体 10/5 = 2，样本 10/4 = 2.5
  it('[1,2,3,4,5] period=5 → 总体 2、样本（ddof=1）2.5', () => {
    expect(variance([1, 2, 3, 4, 5], 5)[4]).toBeCloseTo(2, 15)
    expect(variance([1, 2, 3, 4, 5], 5, 1)[4]).toBeCloseTo(2.5, 15)
  })

  it('常数序列方差 0', () => {
    expect(variance([4, 4, 4], 3)[2]).toBeCloseTo(0, 15)
  })

  it('period ≤ ddof 时抛 RangeError', () => {
    expect(() => variance([1, 2, 3], 2, 2)).toThrow(RangeError)
  })
})

describe('力量平衡 bop', () => {
  // 手算单根 bar {o:10,h:12,l:8,c:11}：(11−10)/(12−8) = 0.25
  it('{o:10,h:12,l:8,c:11} → 0.25', () => {
    const bars: Bar[] = [{ o: 10, h: 12, l: 8, c: 11, v: 1 }]
    expect(bop(bars)[0]).toBeCloseTo(0.25, 15)
  })

  it('区间为 0 → 0（不产出 NaN）', () => {
    const bars: Bar[] = [{ o: 8, h: 9, l: 9, c: 8, v: 1 }]
    expect(bop(bars)[0]).toBeCloseTo(0, 15)
  })

  it('多根 bar 各自计算，输出等长', () => {
    const bars: Bar[] = [
      { o: 10, h: 12, l: 8, c: 11, v: 1 },
      { o: 10, h: 12, l: 8, c: 8, v: 1 },
      { o: 10, h: 12, l: 8, c: 10, v: 1 },
    ]
    const out = bop(bars)
    expect(out.length).toBe(3)
    expect(out[1]).toBeCloseTo(-0.5, 15)
    expect(out[2]).toBeCloseTo(0, 15)
  })
})

describe('ADX 评级 adxr', () => {
  // 手算：ADX 序列 [null,10,20,30,40]，period=3（滞后 period−1=2 位）
  //   out[3] = (30+10)/2 = 20，out[4] = (40+20)/2 = 30，out[2] 的回看项是 null → null
  it('[null,10,20,30,40] period=3 → out[3]=20，out[4]=30', () => {
    const adxValues: Series = [null, 10, 20, 30, 40]
    const out = adxr(adxValues, 3)
    expect(out[2]).toBeNull()
    expect(out[3]).toBeCloseTo(20, 15)
    expect(out[4]).toBeCloseTo(30, 15)
  })

  it('period=1 时退化为原序列（滞后 0 位）', () => {
    const out = adxr([1, 2, 3], 1)
    expect(out).toEqual([1, 2, 3])
  })
})

describe('GQ-26 variance 极端输入', () => {
  const base = Array.from({ length: 40 }, (_, i) => 1 + (i % 7) / 10)
  it('1e300 量级：方差超出双精度范围 → null，不返回 Infinity', () => {
    const out = variance(
      base.map((v) => v * 1e300),
      10,
    )
    expect(out.every((x) => x === null || Number.isFinite(x))).toBe(true)
    expect(out.slice(9).every((x) => x === null)).toBe(true) // 修前这里是 Infinity
  })
  it('反例：1e100 量级方差仍可表示，与缩放后的结果等价（不能一律给 null）', () => {
    const a = variance(base, 10)
    const b = variance(
      base.map((v) => v * 1e100),
      10,
    )
    b.slice(9).forEach((x, i) => expect(x! / 1e200).toBeCloseTo(a[9 + i]!, 9))
  })
  it('窗口内 NaN：含它的窗口 null，之后恢复', () => {
    const v = Array.from({ length: 20 }, (_, i) => 10 + i)
    v[8] = Number.NaN
    const out = variance(v, 4)
    for (let i = 3; i < 20; i++) {
      if (i >= 8 && i <= 11) expect(out[i]).toBeNull()
      else expect(Number.isFinite(out[i] as number)).toBe(true)
    }
  })
})
