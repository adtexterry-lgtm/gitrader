// SPDX-License-Identifier: CPAL-1.0
// 模式 A 的下单管线：引擎只产出订单意图，经 host.order.place 交给宿主（宿主过授权书 + 风控闸 + 速率预算 + 连接器）。
// 这里负责的是「引擎自己的礼貌」，不是风控：
//   · 接管 / 失联 / 推送限额 → 少发或不发（LocalGuard）；
//   · 幂等：clientOrderId 由调用方按 实例|标的|K 线|动作 确定性生成，重复提交宿主只会认出同一单；
//   · 被拒（2xxx）后同向同类请求退避 5 分钟，不拆单规避（一致性测试 A1）；
//   · 1002 PRECISION 不原样重发：刷新合约规则，同一根 K 线内不再试；
//   · 3006 结果未知：先 host.order.status 按 clientOrderId 查，查清之前不再对该标的下新单；
//   · 不带 builder 字段（A2：builder 由宿主统一附加，引擎不得自设）。
import { PROBLEM_CODES, type AccountId, type Instrument, type Order, type OrderIntent, type OrderResult, type Origin, type Problem } from '../proto'
import { RpcError } from '../gep/peer'
import type { EngineContext } from './context'

export type SubmitStatus = 'placed' | 'denied' | 'rejected' | 'blocked' | 'unknown' | 'error'
export interface SubmitOutcome { status: SubmitStatus; orderId?: string; orderStatus?: string; problem?: Problem; note: string }

export interface SubmitArgs {
  accountId: AccountId
  instrumentId: string
  intent: OrderIntent
  kind: 'open' | 'reduce'
  strategyId?: string
  instanceId: string
  mandateId: string
  /** 同一根 K 线内同一个键只试一次（1002 之后用）。 */
  barKey: string
  origin: Origin
  /** 1002 后刷新合约规则。 */
  invalidateRules?: (instrumentId: string) => void
}

interface Backoff { until: number; barKey?: string; why: string }
interface Unknown { clientOrderId: string; since: number }

const DENY_BACKOFF_MS = 5 * 60_000
const UNKNOWN_GIVEUP_MS = 10 * 60_000
const DEFAULT_RETRY_MS = 5_000

const PLACED = new Set(['new', 'submitted', 'open', 'untriggered', 'partially_filled', 'filled'])

export class OrderSubmitter {
  private readonly backoff = new Map<string, Backoff>()
  private readonly unknown = new Map<string, Unknown>()
  /** 已提交且有明确结果的 clientOrderId（同一根 K 线内不重复提交）。 */
  private readonly done = new Map<string, SubmitStatus>()

  constructor(private readonly ctx: EngineContext) {}

  private key(a: { instanceId: string; instrumentId: string; intent: OrderIntent }): string {
    return `${a.instanceId}|${a.instrumentId}|${a.intent.side}|${a.intent.reduceOnly ? 'r' : 'o'}`
  }

  /** 接管解除后：之前的提交结果作废（那期间单子可能已被撤 / 平），允许重新对仓位。 */
  forgetDone(): void {
    this.done.clear()
    this.backoff.clear()
  }

  clearInstance(instanceId: string): void {
    for (const k of [...this.backoff.keys()]) if (k.startsWith(`${instanceId}|`)) this.backoff.delete(k)
    for (const k of [...this.unknown.keys()]) if (k.startsWith(`${instanceId}|`)) this.unknown.delete(k)
  }

  /** 该实例 + 标的上有没有「结果未知」的单还没查清。 */
  hasUnknown(instanceId: string, instrumentId: string): boolean {
    for (const k of this.unknown.keys()) if (k.startsWith(`${instanceId}|${instrumentId}|`)) return true
    return false
  }

