// SPDX-License-Identifier: CPAL-1.0
// 风险 / 波动指标的独立参照值。参照来源逐条写在用例里，全部是「定义 + 小样本算术」，与本包实现无关：
//   · 样本标准差 / 偏度 / 峰度：pandas .std(ddof=1) / .skew() / .kurt() 的公开定义式（bias=False 校正版），
//     数值用手算的精确分数给出（见注释里的分数推导），不用任何代码算出来再抄；
//   · 最大回撤：定义式 v/peak − 1 取窗口最小值，小样本可逐步核对；
//   · ATR 占价比、Amihud：QuantDinger app/services/factors/registry.py:384-388 / 1075-1083 的定义式。
import { describe, expect, it } from 'vitest'
import type { Bar } from '../src/index'
import {
  amihudIlliquidity,
  atrPercent,
  downsideVolatility,
  kurtosis,
  maxDrawdown,
  realizedVolatility,
  skewness,
} from '../src/index'

describe('已实现波动率 realizedVolatility', () => {
  it('常数收益序列标准差为 0（[1%,1%,1%,1%]，ddof=1）', () => {
    const out = realizedVolatility([0.01, 0.01, 0.01, 0.01], 4)
    expect(out[3]).toBeCloseTo(0, 15)
  })

  // 手算：r = [+1%,−1%,+1%,−1%]，均值 0，Σ(r−μ)² = 4×1e−4 = 4e−4，
  // 样本方差 = 4e−4/3 → s = 0.011547005383792516；年化 ×√252 = 0.18330302779823363。
  it('交替 ±1% 的样本标准差 0.011547005383792516，年化 0.18330302779823363', () => {
    const returns = [0.01, -0.01, 0.01, -0.01]
    const raw = realizedVolatility(returns, 4, { annualize: false })
    const annual = realizedVolatility(returns, 4)
    expect(raw[3]).toBeCloseTo(0.011547005383792516, 15)
    expect(annual[3]).toBeCloseTo(0.18330302779823363, 12)
  })

  it('预热期（前 period−1 项）为 null，输出与输入等长', () => {
    const out = realizedVolatility([0.01, -0.01, 0.01, -0.01, 0.02], 3)
    expect(out.length).toBe(5)
    expect(out[0]).toBeNull()
    expect(out[1]).toBeNull()
    expect(out[2]).not.toBeNull()
  })

  it('非有限收益抛 RangeError', () => {
    expect(() => realizedVolatility([0.01, Number.NaN], 2)).toThrow(RangeError)
  })
})

describe('下行波动率 downsideVolatility', () => {
  // 手算：r = [+2%,−1%,+3%,−2%]，只取负偏离：1e−4 + 4e−4 = 5e−4，除以整窗 4 = 1.25e−4，
  // 开方 = 0.011180339887498949，年化 ×√252 = 0.1774823934929885。
  it('[+2%,−1%,+3%,−2%] → 0.011180339887498949，年化 0.1774823934929885', () => {
    const returns = [0.02, -0.01, 0.03, -0.02]
    expect(downsideVolatility(returns, 4, { annualize: false })[3]).toBeCloseTo(0.011180339887498949, 15)
    expect(downsideVolatility(returns, 4)[3]).toBeCloseTo(0.1774823934929885, 12)
  })

  // 同上但 mar=1%：低于 1% 的偏差是 (−1%−1%) = −2% 与 (−2%−1%) = −3%，
  // 平方和 4e−4 + 9e−4 = 1.3e−3，/4 = 3.25e−4，开方 = 0.018027756377319945，年化 = 0.2861817604250837。
  it('mar=1% 时只有低于目标的偏差计入 → 0.018027756377319945，年化 0.2861817604250837', () => {
    const returns = [0.02, -0.01, 0.03, -0.02]
    expect(downsideVolatility(returns, 4, { annualize: false, mar: 0.01 })[3]).toBeCloseTo(0.018027756377319945, 15)
    expect(downsideVolatility(returns, 4, { mar: 0.01 })[3]).toBeCloseTo(0.2861817604250837, 12)
  })

  it('全部为正收益 → 下行波动率为 0', () => {
    expect(downsideVolatility([0.01, 0.02, 0.03, 0.04], 4)[3]).toBeCloseTo(0, 15)
  })
})

describe('偏度 skewness', () => {
  it('对称样本 [1,2,3,4,5] 的样本偏度为 0（第三次矩正负相消）', () => {
    const out = skewness([1, 2, 3, 4, 5], 5)
    expect(out[4]).toBeCloseTo(0, 15)
  })

  // 手算（sample，n=5）：μ=4，s²=50/4=12.5，s=3.5355339059327378，
  // Σz³ = (−27−8−1+0+216)/s³ = 180/44.19417382415922 = 4.0732703823...，
  // × n/((n−1)(n−2)) = 5/12 → 1.697056274847714（= 1.2√2）。
  it('[1,2,3,4,10] 的样本偏度 1.697056274847714（=1.2√2）', () => {
    expect(skewness([1, 2, 3, 4, 10], 5)[4]).toBeCloseTo(1.697056274847714, 12)
  })

  // 总体口径 g1 = m3/m2^1.5：m2 = 10，m3 = 36 → 36/31.6227766 = 1.1384199576606167。
  it('[1,2,3,4,10] 的总体偏度 1.1384199576606167（=36/(10√10)）', () => {
    expect(skewness([1, 2, 3, 4, 10], 5, { sample: false })[4]).toBeCloseTo(1.1384199576606167, 12)
  })

  it('窗口标准差为 0 时取中性值 0', () => {
    expect(skewness([7, 7, 7, 7], 4)[3]).toBeCloseTo(0, 15)
  })
})

