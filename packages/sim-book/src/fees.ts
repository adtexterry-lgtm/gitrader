// SPDX-License-Identifier: CPAL-1.0
// 费用模型：maker / taker 分别按费率计费，费率可按币种覆盖；负费率是返佣（rebate）。
// **资金费（funding）不在本包**：资金费是持仓在时间轴上的结算，不属于成交流水；本包只算每笔成交的手续费。
//
// 设计参照：nautilus_trader crates/execution/src/models/fee.rs@55c0e820 —— FeeModel 作为可替换模型挂在成交上，
//   MakerTakerFeeModel(maker_rate, taker_rate) 按成交的方向取两档费率之一、按 instrument 覆盖费率
//   （set_override），佣金 = 成交价 × 成交量 × 费率，负 maker 费率当返佣，Decimal 记账不碰浮点；
//   crates/model/src/fees.rs@55c0e820 的 MakerTakerFeeSchedule / calculate_maker_taker_commission
//   把「查费率」与「算佣金」分开。
// 本包按自己的协议从零写：费率与金额都是 @gitrader/protocol/decimal 的 18 位定点（bigint），
// 覆盖键用币种（本包单标的，币种由调用方给），一次性乘除到 18 位避免中间截断。
import { ZERO, add, cmp, type Fx } from '@gitrader/protocol/decimal'
import { fmtDecimal, isDecimalText, parseDecimal } from './num'
import type { LiquiditySide } from './types'

export interface FeeRates {
  /** maker 费率（分数，例如 "0.0002" = 2 bps）。负数是返佣。 */
  maker: string
  /** taker 费率（分数）。负数是返佣。 */
  taker: string
}

export interface FeeConfig extends FeeRates {
  /** 计费币种，缺省 USD。 */
  currency?: string
  /** 按币种覆盖费率：{ USDT: { maker, taker } }。查不到就落到 maker / taker。 */
  overrides?: Record<string, FeeRates>
}

/** 累计费用（字符串形态，给人看 / 进报告）。负数表示净返佣。 */
export interface FeeTotals {
  currency: string
  maker: string
  taker: string
  total: string
  /** 计过费的成交笔数。 */
  fills: number
}

/** 三档费率上限：|rate| ≤ 1（100%），防手滑写成百分比（"2" 当 2 bps 用会算出 200%）。 */
const MAX_ABS_RATE = 10n ** 18n
const SCALE_SQ = 10n ** 36n

function rateOf(value: string, field: string): Fx {
  if (!isDecimalText(value)) throw new TypeError(`${field} 不是十进制文本：${JSON.stringify(value)}`)
  const rate = parseDecimal(value, field)
  const abs = rate < ZERO ? -rate : rate
  if (cmp(abs, MAX_ABS_RATE) > 0) throw new RangeError(`${field} 绝对值不能超过 1：${value}`)
  return rate
}

export class FeeModel {
  readonly currency: string
  private readonly maker: Fx
  private readonly taker: Fx
  private readonly overrides: Map<string, { maker: Fx; taker: Fx }>

  constructor(config: FeeConfig) {
    this.currency = config.currency ?? 'USD'
    this.maker = rateOf(config.maker, 'fees.maker')
    this.taker = rateOf(config.taker, 'fees.taker')
    this.overrides = new Map()
    for (const [currency, rates] of Object.entries(config.overrides ?? {})) {
      if (typeof rates !== 'object' || rates === null) throw new TypeError(`fees.overrides.${currency} 必须是 { maker, taker }`)
      this.overrides.set(currency, { maker: rateOf(rates.maker, `fees.overrides.${currency}.maker`), taker: rateOf(rates.taker, `fees.overrides.${currency}.taker`) })
    }
  }

  /** 全零费率模型（不计费）。 */
  static zero(currency = 'USD'): FeeModel {
    return new FeeModel({ maker: '0', taker: '0', currency })
  }

  /** 该币种该流动性方向的费率（分数，定点）。 */
  rateFor(currency: string, liquidity: LiquiditySide): Fx {
    const override = this.overrides.get(currency)
    if (override !== undefined) return liquidity === 'maker' ? override.maker : override.taker
    return liquidity === 'maker' ? this.maker : this.taker
  }

  /** 一笔成交的手续费 = 成交价 × 成交量 × 费率；正数是支出，负数是返佣。 */
  charge(currency: string, price: Fx, qty: Fx, liquidity: LiquiditySide): Fx {
    const rate = this.rateFor(currency, liquidity)
    if (rate === ZERO || qty === ZERO) return ZERO
    // 三份 scale-18 定点连乘后一次性除回 18 位，避免逐次 mul 的截断误差。
    return (price * qty * rate) / SCALE_SQ
  }
}

/** 费用累计账本：按 maker / taker 分别累加，任何一张单、整场仿真各一份。 */
export class FeeLedger {
  readonly currency: string
  private makerSum: Fx = ZERO
  private takerSum: Fx = ZERO
  private count = 0

  constructor(currency: string) {
    this.currency = currency
  }

  charge(liquidity: LiquiditySide, fee: Fx): void {
    if (liquidity === 'maker') this.makerSum = add(this.makerSum, fee)
    else this.takerSum = add(this.takerSum, fee)
    this.count += 1
  }

  totals(): FeeTotals {
    return {
      currency: this.currency,
      maker: fmtDecimal(this.makerSum),
      taker: fmtDecimal(this.takerSum),
      total: fmtDecimal(add(this.makerSum, this.takerSum)),
      fills: this.count,
    }
  }
}

/** 选项里既接受模型实例也接受配置对象。 */
export function toFeeModel(value: FeeModel | FeeConfig | undefined): FeeModel | null {
  if (value === undefined) return null
  return value instanceof FeeModel ? value : new FeeModel(value)
}
