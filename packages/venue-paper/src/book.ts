// SPDX-License-Identifier: CPAL-1.0
// 吃单撮合（纯函数）：市价逐档吃 L2 盘口（买吃 asks、卖吃 bids），加权均价；盘口不够时剩余按末档价 ±0.1%；无盘口时按 mid ± 5 bps。
// 搬自 早期 Demo 原型 src/sim/fill.ts，改成十进制定点数，并加上「价格上限」（限价单 / 带滑点上限的市价单不得越过它）。
import type { Book } from '@gitrader/protocol'
import { div, fx, mul } from '@gitrader/protocol/decimal'
import type { Fx } from '@gitrader/protocol/decimal'
import { NO_BOOK_SLIPPAGE, TAIL_SLIPPAGE } from './declaration'

export type WalkSource = 'book' | 'book+tail' | 'mid'
export interface Walk {
  /** 实际成交数量（受价格上限限制时可能小于请求数量）。 */
  filled: Fx
  /** 加权均价；filled = 0 时为 0。 */
  avgPx: Fx
  source: WalkSource
}

const TAIL = fx(TAIL_SLIPPAGE)
const NOBOOK = fx(NO_BOOK_SLIPPAGE)
const ONE = fx(1)

/**
 * side：吃哪一边。cap：价格上限（买单不得高于 cap，卖单不得低于 cap；undefined = 不限）。
 * allowTail：盘口吃空后是否允许按「末档价 ±0.1%」补足（只有市价单可以——限价单不能凭空造流动性）。
 */
export function walkBook(side: 'buy' | 'sell', size: Fx, book: Book | undefined, mid: Fx, opts: { cap?: Fx; allowTail: boolean }): Walk {
  const buy = side === 'buy'
  const levels = book ? (buy ? book.asks : book.bids) : []
  const within = (px: Fx) => opts.cap === undefined || (buy ? px <= opts.cap : px >= opts.cap)
  if (!levels || levels.length === 0) {
    if (!opts.allowTail) return { filled: 0n, avgPx: 0n, source: 'mid' }
    const px = mul(mid, buy ? ONE + NOBOOK : ONE - NOBOOK)
    return within(px) ? { filled: size, avgPx: px, source: 'mid' } : { filled: 0n, avgPx: 0n, source: 'mid' }
  }
  let remaining = size
  let cost = 0n
  let filled = 0n
  for (const lv of levels) {
    if (remaining <= 0n) break
    const px = fx(lv.price)
    if (!within(px)) return finish(filled, cost, 'book')
    const take = fx(lv.size) < remaining ? fx(lv.size) : remaining
    cost += mul(take, px)
    filled += take
    remaining -= take
  }
  let source: WalkSource = 'book'
  if (remaining > 0n && opts.allowTail) {
    const tailPx = mul(fx(levels[levels.length - 1]!.price), buy ? ONE + TAIL : ONE - TAIL)
    if (within(tailPx)) {
      cost += mul(remaining, tailPx)
      filled += remaining
      source = 'book+tail'
    }
  }
  return finish(filled, cost, source)
}

function finish(filled: Fx, cost: Fx, source: WalkSource): Walk {
  return { filled, avgPx: filled > 0n ? div(cost, filled) : 0n, source }
}

/** 限价单是否穿价（会立即吃单）：买单 bestAsk ≤ price，卖单 bestBid ≥ price。 */
export function limitCrosses(side: 'buy' | 'sell', price: Fx, book: Book | undefined): boolean {
  if (!book) return false
  if (side === 'buy') return book.asks.length > 0 && fx(book.asks[0]!.price) <= price
  return book.bids.length > 0 && fx(book.bids[0]!.price) >= price
}

