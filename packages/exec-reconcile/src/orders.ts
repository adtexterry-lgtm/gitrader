// SPDX-License-Identifier: CPAL-1.0
// 订单差异分类：本地挂单 ↔ 场所挂单 / 历史订单报告。
//
// 判定顺序刻意做成「先查再判」：
//   1. 挂单报告里有的，逐字段比（状态 / 累计成交量 / 价格 / 只减仓）；
//   2. 挂单报告没有的，先看历史订单报告（已成 / 已撤 / 被拒），再看到达这个单的成交；
//   3. 都没有的，先看是不是还在场所回报延迟窗口内（是 → 等一等，不下结论）；
//   4. 窗口外、场所又给不出历史订单的，只能标「需要人工」，绝不写成「丢失」。
// 第 3、4 条对应批次 6 的两个真问题：IOC 部分成交被误判成拒单、IBKR 重启后 found:false。
// 设计参照：nautilus_trader crates/live/src/execution/manager.rs（check_open_orders → 定向查询 → 再结论）@55c0e820
import { adviceFor, severityFor } from './advice'
import { normalizeDecimal, signDecimal, subtractDecimal } from './decimal'
import { localFilledSum } from './fills'
import { type LinkIndex, venueIdsOf } from './links'
import { classifyVenueStatus } from './status'
import { driftBps, isWithinLatency, priceDriftBeyondBps, sizeEqual, type ResolvedOptions } from './tolerance'
import type {
  ActionKind, Advice, Evidence, Finding, FindingCode, LocalOrderView, ReconcileInput, Severity, VenueOrderView,
} from './types'
import { isTerminalStatus } from './types'

export interface OrderCoverage {
  openOrdersAvailable: boolean
  historyAvailable: boolean
  fillsAvailable: boolean
}

export interface OrderClassificationResult {
  findings: Finding[]
  /** 已与本地订单对上号的场所单号（含改单链上的旧号）。 */
  mappedVenueIds: Set<string>
  /** 本地是否有订单认领了这个场所单号。 */
  claimedVenueIds: Set<string>
}

function ev(report: Evidence['report'], id: string, field: string, value: string): Evidence {
  return { report, id, field, value }
}

/** 建议覆盖：只覆盖 action / why，requiresHuman 一律不许被改成 false。 */
function adviceOverride(opts?: { why?: string; action?: ActionKind }): Partial<Advice> | undefined {
  if (opts === undefined) return undefined
  const override: Partial<Advice> = {}
  if (opts.action !== undefined) override.action = opts.action
  if (opts.why !== undefined) override.why = opts.why
  return Object.keys(override).length > 0 ? override : undefined
}

function makeFinding(
  code: FindingCode,
  accountId: string,
  subject: Omit<Finding['subject'], 'accountId'>,
  detail: string,
  evidence: Evidence[],
  opts?: { severity?: Severity; tags?: string[]; why?: string; action?: ActionKind; inferred?: true; basis?: string[] },
): Finding {
  return {
    code,
    severity: severityFor(code, opts?.severity),
    subject: { accountId, ...subject },
    detail,
    advice: adviceFor(code, adviceOverride(opts)),
    evidence,
    ...(opts?.tags ? { tags: opts.tags } : {}),
    ...(opts?.inferred ? { inferred: true as const } : {}),
    ...(opts?.basis ? { basis: opts.basis } : {}),
  }
}

function orderEvidence(order: LocalOrderView): Evidence[] {
  return [
    ev('local.orders', order.orderId, 'status', order.status),
    ev('local.orders', order.orderId, 'filledSize', order.filledSize),
    ev('local.orders', order.orderId, 'size', order.size),
  ]
}

function venueEvidence(source: 'open' | 'history', order: VenueOrderView): Evidence[] {
  const report: Evidence['report'] = source === 'open' ? 'venue.openOrders' : 'venue.historyOrders'
  const out: Evidence[] = [
    ev(report, order.venueOrderId, 'status', order.status),
    ...(order.filledSize !== undefined ? [ev(report, order.venueOrderId, 'filledSize', order.filledSize)] : []),
  ]
  if (order.clientOrderId) out.push(ev(report, order.venueOrderId, 'clientOrderId', order.clientOrderId))
  return out
}

/** 场所视图里能按单号 / 客户端单号找到的订单。 */
interface VenueLookup {
  open: VenueOrderView[]
  history: VenueOrderView[]
  fillsByVenueOrderId: Map<string, ReconcileInput['venue']['fills'][number][]>
}

