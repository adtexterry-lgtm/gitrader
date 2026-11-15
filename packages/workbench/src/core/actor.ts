// SPDX-License-Identifier: CPAL-1.0
// 「谁做的」：契约 §1.6 Origin（v0.1.2 起 actorType 必填）→ 视觉规范 §4.3 的四种小标，以及检阅块的固定筛选器（人 / 引擎 / LLM Agent / 系统）。
// TODO(protocol): 下面的 actorType 取值与前缀对应是 protocol/src/model/origin.ts（ORIGIN_ACTOR_TYPES / ORIGIN_ACTOR_TYPE_OF_PREFIX）的镜像，
// protocol 的块 / 来源类型从包入口导出后改为 re-export。
import { t as tr } from '../ui/lib/i18n.js'
export type OriginActorType = 'human' | 'engine' | 'llm-agent' | 'system'
export type ActorKind = 'host' | 'unit' | 'user' | 'system'

const TYPE_OF_PREFIX: Record<string, OriginActorType> = {
  user: 'human', agent: 'llm-agent', engine: 'engine', workflow: 'engine', strategy: 'engine', plugin: 'engine', mandate: 'system', system: 'system', venue: 'system',
}

/** 优先用内核盖章的 origin.actorType；没有（旧数据）按 actor 前缀推断；认不出归「系统」。 */
export function originActorType(origin: { actor?: string | null; actorType?: string | null } | null | undefined): OriginActorType {
  const t = origin?.actorType
  if (t === 'human' || t === 'engine' || t === 'llm-agent' || t === 'system') return t
  return TYPE_OF_PREFIX[String(origin?.actor ?? '').split(':', 1)[0]!] ?? 'system'
}

const KIND_OF_TYPE: Record<OriginActorType, ActorKind> = { human: 'user', engine: 'unit', 'llm-agent': 'host', system: 'system' }
/** 小标形状：LLM Agent ◆ 橙｜引擎 ◇ 暖橙｜人 ● 白｜系统 ○ 灰。 */
export const actorKind = (origin: { actor?: string | null; actorType?: string | null } | string | null | undefined): ActorKind =>
  KIND_OF_TYPE[originActorType(typeof origin === 'string' ? { actor: origin } : origin)]

const WORD: Record<ActorKind, string> = { host: 'LLM Agent', unit: tr('引擎'), user: tr('你'), system: tr('系统') }
export const actorWord = (kind: ActorKind): string => WORD[kind]

/** 检阅块（Agent 活动 / 记录）里的固定来源筛选器：全部 + 四类。 */
export const ACTOR_FILTERS: ReadonlyArray<{ id: 'all' | OriginActorType; label: string }> = [
  { id: 'all', label: tr('全部') }, { id: 'human', label: tr('人') }, { id: 'engine', label: tr('引擎') }, { id: 'llm-agent', label: 'LLM Agent' }, { id: 'system', label: tr('系统') },
]
export type ActorFilterId = (typeof ACTOR_FILTERS)[number]['id']

export function matchesActorFilter(origin: { actor?: string | null; actorType?: string | null } | null | undefined, filter: ActorFilterId): boolean {
  return filter === 'all' || originActorType(origin) === filter
}
