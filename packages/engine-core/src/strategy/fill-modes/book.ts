// SPDX-License-Identifier: CPAL-1.0
// 'book' 成交模式：把盘口 / 逐笔记录按时间喂给 @gitrader/sim-book，在成交时刻用市价单（IOC）逐档吃单，
// 成交价取盘口实际档位价的加权均价。本模块只调用 sim-book 的公开 API（SimBook / validateJsonl / validateRecords），
// 不改它的任何实现。
//
// 与 'bar' 模式的边界（很重要）：
//   - 'bar'：第 i+1 根开盘价 + 固定 bps 滑点，成交量只受 K 线量占比约束。缺省模式，行为逐字节不变。
//   - 'book'：价格与可成交量都来自真实盘口；簿上量不足就只成交能吃掉的部分，余额记进未成交名义。
//   - 数据缺失 / 吃不到量 / 状态不明一律抛 FillModeError（自查项 S15），**绝不退回 'bar' 继续跑**。
//   - 保护规则（止损 / 止盈 / 移动止损 / 时限）与强平按 K 线高低价判定、按 K 线口径成交，
//     与盘口口径冲突，因此 'book' 模式下用它们直接报错，而不是悄悄混用两种价格来源。
import { SimBook, fmtDecimal, validateJsonl, validateRecords } from '../../../../sim-book/src/index'
import type { MarketRecord } from '../../../../sim-book/src/index'
import { toDecimalText } from './num'
import { FillModeError, type BookExecution, type BookFeed } from './types'

export interface BookFillerOptions {
  /** 订单 id 前缀，便于在 sim-book 的回报里定位是哪一次回测的成交。 */
  idPrefix?: string
  /** 记录的标的名；不给则取 feed.instrument，再退到通用占位。 */
  instrument?: string
}

export class BookFiller {
  private readonly sim: SimBook
  private readonly records: readonly MarketRecord[]
  /** 整份数据的最后一条记录的 ts；成交时刻晚于它说明数据没覆盖到这一刻。 */
  private readonly lastTs: number
  private readonly idPrefix: string
  private cursor = 0
  /** 已经喂进盘口的记录数；为 0 时任何成交都缺数据。 */
  private applied = 0
  private orders = 0

  constructor(feed: BookFeed | undefined, options: BookFillerOptions = {}) {
    if (feed === undefined) {
      throw new FillModeError(
        'missing_feed',
        "fillMode='book' 需要盘口 / 逐笔数据，但没有给 bookFeed；请传入 { jsonl } 或 { records }，不会退回 'bar' 模式",
      )
    }
    if (feed.jsonl !== undefined && feed.records !== undefined) {
      throw new FillModeError('feed_conflict', "bookFeed 同时给了 jsonl 与 records，无法判定用哪一份；只给其中一份")
    }
    const raw =
      feed.jsonl !== undefined
        ? validateJsonl(feed.jsonl)
        : feed.records !== undefined
          ? validateRecords(feed.records)
          : undefined
    if (raw === undefined) {
      throw new FillModeError('missing_feed', "bookFeed 既没有 jsonl 也没有 records；不会退回 'bar' 模式")
    }
    if (!raw.ok) {
      const detail = raw.errors
        .slice(0, 3)
        .map((e) => `第 ${e.line} 行 ${e.code}：${e.message}`)
        .join('；')
      throw new FillModeError('unparsable_feed', `盘口 / 逐笔数据未通过 sim-book 校验（${raw.errors.length} 处）：${detail}`)
    }
    if (raw.records.length === 0) {
      throw new FillModeError('empty_feed', '盘口 / 逐笔数据为空；不会退回 \'bar\' 模式')
    }
    this.records = raw.records
    this.lastTs = this.records[this.records.length - 1]!.ts
    this.idPrefix = options.idPrefix ?? 'bt'
    const instrument = feed.instrument ?? options.instrument
    this.sim = new SimBook(instrument === undefined ? {} : { instrument })
  }

  /** 已经喂进盘口的记录数（诊断用）。 */
  get appliedRecords(): number {
    return this.applied
  }

