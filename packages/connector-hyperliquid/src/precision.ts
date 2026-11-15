// SPDX-License-Identifier: CPAL-1.0
// Hyperliquid 价格 / 数量规整（契约 §1.3；知识库「API_info与exchange要点」tick and lot size）。
//   价格：≤5 位有效数字，小数位 ≤ 6 − szDecimals（永续），整数价恒合法；签名前去尾随 0。
//   数量：按 szDecimals 向零截断。
import { abs, fx, fracDigits, intDigits, roundFx, sigDigits, str } from '@gitrader/protocol/decimal'
import type { Fx } from '@gitrader/protocol/decimal'

export const PERP_PRICE_DECIMALS = 6
export const MAX_SIG_FIGS = 5

export function maxPriceDecimals(szDecimals: number): number {
  return Math.max(PERP_PRICE_DECIMALS - szDecimals, 0)
}

/** 0 < |x| < 1 时，小数点后紧跟的零的个数。 */
function leadingZerosAfterPoint(x: Fx): number {
  const s = str(abs(x))
  const i = s.indexOf('.')
  if (i < 0) return 0
  return /^0*/.exec(s.slice(i + 1))![0].length
}

export function isValidPrice(p: Fx, szDecimals: number): boolean {
  if (p <= 0n) return false
  if (fracDigits(p) === 0) return true // 整数价恒合法
  if (fracDigits(p) > maxPriceDecimals(szDecimals)) return false
  return sigDigits(p) <= MAX_SIG_FIGS
}

/** 把价格贴到合法刻度。dir：down = 向小取整，up = 向大取整。 */
export function snapPrice(p: Fx, szDecimals: number, dir: 'down' | 'up'): Fx {
  if (isValidPrice(p, szDecimals)) return p
  const id = intDigits(p)
  const sigDp = id >= 1 ? MAX_SIG_FIGS - id : MAX_SIG_FIGS + leadingZerosAfterPoint(p)
  const dp = Math.max(0, Math.min(maxPriceDecimals(szDecimals), sigDp))
  return roundFx(p, dp, dir === 'down' ? 'floor' : 'ceil')
}

/** 数量向零截断到 szDecimals。 */
export function truncSize(s: Fx, szDecimals: number): Fx {
  return roundFx(s, szDecimals, 'trunc')
}

/** 线上价格 / 数量字符串：规范形（无尾随 0）。 */
export const wire = (x: Fx): string => str(x)
export { fx }
