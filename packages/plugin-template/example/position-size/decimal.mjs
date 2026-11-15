// SPDX-License-Identifier: Apache-2.0
// 十进制字符串 ↔ BigInt 定点（8 位小数）。金额不用 Number；乘除合在一步里只取整一次，向下取整。
const S = 10n ** 8n

/** "12.5" → 1250000000n；只接受非负十进制，小数多于 8 位直接截掉（向下取整）。 */
export function parse(s) {
  const m = /^([0-9]+)(?:\.([0-9]+))?$/.exec(String(s))
  if (!m) throw new Error(`not a decimal: ${s}`)
  return BigInt(m[1]) * S + BigInt((m[2] ?? '').slice(0, 8).padEnd(8, '0'))
}
export const format = (n) => `${n / S}.${String(n % S).padStart(8, '0')}`
export const absDiff = (a, b) => (a > b ? a - b : b - a)
/** a × b ÷ c（都是定点数），结果向下取整到 8 位。c 为 0 抛错。 */
export function mulDiv(a, b, c) {
  if (c === 0n) throw new Error('division by zero')
  return (a * b) / c
}
