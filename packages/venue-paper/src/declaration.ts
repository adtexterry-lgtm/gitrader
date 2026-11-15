// SPDX-License-Identifier: CPAL-1.0
// 模拟场所 kernel-sim 对外声明的撮合假设（契约 §1.5.3，必须公开）。ASSUMPTIONS.md 逐条解释；测试保证两者一致。
import type { SimVenueDeclaration } from '@gitrader/protocol'

export function simDeclaration(mirrors: string[] = ['hyperliquid']): SimVenueDeclaration {
  return {
    connector: 'kernel-sim',
    modes: ['paper', 'shadow'],
    mirrors,
    fillModel: {
      market: 'walk-l2-book',
      bookShortfall: 'last-level-plus-0.1pct',
      noBook: 'mid-plus-5bps',
      limit: 'touch-fill-at-limit',
      queuePosition: false,
      latencyMs: 0,
      funding: 'hourly-accrual',
      liquidation: 'approx-at-mark',
      positionMode: 'oneWay',
      marginMode: 'cross-only',
    },
    knownGaps: ['no-queue-position', 'no-latency-model', 'isolated-only-markets-simulated-as-cross'],
  }
}

/** 默认基础档费率（HL 基础档 taker 0.045% / maker 0.015%）；标的自带 fees 时以标的为准。 */
export const DEFAULT_FEES = { maker: '0.00015', taker: '0.00045' } as const
/** 盘口不够时，剩余按末档价 ±0.1%。 */
export const TAIL_SLIPPAGE = '0.001'
/** 无盘口时按 mid ± 5 bps。 */
export const NO_BOOK_SLIPPAGE = '0.0005'
