// SPDX-License-Identifier: CPAL-1.0
// 浮点数 → sim-book 能收的十进制文本（scale 18 定点语法，不收指数形态）。
// sim-book 的记录与订单只收 /^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/，String(1e-7) 会给出 "1e-7"，
// 所以这里统一走定点格式化并去掉尾随零。
import { FillModeError } from './types'

/** 最大可表示数量：再大就没有 18 位小数的定点表示，直接报错而不是悄悄截断。 */
const MAX = 1e21

export function toDecimalText(x: number): string {
  if (!Number.isFinite(x)) throw new FillModeError('invalid_qty', `数量不是有限数：${String(x)}`)
  if (x < 0) throw new FillModeError('invalid_qty', `数量必须为非负数：${String(x)}`)
  if (x === 0) return '0'
  if (x >= MAX) throw new FillModeError('invalid_qty', `数量超出定点表示范围：${String(x)}`)
  if (Number.isInteger(x)) return String(x)
  const fixed = x.toFixed(18).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')
  // 小于 1e-18 的量格式化后是 0：这类数量在盘口上无法成交，报错而不是按 0 处理
  if (fixed === '0') throw new FillModeError('invalid_qty', `数量小于仿真精度（1e-18）：${String(x)}`)
  return fixed
}
