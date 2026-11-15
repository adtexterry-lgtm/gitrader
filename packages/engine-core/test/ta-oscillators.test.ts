// SPDX-License-Identifier: CPAL-1.0
// 振荡 / 量能类指标的已知答案、预热期 null、长度、非法参数与空输入检查。
import { describe, expect, it } from 'vitest'
import type { Bar, Series } from '../src/strategy/ta/types'
import {
  adx,
  aroon,
  awesomeOscillator,
  chaikinOscillator,
  choppiness,
  dpo,
  easeOfMovement,
  elderRay,
  forceIndex,
  massIndex,
  ppo,
  stochRsi,
  trix,
  ulcerIndex,
  ultimateOscillator,
  vortex,
} from '../src/strategy/ta/oscillators'

/** 常数 K 线：h = l = c = 100，v = 10。 */
const flatBars = (n: number): Bar[] =>
  Array.from({ length: n }, () => ({ o: 100, h: 100, l: 100, c: 100, v: 10 }))

/** 等差上涨 K 线：c = 100 + i，h = c + 1，l = c − 1，v = 10。 */
const upBars = (n: number): Bar[] =>
  Array.from({ length: n }, (_, i) => {
    const c = 100 + i
    return { o: c, h: c + 1, l: c - 1, c, v: 10 }
  })

/** 等差下跌 K 线：c = 200 − i，h = c + 1，l = c − 1，v = 10。 */
const downBars = (n: number): Bar[] =>
  Array.from({ length: n }, (_, i) => {
    const c = 200 - i
    return { o: c, h: c + 1, l: c - 1, c, v: 10 }
  })

/** 起伏 K 线：让 RSI 等派生量在窗口内有差异。 */
const zigzagBars = (n: number): Bar[] =>
  Array.from({ length: n }, (_, i) => {
    const c = 100 + (i % 7)
    return { o: c, h: c + 1, l: c - 1, c, v: 10 }
  })

/** 高价差固定、资金流乘数恒为 0.5 的 K 线，用于蔡金振荡的已知答案。 */
const flowBars = (n: number): Bar[] =>
  Array.from({ length: n }, (_, i) => {
    const l = 100 + i
    return { o: l, h: l + 2, l, c: l + 1.5, v: 10 }
  })

const closesOf = (bars: Bar[]): number[] => bars.map((bar) => bar.c)
const firstIndex = (series: Series): number => series.findIndex((v) => v !== null)
const allNull = (series: Series): boolean => series.every((v) => v === null)

describe('trix', () => {
  it('常数序列预热后为 0，首个非 null 下标为 43', () => {
    const values = new Array<number>(60).fill(100)
    const out = trix(values, 15)
    expect(out).toHaveLength(60)
    expect(firstIndex(out)).toBe(43)
    for (let i = 43; i < out.length; i += 1) expect(out[i]).toBeCloseTo(0, 9)
  })

  it('等差上涨为正值', () => {
    const out = trix(closesOf(upBars(60)), 15)
    expect(firstIndex(out)).toBe(43)
    for (let i = 43; i < out.length; i += 1) expect(out[i]!).toBeGreaterThan(0)
  })
})

describe('ultimateOscillator', () => {
  it('常数 K 线的真实波幅为 0，全为 null', () => {
    const out = ultimateOscillator(flatBars(40))
    expect(out).toHaveLength(40)
    expect(allNull(out)).toBe(true)
  })

  it('等差上涨的买压 / 波幅比恒为 0.5，预热后为 50', () => {
    const out = ultimateOscillator(upBars(60))
    expect(firstIndex(out)).toBe(28)
    for (let i = 28; i < out.length; i += 1) expect(out[i]).toBeCloseTo(50, 9)
  })
})

describe('awesomeOscillator', () => {
  it('常数 K 线全为 0', () => {
    const out = awesomeOscillator(flatBars(40))
    expect(out).toHaveLength(40)
    expect(firstIndex(out)).toBe(33)
    for (let i = 33; i < out.length; i += 1) expect(out[i]).toBeCloseTo(0, 9)
  })

  it('中价等差时短长均线之差为常数', () => {
    const bars: Bar[] = [1, 2, 3, 4, 5, 6, 7].map((c) => ({ o: c, h: c, l: c, c, v: 10 }))
    const out = awesomeOscillator(bars, { fast: 2, slow: 3 })
    expect(out[0]).toBeNull()
    expect(out[1]).toBeNull()
    for (let i = 2; i < out.length; i += 1) expect(out[i]).toBeCloseTo(0.5, 9)
  })
})

