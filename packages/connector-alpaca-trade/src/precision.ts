// SPDX-License-Identifier: CPAL-1.0
// 美股价格 / 数量规整（契约 §1.3）。全部走 @gitrader/protocol 的定点十进制，不做 JS 浮点加减（教训 7）。
//   · 价格：Alpaca 的 tick 由资产元数据 `price_increment` 给（美股多为 0.01，部分 0.0001），无元数据时缺省 0.01；
//   · 数量：**整数股**（step 1）或**小数股**（step 0.000001，仅 `fractionable` 资产）——不取整，不合规直接拒；
//   · 价格贴 tick 永不朝成交方向放宽：买单向下、卖单向上（照 packages/connector-hyperliquid/src/limit-safety.ts 口径）。
import { floorToStep, fx, str } from '@gitrader/protocol/decimal'
import type { Fx } from '@gitrader/protocol/decimal'
import type { Decimal } from '@gitrader/protocol'

/** 小数股的最小步长（Alpaca 允许到 6 位小数；资产元数据不给时用它）。 */
export const FRACTIONAL_STEP = '0.000001'
/** 整数股的步长。 */
export const WHOLE_SHARE_STEP = '1'
/** 美股缺省 tick（无资产元数据时）。 */
export const DEFAULT_TICK = '0.01'

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

/** step / tick 的小数位数（文档与断言用）。 */
export function decimalsOf(step: string): number {
  const i = step.indexOf('.')
  return i < 0 ? 0 : step.length - i - 1
}

/** 数量是否恰好是整数股。 */
export function isWholeQty(value: string): boolean {
  const x = toFx(value)
  return x !== undefined && x % fx(WHOLE_SHARE_STEP) === 0n
}

/** 数量是否是 step 的整数倍。 */
export function isMultipleOf(value: string, step: string): boolean {
  const x = toFx(value)
  const s = toFx(step)
  if (x === undefined || s === undefined) return false
  return x % s === 0n
}

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/live_trading/bitget.py:173-175; adapted.
/** 向零截断到 step 的整数倍（正数即 floor）。 */
export function truncateToStep(value: string, step: string): Decimal {
  const x = toFx(value)
  const s = toFx(step)
  if (x === undefined || s === undefined) throw new RangeError(`truncateToStep needs positive values (value=${value}, step=${step})`)
  return floorToStep(str(x), str(s))
}

/** 把价格贴到 tick 上：down = 向小取整，up = 向大取整（正好整除时不动）。 */
export function snapToTick(price: string, tick: string, dir: 'down' | 'up'): Decimal {
  const p = toFx(price)
  const t = toFx(tick)
  if (p === undefined || t === undefined) throw new RangeError(`snapToTick needs positive values (price=${price}, tick=${tick})`)
  const down = (p / t) * t
  if (dir === 'down') return str(down) as Decimal
  return str(down === p ? p : down + t) as Decimal
}

/** 定点数 × bps/10000（滑点带用）。 */
export function applyBps(price: string, bps: number, dir: 'up' | 'down'): Decimal {
  const p = fx(price)
  const delta = (p * BigInt(Math.abs(Math.trunc(bps)))) / 10_000n
  return str(dir === 'up' ? p + delta : p - delta) as Decimal
}

/** 小数股数量规整：只截到 6 位（Alpaca 精度），不做「进位到整股」（取整就是改用户的数量）。 */
export function normalizeFractionalQty(value: string): Decimal {
  return truncateToStep(value, FRACTIONAL_STEP)
}
