// SPDX-License-Identifier: CPAL-1.0
// 测试用签名器：@noble/curves + EIP-712 哈希，只在测试里存在，产品代码不带它。
// 密钥一律用 randomSecretKey() 现生成、只放内存，不落盘。唯一例外是签名对拍用的官方 SDK 公开测试向量密钥（见 signing.test.ts）。
import { keccak_256 } from '@noble/hashes/sha3.js'
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import type { SignerHandle } from '@gitrader/protocol/connector'

type Field = { name: string; type: string }
type Types = Record<string, readonly Field[]>

const pad32 = (b: Uint8Array): Uint8Array => concatBytes(new Uint8Array(32 - b.length), b)
const bigTo32 = (n: bigint): Uint8Array => hexToBytes(n.toString(16).padStart(64, '0'))

function encodeType(primary: string, types: Types): string {
  const deps = new Set<string>()
  const walk = (t: string) => {
    const base = t.replace(/\[\]$/, '')
    if (!types[base] || deps.has(base)) return
    deps.add(base)
    for (const f of types[base]!) walk(f.type)
  }
  walk(primary)
  deps.delete(primary)
  const order = [primary, ...[...deps].sort()]
  return order.map((n) => `${n}(${types[n]!.map((f) => `${f.type} ${f.name}`).join(',')})`).join('')
}

function encodeValue(type: string, value: unknown, types: Types): Uint8Array {
  if (types[type]) return hashStruct(type, value as Record<string, unknown>, types)
  if (type === 'string') return keccak_256(utf8ToBytes(String(value)))
  if (type === 'bytes') return keccak_256(hexToBytes(String(value).replace(/^0x/, '')))
  if (type === 'bytes32') return pad32Right(hexToBytes(String(value).replace(/^0x/, '')))
  if (type === 'address') return pad32(hexToBytes(String(value).replace(/^0x/, '').padStart(40, '0')))
  if (type === 'bool') return bigTo32(value ? 1n : 0n)
  if (/^u?int\d*$/.test(type)) {
    let n = BigInt(value as string | number | bigint)
    if (n < 0n) n = (1n << 256n) + n
    return bigTo32(n)
  }
  throw new Error(`unsupported EIP-712 type ${type}`)
}
const pad32Right = (b: Uint8Array): Uint8Array => concatBytes(b, new Uint8Array(32 - b.length))

function hashStruct(name: string, message: Record<string, unknown>, types: Types): Uint8Array {
  const typeHash = keccak_256(utf8ToBytes(encodeType(name, types)))
  return keccak_256(concatBytes(typeHash, ...types[name]!.map((f) => encodeValue(f.type, message[f.name], types))))
}

export interface TypedDataParams {
  domain: Record<string, unknown>
  types: Types
  primaryType: string
  message: Record<string, unknown>
}

export function hashTypedData(p: TypedDataParams): Uint8Array {
  const domainTypes: Field[] = [
    ...(p.domain.name !== undefined ? [{ name: 'name', type: 'string' }] : []),
    ...(p.domain.version !== undefined ? [{ name: 'version', type: 'string' }] : []),
    ...(p.domain.chainId !== undefined ? [{ name: 'chainId', type: 'uint256' }] : []),
    ...(p.domain.verifyingContract !== undefined ? [{ name: 'verifyingContract', type: 'address' }] : []),
  ]
  const all: Types = { EIP712Domain: domainTypes, ...p.types }
  const domainSep = hashStruct('EIP712Domain', p.domain, all)
  return keccak_256(concatBytes(new Uint8Array([0x19, 0x01]), domainSep, hashStruct(p.primaryType, p.message, all)))
}

export function addressOf(secretKey: Uint8Array): `0x${string}` {
  const pub = secp256k1.getPublicKey(secretKey, false) // 65 字节，0x04 开头
  return `0x${bytesToHex(keccak_256(pub.slice(1)).slice(12))}`
}

export function recoverAddress(hash: Uint8Array, sigHex: string): `0x${string}` {
  const sig = hexToBytes(sigHex.replace(/^0x/, ''))
  const v = sig[64]! >= 27 ? sig[64]! - 27 : sig[64]!
  const rec = concatBytes(new Uint8Array([v]), sig.slice(0, 64))
  const pub = secp256k1.recoverPublicKey(rec, hash, { prehash: false })
  const uncompressed = secp256k1.Point.fromBytes(pub).toBytes(false)
  return `0x${bytesToHex(keccak_256(uncompressed.slice(1)).slice(12))}`
}

export interface TestSigner extends SignerHandle {
  /** 记录收到的待签载荷（断言用）。 */
  readonly seen: TypedDataParams[]
  recover(params: TypedDataParams, sigHex: string): `0x${string}`
}

/** 用给定私钥（缺省随机）造一个 signTypedData 形状的签名器。 */
export function makeTestSigner(secretKey: Uint8Array = secp256k1.utils.randomSecretKey()): TestSigner {
  const seen: TypedDataParams[] = []
  const address = addressOf(secretKey)
  return {
    address,
    seen,
    async signTypedData(params) {
      seen.push(params as TypedDataParams)
      const hash = hashTypedData(params as TypedDataParams)
      const sig = secp256k1.sign(hash, secretKey, { prehash: false, format: 'recovered' }) // [recovery, r, s]
      const rs = sig.slice(1)
      return `0x${bytesToHex(rs)}${(27 + sig[0]!).toString(16)}`
    },
    recover: (params, sigHex) => recoverAddress(hashTypedData(params), sigHex),
  }
}
