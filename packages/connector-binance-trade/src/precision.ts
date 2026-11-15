// SPDX-License-Identifier: CPAL-1.0
// Binance 价格 / 数量规整（契约 §1.3）。Binance 用的是盘口过滤器，不是有效数字：
//   · PRICE_FILTER.tickSize     —— 价格必须是 tickSize 的整数倍（测试里 tick = 0.10）；
//   · LOT_SIZE.stepSize / minQty —— 数量必须是 stepSize 的整数倍且不小于 minQty；
//   · MIN_NOTIONAL.notional     —— 名义额下限（reduceOnly 单豁免）。
// 数量一律「向零截断」到 step（与 QD `_floor_to_step` 同向），价格按 rounding 决定 floor / ceil，
// 永不朝成交方向放宽（passive：买单向下、卖单向上）。
import { fx, str } from '@gitrader/protocol/decimal'
import type { Fx } from '@gitrader/protocol/decimal'
import type { Decimal } from '@gitrader/protocol'

/** 解析成正的定点数；非法 / 非正返回 undefined。 */
export function toFx(value: string | number | undefined | null): Fx | undefined {
  if (value === undefined || value === null) return undefined
  const text = typeof value === 'number' ? String(value) : value.trim()
  if (text === '') return undefined
  try {
    const x = fx(text)
    return x > 0n ? x : undefined
  } catch {
    return undefined
  }
}

/** step / tick 的小数位数（用于文档与断言；规整本身走定点除法）。 */
export function decimalsOf(step: string): number {
  const i = step.indexOf('.')
  return i < 0 ? 0 : step.length - i - 1
}

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/live_trading/binance.py:162-164; adapted.
/** 向零截断到 step 的整数倍（正数即 floor）。 */
export function truncateToStep(value: string, step: string): Decimal {
  const x = toFx(value)
  const s = toFx(step)
  if (x === undefined || s === undefined) throw new RangeError(`truncateToStep needs positive values (value=${value}, step=${step})`)
  return toDecimal((x / s) * s)
}

/** value 是否正好是 step 的整数倍。 */
export function isMultipleOf(value: string, step: string): boolean {
  const x = toFx(value)
  const s = toFx(step)
  if (x === undefined || s === undefined) return false
  return x % s === 0n
}

/** 把价格贴到 tick 上：down = 向零（小）取整，up = 向大取整。 */
export function snapToTick(price: string, tick: string, dir: 'down' | 'up'): Decimal {
  const p = toFx(price)
  const t = toFx(tick)
  if (p === undefined || t === undefined) throw new RangeError(`snapToTick needs positive values (price=${price}, tick=${tick})`)
  const down = (p / t) * t
  if (dir === 'down') return toDecimal(down)
  return toDecimal(down === p ? p : down + t)
}

/** 定点数在 0.1 尺度下的写法：有 tick 用小数位，无 tick 用协议规范形。 */
export function stopTolerance(step: string): Decimal {
  // 一个 tick 的容差；用于「触发价是否已经穿过参考价」这类检查留给内核，这里只给数值。
  return toDecimal(fx(step))
}

function toDecimal(x: Fx): Decimal {
  return str(x) as Decimal
}
