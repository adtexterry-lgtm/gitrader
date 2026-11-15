// SPDX-License-Identifier: Apache-2.0
// 契约 §1.2：标识符。

/** 内部 id 前缀（§1.2 表）。 */
export const ID_PREFIXES = [
  'org', 'usr', 'grp', 'acct', 'ord', 'fill', 'fund', 'pol', 'prot', 'mdt', 'ak', 'prop', 'pck', 'tko', 'exp',
  'sig', 'dec', 'led', 'bind', 'job', 'evt', 'ses',
] as const
export type IdPrefix = (typeof ID_PREFIXES)[number]

/** `<前缀>_<ULID>`。实际实现用完整 26 位 ULID；契约示例里有缩写，校验器按缩写也放行（见 schema `Id`）。 */
export type Id<P extends string = string> = `${P}_${string}`

export type OrgId = Id<'org'>
export type UserId = Id<'usr'>
export type GroupId = Id<'grp'>
export type AccountId = Id<'acct'>
export type OrderId = Id<'ord'>
export type FillId = Id<'fill'>
export type FundingId = Id<'fund'>
export type PolicyId = Id<'pol'>
export type ProtectorId = Id<'prot'>
export type MandateId = Id<'mdt'>
export type AgentKeyId = Id<'ak'>
export type ProposalId = Id<'prop'>
export type PrecheckId = Id<'pck'>
export type TakeoverId = Id<'tko'>
export type ExperimentId = Id<'exp'>
export type SignalId = Id<'sig'>
export type DecisionId = Id<'dec'>
export type LedgerId = Id<'led'>
export type BindingId = Id<'bind'>
export type JobId = Id<'job'>
export type EventId = Id<'evt'>
export type SessionId = Id<'ses'>
/** 策略 / 工作流实例 id（契约示例用 `inst_…`，但 §1.2 前缀表没列；见 OPEN-QUESTIONS）。 */
export type InstanceId = Id<'inst'>

/** `<venue>:<场所原生符号>`，按第一个冒号切分。例 `hyperliquid:BTC`、`hyperliquid:xyz:TSLA`、`hyperliquid:PURR/USDC`。 */
export type InstrumentId = string
/** 小写短名：`hyperliquid`、`binance-usdm`、`okx`。 */
export type VenueId = string
/** 32 位小写十六进制（16 字节）。 */
export type ClientOrderId = string
/** 票号 `T-YYYYMMDD-NNNN`。 */
export type Ticket = `T-${string}`
/** `sha256:<64 位小写十六进制>`。 */
export type Sha256Digest = `sha256:${string}`

export const ACTOR_TYPES = ['user', 'agent', 'engine', 'workflow', 'strategy', 'plugin', 'system', 'mandate', 'venue'] as const
export type ActorType = (typeof ACTOR_TYPES)[number]
/** `<类型>:<id>`，例 `agent:ak_01JAB5`、`user:usr_local`、`system:protector`。 */
export type Actor = `${ActorType}:${string}`

/** 按第一个冒号切分 instrumentId → [venue, symbol]。 */
export function splitInstrumentId(id: InstrumentId): [venue: string, symbol: string] {
  const i = id.indexOf(':')
  if (i <= 0 || i === id.length - 1) throw new TypeError(`invalid instrumentId: ${JSON.stringify(id)}`)
  return [id.slice(0, i), id.slice(i + 1)]
}

export const ID_PATTERN = '^[a-z]{2,5}_[0-9A-Za-z]{3,26}$'
export const CLIENT_ORDER_ID_PATTERN = '^[0-9a-f]{32}$'
export const TICKET_PATTERN = '^T-[0-9]{8}-[0-9]{4,}$'
export const SHA256_PATTERN = '^sha256:[0-9a-f]{64}$'
export const INSTRUMENT_ID_PATTERN = '^[a-z0-9][a-z0-9-]*:.+$'
