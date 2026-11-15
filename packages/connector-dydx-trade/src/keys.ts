// SPDX-License-Identifier: CPAL-1.0
// 密钥与地址：从 32 字节私钥派生 Cosmos/dYdX 地址，并用 Node 内置 crypto 做 secp256k1 ECDSA 签名。
// 零第三方依赖：只用 node:crypto（OpenSSL 提供 secp256k1 曲线运算），公钥由 OpenSSL 从 PKCS#8 派生，本包不做曲线数学。
// 地址口径（Cosmos / dYdX）：bech32('dydx', ripemd160(sha256(压缩公钥 33 字节)))，与 cosmjs
//   packages/amino/src/addresses.ts 的 rawSecp256k1PubkeyToRawAddress 一致（v4-client-js 用 DirectSecp256k1HdWallet）。
// 设计参照（只借「私钥 → 地址 → 签名」的步骤与检查项，代码从零写）：nautilus_trader crates/adapters/dydx/src/execution/wallet.rs@55c0e820。
//
// 私钥只在构造期进入，之后存在 `#` 私有字段里；任何导出（JSON.stringify / util.inspect / toString）都拿不到它。
import { createHash, createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto'
import { bech32Encode } from './bech32'
import { BECH32_PREFIX, OID_EC_PUBLIC_KEY, OID_SECP256K1, SECP256K1_N } from './constants'

/** dYdX / Cosmos 账户地址（bech32，'dydx1...'）。 */
export type DydxAddress = `dydx1${string}`

export interface SigningKeyInfo {
  /** bech32 地址（dydx1…）。 */
  address: DydxAddress
  /** 33 字节压缩公钥（Cosmos secp256k1.PubKey.key）。 */
  publicKey: Uint8Array
}

/** 小写十六进制（不带 0x）。 */
export function toHex(b: Uint8Array): string {
  let s = ''
  for (const x of b) s += x.toString(16).padStart(2, '0')
  return s
}

export function fromHex(h: string): Uint8Array {
  const clean = h.startsWith('0x') || h.startsWith('0X') ? h.slice(2) : h
  if (clean.length % 2 !== 0) throw new TypeError('hex string must have an even length')
  if (!/^[0-9a-fA-F]*$/.test(clean)) throw new TypeError('hex string contains non-hex characters')
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  return out
}

/** 把 32 字节裸私钥包成 PKCS#8 DER（ECPrivateKey 内嵌 + secp256k1 OID），交给 OpenSSL。 */
export function pkcs8FromRawKey(raw: Uint8Array): Uint8Array {
  if (raw.length !== 32) throw new TypeError(`secp256k1 private key must be 32 bytes, got ${raw.length}`)
  let n = 0n
  for (const b of raw) n = (n << 8n) | BigInt(b)
  if (n === 0n || n >= SECP256K1_N) throw new TypeError('private key out of range for secp256k1')

  // ECPrivateKey ::= SEQUENCE { version 1, privateKey OCTET STRING, [0] parameters OID secp256k1 }
  const ecInner = concat([
    fromHex('302e0201010420'), raw, fromHex('a0070605' + OID_SECP256K1),
  ])
  // PKCS#8 ::= SEQUENCE { version 0, AlgorithmIdentifier { ecPublicKey, secp256k1 }, privateKey OCTET STRING }
  const algorithm = fromHex('30100607' + OID_EC_PUBLIC_KEY + '0605' + OID_SECP256K1)
  const body = concat([fromHex('020100'), algorithm, derLength(0x04, ecInner.length), ecInner])
  return concat([derLength(0x30, body.length), body])
}

function derLength(tag: number, len: number): Uint8Array {
  if (len < 0x80) return new Uint8Array([tag, len])
  if (len < 0x100) return new Uint8Array([tag, 0x81, len])
  return new Uint8Array([tag, 0x82, (len >> 8) & 0xff, len & 0xff])
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((s, p) => s + p.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

/** 由 32 字节私钥生成签名器（持有 KeyObject，私钥字节用完即弃）。 */
export class DydxSigner {
  readonly info: SigningKeyInfo
  readonly #key: KeyObject
  readonly #publicKey: KeyObject

  constructor(privateKeyHex: string) {
    if (typeof privateKeyHex !== 'string' || privateKeyHex.length === 0) {
      throw new TypeError('a 32-byte secp256k1 private key (hex) is required to sign dYdX transactions')
    }
    const raw = fromHex(privateKeyHex)
    const der = pkcs8FromRawKey(raw)
    this.#key = createPrivateKey({ key: Buffer.from(der), format: 'der', type: 'pkcs8' })
    this.#publicKey = createPublicKey(this.#key)
    const jwk = this.#publicKey.export({ format: 'jwk' }) as { x?: string; y?: string }
    if (typeof jwk.x !== 'string' || typeof jwk.y !== 'string') throw new Error('derived public key has no affine coordinates')
    const x = b64urlToBytes(jwk.x)
    const y = b64urlToBytes(jwk.y)
    if (x.length !== 32 || y.length !== 32) throw new Error('derived public key coordinates are not 32 bytes')
    const compressed = new Uint8Array(33)
    // 压缩前缀看 Y 的最后一个字节的最低位（Y 是 32 字节，末字节下标 31）
    compressed[0] = (y[31]! & 1) === 1 ? 0x03 : 0x02
    compressed.set(x, 1)
    this.info = { address: addressFromPublicKey(compressed), publicKey: compressed }
  }

  /** 地址（bech32）。 */
  get address(): DydxAddress {
    return this.info.address
  }

  /**
   * 签名（Cosmos 口径）：signature = secp256k1_ecdsa(sha256(message))，64 字节 r||s，低 S 归一化。
   * 调用方传的是**被签原文**（dYdX 是 SignDoc 的 proto 字节），不是摘要——Node 的 ECDSA 必须带摘要算法，
   * 传 null 会让 OpenSSL 再套一层默认摘要（实测 sha256），结果链上验不过；这一条踩过，写死在这里。
   * 注意：node:crypto 走 OpenSSL 的随机 k（非 RFC6979），同一消息两次签名不同字节但都有效——测试验签不比对字节。
   */
  signMessage(message: Uint8Array): Uint8Array {
    return normalizeLowS(new Uint8Array(sign('sha256', Buffer.from(message), { key: this.#key, dsaEncoding: 'ieee-p1363' })))
  }

  /** 用自己的公钥验签（自查；生产由链上节点验）。 */
  verifyMessage(message: Uint8Array, signature: Uint8Array): boolean {
    return verifySha256(message, signature, this.info.publicKey)
  }
}

/** 用 33 字节压缩公钥对「SHA-256(消息)」验签；公钥不合法返回 false。 */
export function verifySha256(message: Uint8Array, signature: Uint8Array, compressedPubKey: Uint8Array): boolean {
  if (signature.length !== 64 || compressedPubKey.length !== 33) return false
  if (compressedPubKey[0] !== 0x02 && compressedPubKey[0] !== 0x03) return false
  try {
    const spki = concat([fromHex('3036301006072a8648ce3d020106052b8104000a032200'), compressedPubKey])
    const key = createPublicKey({ key: Buffer.from(spki), format: 'der', type: 'spki' })
    return verify('sha256', Buffer.from(message), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature))
  } catch {
    return false
  }
}

function normalizeLowS(sig: Uint8Array): Uint8Array {
  const s = bytesToBigInt(sig.subarray(32))
  if (s <= SECP256K1_N / 2n) return sig
  const out = Uint8Array.from(sig)
  out.set(bigIntToBytes(SECP256K1_N - s, 32), 32)
  return out
}

/** base64url（JWK 坐标编码）→ 32 字节。 */
function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/')
  return new Uint8Array(Buffer.from(b64, 'base64'))
}

function bytesToBigInt(b: Uint8Array): bigint {
  let n = 0n
  for (const x of b) n = (n << 8n) | BigInt(x)
  return n
}

function bigIntToBytes(n: bigint, len: number): Uint8Array {
  const out = new Uint8Array(len)
  let v = n
  for (let i = len - 1; i >= 0; i -= 1) {
    out[i] = Number(v & 0xffn)
    v >>= 8n
  }
  return out
}

/**
 * 由公钥（压缩 33 字节）算 bech32 地址：bech32('dydx', ripemd160(sha256(公钥)))。
 * 先用 createPublicKey 校验曲线点合法（非法 SPKI 会抛错），再对 33 字节原样做哈希。
 */
export function addressFromPublicKey(compressedPubKey: Uint8Array): DydxAddress {
  if (compressedPubKey.length !== 33) throw new TypeError('compressed public key must be 33 bytes')
  const prefix = compressedPubKey[0]
  if (prefix !== 0x02 && prefix !== 0x03) throw new TypeError('compressed public key must start with 0x02 or 0x03')
  const spki = concat([fromHex('3036301006072a8648ce3d020106052b8104000a032200'), compressedPubKey])
  createPublicKey({ key: Buffer.from(spki), format: 'der', type: 'spki' })
  const sha = new Uint8Array(createHash('sha256').update(Buffer.from(compressedPubKey)).digest())
  const hash160 = new Uint8Array(createHash('ripemd160').update(Buffer.from(sha)).digest())
  return bech32Encode(BECH32_PREFIX, hash160) as DydxAddress
}
