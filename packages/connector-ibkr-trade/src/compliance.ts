// SPDX-License-Identifier: CPAL-1.0
// 美股专属八条里的「下单前裁定」集中在这里，方便逐条自查：
//   八条 1 时段：sessions 来自场馆日历（calendar.ts），这里只读结果；
//   八条 2 休市不排队：常规时段外的市价意图一律拒单；盘前盘后只在显式允许时用场所允许的单型；
//   八条 3 市价仍走价带：必须带 maxSlippageBps，转参考价 ± 滑点的限价；无参考价拒单，不退回裸市价；
//   八条 4 碎股：IB 现金股票只收整数股（contractDetails 没有 fractionable 标志），非整数拒单、不取整；
//   八条 5 卖空：可借券信息只有 reqMktData 的 tick 236，本包最小子集没有 → 超出可卖量的卖出（开空）一律拒单；
//   八条 6 账户限制：IB 账户摘要没有冻结标志；受限账户由 IB 以 201 拒单，原文照传；
//   八条 7 模拟 / 实盘不混：端口 ↔ 模式对应表在 ids.ts，构造时校验（见 index.ts）；
//   八条 8 能力老实：不支持的单型回 1004（orders.ts）。
import { asDecimal } from '@gitrader/protocol'
import type { Decimal, TriggerPriceType } from '@gitrader/protocol'
import { cmpDec, fx, roundFx, str } from '@gitrader/protocol/decimal'
import type { InstrumentRecord } from './contracts'
import { sessionStatus } from './calendar'
import type { SessionStatus } from './calendar'
import { IbError } from './errors'
import type { IbkrMode } from './ids'

export interface Restrictions {
  tradingBlocked: boolean
  accountBlocked: boolean
}

/** 八条 6：受限账户由 IB 以 201 拒单，原文照传；这里的标志恒为 false。 */
export function assertAccountCanTrade(r: Restrictions): void {
  if (r.accountBlocked) {
    throw IbError.of(
      'RULE_DENIED',
      'IBKR account reports account-level block',
      '账户被 IB 端限制：请先在 IB 客户端 / 客服侧处理，本连接器不做任何绕开限制的处理',
    )
  }
  if (r.tradingBlocked) {
    throw IbError.of(
      'RULE_DENIED',
      'IBKR account reports trading blocked',
      '交易被 IB 端暂停：处理完再下单，本连接器不做任何绕开限制的处理',
    )
  }
}

export type OrderKind = 'market' | 'non_market'

export interface SessionInput {
  record: InstrumentRecord
  now: number
  kind: OrderKind
  /** 显式声明允许盘前盘后（缺省不允许：八条 2）。 */
  allowExtendedHours?: boolean
  /** 协议 tif（undefined = 场所缺省 DAY）。 */
  tif?: string
}

/**
 * 八条 1 / 2：时段一律从场馆日历算（calendar.sessionStatus），不写死 09:30-16:00。
 * 返回时段状态（调用方据此设置 order.outsideRth）。
 */
export function assertSessionAllows(i: SessionInput): SessionStatus {
  const status = sessionStatus(i.record.sessions, i.now)
  if (status.state === 'closed') {
    throw IbError.of(
      'INVALID_PARAMS',
      `${i.record.instrument.symbol} is outside the venue session at ${status.clock.date} ${String(status.clock.minutes)} min (${status.reason})`,
      '休市不排队：常规时段外的市价意图不会被挂到下一个开盘按未知价成交；开盘后再下单，或用限价单显式声明允许盘前盘后',
    )
  }
  if (status.state === 'extended') {
    if (i.kind === 'market') {
      throw IbError.of(
        'INVALID_PARAMS',
        `market intent for ${i.record.instrument.symbol} is refused outside regular hours (${status.reason})`,
        '盘前盘后不接市价意图（成交价不可控）；改用限价单并显式声明 allowExtendedHours',
      )
    }
    if (i.allowExtendedHours !== true) {
      throw IbError.of(
        'INVALID_PARAMS',
        `${i.record.instrument.symbol} is in an extended-hours window (${status.reason}) but the intent did not declare allowExtendedHours`,
        '盘前盘后必须显式声明 allowExtendedHours=true，且只发限价 + DAY（场所限制）',
      )
    }
    if (i.tif !== undefined && i.tif !== 'ioc') {
      throw IbError.of('INVALID_PARAMS', `tif ${String(i.tif).toUpperCase()} is not allowed in extended hours`, '盘前盘后只用 DAY（缺省 tif）或 IOC')
    }
  }
  return status
}

