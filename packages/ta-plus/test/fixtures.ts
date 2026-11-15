// SPDX-License-Identifier: CPAL-1.0
// 测试夹具：合成 K 线。全部写死，不联网、不读文件。
import type { Bar } from '../src/types'

/** 由收盘价造 K 线：h = c+1，l = c−1，o = c。 */
export function barsFrom(closes: number[], volume = 1000): Bar[] {
  return closes.map((c) => ({ o: c, h: c + 1, l: c - 1, c, v: volume }))
}

/** 确定性伪随机序列（线性同余），用于约定类测试，不依赖第三方。 */
export function lcgSeries(count: number, seed = 12345): number[] {
  let state = seed
  const out: number[] = []
  for (let i = 0; i < count; i++) {
    state = (state * 1103515245 + 12345) % 2147483648
    out.push(50 + state / 2147483648)
  }
  return out
}
