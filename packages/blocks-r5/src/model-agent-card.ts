// SPDX-License-Identifier: CPAL-1.0
// Agent 卡（F19）的纯逻辑：今日提议 / 拦截取 risk.stats 的按 actor 汇总（与账本同源），日界用浏览器本地 0 点；
// 卡片顺序按钥匙创建时间固定，同一会话内不再随动作跳动（R-52）。不碰界面、不碰钩子，vitest 直接测。
import { isRec } from '../../blocks-default/src/util'

export const AGENT_DASH = '—'

export interface AgentCardCounts {
  /** 今日提议数；risk.stats 不可用时为 null（显示 —）。 */
  proposals: number | null
  /** 今日拦截数（denied 已含提案阶段的拒绝）；risk.stats 不可用时为 null（显示 —）。 */
  blocked: number | null
}

export interface AgentKeyLike {
  keyId: string
  name: string
}

/** 浏览器本地时间当天 0 点（毫秒）——risk.stats 的 sinceTs。 */
export function localDayStart(now: number): number {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

const countOf = (v: unknown): number | null => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null

/**
 * risk.stats 回包 → 某把钥匙的今日提议 / 拦截。
 * 回包不可用（查询失败 / 形状不对）时两项都是 null；回包可用但该 actor 今天没有记录时是 0。
 */
export function agentCardCounts(stats: unknown, keyId: string): AgentCardCounts {
  if (!isRec(stats) || !isRec(stats.byActor)) return { proposals: null, blocked: null }
  const bucket = (stats.byActor as Record<string, unknown>)[`agent:${keyId}`]
  if (bucket === undefined) return { proposals: 0, blocked: 0 }
  if (!isRec(bucket)) return { proposals: null, blocked: null }
  return { proposals: countOf(bucket.proposals) ?? 0, blocked: countOf(bucket.denied) ?? 0 }
}

/** 计数显示：null → 「—」（失败不显示成 0），其余按整数原样。 */
export function fmtAgentCount(n: number | null): string {
  return n === null ? AGENT_DASH : String(n)
}

const byName = (a: AgentKeyLike, b: AgentKeyLike): number => a.name < b.name ? -1 : a.name > b.name ? 1 : a.keyId < b.keyId ? -1 : a.keyId > b.keyId ? 1 : 0

/**
 * 卡片顺序：按钥匙创建时间升序；没有创建时间的排在后面、彼此按名字。
 * 与活动流无关，同一会话内顺序不再随动作跳动（R-52）。
 */
export function stableKeyOrder<T extends AgentKeyLike>(keys: readonly T[], createdAtOf: (keyId: string) => number | null): T[] {
  return [...keys].sort((a, b) => {
    const at = createdAtOf(a.keyId)
    const bt = createdAtOf(b.keyId)
    if (at !== null && bt !== null) return at - bt || byName(a, b)
    if (at !== null) return -1
    if (bt !== null) return 1
    return byName(a, b)
  })
}
