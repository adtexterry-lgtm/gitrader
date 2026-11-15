// SPDX-License-Identifier: Apache-2.0
// 壳 ↔ 内核的线格式（工作台 UI 通道，v0.1.3）。
//
// 契约 §4.2 只定义了块 ↔ 壳内桥（bridge.hello / subscribe / query / command / link.set）；壳到内核这一跳的线格式契约没有写。
// 本文件以 F 的实现（packages/blocks-sdk/src/client.ts、packages/workbench/src/core/{session,host-api}.ts）为底稿，
// 在契约 §4.2 / §5.1 的约束下定稿；B / E 的服务端按这里实现。与 B 现有实现的差异见 CHANGELOG v0.1.3「UI 线格式」。
//
// 1. 引导与换票  页面由内核服务，index.html 里注入一枚一次性引导令牌（<meta name="gitrader-bootstrap">）。
//    POST /api/session {bootstrap} → 200 {sessionToken, user, ws?}；失败 401 {error:{name:"AUTH_FAILED", message}}。
//    引导令牌一次有效；会话令牌只放内存（不进 localStorage / cookie / URL）。本机其他进程伪造 Sec-Fetch-Site 也换不到会话（契约 §5.1 T-B）。
// 2. 连接        ws://127.0.0.1:<port>/ui（默认路径，POST /api/session 的响应里 ws 可覆盖）。JSON-RPC 2.0 文本帧，每帧一个对象，≤ 1 MiB。
//    首帧必须是 auth；5 s 内未鉴权由内核关闭连接。令牌永远不放 URL。
// 3. 方法（壳 → 内核）  auth / subscribe / unsubscribe / query / command；（内核 → 壳）通知 event。
// 4. 在场证明    需要在场证明的命令：内核回错误，data.name = "ATTESTATION_REQUIRED"；壳弹出 PIN 层，带 attestation 重发一次。
//    PIN 明文只在本机回环发给内核校验，不落盘、不进日志、不进账本。错误的 PIN 回 AUTH_FAILED（5003）。
// 5. 命令的来源盖章  壳只提供 origin.tool / origin.via（="ui"），actor / actorType / requestId 由内核按已认证身份盖章（契约 §1.6）。
import type { Ms } from '../model/decimal'
import type { Problem } from '../model/problem'
import type { Origin } from '../model/origin'
import type { TakeoverLevel } from '../agent/takeover'
import type { AccountSummary, RiskStateSnapshot } from '../block/payloads'

export const UI_WS_PATH = '/ui'
export const UI_SESSION_PATH = '/api/session'
export const UI_BOOTSTRAP_META = 'gitrader-bootstrap'
/** 每帧 ≤ 1 MiB；首帧 auth 5 s 内必须到。 */
export const UI_LIMITS = { maxFrameBytes: 1024 * 1024, authTimeoutMs: 5000, defaultRequestTimeoutMs: 15000 } as const

// ---- 1. 换票 ----------------------------------------------------------------------------

export interface SessionExchangeRequest { bootstrap: string }
export interface SessionExchangeResult {
  sessionToken: string
  sessionId?: string
  expiresAt?: Ms
  /** 例 `usr_local`。 */
  user: string
  /** 覆盖默认 `/ui`。 */
  ws?: string
}
export interface SessionExchangeError { error: { name: string; message: string } }

// ---- 2. 方法 ----------------------------------------------------------------------------

export interface UiAuthParams { token: string; client: { name: string; instanceId?: string } }
export interface UiAuthResult { ok: true; user: string }

export interface UiSubscribeParams {
  topic: string
  filter?: Record<string, unknown>
  /** 服务端合并限频。 */
  maxHz?: number
  /** 断线重连后从这个 seq 续订（含）。 */
  fromSeq?: number
}
export interface UiSubscribeResult { subscriptionId: string }
export interface UiUnsubscribeParams { subscriptionId: string }

/** 在场证明（请求侧）：契约 §5.1 `attestation.method` 的线上形态。M1 只有 PIN；通行密钥 M1.1；钱包签名只用于 HL 授权。 */
export interface PresenceProof {
  method: 'pin' | 'passkey' | 'wallet'
  /** method = pin：6–12 位数字，明文只在本机回环发给内核。 */
  pin?: string
  /** passkey / wallet 的断言 / 签名载荷，形状待 M1.1。 */
  assertion?: Record<string, unknown>
}

export interface UiQueryParams { method: string; params?: Record<string, unknown> }
export interface UiCommandParams {
  action: string
  params?: Record<string, unknown>
  /** 壳填 tool（缺省 `ui:<action>`）与 via = "ui"；块经桥发来的命令 tool = `block:<blockId>:<action>`（§4.2）。 */
  origin: Pick<Origin, 'tool' | 'via'>
  attestation?: PresenceProof
}

export interface UiEventItem { seq?: number; ts?: Ms; data: unknown }
/** 内核 → 壳的通知。单条事件可直接把 seq / ts / data 放在 params 上。 */
export interface UiEventParams {
  subscriptionId: string
  topic: string
  events?: UiEventItem[]
  seq?: number
  ts?: Ms
  data?: unknown
}

export interface UiMethods {
  auth: { params: UiAuthParams; result: UiAuthResult }
  subscribe: { params: UiSubscribeParams; result: UiSubscribeResult }
  unsubscribe: { params: UiUnsubscribeParams; result: { ok: true } | Record<string, never> }
  query: { params: UiQueryParams; result: unknown }
  command: { params: UiCommandParams; result: unknown }
}
export const UI_METHOD_NAMES = ['auth', 'subscribe', 'unsubscribe', 'query', 'command'] as const
export type UiMethodName = (typeof UI_METHOD_NAMES)[number]
export const UI_NOTIFICATION_NAMES = ['event'] as const

