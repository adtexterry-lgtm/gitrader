// SPDX-License-Identifier: CPAL-1.0
// 交易封装测试：SignDoc 结构、签名验签（独立 verify）、TxRaw、手续费、TxExtension、广播体。
import { describe, expect, it } from 'vitest'
import { createHash, createPublicKey, verify } from 'node:crypto'
import { DydxSigner, fromHex, verifySha256 } from '../src/keys'
import { anyOf, msgPlaceOrder } from '../src/msgs'
import {
  broadcastRequestBody, encodeAuthInfo, encodeSignDoc, encodeTxBody, encodeTxRaw, parseSignDoc, sha256Hex, signTransaction,
} from '../src/tx'
import { SECP256K1_N, TYPE_URL } from '../src/constants'
import { hex, one, walk } from './helpers/tlv'

const KEY = '11'.repeat(32)
const signer = new DydxSigner(KEY)
const order = {
  orderId: { owner: signer.address, subaccountNumber: 0, clientId: 77, clobPairId: 1, orderFlags: 0 },
  side: 'buy' as const,
  quantums: 1_000_000,
  subticks: 100_000,
  goodTilBlock: 500,
  tif: 'ioc' as const,
  reduceOnly: false,
  clientMetadata: 0,
}
const cfg = { chainId: 'dydx-testnet-4', accountNumber: 42, sequence: 7, fee: { amount: [], gasLimit: 0 } }

