// SPDX-License-Identifier: CPAL-1.0
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { canonicalize } from '../proto'
import type { Sha256Digest } from '../proto'

export const sha256Hex = (utf8: string | Uint8Array): string => createHash('sha256').update(utf8).digest('hex')
export const sha256Digest = (utf8: string | Uint8Array): Sha256Digest => `sha256:${sha256Hex(utf8)}`
/** `sha256:` + SHA-256(JCS(value))。 */
export const digestOf = (value: unknown): Sha256Digest => sha256Digest(canonicalize(value))
export const hmacHex = (key: Uint8Array | string, data: string): string => createHmac('sha256', key).update(data).digest('hex')

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
/** RFC 4648 base32，大写，无填充；32 字节 → 52 个字符。 */
export function base32(bytes: Uint8Array): string {
  let bits = 0, value = 0, out = ''
  for (const b of bytes) {
    value = (value << 8) | b
    bits += 8
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5 }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31]
  return out
}
export const randomToken = (prefix: string, bytes = 32): string => `${prefix}${base32(randomBytes(bytes))}`
