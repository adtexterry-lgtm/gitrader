// SPDX-License-Identifier: CPAL-1.0
// 盘口状态：快照 / 增量 / 逐笔成交三种记录落到同一份买卖档位表，并维护一张「已被吃掉多少」的流动性台账。
//
// 设计参照：nautilus_trader crates/model/src/data/order.rs@55c0e820（BookAction 的 add / update / delete / clear
// 四种增量语义）；crates/execution/src/matching_engine/mod.rs@55c0e820 的 apply_liquidity_consumption
// （按「原始档位量 + 已消耗量」记账，档位量一变就清零重记，避免同一份挂单量被重复吃）。
// 本实现按自己的协议形状从零写：台账以价格字符串为键、随档位增删与快照刷新重置，不引入参照的任何数据结构。
import { ZERO, add, cmp, str, sub, type Fx } from '@gitrader/protocol/decimal'
import { minFx, parsePositive, priceKey } from './num'
import type { AggressorSide, BookSide, DeltaRecord, MarketRecord, SnapshotRecord, TradeRecord } from './types'

export interface BookLevel {
  readonly price: Fx
  readonly size: Fx
}

export interface LevelView {
  price: string
  size: string
}

export class MarketBook {
  instrument = ''
  ts = 0
  lastTrade: { price: Fx; size: Fx; ts: number; aggressor: AggressorSide } | null = null

  private bidLevels: BookLevel[] = []
  private askLevels: BookLevel[] = []
  private consumedBid = new Map<string, Fx>()
  private consumedAsk = new Map<string, Fx>()

  /** 按记录类型落到对应处理；盘口类记录保持 ts 单调取大，成交类记录同时更新最新价。 */
  apply(record: MarketRecord): void {
    switch (record.type) {
      case 'book_snapshot':
        this.applySnapshot(record)
        return
      case 'book_delta':
        this.applyDelta(record)
        return
      case 'trade':
        this.applyTrade(record)
        return
    }
  }

  /** 快照整体替换一侧或两侧档位，并清空两侧台账（新数据 = 新的可吃量）。 */
  applySnapshot(rec: SnapshotRecord): void {
    this.checkInstrument(rec.instrument)
    const bids = parseLevels(rec.bids, 'bid')
    const asks = parseLevels(rec.asks, 'ask')
    this.bidLevels = bids
    this.askLevels = asks
    this.consumedBid.clear()
    this.consumedAsk.clear()
    this.ts = Math.max(this.ts, rec.ts)
    this.assertNotCrossed()
  }

  /**
   * 增量：add 必须是新档位，update / delete 必须命中已有档位，clear 清空该侧。
   * 档位量变化的档位会清掉它在台账里的已消耗量——交易所重新报了这一档，之前的消耗不再成立。
   */
  applyDelta(rec: DeltaRecord): void {
    this.checkInstrument(rec.instrument)
    const side = rec.side
    const levels = this.levelsOf(side)
    const consumed = this.consumedOf(side)

    if (rec.action === 'clear') {
      levels.length = 0
      consumed.clear()
      this.ts = Math.max(this.ts, rec.ts)
      return
    }
    if (rec.price === undefined) throw new TypeError(`book_delta ${rec.action} 缺 price`)
    const price = parsePositive(rec.price, 'delta.price')
    const key = priceKey(price)
    const index = this.indexOf(side, price)

    if (rec.action === 'delete') {
      if (index < 0) throw new RangeError(`book_delta delete 命中不存在的档位：${rec.price}`)
      levels.splice(index, 1)
      consumed.delete(key)
      this.ts = Math.max(this.ts, rec.ts)
      return
    }

    if (rec.size === undefined) throw new TypeError(`book_delta ${rec.action} 缺 size`)
    const size = parsePositive(rec.size, 'delta.size')

    if (rec.action === 'add') {
      if (index >= 0) throw new RangeError(`book_delta add 命中已存在的档位：${rec.price}`)
      levels.splice(this.insertIndex(side, price), 0, { price, size })
      consumed.delete(key)
    } else {
      if (index < 0) throw new RangeError(`book_delta update 命中不存在的档位：${rec.price}`)
      levels[index] = { price, size }
      consumed.delete(key)
    }
    this.ts = Math.max(this.ts, rec.ts)
    this.assertNotCrossed()
  }

  /**
   * 逐笔成交：更新最新价，并按主动方向吃掉该价位的挂单量（主动买吃卖档，主动卖吃买档）。
   * 成交量为 0 或方向未知时不动台账，只有最新价变化。
   */
  applyTrade(rec: TradeRecord): { side: BookSide | null; consumed: Fx } {
    this.checkInstrument(rec.instrument)
    const price = parsePositive(rec.price, 'trade.price')
    const size = parsePositive(rec.size, 'trade.size')
    this.ts = Math.max(this.ts, rec.ts)
    this.lastTrade = { price, size, ts: rec.ts, aggressor: rec.aggressor ?? 'unknown' }
    if (rec.aggressor !== 'buy' && rec.aggressor !== 'sell') return { side: null, consumed: ZERO }
    const side: BookSide = rec.aggressor === 'buy' ? 'ask' : 'bid'
    return { side, consumed: this.consume(side, price, size) }
  }

  bestBid(): Fx | null {
    return this.bidLevels[0]?.price ?? null
  }

  bestAsk(): Fx | null {
    return this.askLevels[0]?.price ?? null
  }

