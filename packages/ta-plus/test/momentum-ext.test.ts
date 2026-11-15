// SPDX-License-Identifier: CPAL-1.0
// 动量类补充指标的独立参照值。参照来源：
//   · cmo：TA-Lib ta_CMO.c:150-230 的官方实现（100·(gain−loss)/(gain+loss)，Wilder 平滑，种子为前 period 个涨跌额的平均）；
//     期望值按该定义用整数序列手算，分数推导写在本文件注释里；
//   · tsi：William Blau 定义（动量与其绝对值的二级 EMA 之比），期望值用 2/3 权重的分数手算；
//   · efficiencyRatio：考夫曼定义 |净变动|/Σ|逐期变动|，小样本可心算；
//     其余（smaDistance / emaDistance / emaSlope / zScore）：定义式 + 小样本手算，EMA 用 seed 与 k=2/(n+1) 逐步列出。
import { describe, expect, it } from 'vitest'
import {
  cmo,
  efficiencyRatio,
  emaDistance,
  emaSlope,
  smaDistance,
  tsi,
  zScore,
} from '../src/index'

describe('CMO（钱德动量摆动指标）', () => {
  // 手算 [10,11,10,12,12,13]，period=3：
  //   种子（d1..d3 = +1,−1,+2）：gain=3/3=1，loss=1/3 → 100·(1−1/3)/(1+1/3) = 50
  //   i=4，d=0：gain = 1 − 1/3 = 2/3，loss = 1/3 − 1/9 = 2/9 → 100·(2/3−2/9)/(2/3+2/9) = 50
  //   i=5，d=+1：gain = (2/3·2+1)/3 = 7/9，loss = (2/9·2)/3 = 4/27
  //             → 100·(17/27)/(25/27) = 68
  it('[10,11,10,12,12,13] period=3 → [null,null,null,50,50,68]', () => {
    const out = cmo([10, 11, 10, 12, 12, 13], 3)
    expect(out.slice(0, 3)).toEqual([null, null, null])
    expect(out[3]).toBeCloseTo(50, 12)
    expect(out[4]).toBeCloseTo(50, 12)
    expect(out[5]).toBeCloseTo(68, 12)
  })

  it('连续上涨 → +100，连续下跌 → −100（定义边界）', () => {
    expect(cmo([1, 2, 3, 4, 5, 6], 3)[5]).toBeCloseTo(100, 15)
    expect(cmo([6, 5, 4, 3, 2, 1], 3)[5]).toBeCloseTo(-100, 15)
  })

  it('完全无变动 → 0（gain+loss 为 0 的边界，TA-Lib 输出 0）', () => {
    expect(cmo([8, 8, 8, 8, 8], 3)[4]).toBeCloseTo(0, 15)
  })
})

describe('TSI（真实强度指数）', () => {
  // 手算 closes [10,11,12,13,14] → 动量全为 +1，二级 EMA 全为 1，分母同为 1 → TSI = 100。
  it('单调上涨（动量恒为 +1）→ 100', () => {
    const out = tsi([10, 11, 12, 13, 14], { slow: 2, fast: 2 })
    expect(out[3]).toBeCloseTo(100, 15)
    expect(out[4]).toBeCloseTo(100, 15)
  })

  // 手算 closes [10,11,12,11,10] → 动量 [1,1,−1,−1]，慢线 EMA(2)，k=2/3：
  //   一级：种子 (1+1)/2 = 1 → 再两拍：1·2/3+1/3·1 = 1 之前先算出 −1/3、−7/9
  //          e1 = [1, −1/3, −7/9]
  //   二级：种子 (1 − 1/3)/2 = 1/3 → 下一拍 (−7/9)·2/3 + (1/3)·1/3 = −11/27
  //   绝对值链恒为 1 → 分母 = 1 → TSI = 100·(−11/27) = −1100/27 = −40.740740740740735
  it('[10,11,12,11,10] slow=2 fast=2 → −1100/27', () => {
    expect(tsi([10, 11, 12, 11, 10], { slow: 2, fast: 2 })[4]).toBeCloseTo(-1100 / 27, 12)
  })

  it('预热期为 slow+fast−1，之前全为 null', () => {
    const out = tsi([10, 11, 12, 13, 14, 15], { slow: 3, fast: 2 })
    expect(out.slice(0, 4)).toEqual([null, null, null, null])
    expect(out[4]).not.toBeNull()
  })
})

