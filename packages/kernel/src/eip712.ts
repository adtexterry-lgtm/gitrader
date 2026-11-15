// SPDX-License-Identifier: CPAL-1.0
// EIP-712 类型化数据哈希 + secp256k1 签名（只有 signTypedData 一个形状，viem / @nktkas/hyperliquid 的钱包对象就是它）。
// 密码学原语全部来自 @noble/curves + @noble/hashes（审计过的库）；这里只做 EIP-712 的编码（规范文本里的 encodeType / encodeData），
// 并用规范自带的 Mail 示例向量对拍（test/eip712.test.ts）。HL 动作签名向量对拍由连接器包做（C）。
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { keccak_256 } from '@noble/hashes/sha3.js'
import { bytesToHex, hexToBytes, utf8ToBytes, concatBytes } from '@noble/hashes/utils.js'

export interface TypedDataField { name: string; type: string }
export interface TypedData {
  domain: Record<string, unknown>
  types: Record<string, TypedDataField[]>
  primaryType: string
  message: Record<string, unknown>
}

const DOMAIN_FIELDS: [string, string][] = [['name', 'string'], ['version', 'string'], ['chainId', 'uint256'], ['verifyingContract', 'address'], ['salt', 'bytes32']]

function typesWithDomain(td: TypedData): Record<string, TypedDataField[]> {
  if (td.types.EIP712Domain) return td.types
  const fields = DOMAIN_FIELDS.filter(([n]) => td.domain[n] !== undefined).map(([name, type]) => ({ name, type }))
  return { ...td.types, EIP712Domain: fields }
}

function deps(primary: string, types: Record<string, TypedDataField[]>, found = new Set<string>()): Set<string> {
  const base = primary.replace(/\[\d*\]$/, '')
  if (found.has(base) || !types[base]) return found
  found.add(base)
  for (const f of types[base] as TypedDataField[]) deps(f.type, types, found)
  return found
}

function encodeType(primary: string, types: Record<string, TypedDataField[]>): string {
  const d = deps(primary, types)
  d.delete(primary)
  const order = [primary, ...[...d].sort()]
  return order.map((t) => `${t}(${(types[t] as TypedDataField[]).map((f) => `${f.type} ${f.name}`).join(',')})`).join('')
}

const hashType = (primary: string, types: Record<string, TypedDataField[]>): Uint8Array => keccak_256(utf8ToBytes(encodeType(primary, types)))

function toBigInt(v: unknown): bigint {
  if (typeof v === 'bigint') return v
  if (typeof v === 'number') { if (!Number.isInteger(v)) throw new TypeError(`not an integer: ${v}`); return BigInt(v) }
  if (typeof v === 'string') return BigInt(v)
  throw new TypeError(`cannot convert ${typeof v} to integer`)
}
const pad32 = (b: Uint8Array, left: boolean): Uint8Array => {
  if (b.length > 32) throw new RangeError('value longer than 32 bytes')
  const out = new Uint8Array(32)
  out.set(b, left ? 32 - b.length : 0)
  return out
}
const hex = (v: unknown): Uint8Array => {
  if (v instanceof Uint8Array) return v
  if (typeof v !== 'string') throw new TypeError('expected hex string')
  const s = v.startsWith('0x') || v.startsWith('0X') ? v.slice(2) : v
  return hexToBytes(s.length % 2 ? `0${s}` : s)
}

function encodeValue(type: string, value: unknown, types: Record<string, TypedDataField[]>): Uint8Array {
  const arr = /^(.*)\[(\d*)\]$/.exec(type)
  if (arr) {
    if (!Array.isArray(value)) throw new TypeError(`expected array for ${type}`)
    return keccak_256(concatBytes(...value.map((x) => encodeValue(arr[1] as string, x, types))))
  }
  if (types[type]) return hashStruct(type, value as Record<string, unknown>, types)
  if (type === 'string') return keccak_256(utf8ToBytes(String(value)))
  if (type === 'bytes') return keccak_256(hex(value))
  if (type === 'bool') return pad32(Uint8Array.of(value ? 1 : 0), true)
  if (type === 'address') return pad32(hex(value), true)
  const b = /^bytes(\d+)$/.exec(type)
  if (b) { const bytes = hex(value); if (bytes.length !== Number(b[1])) throw new RangeError(`${type} length mismatch`); return pad32(bytes, false) }
  const u = /^(u?)int(\d*)$/.exec(type)
  if (u) {
    const bits = u[2] ? Number(u[2]) : 256
    const n = toBigInt(value)
    const lo = u[1] ? 0n : -(1n << BigInt(bits - 1))
    const hi = u[1] ? (1n << BigInt(bits)) - 1n : (1n << BigInt(bits - 1)) - 1n
    if (n < lo || n > hi) throw new RangeError(`${type} out of range`)
    const twos = n < 0n ? (1n << 256n) + n : n
    return hexToBytes(twos.toString(16).padStart(64, '0'))
  }
  throw new TypeError(`unsupported EIP-712 type ${type}`)
}

function hashStruct(name: string, data: Record<string, unknown>, types: Record<string, TypedDataField[]>): Uint8Array {
  const fields = types[name]
  if (!fields) throw new TypeError(`unknown type ${name}`)
  return keccak_256(concatBytes(hashType(name, types), ...fields.map((f) => {
    if (!(f.name in data)) throw new TypeError(`missing field ${name}.${f.name}`)
    return encodeValue(f.type, data[f.name], types)
  })))
}

export function hashTypedData(td: TypedData): Uint8Array {
  const types = typesWithDomain(td)
  return keccak_256(concatBytes(Uint8Array.of(0x19, 0x01), hashStruct('EIP712Domain', td.domain, types), hashStruct(td.primaryType, td.message, types)))
}

/** r ‖ s ‖ v（v = 27 / 28），0x 前缀十六进制。 */
export function signDigest(digest: Uint8Array, privateKey: Uint8Array): string {
  const sig = secp256k1.sign(digest, privateKey, { prehash: false, format: 'recovered' }) // [recovery, r, s]
  const rec = sig[0] as number
  return `0x${bytesToHex(sig.slice(1, 65))}${(27 + rec).toString(16).padStart(2, '0')}`
}

export function signTypedDataWithKey(td: TypedData, privateKey: Uint8Array): { signature: string; digest: string } {
  const digest = hashTypedData(td)
  return { signature: signDigest(digest, privateKey), digest: `0x${bytesToHex(digest)}` }
}

/** EIP-55 校验和地址。 */
export function checksumAddress(raw20: Uint8Array): string {
  const lower = bytesToHex(raw20)
  const h = bytesToHex(keccak_256(utf8ToBytes(lower)))
  let out = '0x'
  for (let i = 0; i < lower.length; i++) out += parseInt(h[i] as string, 16) >= 8 ? (lower[i] as string).toUpperCase() : (lower[i] as string)
  return out
}

export function addressOf(privateKey: Uint8Array): string {
  return checksumAddress(keccak_256(secp256k1.getPublicKey(privateKey, false).slice(1)).slice(-20))
}

/** 从签名与摘要恢复地址（测试 / 对拍用）。 */
export function recoverAddress(digest: Uint8Array, signature: string): string {
  const raw = hexToBytes(signature.slice(2))
  const rec = (raw[64] as number) - 27
  const sig65 = concatBytes(Uint8Array.of(rec), raw.slice(0, 64))
  const pub = secp256k1.recoverPublicKey(sig65, digest, { prehash: false })
  return checksumAddress(keccak_256(secp256k1.Point.fromBytes(pub).toBytes(false).slice(1)).slice(-20))
}