  /**
   * 时刻 ts 可见盘口的最优价：side='buy' 取最优卖价（要买就得吃卖档），'sell' 取最优买价。
   * 回测定仓位时用它替代 K 线开盘价，避免「按 K 线定价、按盘口成交」的量价错配。
   */
  topPrice(ts: number, side: 'buy' | 'sell'): number {
    this.advance(ts)
    this.assertTwoSided(ts)
    const price = side === 'buy' ? this.sim.book.bestAsk() : this.sim.book.bestBid()
    if (price === null) throw new FillModeError('no_book', `成交时刻 ${ts} 的盘口没有可吃的一侧（side=${side}）`)
    const value = Number(fmtDecimal(price))
    if (!Number.isFinite(value) || value <= 0) {
      throw new FillModeError('no_book', `成交时刻 ${ts} 的盘口价无法换算：${fmtDecimal(price)}`)
    }
    return value
  }

  /**
   * 在时刻 ts 用盘口成交 |signed| 数量。signed > 0 买、< 0 卖。
   * 调用方负责传入非零数量；这里只处理「盘口说了算」的部分：价格、实际成交量、余额。
   */
  execute(ts: number, signed: number): BookExecution {
    if (!Number.isFinite(signed) || signed === 0) {
      throw new FillModeError('invalid_qty', `'book' 模式的成交量必须是非零有限数：${String(signed)}`)
    }
    const wanted = Math.abs(signed)
    const qty = toDecimalText(wanted)
    if (qty === '0') throw new FillModeError('invalid_qty', `成交量 ${String(wanted)} 太小，无法在盘口上成交`)

    this.advance(ts)
    this.assertTwoSided(ts)

    const report = this.sim.submit(
      { id: `${this.idPrefix}-${this.orders++}`, side: signed > 0 ? 'buy' : 'sell', type: 'market', qty, tif: 'ioc' },
      ts,
    )
    if (report.fills.length === 0) {
      throw new FillModeError(
        'no_liquidity',
        `成交时刻 ${ts} 的盘口吃不到任何量（数量 ${qty}，status=${report.status}${report.reason === undefined ? '' : `，reason=${report.reason}`}）；` +
          "不按 0 成交静默跳过，也不退回 'bar' 模式",
      )
    }
    const price = Number(report.avgPrice)
    const filled = Number(report.filledQty)
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(filled) || filled <= 0) {
      throw new FillModeError('no_liquidity', `盘口回报无法换算成成交价 / 量：avgPrice=${report.avgPrice}, filledQty=${report.filledQty}`)
    }
    const shortfall = wanted - filled
    return { price, filled, shortfall: shortfall > 0 ? shortfall : 0, levels: report.fills.length }
  }

  // ---- 内部 ------------------------------------------------------------------------------------

  /** 把 ts 及之前的记录全部落到盘口：成交用的是「该时刻已经可见的那版盘口」，不看未来数据。 */
  private advance(ts: number): void {
    while (this.cursor < this.records.length) {
      const record = this.records[this.cursor]!
      if (record.ts > ts) break
      try {
        this.sim.apply(record)
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        throw new FillModeError('feed_conflict', `第 ${this.cursor + 1} 条记录（ts=${record.ts}）落到盘口失败：${reason}`)
      }
      this.cursor += 1
      this.applied += 1
    }
    if (this.applied === 0) {
      const first = this.records[0]!
      throw new FillModeError(
        'stale_feed',
        `成交时刻 ${ts} 之前没有任何盘口 / 逐笔记录（数据从 ts=${first.ts} 开始）：盘口数据没有覆盖到这段回测，` +
          "无法按盘口成交，也不会退回 'bar' 模式",
      )
    }
    const last = this.lastTs
    if (ts > last) {
      throw new FillModeError(
        'stale_feed',
        `成交时刻 ${ts} 晚于盘口 / 逐笔数据的最后一条记录（ts=${last}）：数据没有覆盖到这一刻，无法按盘口成交，也不会退回 'bar' 模式`,
      )
    }
  }

  /** 两侧都要有档位才定价；缺一侧说明数据流断了，按错误处理而不是拿 K 线价顶上。 */
  private assertTwoSided(ts: number): void {
    if (this.sim.book.bestBid() === null || this.sim.book.bestAsk() === null) {
      throw new FillModeError(
        'no_book',
        `成交时刻 ${ts} 的盘口有一侧为空（bestBid=${String(this.sim.book.bestBid())}, bestAsk=${String(this.sim.book.bestAsk())}）：` +
          "数据流不完整，不拿 K 线价顶上",
      )
    }
  }
}
