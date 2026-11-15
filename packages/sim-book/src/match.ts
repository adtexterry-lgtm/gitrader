// SPDX-License-Identifier: CPAL-1.0
// 逐档吃量的纯函数：先试算（planWalk，只读），再落账（commitWalk，吃流动性）。
// 分两步是为了 FOK：整单吃不下就一格都不落账，盘口回到试算前的可吃量。
//
// 设计参照：nautilus_trader crates/execution/src/matching_engine/mod.rs@55c0e820（按档位试算成交量，
// 用消費台账限制每档可吃量；FOK 预演后不成立就回滚台账）；
// crates/execution/src/models/fill.rs@55c0e820（is_price_tradable：限价单只在与对手价可成交时进入撮合）。
// 本包的落账方式是自己的两步试算 / 提交，未照搬参照的 journal 结构。
import { ZERO, add, cmp, sub, type Fx } from '@gitrader/protocol/decimal'
import type { MarketBook } from './book'
import { minFx } from './num'
import type { BookSide, Side } from './types'

export interface PlannedFill {
  price: Fx
  qty: Fx
}

export interface FillPlan {
  fills: PlannedFill[]
  filled: Fx
}

/** 停损触发价的参照口径：最新成交价，或对手方最优价（最新价尚不存在时的退化口径）。 */
export type TriggerBasis = 'last' | 'opposite_quote'

/**
 * 试算一笔吃单能吃到的量。buy 吃卖档（价低优先），sell 吃买档（价高优先）。
 * limit 为 null 表示市价（不限价）。只读，不改变盘口与台账。
 */
export function planWalk(book: MarketBook, side: Side, limit: Fx | null, qty: Fx): FillPlan {
  const bookSide: BookSide = side === 'buy' ? 'ask' : 'bid'
  const fills: PlannedFill[] = []
  let remaining = qty
  let filled = ZERO

  for (const level of book.levels(bookSide)) {
    if (remaining <= ZERO) break
    if (limit !== null) {
      // 档位有序：越过限价的档位之后都不会再可成交。
      const beyond = side === 'buy' ? cmp(level.price, limit) > 0 : cmp(level.price, limit) < 0
      if (beyond) break
    }
    const available = book.availableAt(bookSide, level.price)
    if (available <= ZERO) continue
    const take = minFx(remaining, available)
    fills.push({ price: level.price, qty: take })
    remaining = sub(remaining, take)
    filled = add(filled, take)
  }

  return { fills, filled }
}

/** 落账：把试算的每一格从对应档位的可吃量里扣掉，返回真正扣到的总量。 */
export function commitWalk(book: MarketBook, side: Side, plan: FillPlan): Fx {
  const bookSide: BookSide = side === 'buy' ? 'ask' : 'bid'
  let consumed = ZERO
  for (const fill of plan.fills) {
    consumed = add(consumed, book.consume(bookSide, fill.price, fill.qty))
  }
  return consumed
}

/** 限价单入场是否会吃单：buy 限价 ≥ 卖一，或 sell 限价 ≤ 买一。对手方为空时不吃单。 */
export function wouldCross(book: MarketBook, side: Side, price: Fx): boolean {
  if (side === 'buy') {
    const ask = book.bestAsk()
    return ask !== null && cmp(price, ask) >= 0
  }
  const bid = book.bestBid()
  return bid !== null && cmp(price, bid) <= 0
}

/**
 * 停损触发判定：buy 停损在价格向上穿过触发价时触发，sell 停损在向下穿过时触发。
 * basis=last 用最新成交价（还没成交过时退回对手方最优价）；basis=opposite_quote 直接用对手方最优价。
 */
export function isTriggered(book: MarketBook, side: Side, trigger: Fx, basis: TriggerBasis): boolean {
  const last = book.lastTrade?.price ?? null
  const reference = basis === 'last' && last !== null ? last : (side === 'buy' ? book.bestAsk() : book.bestBid())
  if (reference === null) return false
  return side === 'buy' ? cmp(reference, trigger) >= 0 : cmp(reference, trigger) <= 0
}
