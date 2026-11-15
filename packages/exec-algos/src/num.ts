// SPDX-License-Identifier: CPAL-1.0
// 包内定点小工具：规范输出、按 step 取整、入参校验。算术全走 @gitrader/protocol/decimal，不碰 JS 浮点加减。
import { fx, str, type Fx } from '@gitrader/protocol/decimal'

/** 规范十进制字符串（无指数、无尾随 0、零写 "0"）。 */
export function canonical(x: string): string {
  return str(fx(x))
}

/** 解析并要求正值；不合规抛 RangeError。 */
export function positiveFx(label: string, x: string): Fx {
  const v = fx(x)
  if (v <= 0n) throw new RangeError(`${label} must be positive: ${JSON.stringify(x)}`)
  return v
}

/** 解析并要求非负值；不合规抛 RangeError。 */
export function nonNegativeFx(label: string, x: string): Fx {
  const v = fx(x)
  if (v < 0n) throw new RangeError(`${label} must not be negative: ${JSON.stringify(x)}`)
  return v
}

/** 有限数校验（bps / 毫秒 / now 这类入参）；不合规抛 RangeError。 */
export function requireFinite(label: string, n: number): number {
  if (!Number.isFinite(n)) throw new RangeError(`${label} must be a finite number: ${String(n)}`)
  return n
}

/**
 * 按 step 取整：floor 向负无穷、ceil 向正无穷、trunc 向零。x 与 step 都已是 scale 18 的定点值。
 * 结果一定是 step 的整数倍，且与 x 的误差小于一个 step。
 */
export function roundToStep(x: Fx, step: Fx, mode: 'floor' | 'ceil' | 'trunc'): Fx {
  if (step <= 0n) throw new RangeError('step must be positive')
  const q = x / step // bigint 除法向零
  const r = x - q * step
  if (r === 0n) return x
  switch (mode) {
    case 'trunc':
      return q * step
    case 'floor':
      return (x < 0n ? q - 1n : q) * step
    case 'ceil':
      return (x > 0n ? q + 1n : q) * step
  }
}
