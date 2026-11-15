// SPDX-License-Identifier: CPAL-1.0
// approveAgent / approveBuilderFee：只生成 EIP-712 待签载荷与说明，**不签名、不碰任何密钥**。
// 这两个动作必须由主钱包在系统浏览器里签（API 钱包签不了，官方明确）；签完的签名由 submitUserSigned 提交。
// 载荷形状对齐 @nktkas/hyperliquid 的 ApproveAgentTypes / ApproveBuilderFeeTypes 与官方 Python SDK 的 user-signed 动作。
import { ApproveAgentTypes, ApproveBuilderFeeTypes } from '@nktkas/hyperliquid/api/exchange'
import type { Environment } from './rest'
import { BUILDER_FEE_TENTH_BPS, builderMaxFeeRate } from './orders'
import type { Hex } from '@gitrader/protocol/connector'

/** 官方 Python SDK 的做法：用户签名动作的 signatureChainId 固定 0x66eee（421614），主网 / 测试网相同；真正区分网络的是 hyperliquidChain。 */
export const SIGNATURE_CHAIN_ID = '0x66eee'
/** API 钱包最长有效期 180 天。 */
export const AGENT_MAX_VALID_MS = 180 * 86_400_000
export const DEFAULT_AGENT_NAME = 'gitrader'

export interface TypedDataPayload {
  domain: { name: string; version: string; chainId: number; verifyingContract: Hex }
  types: Record<string, readonly { name: string; type: string }[]>
  primaryType: string
  message: Record<string, unknown>
}

export interface UserSignedRequest {
  kind: 'approveAgent' | 'approveBuilderFee'
  /** 交给 /exchange 的完整 action（含 type、signatureChainId、hyperliquidChain、nonce）。 */
  action: Record<string, unknown>
  nonce: number
  /** 交给主钱包签名的 EIP-712 载荷（eth_signTypedData_v4 形状）。 */
  typedData: TypedDataPayload
  /** 谁必须签：永远是主钱包。 */
  signWith: 'main-wallet'
  /** 给界面展示的说明（英文与中文各一份，界面按语言取）。 */
  explanation: { en: string; zh: string; fields: Array<{ label: string; value: string }> }
}

const ZERO_ADDR: Hex = '0x0000000000000000000000000000000000000000'

function typed(primaryTypes: Record<string, readonly { name: string; type: string }[]>, message: Record<string, unknown>): TypedDataPayload {
  return {
    domain: { name: 'HyperliquidSignTransaction', version: '1', chainId: parseInt(SIGNATURE_CHAIN_ID, 16), verifyingContract: ZERO_ADDR },
    types: primaryTypes,
    primaryType: Object.keys(primaryTypes)[0]!,
    message,
  }
}

const chainName = (env: Environment) => (env === 'testnet' ? 'Testnet' : 'Mainnet')

/**
 * 授权一个 API 钱包（只签名、不能提现）。
 * agentName 缺省为 "gitrader"：命名钱包占 3 个命名名额之一，不占那 1 个未命名名额；
 * validUntilMs 会追加成 `name valid_until <ms>`（官方语法，最长 180 天）。
 */
export function buildApproveAgent(o: {
  environment: Environment
  agentAddress: string
  agentName?: string
  validUntilMs?: number
  nonce: number
  now?: number
}): UserSignedRequest {
  const now = o.now ?? Date.now()
  if (!/^0x[0-9a-fA-F]{40}$/.test(o.agentAddress)) throw new TypeError(`agentAddress is not an address: ${o.agentAddress}`)
  let name = o.agentName ?? DEFAULT_AGENT_NAME
  if (o.validUntilMs !== undefined) {
    if (o.validUntilMs <= now) throw new RangeError('validUntilMs must be in the future')
    if (o.validUntilMs > now + AGENT_MAX_VALID_MS) throw new RangeError('API wallets are valid for at most 180 days')
    name = `${name} valid_until ${Math.floor(o.validUntilMs)}`
  }
  const agentAddress = o.agentAddress.toLowerCase()
  const action = {
    type: 'approveAgent',
    hyperliquidChain: chainName(o.environment),
    signatureChainId: SIGNATURE_CHAIN_ID,
    agentAddress,
    agentName: name,
    nonce: o.nonce,
  }
  const message = { hyperliquidChain: action.hyperliquidChain, agentAddress, agentName: name, nonce: o.nonce }
  return {
    kind: 'approveAgent',
    action,
    nonce: o.nonce,
    typedData: typed(ApproveAgentTypes as unknown as Record<string, readonly { name: string; type: string }[]>, message),
    signWith: 'main-wallet',
    explanation: {
      en: 'Authorize an API wallet that can sign trades for your account. It can place and cancel orders but cannot withdraw or transfer funds.',
      zh: '授权一个 API 钱包替你的账户签名交易：能下单、撤单，不能提现或转账。',
      fields: [
        { label: 'network', value: action.hyperliquidChain },
        { label: 'agentAddress', value: agentAddress },
        { label: 'agentName', value: name },
      ],
    },
  }
}