describe('ppo', () => {
  it('常数序列的 ppo / signal / hist 全为 0', () => {
    const values = new Array<number>(40).fill(100)
    const { ppo: p, signal, hist } = ppo(values)
    expect(p).toHaveLength(40)
    expect(firstIndex(p)).toBe(25)
    for (let i = 25; i < p.length; i += 1) expect(p[i]).toBeCloseTo(0, 9)
    expect(signal[32]).toBeNull()
    expect(hist[32]).toBeNull()
    for (let i = 33; i < p.length; i += 1) {
      expect(signal[i]).toBeCloseTo(0, 9)
      expect(hist[i]).toBeCloseTo(0, 9)
    }
  })

  it('快慢 EMA 之差的百分比与信号线', () => {
    const { ppo: p, signal, hist } = ppo([1, 2, 3, 4, 5], { fast: 2, slow: 3, signal: 2 })
    expect(p[1]).toBeNull()
    expect(p[2]).toBeCloseTo(25, 9)
    expect(p[3]).toBeCloseTo(16.6666666667, 9)
    expect(p[4]).toBeCloseTo(12.5, 9)
    expect(signal[2]).toBeNull()
    expect(signal[3]).toBeCloseTo(20.8333333333, 9)
    expect(signal[4]).toBeCloseTo(15.2777777778, 9) // EMA(2) 以首两值均值为种子：20.8333 + (12.5 − 20.8333)·2/3
    expect(hist[3]).toBeCloseTo(-4.1666666667, 9)
  })

  it('等差上涨的 ppo 为正值', () => {
    const { ppo: p } = ppo(closesOf(upBars(60)))
    expect(firstIndex(p)).toBe(25)
    for (let i = 25; i < p.length; i += 1) expect(p[i]!).toBeGreaterThan(0)
  })
})

describe('aroon', () => {
  it('常数 K 线最高最低都在当前根，up = down = 100、osc = 0', () => {
    const { up, down, osc } = aroon(flatBars(40), 25)
    expect(up).toHaveLength(40)
    expect(firstIndex(up)).toBe(25)
    for (let i = 25; i < up.length; i += 1) {
      expect(up[i]).toBeCloseTo(100, 9)
      expect(down[i]).toBeCloseTo(100, 9)
      expect(osc[i]).toBeCloseTo(0, 9)
    }
  })

  it('等差上涨 up = 100、down = 0、osc = 100', () => {
    const { up, down, osc } = aroon(upBars(60), 25)
    for (let i = 25; i < up.length; i += 1) {
      expect(up[i]).toBeCloseTo(100, 9)
      expect(down[i]).toBeCloseTo(0, 9)
      expect(osc[i]).toBeCloseTo(100, 9)
    }
  })

  it('等差下跌 up = 0、down = 100', () => {
    const { up, down } = aroon(downBars(60), 25)
    for (let i = 25; i < up.length; i += 1) {
      expect(up[i]).toBeCloseTo(0, 9)
      expect(down[i]).toBeCloseTo(100, 9)
    }
  })
})

describe('dpo', () => {
  it('常数序列全为 0，首个非 null 下标为 20', () => {
    const out = dpo(new Array<number>(40).fill(100), 20)
    expect(out).toHaveLength(40)
    expect(firstIndex(out)).toBe(20)
    for (let i = 20; i < out.length; i += 1) expect(out[i]).toBeCloseTo(0, 9)
  })

  it('等差上涨恒为 −1.5', () => {
    const out = dpo(closesOf(upBars(60)), 20)
    expect(firstIndex(out)).toBe(20)
    for (let i = 20; i < out.length; i += 1) expect(out[i]).toBeCloseTo(-1.5, 9)
  })
})

