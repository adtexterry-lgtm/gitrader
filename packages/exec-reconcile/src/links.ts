// SPDX-License-Identifier: CPAL-1.0
// 客户端单号 ↔ 场所单号的映射（含多次改单链）。
//
// 批次 6 的两个真问题都落在这里：
//   · Alpaca replace 之后场所会给新单一个新 id，内核按原 client id 会追到已 replaced 的旧单（CLOSE-B6-alpaca 决定 2）；
//   · IBKR 重启后只能靠 orderRef 找回已成交单（CLOSE-B6-ibkr）。
// 所以对账第一步不是比数量，而是先把「这条链上这张逻辑单在场所到底叫什么」算清楚；
// 链上有歧义时，后续所有按单号的比对都要降级成「需要人工」。
// 设计参照：nautilus_trader crates/live/src/execution/reconciliation.rs（targeted 单号查询前先确定归属客户端）@55c0e820
import type { AmendLink, Evidence, LinkResolution, LocalOrderView, ReconcileInput } from './types'

export interface LinkIndex {
  resolutions: LinkResolution[]
  byClientOrderId: Map<string, LinkResolution>
  byVenueOrderId: Map<string, LinkResolution>
  /** 被多条客户端单号认领的场所单号 → 认领者列表。 */
  conflicts: Map<string, string[]>
  /** 本地订单 id → 该单在场所的全部单号。 */
  venueIdsForOrder: Map<string, string[]>
}

function pushUnique(list: string[], value: string | null | undefined): void {
  if (typeof value !== 'string' || value === '') return
  if (!list.includes(value)) list.push(value)
}

function evidenceFor(res: LinkResolution, report: Evidence['report'], id: string, field: string, value: string): void {
  res.evidence.push({ report, id, field, value })
}

/**
 * 解析单号链。规则：
 *   1. 同一客户端单号下的链接按时间排序，依次收集 previousVenueOrderId 与 venueOrderId；
 *   2. 链上第一条改单 / 替换的 previousVenueOrderId 必须来自更早的链接，否则判 broken（链断）；
 *   3. 同一场所单号被两条链（或两条本地订单）认领 → 判 ambiguous，两条链都标；
 *   4. 链接声明的 orderId 与该客户端单号在账本里的订单不一致 → ambiguous（同一单号两个身份）。
 */
