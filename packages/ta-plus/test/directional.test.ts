// SPDX-License-Identifier: CPAL-1.0
// 方向类参照：Wilder（1978）定义，与 engine-core `adx()` 内部 +DI / −DI 同口径：平滑和的种子 =
// 第 1..period 根 DM / TR 之和，首个值在下标 period；之后 prev − prev/period + x。
// 与 TA-Lib 的差异：`ta_PLUS_DM.c` / `ta_PLUS_DI.c` 的种子是前 period−1 根之和再平滑一步
// （`PLUS_DM` 首值在下标 period−1），预热段数值不同；本夹具 period 3 时 TA-Lib 的 +DI[3] = 200/7 =
// 28.571428…，本包为 100/3；两者随时间收敛。
// 手算（period=3，BARS 前四根 H=101,103,104,103；L=99,100,101,100；C=100,102,103,102）：
//   +DM[1]=2、+DM[2]=1、+DM[3]=0 → 种子 = 3；−DM[3]=1 → 种子 = 1
//   TR[1]=max(3,3,0)=3、TR[2]=max(3,2,1)=3、TR[3]=max(3,0,3)=3 → 种子 = 9
//   +DI[3] = 100×3/9 = 33.333…；−DI[3] = 100×1/9 = 11.111…；DX[3] = 100×|33.33−11.11|/44.44 = 50
// 其余各点为同一递推（prev − prev/period + x）逐根手推；期望值经收口代理 2026-10-22 用分数按 Wilder 定义独立重算一致。
import { describe, expect, it } from 'vitest'
import { dx, minusDI, minusDM, plusDI, plusDM } from '../src/index'
import { BARS, expectSeries } from './fixtures-t1b'

const N = (n: number): null[] => new Array<null>(n).fill(null)

describe('方向运动与方向指标（TA-Lib Wilder 累加）', () => {
  it('plusDM 是累加和（种子 3，i=4 递推 3−1+2=4）', () => {
    expectSeries(
      plusDM(BARS, 3),
      [...N(3), 3, 4, 2.6666666666666665, 3.7777777777777777, 3.5185185185185186, 2.345679012345679, 4.563786008230453],
      'plusDM',
    )
  })

  it('minusDM 只计下移（i=3 首值 1）', () => {
    expectSeries(
      minusDM(BARS, 3),
      [...N(3), 1, 0.6666666666666666, 1.4444444444444444, 0.962962962962963, 0.6419753086419753, 2.4279835390946502, 1.6186556927297668],
      'minusDM',
    )
  })

  it('plusDI = 100 × 平滑 +DM ÷ 平滑 TR，i=3 为 100/3', () => {
    expectSeries(
      plusDI(BARS, 3),
      [...N(3), 100 / 3, 44.44444444444444, 29.62962962962963, 41.97530864197531, 39.09465020576131, 23.456790123456788, 42.785493827160494],
      'plusDI',
    )
  })

  it('minusDI = 100 × 平滑 −DM ÷ 平滑 TR，i=3 为 100/9', () => {
    expectSeries(
      minusDI(BARS, 3),
      [...N(3), 100 / 9, 7.407407407407407, 16.049382716049383, 10.699588477366255, 7.133058984910837, 24.2798353909465, 15.174897119341563],
      'minusDI',
    )
  })

  it('dx = 100 × |+DI − −DI| ÷ (+DI + −DI)，i=3 为 50', () => {
    expectSeries(
      dx(BARS, 3),
      [...N(3), 50, 71.42857142857143, 29.72972972972973, 59.375, 69.13946587537092, 1.7241379310344827, 47.63700909696027],
      'dx',
    )
  })

  it('单边上涨序列（收盘等于最高价）：+DI = 100、−DI = 0、DX = 100', () => {
    const bars = Array.from({ length: 8 }, (_, i) => ({ o: 100 + i, h: 101 + i, l: 100 + i, c: 101 + i, v: 1000 }))
    expect(plusDI(bars, 3)[7]).toBeCloseTo(100, 9)
    expect(minusDI(bars, 3)[7]).toBeCloseTo(0, 12)
    expect(dx(bars, 3)[7]).toBeCloseTo(100, 9)
  })

  it('单边下跌序列（收盘等于最低价）：+DI = 0、DX = 100（方向相反但强度相同）', () => {
    const bars = Array.from({ length: 8 }, (_, i) => ({ o: 100 - i, h: 100 - i, l: 99 - i, c: 99 - i, v: 1000 }))
    expect(plusDI(bars, 3)[7]).toBeCloseTo(0, 12)
    expect(minusDI(bars, 3)[7]).toBeCloseTo(100, 9)
    expect(dx(bars, 3)[7]).toBeCloseTo(100, 9)
  })

  it('单边上涨但收盘只在中段时 +DI = 100×DM ÷ TR（= 2/3）', () => {
    const bars = Array.from({ length: 8 }, (_, i) => ({ o: 100 + i, h: 101 + i, l: 100 + i, c: 100.5 + i, v: 1000 }))
    expect(plusDI(bars, 3)[7]).toBeCloseTo(200 / 3, 9)
  })

  it('完全无波动（h=l=c 且不涨不跌）：DI 与 DX 全为 null（平滑 TR 为 0 或方向和为 0）', () => {
    const bars = Array.from({ length: 8 }, () => ({ o: 50, h: 50, l: 50, c: 50, v: 1 }))
    expect(plusDI(bars, 3).every((v) => v === null)).toBe(true)
    expect(minusDI(bars, 3).every((v) => v === null)).toBe(true)
    expect(dx(bars, 3).every((v) => v === null)).toBe(true)
  })

  it('非法周期抛 RangeError', () => {
    for (const fn of [plusDM, minusDM, plusDI, minusDI, dx]) {
      expect(() => fn(BARS, 0)).toThrow(RangeError)
      expect(() => fn(BARS, 1.5)).toThrow(RangeError)
    }
  })
})
