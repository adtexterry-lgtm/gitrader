// SPDX-License-Identifier: CPAL-1.0
// 十进制字符串的解析、比较与加减（契约 §1.3：对账级数值一律十进制字符串）。
// 对账要判定「场所报的累计成交量比本地记的多还是少」「持仓差是否在容差内」，
// 这些判定一次都不许经过浮点：0.1 + 0.2 !== 0.3 会让一条本该相等的成交被报成差异。
// 实现只用字符串与 BigInt，不引第三方库。

/** 解析后的十进制：符号与整数 / 小数部分（小数部分已去掉尾零）。 */
export interface ParsedDecimal {
  neg: boolean
  int: string
  frac: string
}

const DECIMAL_RE = /^([+-]?)(\d*)(?:\.(\d*))?$/

/** 解析十进制字符串；不认指数记法、NaN、Infinity、千分位。非法输入抛 TypeError。 */
export function parseDecimal(value: string): ParsedDecimal {
  const text = typeof value === 'string' ? value.trim() : ''
  const m = DECIMAL_RE.exec(text)
  if (!m) throw new TypeError(`not a decimal string: ${JSON.stringify(value)}`)
  const rawInt = m[2] ?? ''
  const rawFrac = m[3] ?? ''
  if (rawInt === '' && rawFrac === '') throw new TypeError(`not a decimal string: ${JSON.stringify(value)}`)
  const int = rawInt.replace(/^0+(?=\d)/, '') || '0'
  const frac = rawFrac.replace(/0+$/, '')
  const neg = m[1] === '-' && !(int === '0' && frac === '')
  return { neg, int, frac }
}

/** 是否是合法的十进制字符串（不抛错版本）。 */
export function isDecimalString(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    parseDecimal(value)
    return true
  } catch {
    return false
  }
}

/** 归一化：去掉正号、前导零、小数尾零。 */
export function normalizeDecimal(value: string): string {
  const d = parseDecimal(value)
  const body = d.frac === '' ? d.int : `${d.int}.${d.frac}`
  return d.neg ? `-${body}` : body
}

/** 绝对值。 */
export function absDecimal(value: string): string {
  return normalizeDecimal(value).replace(/^-/, '')
}

/** 取反。 */
export function negateDecimal(value: string): string {
  const n = normalizeDecimal(value)
  return n.startsWith('-') ? n.slice(1) : n === '0' ? '0' : `-${n}`
}

/** 符号：-1 / 0 / 1。 */
export function signDecimal(value: string): -1 | 0 | 1 {
  const d = parseDecimal(value)
  if (d.int === '0' && d.frac === '') return 0
  return d.neg ? -1 : 1
}

/** 是否为零。 */
export function isZeroDecimal(value: string): boolean {
  return signDecimal(value) === 0
}

function compareMagnitude(a: ParsedDecimal, b: ParsedDecimal): -1 | 0 | 1 {
  if (a.int.length !== b.int.length) return a.int.length < b.int.length ? -1 : 1
  if (a.int !== b.int) return a.int < b.int ? -1 : 1
  const width = Math.max(a.frac.length, b.frac.length)
  const af = a.frac.padEnd(width, '0')
  const bf = b.frac.padEnd(width, '0')
  if (af === bf) return 0
  return af < bf ? -1 : 1
}

/** 比较两个十进制字符串：a < b → -1，相等 → 0，a > b → 1。 */
export function compareDecimal(a: string, b: string): -1 | 0 | 1 {
  const x = parseDecimal(a)
  const y = parseDecimal(b)
  if (x.neg !== y.neg) return x.neg ? -1 : 1
  const magnitude = compareMagnitude(x, y)
  if (!x.neg) return magnitude
  return magnitude === 0 ? 0 : magnitude === 1 ? -1 : 1
}

/** 数值相等（'1.10' 与 '1.1' 相等）。 */
export function equalDecimal(a: string, b: string): boolean {
  return compareDecimal(a, b) === 0
}

function scaledDigits(d: ParsedDecimal, scale: number): string {
  // padEnd 只补不截：小数位比标度长时，多余的小数位会被拼进整数部分（'0.0001' 放到 0 位标度 → 1），
  // 数字凭空放大。这里宁可抛错也不静默给错数。combine / commonScaled 的标度取两个操作数的最大
  // 小数位，永远不会触发；只有把值硬放到更小标度（旧 sizeEqual 拿容差这么做）才会。
  if (d.frac.length > scale) {
    throw new RangeError(`decimal has ${d.frac.length} fractional digits, more than scale ${scale}; refusing to truncate`)
  }
  return `${d.neg ? '-' : ''}${d.int}${d.frac.padEnd(scale, '0')}`
}

function fromScaled(value: bigint, scale: number): string {
  const negative = value < 0n
  let body = (negative ? -value : value).toString()
  if (scale > 0) {
    body = body.padStart(scale + 1, '0')
    const int = body.slice(0, body.length - scale)
    const frac = body.slice(body.length - scale).replace(/0+$/, '')
    body = frac === '' ? int : `${int}.${frac}`
  }
  if (negative && /[1-9]/.test(body)) return `-${body}`
  return body
}

function combine(a: string, b: string, flip: boolean): string {
  const x = parseDecimal(a)
  const y = parseDecimal(b)
  const scale = Math.max(x.frac.length, y.frac.length)
  const left = BigInt(scaledDigits(x, scale))
  const right = BigInt(scaledDigits(y, scale))
  return fromScaled(flip ? left - right : left + right, scale)
}

/** 加法（十进制字符串进出）。 */
export function addDecimal(a: string, b: string): string {
  return combine(a, b, false)
}

/** 减法。 */
export function subtractDecimal(a: string, b: string): string {
  return combine(a, b, true)
}

/** 求和；空数组返回 '0'。 */
export function sumDecimal(values: readonly string[]): string {
  return values.reduce((acc, v) => addDecimal(acc, v), '0')
}

/** 两个数的差是否在容差内（|a-b| <= tolerance）；tolerance 必须非负。 */
export function withinTolerance(a: string, b: string, tolerance: string): boolean {
  if (signDecimal(tolerance) < 0) throw new RangeError(`tolerance must not be negative: ${tolerance}`)
  return compareDecimal(absDecimal(subtractDecimal(a, b)), tolerance) <= 0
}

/** 取较小值。 */
export function minDecimal(a: string, b: string): string {
  return compareDecimal(a, b) <= 0 ? normalizeDecimal(a) : normalizeDecimal(b)
}

/** 把某个十进制按指定标度转成未缩放整数（例如把容差 0.001 放到 4 位标度上 → 10n）。 */
export function decimalAtScale(value: string, scale: number): bigint {
  return BigInt(scaledDigits(parseDecimal(value), scale))
}

/** 把两个十进制放到同一标度上，返回未缩放整数（供乘除 / 比例比较用，不经过浮点）。 */
export function commonScaled(a: string, b: string): { a: bigint; b: bigint; scale: number } {
  const x = parseDecimal(a)
  const y = parseDecimal(b)
  const scale = Math.max(x.frac.length, y.frac.length)
  return { a: BigInt(scaledDigits(x, scale)), b: BigInt(scaledDigits(y, scale)), scale }
}

/** 取较大值。 */
export function maxDecimal(a: string, b: string): string {
  return compareDecimal(a, b) >= 0 ? normalizeDecimal(a) : normalizeDecimal(b)
}
