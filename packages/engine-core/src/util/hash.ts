// SPDX-License-Identifier: CPAL-1.0
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { Candle, Sha256Digest } from '../proto'

export const sha256Hex = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex')
export const sha256Digest = (data: string | Uint8Array): Sha256Digest => `sha256:${sha256Hex(data)}`

/**
 * 键排序后的 JSON：同一对象永远得到同一串（用于 specDigest 与幂等 id）。
 *
 * 非有限数字必须与 null 区分开（审计 L4-08）：`JSON.stringify` 把 NaN / ±Infinity 都写成 `null`，
 * 于是"价格为 NaN 的 K 线"和"价格为 null 的 K 线"摘要相同。这里给它们各自的显式标记
 * （对象形式的标记不会与字符串 `"NaN"` 撞车），`-0` 也保留符号，`0` 与 `-0` 可区分。
 */
export function stableStringify(v: unknown): string {
  if (typeof v === 'number') {
    if (Number.isNaN(v)) return '{"$num":"NaN"}'
    if (v === Infinity) return '{"$num":"+Inf"}'
    if (v === -Infinity) return '{"$num":"-Inf"}'
    if (Object.is(v, -0)) return '-0'          // JSON 数字文本，但不是 "0"
    return JSON.stringify(v)
  }
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null'
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`
  const o = v as Record<string, unknown>
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(',')}}`
}

/** K 线序列摘要：把 t/o/h/l/c/v 打成 Float64 二进制再哈希（52 万根也只要几十毫秒）。 */
export function candlesDigest(candles: readonly Candle[]): Sha256Digest {
  const buf = new Float64Array(candles.length * 6)
  let k = 0
  for (const c of candles) { buf[k++] = c.t; buf[k++] = c.o; buf[k++] = c.h; buf[k++] = c.l; buf[k++] = c.c; buf[k++] = c.v }
  return sha256Digest(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength))
}

const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
/** `<前缀>_<26 位 ULID>`。 */
export function newId(prefix: string, now = Date.now()): string {
  let t = now
  let time = ''
  for (let i = 0; i < 10; i++) { time = B32[t % 32] + time; t = Math.floor(t / 32) }
  const r = randomBytes(16)
  let rand = ''
  for (let i = 0; i < 16; i++) rand += B32[r[i]! % 32]
  return `${prefix}_${time}${rand}`
}

export const newRequestId = (): string => randomUUID()
