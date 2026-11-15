// SPDX-License-Identifier: CPAL-1.0
// 价格变换参照：TA-Lib include/ta_func.h 的 TA_AVGPRICE / TA_MEDPRICE / TA_TYPPRICE / TA_WCLPRICE 定义式。
// 期望值为手算（输入第 0 根 o=100,h=101,l=99,c=100；第 4 根 103/105/102/104；第 9 根 106/108/105/107）：
//   i=0: avg=(100+101+99+100)/4=100  med=(101+99)/2=100  typ=(101+99+100)/3=100  wcl=(101+99+200)/4=100
//   i=4: avg=414/4=103.5  med=207/2=103.5  typ=311/3=103.666…  wcl=415/4=103.75
//   i=9: avg=426/4=106.5  med=213/2=106.5  typ=320/3=106.666…  wcl=427/4=106.75
import { describe, expect, it } from 'vitest'
import { avgPrice, medPrice, typPrice, wclPrice } from '../src/index'
import { BARS, expectSeries } from './fixtures-t1b'

const pick = (series: Array<number | null>): Array<number | null> => [series[0]!, series[4]!, series[9]!]

describe('价格变换（TA-Lib 定义式 + 手算）', () => {
  it('avgPrice = (o+h+l+c)/4', () => {
    expectSeries(avgPrice(BARS), BARS.map((b) => (b.o + b.h + b.l + b.c) / 4), 'avgPrice')
    expect(pick(avgPrice(BARS))).toEqual([100, 103.5, 106.5])
  })

  it('medPrice = (h+l)/2', () => {
    expect(pick(medPrice(BARS))).toEqual([100, 103.5, 106.5])
  })

  it('typPrice = (h+l+c)/3，i=9 为 320/3', () => {
    expectSeries(typPrice(BARS), BARS.map((b) => (b.h + b.l + b.c) / 3), 'typPrice')
    expect(typPrice(BARS)[9]).toBeCloseTo(320 / 3, 12)
  })

  it('wclPrice = (h+l+2c)/4，i=9 为 427/4', () => {
    expect(wclPrice(BARS)[9]).toBeCloseTo(427 / 4, 12)
    expect(wclPrice(BARS)[4]).toBeCloseTo(415 / 4, 12)
  })

  it('逐 bar 变换：输出无 null、无预热期（6 根常数 K 线逐项还原各自公式）', () => {
    const flat = Array.from({ length: 6 }, () => ({ o: 7, h: 9, l: 5, c: 8, v: 1 }))
    expect(avgPrice(flat)).toEqual([7.25, 7.25, 7.25, 7.25, 7.25, 7.25])
    expect(medPrice(flat)).toEqual([7, 7, 7, 7, 7, 7])
    expect(wclPrice(flat)).toEqual([7.5, 7.5, 7.5, 7.5, 7.5, 7.5])
    for (const v of typPrice(flat)) expect(v).toBeCloseTo(22 / 3, 12)
  })

  it('空输入返回空数组（不抛错，长度约定仍成立）', () => {
    expect(avgPrice([])).toEqual([])
    expect(medPrice([])).toEqual([])
    expect(typPrice([])).toEqual([])
    expect(wclPrice([])).toEqual([])
  })
})