describe('SignDoc / TxRaw', () => {
  const msg = anyOf(TYPE_URL.msgPlaceOrder, msgPlaceOrder(order))
  const signed = signTransaction(signer, [msg], cfg)

  it('SignDoc 里的 chain_id 与 account_number 原样', () => {
    const doc = parseSignDoc(signed.signDoc)
    expect(doc.chainId).toBe('dydx-testnet-4')
    expect(doc.accountNumber).toBe(42)
  })

  it('SignDoc 的 body/auth 与 TxRaw 里的字节一致（同一份编码）', () => {
    const doc = parseSignDoc(signed.signDoc)
    const raw = walk(signed.txBytes)
    expect(hex(one(raw, 1).data!)).toBe(hex(doc.bodyBytes))
    expect(hex(one(raw, 2).data!)).toBe(hex(doc.authInfoBytes))
    expect(hex(one(raw, 1).data!)).toBe(hex(signed.bodyBytes))
  })

  it('签名是 64 字节，且对 sha256(SignDoc) 验签通过', () => {
    expect(signed.signature).toHaveLength(64)
    expect(verifySha256(signed.signDoc, signed.signature, signer.info.publicKey)).toBe(true)
  })

  it('改动 SignDoc 任一字节 → 验签失败', () => {
    const tampered = Uint8Array.from(signed.signDoc)
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 0x01
    expect(verifySha256(tampered, signed.signature, signer.info.publicKey)).toBe(false)
  })

  it('txHash = sha256(TxRaw)，与广播回执口径一致', () => {
    expect(signed.txHash).toBe(createHash('sha256').update(Buffer.from(signed.txBytes)).digest('hex'))
    expect(signed.signDocHash).toBe(sha256Hex(signed.signDoc))
  })

  it('tx_bytes 的 base64 往返不丢字节', () => {
    expect(Array.from(Buffer.from(signed.txBytesBase64, 'base64'))).toEqual(Array.from(signed.txBytes))
  })

  it('TxBody 里带一条 non-critical TxExtension（Any = /dydxprotocol.accountplus.TxExtension）', () => {
    const body = walk(signed.bodyBytes)
    const ext = body.filter((f) => f.field === 2047)
    expect(ext).toHaveLength(1)
    const any = walk(ext[0]!.data!)
    expect(one(any, 1).text).toBe('/dydxprotocol.accountplus.TxExtension')
    expect(one(any, 2).data).toHaveLength(0)
  })

  it('authenticators 非空时写进 TxExtension.selected_authenticators（packed）', () => {
    const s2 = signTransaction(signer, [msg], { ...cfg, authenticators: [7] })
    const body = walk(s2.bodyBytes)
    const any = walk(one(body.filter((f) => f.field === 2047), 2047).data!)
    const ext = walk(one(any, 2).data!)
    expect(hex(one(ext, 1).data!)).toBe('07')
  })

  it('AuthInfo：公钥 Any 类型正确、sequence 写入、签名模式 DIRECT=1', () => {
    const auth = walk(signed.authInfoBytes)
    const si = walk(one(auth, 1).data!)
    const pubAny = walk(one(si, 1).data!)
    expect(one(pubAny, 1).text).toBe('/cosmos.crypto.secp256k1.PubKey')
    expect(one(walk(one(pubAny, 2).data!), 1).data).toEqual(signer.info.publicKey)
    expect(Number(one(si, 3).num)).toBe(7)
    const mode = walk(one(walk(one(si, 2).data!), 1).data!)
    expect(Number(one(mode, 1).num)).toBe(1)
  })

  it('空手续费：Fee 里没有 amount、gas 0 被省略', () => {
    const auth = walk(signed.authInfoBytes)
    const fee = walk(one(auth, 2).data!)
    expect(fee.filter((f) => f.field === 1)).toHaveLength(0)
    expect(fee.find((f) => f.field === 2)).toBeUndefined()
  })

  it('手续费与 gas 上限写出 denom / amount / gas_limit', () => {
    const s2 = signTransaction(signer, [msg], { ...cfg, fee: { amount: [{ denom: 'uusdc', amount: '2000' }], gasLimit: 200000 } })
    const auth = walk(s2.authInfoBytes)
    const fee = walk(one(auth, 2).data!)
    const coin = walk(one(fee, 1).data!)
    expect(one(coin, 1).text).toBe('uusdc')
    expect(one(coin, 2).text).toBe('2000')
    expect(Number(one(fee, 2).num)).toBe(200000)
  })

  it('memory / timeout_height 写进 TxBody', () => {
    const s2 = signTransaction(signer, [msg], { ...cfg, memo: 'gt', timeoutHeight: 999 })
    const body = walk(s2.bodyBytes)
    expect(one(body, 2).text).toBe('gt')
    expect(Number(one(body, 3).num)).toBe(999)
  })

  it('没有消息 / 没有 sequence 也能签（sequence 0 省略）', () => {
    expect(() => signTransaction(signer, [], cfg)).toThrow(/at least one message/)
    const s2 = signTransaction(signer, [msg], { ...cfg, sequence: 0, accountNumber: 0 })
    expect(parseSignDoc(s2.signDoc).accountNumber).toBe(0)
  })

  it('encodeTxBody / encodeAuthInfo / encodeSignDoc / encodeTxRaw 可单独组合，结果与 signTransaction 相同', () => {
    const body = encodeTxBody([msg])
    const auth = encodeAuthInfo(signer.info.publicKey, 7, cfg.fee)
    const doc = encodeSignDoc(body, auth, cfg.chainId, cfg.accountNumber)
    expect(hex(doc)).toBe(hex(signed.signDoc))
    const raw = encodeTxRaw(body, auth, [signed.signature])
    expect(hex(raw)).toBe(hex(signed.txBytes))
  })

  it('parseSignDoc 对残缺输入抛错', () => {
    expect(() => parseSignDoc(new Uint8Array([0x1a, 0x01, 0x61]))).toThrow(/missing/)
  })

  it('广播体只有 tx_bytes 与 mode', () => {
    expect(broadcastRequestBody(signed, 'BROADCAST_MODE_SYNC')).toEqual({
      tx_bytes: signed.txBytesBase64,
      mode: 'BROADCAST_MODE_SYNC',
    })
  })
})

