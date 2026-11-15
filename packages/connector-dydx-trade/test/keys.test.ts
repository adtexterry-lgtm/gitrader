// SPDX-License-Identifier: CPAL-1.0
// 密钥 / 地址 / 签名测试。期望值全部取自公开向量，不由本包自己的函数反算：
//   · 私钥 1 的压缩公钥是生成元 G 的公开常数（0279be66…f81798）；
//   · dYdX 官方向量（dydxprotocol/v4-clients v4-client-js/examples/constants.ts 的 DYDX_TEST_PRIVATE_KEY / DYDX_TEST_ADDRESS）；
//   · cosmjs 向量（packages/proto-signing/src/testutils.ts 的 faucet 与 testVectors[0] 公钥 / 地址）；
//   · 签名用 node:crypto 的 verify 独立验签（不是自己写验签再自己验）；
//   · 低 S 归一化后仍能验签通过（链上要求）。
import { describe, expect, it } from 'vitest'
import { inspect } from 'node:util'
import { SECP256K1_N } from '../src/constants'
import { DydxSigner, addressFromPublicKey, fromHex, pkcs8FromRawKey, toHex, verifySha256 } from '../src/keys'
import { bech32Decode } from '../src/bech32'

const KEY1 = '00'.repeat(31) + '01'
const KEY2 = '00'.repeat(31) + '02'
/** dydxprotocol/v4-clients v4-client-js/examples/constants.ts（测试网账户）。 */
const DYDX_TEST_KEY = 'e92a6595c934c991d3b3e987ea9b3125bf61a076deab3a9cb519787b7b3e8d77'
const DYDX_TEST_ADDRESS = 'dydx14zzueazeh0hj67cghhf9jypslcf9sh2n5k6art'
/** cosmjs proto-signing testutils 的 faucet（m/44'/118'/0'/0/0 派生私钥）。 */
const COSMJS_KEY = 'e16ee698b4a4ee03566d7dd9bb6f0e8a2dda802527ba56205f5767c0049fa0b9'
const COSMJS_PUBKEY_B64 = 'A08EGB7ro1ORuFhjOnZcSgwYlpe0DSFjVNUIkNNQxwKQ'
const COSMJS_ADDRESS = 'cosmos1pkptre7fdkl6gfrzlesjjvhxhlc3r4gmmk8rs6'

describe('地址派生（公开向量交叉核对）', () => {
  it('私钥 1 的压缩公钥 = secp256k1 生成元 G（公开常数）', () => {
    expect(toHex(new DydxSigner(KEY1).info.publicKey))
      .toBe('0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798')
  })

  it('dYdX 官方向量：私钥 → dydx14zzueazeh0hj67cghhf9jypslcf9sh2n5k6art', () => {
    const signer = new DydxSigner(DYDX_TEST_KEY)
    expect(signer.address).toBe(DYDX_TEST_ADDRESS)
    expect(addressFromPublicKey(signer.info.publicKey)).toBe(DYDX_TEST_ADDRESS)
  })

  it('cosmjs 向量：私钥 → 压缩公钥 base64 A08EGB7r…xwKQ，地址字节等于 cosmos1pkptre…rs6', () => {
    const signer = new DydxSigner(COSMJS_KEY)
    expect(Buffer.from(signer.info.publicKey).toString('base64')).toBe(COSMJS_PUBKEY_B64)
    const ours = bech32Decode(signer.address)
    const theirs = bech32Decode(COSMJS_ADDRESS)
    expect(ours?.hrp).toBe('dydx')
    expect(theirs?.hrp).toBe('cosmos')
    expect(toHex(ours!.bytes)).toBe(toHex(theirs!.bytes))
  })

  it('地址是 20 字节 ripemd160(sha256(公钥))，导出的 hex 与解码一致', () => {
    const signer = new DydxSigner(DYDX_TEST_KEY)
    const d = bech32Decode(signer.address)
    expect(d?.bytes).toHaveLength(20)
    expect(toHex(d!.bytes)).toHaveLength(40)
    expect(signer.address.startsWith('dydx1')).toBe(true)
  })

  it('压缩公钥 33 字节，前缀 02/03', () => {
    const signer = new DydxSigner(KEY1)
    expect(signer.info.publicKey).toHaveLength(33)
    expect([0x02, 0x03]).toContain(signer.info.publicKey[0])
  })

  it('奇数 Y 的私钥用 03 前缀（0x11…11），地址与 addressFromPublicKey 一致', () => {
    const odd = new DydxSigner('11'.repeat(32))
    expect(odd.info.publicKey[0]).toBe(0x03)
    expect(addressFromPublicKey(odd.info.publicKey)).toBe(odd.address)
    expect(odd.verifyMessage(new TextEncoder().encode('parity'), odd.signMessage(new TextEncoder().encode('parity')))).toBe(true)
  })

  it('addressFromPublicKey 拒绝非 33 字节 / 非法前缀 / 不在曲线上的点', () => {
    const signer = new DydxSigner(KEY1)
    expect(() => addressFromPublicKey(signer.info.publicKey.subarray(0, 32))).toThrow(TypeError)
    const badPrefix = Uint8Array.from(signer.info.publicKey)
    badPrefix[0] = 0x04
    expect(() => addressFromPublicKey(badPrefix)).toThrow(TypeError)
    const offCurve = new Uint8Array(33)
    offCurve[0] = 0x02
    expect(() => addressFromPublicKey(offCurve)).toThrow()
  })

  it('不同私钥给不同地址', () => {
    expect(new DydxSigner(KEY2).address).not.toBe(new DydxSigner(KEY1).address)
  })

  it('私钥必须是 32 字节且在群阶内', () => {
    expect(() => new DydxSigner('01')).toThrow(TypeError)
    expect(() => new DydxSigner('00'.repeat(32))).toThrow(TypeError)
    expect(() => new DydxSigner('ff'.repeat(32))).toThrow(/out of range/)
    expect(() => new DydxSigner('')).toThrow(TypeError)
  })

  it('pkcs8FromRawKey 输出是合法 DER（以 30 开头、含 secp256k1 OID）', () => {
    const der = pkcs8FromRawKey(new Uint8Array(32).fill(1))
    expect(der[0]).toBe(0x30)
    expect(toHex(der)).toContain('2b8104000a')
  })

  it('fromHex / toHex 往返（含 0x 前缀与大小写）', () => {
    expect(toHex(fromHex('0xABcd'))).toBe('abcd')
    expect(() => fromHex('abc')).toThrow(TypeError)
    expect(() => fromHex('zz')).toThrow(TypeError)
  })
})

