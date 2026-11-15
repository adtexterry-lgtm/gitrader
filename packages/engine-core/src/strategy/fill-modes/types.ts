// SPDX-License-Identifier: CPAL-1.0
// 成交模式的类型与错误码。两种模式：
//   'bar'  —— 缺省。信号出在第 i 根收盘，第 i+1 根**开盘价**成交，加固定滑点与吃单手续费（历史行为，逐字节不变）。
//   'book' —— 把盘口 / 逐笔记录喂给 @gitrader/sim-book，在成交时刻按盘口逐档吃单，成交价取实际档位价（VWAP），
//            不再额外加滑点。需要调用方提供盘口数据；缺数据一律抛错，绝不静默退回 'bar'。
import type { MarketRecord } from '../../../../sim-book/src/index'

export type FillMode = 'bar' | 'book'

export const FILL_MODES: readonly FillMode[] = ['bar', 'book']

/**
 * 'book' 模式的行情输入：JSONL 文本（一行一条 book_snapshot / book_delta / trade）或已解析的记录数组。
 * 两种形式二选一；同时给会被当成状态不明而报错。
 */
export interface BookFeed {
  /** 标的（与记录里的 instrument 一致）；不给则取第一条记录的标的。 */
  instrument?: string
  /** JSONL 文本。 */
  jsonl?: string
  /** 已解析的记录，ts 必须非递减。 */
  records?: readonly MarketRecord[]
}

/** 一次盘口成交的结果。价格与数量都取自盘口，不含任何 K 线口径的滑点。 */
export interface BookExecution {
  /** 成交量加权均价。 */
  price: number
  /** 实际成交量（币数量，正数）。 */
  filled: number
  /** 簿上可吃量不足时没成交的部分（正数）；0 表示整单成交。 */
  shortfall: number
  /** 吃到的档位数（诊断用）。 */
  levels: number
}

export type FillModeErrorCode =
  /** fillMode = 'book' 但没给 bookFeed。 */
  | 'missing_feed'
  /** 数据源里没有任何记录。 */
  | 'empty_feed'
  /** jsonl 与 records 同时给，或记录的标的与声明不一致。 */
  | 'feed_conflict'
  /** 数据没通过 sim-book 的校验（JSON 语法 / 字段 / 流级 ts 非递减 / 盘口可重放）。 */
  | 'unparsable_feed'
  /** 成交时刻早于第一条记录、或晚于最后一条记录（数据没覆盖到这一刻）。 */
  | 'stale_feed'
  /** 有记录但一侧盘口为空，无法定价。 */
  | 'no_book'
  /** 该时刻盘口吃不到任何量。 */
  | 'no_liquidity'
  /** 数量无法用十进制文本表示（超精度 / 非有限数）。 */
  | 'invalid_qty'
  /** fillMode 不是 'bar' / 'book'。 */
  | 'unknown_mode'
  /** 'book' 模式下用了与盘口口径冲突的选项（保护规则 / 强平）。 */
  | 'unsupported_option'

/**
 * 成交模式的显式错误。规则（对应自查项 S15 / 成长档案 G16）：
 * 「数据缺失 / 状态不明」只许报错，绝不许退回另一种成交模式继续跑——否则回测结果会悄悄换口径。
 */
export class FillModeError extends Error {
  constructor(readonly code: FillModeErrorCode, message: string) {
    super(message)
    this.name = 'FillModeError'
  }
}
