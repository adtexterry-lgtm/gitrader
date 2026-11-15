// SPDX-License-Identifier: Apache-2.0
// 十进制字符串 <-> 定点整数（scale 18）的算术：加、减、乘、除、比较、精度截断。订单 / 价格规整、模拟撮合用，不碰浮点。
// 由 connector-hyperliquid 与 venue-paper 里两份同源的 dec.ts 抽出（v0.1.3）；导出名与那两份保持一致，替换时只改 import 路径：
//   import { fx, str, mul, ... } from '@gitrader/protocol/decimal'
// 注意：定点值只有 18 位小数，乘除超出的位向零截断；对账级金额的加减在 18 位内是精确的。
import { asDecimal, type Decimal } from './model/decimal'

export const SCALE = 18
const ONE = 10n ** BigInt(SCALE)

export type Fx = bigint

const NUM_RE = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/

/** 解析十进制文本（允许 +、指数、前后零）。不是数字则抛 TypeError。小数超过 18 位的部分向零截断。 */
export function fx(input: string | number): Fx {
  const text = typeof input === 'number' ? numberToText(input) : input.trim()
  const m = NUM_RE.exec(text)
  if (!m || ((m[2] ?? '') === '' && (m[3] ?? '') === '')) throw new TypeError(`not a decimal number: ${JSON.stringify(input)}`)
  let int = m[2] ?? ''
  let frac = m[3] ?? ''
  const exp = m[4] ? parseInt(m[4], 10) : 0
  if (exp > 0) {
    const take = Math.min(exp, frac.length)
    int += frac.slice(0, take)
    frac = frac.slice(take)
    int += '0'.repeat(exp - take)
  } else if (exp < 0) {
    const need = -exp
    const take = Math.min(need, int.length)
    frac = int.slice(int.length - take) + frac
    int = int.slice(0, int.length - take)
    frac = '0'.repeat(need - take) + frac
  }
  frac = (frac + '0'.repeat(SCALE)).slice(0, SCALE)
  const v = BigInt((int || '0') + frac)
  return m[1] === '-' ? -v : v
}

function numberToText(n: number): string {
  if (!Number.isFinite(n)) throw new TypeError(`not a finite number: ${n}`)
  return String(n)
}

export type RoundMode = 'trunc' | 'floor' | 'ceil' | 'half'

/** 按 dp 位小数取整（定点值仍在 scale 18 上）。trunc 向零，floor 向负无穷，ceil 向正无穷，half 四舍五入（远离零）。 */
export function roundFx(x: Fx, dp: number, mode: RoundMode = 'trunc'): Fx {
  if (dp >= SCALE) return x
  const unit = 10n ** BigInt(SCALE - dp)
  const q = x / unit // bigint 除法向零
  const r = x - q * unit
  if (r === 0n) return x
  switch (mode) {
    case 'trunc': return q * unit
    case 'floor': return (x < 0n ? q - 1n : q) * unit
    case 'ceil': return (x > 0n ? q + 1n : q) * unit
    case 'half': {
      const twice = (r < 0n ? -r : r) * 2n
      if (twice >= unit) return (x < 0n ? q - 1n : q + 1n) * unit
      return q * unit
    }
  }
}

/** 规范十进制字符串（无指数、无尾随 0、零写 "0"、不写 "-0"）。dp 缺省 18；超出的位按四舍五入。 */
export function str(x: Fx, dp = SCALE): string {
  const v = roundFx(x, dp, 'half')
  const neg = v < 0n
  const abs_ = neg ? -v : v
  const s = abs_.toString().padStart(SCALE + 1, '0')
  const int = s.slice(0, s.length - SCALE)
  const frac = s.slice(s.length - SCALE).replace(/0+$/, '')
  const body = frac ? `${int}.${frac}` : int
  return neg && body !== '0' ? `-${body}` : body
}

export const ZERO: Fx = 0n
export const ONE_FX: Fx = ONE

export const add = (a: Fx, b: Fx): Fx => a + b
export const sub = (a: Fx, b: Fx): Fx => a - b
export const neg = (a: Fx): Fx => -a
export const mul = (a: Fx, b: Fx): Fx => (a * b) / ONE
export const div = (a: Fx, b: Fx): Fx => {
  if (b === 0n) throw new RangeError('division by zero')
  return (a * ONE) / b
}
export const abs = (a: Fx): Fx => (a < 0n ? -a : a)
export const min = (a: Fx, b: Fx): Fx => (a < b ? a : b)
export const max = (a: Fx, b: Fx): Fx => (a > b ? a : b)
export const cmp = (a: Fx, b: Fx): -1 | 0 | 1 => (a < b ? -1 : a > b ? 1 : 0)
export const sign = (a: Fx): -1 | 0 | 1 => (a < 0n ? -1 : a > 0n ? 1 : 0)
export const toNumber = (a: Fx): number => Number(a) / 1e18

/** 小数部分的位数（0 表示整数）。 */
export function fracDigits(x: Fx): number {
  const s = str(x)
  const i = s.indexOf('.')
  return i < 0 ? 0 : s.length - i - 1
}

/** 整数部分位数（|x|<1 时为 0）。 */
export function intDigits(x: Fx): number {
  const s = str(abs(x))
  const i = s.indexOf('.')
  const int = i < 0 ? s : s.slice(0, i)
  return int === '0' ? 0 : int.length
}

/** 第一个非零数字之后到末位的有效数字个数（用于 5 位有效数字规则）。 */
export function sigDigits(x: Fx): number {
  const s = str(abs(x)).replace('.', '').replace(/^0+/, '')
  return s.length
}

// ---- 字符串层：输入输出都是规范十进制字符串（Decimal 品牌类型）-----------------------------------

/** 规范十进制字符串之和 / 差 / 积；积按 mode 取到 dp 位小数（缺省向零截断到 18 位）。 */
export const addDec = (a: string, b: string): Decimal => asDecimal(str(fx(a) + fx(b)))
export const subDec = (a: string, b: string): Decimal => asDecimal(str(fx(a) - fx(b)))
export const mulDec = (a: string, b: string, dp = SCALE, mode: RoundMode = 'trunc'): Decimal => asDecimal(str(roundFx(mul(fx(a), fx(b)), dp, mode), dp))
/** 比较两个十进制字符串：-1 / 0 / 1。 */
export const cmpDec = (a: string, b: string): -1 | 0 | 1 => cmp(fx(a), fx(b))
/** 按 dp 位小数取整（缺省向零截断，数量规则：§1.3「数量一律向零截断」）。 */
export const roundDec = (a: string, dp: number, mode: RoundMode = 'trunc'): Decimal => asDecimal(str(roundFx(fx(a), dp, mode), dp))
/** 向零截断到 step 的整数倍（例：size 按 step = 0.001）。step 必须为正。 */
export function floorToStep(a: string, step: string): Decimal {
  const s = fx(step)
  if (s <= 0n) throw new RangeError('step must be positive')
  const x = fx(a)
  return asDecimal(str((x / s) * s))
}
