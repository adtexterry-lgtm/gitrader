// SPDX-License-Identifier: CPAL-1.0
// 合成行情：一套价格序列同时生成 K 线（给 'bar' 模式）与盘口 / 逐笔记录（给 'book' 模式），
// 两种模式跑的是「同一段行情、同一个策略」，差异只可能来自成交口径。
// 纯确定性：不用随机数，任何一次运行都得到同一份数据。
import type { MarketRecord } from '../../../sim-book/src/index'
import type { Candle } from '../../src/types'

export const STEP = 60_000
export const T0 = Date.UTC(2026, 0, 5)

export interface SyntheticOptions {
  bars?: number
  /** 起始价。 */
  start?: number
  /** 每根 K 线的价格变动（正弦，幅度）。 */
  amplitude?: number
  /** 盘口档位数。 */
  depth?: number
  /** 每档挂量（币数量）。 */
  levelSize?: number
  /** 相邻档位的价差（分数，0.001 = 0.1%）。 */
  tick?: number
  /** 买一与卖一之间的半价差（分数）。 */
  halfSpread?: number
  /** 盘口相对 K 线开盘价的偏移（分数）：用它把「盘口价」与「K 线价」拉开，验证成交价到底取自哪一边。 */
  skew?: number
}

export interface SyntheticMarket {
  candles: Candle[]
  records: MarketRecord[]
  instrument: string
}

/** 价序列：起始价 ± 正弦，周期 26 根，保证有上有下、有反手。 */
export function path(bars: number, start: number, amplitude: number): number[] {
  return Array.from({ length: bars }, (_, i) => {
    const wave = amplitude * Math.sin((2 * Math.PI * i) / 26)
    const drift = amplitude * 0.35 * Math.sin((2 * Math.PI * i) / 97)
    return round2(start + wave + drift)
  })
}

const round2 = (x: number): number => Math.round(x * 100) / 100
const dec = (x: number): string => {
  const s = x.toFixed(6).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')
  return s === '-0' ? '0' : s
}

export function syntheticMarket(options: SyntheticOptions = {}): SyntheticMarket {
  const bars = options.bars ?? 160
  const depth = options.depth ?? 5
  const levelSize = options.levelSize ?? 40
  const tick = options.tick ?? 0.001
  const halfSpread = options.halfSpread ?? 0.0005
  const skew = options.skew ?? 0
  const closes = path(bars, options.start ?? 100, options.amplitude ?? 6)
  const instrument = 'synthetic:BTC'

  const candles: Candle[] = closes.map((c, i) => {
    const o = i === 0 ? c : closes[i - 1]!
    const hi = Math.max(o, c)
    const lo = Math.min(o, c)
    return {
      t: T0 + i * STEP,
      o,
      h: round2(hi * (1 + tick)),
      l: round2(lo * (1 - tick)),
      c,
      v: 100 + (i % 5) * 20,
    }
  })

  const records: MarketRecord[] = []
  for (let i = 0; i < bars; i += 1) {
    const bar = candles[i]!
    const ts = bar.t
    const mid = round2(bar.o * (1 + skew))
    const bids: Array<[string, string]> = []
    const asks: Array<[string, string]> = []
    for (let k = 0; k < depth; k += 1) {
      bids.push([dec(round2(mid * (1 - halfSpread - k * tick))), dec(levelSize)])
      asks.push([dec(round2(mid * (1 + halfSpread + k * tick))), dec(levelSize)])
    }
    records.push({ type: 'book_snapshot', ts, instrument, bids, asks })
    // 盘中一笔逐笔成交：更新最新价并消耗卖档量（不影响我方后续成交价的定性判断）
    records.push({
      type: 'trade',
      ts: ts + Math.floor(STEP / 3),
      instrument,
      price: asks[0]![0]!,
      size: dec(levelSize / 4),
      aggressor: 'buy',
    })
    // 下半根把卖一补回原量（增量记录，顺带让 delta 路径也被覆盖到）
    records.push({
      type: 'book_delta',
      ts: ts + Math.floor((2 * STEP) / 3),
      instrument,
      side: 'ask',
      action: 'update',
      price: asks[0]![0]!,
      size: dec(levelSize),
    })
  }

  return { candles, records, instrument }
}
