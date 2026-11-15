// SPDX-License-Identifier: CPAL-1.0
// 机器人模板的类型。模板 = 参数声明（照 engine-core 策略约定，ParamDef 形状）+ 逐 K 线的下单意图生成器。
// 模板只产出「意图」(OrderIntent)，不发送任何请求；撮合与账本都在本包的纸面引擎里。
import type { Candle } from '@gitrader/engine-core'

export type BotTemplateId = 'grid' | 'dca' | 'martingale' | 'trend'
export type BotSide = 'buy' | 'sell'
export type GridDirection = 'long' | 'short' | 'neutral'
export type BoundaryAction = 'pause' | 'stop_loss' | 'hold'

export type BotParamValue = number | boolean | string
export type BotParams = Record<string, BotParamValue>

/**
 * 参数声明：与 engine-core `strategy/types.ts::ParamDef` 同一形状
 * （key / label / type:number|integer|boolean|select / default / min / max / step / options / help / hidden）。
 * engine-core 的根导出没有转发 ParamDef 类型，所以这里按同一形状本地声明；
 * 校验仍直接调用 engine-core 的公开 `validateStrictParams`（结构兼容）。
 */
export interface BotParamDef {
  key: string
  label: string
  type: 'number' | 'integer' | 'boolean' | 'select'
  default: BotParamValue
  min?: number
  max?: number
  step?: number
  options?: string[]
  help?: string
  hidden?: boolean
}

/** 停机原因码。全部是「停下」而不是「继续试探」。 */
export type BotHaltCode =
  | 'max-exposure'
  | 'martingale-max-adds'
  | 'martingale-max-notional'
  | 'max-orders'
  | 'grid-boundary'
  | 'stop-loss'
  | 'take-profit'
  | 'trailing-stop'
  | 'trend-signal-flat'

export interface BotHalt {
  code: BotHaltCode
  detail: string
}

/** 一条下单意图：限价 + 数量 + 原因。价格与数量必须是有限正数，否则引擎报错不撮合。 */
export interface OrderIntent {
  side: BotSide
  price: number
  qty: number
  reason: string
}

export interface BotFill extends OrderIntent {
  t: number
  i: number
  notional: number
  fee: number
  /** 本笔的手续费率（引擎给定），模板把它写进自己的账本。 */
  feeRate: number
  /** 成交后机器人自己的净仓位（带符号，基础资产单位）。 */
  position: number
}

export interface BotContext {
  i: number
  bar: Candle
  prev: Candle | null
  /** K 线周期毫秒（引擎推断或调用方给定），DCA 的周期节奏用它。 */
  intervalMs: number
}

export interface BotCaps {
  /** 最大敞口（名义额，计价币）。全模板必有。 */
  maxExposureNotional: number
  /** 马丁：最大加仓次数（不含首仓）。 */
  maxAdds?: number
  /** 马丁：最大总名义额（累计开仓额上限）。 */
  maxTotalNotional?: number
}

/** 状态快照。读不到自洽状态时 snapshot() 抛 BotStateError，不返回猜测值。 */
export interface BotSnapshot {
  template: BotTemplateId
  position: number
  avgEntry: number
  realizedPnl: number
  fees: number
  exposure: number
  halted: BotHalt | null
  detail: Record<string, number | string | boolean>
}

export interface BotRuntime {
  readonly template: BotTemplateId
  readonly caps: BotCaps
  onBar(ctx: BotContext): OrderIntent[]
  onFill(fill: BotFill): void
  snapshot(price: number): BotSnapshot
  /** 权益 = 初始现金 + 已实现盈亏 - 手续费 + 未实现盈亏。 */
  equity(price: number, initialCash: number): number
}
