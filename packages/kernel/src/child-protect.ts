// SPDX-License-Identifier: CPAL-1.0
// fix-r2 K1（ADR-14）：启动对账之后的「保护」两步——领养场所上本地没记录的子单、给崩溃丢掉止损的仓位幂等补挂。
// 纸面账户自动做；实盘账户只告警（position.unprotected + REDUCING + takeover.alert），自动领养 / 补挂待 维护者 批准。
// 只补「本地从未有过止损子单记录」的父单（派生 clientOrderId 一旦用过就不再补）：人后来撤掉的止损不会被内核偷偷挂回去。
import type { Kernel } from './kernel'
import type { NormalizedIntent } from './connector'
import type { Account, Order, Position } from './proto'
import type { VenueOpenOrder } from '@gitrader/protocol/connector'
import { derivedStopClientOrderId } from './trading'
import * as d from './util/dec'
import { KernelError } from './util/errors'
import { systemOrigin } from './util/origin'

export interface ProtectionView { positions: Position[]; openOrders: VenueOpenOrder[] }
export interface ProtectionOutcome {
  adopted: string[]
  replaced: string[]
  unprotected: Array<{ instrumentId: string; reason: string }>
  /** 瞬时失败（行情陈旧 / 可重试）的父单：调用方稍后重试。 */
  retry: string[]
}

const WINDOW_MS = 24 * 60 * 60 * 1000
const STOP = new Set(['stop_market', 'stop_limit'])
const LIVE = new Set(['new', 'submitted', 'open', 'untriggered', 'partially_filled'])

const roleOf = (type: string): 'sl' | 'tp' => (type === 'take_market' || type === 'take_limit' ? 'tp' : 'sl')

function intentOf(k: Kernel, orderId: string): NormalizedIntent | undefined {
  return k.docs.get<{ intent?: NormalizedIntent }>('order-record', orderId)?.intent
}

function flag(k: Kernel, account: Account, instrumentId: string, reasonZh: string, detail: string, out: ProtectionOutcome): void {
  const origin = systemOrigin('startup:protect')
  const symbol = k.bus.instrument(instrumentId)?.displaySymbol ?? instrumentId
  k.ledger.append({ type: 'annotation', origin, subject: { accountId: account.accountId as `acct_${string}`, instrumentId }, payload: { kind: 'position.unprotected', instrumentId, reason: detail } })
  const scope = { type: 'account' as const, id: account.accountId }
  if (k.tstate.get(scope) === 'ACTIVE') k.tstate.set(scope, 'REDUCING', `仓位无止损：${symbol}（${reasonZh}）`, origin)
  k.events.publish('takeover.alert', { phase: 'protection', accountId: account.accountId, instrumentId, reason: detail })
  out.unprotected.push({ instrumentId, reason: detail })
}

function transient(problem: { name?: string; retryable?: boolean; ruleHits?: Array<{ code: string }> } | undefined): boolean {
  if (!problem) return false
  return problem.retryable === true || problem.name === 'STALE_PRICE' || (problem.ruleHits ?? []).some((h) => h.code === 'STALE_PRICE')
}

/**
 * 领养 + 保护审计。`final` = 这是最后一次重试：瞬时失败也按失败处理（REDUCING）。
 * 读：本地订单表、订单记录里的意图、场所的未结单与持仓。写：只经 TradingService 的子单构造器 / 系统来源下单路径。
 */
