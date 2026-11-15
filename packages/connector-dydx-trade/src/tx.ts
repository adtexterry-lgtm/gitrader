// SPDX-License-Identifier: CPAL-1.0
// Cosmos 交易封装（SIGN_MODE_DIRECT）：TxBody / AuthInfo / SignDoc / TxRaw 与地址签名。
// 字段表（cosmos/tx/v1beta1/tx.proto）：
//   TxBody      { messages = 1, memo = 2, timeout_height = 3, extension_options = 1023, non_critical_extension_options = 2047 }
//   AuthInfo    { signer_infos = 1, fee = 2 }
//   SignerInfo  { public_key = 1 (Any /cosmos.crypto.secp256k1.PubKey), mode_info = 2, sequence = 3 }
//   ModeInfo    { oneof { single = 1 } }，ModeInfo.Single { mode = 1 }，SIGN_MODE_DIRECT = 1
//   Fee         { amount = 1 (repeated Coin), gas_limit = 2, payer = 3, granter = 4 }，Coin { denom = 1, amount = 2 (string) }
//   TxRaw       { body_bytes = 1, auth_info_bytes = 2, signatures = 3 }
//   SignDoc     { body_bytes = 1, auth_info_bytes = 2, chain_id = 3, account_number = 4 }
//   cosmos.crypto.secp256k1.PubKey { key = 1 (bytes, 压缩 33 字节) }
//   dYdX 客户端还会带一条 non-critical extension：Any{/dydxprotocol.accountplus.TxExtension, selected_authenticators}
//   （官方 v4-client-js clients/modules/signer.ts 的 signTransaction 就是这么做），本包跟随。
// 签名口径：signature = secp256k1_ecdsa(sha256(signDocBytes))，64 字节 r||s（Cosmos 不要求 recovery id）。
// 设计参照（只借「先编码 body/authInfo，再签 SignDoc，再拼 TxRaw」这一步序，代码从零写）：
//   nautilus_trader crates/adapters/dydx/src/execution/tx_manager.rs@55c0e820。
import { createHash } from 'node:crypto'
import { SIGN_MODE_DIRECT, TYPE_URL } from './constants'
import type { DydxSigner } from './keys'
import { anyOf, packedVarints } from './msgs'
import { ProtoWriter, readFields, toBase64 } from './proto'

export interface CoinAmount { denom: string; amount: string }

export interface FeeConfig {
  amount: CoinAmount[]
  gasLimit: number
  payer?: string
  granter?: string
}

export interface TxConfig {
  chainId: string
  accountNumber: number
  sequence: number
  fee: FeeConfig
  memo?: string
  timeoutHeight?: number
  /** 授权器（API key 模式）；空数组时 TxExtension 仍然要发（官方客户端固定带一条）。 */
  authenticators?: number[]
}

export interface SignedTx {
  /** TxRaw 的 proto 字节（POST /cosmos/tx/v1beta1/txs 的 tx_bytes，base64 后发出）。 */
  txBytes: Uint8Array
  txBytesBase64: string
  /** sha256(TxRaw) 的十六进制：交易哈希（广播回执里的 txhash 应与之相等）。 */
  txHash: string
  /** sha256(SignDoc) 的十六进制：落账本 signer.signed 时用这个摘要。 */
  signDocHash: string
  /** 64 字节 r||s 签名。 */
  signature: Uint8Array
  /** 签名字节（供离线核对）。 */
  signDoc: Uint8Array
  bodyBytes: Uint8Array
  authInfoBytes: Uint8Array
}

export function sha256(b: Uint8Array): Uint8Array {
  return new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest())
}

export function sha256Hex(b: Uint8Array): string {
  return createHash('sha256').update(Buffer.from(b)).digest('hex')
}

export function encodePubKey(compressed: Uint8Array): Uint8Array {
  return anyOf(TYPE_URL.pubKey, new ProtoWriter().bytes(1, compressed).finish())
}

export function encodeModeInfoSingle(): Uint8Array {
  return new ProtoWriter().bytes(1, new ProtoWriter().uint64(1, SIGN_MODE_DIRECT).finish()).finish()
}

export function encodeSignerInfo(compressedPubKey: Uint8Array, sequence: number): Uint8Array {
  return new ProtoWriter()
    .bytes(1, encodePubKey(compressedPubKey))
    .bytes(2, encodeModeInfoSingle())
    .uint64(3, sequence)
    .finish()
}

export function encodeCoin(c: CoinAmount): Uint8Array {
  return new ProtoWriter().string(1, c.denom).string(2, c.amount).finish()
}