describe('adx', () => {
  it('常数 K 线的真实波幅为 0，三条序列全为 null', () => {
    const { plusDi, minusDi, adx: adxOut } = adx(flatBars(40))
    expect(plusDi).toHaveLength(40)
    expect(allNull(plusDi)).toBe(true)
    expect(allNull(minusDi)).toBe(true)
    expect(allNull(adxOut)).toBe(true)
  })

  it('等差上涨的 +DI 为 50、−DI 为 0、ADX 接近 100', () => {
    const { plusDi, minusDi, adx: adxOut } = adx(upBars(60), 14)
    expect(firstIndex(plusDi)).toBe(14)
    expect(firstIndex(adxOut)).toBe(27)
    for (let i = 14; i < plusDi.length; i += 1) {
      expect(plusDi[i]).toBeCloseTo(50, 9)
      expect(minusDi[i]).toBeCloseTo(0, 9)
      expect(plusDi[i]!).toBeGreaterThan(minusDi[i]!)
    }
    for (let i = 27; i < adxOut.length; i += 1) expect(adxOut[i]).toBeCloseTo(100, 9)
  })

  it('等差下跌的 −DI 大于 +DI', () => {
    const { plusDi, minusDi } = adx(downBars(60), 14)
    for (let i = 14; i < plusDi.length; i += 1) {
      expect(minusDi[i]!).toBeGreaterThan(plusDi[i]!)
      expect(plusDi[i]).toBeCloseTo(0, 9)
    }
  })
})

describe('stochRsi', () => {
  it('常数序列的 RSI 恒定，k 与 d 全为 null', () => {
    const { k, d } = stochRsi(new Array<number>(40).fill(100))
    expect(k).toHaveLength(40)
    expect(allNull(k)).toBe(true)
    expect(allNull(d)).toBe(true)
  })

  it('已知小样本的 k 值', () => {
    const { k, d } = stochRsi([1, 2, 3, 2, 3], {
      rsiPeriod: 2,
      stochPeriod: 2,
      k: 2,
      d: 2,
    })
    expect(k[2]).toBeNull()
    expect(k[3]).toBeNull()
    expect(k[4]).toBeCloseTo(0.5, 9)
    expect(allNull(d)).toBe(true)
  })

  it('起伏序列的非 null 值落在 0..1 且预热下标正确', () => {
    const { k, d } = stochRsi(closesOf(zigzagBars(60)))
    expect(firstIndex(k)).toBe(29)
    expect(firstIndex(d)).toBe(31)
    for (let i = 0; i < k.length; i += 1) {
      const v = k[i]
      if (v === null || v === undefined) continue
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(1)
    }
  })
})

describe('chaikinOscillator', () => {
  it('常数 K 线的 AD 线恒为 0，振荡为 0', () => {
    const out = chaikinOscillator(flatBars(40))
    expect(out).toHaveLength(40)
    expect(firstIndex(out)).toBe(9)
    for (let i = 9; i < out.length; i += 1) expect(out[i]).toBeCloseTo(0, 9)
  })

  it('资金流均匀放大时快慢 EMA 之差为常数', () => {
    const out = chaikinOscillator(flowBars(30), { fast: 2, slow: 3 })
    expect(out[1]).toBeNull()
    for (let i = 2; i < out.length; i += 1) expect(out[i]).toBeCloseTo(2.5, 9)
  })
})

describe('forceIndex', () => {
  it('常数 K 线全为 0', () => {
    const out = forceIndex(flatBars(40))
    expect(out).toHaveLength(40)
    expect(firstIndex(out)).toBe(13)
    for (let i = 13; i < out.length; i += 1) expect(out[i]).toBeCloseTo(0, 9)
  })

  it('等差上涨时收盘价变动乘成交量恒为 10', () => {
    const out = forceIndex(upBars(60), 13)
    expect(firstIndex(out)).toBe(13)
    for (let i = 13; i < out.length; i += 1) expect(out[i]).toBeCloseTo(10, 9)
  })
})

describe('easeOfMovement', () => {
  it('高低价相等时该点为 null，整条序列为 null', () => {
    const out = easeOfMovement(flatBars(40))
    expect(out).toHaveLength(40)
    expect(allNull(out)).toBe(true)
  })

  it('等差上涨时位移 1、箱体比率 5e-8，输出 2e7', () => {
    const out = easeOfMovement(upBars(60), 14)
    expect(firstIndex(out)).toBe(14)
    for (let i = 14; i < out.length; i += 1) expect(out[i]).toBeCloseTo(2e7, 0)
  })
})

