// SPDX-License-Identifier: CPAL-1.0
// 引擎本地闸：接管（engine.halt / resume）、宿主失联、风控推送（risk.policy.push，只能收紧）。
// 这里只做「引擎自己少做点」——真正的强制风控在宿主（模式 A 下单必经宿主风控闸，§2.6）。
// Harness 只做准入和记录：这里不判断策略信号好坏，只按宿主推下来的数字限额和接管指令收紧。
import { strictestTradingState, type AccountId, type InstrumentId, type RiskPolicy, type TakeoverLevel, type TakeoverScope, type TradingState } from '../proto'

export interface Takeover { takeoverId: string; level: TakeoverLevel; scope: TakeoverScope; reason: string; at: number; deadlineMs: number }

/** 推送下来的限额取最严后的结果（number；比例同为分数 number）。 */
export interface EffectiveLimits {
  maxLeverage?: number
  maxOrderNotional?: number
  maxSlippageBps?: number
  maxOrdersPerMinute?: number
  instrumentAllowlist?: string[]
  venueAllowlist?: string[]
  maxOpenPositions?: number
  maxPositionNotionalRatio?: number
  maxTotalNotionalRatio?: number
}

export interface GateCtx { accountId: AccountId; instrumentId: InstrumentId; strategyId?: string; mandateId?: string }
export type GateKind = 'open' | 'reduce'
export interface GateDecision { ok: boolean; why?: string }

interface StoredPolicy { policy: RiskPolicy; effectiveAt: number }

const num = (v: unknown): number | undefined => {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return undefined
}
const minOf = (a: number | undefined, b: number | undefined): number | undefined => (a === undefined ? b : b === undefined ? a : Math.min(a, b))

export class LocalGuard {
  /** 宿主心跳超时 / 连接断开。 */
  hostLost = false
  private readonly takeovers = new Map<string, Takeover>()
  private readonly policies = new Map<string, StoredPolicy>()
  private orderTimes: number[] = []

  constructor(private readonly now: () => number = Date.now) {}

  /** 新宿主会话：接管、风控推送、速率窗口都属于上一个会话，清空（hostLost 状态由连接状态决定，不在这里动）。 */
  reset(): void {
    this.takeovers.clear()
    this.policies.clear()
    this.orderTimes = []
  }

  // ---- 风控推送 ----------------------------------------------------------------

  /** 接收推送；返回被接受的版本号。旧版本（低于已存版本）不接受；结构不对的整个推送由调用方拒绝。 */
  acceptPolicies(policies: readonly RiskPolicy[], effectiveAt: number): number[] {
    const accepted: number[] = []
    for (const p of policies) {
      const cur = this.policies.get(p.policyId)
      if (cur && p.version < cur.policy.version) continue
      this.policies.set(p.policyId, { policy: p, effectiveAt })
      accepted.push(p.version)
    }
    return accepted
  }

  /** 当前生效的最高策略版本（预检 / 日志用）。 */
  policyVersion(): number {
    let v = 0
    for (const s of this.policies.values()) v = Math.max(v, s.policy.version)
    return v
  }

  policyCount(): number { return this.policies.size }

  private scopeMatches(p: RiskPolicy, ctx: GateCtx): boolean {
    switch (p.scope.type) {
      case 'account': return p.scope.id === ctx.accountId
      case 'mandate': return ctx.mandateId !== undefined && p.scope.id === ctx.mandateId
      case 'strategy': return ctx.strategyId !== undefined && p.scope.id === ctx.strategyId
      default: return true // org / group：引擎不知道成员关系，多套用只会更严
    }
  }

