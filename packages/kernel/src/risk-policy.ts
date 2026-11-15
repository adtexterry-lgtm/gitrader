// SPDX-License-Identifier: CPAL-1.0
// 风控策略的纯函数部分：多作用域取最严合并、"是否更宽"比较（放宽 = 人面专属 + PIN）、数字预设展开。
import { RISK_PRESETS } from './proto'
import type { Decimal, Protector, RiskLimits, RiskPolicy } from './proto'
import * as d from './util/dec'

export type LimitsNumericDec = 'maxOrderNotional' | 'maxPositionNotionalRatio' | 'maxTotalNotionalRatio' | 'maxDailyLossRatio' | 'maxDailyNotional'
/** 重复意图窗口缺省 10 s（默认开启）。 */
export const DEFAULT_DUPLICATE_WINDOW_SEC = 10
export type LimitsNumeric = 'maxLeverage' | 'maxOpenPositions' | 'maxSlippageBps' | 'maxOrdersPerMinute' | 'maxDailyOrders' | 'maxCancelsPerMinute'
export const DEC_KEYS: LimitsNumericDec[] = ['maxOrderNotional', 'maxPositionNotionalRatio', 'maxTotalNotionalRatio', 'maxDailyLossRatio', 'maxDailyNotional']
export const NUM_KEYS: LimitsNumeric[] = ['maxLeverage', 'maxOpenPositions', 'maxSlippageBps', 'maxOrdersPerMinute', 'maxDailyOrders', 'maxCancelsPerMinute']

/** 数字预设展开成限额（预设只是一组数字；显示文案由数字生成）。 */
export function limitsOfPreset(id: string): Partial<RiskLimits> {
  const p = RISK_PRESETS.find((x) => x.id === id)
  if (!p) throw new RangeError(`unknown risk preset ${id}`)
  return {
    maxLeverage: p.maxLeverage, maxOrderNotional: p.maxOrderNotional, maxPositionNotionalRatio: p.maxPositionNotionalRatio,
    maxTotalNotionalRatio: p.maxTotalNotionalRatio, maxOpenPositions: p.maxOpenPositions, maxDailyLossRatio: p.maxDailyLossRatio,
  }
}
export function protectorsOfPreset(id: string): Protector[] {
  const p = RISK_PRESETS.find((x) => x.id === id)
  return p && p.cooldownSec > 0 ? [{ kind: 'cooldown', afterOpenSec: p.cooldownSec }] : []
}

/** 多个限额取最严：上限取最小、白名单取交集（空 = 不限，不参与交集）。 */
export function strictestLimits(list: Partial<RiskLimits>[]): RiskLimits {
  const out: Record<string, unknown> = {}
  for (const k of DEC_KEYS) {
    const vals = list.map((l) => l[k]).filter((v): v is Decimal => v !== undefined)
    if (vals.length) out[k] = d.str(vals.map((v) => d.D(v)).reduce((a, b) => d.min(a, b)))
  }
  for (const k of NUM_KEYS) {
    const vals = list.map((l) => l[k]).filter((v): v is number => v !== undefined)
    if (vals.length) out[k] = Math.min(...vals)
  }
  for (const k of ['instrumentAllowlist', 'venueAllowlist'] as const) {
    const lists = list.map((l) => l[k]).filter((v): v is string[] => Array.isArray(v) && v.length > 0)
    if (lists.length) out[k] = (lists[0] as string[]).filter((x) => lists.every((l) => l.includes(x)))
    // 交集为空表示"没有任何标的被允许"：用一个不可能匹配的哨兵，而不是空数组（空数组 = 不限）。
    if (lists.length && (out[k] as string[]).length === 0) out[k] = ['\u0000none']
  }
  if (out.maxSlippageBps === undefined) out.maxSlippageBps = 50
  return out as unknown as RiskLimits
}

const looserNum = (a: number | undefined, b: number | undefined): boolean => b !== undefined && (a === undefined || a > b)
const looserDec = (a: Decimal | undefined, b: Decimal | undefined): boolean => b !== undefined && (a === undefined || d.gt(d.D(a), d.D(b)))
const looserList = (a: string[] | undefined, b: string[] | undefined): boolean => {
  const bl = b && b.length > 0 ? b : null
  if (!bl) return false // b 不限 → a 不可能更宽
  if (!a || a.length === 0) return true
  return a.some((x) => !bl.includes(x))
}

