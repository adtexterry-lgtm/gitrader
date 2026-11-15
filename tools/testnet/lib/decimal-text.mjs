// SPDX-License-Identifier: CPAL-1.0
// 定点文本运算（只用 BigInt，不碰 JS 浮点）：把 "0.001" 这类十进制文本按步长向下 / 向上贴齐。
// 只服务旅程脚本的「远离盘口的极小限价单」定价；真正的钱路口径在 packages/protocol 的 decimal 工具里。

/** 小数位数："0.001" → 3，"100" → 0。 */
export function decimalsOf(text) {
  const s = String(text)
  const dot = s.indexOf('.')
  return dot < 0 ? 0 : s.length - dot - 1
}

/** 把十进制文本放大成 BigInt（按 decimals 位）；多余位数四舍五入丢弃（向零）。 */
export function toUnits(text, decimals) {
  const s = String(text).trim()
  if (!/^-?\d+(\.\d+)?$/.test(s)) throw new TypeError(`not a decimal: ${s}`)
  const negative = s.startsWith('-')
  const body = negative ? s.slice(1) : s
  const [whole, frac = ''] = body.split('.')
  const padded = (frac + '0'.repeat(decimals)).slice(0, decimals)
  const units = BigInt(whole + padded)
  return negative ? -units : units
}

/** BigInt 还原成定点文本（去掉尾部 0，但保留至少整数位）。 */
export function fromUnits(units, decimals) {
  const negative = units < 0n
  let digits = (negative ? -units : units).toString().padStart(decimals + 1, '0')
  const whole = digits.slice(0, digits.length - decimals)
  const frac = decimals === 0 ? '' : digits.slice(digits.length - decimals).replace(/0+$/, '')
  const text = frac === '' ? whole : `${whole}.${frac}`
  return negative ? `-${text}` : text
}

/** 向下贴到 step 的整数倍（价格用）。 */
export function snapDown(value, step) {
  const d = Math.max(decimalsOf(value), decimalsOf(step))
  const v = toUnits(value, d)
  const s = toUnits(step, d)
  if (s <= 0n) throw new TypeError(`step must be positive: ${step}`)
  const snapped = v - (((v % s) + s) % s)
  return fromUnits(snapped, d)
}

/** 向上贴到 step 的整数倍（数量用，保证 ≥ 场所最小量）。 */
export function snapUp(value, step) {
  const d = Math.max(decimalsOf(value), decimalsOf(step))
  const v = toUnits(value, d)
  const s = toUnits(step, d)
  if (s <= 0n) throw new TypeError(`step must be positive: ${step}`)
  const remainder = ((v % s) + s) % s
  const snapped = remainder === 0n ? v : v + (s - remainder)
  return fromUnits(snapped, d)
}

/** 按基点调整价格文本：bps 为正 = 价格上浮，为负 = 下浮。 */
export function shiftBps(priceText, bps) {
  const d = Math.max(decimalsOf(priceText), 6)
  const v = toUnits(priceText, d)
  const shifted = (v * BigInt(10_000 + bps)) / 10_000n
  return fromUnits(shifted, d)
}

/** 两个十进制文本相乘（BigInt 精确，不做浮点）。 */
export function multiplyDecimal(a, b) {
  const da = decimalsOf(a)
  const db = decimalsOf(b)
  const product = toUnits(a, da) * toUnits(b, db)
  return fromUnits(product, da + db)
}

/** 十进制文本比较：a > b → 1，a < b → -1，相等 → 0。 */
export function compareDecimal(a, b) {
  const d = Math.max(decimalsOf(a), decimalsOf(b))
  const x = toUnits(a, d)
  const y = toUnits(b, d)
  return x === y ? 0 : x > y ? 1 : -1
}

/** 数量是否非零（"0" / "0.000" → false）。 */
export function isNonZero(text) {
  if (text === null || text === undefined) return false
  try {
    return toUnits(String(text), Math.max(decimalsOf(text), 0)) !== 0n
  } catch {
    return false
  }
}
