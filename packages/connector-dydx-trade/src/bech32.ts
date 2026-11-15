// SPDX-License-Identifier: CPAL-1.0
// bech32（BIP-173 原版校验和，不是 bech32m）。Cosmos / dYdX 地址用 bech32，HRP = 'dydx'。
// 只用字符串与数组，不依赖 Buffer。向量见 test/bech32.test.ts（BIP-173 官方测试集）。
const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]

function polymod(values: readonly number[]): number {
  let chk = 1
  for (const v of values) {
    const top = chk >>> 25
    chk = ((chk & 0x1ffffff) << 5) ^ v
    for (let i = 0; i < 5; i += 1) {
      if (((top >>> i) & 1) === 1) chk ^= GENERATOR[i]!
    }
  }
  return chk >>> 0
}

function hrpExpand(hrp: string): number[] {
  const out: number[] = []
  for (let i = 0; i < hrp.length; i += 1) out.push(hrp.charCodeAt(i) >> 5)
  out.push(0)
  for (let i = 0; i < hrp.length; i += 1) out.push(hrp.charCodeAt(i) & 31)
  return out
}

function createChecksum(hrp: string, data: readonly number[]): number[] {
  const values = [...hrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0]
  const mod = polymod(values) ^ 1
  const out: number[] = []
  for (let p = 0; p < 6; p += 1) out.push((mod >>> (5 * (5 - p))) & 31)
  return out
}

/** 8 bit → 5 bit（BIP-173 convertbits，pad = true）。 */
export function toWords(bytes: Uint8Array): number[] {
  const out: number[] = []
  let acc = 0
  let bits = 0
  for (const b of bytes) {
    acc = (acc << 8) | b
    bits += 8
    while (bits >= 5) {
      bits -= 5
      out.push((acc >>> bits) & 31)
    }
  }
  if (bits > 0) out.push((acc << (5 - bits)) & 31)
  return out
}

/** 5 bit → 8 bit；末尾填充位非零或超过 4 bit 时返回 null（严格解码）。 */
export function fromWords(words: readonly number[]): Uint8Array | null {
  const out: number[] = []
  let acc = 0
  let bits = 0
  for (const w of words) {
    if (w < 0 || w > 31) return null
    acc = (acc << 5) | w
    bits += 5
    if (bits >= 8) {
      bits -= 8
      out.push((acc >>> bits) & 0xff)
    }
  }
  if (bits >= 5) return null
  if (((acc << (8 - bits)) & 0xff) !== 0) return null
  return new Uint8Array(out)
}

/** 编码：hrp + '1' + data + 6 位校验和。总长上限 90（BIP-173）。 */
export function bech32Encode(hrp: string, bytes: Uint8Array): string {
  const lower = hrp.toLowerCase()
  if (!/^[a-z0-9]+$/.test(lower)) throw new TypeError(`invalid bech32 hrp: ${hrp}`)
  const data = toWords(bytes)
  const combined = [...data, ...createChecksum(lower, data)]
  let out = `${lower}1`
  for (const v of combined) out += CHARSET[v]!
  if (out.length > 90) throw new TypeError('bech32 string exceeds 90 characters')
  return out
}

export interface Bech32Decoded { hrp: string; bytes: Uint8Array }

/** 解码并校验和；任何不合规（大小写混用、长度、校验和、填充位）都返回 null。 */
export function bech32Decode(input: string): Bech32Decoded | null {
  if (input.length < 8 || input.length > 90) return null
  const hasLower = /[a-z]/.test(input)
  const hasUpper = /[A-Z]/.test(input)
  if (hasLower && hasUpper) return null
  const s = input.toLowerCase()
  const sep = s.lastIndexOf('1')
  if (sep < 1 || sep + 7 > s.length) return null
  const hrp = s.slice(0, sep)
  const data: number[] = []
  for (const ch of s.slice(sep + 1)) {
    const v = CHARSET.indexOf(ch)
    if (v < 0) return null
    data.push(v)
  }
  if (polymod([...hrpExpand(hrp), ...data]) !== 1) return null
  const bytes = fromWords(data.slice(0, -6))
  if (bytes === null) return null
  return { hrp, bytes }
}