/** 八条 3：参考价 ± 滑点；拿不到参考价就拒单，不退回裸市价。全部用 bigint。 */
export function marketBandPrice(o: {
  symbol: string
  side: 'buy' | 'sell'
  reference: number | string | undefined
  maxSlippageBps: number | undefined
  tick: string
  marketErrorCode?: number | undefined
}): { price: Decimal; band: { low: Decimal; high: Decimal } } {
  if (o.maxSlippageBps === undefined || !Number.isFinite(o.maxSlippageBps) || o.maxSlippageBps <= 0) {
    throw IbError.of(
      'INVALID_PARAMS',
      'market intent needs maxSlippageBps (no implicit default slippage)',
      '市价意图必须带 maxSlippageBps：本包把它转成参考价 ± 滑点的限价 IOC，不发裸市价',
    )
  }
  if (o.reference === undefined) {
    const why = o.marketErrorCode === undefined ? 'no quote snapshot yet' : `IB market data error ${String(o.marketErrorCode)}`
    throw IbError.of(
      'STALE_PRICE',
      `no reference price for ${o.symbol} (${why})`,
      '市价意图需要参考价：先 refreshQuote() 或在有行情权限的环境运行；无行情权限时本包拒单，不退回裸市价',
      { retryAfterMs: 1000 },
    )
  }
  const ref = fx(String(o.reference))
  if (ref <= 0n) {
    const why = o.marketErrorCode === undefined ? 'no quote snapshot yet' : `IB market data error ${String(o.marketErrorCode)}`
    throw IbError.of(
      'STALE_PRICE',
      `no reference price for ${o.symbol} (${why})`,
      '市价意图需要参考价：先 refreshQuote() 或在有行情权限的环境运行；无行情权限时本包拒单，不退回裸市价',
      { retryAfterMs: 1000 },
    )
  }
  const bps = fx(String(o.maxSlippageBps))
  const tenK = fx('10000')
  const highRaw = (ref * (tenK + bps)) / tenK
  const lowRaw = (ref * (tenK - bps)) / tenK
  const raw = o.side === 'buy' ? highRaw : lowRaw
  return {
    price: snap(raw, o.tick, o.side === 'buy' ? 'down' : 'up'),
    band: { low: snap(lowRaw, o.tick, 'down'), high: snap(highRaw, o.tick, 'up') },
  }
}

/** 按 tick 取整（down / up），返回规范十进制文本。 */
export function snap(price: number | string | bigint, tick: string, mode: 'down' | 'up'): Decimal {
  const t = fx(tick)
  const x = typeof price === 'bigint' ? price : fx(typeof price === 'number' ? price.toFixed(10) : price)
  if (t <= 0n) return asDecimal(str(x))
  const q = x / t
  const r = x - q * t
  const snapped = mode === 'down' ? (x < 0n ? q - (r === 0n ? 0n : 1n) : q) * t : (r === 0n ? q : q + 1n) * t
  return asDecimal(str(snapped))
}

/** 八条 4：整数股（IB 现金股票不声明可碎股）。不取整，直接拒。 */
export function assertWholeShares(size: Decimal, symbol: string): void {
  const v = fx(size)
  if (v <= 0n) {
    throw IbError.of('INVALID_PARAMS', `size must be positive (got ${size})`, '数量必须大于 0')
  }
  const one = fx('1')
  if (v % one !== 0n) {
    throw IbError.of(
      'PRECISION',
      `fractional share size ${size} is not supported for ${symbol}`,
      'IB 现金股票只收整数股（contractDetails 不提供可碎股标志）：本包不取整，请把数量改成整数股',
    )
  }
}

/**
 * 八条 5 + IB 没有原生 reduce-only：
 *   · 卖出（无论 reduceOnly）都要求可卖量 >= size（可卖量 = 多头持仓 − 在场 SELL 剩余 − 本次已发 SELL）；
 *   · reduceOnly 的买入要求该账户有空头且空头量 >= size。
 */
export function assertSellReducesOnly(o: {
  side: 'buy' | 'sell'
  size: Decimal
  positionSize?: Decimal | undefined
  shortPositionSize?: Decimal | undefined
  reduceOnly: boolean | undefined
  symbol: string
}): void {
  const reduceHint = 'IB 股票没有原生 reduce-only，本包按持仓前置校验'
  if (o.side === 'sell') {
    const held = o.positionSize
    if (held === undefined || cmpDec(held, '0') <= 0) {
      throw IbError.of(
        'INVALID_PARAMS',
        `short selling ${o.symbol} is refused: no long position available to close`,
        `IB 的可借券（shortable）信息要 reqMktData 的 generic tick 236，本包最小子集未实现 → 开空一律拒单；${reduceHint}`,
      )
    }
    if (cmpDec(o.size, held) > 0) {
      throw IbError.of(
        'INVALID_PARAMS',
        `sell ${o.size} ${o.symbol} exceeds the available long position ${held}`,
        `超出可卖量的卖出等于开空：本包只做减仓方向的卖出（可借券未建模）；${reduceHint}`,
      )
    }
    return
  }
  if (o.reduceOnly === true) {
    const short = o.shortPositionSize
    if (short === undefined || cmpDec(short, '0') <= 0 || cmpDec(o.size, short) > 0) {
      throw IbError.of(
        'INVALID_PARAMS',
        `reduceOnly buy ${o.size} ${o.symbol} exceeds the short position ${short ?? '0'}`,
        `reduceOnly 买入只能平空头；${reduceHint}`,
      )
    }
  }
}

/** 触发价类型：只有 last（IB 的止损按最新价触发；mark / index 不适用于现金股票）。 */
export function assertTriggerType(t: TriggerPriceType | undefined): void {
  if (t !== undefined && t !== 'last') {
    throw IbError.of(
      'ORDER_TYPE_UNSUPPORTED',
      `trigger type ${t} is not supported for US cash equities`,
      'IB 现金股票的止损按最新价（last）触发；mark / index 触发不在最小子集里',
    )
  }
}

/** 八条 7：端口必须属于声明的模式（模拟 7497/4002，实盘 7496/4001）。 */
export function assertPortMode(port: number, mode: IbkrMode, knownPorts: readonly number[]): void {
  if (knownPorts.includes(port)) return
  throw IbError.of(
    'INVALID_PARAMS',
    `port ${String(port)} does not match the declared ${mode} environment (simulation: 7497 / 4002, live: 7496 / 4001)`,
    '模拟 / 实盘不许混：端口与模式必须对应；自定义端口只用于假服务器 / 隧道，需显式 allowCustomPort',
  )
}

/** 数值工具：把 Decimal 文本规整成 number（仅用于 IB 的 double 字段）。 */
export function toNumber(d: Decimal): number {
  return Number(d)
}

export { roundFx }