  /** 适用于此上下文的全部生效策略，限额取最严：上限取最小、白名单取交集。 */
  limitsFor(ctx: GateCtx): EffectiveLimits {
    const t = this.now()
    const out: EffectiveLimits = {}
    for (const { policy, effectiveAt } of this.policies.values()) {
      if (effectiveAt > t || !this.scopeMatches(policy, ctx)) continue
      const l = policy.limits as unknown as Record<string, unknown>
      out.maxLeverage = minOf(out.maxLeverage, num(l.maxLeverage))
      out.maxOrderNotional = minOf(out.maxOrderNotional, num(l.maxOrderNotional))
      out.maxSlippageBps = minOf(out.maxSlippageBps, num(l.maxSlippageBps))
      out.maxOrdersPerMinute = minOf(out.maxOrdersPerMinute, num(l.maxOrdersPerMinute))
      out.maxOpenPositions = minOf(out.maxOpenPositions, num(l.maxOpenPositions))
      out.maxPositionNotionalRatio = minOf(out.maxPositionNotionalRatio, num(l.maxPositionNotionalRatio))
      out.maxTotalNotionalRatio = minOf(out.maxTotalNotionalRatio, num(l.maxTotalNotionalRatio))
      for (const k of ['instrumentAllowlist', 'venueAllowlist'] as const) {
        const list = l[k]
        if (Array.isArray(list) && list.length > 0) {
          const strs = list.filter((x): x is string => typeof x === 'string')
          out[k] = out[k] ? out[k]!.filter((x) => strs.includes(x)) : strs
        }
      }
    }
    for (const k of Object.keys(out) as (keyof EffectiveLimits)[]) if (out[k] === undefined) delete out[k]
    return out
  }

  // ---- 接管 --------------------------------------------------------------------

  halt(t: Takeover): void { this.takeovers.set(t.takeoverId, t) }

  /** 恢复：只按 takeoverId 解除（严格，不按范围猜）。返回被解除的接管。 */
  resume(takeoverId: string): Takeover[] {
    const hit = this.takeovers.get(takeoverId)
    if (!hit) return []
    this.takeovers.delete(takeoverId)
    return [hit]
  }

  activeTakeovers(): Takeover[] { return [...this.takeovers.values()] }

  private takeoverMatches(t: Takeover, ctx: Partial<GateCtx>): boolean {
    const s = t.scope
    if (s.accountIds?.length && !(ctx.accountId && s.accountIds.includes(ctx.accountId))) return false
    if (s.strategyIds?.length && !(ctx.strategyId && s.strategyIds.includes(ctx.strategyId))) return false
    if (s.instrumentIds?.length && !(ctx.instrumentId && s.instrumentIds.includes(ctx.instrumentId))) return false
    return true
  }

  /** 引擎对这个上下文的交易状态（借 Nautilus 三态，只用于诊断展示）。 */
  stateFor(ctx: Partial<GateCtx>): TradingState {
    const states: TradingState[] = ['ACTIVE']
    if (this.hostLost) states.push('REDUCING')
    for (const t of this.takeovers.values()) if (this.takeoverMatches(t, ctx)) states.push(t.level === 'halt_new' ? 'REDUCING' : t.level === 'cancel_all' ? 'REDUCING' : 'HALTED')
    return strictestTradingState(states)
  }

  /**
   * 能不能发这类请求。
   * - 开仓类（open）：任何接管、宿主失联都禁止。
   * - 减仓类（reduce，reduceOnly）：只有 cancel_all / flatten_all 禁止（那两档由宿主自己撤单 / 平仓，引擎不再插手）。
   */
  gate(ctx: GateCtx, kind: GateKind): GateDecision {
    for (const t of this.takeovers.values()) {
      if (!this.takeoverMatches(t, ctx)) continue
      if (kind === 'open') return { ok: false, why: `takeover ${t.level} in effect` }
      if (t.level !== 'halt_new') return { ok: false, why: `takeover ${t.level} in effect` }
    }
    if (kind === 'open' && this.hostLost) return { ok: false, why: 'host heartbeat lost' }
    return { ok: true }
  }

  /** 本地限额：标的白名单（开仓 / 减仓都查）。 */
  instrumentAllowed(ctx: GateCtx): GateDecision {
    const lim = this.limitsFor(ctx)
    if (lim.instrumentAllowlist && !lim.instrumentAllowlist.includes(ctx.instrumentId)) return { ok: false, why: 'instrument not in pushed allowlist' }
    const venue = ctx.instrumentId.split(':')[0]!
    if (lim.venueAllowlist && !lim.venueAllowlist.includes(venue)) return { ok: false, why: 'venue not in pushed allowlist' }
    return { ok: true }
  }

  // ---- 速率（maxOrdersPerMinute）---------------------------------------------------

  rateOk(ctx: GateCtx): GateDecision {
    const lim = this.limitsFor(ctx).maxOrdersPerMinute
    if (lim === undefined) return { ok: true }
    const t = this.now()
    this.orderTimes = this.orderTimes.filter((x) => t - x < 60_000)
    return this.orderTimes.length < lim ? { ok: true } : { ok: false, why: 'maxOrdersPerMinute reached' }
  }

  noteOrder(): void { this.orderTimes.push(this.now()) }
}
