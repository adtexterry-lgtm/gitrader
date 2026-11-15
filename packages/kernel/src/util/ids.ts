// SPDX-License-Identifier: CPAL-1.0
import { randomBytes, randomUUID } from 'node:crypto'
import type { IdPrefix } from '../proto'

const C32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
let lastMs = 0
let lastRand: Uint8Array = new Uint8Array(10)

/** ULID（26 位 Crockford base32）；同一毫秒内单调递增。 */
export function ulid(now = Date.now()): string {
  let rand: Uint8Array
  if (now <= lastMs) {
    now = lastMs
    rand = lastRand.slice()
    for (let i = 9; i >= 0; i--) { rand[i] = ((rand[i] as number) + 1) & 255; if (rand[i] !== 0) break }
  } else {
    rand = randomBytes(10)
  }
  lastMs = now
  lastRand = rand
  let t = ''
  let ms = now
  for (let i = 0; i < 10; i++) { t = C32[ms % 32] + t; ms = Math.floor(ms / 32) }
  let r = ''
  let bits = 0, acc = 0
  for (const b of rand) {
    acc = (acc << 8) | b
    bits += 8
    while (bits >= 5) { r += C32[(acc >>> (bits - 5)) & 31]; bits -= 5; acc &= (1 << bits) - 1 }
  }
  return t + r
}

export const newId = <P extends IdPrefix>(prefix: P, now?: number): `${P}_${string}` => `${prefix}_${ulid(now)}`
export const newRequestId = (): string => randomUUID()
/** 32 位小写十六进制（16 字节）。 */
export const newClientOrderId = (): string => randomBytes(16).toString('hex')