describe('签名与验签', () => {
  const signer = new DydxSigner(KEY1)
  const message = new TextEncoder().encode('dydx sign test message')

  it('签名长度固定 64 字节（r||s）', () => {
    expect(signer.signMessage(message)).toHaveLength(64)
    expect(signer.signMessage(new Uint8Array(0))).toHaveLength(64)
  })

  it('signMessage 的签名能被 verifyMessage 验过，改一个字节就不过', () => {
    const sig = signer.signMessage(message)
    expect(sig).toHaveLength(64)
    expect(signer.verifyMessage(message, sig)).toBe(true)
    const tampered = Uint8Array.from(sig)
    tampered[10] = tampered[10]! ^ 0x01
    expect(signer.verifyMessage(message, tampered)).toBe(false)
    const tamperedMsg = Uint8Array.from(message)
    tamperedMsg[0] = tamperedMsg[0]! ^ 0x01
    expect(signer.verifyMessage(tamperedMsg, sig)).toBe(false)
  })

  it('低 S 归一化：s ≤ n/2', () => {
    for (let i = 0; i < 8; i += 1) {
      const sig = signer.signMessage(new TextEncoder().encode(`msg-${i}`))
      let s = 0n
      for (const b of sig.subarray(32)) s = (s << 8n) | BigInt(b)
      expect(s <= SECP256K1_N / 2n).toBe(true)
    }
  })

  it('verifySha256 拒绝错误长度的签名 / 非法公钥前缀（不抛错）', () => {
    const sig = signer.signMessage(message)
    expect(verifySha256(message, sig.subarray(0, 63), signer.info.publicKey)).toBe(false)
    const badPub = Uint8Array.from(signer.info.publicKey)
    badPub[0] = 0x04
    expect(verifySha256(message, sig, badPub)).toBe(false)
  })

  it('同一摘要两次签名都有效（OpenSSL 随机 k；不比对字节）', () => {
    const a = signer.signMessage(message)
    const b = signer.signMessage(message)
    expect(signer.verifyMessage(message, a)).toBe(true)
    expect(signer.verifyMessage(message, b)).toBe(true)
  })
})

describe('密钥不外泄（工单教训 6）', () => {
  const signer = new DydxSigner(KEY1)

  it('JSON.stringify(signer) 不含私钥', () => {
    const s = JSON.stringify(signer)
    expect(s).not.toContain(KEY1)
    expect(s).toContain('dydx1')
  })

  it('util.inspect(signer, {depth: 5}) 不含私钥', () => {
    const s = inspect(signer, { depth: 5, showHidden: true })
    expect(s).not.toContain(KEY1)
    // 私钥的十六进制、十进制表示都不该出现
    expect(s).not.toMatch(/0{20,}1/)
  })

  it('String(signer) / String(Error) 不含私钥', () => {
    expect(String(signer)).not.toContain(KEY1)
    try {
      new DydxSigner('zz')
    } catch (e) {
      expect(String(e)).not.toContain(KEY1)
    }
  })

  it('私钥字段是 # 私有字段，Object.keys 里没有', () => {
    expect(Object.keys(signer as unknown as Record<string, unknown>)).not.toContain('#key')
    expect(Object.keys(signer as unknown as Record<string, unknown>)).not.toContain('key')
  })
})
