// SPDX-License-Identifier: Apache-2.0
// 契约 §1.4.1 Org / Member、§1.4.2 AccountGroup、§1.4.3 Account、§1.4.9 Balance / MarginSnapshot。
import type { Decimal, Ms } from './decimal'
import type { AccountId, BindingId, GroupId, OrgId, PolicyId, UserId, VenueId } from './ids'

export const MEMBER_ROLES = ['admin', 'risk', 'trader', 'research'] as const
export type MemberRole = (typeof MEMBER_ROLES)[number]

export interface Member { userId: UserId; roles: MemberRole[] }

export interface Org {
  /** 单人使用时为本机默认组织 `org_local`。 */
  orgId: OrgId
  name: string
  identity: { provider: 'local' | 'unigit'; externalId?: string }
  members: Member[]
  settings?: { twoPersonAboveNotional?: Decimal }
}

export interface AccountGroup {
  groupId: GroupId
  orgId: OrgId
  name: string
  /** 一个账户可属于多个组。 */
  accountIds: AccountId[]
  /** 组级风控（与账户级取最严）。 */
  policyIds?: PolicyId[]
  /** 绑定到本组的引擎。 */
  bindingIds?: BindingId[]
}

export type AccountEnvironment = 'mainnet' | 'testnet'
/** paper / shadow 由内核模拟场所 kernel-sim 承接（§1.5.3）。 */
export type AccountMode = 'live' | 'paper' | 'shadow'
export type AccountStatus = 'active' | 'read_only' | 'disabled'
export type SignerType = 'api-wallet' | 'api-key' | 'none' | 'gateway-session'

export interface AccountSigner {
  type: SignerType
  /** 只存句柄与指纹，不存密钥。 */
  credentialRef: string
  address?: string
  fingerprint?: string
  notAfter?: Ms
  /** 查不到提现权限时写 "unknown"，不默认安全。 */
  permissions: { trade: boolean; withdraw: false | 'unknown' }
}

export interface Account {
  accountId: AccountId
  alias: string
  orgId: OrgId
  groupIds: GroupId[]
  /** 实际交易场所；纸面账户写被模拟的场所。 */
  venue: VenueId
  environment: AccountEnvironment
  mode: AccountMode
  /** HL 填主账户地址；CEX 填账户引用。 */
  owner: { address?: string; accountRef?: string }
  subaccount?: { address?: string; name?: string }
  vault?: { address: string }
  /** 取自场所能力 accountModels（HL：standard / unified / portfolio）。 */
  accountModel: string
  signer: AccountSigner
  builder?: { status: 'approved' | 'not_approved' | 'unknown'; maxFeeTenthBps?: number }
  /** mode=paper 时必填。 */
  paper?: { initialBalance: Decimal; ccy: string }
  status: AccountStatus
}

export interface Balance {
  accountId: AccountId
  asset: string
  total: Decimal
  available: Decimal
  hold: Decimal
  borrowed?: Decimal
  ts: Ms
}

export interface MarginSnapshot {
  accountId: AccountId
  /** 同 accountModel。 */
  model: string
  valuationCcy: string
  equity: Decimal
  initialMargin: Decimal
  maintenanceMargin: Decimal
  available: Decimal
  /** 维持保证金 / 权益。 */
  marginRatio: Decimal
  leverage: number
  ts: Ms
}
