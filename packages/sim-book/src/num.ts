// SPDX-License-Identifier: CPAL-1.0
// 包内定点小工具：十进制文本的语法校验与规范输出。算术一律走 @gitrader/protocol/decimal（scale 18 定点），不碰 JS 浮点。
import { ZERO, cmp, fx, str, type Fx } from '@gitrader/protocol/decimal'

/**
 * 记录与订单里的价格 / 数量只收十进制文本：可选负号、整数部分不带多余前导零、可选小数。
 * 不收指数（1e-8）、千分位、正号——这些形态会被协议 decimal 悄悄接受，但在 JSONL 记录里是歧义来源。
 */
export const DECIMAL_TEXT = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/

export function isDecimalText(value: unknown): value is string {
  return typeof value === 'string' && DECIMAL_TEXT.test(value)
}

/** 解析十进制文本；语法不对抛 TypeError。 */
export function parseDecimal(value: string, field: string): Fx {
  if (!isDecimalText(value)) throw new TypeError(`${field} 不是十进制文本：${JSON.stringify(value)}`)
  return fx(value)
}

/** 必须 > 0 的数值（数量、价格）。 */
export function parsePositive(value: string, field: string): Fx {
  const x = parseDecimal(value, field)
  if (x <= ZERO) throw new RangeError(`${field} 必须为正数：${value}`)
  return x
}

/** 价格的解析规则与数量一致（0 价档位在撮合里没有意义，一律拒绝）。 */
export const parsePrice = parsePositive

/** 规范输出：scale 18 定点转十进制文本，去掉尾随零。 */
export const fmtDecimal = (x: Fx): string => str(x)

/** 价格档位的归一化键：100.10 与 100.1 是同一档。 */
export const priceKey = (x: Fx): string => str(x)

export const minFx = (a: Fx, b: Fx): Fx => (a <= b ? a : b)

export const lte = (a: Fx, b: Fx): boolean => cmp(a, b) <= 0

export const gte = (a: Fx, b: Fx): boolean => cmp(a, b) >= 0