  async submit(a: SubmitArgs): Promise<SubmitOutcome> {
    const { ctx } = this
    const gctx = { accountId: a.accountId, instrumentId: a.instrumentId, ...(a.strategyId ? { strategyId: a.strategyId } : {}), mandateId: a.mandateId }
    const gate = ctx.guard.gate(gctx, a.kind)
    if (!gate.ok) return { status: 'blocked', note: gate.why ?? 'blocked' }
    const allowed = ctx.guard.instrumentAllowed(gctx)
    if (!allowed.ok) return { status: 'blocked', note: allowed.why ?? 'not allowed' }
    const rate = ctx.guard.rateOk(gctx)
    if (!rate.ok) return { status: 'blocked', note: rate.why ?? 'rate' }

    const now = ctx.now()
    const k = this.key(a)
    const b = this.backoff.get(k)
    if (b) {
      if (b.barKey !== undefined ? b.barKey === a.barKey : now < b.until) return { status: 'blocked', note: b.why }
      this.backoff.delete(k)
    }
    // 之前有结果未知的单：先查清
    for (const [uk, u] of [...this.unknown]) {
      if (!uk.startsWith(`${a.instanceId}|${a.instrumentId}|`)) continue
      const resolved = await this.resolveUnknown(uk, u)
      if (resolved === null) return { status: 'blocked', note: `previous order ${u.clientOrderId} outcome still unknown` }
    }

    const clientOrderId = a.intent.clientOrderId as string
    // 同一个 clientOrderId 已经交出去并得到明确结果：不再重复提交（重发由 K 线推进后的新单号承担）
    const done = this.done.get(clientOrderId)
    if (done) return { status: 'blocked', note: `already submitted this bar (${done})` }
    ctx.guard.noteOrder()
    let result: OrderResult
    try {
      result = await ctx.host.placeOrder({
        accountId: a.accountId, intent: a.intent, clientOrderId,
        ...(a.strategyId ? { strategyId: a.strategyId } : {}), instanceId: a.instanceId as never,
        // TODO(protocol): HostOrderPlaceParams 没有 origin 字段；T26 要求引擎发出的订单带 origin.tool 与 causation.instanceId，这里作为追加字段发送，actor 由宿主覆盖。
        origin: a.origin,
      } as never)
    } catch (e) {
      const out = await this.onThrown(e, a, k, clientOrderId)
      this.remember(clientOrderId, out)
      return out
    }
    const out = await this.onResult(result, a, k, clientOrderId)
    this.remember(clientOrderId, out)
    return out
  }

  private remember(clientOrderId: string, out: SubmitOutcome): void {
    if (out.status === 'blocked' || out.status === 'error') return
    this.done.set(clientOrderId, out.status)
    if (this.done.size > 5000) this.done.delete(this.done.keys().next().value as string)
  }

  private onThrown(e: unknown, a: SubmitArgs, k: string, clientOrderId: string): Promise<SubmitOutcome> | SubmitOutcome {
    const p = e instanceof RpcError ? e.problem : undefined
    if (p && p.code === PROBLEM_CODES.VENUE_OUTCOME_UNKNOWN.code) return this.markUnknown(a, k, clientOrderId, p)
    if (p) return this.onProblem(p, a, k)
    // 传输层异常 / 超时：不知道单有没有到场所 → 按「结果未知」处理，先查再说
    return this.markUnknown(a, k, clientOrderId, undefined)
  }

  private onResult(r: OrderResult, a: SubmitArgs, k: string, clientOrderId: string): Promise<SubmitOutcome> | SubmitOutcome {
    // 先看 problem：结果未知（3006）可能随「已提交」状态一起回来，不能当成成功
    if (r.problem?.code === PROBLEM_CODES.VENUE_OUTCOME_UNKNOWN.code) return this.markUnknown(a, k, clientOrderId, r.problem)
    if (r.problem) {
      const o = this.onProblem(r.problem, a, k, r.orderId)
      return r.status === 'denied' && o.status === 'error' ? { ...o, status: 'denied' } : o
    }
    if (PLACED.has(r.status)) return { status: 'placed', orderId: r.orderId, orderStatus: r.status, note: r.status }
    if (r.status === 'denied') {
      this.backoff.set(k, { until: this.ctx.now() + DENY_BACKOFF_MS, why: 'denied by host risk gate' })
      return { status: 'denied', orderId: r.orderId, note: 'denied' }
    }
    return { status: 'rejected', orderId: r.orderId, orderStatus: r.status, note: `order ${r.status}` }
  }

