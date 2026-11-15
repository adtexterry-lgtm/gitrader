// SPDX-License-Identifier: CPAL-1.0
// 把引擎内部的 number 变成契约 §1.3 的规范十进制字符串，并按步长向零截断（§1.3 取整规则）。
import { normalizeDecimal, type Decimal } from '../proto'

/** number → 规范十进制字符串。不做科学计数；取 15 位有效数字（double 的可靠精度）。 */
export function decimalOf(x: number): Decimal {
  if (!Number.isFinite(x)) throw new TypeError(`not a finite number: ${String(x)}`)
  if (x === 0) return normalizeDecimal('0')
  return normalizeDecimal(x.toPrecision(15))
}

/**
 * 按小数位数向零截断到 `decimals` 位（数量取整规则）。纯字符串操作，不引入二次浮点误差。
 * 例：truncDecimals(0.123456789, 5) → "0.12345"。
 */
export function truncDecimals(x: number, decimals: number): Decimal {
  const [i, f = ''] = decimalOf(Math.abs(x)).split('.')
  const kept = f.slice(0, Math.max(0, decimals))
  const out = normalizeDecimal(kept === '' ? i! : `${i}.${kept}`)
  return x < 0 && out !== '0' ? normalizeDecimal(`-${out}`) : out
}

/**
 * 把数量按 step 向下取整到 step 的整数倍；负数按绝对值取整后补符号，即向零取整。
 * 若 |qty| 与最近整数倍的差 ≤ 4 ulp（Number.EPSILON·|qty|·4），就吸附到该整数倍，
 * 免得 0.30000000000000004 这类二进制噪声把整手数量截掉一手。step ≤ 0 或非有限 → 原值；
 * 结果 < minQty（给了的话）→ 0。
 *
 * 非有限 qty → RangeError（审计 L4-02 / 工单规则 2）：算不出来就显式报错，
 * 不许静默给一个 0（调用方会把它当成「决定了不成交」）。
 *
 * Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/strategy_v2/runtime.py:1233; adapted.
 * 与 QD 的差异：QD 的 `_round_to_lot` 对 |value|/lot_size 取 floor，与本实现的向零取整一致
 * （-0.25、step 0.1 → -0.2）；QD 另有 max(1e-12, 4·ulp(ratio)) 的绝对值下限，这里只按 4 ulp。
 */
export function normalizeLot(qty: number, step: number, minQty?: number): number {
  if (!Number.isFinite(qty)) throw new RangeError(`normalizeLot: qty is not a finite number (${String(qty)})`)
  if (!Number.isFinite(step) || step <= 0) return qty
  const ratio = Math.abs(qty) / step
  const nearest = Math.round(ratio)
  const tol = Number.EPSILON * Math.abs(qty) * 4
  const units = Math.abs(Math.abs(qty) - nearest * step) <= tol ? nearest : Math.floor(ratio)
  const raw = units * step
  // 去掉 units·step 自带的二进制噪声，但只在 4 ulp 内动手，别改到大数/高精度步长的真值。
  const cleaned = Number(raw.toPrecision(15))
  const magnitude = Math.abs(cleaned - raw) <= Number.EPSILON * Math.abs(raw) * 4 ? cleaned : raw
  if (magnitude === 0) return 0
  const value = qty < 0 ? -magnitude : magnitude
  if (minQty !== undefined && value < minQty) return 0
  return value
}

/** 按步长（如 "0.001"、"0.5"）向零截断到步长的整数倍。纯整数运算，无浮点误差。 */
export function truncToStep(x: number, step: string): Decimal {
  const k = step.includes('.') ? step.split('.')[1]!.length : 0
  const toInt = (d: string): bigint => {
    const [i, f = ''] = d.split('.')
    return BigInt(i + f.padEnd(k, '0'))
  }
  const stepInt = toInt(step)
  if (stepInt <= 0n) return truncDecimals(x, k)
  const t = truncDecimals(Math.abs(x), k)
  const q = (toInt(t) / stepInt) * stepInt
  const s = q.toString().padStart(k + 1, '0')
  const out = normalizeDecimal(k > 0 ? `${s.slice(0, -k)}.${s.slice(-k)}` : s)
  return x < 0 && out !== '0' ? normalizeDecimal(`-${out}`) : out
}

/** 对外 JSON 数值取 15 位有效数字，去掉二进制尾差（0.10600000000000001 → 0.106）；非有限数原样返回。 */
export function roundOut(x: number): number {
  return Number.isFinite(x) ? Number(x.toPrecision(15)) : x
}
