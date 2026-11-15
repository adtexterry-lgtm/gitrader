// SPDX-License-Identifier: CPAL-1.0
// 本包的两类错误。区分「参数不合规」与「状态不明」：前者在开工前拒，后者在运行中一律抛出，
// 由调用方决定停机——本包绝不把状态不确定读成「没有仓位」再继续跑。
export class BotParamError extends Error {
  readonly code = 'bot-param'
  /** 出问题的参数键（跨字段错误时可能为空）。 */
  readonly key: string | undefined
  readonly errors: readonly string[]

  constructor(errors: readonly string[], key?: string) {
    super(errors.join('; '))
    this.name = 'BotParamError'
    this.errors = errors
    this.key = key
  }
}

/** 状态读失败 / 状态自相矛盾 / 输入数据不可信：只许报错或停下，不许静默继续。 */
export class BotStateError extends Error {
  readonly code = 'bot-state'
  readonly kind: BotStateErrorKind

  constructor(kind: BotStateErrorKind, detail: string) {
    super(detail)
    this.name = 'BotStateError'
    this.kind = kind
  }
}

export type BotStateErrorKind =
  | 'candle-invalid'
  | 'candles-not-monotonic'
  | 'grid-cell-state-unreadable'
  | 'ledger-inconsistent'
  | 'ledger-short-not-allowed'
  | 'position-unreadable'
  | 'order-intent-invalid'
