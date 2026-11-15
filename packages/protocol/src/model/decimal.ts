// SPDX-License-Identifier: Apache-2.0
// 契约 §1.3：对账级数值一律十进制字符串（订单、成交、持仓、余额、保证金、账本、GEP / MCP / 导出同此规则）。
// 行情类（K 线、盘口、报价、深度）与分析级数值（概率、置信度）允许 JSON number。

declare const decimalBrand: unique symbol

/** 规范十进制字符串（品牌类型）。只能经 `asDecimal()` / `isDecimal()` 得到，避免把任意字符串当金额。 */
export type Decimal = string & { readonly [decimalBrand]: true }

/** Unix 毫秒整数。 */
export type Ms = number

export const GATE_DIV_SCALE = 18
export const GATE_RATIO_SCALE = 8

/** 规范形：无指数、无前导 +、无尾随 0、零写 "0"、不写 "-0"。 */
export const DECIMAL_PATTERN = '^(?!-0$)-?(0|[1-9][0-9]*)(\\.[0-9]*[1-9])?$'
/** 有效数字 ≤ 30：第一个非零数字之后最多再有 29 位数字（小数点不算）。 */
export const DECIMAL_SIGDIGITS_MAX = 30

const DECIMAL_RE = new RegExp(DECIMAL_PATTERN)
const TOO_MANY_SIG_RE = new RegExp(`^-?0*\\.?0*[1-9](?:\\.?[0-9]){${DECIMAL_SIGDIGITS_MAX}}`)

export function isDecimal(value: unknown): value is Decimal {
  return typeof value === 'string' && DECIMAL_RE.test(value) && !TOO_MANY_SIG_RE.test(value)
}

/** 校验并品牌化；不合规则抛 TypeError。 */
export function asDecimal(value: string): Decimal {
  if (!isDecimal(value)) throw new TypeError(`not a canonical decimal string: ${JSON.stringify(value)}`)
  return value
}

/**
 * 把宽松的十进制文本（可带 +、指数、尾随 0、"-0"）规范化为规范形；不是数字则抛 TypeError。
 * 只做文本规范化，不做浮点运算，不丢精度。
 */
export function normalizeDecimal(input: string): Decimal {
  const m = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(input.trim())
  if (!m || (m[2] === '' && (m[3] ?? '') === '')) throw new TypeError(`not a decimal number: ${JSON.stringify(input)}`)
  const sign = m[1] === '-' ? '-' : ''
  let intPart = m[2] ?? ''
  let frac = m[3] ?? ''
  const exp = m[4] ? parseInt(m[4], 10) : 0
  if (exp > 0) {
    const shift = Math.min(exp, frac.length)
    intPart += frac.slice(0, shift)
    frac = frac.slice(shift)
    intPart += '0'.repeat(exp - shift)
  } else if (exp < 0) {
    const need = -exp
    const take = Math.min(need, intPart.length)
    frac = intPart.slice(intPart.length - take) + frac
    intPart = intPart.slice(0, intPart.length - take)
    frac = '0'.repeat(need - take) + frac
  }
  intPart = intPart.replace(/^0+/, '') || '0'
  frac = frac.replace(/0+$/, '')
  const body = frac ? `${intPart}.${frac}` : intPart
  return asDecimal(body === '0' ? '0' : sign + body)
}

/** 对外格式化别名：将宽松十进制文本规范化为协议标准写法。 */
export const formatDecimal = normalizeDecimal