  private onProblem(p: Problem, a: SubmitArgs, k: string, orderId?: string): SubmitOutcome {
    const now = this.ctx.now()
    if (p.category === 'RISK') {
      // 2007 / 2008 可重试：按 retryAfterMs 退避；其余（2001 …）按被拒处理，5 分钟内不换个说法再来
      const retry = p.retryable ? (p.retryAfterMs ?? DEFAULT_RETRY_MS) : DENY_BACKOFF_MS
      this.backoff.set(k, { until: now + retry, why: p.message })
      return { status: 'denied', ...(orderId ? { orderId } : {}), problem: p, note: p.message }
    }
    if (p.code === PROBLEM_CODES.PRECISION.code) {
      a.invalidateRules?.(a.instrumentId)
      this.backoff.set(k, { until: now + 60_000, barKey: a.barKey, why: 'precision rejected; rules refreshed, waiting for next bar' })
      return { status: 'rejected', ...(orderId ? { orderId } : {}), problem: p, note: p.message }
    }
    if (p.retryable) this.backoff.set(k, { until: now + (p.retryAfterMs ?? DEFAULT_RETRY_MS), why: p.message })
    else if (p.category === 'REJECTED') this.backoff.set(k, { until: now + 60_000, barKey: a.barKey, why: p.message })
    return { status: p.category === 'REJECTED' || p.category === 'VENUE' ? 'rejected' : 'error', ...(orderId ? { orderId } : {}), problem: p, note: p.message }
  }

  private async markUnknown(a: SubmitArgs, k: string, clientOrderId: string, p: Problem | undefined): Promise<SubmitOutcome> {
    const uk = `${a.instanceId}|${a.instrumentId}|${a.intent.side}|${a.intent.reduceOnly ? 'r' : 'o'}|${clientOrderId}`
    const u: Unknown = { clientOrderId, since: this.ctx.now() }
    this.unknown.set(uk, u)
    void k
    const found = await this.resolveUnknown(uk, u)
    if (found !== null && found !== 'absent') {
      const live = PLACED.has(found.status)
      return { status: live ? 'placed' : 'rejected', orderId: found.orderId, orderStatus: found.status, ...(found.problem ? { problem: found.problem } : {}), note: `outcome unknown (${p?.code ?? 'transport'}); host.order.status says ${found.status}` }
    }
    return { status: 'unknown', ...(p ? { problem: p } : {}), note: 'outcome unknown; will query host.order.status before any further order on this instrument' }
  }

  /**
   * 按 clientOrderId 查一次状态。返回 Order = 宿主认得这张单（不再重发）；'absent' = 宿主明确说没有 / 放弃等待；null = 还没查清。
   */
  private async resolveUnknown(uk: string, u: Unknown): Promise<Order | 'absent' | null> {
    try {
      const order = await this.ctx.host.orderStatus({ clientOrderId: u.clientOrderId })
      this.unknown.delete(uk)
      return order
    } catch (e) {
      const p = e instanceof RpcError ? e.problem : undefined
      // 宿主明确说「没有这张单」（1xxx 类）= 单从未到达场所，可以放行
      if (p?.category === 'REJECTED') { this.unknown.delete(uk); return 'absent' }
      if (this.ctx.now() - u.since > UNKNOWN_GIVEUP_MS) { this.unknown.delete(uk); return 'absent' }
      return null
    }
  }
}

export type { Instrument }
