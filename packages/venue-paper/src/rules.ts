// SPDX-License-Identifier: CPAL-1.0
// 按标的能力声明（Instrument.price / size）规整价格与数量。规则来自 Instrument，不写死场所：
//   tick 型（CEX）：价格必须是 tick 的整数倍；
//   有效数字型（HL）：整数价恒合法，否则 ≤ sigFigs 位有效数字且小数位 ≤ maxDecimals。
import type { Instrument, InstrumentPriceRule } from '@gitrader/protocol'
import { abs, fracDigits, fx, intDigits, roundFx, sigDigits, str } from '@gitrader/protocol/decimal'
import type { Fx } from '@gitrader/protocol/decimal'

function leadingZerosAfterPoint(x: Fx): number {
  const s = str(abs(x))
  const i = s.indexOf('.')
  return i < 0 ? 0 : /^0*/.exec(s.slice(i + 1))![0].length
}

export function isValidPrice(rule: InstrumentPriceRule, p: Fx): boolean {
  if (p <= 0n) return false
  if (rule.tick !== undefined) return p % fx(rule.tick) === 0n
  if (fracDigits(p) === 0) return true
  if (rule.maxDecimals !== undefined && fracDigits(p) > rule.maxDecimals) return false
  if (rule.sigFigs !== undefined && sigDigits(p) > rule.sigFigs) return false
  return true
}

/** 贴到合法刻度；down = 向小，up = 向大。 */
export function snapPrice(rule: InstrumentPriceRule, p: Fx, dir: 'down' | 'up'): Fx {
  if (isValidPrice(rule, p)) return p
  if (rule.tick !== undefined) {
    const t = fx(rule.tick)
    const q = p / t
    return (dir === 'down' ? q : q + 1n) * t
  }
  const id = intDigits(p)
  const sigDp = rule.sigFigs === undefined ? 18 : id >= 1 ? rule.sigFigs - id : rule.sigFigs + leadingZerosAfterPoint(p)
  const dp = Math.max(0, Math.min(rule.maxDecimals ?? 18, sigDp))
  return roundFx(p, dp, dir === 'down' ? 'floor' : 'ceil')
}

/** 数量向零截断到 size.decimals。 */
export function truncSize(i: Instrument, s: Fx): Fx {
  return roundFx(s, i.size.decimals, 'trunc')
}