  /** 该档位的显示总量；档位不存在返回 0。 */
  sizeAt(side: BookSide, price: Fx): Fx {
    const level = this.levelAt(side, price)
    return level === null ? ZERO : level.size
  }

  /** 该档位还能被吃多少 = 显示量 − 台账已消耗量（不小于 0）。 */
  availableAt(side: BookSide, price: Fx): Fx {
    const level = this.levelAt(side, price)
    if (level === null) return ZERO
    const used = this.consumedOf(side).get(priceKey(price)) ?? ZERO
    const left = sub(level.size, used)
    return left < ZERO ? ZERO : left
  }

  /** 台账里该档位已被吃掉的量（测试与报告用）。 */
  consumedAt(side: BookSide, price: Fx): Fx {
    return this.consumedOf(side).get(priceKey(price)) ?? ZERO
  }

  /** 吃掉一份流动性，返回真正吃到的量（受剩余可吃量与请求量双重限制）。 */
  consume(side: BookSide, price: Fx, qty: Fx): Fx {
    if (qty <= ZERO) return ZERO
    const take = minFx(qty, this.availableAt(side, price))
    if (take <= ZERO) return ZERO
    const consumed = this.consumedOf(side)
    const key = priceKey(price)
    consumed.set(key, add(consumed.get(key) ?? ZERO, take))
    return take
  }

  /** 只看不吃的可吃量（FOK 先试算再决定是否落账）。 */
  hasLevel(side: BookSide, price: Fx): boolean {
    return this.indexOf(side, price) >= 0
  }

  isCrossed(): boolean {
    const bid = this.bestBid()
    const ask = this.bestAsk()
    return bid !== null && ask !== null && cmp(bid, ask) >= 0
  }

  /** 某一侧的档位（按盘口顺序：买档从高到低，卖档从低到高）。返回值是副本，外部改不动内部状态。 */
  levels(side: BookSide): readonly BookLevel[] {
    return [...this.levelsOf(side)]
  }

  depth(side: BookSide): LevelView[] {
    return this.levelsOf(side).map((level) => ({ price: priceKey(level.price), size: str(level.size) }))
  }

  /** 清空台账（不动档位）。快照与档位量变化已自动清，这里留给调用方手工重置。 */
  resetConsumption(): void {
    this.consumedBid.clear()
    this.consumedAsk.clear()
  }

  private levelsOf(side: BookSide): BookLevel[] {
    return side === 'bid' ? this.bidLevels : this.askLevels
  }

  private consumedOf(side: BookSide): Map<string, Fx> {
    return side === 'bid' ? this.consumedBid : this.consumedAsk
  }

  private levelAt(side: BookSide, price: Fx): BookLevel | null {
    const index = this.indexOf(side, price)
    return index < 0 ? null : (this.levelsOf(side)[index] ?? null)
  }

  private indexOf(side: BookSide, price: Fx): number {
    const levels = this.levelsOf(side)
    const key = priceKey(price)
    for (let i = 0; i < levels.length; i += 1) {
      const level = levels[i]
      if (level !== undefined && priceKey(level.price) === key) return i
    }
    return -1
  }

  /** 买档从高到低、卖档从低到高插入。 */
  private insertIndex(side: BookSide, price: Fx): number {
    const levels = this.levelsOf(side)
    for (let i = 0; i < levels.length; i += 1) {
      const level = levels[i]
      if (level === undefined) continue
      const order = side === 'bid' ? cmp(price, level.price) : cmp(level.price, price)
      if (order > 0) return i
    }
    return levels.length
  }

  private assertNotCrossed(): void {
    if (this.isCrossed()) {
      throw new RangeError(`盘口已交叉（买一 ${this.bestBid()?.toString()} ≥ 卖一 ${this.bestAsk()?.toString()}），记录流不可信`)
    }
  }

  private checkInstrument(instrument: string): void {
    if (this.instrument === '') {
      this.instrument = instrument
      return
    }
    if (this.instrument !== instrument) {
      throw new RangeError(`记录标的 ${instrument} 与盘口标的 ${this.instrument} 不一致`)
    }
  }
}

/** 快照档位：先去重再验排序（买档严格递减，卖档严格递增），价格必须在 0 以上。 */
function parseLevels(tuples: readonly unknown[], side: BookSide): BookLevel[] {
  if (!Array.isArray(tuples)) throw new TypeError(`book_snapshot 的 ${side} 必须是档位数组`)
  const out: BookLevel[] = []
  const seen = new Set<string>()
  for (const tuple of tuples) {
    if (!Array.isArray(tuple) || tuple.length !== 2) throw new TypeError(`档位必须是 [price, size] 二元组：${JSON.stringify(tuple)}`)
    const [rawPrice, rawSize] = tuple as [unknown, unknown]
    if (typeof rawPrice !== 'string' || typeof rawSize !== 'string') throw new TypeError('档位价格与数量必须是十进制文本')
    const price = parsePositive(rawPrice, 'level.price')
    const size = parsePositive(rawSize, 'level.size')
    const key = priceKey(price)
    if (seen.has(key)) throw new RangeError(`book_snapshot 的 ${side} 有重复档位：${rawPrice}`)
    seen.add(key)
    const prev = out[out.length - 1]
    if (prev !== undefined) {
      const order = side === 'bid' ? cmp(prev.price, price) : cmp(price, prev.price)
      if (order <= 0) throw new RangeError(`book_snapshot 的 ${side} 档位顺序不对：${rawPrice} 紧接在 ${priceKey(prev.price)} 之后`)
    }
    out.push({ price, size })
  }
  return out
}