function indexVenue(input: ReconcileInput): VenueLookup {
  const fillsByVenueOrderId = new Map<string, ReconcileInput['venue']['fills'][number][]>()
  for (const fill of input.venue.fills) {
    const bucket = fillsByVenueOrderId.get(fill.venueOrderId)
    if (bucket) bucket.push(fill)
    else fillsByVenueOrderId.set(fill.venueOrderId, [fill])
  }
  return {
    open: [...input.venue.openOrders],
    history: [...(input.venue.historyOrders ?? [])],
    fillsByVenueOrderId,
  }
}

function findIn(list: VenueOrderView[], ids: readonly string[], clientOrderId: string): VenueOrderView | undefined {
  const byId = list.find((v) => ids.includes(v.venueOrderId))
  if (byId) return byId
  return list.find((v) => typeof v.clientOrderId === 'string' && v.clientOrderId !== '' && v.clientOrderId === clientOrderId)
}

/** 订单差异分类主入口。 */
export function classifyOrders(
  input: ReconcileInput,
  index: LinkIndex,
  opts: ResolvedOptions,
  coverage: OrderCoverage,
): OrderClassificationResult {
  const findings: Finding[] = []
  const accountId = input.local.accountId
  const venue = indexVenue(input)
  const mappedVenueIds = new Set<string>()
  const claimedVenueIds = new Set<string>()
  const ordersById = new Map(input.local.orders.map((o) => [o.orderId, o]))
  const terminalOrders = input.local.orders.filter((o) => isTerminalStatus(o.status))
  const openOrders = input.local.orders.filter((o) => !isTerminalStatus(o.status))

  // ---- 0. 单号链本身 ---------------------------------------------------------
  for (const res of index.resolutions) {
    const base = { clientOrderId: res.clientOrderId, ...(res.orderId ? { orderId: res.orderId } : {}) }
    const chainMissingOrder = res.orderId === undefined || !ordersById.has(res.orderId)
    if (res.ambiguous) {
      findings.push(makeFinding('amend_chain_ambiguous', accountId, base,
        `客户端单号 ${res.clientOrderId} 的场所单号链有歧义（${res.venueOrderIds.join(' → ')}），按单号认单会认错`,
        res.evidence, { tags: chainMissingOrder ? ['chain_without_order'] : undefined }))
    } else if (res.broken) {
      findings.push(makeFinding('amend_chain_broken', accountId, base,
        `客户端单号 ${res.clientOrderId} 的改单链缺一段记录（上一位场所单号没有对应的下单 / 改单）`,
        res.evidence))
    } else if (res.venueOrderIds.length > 1) {
      findings.push(makeFinding('amend_chain_resolved', accountId, base,
        `客户端单号 ${res.clientOrderId} 对应 ${res.venueOrderIds.length} 个场所单号：${res.venueOrderIds.join(' → ')}`,
        res.evidence))
    }
  }
  const reportedVenueIdConflicts = new Set<string>()
  for (const [venueOrderId, claimers] of index.conflicts) {
    reportedVenueIdConflicts.add(venueOrderId)
    findings.push(makeFinding('order_venue_id_conflict', accountId, { venueOrderId, clientOrderId: claimers[0] },
      `场所单号 ${venueOrderId} 被 ${claimers.join('、')} 同时认领，成交会记到错误的订单上`,
      [ev('links', venueOrderId, 'claim', claimers.join(','))]))
  }
  // 两张本地订单共用同一个场所单号（账本自身的脏数据）
  const seenVenueId = new Map<string, string>()
  for (const order of input.local.orders) {
    for (const id of venueIdsOf(index, order)) {
      const owner = seenVenueId.get(id)
      if (owner !== undefined && owner !== order.orderId) {
        // 同一个场所单号只报一条（上一个循环已经报过就跳过）
        if (reportedVenueIdConflicts.has(id)) continue
        reportedVenueIdConflicts.add(id)
        findings.push(makeFinding('order_venue_id_conflict', accountId,
          { orderId: order.orderId, clientOrderId: order.clientOrderId, venueOrderId: id },
          `场所单号 ${id} 同时挂在本地订单 ${owner} 与 ${order.orderId} 上`,
          [ev('local.orders', owner, 'venueOrderId', id), ev('local.orders', order.orderId, 'venueOrderId', id)]))
      } else if (owner === undefined) seenVenueId.set(id, order.orderId)
    }
  }

  // ---- 1. 本地挂着的单 -------------------------------------------------------
  for (const order of openOrders) {
    const ids = venueIdsOf(index, order)
    const open = findIn(venue.open, ids, order.clientOrderId)
    const chain = index.byClientOrderId.get(order.clientOrderId)
    const unreliableChain = chain !== undefined && (chain.broken || chain.ambiguous)
    if (open) {
      mappedVenueIds.add(open.venueOrderId)
      claimedVenueIds.add(open.venueOrderId)
      const klass = classifyVenueStatus(open.status)
      const localFilled = order.filledSize
      // 场所挂单报告不带累计成交量时整段跳过：这种情形的缺口由成交层（fills.ts）负责
      const sizeGap = open.filledSize !== undefined && !sizeEqual(open.filledSize, localFilled, opts.sizeTolerance)
      if (open.filledSize !== undefined && sizeGap && signDecimal(subtractDecimal(open.filledSize, localFilled)) > 0) {
        const venueFilled = open.filledSize
        const ledgerSum = localFilledSum(input, order.orderId)
        const unrecorded = !sizeEqual(subtractDecimal(venueFilled, ledgerSum), '0', opts.sizeTolerance)
        // 成交明细里也没这笔 → 交给成交层出 fill_missing_inferred / fill_missing_unexplained，这里不重复报
        if (!unrecorded) {
          findings.push(makeFinding('order_filled_size_drift', accountId,
            { orderId: order.orderId, clientOrderId: order.clientOrderId, venueOrderId: open.venueOrderId, instrumentId: order.instrumentId },
            `场所累计成交 ${normalizeDecimal(venueFilled)} 多于账本订单字段 ${normalizeDecimal(localFilled)}，但账本该单成交明细合计 ${normalizeDecimal(ledgerSum)} 已对上：只是订单累计成交量字段没跟上`,
            [...orderEvidence(order), ...venueEvidence('open', open)],
            {
              tags: ['ledger_order_field_stale'],
              action: 'adopt_venue_state',
              why: '成交明细已入账，只是订单累计成交量字段没跟上；不要再补记成交。',
            }))
        }
      } else if (open.filledSize !== undefined && sizeGap) {
        const venueFilled = open.filledSize
        findings.push(makeFinding('order_filled_size_drift', accountId,
          { orderId: order.orderId, clientOrderId: order.clientOrderId, venueOrderId: open.venueOrderId, instrumentId: order.instrumentId },
          `账本累计成交 ${normalizeDecimal(localFilled)} 多于场所 ${normalizeDecimal(venueFilled)}：改单后场所把该单的已成交量重置了，成交可能记在改单前的单号上`,
          [...orderEvidence(order), ...venueEvidence('open', open)],
          { tags: ['venue_reset_after_amend'] }))
      }
      const localLive = order.status === 'open' || order.status === 'partially_filled'
      const venueLive = klass === 'open' || klass === 'partially_filled'
      if (!venueLive) {
        findings.push(makeFinding('order_state_drift', accountId,
          { orderId: order.orderId, clientOrderId: order.clientOrderId, venueOrderId: open.venueOrderId },
          `账本状态 ${order.status}，场所挂单报告状态 ${open.status}（归一为 ${klass}）`,
          [...orderEvidence(order), ...venueEvidence('open', open)],
          klass === 'unknown'
            ? { action: 'query_order_status', why: '场所状态读不出来，不猜；先按单号查一次。' }
            : undefined))
      } else if (localLive && klass === 'partially_filled' && order.status === 'open' && !sizeGap) {
        findings.push(makeFinding('order_state_drift', accountId,
          { orderId: order.orderId, clientOrderId: order.clientOrderId, venueOrderId: open.venueOrderId },
          `场所已部分成交（${open.status}），账本仍记为 ${order.status}`,
          [...orderEvidence(order), ...venueEvidence('open', open)]))
      }
      if (typeof open.price === 'string' && typeof order.price === 'string' && open.price !== '' && order.price !== '') {
        if (priceDriftBeyondBps(open.price, order.price, opts.priceToleranceBps)) {
          findings.push(makeFinding('order_price_drift', accountId,
            { orderId: order.orderId, clientOrderId: order.clientOrderId, venueOrderId: open.venueOrderId },
            `价格不符：账本 ${normalizeDecimal(order.price)}、场所 ${normalizeDecimal(open.price)}，相差 ${driftBps(open.price, order.price)} bp（容差 ${opts.priceToleranceBps} bp）`,
            [...orderEvidence(order), ...venueEvidence('open', open)]))
        }
      }
      if (typeof open.reduceOnly === 'boolean' && typeof order.reduceOnly === 'boolean' && open.reduceOnly !== order.reduceOnly) {
        findings.push(makeFinding('order_reduce_only_drift', accountId,
          { orderId: order.orderId, clientOrderId: order.clientOrderId, venueOrderId: open.venueOrderId },
          `只减仓标记不符：账本 ${String(order.reduceOnly)}、场所 ${String(open.reduceOnly)}`,
          [...orderEvidence(order), ...venueEvidence('open', open)]))
      }
      continue
    }

    // 挂单报告里没有：历史订单 / 成交 / 延迟窗口
    const history = findIn(venue.history, ids, order.clientOrderId)
    if (history) {
      mappedVenueIds.add(history.venueOrderId)
      claimedVenueIds.add(history.venueOrderId)
      const klass = classifyVenueStatus(history.status)
      const base = { orderId: order.orderId, clientOrderId: order.clientOrderId, venueOrderId: history.venueOrderId, instrumentId: order.instrumentId }
      const evidence = [...orderEvidence(order), ...venueEvidence('history', history)]
      if (klass === 'filled') {
        const partialTerminal = history.filledSize !== undefined && history.origSize !== undefined &&
          signDecimal(subtractDecimal(history.filledSize, history.origSize)) < 0
        findings.push(makeFinding('local_open_venue_filled', accountId, base,
          `场所历史订单显示已成（${history.status}，成交量 ${normalizeDecimal(history.filledSize ?? '?')}），账本仍为 ${order.status}` +
            (partialTerminal ? `；但成交量 ${normalizeDecimal(history.filledSize ?? '0')} 小于原量 ${normalizeDecimal(history.origSize ?? '0')}，终态「已成」不等于整单成交` : ''),
          evidence, partialTerminal ? {
            tags: ['terminal_status_partial'],
            action: 'query_order_status',
            why: '终态写着已成，成交量却小于原量，可能是部分成交后撤单；先按单号查成交明细再改状态。',
          } : undefined))
      } else if (klass === 'cancelled') {
        findings.push(makeFinding('local_open_venue_cancelled', accountId, base,
          `场所历史订单显示已撤 / 已过期（${history.status}），账本仍为 ${order.status}`,
          evidence))
      } else if (klass === 'rejected') {
        findings.push(makeFinding('local_open_venue_rejected', accountId, base,
          `场所历史订单显示被拒（${history.status}），账本没有落 problem`,
          evidence))
      } else if (klass === 'partially_filled') {
        findings.push(makeFinding('local_open_venue_partially_recorded', accountId, base,
          `场所历史订单只有部分成交（${history.status}），没有终结状态，账本仍为 ${order.status}`,
          evidence))
      } else {
        findings.push(makeFinding('local_open_venue_missing', accountId, base,
          `场所历史订单里有这张单但状态读不出来（${history.status}），不猜`,
          evidence, { tags: ['status_unreadable'] }))
      }
      continue
    }

    const fillsHere = ids.flatMap((id) => venue.fillsByVenueOrderId.get(id) ?? [])
    if (fillsHere.length > 0) {
      for (const id of ids) mappedVenueIds.add(id)
      findings.push(makeFinding('local_open_venue_partially_recorded', accountId,
        { orderId: order.orderId, clientOrderId: order.clientOrderId, instrumentId: order.instrumentId },
        `订单报告里找不到这张单，但有 ${fillsHere.length} 笔成交落在它的单号上（${ids.join(' / ')}）`,
        [
          ...orderEvidence(order),
          ...fillsHere.map((f) => ev('venue.fills', f.venueFillId, 'size', f.size)),
        ], { tags: ['fills_only'] }))
      continue
    }

    if (!coverage.openOrdersAvailable) {
      findings.push(makeFinding('local_open_venue_missing', accountId,
        { orderId: order.orderId, clientOrderId: order.clientOrderId, instrumentId: order.instrumentId },
        `场所本次给不出挂单报告：本地挂着的这张单在场所是什么状态无从判断（不能写成「场所没有」）`,
        [...orderEvidence(order), ev('options', 'venue.unavailable', 'openOrders', 'true')],
        { tags: ['coverage_limited', 'open_orders_unavailable'],
          why: '该场所本次不提供挂单报告，未匹配到的本地挂单不能判定为已撤、已成或丢失，只能人工核。' }))
      continue
    }
    if (!coverage.historyAvailable) {
      findings.push(makeFinding('local_open_venue_missing', accountId,
        { orderId: order.orderId, clientOrderId: order.clientOrderId, instrumentId: order.instrumentId },
        `场所挂单报告与成交里都没有这张单，且该场所不提供历史订单报告：无法判定它已撤、已成还是从未到达场所`,
        [...orderEvidence(order), ev('options', 'venue.unavailable', 'historyOrders', 'true')],
        { tags: ['coverage_limited'], why: '该场所不提供历史订单，本地挂单在场所看不到时无法区分已撤 / 已成 / 丢失，只能人工核。' }))
      continue
    }
    if (isWithinLatency(order.updatedAt ?? order.createdAt, opts)) {
      findings.push(makeFinding('order_unverified_within_latency', accountId,
        { orderId: order.orderId, clientOrderId: order.clientOrderId, instrumentId: order.instrumentId },
        `下单后 ${opts.now - (order.updatedAt ?? order.createdAt)} ms，仍在场所回报延迟窗口 ${opts.venueLatencyMs} + 时钟偏差 ${opts.clockSkewMs} ms 内，场所还没看到属正常`,
        [...orderEvidence(order), ev('options', 'options.venueLatencyMs', 'now', String(opts.now))]))
      continue
    }
    findings.push(makeFinding('local_open_venue_missing', accountId,
      { orderId: order.orderId, clientOrderId: order.clientOrderId, instrumentId: order.instrumentId },
      `超出回报延迟窗口仍查不到：挂单报告、历史订单、成交都没有这张单（本地 ${order.status}，下单于 ${new Date(order.createdAt).toISOString()}）`,
      [...orderEvidence(order)], { tags: unreliableChain ? ['chain_unreliable'] : undefined }))
  }

  // ---- 2. 本地已终结、场所还在挂 --------------------------------------------
  for (const order of terminalOrders) {
    const ids = venueIdsOf(index, order)
    const open = findIn(venue.open, ids, order.clientOrderId)
    if (!open) continue
    mappedVenueIds.add(open.venueOrderId)
    claimedVenueIds.add(open.venueOrderId)
    findings.push(makeFinding('local_terminal_venue_open', accountId,
      { orderId: order.orderId, clientOrderId: order.clientOrderId, venueOrderId: open.venueOrderId, instrumentId: order.instrumentId },
      `账本记 ${order.status}，场所仍挂着这张单（${open.status}，剩余 ${normalizeDecimal(open.size ?? '?')}）`,
      [...orderEvidence(order), ...venueEvidence('open', open)]))
  }

  // ---- 3. 场所有、本地无 -----------------------------------------------------
  const localClientIds = new Set(input.local.orders.map((o) => o.clientOrderId))
  for (const open of input.venue.openOrders) {
    if (claimedVenueIds.has(open.venueOrderId)) continue
    const owner = index.byVenueOrderId.get(open.venueOrderId)
    const owned = typeof open.clientOrderId === 'string' && open.clientOrderId !== '' &&
      (localClientIds.has(open.clientOrderId) || (opts.ownClientOrderIdPrefixes.length > 0 && opts.ownClientOrderIdPrefixes.some((p) => open.clientOrderId!.startsWith(p))))
    const base = {
      venueOrderId: open.venueOrderId,
      ...(open.clientOrderId ? { clientOrderId: open.clientOrderId } : {}),
      instrumentId: open.instrumentId,
      ...(owner?.orderId ? { orderId: owner.orderId } : {}),
    }
    if (owner !== undefined || owned || opts.ownClientOrderIdPrefixes.length === 0) {
      findings.push(makeFinding('venue_order_unmapped', accountId, base,
        `场所有这张挂单（${open.status}，${open.side} ${open.instrumentId} 剩余 ${normalizeDecimal(open.size ?? '?')}），账本没有订单认领它${open.clientOrderId ? `（客户端单号 ${open.clientOrderId}）` : '（场所没回客户端单号）'}`,
        venueEvidence('open', open),
        { tags: open.clientOrderId ? ['client_id_unclaimed'] : ['client_id_missing'] }))
    } else {
      findings.push(makeFinding('venue_order_external', accountId, base,
        `这张挂单的客户端单号 ${open.clientOrderId} 不属于本系统前缀（${opts.ownClientOrderIdPrefixes.join(' / ')}），按外部下单处理`,
        venueEvidence('open', open)))
    }
  }

  return { findings, mappedVenueIds, claimedVenueIds }
}
