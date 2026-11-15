// SPDX-License-Identifier: CPAL-1.0
// 回归与相关参照：TA-Lib ta_CORREL.c / ta_BETA.c / ta_LINEARREG_SLOPE.c / _INTERCEPT.c / _ANGLE.c / ta_TSF.c。
// BETA 差异：TA-Lib 输入两条价格，内部先转成单根收益率（指数在 inReal0、个股在 inReal1），
// lookback = period；本包 beta 直接对传入序列回归，常规 beta 需调用方先用 simpleReturns 转收益率。
// 手算（period=4，窗 [100,102,103,102]）：x̄=1.5、ȳ=101.75、Σ(x−x̄)(y−ȳ)=3.5、Σ(x−x̄)²=5
//   → slope = 0.7、intercept = 101.75 − 0.7×1.5 = 100.7、angle = atan(0.7) = 34.992°、TSF = 100.7 + 0.7×4 = 103.5
// 相关系数与 Beta 的期望值经收口代理 2026-10-22 用 Python Fraction 按定义独立重算一致（重算脚本不入库）。
import { describe, expect, it } from 'vitest'
import { beta, correl, linRegAngle, linRegIntercept, linRegSlope, tsf } from '../src/index'
import { CLOSES, VOLUMES, expectSeries } from './fixtures-t1b'

const N = (n: number): null[] => new Array<null>(n).fill(null)

describe('回归与相关（TA-Lib 定义式 + 手算）', () => {
  it('linRegSlope：窗 [100,102,103,102] 的斜率为 0.7（3.5/5）', () => {
    expectSeries(
      linRegSlope(CLOSES, 4),
      [...N(3), 0.7, 0.5, 0.2, 0.8, 0.8, 0.4, 0.4],
      'linRegSlope',
    )
  })

  it('linRegIntercept：i=3 为 100.7（ȳ − slope×x̄）', () => {
    expectSeries(
      linRegIntercept(CLOSES, 4),
      [...N(3), 100.7, 102, 102.7, 102.3, 103.3, 103.9, 104.9],
      'linRegIntercept',
    )
  })

  it('linRegAngle：i=3 为 atan(0.7) 的度数', () => {
    expectSeries(
      linRegAngle(CLOSES, 4),
      [...N(3), 34.99202019855865, 26.56505117707799, 11.309932474020215, 38.65980825409009, 38.65980825409009, 21.801409486351811, 21.801409486351811],
      'linRegAngle',
    )
    expect(linRegAngle(CLOSES, 4)[3]).toBeCloseTo((Math.atan(0.7) * 180) / Math.PI, 12)
  })

  it('tsf：i=3 为 103.5（下一根的回归值）', () => {
    expectSeries(tsf(CLOSES, 4), [...N(3), 103.5, 104, 103.5, 105.5, 106.5, 105.5, 106.5], 'tsf')
  })

  it('线性序列 y = 2x + 3：斜率恒为 2、截距为窗口左端值、TSF 为下一根值、角度 atan(2)', () => {
    const y = Array.from({ length: 8 }, (_, i) => 2 * i + 3)
    const slope = linRegSlope(y, 4)
    const intercept = linRegIntercept(y, 4)
    const forecast = tsf(y, 4)
    for (let i = 3; i < 8; i++) {
      expect(slope[i]).toBeCloseTo(2, 10)
      // 截距是窗口最左边那根的拟合值（横轴 0 处），即 y[i−3]
      expect(intercept[i]).toBeCloseTo(y[i - 3]!, 10)
      // TSF 是窗口后一格，即 y[i+1]
      expect(forecast[i]).toBeCloseTo(2 * (i + 1) + 3, 10)
      expect(linRegAngle(y, 4)[i]).toBeCloseTo((Math.atan(2) * 180) / Math.PI, 10)
    }
  })

  it('水平序列的斜率为 0、角度为 0、TSF 等于该水平', () => {
    const flat = new Array<number>(8).fill(20)
    const slope = linRegSlope(flat, 4)
    for (let i = 3; i < 8; i++) {
      expect(slope[i]).toBeCloseTo(0, 12)
      expect(linRegAngle(flat, 4)[i]).toBeCloseTo(0, 12)
      expect(tsf(flat, 4)[i]).toBeCloseTo(20, 10)
    }
  })

  it('correl：与自身的相关系数为 1，与取负后的序列为 −1', () => {
    const negated = CLOSES.map((v) => -v)
    const same = correl(CLOSES, CLOSES, 4)
    const opposite = correl(CLOSES, negated, 4)
    for (let i = 3; i < CLOSES.length; i++) {
      expect(same[i]).toBeCloseTo(1, 9)
      expect(opposite[i]).toBeCloseTo(-1, 9)
    }
  })

  it('correl：与成交量的窗口相关系数等于独立参考值', () => {
    expectSeries(
      correl(CLOSES, VOLUMES, 4),
      [
        ...N(3),
        0.050062617432,
        -0.591864030249,
        -0.632455532034,
        -0.994376712684,
        0.230089496654,
        0.113796486272,
        0.544435722937,
      ],
      'correl',
    )
  })

  it('beta：基准序列取自身时为 1，取两倍时为 2', () => {
    const doubled = VOLUMES.map((v) => 2 * v)
    const self = beta(VOLUMES, VOLUMES, 4)
    const twice = beta(doubled, VOLUMES, 4)
    for (let i = 3; i < VOLUMES.length; i++) {
      expect(self[i]).toBeCloseTo(1, 9)
      expect(twice[i]).toBeCloseTo(2, 9)
    }
  })

  it('beta：收盘对成交量的取值等于独立参考值', () => {
    expectSeries(
      beta(CLOSES, VOLUMES, 4),
      [
        ...N(3),
        0.000238095238,
        -0.002266666667,
        -0.002,
        -0.004299065421,
        0.000882352941,
        0.000431654676,
        0.001743589744,
      ],
      'beta',
    )
  })

  it('方差为 0 的窗口：correl 与 beta 输出 null（不产生 NaN / Infinity）', () => {
    const flat = new Array<number>(6).fill(10)
    expect(correl(flat, VOLUMES.slice(0, 6), 4).slice(3)).toEqual([null, null, null])
    expect(beta(flat, flat, 4).slice(3)).toEqual([null, null, null])
  })

  it('两序列长度不等抛 RangeError；period < 2 的回归抛 RangeError', () => {
    expect(() => correl(CLOSES, VOLUMES.slice(0, 5), 3)).toThrow(RangeError)
    expect(() => beta(CLOSES, VOLUMES.slice(0, 5), 3)).toThrow(RangeError)
    expect(() => linRegSlope(CLOSES, 1)).toThrow(RangeError)
    expect(() => tsf(CLOSES, 1)).toThrow(RangeError)
  })
})