describe('massIndex', () => {
  it('常数 K 线的高低价差为 0，全为 null', () => {
    const out = massIndex(flatBars(40))
    expect(out).toHaveLength(40)
    expect(allNull(out)).toBe(true)
  })

  it('高低价差固定时比值为 1，25 期和为 25', () => {
    const out = massIndex(upBars(60), { ema: 9, sum: 25 })
    expect(firstIndex(out)).toBe(40)
    for (let i = 40; i < out.length; i += 1) expect(out[i]).toBeCloseTo(25, 9)
  })
})

describe('ulcerIndex', () => {
  it('常数序列为 0', () => {
    const out = ulcerIndex(new Array<number>(40).fill(100), 14)
    expect(out).toHaveLength(40)
    expect(firstIndex(out)).toBe(13)
    for (let i = 13; i < out.length; i += 1) expect(out[i]).toBeCloseTo(0, 9)
  })

  it('等差上涨为 0', () => {
    const out = ulcerIndex(closesOf(upBars(60)), 14)
    for (let i = 13; i < out.length; i += 1) expect(out[i]).toBeCloseTo(0, 9)
  })

  it('回撤百分比的平方平均再开方', () => {
    const out = ulcerIndex([100, 90, 100], 3)
    expect(out[1]).toBeNull()
    expect(out[2]).toBeCloseTo(5.7735026919, 9)
  })
})

describe('vortex', () => {
  it('常数 K 线的真实波幅之和为 0，全为 null', () => {
    const { plus, minus } = vortex(flatBars(40))
    expect(plus).toHaveLength(40)
    expect(allNull(plus)).toBe(true)
    expect(allNull(minus)).toBe(true)
  })

  it('等差上涨 plus 为 1.5、minus 为 0.5', () => {
    const { plus, minus } = vortex(upBars(60), 14)
    expect(firstIndex(plus)).toBe(14)
    for (let i = 14; i < plus.length; i += 1) {
      expect(plus[i]).toBeCloseTo(1.5, 9)
      expect(minus[i]).toBeCloseTo(0.5, 9)
      expect(plus[i]!).toBeGreaterThan(minus[i]!)
    }
  })

  it('等差下跌 minus 大于 plus', () => {
    const { plus, minus } = vortex(downBars(60), 14)
    for (let i = 14; i < plus.length; i += 1) {
      expect(minus[i]!).toBeGreaterThan(plus[i]!)
    }
  })
})

describe('choppiness', () => {
  it('常数 K 线区间为 0，全为 null', () => {
    const out = choppiness(flatBars(40))
    expect(out).toHaveLength(40)
    expect(allNull(out)).toBe(true)
  })

  it('等差上涨时 ΣTR = 28、区间 = 15', () => {
    const out = choppiness(upBars(60), 14)
    expect(firstIndex(out)).toBe(13)
    for (let i = 13; i < out.length; i += 1) expect(out[i]).toBeCloseTo(23.65, 1)
  })
})

describe('elderRay', () => {
  it('常数 K 线的 bull 与 bear 全为 0', () => {
    const { bull, bear } = elderRay(flatBars(40))
    expect(bull).toHaveLength(40)
    expect(firstIndex(bull)).toBe(12)
    for (let i = 12; i < bull.length; i += 1) {
      expect(bull[i]).toBeCloseTo(0, 9)
      expect(bear[i]).toBeCloseTo(0, 9)
    }
  })

  it('等差上涨 bull 为正，等差下跌 bear 为负', () => {
    const up = elderRay(upBars(60), 13)
    expect(up.bull[12]).toBeCloseTo(7, 9)
    for (let i = 12; i < up.bull.length; i += 1) expect(up.bull[i]!).toBeGreaterThan(0)
    const down = elderRay(downBars(60), 13)
    for (let i = 12; i < down.bear.length; i += 1) expect(down.bear[i]!).toBeLessThan(0)
  })
})

