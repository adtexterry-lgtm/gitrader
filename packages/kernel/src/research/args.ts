// SPDX-License-Identifier: CPAL-1.0
// research 工具的入参小工具（内核侧）。
import { makeProblem } from '../proto'
import { KernelError } from '../util/errors'

export const bad = (message: string): KernelError => new KernelError(makeProblem('INVALID_PARAMS', message))

export function needString(v: unknown, name: string): string {
  if (typeof v !== 'string' || v === '') throw bad(`${name} is required`)
  return v
}

/** 整数入参：没给取默认；给了必须是 1..max 的整数。 */
export function positiveInt(v: unknown, def: number, max: number): number {
  if (v === undefined || v === null) return def
  const n = Number(v)
  if (!Number.isInteger(n) || n < 1 || n > max) throw bad(`limit must be an integer in [1, ${max}]`)
  return n
}

/** 偏移游标分页：cursor 是十进制偏移；越界当非法游标。 */
export function page(total: number, cursor: unknown, limit: number): { from: number; to: number } {
  const from = cursor === undefined || cursor === null || cursor === '' ? 0 : Number(cursor)
  if (!Number.isInteger(from) || from < 0 || from > total) throw bad('cursor is not valid')
  return { from, to: Math.min(total, from + limit) }
}
