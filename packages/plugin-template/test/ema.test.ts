// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest'
import { CloseBuffer, candlesOf, ema, emaSeries, reading } from '../src/index'

const c = (t: number, close: number) => ({ t, o: close, h: close, l: close, c: close, v: 1 })

describe('EMA', () => {
  it('前 period 根的简单平均当种子，之后按 k = 2/(period+1) 递推', () => {
    const s = emaSeries([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3)
    expect(s).toEqual([null, null, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(ema([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3)).toBe(9)
  })

  it('已知数值：period 5，k = 1/3', () => {
    const closes = [22.27, 22.19, 22.08, 22.17, 22.18, 22.13, 22.23, 22.43, 22.24, 22.29]
    const s = emaSeries(closes, 5)
    expect(s.slice(0, 4)).toEqual([null, null, null, null])
    expect(s[4]).toBeCloseTo(22.178, 6)
    expect(s[5]).toBeCloseTo(22.178 + (22.13 - 22.178) / 3, 6)
    expect(s[9]).toBeCloseTo(22.268419753, 8)
  })

  it('不够 period 根返回 null；period 非法抛错；常数序列的 EMA 等于该常数', () => {
    expect(ema([1, 2], 3)).toBeNull()
    expect(ema([], 3)).toBeNull()
    expect(() => ema([1, 2, 3], 0)).toThrow(RangeError)
    expect(() => ema([1, 2, 3], 2.5)).toThrow(RangeError)
    expect(ema(Array(30).fill(5), 9)).toBeCloseTo(5, 12)
  })

  it('period 为 1 就是收盘价本身；非有限数不污染结果', () => {
    expect(emaSeries([3, 4, 5], 1)).toEqual([3, 4, 5])
    expect(emaSeries([1, 2, Number.NaN, 4], 2)).toEqual([null, 1.5, 1.5, 1.5 + (2 / 3) * (4 - 1.5)])
  })
})

describe('行情载荷解析', () => {
  it('单根 K 线、{candle}、{candles}、K 线数组都认；字符串数字也认；坏数据丢掉', () => {
    expect(candlesOf({ t: 1, o: 1, h: 2, l: 0.5, c: 1.5, v: 3 })).toEqual([{ t: 1, o: 1, h: 2, l: 0.5, c: 1.5, v: 3 }])
    expect(candlesOf({ instrumentId: 'a:B', interval: '15m', candle: { t: 2, c: '7.5' } })).toEqual([{ t: 2, o: 7.5, h: 7.5, l: 7.5, c: 7.5, v: 0 }])
    expect(candlesOf({ candles: [{ t: 1, c: 1 }, { t: 2, c: 2 }, { c: 3 }] })).toHaveLength(2)
    expect(candlesOf([{ t: 1, c: 1 }, null, 'x', { t: 'bad', c: 1 }])).toHaveLength(1)
    expect(candlesOf(null)).toEqual([])
    expect(candlesOf(42)).toEqual([])
  })
})

describe('收盘价缓冲', () => {
  it('同一根（同 t）更新覆盖，新 K 线追加，乱序到达也按时间升序', () => {
    const b = new CloseBuffer(10)
    b.push([c(3, 30), c(1, 10), c(2, 20)])
    expect(b.closes).toEqual([10, 20, 30])
    b.push([c(3, 33)])
    expect(b.closes).toEqual([10, 20, 33])
    expect(b.size).toBe(3)
  })
  it('超过上限丢最老的', () => {
    const b = new CloseBuffer(3)
    b.push([1, 2, 3, 4, 5].map((t) => c(t, t * 10)))
    expect(b.closes).toEqual([30, 40, 50])
    b.clear()
    expect(b.size).toBe(0)
  })
})

describe('读数', () => {
  it('收盘价相对 EMA 的偏离与方向；数据不够时只给根数', () => {
    const r = reading([10, 10, 10, 10, 12], 3)
    expect(r.ema).not.toBeNull()
    expect(r.trend).toBe('up')
    expect(r.diffPct!).toBeGreaterThan(0)
    expect(reading([10, 10, 10, 8], 3).trend).toBe('down')
    expect(reading([10, 10, 10, 10], 3).trend).toBe('flat')
    expect(reading([1, 2], 5)).toMatchObject({ ema: null, last: 2, diffPct: null, trend: null, bars: 2 })
    expect(reading([], 5)).toMatchObject({ ema: null, last: null, bars: 0 })
  })
})