describe('预热下标', () => {
  it('各指标首个非 null 下标与公式一致', () => {
    const up = upBars(60)
    const zigzagCloses = closesOf(zigzagBars(60))
    expect(firstIndex(trix(closesOf(up), 15))).toBe(43)
    expect(firstIndex(ultimateOscillator(up))).toBe(28)
    expect(firstIndex(awesomeOscillator(up))).toBe(33)
    expect(firstIndex(ppo(closesOf(up)).ppo)).toBe(25)
    expect(firstIndex(aroon(up, 25).up)).toBe(25)
    expect(firstIndex(dpo(closesOf(up), 20))).toBe(20)
    expect(firstIndex(adx(up, 14).plusDi)).toBe(14)
    expect(firstIndex(adx(up, 14).adx)).toBe(27)
    expect(firstIndex(stochRsi(zigzagCloses).k)).toBe(29)
    expect(firstIndex(chaikinOscillator(up))).toBe(9)
    expect(firstIndex(forceIndex(up, 13))).toBe(13)
    expect(firstIndex(easeOfMovement(up, 14))).toBe(14)
    expect(firstIndex(massIndex(up, { ema: 9, sum: 25 }))).toBe(40)
    expect(firstIndex(ulcerIndex(zigzagCloses, 14))).toBe(13)
    expect(firstIndex(vortex(up, 14).plus)).toBe(14)
    expect(firstIndex(choppiness(up, 14))).toBe(13)
    expect(firstIndex(elderRay(up, 13).bull)).toBe(12)
  })
})

describe('非法参数与空输入', () => {
  it('period 为 0 或非整数时全部为 null 且不抛错', () => {
    const bars = upBars(60)
    const closes = closesOf(bars)
    const check = (series: Series): void => {
      expect(allNull(series)).toBe(true)
    }
    check(trix(closes, 0))
    check(trix(closes, 1.5))
    check(ultimateOscillator(bars, { short: 0 }))
    check(ultimateOscillator(bars, { long: 2.5 }))
    check(awesomeOscillator(bars, { fast: 0 }))
    check(awesomeOscillator(bars, { slow: -1 }))
    const p = ppo(closes, { fast: 0, slow: 0, signal: 0 })
    check(p.ppo)
    check(p.signal)
    check(p.hist)
    const ar = aroon(bars, 0)
    check(ar.up)
    check(ar.down)
    check(ar.osc)
    check(dpo(closes, 0))
    const a = adx(bars, 0)
    check(a.plusDi)
    check(a.minusDi)
    check(a.adx)
    const sr = stochRsi(closes, { rsiPeriod: 0, stochPeriod: 0, k: 0, d: 0 })
    check(sr.k)
    check(sr.d)
    check(chaikinOscillator(bars, { fast: 0 }))
    check(chaikinOscillator(bars, { slow: 0 }))
    check(forceIndex(bars, 0))
    check(easeOfMovement(bars, 0))
    check(massIndex(bars, { ema: 0 }))
    check(massIndex(bars, { sum: 0 }))
    check(ulcerIndex(closes, 0))
    const v = vortex(bars, 0)
    check(v.plus)
    check(v.minus)
    check(choppiness(bars, 0))
    const er = elderRay(bars, 0)
    check(er.bull)
    check(er.bear)
  })

  it('空输入返回空数组', () => {
    const bars: Bar[] = []
    expect(trix([])).toEqual([])
    expect(ultimateOscillator(bars)).toEqual([])
    expect(awesomeOscillator(bars)).toEqual([])
    const p = ppo([])
    expect(p.ppo).toEqual([])
    expect(p.signal).toEqual([])
    expect(p.hist).toEqual([])
    const ar = aroon(bars)
    expect(ar.up).toEqual([])
    expect(ar.down).toEqual([])
    expect(ar.osc).toEqual([])
    expect(dpo([])).toEqual([])
    const a = adx(bars)
    expect(a.plusDi).toEqual([])
    expect(a.minusDi).toEqual([])
    expect(a.adx).toEqual([])
    const sr = stochRsi([])
    expect(sr.k).toEqual([])
    expect(sr.d).toEqual([])
    expect(chaikinOscillator(bars)).toEqual([])
    expect(forceIndex(bars)).toEqual([])
    expect(easeOfMovement(bars)).toEqual([])
    expect(massIndex(bars)).toEqual([])
    expect(ulcerIndex([])).toEqual([])
    const v = vortex(bars)
    expect(v.plus).toEqual([])
    expect(v.minus).toEqual([])
    expect(choppiness(bars)).toEqual([])
    const er = elderRay(bars)
    expect(er.bull).toEqual([])
    expect(er.bear).toEqual([])
  })
})
