// SPDX-License-Identifier: CPAL-1.0
// 执行算法公共类型：先挂后吃（maker-then-market）的规格、指令、状态。数量与价格一律十进制字符串。

export type Side = 'buy' | 'sell'

/** 先挂后吃的下单规格。金额 / 数量都是十进制字符串；bps 与毫秒是整数或有限小数。 */
export interface MakerThenMarketSpec {
  side: Side
  /** 意图总量（币数量），下单前按 lotStep 向零截断。 */
  size: string
  /** 定价参考价（通常是盘口中间价或最新成交价）。 */
  refPrice: string
  /** 挂单相对 refPrice 的偏移，单位 bps，必须 ≥ 0（负偏移会变成吃单）。 */
  makerOffsetBps: number
  /** 挂单等待成交的时长（毫秒），到点由调用方喂 onTimeout。 */
  makerWaitMs: number
  /** 市价回退腿的滑点上限，单位 bps；价带限价 + IOC 用。 */
  maxSlippageBps: number
  /** 价格最小变动单位。 */
  tickSize: string
  /** 数量步长。 */
  lotStep: string
  /** 交易所最小下单量；余量小于它就不再发尾单（tail guard）。 */
  minSize: string
}

/** 一条待执行指令。发起方按顺序取 `next` 执行，执行结果通过 onFill / onTimeout 回喂。 */
export type ExecStep =
  | { kind: 'place_limit'; price: string; size: string; postOnly: true }
  | { kind: 'wait'; ms: number }
  | { kind: 'cancel' }
  | { kind: 'place_ioc'; price: string; size: string }
  | { kind: 'done'; reason: 'filled' | 'tail_guard' | 'market_fallback' }

/** 状态机快照。`steps` 是已发出的指令日志，`filled` / `notional` 是累计成交量与名义额，`fees` 按币种累计。 */
export interface ExecState {
  phase: 'maker' | 'taker' | 'done'
  filled: string
  notional: string
  fees: Record<string, string>
  steps: ExecStep[]
}

/** 一笔成交（部分成交也算一笔）。 */
export interface Fill {
  size: string
  price: string
  fee?: string
  feeCurrency?: string
}
