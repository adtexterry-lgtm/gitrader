// SPDX-License-Identifier: CPAL-1.0
// 纸面执行引擎：把模板产出的下单意图按「限价触达」撮合，记账，并执行第二道敞口闸。
// 两条硬规矩：
//   1) 输入数据不可信（非有限价、上影低于下影、时间不递增）→ 抛 BotStateError，不跳过、不猜。
//   2) 敞口超限的意图是「拒单 + 停机」，不是「截小数量继续」；停机后不平仓、不补单，仓位原样留在结果里。
// 本包不下单：这里所有「成交」都是纸面记账，没有任何网络调用。
import type { Candle } from '@gitrader/engine-core'
import { BotStateError } from './errors'
import { checkExposure } from './safety'
import type { BotFill, BotHalt, BotRuntime, BotSnapshot, BotTemplateId } from './types'

const roundOut = (x: number): number => (Number.isFinite(x) ? Number(x.toPrecision(15)) : x)

export interface RunOptions {
  initialCash?: number
  feeRate?: number
  intervalMs?: number
}

export interface EquityPoint {
  t: number
  v: number
}

export interface BotRun {
  template: BotTemplateId
  fills: BotFill[]
  equity: EquityPoint[]
  initialCash: number
  finalEquity: number
  realizedPnl: number
  fees: number
  /** 全过程最大持仓名义额（按每根 K 线收盘计）。 */
  maxExposure: number
  /** 未被触达的意图条数（限价没到，属正常挂单，不是错误）。 */
  unfilled: number
  halted: BotHalt | null
  snapshot: BotSnapshot
}

const EPS = 1e-9

export function runBot(bot: BotRuntime, candles: readonly Candle[], opts: RunOptions = {}): BotRun {
  assertCandles(candles)
  const initialCash = opts.initialCash !== undefined && opts.initialCash > 0 ? opts.initialCash : 10_000
  const feeRate = opts.feeRate !== undefined && opts.feeRate >= 0 ? opts.feeRate : 0
  const intervalMs = opts.intervalMs !== undefined && opts.intervalMs > 0
    ? opts.intervalMs
    : candles.length > 1 ? inferIntervalMs(candles) : 60_000
  const fills: BotFill[] = []
  const equity: EquityPoint[] = []
  let maxExposure = 0
  let unfilled = 0
  let halt: BotHalt | null = null
  let lastPrice = candles.length ? (candles[candles.length - 1] as Candle).c : 0

  for (let i = 0; i < candles.length; i++) {
    const bar = candles[i] as Candle
    lastPrice = bar.c
    if (!halt) {
      const start = bot.snapshot(bar.c)
      if (start.halted) halt = start.halted
    }
    if (!halt) {
      const intents = bot.onBar({ i, bar, prev: i > 0 ? (candles[i - 1] as Candle) : null, intervalMs })
      for (const intent of intents) {
        const fillable = intent.side === 'buy' ? bar.l <= intent.price + EPS : bar.h >= intent.price - EPS
        if (!fillable) { unfilled += 1; continue }
        const state = bot.snapshot(intent.price)
        const signed = intent.side === 'buy' ? intent.qty : -intent.qty
        const verdict = checkExposure(bot.caps, state.position, intent.price, signed)
        if (!verdict.ok) {
          // 拒单并停机：截断数量会让账本与实际风险分家
          halt = { code: verdict.code, detail: verdict.detail }
          break
        }
        const notional = intent.price * intent.qty
        const fill: BotFill = {
          side: intent.side,
          price: intent.price,
          qty: intent.qty,
          reason: intent.reason,
          t: bar.t,
          i,
          notional,
          fee: notional * feeRate,
          feeRate,
          position: state.position + signed,
        }
        bot.onFill(fill)
        fills.push({ ...fill, notional: roundOut(fill.notional), fee: roundOut(fill.fee) })
      }
      if (!halt) {
        const after = bot.snapshot(bar.c)
        if (after.halted) halt = after.halted
      }
    }
    // 停机后不再调用 onBar、不撮合意图，但每根 K 线仍按收盘价盯市直到数据结束。
    equity.push({ t: bar.t, v: roundOut(bot.equity(bar.c, initialCash)) })
    const marked = bot.snapshot(bar.c)
    maxExposure = Math.max(maxExposure, marked.exposure)
  }

  const last = bot.snapshot(lastPrice || 1)
  return {
    template: bot.template,
    fills,
    equity,
    initialCash,
    finalEquity: roundOut(bot.equity(lastPrice || 1, initialCash)),
    realizedPnl: roundOut(last.realizedPnl),
    fees: roundOut(last.fees),
    maxExposure: roundOut(maxExposure),
    unfilled,
    halted: halt ?? last.halted,
    snapshot: last,
  }
}

/** 相邻 K 线间隔（取最常见的一档，异常间隔不影响结果）。engine-core 的 inferIntervalMs 未从根导出，这里自算。 */
export function inferIntervalMs(candles: readonly Candle[]): number {
  if (candles.length < 2) return 60_000
  const counts = new Map<number, number>()
  for (let i = 1; i < candles.length; i++) {
    const d = (candles[i] as Candle).t - (candles[i - 1] as Candle).t
    if (Number.isFinite(d) && d > 0) counts.set(d, (counts.get(d) ?? 0) + 1)
  }
  let best = 0
  let bestCount = 0
  for (const [d, n] of counts) if (n > bestCount || (n === bestCount && d < best)) { best = d; bestCount = n }
  return best > 0 ? best : 60_000
}

/** K 线数据可信性检查：任何一条不可信就抛，不静默丢弃这一根。 */
export function assertCandles(candles: readonly Candle[]): void {
  let prevT = -Infinity
  for (let i = 0; i < candles.length; i++) {
    const b = candles[i] as Candle
    for (const [k, v] of [['o', b.o], ['h', b.h], ['l', b.l], ['c', b.c]] as const) {
      if (!Number.isFinite(v) || v <= 0) {
        throw new BotStateError('candle-invalid', `candle[${i}].${k} must be a finite positive number, got ${String(v)}`)
      }
    }
    if (b.h < b.l) throw new BotStateError('candle-invalid', `candle[${i}] high ${b.h} is below low ${b.l}`)
    if (b.h + EPS < Math.max(b.o, b.c)) throw new BotStateError('candle-invalid', `candle[${i}] high ${b.h} is below open/close`)
    if (b.l - EPS > Math.min(b.o, b.c)) throw new BotStateError('candle-invalid', `candle[${i}] low ${b.l} is above open/close`)
    if (!Number.isFinite(b.t) || b.t <= prevT) {
      throw new BotStateError('candles-not-monotonic', `candle[${i}] timestamp ${String(b.t)} is not strictly increasing`)
    }
    prevT = b.t
  }
}
