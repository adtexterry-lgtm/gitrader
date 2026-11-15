// SPDX-License-Identifier: CPAL-1.0
// 先挂后吃状态机：挂 post-only 限价 → 等 → 到期撤余量 → 余量够大发 IOC 价带尾单，不够大就 tail guard 收尾。
// 纯函数：不读钟、不发请求；时间与成交由调用方回喂。
import { addDec, cmpDec, div, floorToStep, fx, mulDec, str, subDec } from '@gitrader/protocol/decimal'
import { bandPrice, makerPrice } from './price'
import { nonNegativeFx, positiveFx, requireFinite } from './num'
import type { ExecState, ExecStep, Fill, MakerThenMarketSpec } from './types'

function validateSpec(spec: MakerThenMarketSpec): void {
  if (spec.side !== 'buy' && spec.side !== 'sell') throw new RangeError(`unsupported side: ${String(spec.side)}`)
  positiveFx('spec.size', spec.size)
  positiveFx('spec.refPrice', spec.refPrice)
  positiveFx('spec.tickSize', spec.tickSize)
  positiveFx('spec.lotStep', spec.lotStep)
  nonNegativeFx('spec.minSize', spec.minSize)
  requireFinite('spec.makerOffsetBps', spec.makerOffsetBps)
  requireFinite('spec.maxSlippageBps', spec.maxSlippageBps)
  requireFinite('spec.makerWaitMs', spec.makerWaitMs)
  if (spec.makerOffsetBps < 0) throw new RangeError(`spec.makerOffsetBps must not be negative: ${spec.makerOffsetBps}`)
  if (spec.maxSlippageBps < 0) throw new RangeError(`spec.maxSlippageBps must not be negative: ${spec.maxSlippageBps}`)
  if (spec.makerWaitMs < 0) throw new RangeError(`spec.makerWaitMs must not be negative: ${spec.makerWaitMs}`)
}

/** 数量一律向零截断到 lotStep。 */
function quantizeSize(size: string, lotStep: string): string {
  return floorToStep(size, lotStep)
}

/** 实际挂出去的目标量：意图量按 lotStep 向零截断。满量判定一律与它比，不与未截断的 `spec.size` 比。 */
function targetSize(spec: MakerThenMarketSpec): string {
  return quantizeSize(spec.size, spec.lotStep)
}

/** 费用币种归一：大写、去空白，缺省记 UNKNOWN（照 QD 的费用合并口径）。 */
function feeKey(currency: string | undefined): string {
  const k = (currency ?? '').trim().toUpperCase()
  return k || 'UNKNOWN'
}

function mergeFee(fees: Record<string, string>, fee: string, currency: string | undefined): Record<string, string> {
  const key = feeKey(currency)
  return { ...fees, [key]: addDec(fees[key] ?? '0', fee) }
}

/** 剩余待成交量：max(0, target − filled)，按 lotStep 向零截断；target 是截断后的实际挂单量。 */
export function remainingSize(spec: MakerThenMarketSpec, state: ExecState): string {
  const left = subDec(targetSize(spec), state.filled)
  if (cmpDec(left, '0') <= 0) return '0'
  return quantizeSize(left, spec.lotStep)
}

/** 加权均价 = 累计名义额 / 累计成交量（成交量 0 时返回 "0"）。 */
export function averagePrice(state: ExecState): string {
  const filled = fx(state.filled)
  if (filled <= 0n) return '0'
  return str(div(fx(state.notional), filled))
}

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/live_trading/executors.py:128-334; adapted.
/**
 * 起步：数量截断后不足最小下单量就直接 tail guard 结束，否则发 post-only 限价 + 一条等待指令。
 * `now` 只做入参校验（必须是有限毫秒），纯函数自己不读钟、不落时间戳。
 */
export function startMakerThenMarket(
  spec: MakerThenMarketSpec,
  now: number,
): { state: ExecState; next: ExecStep } {
  validateSpec(spec)
  requireFinite('now', now)
  const size = targetSize(spec)
  if (cmpDec(size, '0') <= 0 || cmpDec(size, spec.minSize) < 0) {
    const next: ExecStep = { kind: 'done', reason: 'tail_guard' }
    return { state: { phase: 'done', filled: '0', notional: '0', fees: {}, steps: [next] }, next }
  }
  const price = makerPrice(spec.side, spec.refPrice, spec.makerOffsetBps, spec.tickSize)
  const place: ExecStep = { kind: 'place_limit', price, size, postOnly: true }
  const wait: ExecStep = { kind: 'wait', ms: spec.makerWaitMs }
  return {
    state: { phase: 'maker', filled: '0', notional: '0', fees: {}, steps: [place, wait] },
    next: place,
  }
}

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/live_trading/executors.py:144-334; adapted.
/**
 * 回喂一笔成交（含部分成交）：**任何阶段**都先累计成交量 / 名义额，按币种累计费用——真实成交永不丢弃。
 * 重复回报的去重由调用方用 `fillDedupeKey` 做。
 *
 * - 挂单腿（maker）：累计后 `filled ≥ target` → done/filled；否则留在 maker（撤单等待期间的成交也走这里）。
 * - 吃单腿（taker，IOC 尾单）：累计后 `filled ≥ target` → done/market_fallback；否则留在 taker，
 *   等下一笔成交或 IOC 结束的 onTimeout。
 * - 已结束（done）：只记账，`phase` 仍是 done、不追加步骤、不返回 `next`。
 *
 * `target` 是 `spec.size` 按 lotStep 截断后的实际挂单量。
 */