export async function reconcileProtection(k: Kernel, account: Account, view: ProtectionView, opts: { final?: boolean } = {}): Promise<ProtectionOutcome> {
  const out: ProtectionOutcome = { adopted: [], replaced: [], unprotected: [], retry: [] }
  const live = account.mode === 'live'
  const now = k.clock.now()
  let local: Order[] = k.orders.list({ accountId: account.accountId, limit: 1000 })
  const hasChild = (parentId: string, role: 'sl' | 'tp'): boolean => local.some((o) => o.parentOrderId === parentId && o.tpslRole === role)

  // 1. 领养：场所上有、本地没有的只减仓触发单，且能按父单链接对上本地父单
  for (const row of view.openOrders) {
    if (!row.reduceOnly || !row.isTrigger) continue
    if (local.some((o) => o.venueOrderId === row.venueOrderId || (!!row.clientOrderId && o.clientOrderId === row.clientOrderId))) continue
    if (!row.parentVenueOrderId) continue // 不猜：没有父单链接的场所单不是我们能认的
    const parent = local.find((o) => o.venueOrderId === row.parentVenueOrderId && !o.parentOrderId)
    if (!parent) continue
    const role = roleOf(row.type)
    const intent = intentOf(k, parent.orderId)
    const leg = role === 'sl' ? intent?.tpsl?.stopLoss : intent?.tpsl?.takeProfit
    if (!intent || !leg || hasChild(parent.orderId, role)) continue
    if (live) { flag(k, account, parent.instrumentId, '场所上有止损但内核没有记录，需要人确认', `venue child ${row.venueOrderId} of ${parent.orderId} is not recorded locally`, out); continue }
    const child = k.trading.adoptVenueChild(parent, intent, { venueOrderId: row.venueOrderId, clientOrderId: row.clientOrderId }, role)
    if (child) { out.adopted.push(child.orderId); local = [child, ...local] }
  }

  // 2. 保护审计：意图带止损、已成交、从未有过止损子单、仓位还在且场所上没有反向止损单
  for (const parent of local) {
    if (parent.parentOrderId || parent.reduceOnly || now - parent.createdAt > WINDOW_MS) continue
    if (parent.status !== 'filled' && parent.status !== 'partially_filled' && !(parent.status === 'cancelled' && d.gt(d.D(parent.filledSize), d.ZERO))) continue
    const leg = intentOf(k, parent.orderId)?.tpsl?.stopLoss
    if (!leg || hasChild(parent.orderId, 'sl')) continue
    const derived = derivedStopClientOrderId(parent.clientOrderId)
    if (k.orders.byClientOrderId(derived)) continue
    const pos = view.positions.find((p) => p.instrumentId === parent.instrumentId)
    if (!pos || pos.side !== (parent.side === 'buy' ? 'long' : 'short') || !d.gt(d.D(pos.size), d.ZERO)) continue
    const closeSide = parent.side === 'buy' ? 'sell' : 'buy'
    // 按数量算覆盖（不是「有一张止损就算有」）：同一标的多笔开仓时，丢的那张止损只补没被覆盖的那部分
    const venueStops = view.openOrders.filter((r) => r.instrumentId === parent.instrumentId && r.reduceOnly && STOP.has(r.type) && r.side === closeSide)
    const localOnly = local.filter((o) => o.instrumentId === parent.instrumentId && o.reduceOnly && STOP.has(o.type) && o.side === closeSide && LIVE.has(o.status) && !venueStops.some((r) => r.venueOrderId === o.venueOrderId))
    const covered = [...venueStops.map((r) => d.D(r.size)), ...localOnly.map((o) => d.sub(d.D(o.size), d.D(o.filledSize)))].reduce((s, x) => d.add(s, x), d.ZERO)
    const uncovered = d.sub(d.D(pos.size), covered)
    if (!d.gt(uncovered, d.ZERO)) continue
    if (live) { flag(k, account, parent.instrumentId, '开仓时计划的止损没有挂上', `filled ${parent.orderId} has a stop-loss intent but no stop order`, out); continue }
    const size = d.str(d.min(d.D(parent.filledSize), uncovered))
    let problem: { name?: string; message?: string; retryable?: boolean; ruleHits?: Array<{ code: string }> } | undefined
    try {
      const r = await k.trading.placeProtectiveStop(parent, leg, size)
      if (r.skipped) continue
      if (r.order && r.order.status !== 'denied' && r.order.status !== 'rejected') { out.replaced.push(r.order.orderId); local = [r.order, ...local]; continue }
      problem = r.order?.problem ?? r.problem
    } catch (e) {
      problem = e instanceof KernelError ? e.problem : { message: e instanceof Error ? e.message : String(e), retryable: true }
    }
    if (transient(problem) && !opts.final) { out.retry.push(parent.orderId); continue }
    flag(k, account, parent.instrumentId, `补挂被拒：${problem?.message ?? '原因不明'}`, `protective stop for ${parent.orderId} was not placed: ${problem?.name ?? ''} ${problem?.message ?? ''}`.trim(), out)
  }
  return out
}
