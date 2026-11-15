// SPDX-License-Identifier: CPAL-1.0
// T1b 测试夹具：与独立参照脚本使用同一组输入（10 根 K 线，手写死值，不联网、不生成随机数）。
// 参照值来源见各 test 文件头：Python 独立实现（按 TA-Lib 定义式重写，未复用本包代码）+ 手算分数。
import { expect } from 'vitest'
import type { Bar, Series } from '../src/types'

/** 10 根 K 线：开高低收量全部写死，便于逐步手算核对。 */
export const BARS: Bar[] = [
  { o: 100, h: 101, l: 99, c: 100, v: 1000 },
  { o: 101, h: 103, l: 100, c: 102, v: 1200 },
  { o: 102, h: 104, l: 101, c: 103, v: 900 },
  { o: 101, h: 103, l: 100, c: 102, v: 1500 },
  { o: 103, h: 105, l: 102, c: 104, v: 1100 },
  { o: 102, h: 104, l: 101, c: 103, v: 1300 },
  { o: 104, h: 106, l: 103, c: 105, v: 800 },
  { o: 105, h: 107, l: 104, c: 106, v: 1600 },
  { o: 103, h: 105, l: 102, c: 104, v: 1400 },
  { o: 106, h: 108, l: 105, c: 107, v: 1700 },
]

export const CLOSES = BARS.map((bar) => bar.c)
export const VOLUMES = BARS.map((bar) => bar.v)

/** 21 根价位夹具：c = 100 + (i mod 7)，h = c+1，l = c−1，o = c−0.5。 */
export function levelBars(count = 21): Bar[] {
  const out: Bar[] = []
  for (let i = 0; i < count; i++) {
    const c = 100 + (i % 7)
    out.push({ o: c - 0.5, h: c + 1, l: c - 1, c, v: 1000 })
  }
  return out
}

/** 逐项比对：null 必须对应 null，数值按 9 位小数比较。 */
export function expectSeries(actual: Series, expected: Array<number | null>, label: string): void {
  expect(actual.length, `${label} 长度`).toBe(expected.length)
  for (let i = 0; i < expected.length; i++) {
    const want = expected[i] ?? null
    const got = actual[i] ?? null
    if (want === null) expect(got, `${label}[${i}]`).toBeNull()
    else expect(got, `${label}[${i}]`).toBeCloseTo(want, 9)
  }
}