export function onFill(
  spec: MakerThenMarketSpec,
  state: ExecState,
  fill: Fill,
  now: number,
): { state: ExecState; next?: ExecStep } {
  requireFinite('now', now)
  positiveFx('fill.size', fill.size)
  positiveFx('fill.price', fill.price)

  const filled = addDec(state.filled, fill.size)
  const notional = addDec(state.notional, mulDec(fill.size, fill.price))
  const fees =
    fill.fee !== undefined && cmpDec(fill.fee, '0') !== 0
      ? mergeFee(state.fees, fill.fee, fill.feeCurrency)
      : state.fees

  if (state.phase === 'done') {
    return { state: { phase: 'done', filled, notional, fees, steps: state.steps } }
  }
  const full = cmpDec(filled, targetSize(spec)) >= 0
  if (state.phase === 'taker') {
    if (!full) return { state: { phase: 'taker', filled, notional, fees, steps: state.steps } }
    const next: ExecStep = { kind: 'done', reason: 'market_fallback' }
    return { state: { phase: 'done', filled, notional, fees, steps: [...state.steps, next] }, next }
  }
  if (full) {
    const next: ExecStep = { kind: 'done', reason: 'filled' }
    return { state: { phase: 'done', filled, notional, fees, steps: [...state.steps, next] }, next }
  }
  return { state: { phase: 'maker', filled, notional, fees, steps: state.steps } }
}

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/pending_orders/live_order_phases.py:255-283; adapted.
/**
 * 超时推进状态机。**调用约定分两段**（照 QD executors.py:164-176：撤单后再取一次快照，
 * 快照为 filled / cancelled 才按确认后的成交量算余量发市价）：
 *
 * 1. 第一次挂单超时（maker 阶段、最后一步不是 cancel）：
 *    - 已满量（`filled ≥ target`）→ done/filled，不撤单。
 *    - 否则只追加一条 `cancel`，`phase` 仍是 maker，`next` 返回这条 cancel。
 * 2. 第二次挂单超时（maker 阶段、最后一步是 cancel）：调用方**必须在撤单确认之后**再调，
 *    即 `cancelOutcome` 为 `confirmed` / `filled_meanwhile`，且确认快照之前的成交都已用 `onFill` 喂过。
 *    此时按**当前** `filled` 算余量：余量 ≤ 0 → done/filled；余量 < minSize → done/tail_guard；
 *    否则追加 `place_ioc`（价带价、余量），`phase` 转 taker，`next` 返回这条 IOC。
 *    撤单等待期间来的成交照常累加；若因此 `filled ≥ target` → done/filled。
 * 3. taker 阶段超时 = IOC 已结束（调用方确认 IOC 终态后调）：`phase` 改为 done，
 *    追加 done/market_fallback，`next` 返回它。
 * 4. done 阶段超时是空操作：state 不复制，`next` 是 `steps` 里最后一条 done 步骤（原样返回原因）。
 */
export function onTimeout(
  spec: MakerThenMarketSpec,
  state: ExecState,
  now: number,
): { state: ExecState; next: ExecStep } {
  requireFinite('now', now)
  if (state.phase === 'done') {
    const last = [...state.steps].reverse().find((step) => step.kind === 'done')
    return { state, next: last ?? { kind: 'done', reason: 'filled' } }
  }
  if (state.phase === 'taker') {
    const next: ExecStep = { kind: 'done', reason: 'market_fallback' }
    return { state: { ...state, phase: 'done', steps: [...state.steps, next] }, next }
  }

  const target = targetSize(spec)
  const cancelPending = state.steps.at(-1)?.kind === 'cancel'
  if (!cancelPending) {
    if (cmpDec(state.filled, target) >= 0) {
      const next: ExecStep = { kind: 'done', reason: 'filled' }
      return { state: { ...state, phase: 'done', steps: [...state.steps, next] }, next }
    }
    const cancel: ExecStep = { kind: 'cancel' }
    return { state: { ...state, steps: [...state.steps, cancel] }, next: cancel }
  }

  const remaining = remainingSize(spec, state)
  if (cmpDec(remaining, '0') <= 0) {
    const next: ExecStep = { kind: 'done', reason: 'filled' }
    return { state: { ...state, phase: 'done', steps: [...state.steps, next] }, next }
  }
  if (cmpDec(remaining, spec.minSize) < 0) {
    const next: ExecStep = { kind: 'done', reason: 'tail_guard' }
    return { state: { ...state, phase: 'done', steps: [...state.steps, next] }, next }
  }
  const price = bandPrice(spec.side, spec.refPrice, spec.maxSlippageBps, spec.tickSize)
  const ioc: ExecStep = { kind: 'place_ioc', price, size: remaining }
  return { state: { ...state, phase: 'taker', steps: [...state.steps, ioc] }, next: ioc }
}
