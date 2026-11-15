// SPDX-License-Identifier: CPAL-1.0
// Bitget 价格 / 数量规整（契约 §1.3）。Bitget v2 mix 的精度来自合约元数据：
//   · 价格：`pricePlace`（小数位）+ `priceEndStep`（末位步长）→ tick = priceEndStep × 10^-pricePlace；
//   · 数量：`volumePlace`（小数位）→ step = 10^-volumePlace，下限 `minTradeNum`；名义额下限 `minTradeUSDT`；
//   · 数量一律「向零截断」到 step（与 QD `_floor_to_step` 同向，QD bitget.py:173-175）；
//   · 价格按 rounding 决定向下 / 向上贴 tick，永不朝成交方向放宽（passive：买单向下、卖单向上）。
// 全部走 @gitrader/protocol 的定点十进制（fx / str / floorToStep），不做 JS 浮点加减。
import { floorToStep, fx, str } from '@gitrader/protocol/decimal'
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

/** step / tick 的小数位数（文档与断言用；规整本身走定点除法）。 */
export function decimalsOf(step: string): number {
  const i = step.indexOf('.')
  return i < 0 ? 0 : step.length - i - 1
}

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/live_trading/bitget.py:173-175; adapted.
/** 向零截断到 step 的整数倍（正数即 floor）。 */
export function truncateToStep(value: string, step: string): Decimal {
  const x = toFx(value)
  const s = toFx(step)
  if (x === undefined || s === undefined) throw new RangeError(`truncateToStep needs positive values (value=${value}, step=${step})`)
  return floorToStep(str(x), str(s))
}

/** value 是否正好是 step 的整数倍。 */
export function isMultipleOf(value: string, step: string): boolean {
  const x = toFx(value)
  const s = toFx(step)
  if (x === undefined || s === undefined) return false
  return x % s === 0n
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