describe('超额峰度 kurtosis', () => {
  // 手算（总体）：[1..5]，μ=3，m2 = (4+1+0+1+4)/5 = 2，m4 = (16+1+0+1+16)/5 = 6.8，
  // m4/m2² − 3 = 6.8/4 − 3 = −1.3（均匀五点分布的已知值）。
  it('[1,2,3,4,5] 的总体超额峰度 −1.3', () => {
    expect(kurtosis([1, 2, 3, 4, 5], 5, { sample: false })[4]).toBeCloseTo(-1.3, 12)
  })

  // 手算（sample，Excel KURT / pandas .kurt()）：s²=2.5，Σz⁴ = 34/6.25 = 5.44，
  // 5·6/(4·3·2)·5.44 − 3·16/(3·2) = 1.25·5.44 − 8 = 6.8 − 8 = −1.2。
  it('[1,2,3,4,5] 的样本超额峰度 −1.2', () => {
    expect(kurtosis([1, 2, 3, 4, 5], 5)[4]).toBeCloseTo(-1.2, 12)
  })

  it('样本口径需要 n ≥ 4，不足时整列 null', () => {
    expect(kurtosis([1, 2, 3], 3)[2]).toBeNull()
  })

  it('窗口标准差为 0 时取中性值 0', () => {
    expect(kurtosis([5, 5, 5, 5], 4)[3]).toBeCloseTo(0, 15)
  })
})

describe('最大回撤 maxDrawdown', () => {
  // 手算：[100,120,90,110]，峰 120 → 谷 90，dd = 90/120 − 1 = −0.25。
  it('[100,120,90,110] 的窗口最大回撤 −0.25', () => {
    expect(maxDrawdown([100, 120, 90, 110], 4)[3]).toBeCloseTo(-0.25, 15)
  })

  it('单调上升序列的最大回撤为 0', () => {
    expect(maxDrawdown([10, 11, 12, 13], 4)[3]).toBeCloseTo(0, 15)
  })

  it('回撤逐 bar 因果：窗口只含当前及之前的数据', () => {
    const out = maxDrawdown([100, 120, 90, 110], 2)
    expect(out[1]).toBeCloseTo(0, 15) // [100,120] 无回撤
    expect(out[2]).toBeCloseTo(-0.25, 15) // [120,90]
    expect(out[3]).toBeCloseTo(0, 15) // [90,110]
  })
})

describe('ATR 占价比 atrPercent', () => {
  // 手算：每根 bar 全等 {o:10,h:11,l:9,c:10}，TR = max(2, |11−10|, |9−10|) = 2，
  // Wilder ATR(3) = 2；close = 10 → atr/close = 0.2。
  it('全等 bar（TR=2, close=10）的 ATR 占价比 0.2', () => {
    const bars: Bar[] = Array.from({ length: 5 }, () => ({ o: 10, h: 11, l: 9, c: 10, v: 100 }))
    const out = atrPercent(bars, 3)
    expect(out[2]).toBeCloseTo(0.2, 15)
    expect(out[4]).toBeCloseTo(0.2, 15)
  })

  it('收盘价 ≤ 0 处为 null（不产出无意义的比率）', () => {
    const bars: Bar[] = [
      { o: 10, h: 11, l: 9, c: 10, v: 100 },
      { o: 0, h: 1, l: -1, c: 0, v: 100 },
    ]
    expect(atrPercent(bars, 2)[1]).toBeNull()
  })
})

describe('Amihud 非流动性 amihudIlliquidity', () => {
  // 手算：closes [100,110,99]，volume 1000。
  //   j=1：r = 0.1，成交额 = 110×1000 = 1.1e5 → 0.1/1.1e5 = 9.090909090909091e−7
  //   j=2：r = −0.1（取绝对值），成交额 = 99×1000 = 9.9e4 → 0.1/9.9e4 = 1.01010101010101e−6
  //   均值 = 9.595959595959598e−7
  it('三根 K 线的两窗均值为 9.595959595959598e−7', () => {
    const bars: Bar[] = [
      { o: 100, h: 101, l: 99, c: 100, v: 1000 },
      { o: 110, h: 111, l: 109, c: 110, v: 1000 },
      { o: 99, h: 100, l: 98, c: 99, v: 1000 },
    ]
    const out = amihudIlliquidity(bars, 2)
    expect(out[1]).toBeNull() // 需要一个前置收盘价，第一个可算位置是下标 period
    expect(out[2]).toBeCloseTo(9.595959595959598e-7, 15)
  })

  it('成交额为 0 的 bar 不计入，全部不可计入时为 null', () => {
    const bars: Bar[] = [
      { o: 100, h: 101, l: 99, c: 100, v: 0 },
      { o: 101, h: 102, l: 100, c: 101, v: 0 },
      { o: 102, h: 103, l: 101, c: 102, v: 0 },
    ]
    expect(amihudIlliquidity(bars, 2)[2]).toBeNull()
  })
})
