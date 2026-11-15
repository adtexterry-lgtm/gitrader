// SPDX-License-Identifier: CPAL-1.0
// 价格 / 数量规整（契约 §1.3）。OKX 的约束与币安不同，口径以 connector-okx-data 的解析为准：
//   · 价格：tickSz（Instrument.price.tick）—— 价格必须是它的整数倍；
//   · 数量：**协议里的数量是币数量**，而 OKX 下单的 `sz` 是「张」。本文件只做定点算术：
//     `contractsOf(base, ctVal)` 把币数量折成张（向零截断），`baseOf(contracts, ctVal)` 反向还原；
//     张的步长（lotSz）= Instrument.size.step / ctVal（数据包已把 lotSz 乘过 ctVal）。
// 向零截断方向只会更小，不会超买；价格按 rounding 决定 floor / ceil，永不朝成交方向放宽。
import { div, fx, mul, str } from '@gitrader/protocol/decimal'
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

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/live_trading/okx.py:177-179; adapted.
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

/** 定点除法（向零截断）：a / b，两者都必须是正的定点数。 */
export function divFloor(a: string, b: string): Decimal {
  const x = toFx(a)
  const y = toFx(b)
  if (x === undefined || y === undefined) throw new RangeError(`divFloor needs positive values (a=${a}, b=${b})`)
  return toDecimal(div(x, y))
}

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/live_trading/okx.py:214-267 (size normalization); adapted.
/**
 * 币数量 → 张：`base / ctVal`，再向零截断到张的最小步长。
 * `lotContracts` = Instrument.size.step / ctVal（数据包把 lotSz 乘过 ctVal）；缺省按 1 张步长。
 * 返回 '0' 表示折算后不足一张 / 不足一手 —— 调用方据此报 PRECISION。
 */
export function contractsOf(base: Decimal, ctVal: Decimal, lotContracts?: Decimal): Decimal {
  const raw = divFloor(String(base), String(ctVal))
  if (lotContracts === undefined) return raw
  const step = toFx(String(lotContracts))
  if (step === undefined) return raw
  return truncateToStep(raw, String(lotContracts))
}

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/live_trading/okx.py:1144-1162 (filled contracts → base); adapted.
/** 张 → 币数量：`contracts × ctVal`；ctVal 缺失 / 非法时抛 RangeError（绝不把张当币）。 */
export function baseOf(contracts: Decimal, ctVal: Decimal): Decimal {
  const c = toFx(String(contracts))
  const v = toFx(String(ctVal))
  if (c === undefined) return '0' as Decimal
  if (v === undefined) throw new RangeError(`baseOf needs a positive ctVal (contracts=${contracts}, ctVal=${ctVal})`)
  return toDecimal(mul(c, v))
}

function toDecimal(x: Fx): Decimal {
  return str(x) as Decimal
}