export function encodeFee(fee: FeeConfig): Uint8Array {
  const w = new ProtoWriter()
  for (const c of fee.amount) w.bytes(1, encodeCoin(c))
  w.uint64(2, fee.gasLimit)
  if (fee.payer !== undefined) w.string(3, fee.payer)
  if (fee.granter !== undefined) w.string(4, fee.granter)
  return w.finish()
}

export function encodeAuthInfo(compressedPubKey: Uint8Array, sequence: number, fee: FeeConfig): Uint8Array {
  return new ProtoWriter()
    .bytes(1, encodeSignerInfo(compressedPubKey, sequence))
    .bytes(2, encodeFee(fee))
    .finish()
}

export function encodeTxBody(messages: readonly Uint8Array[], opts: { memo?: string; timeoutHeight?: number; authenticators?: number[] } = {}): Uint8Array {
  const w = new ProtoWriter()
  for (const m of messages) w.bytes(1, m)
  if (opts.memo !== undefined) w.string(2, opts.memo)
  if (opts.timeoutHeight !== undefined) w.uint64(3, opts.timeoutHeight)
  const auths = opts.authenticators ?? []
  const ext = new ProtoWriter()
  if (auths.length > 0) ext.bytes(1, packedVarints(auths))
  w.bytes(2047, anyOf(TYPE_URL.txExtension, ext.finish()))
  return w.finish()
}

export function encodeSignDoc(bodyBytes: Uint8Array, authInfoBytes: Uint8Array, chainId: string, accountNumber: number): Uint8Array {
  return new ProtoWriter()
    .bytes(1, bodyBytes)
    .bytes(2, authInfoBytes)
    .string(3, chainId)
    .uint64(4, accountNumber)
    .finish()
}

export function encodeTxRaw(bodyBytes: Uint8Array, authInfoBytes: Uint8Array, signatures: readonly Uint8Array[]): Uint8Array {
  const w = new ProtoWriter().bytes(1, bodyBytes).bytes(2, authInfoBytes)
  for (const s of signatures) w.bytes(3, s)
  return w.finish()
}

/**
 * 编码 + 签名。messages 是已经 Any 编码好的消息字节（见 msgs.ts 的 anyOf / msgPlaceOrder）。
 * 私钥只在 DydxSigner 内部（# 字段），这里拿到的只是它的签名能力。
 */
export function signTransaction(signer: DydxSigner, messages: readonly Uint8Array[], cfg: TxConfig): SignedTx {
  if (messages.length === 0) throw new TypeError('a transaction needs at least one message')
  const bodyBytes = encodeTxBody(messages, {
    ...(cfg.memo !== undefined ? { memo: cfg.memo } : {}),
    ...(cfg.timeoutHeight !== undefined ? { timeoutHeight: cfg.timeoutHeight } : {}),
    ...(cfg.authenticators !== undefined ? { authenticators: cfg.authenticators } : {}),
  })
  const authInfoBytes = encodeAuthInfo(signer.info.publicKey, cfg.sequence, cfg.fee)
  const signDoc = encodeSignDoc(bodyBytes, authInfoBytes, cfg.chainId, cfg.accountNumber)
  // signer.signMessage 内部做 sha256（Cosmos 的 SIGN_MODE_DIRECT 口径）：传 SignDoc 原文，不传摘要
  const signature = signer.signMessage(signDoc)
  const txBytes = encodeTxRaw(bodyBytes, authInfoBytes, [signature])
  return {
    txBytes,
    txBytesBase64: toBase64(txBytes),
    txHash: sha256Hex(txBytes),
    signDocHash: sha256Hex(signDoc),
    signature,
    signDoc,
    bodyBytes,
    authInfoBytes,
  }
}

/** 从 SignDoc 里读回四元组（测试与离线核对用）。 */
export function parseSignDoc(signDoc: Uint8Array): { bodyBytes: Uint8Array; authInfoBytes: Uint8Array; chainId: string; accountNumber: number } {
  const f = readFields(signDoc)
  const get = (n: number) => f.find((x) => x.field === n)
  const body = get(1)
  const auth = get(2)
  const chain = get(3)
  const acct = get(4)
  if (body?.bytes === undefined || auth?.bytes === undefined) throw new Error('sign doc is missing body/auth bytes')
  return {
    bodyBytes: body.bytes,
    authInfoBytes: auth.bytes,
    chainId: chain?.text ?? '',
    accountNumber: Number(acct?.value ?? 0n),
  }
}

/** 广播请求体（Cosmos LCD）：{ tx_bytes: base64, mode }。一律 SYNC（CheckTx 即返回）；v0.50 不再支持 BLOCK。 */
export function broadcastRequestBody(tx: SignedTx, mode: 'BROADCAST_MODE_SYNC' | 'BROADCAST_MODE_ASYNC'): { tx_bytes: string; mode: string } {
  return { tx_bytes: tx.txBytesBase64, mode }
}