/** 保护器参数方向：返回 a 是否比 b 更宽松（参数更弱 / 缺失）。 */
function protectorLooser(a: Protector | undefined, b: Protector): boolean {
  if (!a) return true
  if (a.kind !== b.kind) return true
  switch (b.kind) {
    case 'cooldown': return (a as typeof b).afterOpenSec < b.afterOpenSec
    case 'stoploss_guard': { const x = a as typeof b; return x.maxStoplosses > b.maxStoplosses || x.pauseMin < b.pauseMin || x.windowMin < b.windowMin || x.scope !== b.scope }
    case 'drawdown_pause': { const x = a as typeof b; return d.gt(d.D(x.maxDrawdownRatio), d.D(b.maxDrawdownRatio)) || x.pauseMin < b.pauseMin || x.windowHours < b.windowHours }
    case 'low_profit_lock': { const x = a as typeof b; return d.lt(d.D(x.minProfitRatio), d.D(b.minProfitRatio)) || x.lockMin < b.lockMin || x.windowHours < b.windowHours }
    case 'max_consecutive_failures': { const x = a as typeof b; return x.count > b.count || x.pauseMin < b.pauseMin }
    case 'plugin': return JSON.stringify(a) !== JSON.stringify(b)
  }
}
const protectorKey = (p: Protector, i: number): string => (p.kind === 'plugin' ? `plugin:${p.pluginId}:${i}` : p.kind === 'stoploss_guard' ? `stoploss_guard:${p.scope}` : p.kind)

/** next 是否比 base 更宽（任何一个维度更宽就算）。放宽必须 PIN 在场证明；收紧会话即可。 */
type PolicyShape = Pick<RiskPolicy, 'limits' | 'protectors' | 'failClosed' | 'dailyResetAt'> & { denyLlmLiveEntries?: boolean }
export function isLooser(next: PolicyShape, base: PolicyShape): string[] {
  const why: string[] = []
  // v0.1.2：denyLlmLiveEntries 缺省 = 开启；关闭是放宽（人面 + PIN）。
  if (next.denyLlmLiveEntries === false && base.denyLlmLiveEntries !== false) why.push('denyLlmLiveEntries')
  // 重复意图窗口：缩短 / 关闭（0）是放宽
  if ((next.limits.duplicateIntentWindowSec ?? DEFAULT_DUPLICATE_WINDOW_SEC) < (base.limits.duplicateIntentWindowSec ?? DEFAULT_DUPLICATE_WINDOW_SEC)) why.push('duplicateIntentWindowSec')
  for (const k of DEC_KEYS) if (looserDec(next.limits[k], base.limits[k])) why.push(k)
  for (const k of NUM_KEYS) if (looserNum(next.limits[k], base.limits[k])) why.push(k)
  for (const k of ['instrumentAllowlist', 'venueAllowlist'] as const) if (looserList(next.limits[k], base.limits[k])) why.push(k)
  const nm = new Map((next.protectors ?? []).map((p, i) => [protectorKey(p, i), p]))
  ;(base.protectors ?? []).forEach((b, i) => { if (protectorLooser(nm.get(protectorKey(b, i)), b)) why.push(`protector:${protectorKey(b, i)}`) })
  if (next.failClosed.stalePriceMs > base.failClosed.stalePriceMs) why.push('failClosed.stalePriceMs')
  if (next.failClosed.onMissingPrice !== 'deny') why.push('failClosed.onMissingPrice')
  if (next.dailyResetAt !== base.dailyResetAt) why.push('dailyResetAt')
  return why
}

/** 日亏基线的"日"键：dailyResetAt 形如 "00:00Z"（UTC 时刻）。 */
export function dayKeyOf(now: number, dailyResetAt: string): string {
  const m = /^(\d{2}):(\d{2})Z$/.exec(dailyResetAt)
  const offset = m ? (Number(m[1]) * 60 + Number(m[2])) * 60_000 : 0
  return new Date(now - offset).toISOString().slice(0, 10)
}
export function dayStartTs(now: number, dailyResetAt: string): number {
  const m = /^(\d{2}):(\d{2})Z$/.exec(dailyResetAt)
  const offset = m ? (Number(m[1]) * 60 + Number(m[2])) * 60_000 : 0
  const day = Date.parse(`${dayKeyOf(now, dailyResetAt)}T00:00:00Z`)
  return day + offset
}