describe('效率系数 efficiencyRatio', () => {
  it('单调上涨 → 1（净变动等于路径长度）', () => {
    expect(efficiencyRatio([10, 11, 12], 2)[2]).toBeCloseTo(1, 15)
  })

  it('回到原点 → 0（净变动 0，路径长度 2）', () => {
    expect(efficiencyRatio([10, 11, 10], 2)[2]).toBeCloseTo(0, 15)
  })

  it('[10,13,11] period=2 → |11−10|/(3+2) = 0.2', () => {
    expect(efficiencyRatio([10, 13, 11], 2)[2]).toBeCloseTo(0.2, 15)
  })
})

describe('均线偏离度 smaDistance / emaDistance', () => {
  it('价格恒等于均值 → 偏离度 0', () => {
    expect(smaDistance([5, 5, 5], 2)[2]).toBeCloseTo(0, 15)
  })

  // SMA([3,4,5]) = 4，close 5 → 5/4 − 1 = 0.25
  it('[1,2,3,4,5] period=3 的最后一项 → 5/4 − 1 = 0.25', () => {
    expect(smaDistance([1, 2, 3, 4, 5], 3)[4]).toBeCloseTo(0.25, 15)
  })

  // EMA(3)：种子 (1+2+3)/3 = 2（下标 2），k=0.5 → e3 = 4·0.5+2·0.5 = 3，e4 = 5·0.5+3·0.5 = 4 → 5/4 − 1 = 0.25
  it('EMA(3) 在 [1,2,3,4,5] 上为 4 → 偏离度 0.25', () => {
    expect(emaDistance([1, 2, 3, 4, 5], 3)[4]).toBeCloseTo(0.25, 15)
  })
})

describe('EMA 斜率 emaSlope', () => {
  // EMA(3) on [10,12,14,16,18]：种子 (10+12+14)/3 = 12，k=0.5 → e3 = 14，e4 = 16
  it('slopePeriod=1 → e4/e3 − 1 = 16/14 − 1 = 1/7', () => {
    expect(emaSlope([10, 12, 14, 16, 18], 3, 1)[4]).toBeCloseTo(1 / 7, 15)
  })

  it('slopePeriod=2 → e4/e2 − 1 = 16/12 − 1 = 1/3', () => {
    expect(emaSlope([10, 12, 14, 16, 18], 3, 2)[4]).toBeCloseTo(1 / 3, 15)
  })

  it('回看基准尚未可算时为 null', () => {
    expect(emaSlope([10, 12, 14, 16, 18], 3, 2)[3]).toBeNull()
  })
})

describe('均值回归 z 分数 zScore', () => {
  // [1..5] period=5：均值 3，样本方差 2.5 → (5−3)/√2.5 = 1.2649110640673518
  it('[1,2,3,4,5] period=5 → 2/√2.5', () => {
    expect(zScore([1, 2, 3, 4, 5], 5)[4]).toBeCloseTo(1.2649110640673518, 12)
  })

  it('窗口无波动 → 0（中性值，不返回 Infinity）', () => {
    expect(zScore([9, 9, 9], 3)[2]).toBeCloseTo(0, 15)
  })

  it('ddof=0（总体标准差）口径不同，数值可核对：2/√2 = 1.4142135623730951', () => {
    expect(zScore([1, 2, 3, 4, 5], 5, 0)[4]).toBeCloseTo(1.4142135623730951, 12)
  })
})