export function buildLinkIndex(input: ReconcileInput): LinkIndex {
  const links = input.links ?? []
  const ordersByClient = new Map<string, LocalOrderView>()
  for (const order of input.local.orders) ordersByClient.set(order.clientOrderId, order)
  const orderIds = new Set(input.local.orders.map((o) => o.orderId))

  const byClientLinks = new Map<string, AmendLink[]>()
  for (const link of links) {
    const bucket = byClientLinks.get(link.clientOrderId)
    if (bucket) bucket.push(link)
    else byClientLinks.set(link.clientOrderId, [link])
  }
  for (const bucket of byClientLinks.values()) bucket.sort((a, b) => a.ts - b.ts)

  const clientOrderIds = new Set<string>([...ordersByClient.keys(), ...byClientLinks.keys()])
  const resolutions: LinkResolution[] = []
  for (const clientOrderId of clientOrderIds) {
    const order = ordersByClient.get(clientOrderId)
    const chain = byClientLinks.get(clientOrderId) ?? []
    const res: LinkResolution = {
      clientOrderId,
      ...(order ? { orderId: order.orderId } : {}),
      venueOrderIds: [],
      ambiguous: false,
      broken: false,
      evidence: [],
    }
    const produced = new Set<string>()
    let first = true
    for (const link of chain) {
      const previous = link.previousVenueOrderId ?? null
      if (previous !== null && first && link.kind !== 'submit') {
        // 链上第一位要引用的上一位单号没有任何记录能证明它属于我们 → 链断
        res.broken = true
        evidenceFor(res, 'links', clientOrderId, `$[${link.kind}].previousVenueOrderId`, previous)
      }
      if (previous !== null && !produced.has(previous) && chain.length > 1) {
        // 引用了一个本链没产生过的单号（可能是更早的会话），记录但不当歧义
        evidenceFor(res, 'links', clientOrderId, 'chain_gap', previous)
      }
      pushUnique(res.venueOrderIds, previous)
      pushUnique(res.venueOrderIds, link.venueOrderId)
      if (typeof link.venueOrderId === 'string' && link.venueOrderId !== '') produced.add(link.venueOrderId)
      if (link.orderId !== undefined && order !== undefined && link.orderId !== order.orderId) {
        res.ambiguous = true
        evidenceFor(res, 'links', clientOrderId, 'orderId', `${link.orderId} ≠ 账本 ${order.orderId}`)
      }
      if (link.orderId !== undefined && order === undefined && !orderIds.has(link.orderId)) {
        evidenceFor(res, 'links', clientOrderId, 'orderId', `${link.orderId}（账本无此单）`)
      }
      evidenceFor(res, 'links', clientOrderId, `link.${link.kind}.ts`, String(link.ts))
      first = false
    }
    if (order) {
      pushUnique(res.venueOrderIds, order.venueOrderId ?? null)
      evidenceFor(res, 'local.orders', order.orderId, 'venueOrderId', String(order.venueOrderId ?? ''))
    }
    if (res.venueOrderIds.length > 1) {
      evidenceFor(res, 'links', clientOrderId, 'venueOrderIds', res.venueOrderIds.join(' → '))
    }
    resolutions.push(res)
  }

  // 单号归属冲突：一个场所单号被多条链认领（含同一 orderId 的重复认领不算）
  const claims = new Map<string, Array<{ clientOrderId: string; orderId?: string }>>()
  for (const res of resolutions) {
    for (const id of res.venueOrderIds) {
      const bucket = claims.get(id)
      const claim = { clientOrderId: res.clientOrderId, ...(res.orderId ? { orderId: res.orderId } : {}) }
      if (bucket) bucket.push(claim)
      else claims.set(id, [claim])
    }
  }
  const conflicts = new Map<string, string[]>()
  for (const [venueOrderId, claimers] of claims) {
    const distinctOrders = new Set(claimers.map((c) => c.orderId ?? `client:${c.clientOrderId}`))
    const distinctClients = new Set(claimers.map((c) => c.clientOrderId))
    if (distinctClients.size > 1 && distinctOrders.size > 1) {
      conflicts.set(venueOrderId, [...distinctClients])
      for (const res of resolutions) {
        if (res.venueOrderIds.includes(venueOrderId)) {
          res.ambiguous = true
          evidenceFor(res, 'links', res.clientOrderId, 'claim', `${venueOrderId} 被 ${[...distinctClients].join(', ')} 认领`)
        }
      }
    }
  }

  const byClientOrderId = new Map<string, LinkResolution>()
  const byVenueOrderId = new Map<string, LinkResolution>()
  for (const res of resolutions) {
    byClientOrderId.set(res.clientOrderId, res)
    for (const id of res.venueOrderIds) if (!byVenueOrderId.has(id)) byVenueOrderId.set(id, res)
  }
  const venueIdsForOrder = new Map<string, string[]>()
  for (const res of resolutions) {
    if (res.orderId === undefined) continue
    const existing = venueIdsForOrder.get(res.orderId) ?? []
    for (const id of res.venueOrderIds) pushUnique(existing, id)
    venueIdsForOrder.set(res.orderId, existing)
  }
  return { resolutions, byClientOrderId, byVenueOrderId, conflicts, venueIdsForOrder }
}

/** 某张本地订单在场所可能使用的全部单号（自身 + 改单链）。 */
export function venueIdsOf(index: LinkIndex, order: LocalOrderView): string[] {
  const out = index.venueIdsForOrder.get(order.orderId) ?? []
  const merged = [...out]
  pushUnique(merged, order.venueOrderId ?? null)
  return merged
}

/** 这条链上有没有链断 / 歧义，供上层决定是否降级结论。 */
export function linkIsUnreliable(index: LinkIndex, clientOrderId: string): boolean {
  const res = index.byClientOrderId.get(clientOrderId)
  return res !== undefined && (res.broken || res.ambiguous)
}