/** 授权 builder 费（Gitrader 固定 1 bp = 0.01%）。builderAddress 是收费地址（须小写）。 */
export function buildApproveBuilderFee(o: {
  environment: Environment
  builderAddress: string
  tenthBps?: number
  nonce: number
  /** 必须显式传 true（用户打开了「支持开发者」）；产品默认免费，不传 / 传 false 一律拒绝生成。 */
  supportDeveloper: boolean
}): UserSignedRequest {
  if (o.supportDeveloper !== true) throw new RangeError('supportDeveloper is off: the builder fee approval is only generated when the user opts in')
  if (!/^0x[0-9a-fA-F]{40}$/.test(o.builderAddress)) throw new TypeError(`builderAddress is not an address: ${o.builderAddress}`)
  const tenth = o.tenthBps ?? BUILDER_FEE_TENTH_BPS
  if (tenth !== BUILDER_FEE_TENTH_BPS) throw new RangeError(`builder fee is fixed at ${BUILDER_FEE_TENTH_BPS} tenths of a basis point (1 bp)`)
  const maxFeeRate = builderMaxFeeRate(tenth)
  const builder = o.builderAddress.toLowerCase()
  const action = {
    type: 'approveBuilderFee',
    hyperliquidChain: chainName(o.environment),
    signatureChainId: SIGNATURE_CHAIN_ID,
    maxFeeRate,
    builder,
    nonce: o.nonce,
  }
  const message = { hyperliquidChain: action.hyperliquidChain, maxFeeRate, builder, nonce: o.nonce }
  return {
    kind: 'approveBuilderFee',
    action,
    nonce: o.nonce,
    typedData: typed(ApproveBuilderFeeTypes as unknown as Record<string, readonly { name: string; type: string }[]>, message),
    signWith: 'main-wallet',
    explanation: {
      en: `Allow Gitrader to add a builder fee of at most ${maxFeeRate} (1 bp) to orders placed through it. You can revoke this any time. Without it, orders still work and carry no builder fee.`,
      zh: `允许 Gitrader 在经它下发的订单上附加最多 ${maxFeeRate}（1 bp）的 builder 费，可随时撤销。不授权也能正常下单，只是不带 builder 费。`,
      fields: [
        { label: 'network', value: action.hyperliquidChain },
        { label: 'builder', value: builder },
        { label: 'maxFeeRate', value: maxFeeRate },
      ],
    },
  }
}

export interface RsvSignature { r: Hex; s: Hex; v: 27 | 28 }

/** 65 字节十六进制签名（r ‖ s ‖ v）→ { r, s, v }。 */
export function splitSignature(sig: Hex): RsvSignature {
  if (!/^0x[0-9a-fA-F]{130}$/.test(sig)) throw new TypeError('signature must be 65 bytes of hex')
  const r = `0x${sig.slice(2, 66)}` as Hex
  const s = `0x${sig.slice(66, 130)}` as Hex
  let v = parseInt(sig.slice(130, 132), 16)
  if (v < 27) v += 27
  if (v !== 27 && v !== 28) throw new TypeError(`unexpected recovery id ${v}`)
  return { r, s, v: v as 27 | 28 }
}

/** 主钱包签完后，拼出 /exchange 的请求体。 */
export function toExchangePayload(req: UserSignedRequest, signature: Hex | RsvSignature): { action: Record<string, unknown>; nonce: number; signature: RsvSignature } {
  return { action: req.action, nonce: req.nonce, signature: typeof signature === 'string' ? splitSignature(signature) : signature }
}