/** error.data 是 Problem（§2.8）。需要在场证明时 data.name = ATTESTATION_REQUIRED（码 1010，类别 REJECTED）。 */
export const ATTESTATION_REQUIRED = 'ATTESTATION_REQUIRED'

/** 壳端（客户端）自己产生的错误码，不是内核发来的：连接丢失 / 超时 / 已关闭。命令的结果未知，调用方不得盲目重发。 */
export const UI_CLIENT_ERROR_CODES = { CONNECTION_LOST: -32001, TIMEOUT: -32002, CLOSED: -32003 } as const

export interface UiError { code: number; message: string; data?: Problem }

// ---- 3. 查询 / 命令名（壳用）--------------------------------------------------------------

export type Network = 'mainnet' | 'testnet'

/** 钥匙只有元数据，永远没有私钥（内核也不会回传）。 */
export interface KeyInfo {
  id: string
  label: string
  /** API 钱包地址（公开信息）。 */
  address: string
  venue: string
  network: Network
  createdAt: Ms
  expiresAt?: Ms
}

export interface SettingsSnapshot {
  network: Network
  pinSet: boolean
  /** 「允许 Agent 调整布局」：打开后 MCP 才加载 workspace 工具（契约 §5.7）。 */
  agentLayout: boolean
  keys: KeyInfo[]
}

export interface InstrumentHit { id: string; name: string; venue?: string }

export interface WorkspaceMeta { id: string; name: string; savedBy?: { actor: string; at: Ms } }

/** 壳用的查询（kind = query）。 */
export interface UiQueries {
  'settings.get': { params: Record<string, never>; result: SettingsSnapshot }
  'risk.state': { params: Record<string, never>; result: RiskStateSnapshot }
  'account.summary': { params: { accountId: string }; result: AccountSummary }
  'workspace.current': { params: Record<string, never>; result: { workspace: unknown; revision: number } | null }
  'workspace.list': { params: Record<string, never>; result: { workspaces: WorkspaceMeta[] } }
  'instruments.search': { params: { q: string; limit?: number }; result: { hits: InstrumentHit[] } }
}

/** 壳用的命令（kind = command）。presence 标明是否需要在场证明（契约 §5.1 表）。 */
export interface UiCommandSpec { action: string; presence: 'none' | 'session' | 'attested'; note?: string }

export const UI_COMMANDS: readonly UiCommandSpec[] = [
  { action: 'session.logout', presence: 'session' },
  { action: 'settings.network.set', presence: 'session' },
  { action: 'settings.agent_layout.set', presence: 'session' },
  { action: 'pin.set', presence: 'session', note: '首次设置只要会话；修改时 attestation = 旧 PIN（method: pin）' },
  { action: 'credential.import', presence: 'session', note: '导入 API 钱包私钥；契约 §5.1 会话即可。params.secret 是私钥明文，仅此命令对 S1 秘密字段规则豁免，且永不入账本 / 日志' },
  { action: 'credential.generate', presence: 'session', note: '内核生成新 API 钱包，私钥不出内核，只回 KeyInfo' },
  { action: 'credential.revoke', presence: 'session' },
  { action: 'takeover.halt_new', presence: 'none', note: '任何人可（§5.6）' },
  { action: 'takeover.cancel_all', presence: 'none' },
  { action: 'takeover.flatten_all', presence: 'none' },
  { action: 'trading_state.resume', presence: 'attested', note: '从 REDUCING / HALTED 恢复 ACTIVE，只有人 + 在场证明' },
  { action: 'workspace.update', presence: 'none' },
  { action: 'workspace.save', presence: 'none' },
  { action: 'workspace.load', presence: 'none' },
  { action: 'workspace.revert', presence: 'session', note: '人面专属（§4.5）' },
]

export interface UiCommands {
  'session.logout': { params: Record<string, never>; result: { ok: true } }
  'settings.network.set': { params: { network: Network }; result: unknown }
  'settings.agent_layout.set': { params: { enabled: boolean }; result: unknown }
  'pin.set': { params: { pin: string }; result: unknown }
  'credential.import': { params: { secret: string; label: string; network: Network }; result: { key: KeyInfo } }
  'credential.generate': { params: { label: string; network: Network }; result: { key: KeyInfo } }
  'credential.revoke': { params: { id: string }; result: unknown }
  'takeover.halt_new': { params: { reason: string; scope: { type: string; id?: string } }; result: unknown }
  'takeover.cancel_all': { params: { reason: string; scope: { type: string; id?: string } }; result: unknown }
  'takeover.flatten_all': { params: { reason: string; scope: { type: string; id?: string } }; result: unknown }
  'trading_state.resume': { params: { scope: { type: string; id?: string } }; result: unknown }
  'workspace.update': { params: { workspace: unknown }; result: { workspace: unknown; revision: number } }
  'workspace.save': { params: { name: string; workspace: unknown }; result: { meta: WorkspaceMeta } }
  'workspace.load': { params: { name: string }; result: { workspace: unknown } }
  'workspace.revert': { params: Record<string, never>; result: { workspace: unknown; revision: number } }
}

/** `takeover.<level>` 的命令名。 */
export const takeoverCommand = (level: TakeoverLevel): `takeover.${TakeoverLevel}` => `takeover.${level}`

/** PIN 格式：6–12 位数字。 */
export const PIN_PATTERN = '^[0-9]{6,12}$'

/** 这些命令的 params 里允许出现秘密字段名（S1 的豁免清单，仅限本机 UI 通道）。 */
export const UI_SECRET_FIELD_EXEMPT: Readonly<Record<string, readonly string[]>> = { 'credential.import': ['secret'] }
