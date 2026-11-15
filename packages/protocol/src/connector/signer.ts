// SPDX-License-Identifier: Apache-2.0
// 连接器接口 · 签名器句柄（契约 §3.3 驱动级信任、§3.6 signer.signed）。
// 底稿：packages/connector-hyperliquid/src/types.ts（C 的临时定义），字段名与 C 现有实现一致。
import type { Ms } from '../model/decimal'

export type Hex = `0x${string}`
export type Environment = 'mainnet' | 'testnet'

/**
 * 内核签名器句柄：`signTypedData` 形状的对象（与 viem LocalAccount / @nktkas/hyperliquid 的 AbstractViemLocalAccount 兼容）。
 * 连接器永远拿不到私钥；句柄由内核在「内核发起的调用窗口内」交给连接器（契约 §3.3）。
 */
export interface SignerHandle {
  readonly address: Hex
  signTypedData(params: {
    domain: { name: string; version: string; chainId: number; verifyingContract: Hex }
    types: Record<string, readonly { name: string; type: string }[]>
    primaryType: string
    message: Record<string, unknown>
  }, options?: unknown): Promise<Hex>
}

/** 每次签名一条，内核写账本 `signer.signed`（只记载荷摘要，不记载荷与签名）。 */
export interface SignedEvent {
  purpose: string
  /** sha256 十六进制，对象是被签的 EIP-712 消息（primaryType + message，键序固定）。 */
  digest: string
  signer: Hex
  ts: Ms
}
