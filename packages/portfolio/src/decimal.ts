// SPDX-License-Identifier: CPAL-1.0
// 组合分析的十进制记账层。
// 算术一律复用 @gitrader/protocol/decimal（18 位定点 bigint，不碰浮点）；本文件只做两件事：
//   1) 把定点值格式化成协议 Decimal 品牌（规范形：无指数、无尾随 0、零写 "0"、不写 "-0"）；
//   2) 定一个统一的对外精度 LEDGER_DP，所有金额 / 数量 / 比率输出都落在这一位。
import { abs, add, cmp, div, fx, mul, neg, sign, str, sub } from '@gitrader/protocol/decimal'
import type { Fx } from '@gitrader/protocol/decimal'
import type { Decimal } from '@gitrader/protocol'

/** 金额 / 数量 / 比率的对外精度（十进制位数）。内部一律 18 位定点，只在输出时落到这里。 */
export const LEDGER_DP = 8

// 规范形正则：语义照抄 packages/protocol/src/model/decimal.ts 的 DECIMAL_PATTERN（Apache-2.0）。
// 这里再复核一次的原因：str() 已按同一规则产出，但上游若改动格式化规则，本包要当场炸而不是静默产出非法字符串。
const CANONICAL = /^(?!-0$)-?(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$/

/** 定点值 -> 协议 Decimal（规范形字符串，四舍五入到 dp 位，缺省 LEDGER_DP）。 */
export function dec(x: Fx, dp = LEDGER_DP): Decimal {
  const text = str(x, dp)
  if (!CANONICAL.test(text)) throw new Error(`portfolio: non-canonical decimal ${JSON.stringify(text)}`)
  return text as Decimal
}

/** 协议 Decimal / 宽松十进制文本 -> 定点值。不是数字则抛 TypeError（来自协议 fx）。 */
export function toFx(value: Decimal | string): Fx {
  return fx(value)
}

export const ZERO: Fx = 0n

/** 求和；空集合为 0。 */
export function sumFx(values: Iterable<Fx>): Fx {
  let total = 0n
  for (const value of values) total += value
  return total
}

/** 除法，分母为 0 时返回 fallback（缺省 0）。用于「占比」这类分母可能为 0 的场合。 */
export function divOr(numerator: Fx, denominator: Fx, fallback: Fx = 0n): Fx {
  return denominator === 0n ? fallback : div(numerator, denominator)
}

/** 占比（0..1），分母为 0 回 '0'：占比类指标共用这一个口径。 */
export function share(part: Decimal, whole: Decimal): Decimal {
  return dec(divOr(fx(part), fx(whole)))
}

export { abs, add, cmp, div, fx, mul, neg, sign, str, sub }
export type { Fx }
