// SPDX-License-Identifier: CPAL-1.0
// 输入 / 输出形状。输入一律用协议类型（packages/protocol/src/model/，只读）：
//   Position（持仓）、Instrument（标的）、Decimal（规范十进制字符串）、AccountId / VenueId / InstrumentId。
// 本包不引入自己的持仓模型，只补协议里没有的两样东西：**价格源**与**策略标签**。
import type { AccountId, Decimal, Instrument, InstrumentId, Position, PositionSide, VenueId } from '@gitrader/protocol'
import { fx, str } from '@gitrader/protocol/decimal'

export type { Decimal, Instrument, InstrumentId, Position, PositionSide, VenueId }

/**
 * 价格源：按 instrumentId 取「计价所用的标记价」。
 * 由调用方注入（场所行情 / 本地缓存 / 测试常量都行）。返回 undefined 表示**没有价格**。
 * 约定：不返回 0 表示「没有价格」——返回 0 或负数按缺价处理（见 valuation.ts）。
 */
export interface PriceSource {
  price(instrumentId: InstrumentId): Decimal | undefined
}

/** 用一张常量表做价格源（键 = instrumentId）。构造时就逐个解析，坏值当场抛 TypeError。 */
export function staticPriceSource(table: Readonly<Record<string, Decimal | string>>): PriceSource {
  const frozen = new Map<string, Decimal>()
  for (const [instrumentId, raw] of Object.entries(table)) {
    // fx() 解析失败会抛 TypeError：宁可构造期就炸，也不要等到汇总时才发现价格不是数。
    const value = fx(String(raw))
    if (value <= 0n) throw new TypeError(`staticPriceSource: price must be positive for ${instrumentId}: ${JSON.stringify(raw)}`)
    frozen.set(instrumentId, str(value) as Decimal)
  }
  return { price: (instrumentId) => frozen.get(instrumentId) }
}

/**
 * 汇率表：键 `FROM/TO`，值 = 1 单位 FROM 折合多少 TO（十进制文本，来自配置 / DB 即可，由 fx() 解析）。
 * 反向对（`TO/FROM`）自动按倒数取；不做三角换算。
 */
export type FxTable = Readonly<Record<string, Decimal | string>>

/** 缺价处理：throw（缺省，报错列全）/ skip（跳过该笔，列进 unpriced，绝不当 0）。 */
export type MissingPriceMode = 'throw' | 'skip'

export interface PortfolioInput {
  readonly positions: readonly Position[]
  readonly instruments: readonly Instrument[]
  /** 计价币，例如 'USD' / 'USDT'。所有金额输出都是这个币。 */
  readonly valuationCcy: string
  readonly prices: PriceSource
  /** 报价币 -> 计价币的汇率表；报价币与计价币相同时不需要。 */
  readonly fx?: FxTable
  /**
   * 策略归因标签。键优先 `${accountId}|${instrumentId}`，其次 `${accountId}`；
   * 都没有则记 `unassigned`。协议 Position 里没有策略字段（策略是引擎侧概念），所以由调用方注入。
   */
  readonly strategyTags?: Readonly<Record<string, string>>
  readonly onMissingPrice?: MissingPriceMode
}

/**
 * 错误码的**实际**口径（联合类型保留全部成员，但只抛下面三种 `code`；细分只出现在 `details` 前缀里）：
 * - 逐笔问题聚合成一条 `valuation_failed`，`details` 每条以 `unknown_instrument:` /
 *   `unsupported_settlement:` / `invalid_position:` / `duplicate_position:` / `missing_price:` /
 *   `missing_fx:` 开头；
 * - `valuationCcy` 为空、汇率为 0 或负、`instruments` 重复，直接抛 `invalid_input`；
 * - 单独调 `fxRate()` 缺对，抛 `missing_fx`。
 */
export type PortfolioErrorCode =
  | 'invalid_input'
  | 'unknown_instrument'
  | 'unsupported_settlement'
  | 'invalid_position'
  | 'duplicate_position'
  | 'missing_price'
  | 'missing_fx'
  | 'valuation_failed'

/** 本包唯一的错误类型：code 供调用方分支，details 逐条列出所有问题（不吞第一条）。 */
export class PortfolioError extends Error {
  readonly code: PortfolioErrorCode
  readonly details: readonly string[]

  constructor(code: PortfolioErrorCode, message: string, details: readonly string[] = []) {
    super(message)
    this.name = 'PortfolioError'
    this.code = code
    this.details = details
  }
}

/** 一笔持仓在计价币下的估值结果。所有金额都是 Decimal（LEDGER_DP = 8）。 */
export interface ValuedPosition {
  readonly accountId: AccountId
  readonly instrumentId: InstrumentId
  readonly venue: VenueId
  readonly base: string
  readonly quote: string
  readonly side: PositionSide
  /** 场所数量（正数，契约 §1.4.8）。 */
  readonly size: Decimal
  readonly contractSize: Decimal
  /** 带符号的基础资产数量：多正空负。 */
  readonly baseQuantity: Decimal
  readonly entryPrice: Decimal
  /** 注入的标记价，原币（报价币）。 */
  readonly markPrice: Decimal
  /** 注入的标记价折成计价币。 */
  readonly markPriceValuation: Decimal
  /** 成本价（计价币，绝对值）。 */
  readonly cost: Decimal
  /** 名义敞口（计价币，绝对值）。 */
  readonly grossExposure: Decimal
  /** 带方向敞口（计价币）：多正空负。 */
  readonly signedExposure: Decimal
  /** 用注入价算出的未实现盈亏（计价币）。 */
  readonly unrealizedPnl: Decimal
  /** 场所上报的已实现盈亏，按本笔标的的报价币折算到计价币。 */
  readonly realizedPnl: Decimal
  /** 场所上报的持仓期资金费（现金流符号），折到计价币。 */
  readonly funding: Decimal
  /** 场所上报的未实现盈亏原值（对账用）。 */
  readonly venueUnrealizedPnl: Decimal
  readonly strategyId: string
}

export interface ValuationResult {
  readonly valuationCcy: string
  readonly positions: readonly ValuedPosition[]
  /** 缺价被跳过（onMissingPrice: 'skip'）的 instrumentId，去重且保序。 */
  readonly unpriced: readonly InstrumentId[]
  readonly cost: Decimal
  readonly grossExposure: Decimal
  readonly netExposure: Decimal
  readonly unrealizedPnl: Decimal
  readonly realizedPnl: Decimal
  readonly funding: Decimal
}
