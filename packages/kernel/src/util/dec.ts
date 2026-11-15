// SPDX-License-Identifier: CPAL-1.0
// 十进制定点运算（BigInt）。对账级数值一律十进制字符串（契约 §1.3），风控与预检在这里算，不碰浮点。
import { asDecimal, normalizeDecimal, DECIMAL_SIGDIGITS_MAX } from '../proto'
import type { Decimal } from '../proto'

/** 值 = n / 10^s，s ≥ 0。 */
export interface Dec { readonly n: bigint; readonly s: number }

const P10: bigint[] = [1n]
const p10 = (k: number): bigint => { while (P10.length <= k) P10.push((P10[P10.length - 1] as bigint) * 10n); return P10[k] as bigint }

export function D(x: string | number | Dec): Dec {
  if (typeof x === 'object') return x
  if (typeof x === 'number') {
    if (!Number.isFinite(x)) throw new TypeError(`not a finite number: ${x}`)
    x = String(x)
  }
  const canon = normalizeDecimal(x)
  const neg = canon.startsWith('-')
  const body = neg ? canon.slice(1) : canon
  const dot = body.indexOf('.')
  const s = dot < 0 ? 0 : body.length - dot - 1
  const n = BigInt(dot < 0 ? body : body.slice(0, dot) + body.slice(dot + 1))
  return { n: neg ? -n : n, s }
}

const align = (a: Dec, b: Dec): [bigint, bigint, number] => {
  const s = Math.max(a.s, b.s)
  return [a.n * p10(s - a.s), b.n * p10(s - b.s), s]
}
export const add = (a: Dec, b: Dec): Dec => { const [x, y, s] = align(a, b); return { n: x + y, s } }
export const sub = (a: Dec, b: Dec): Dec => { const [x, y, s] = align(a, b); return { n: x - y, s } }
export const mul = (a: Dec, b: Dec): Dec => ({ n: a.n * b.n, s: a.s + b.s })
/** 除法，结果保留 scale 位小数，向零截断。 */
export function div(a: Dec, b: Dec, scale = 18): Dec {
  if (b.n === 0n) throw new RangeError('division by zero')
  return { n: (a.n * p10(b.s) * p10(scale)) / (b.n * p10(a.s)), s: scale }
}
export const cmp = (a: Dec, b: Dec): -1 | 0 | 1 => { const [x, y] = align(a, b); return x < y ? -1 : x > y ? 1 : 0 }
export const eq = (a: Dec, b: Dec): boolean => cmp(a, b) === 0
export const lt = (a: Dec, b: Dec): boolean => cmp(a, b) < 0
export const lte = (a: Dec, b: Dec): boolean => cmp(a, b) <= 0
export const gt = (a: Dec, b: Dec): boolean => cmp(a, b) > 0
export const gte = (a: Dec, b: Dec): boolean => cmp(a, b) >= 0
export const isZero = (a: Dec): boolean => a.n === 0n
export const isNeg = (a: Dec): boolean => a.n < 0n
export const neg = (a: Dec): Dec => ({ n: -a.n, s: a.s })
export const abs = (a: Dec): Dec => (a.n < 0n ? neg(a) : a)
export const min = (a: Dec, b: Dec): Dec => (lte(a, b) ? a : b)
export const max = (a: Dec, b: Dec): Dec => (gte(a, b) ? a : b)
export const ZERO: Dec = { n: 0n, s: 0 }
export const ONE: Dec = { n: 1n, s: 0 }

/** 向零截断到 decimals 位小数。 */
export function truncTo(a: Dec, decimals: number): Dec {
  if (a.s <= decimals) return a
  return { n: a.n / p10(a.s - decimals), s: decimals }
}
/** 向 +∞ 取整到 decimals 位小数。 */
export function ceilTo(a: Dec, decimals: number): Dec {
  if (a.s <= decimals) return a
  const q = p10(a.s - decimals)
  let n = a.n / q
  if (a.n % q > 0n) n += 1n
  return { n, s: decimals }
}
/** 向 -∞ 取整到 decimals 位小数。 */
export function floorTo(a: Dec, decimals: number): Dec {
  if (a.s <= decimals) return a
  const q = p10(a.s - decimals)
  let n = a.n / q
  if (a.n % q < 0n) n -= 1n
  return { n, s: decimals }
}

/** 规范十进制字符串（有效数字 ≤ 30，超出时截断小数位）。 */
export function str(a: Dec): Decimal {
  let n = a.n, s = a.s
  while (s > 0 && n % 10n === 0n) { n /= 10n; s-- }
  const negative = n < 0n
  let digits = (negative ? -n : n).toString()
  if (s > 0) {
    // 有效数字上限：超过就砍小数位
    while (digits.replace(/^0+/, '').length > DECIMAL_SIGDIGITS_MAX && s > 0) { digits = digits.slice(0, -1); s-- }
    while (s > 0 && digits.endsWith('0')) { digits = digits.slice(0, -1); s-- }
  }
  let out: string
  if (s === 0) out = digits
  else {
    digits = digits.padStart(s + 1, '0')
    out = `${digits.slice(0, digits.length - s)}.${digits.slice(digits.length - s)}`
  }
  if (out === '0' || /^0(\.0*)?$/.test(out)) return asDecimal('0')
  return asDecimal(negative ? `-${out}` : out)
}
/** 小数位数（规范化后）。 */
export const scaleOf = (a: Dec): number => { let n = a.n, s = a.s; while (s > 0 && n % 10n === 0n) { n /= 10n; s-- } return s }
/** 整数部分位数（0.x 记 0 位）。 */
export function intDigits(a: Dec): number {
  const t = truncTo(abs(a), 0)
  return t.n === 0n ? 0 : t.n.toString().length
}
/** 第一个非零数字起算的有效数字个数（规范化后）。 */
export function sigFigs(a: Dec): number {
  if (a.n === 0n) return 0
  let n = a.n < 0n ? -a.n : a.n
  while (n % 10n === 0n) n /= 10n
  return n.toString().length
}
export const toNumber = (a: Dec): number => Number(str(a))
export const sum = (xs: Dec[]): Dec => xs.reduce(add, ZERO)
