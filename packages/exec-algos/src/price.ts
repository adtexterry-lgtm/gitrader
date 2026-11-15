// SPDX-License-Identifier: CPAL-1.0
// 定价：挂单偏移价与市价意图的价带上限价。两处都只按 tick 取整，且只朝“更难成交”的一侧取整。
import { add, div, fx, mul, str, sub, type Fx } from '@gitrader/protocol/decimal'
import { positiveFx, requireFinite, roundToStep } from './num'
import type { Side } from './types'

const BPS_DEN: Fx = fx('10000')

function bpsFx(label: string, bps: number): Fx {
  requireFinite(label, bps)
  if (bps < 0) throw new RangeError(`${label} must not be negative: ${bps}`)
  return fx(String(bps))
}

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/pending_orders/live_order_phases.py:29-38; adapted.
/**
 * 挂单价：买单 = ref·(1 − offset)，卖单 = ref·(1 + offset)，再按 tick 取整（买向下、卖向上）。
 * 取整方向保证成交价不差于计算出的偏移价：买单不会付得更高，卖单不会卖得更低。
 */
export function makerPrice(side: Side, refPrice: string, offsetBps: number, tickSize: string): string {
  const ref = positiveFx('refPrice', refPrice)
  const tick = positiveFx('tickSize', tickSize)
  const off = div(bpsFx('offsetBps', offsetBps), BPS_DEN)
  const delta = mul(ref, off)
  const target = side === 'buy' ? sub(ref, delta) : add(ref, delta)
  if (target <= 0n) throw new RangeError('maker price collapses to non-positive; check offsetBps')
  return str(roundToStep(target, tick, side === 'buy' ? 'floor' : 'ceil'))
}

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/live_trading/limit_price_safety.py:25-40; adapted.
/**
 * 市价意图的价带限价（配合 IOC 发出）：买单上沿 = ref·(1 + slip)，卖单下沿 = ref·(1 − slip)。
 * 买单向下取整、卖单向上取整，只收紧、不朝成交方向放宽。
 */
export function bandPrice(side: Side, refPrice: string, maxSlippageBps: number, tickSize: string): string {
  const ref = positiveFx('refPrice', refPrice)
  const tick = positiveFx('tickSize', tickSize)
  const slip = div(bpsFx('maxSlippageBps', maxSlippageBps), BPS_DEN)
  const delta = mul(ref, slip)
  const target = side === 'buy' ? add(ref, delta) : sub(ref, delta)
  if (target <= 0n) throw new RangeError('slippage band collapses to non-positive; check maxSlippageBps')
  return str(roundToStep(target, tick, side === 'buy' ? 'floor' : 'ceil'))
}
