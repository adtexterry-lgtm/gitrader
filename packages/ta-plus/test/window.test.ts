// SPDX-License-Identifier: CPAL-1.0
// 窗口类参照：TA-Lib TA_MAX / TA_MIN / TA_MAXINDEX / TA_MININDEX / TA_MIDPOINT / TA_MIDPRICE。
// 期望值来自逐窗口手算（closes = 100,102,103,102,104,103,105,106,104,107，period=4）：
//   i=3 窗 [100,102,103,102] → max 103、min 100、maxIdx 2、minIdx 0、mid (103+100)/2=101.5
//   i=4 窗 [102,103,102,104] → max 104@4、min 102（并列取最新 → 3）、mid (104+102)/2=103
//   i=9 窗 [105,106,104,107] → max 107@9、min 104@7、mid 105.5
//   maxIndex / minIndex 返回输入数组下标（TA-Lib 语义），不是窗口内偏移。
import { describe, expect, it } from 'vitest'
import { maxIndex, midPoint, midPrice, minIndex, rollingMax, rollingMin } from '../src/index'
import { BARS, CLOSES, expectSeries } from './fixtures-t1b'

const N = (n: number): null[] => new Array<null>(n).fill(null)

describe('窗口极值与中点（TA-Lib 定义式 + 手算）', () => {
  it('rollingMax 前 3 项为 null，之后逐窗取最大', () => {
    expectSeries(rollingMax(CLOSES, 4), [...N(3), 103, 104, 104, 105, 106, 106, 107], 'rollingMax')
  })

  it('rollingMin 逐窗取最小（i=4 窗内 102 出现两次，值仍是 102）', () => {
    expectSeries(rollingMin(CLOSES, 4), [...N(3), 100, 102, 102, 102, 103, 103, 104], 'rollingMin')
  })

  it('maxIndex 返回下标；并列时取最新一根', () => {
    expectSeries(maxIndex(CLOSES, 4), [...N(3), 2, 4, 4, 6, 7, 7, 9], 'maxIndex')
  })

  it('minIndex 返回下标；i=4 窗内 [102@1, 103@2, 102@3, 104@4] 并列取最新 → 3', () => {
    expectSeries(minIndex(CLOSES, 4), [...N(3), 0, 3, 3, 3, 5, 5, 8], 'minIndex')
  })

  it('midPoint = (窗口最高 + 窗口最低)/2', () => {
    expectSeries(midPoint(CLOSES, 4), [...N(3), 101.5, 103, 103, 103.5, 104.5, 104.5, 105.5], 'midPoint')
  })

  it('midPrice 用最高价与最低价（i=4 窗 h 最大 105、l 最小 100 → 102.5）', () => {
    expectSeries(midPrice(BARS, 4), [...N(3), 101.5, 102.5, 102.5, 103, 104, 104, 105], 'midPrice')
  })

  it('period = 1 时退化为自身，全部无 null', () => {
    expect(rollingMax(CLOSES, 1)).toEqual(CLOSES)
    expect(rollingMin(CLOSES, 1)).toEqual(CLOSES)
    expect(midPoint(CLOSES, 1)).toEqual(CLOSES)
    expect(maxIndex(CLOSES, 1)).toEqual(CLOSES.map((_, i) => i))
  })

  it('输入短于 period 时整列为 null（不抛错）', () => {
    expect(rollingMax([1, 2], 5)).toEqual([null, null])
    expect(midPrice(BARS.slice(0, 2), 5)).toEqual([null, null])
  })

  it('非法周期抛 RangeError', () => {
    expect(() => rollingMax(CLOSES, 0)).toThrow(RangeError)
    expect(() => rollingMin(CLOSES, -2)).toThrow(RangeError)
    expect(() => maxIndex(CLOSES, 2.5)).toThrow(RangeError)
    expect(() => minIndex(CLOSES, 0)).toThrow(RangeError)
    expect(() => midPoint(CLOSES, 0)).toThrow(RangeError)
    expect(() => midPrice(BARS, 0)).toThrow(RangeError)
  })
})