// cosmjs packages/proto-signing/src/testutils.ts 的 testVectors[0]（faucet 私钥、chain simd-testing、
// account_number 1、sequence 0、fee ucosm 2000 / gas 200000）。期望值全部是官方原值。
const FAUCET_KEY = 'e16ee698b4a4ee03566d7dd9bb6f0e8a2dda802527ba56205f5767c0049fa0b9'
const COSMJS_PUBKEY_B64 = 'A08EGB7ro1ORuFhjOnZcSgwYlpe0DSFjVNUIkNNQxwKQ'
const COSMJS_SIGN_BYTES = '0a93010a90010a1c2f636f736d6f732e62616e6b2e763162657461312e4d736753656e6412700a2d636f736d6f7331706b707472653766646b6c366766727a6c65736a6a766878686c63337234676d6d6b38727336122d636f736d6f7331717970717870713971637273737a673270767871367273307a716733797963356c7a763778751a100a0575636f736d12073132333435363712650a4e0a460a1f2f636f736d6f732e63727970746f2e736563703235366b312e5075624b657912230a21034f04181eeba35391b858633a765c4a0c189697b40d216354d50890d350c7029012040a02080112130a0d0a0575636f736d12043230303010c09a0c1a0c73696d642d74657374696e672001'
const COSMJS_SIGNATURE = 'c9dd20e07464d3a688ff4b710b1fbc027e495e797cfa0b4804da2ed117959227772de059808f765aa29b8f92edf30f4c2c5a438e30d3fe6897daa7141e3ce6f9'

describe('cosmjs 官方签名向量（testVectors[0]）', () => {
  const signBytes = fromHex(COSMJS_SIGN_BYTES)
  const signature = fromHex(COSMJS_SIGNATURE)
  const publicKey = fromHex(Buffer.from(COSMJS_PUBKEY_B64, 'base64').toString('hex'))

  it('encodeSignDoc(body, authInfo, simd-testing, 1) 逐字节等于官方 signBytes', () => {
    // body_bytes 字段：tag 0a + 长度 93 01（147）→ 数据从第 3 字节起 147 字节
    // auth_info_bytes：tag 12 + 长度 65（101）→ 数据从第 152 字节起 101 字节
    const body = signBytes.subarray(3, 150)
    const auth = signBytes.subarray(152, 253)
    const rebuilt = encodeSignDoc(body, auth, 'simd-testing', 1)
    expect(hex(rebuilt)).toBe(hex(signBytes))
  })

  it('encodeAuthInfo(公钥, 0, ucosm 2000 / gas 200000) 等于 signBytes 里的 auth_info_bytes', () => {
    const auth = encodeAuthInfo(publicKey, 0, { amount: [{ denom: 'ucosm', amount: '2000' }], gasLimit: 200000 })
    expect(hex(auth)).toBe(hex(signBytes.subarray(152, 253)))
  })

  it('官方签名对 signBytes 验签通过', () => {
    expect(verifySha256(signBytes, signature, publicKey)).toBe(true)
    const tampered = Uint8Array.from(signBytes)
    tampered[0] = tampered[0]! ^ 0x01
    expect(verifySha256(tampered, signature, publicKey)).toBe(false)
  })

  it('faucet 私钥签 signBytes：node:crypto 独立验签为真，且 s ≤ n/2', () => {
    const faucet = new DydxSigner(FAUCET_KEY)
    expect(Buffer.from(faucet.info.publicKey).toString('base64')).toBe(COSMJS_PUBKEY_B64)
    const produced = faucet.signMessage(signBytes)
    expect(produced).toHaveLength(64)
    // 独立验签（不走本包的 verifySha256）
    const spki = Buffer.concat([
      Buffer.from('3036301006072a8648ce3d020106052b8104000a032200', 'hex'),
      Buffer.from(publicKey),
    ])
    const keyObj = createPublicKey({ key: spki, format: 'der', type: 'spki' })
    expect(verify('sha256', Buffer.from(signBytes), { key: keyObj, dsaEncoding: 'ieee-p1363' }, Buffer.from(produced))).toBe(true)
    let s = 0n
    for (const b of produced.subarray(32)) s = (s << 8n) | BigInt(b)
    expect(s <= SECP256K1_N / 2n).toBe(true)
  })
})
