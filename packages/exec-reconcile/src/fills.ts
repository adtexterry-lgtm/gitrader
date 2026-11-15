// SPDX-License-Identifier: CPAL-1.0
// 成交差异：重复到达、同号冲突、指向未知订单、成交量缺口（推断成交）。
//
// 去重键策略（这是批次 6 收口里最实在的一条）：
//   第一优先 = 场所成交号（venueFillId）。各连接器给的号源不同：
//     Binance `id`、OKX `tradeId`、Bybit `execId`、Bitget `tradeId`、Gate `id`、
//     Hyperliquid `tid`、Alpaca `<order_id>:<累计成交量>`、IBKR `execId`（含更正段）。
//   场所成交号缺失时的回退键 = 单号 + 时间 + 数量 + 价格（合成键），
//     风险：两笔真实成交若这四项全同会被误判成同一笔。
//   累计量键（Alpaca 那种）风险：同一笔成交在 REST 与私有流里的时间戳不一定相等，
//     同号不同时间会被判成冲突（CLOSE-B6-alpaca 决定 1 说的就是这件事）。
// 设计参照：nautilus_trader crates/execution/src/reconciliation/ids.rs（确定性成交号，重放可去重）@55c0e820
import { adviceFor, severityFor } from './advice'
import { absDecimal, addDecimal, compareDecimal, equalDecimal, isZeroDecimal, normalizeDecimal, signDecimal, subtractDecimal, sumDecimal } from './decimal'
import type { LinkIndex } from './links'
import { venueIdsOf } from './links'
import { classifyVenueStatus, isVenueStatusLive } from './status'
import { isBeyondClockSkew, isBeforeLookback, sizeEqual, type ResolvedOptions } from './tolerance'
import type {
  Evidence, FillDedupeResult, FillKeyUse, Finding, FindingCode, InferredFill, LocalFillView,
  LocalOrderView, ReconcileInput, Severity, VenueFillView, VenueOrderView,
} from './types'

export interface FillCoverage {
  fillsAvailable: boolean
}

export interface FillClassificationResult {
  dedupe: FillDedupeResult
  findings: Finding[]
  inferredFills: InferredFill[]
  /** 账本里同一成交号出现多次（已入账的重复），按 orderId 记一份，供上层做持仓解释。 */
  ledgerDuplicateOrderIds: string[]
}

function ev(report: Evidence['report'], id: string, field: string, value: string): Evidence {
  return { report, id, field, value }
}

function makeFinding(
  code: FindingCode,
  accountId: string,
  subject: Omit<Finding['subject'], 'accountId'>,
  detail: string,
  evidence: Evidence[],
  opts?: { severity?: Severity; tags?: string[]; why?: string; inferred?: true; basis?: string[] },
): Finding {
  return {
    code,
    severity: severityFor(code, opts?.severity),
    subject: { accountId, ...subject },
    detail,
    advice: adviceFor(code, opts?.why === undefined ? undefined : { why: opts.why }),
    evidence,
    ...(opts?.tags ? { tags: opts.tags } : {}),
    ...(opts?.inferred ? { inferred: true as const } : {}),
    ...(opts?.basis ? { basis: opts.basis } : {}),
  }
}

const CUMULATIVE_KEY_RE = /^([^:]+):\d+(?:\.\d+)?$/

/** 判定一条成交该用哪种键，并把键的风险写清。 */
export function fillKeyFor(fill: VenueFillView, knownVenueOrderIds: ReadonlySet<string>): FillKeyUse {
  const id = fill.venueFillId
  if (typeof id === 'string' && id !== '') {
    if (CUMULATIVE_KEY_RE.test(id) && knownVenueOrderIds.has(id.slice(0, id.indexOf(':')))) {
      return {
        venueFillId: id, key: id, kind: 'cumulative_quantity', venueOrderId: fill.venueOrderId,
        risk: '成交号 = 订单号 + 累计成交量：同一笔成交跨源时间戳不一致时会被判成冲突，累计量相同的两笔真实成交会被合并',
      }
    }
    return { venueFillId: id, key: id, kind: 'venue_fill_id', venueOrderId: fill.venueOrderId }
  }
  const fallback = `${fill.venueOrderId}|${fill.ts}|${normalizeDecimal(fill.size)}|${normalizeDecimal(fill.price)}`
  return {
    venueFillId: id, key: `fallback:${fallback}`, kind: 'fallback_composite', venueOrderId: fill.venueOrderId,
    risk: '场所没给成交号，只能用「单号 + 时间 + 数量 + 价格」合成键：两笔真实成交这四项全同时会被误判成重复',
  }
}

function sameFill(a: VenueFillView, b: VenueFillView, tolerance: string): boolean {
  return a.venueOrderId === b.venueOrderId
    && a.side === b.side
    && a.ts === b.ts
    && sizeEqual(a.size, b.size, tolerance)
    && equalDecimal(a.price, b.price)
    && (a.instrumentId === b.instrumentId)
}

/** 除时间戳以外全部相同（时间戳在时钟偏差内的同号回报按重复处理）。 */
function sameFillExceptTs(a: VenueFillView, b: VenueFillView, tolerance: string): boolean {
  return a.venueOrderId === b.venueOrderId
    && a.side === b.side
    && sizeEqual(a.size, b.size, tolerance)
    && equalDecimal(a.price, b.price)
    && (a.instrumentId === b.instrumentId)
}

/** 成交去重：场所报告里同一键多次到达时的分类。 */
export function dedupeFills(input: ReconcileInput, opts: ResolvedOptions): { dedupe: FillDedupeResult; findings: Finding[] } {
  const accountId = input.local.accountId
  const knownVenueOrderIds = new Set<string>([
    ...input.local.orders.map((o) => o.venueOrderId ?? '').filter((x) => x !== ''),
    ...(input.links ?? []).flatMap((l) => [l.venueOrderId ?? '', l.previousVenueOrderId ?? '']).filter((x) => x !== ''),
    ...input.venue.openOrders.map((o) => o.venueOrderId),
    ...(input.venue.historyOrders ?? []).map((o) => o.venueOrderId),
  ])
  const keys: FillKeyUse[] = []
  const groups = new Map<string, { key: FillKeyUse; fills: VenueFillView[] }>()
  for (const fill of input.venue.fills) {
    const key = fillKeyFor(fill, knownVenueOrderIds)
    keys.push(key)
    const group = groups.get(key.key)
    if (group) group.fills.push(fill)
    else groups.set(key.key, { key, fills: [fill] })
  }

  const accepted: VenueFillView[] = []
  const duplicates: FillDedupeResult['duplicates'] = []
  const conflicts: FillDedupeResult['conflicts'] = []
  const findings: Finding[] = []

  for (const [key, group] of groups) {
    const [first, ...rest] = group.fills
    if (!first) continue
    const acceptedHere = group.key.kind !== 'fallback_composite' || opts.dedupeFallback === 'accept_with_risk'
    const identical = rest.filter((f) => sameFill(first, f, opts.sizeTolerance))
    // 同一成交号、只差毫秒级时间戳（在允许的时钟偏差内）：按重复处理，不当冲突
    const tsDrift = group.key.kind === 'fallback_composite'
      ? []
      : rest.filter((f) => !sameFill(first, f, opts.sizeTolerance)
        && sameFillExceptTs(first, f, opts.sizeTolerance)
        && Math.abs(f.ts - first.ts) <= opts.clockSkewMs)
    const differing = rest.filter((f) => !identical.includes(f) && !tsDrift.includes(f))
    if (acceptedHere) accepted.push(first)
    if (identical.length > 0) {
      duplicates.push({ key, count: group.fills.length, fill: first })
      findings.push(makeFinding('fill_duplicate', accountId,
        { venueFillId: first.venueFillId, venueOrderId: first.venueOrderId, instrumentId: first.instrumentId, ...(first.clientOrderId ? { clientOrderId: first.clientOrderId } : {}) },
        `成交号 ${first.venueFillId === '' ? '（缺失）' : first.venueFillId} 共到达 ${group.fills.length} 次，内容一致，去重丢弃重复的 ${identical.length} 条`,
        [
          ev('venue.fills', first.venueFillId || key, 'size', first.size),
          ev('venue.fills', first.venueFillId || key, 'count', String(group.fills.length)),
        ], { tags: [group.key.kind] }))
    }
    if (tsDrift.length > 0) {
      duplicates.push({ key, count: tsDrift.length + 1, fill: first })
      const driftText = tsDrift.map((f) => `${Math.abs(f.ts - first.ts)} ms`).join(' / ')
      findings.push(makeFinding('fill_duplicate', accountId,
        { venueFillId: first.venueFillId, venueOrderId: first.venueOrderId, instrumentId: first.instrumentId, ...(first.clientOrderId ? { clientOrderId: first.clientOrderId } : {}) },
        `成交号 ${first.venueFillId === '' ? '（缺失）' : first.venueFillId} 同号同量同价，只差时间戳（相差 ${driftText}，在允许的时钟偏差 ${opts.clockSkewMs} ms 内），按重复处理；内核对同一成交号要求时间完全相等，否则会停账户`,
        [
          ev('venue.fills', first.venueFillId || key, 'ts', `${first.ts} / ${tsDrift.map((f) => String(f.ts)).join(' / ')}`),
          ev('venue.fills', first.venueFillId || key, 'ts_drift_ms', driftText),
        ], { tags: [group.key.kind, 'ts_drift_within_skew'] }))
    }
    for (const other of differing) {
      conflicts.push({ key, existing: first, incoming: other })
      findings.push(makeFinding('fill_conflict', accountId,
        { venueFillId: first.venueFillId || key, venueOrderId: first.venueOrderId, instrumentId: first.instrumentId },
        `同一成交号 ${first.venueFillId || key} 两条回报内容不同：数量 ${normalizeDecimal(first.size)} vs ${normalizeDecimal(other.size)}、价格 ${normalizeDecimal(first.price)} vs ${normalizeDecimal(other.price)}、时间 ${first.ts} vs ${other.ts}`,
        [
          ev('venue.fills', key, 'size', `${normalizeDecimal(first.size)} / ${normalizeDecimal(other.size)}`),
          ev('venue.fills', key, 'price', `${normalizeDecimal(first.price)} / ${normalizeDecimal(other.price)}`),
          ev('venue.fills', key, 'ts', `${first.ts} / ${other.ts}`),
        ], { tags: [group.key.kind] }))
    }
    if (group.key.kind === 'fallback_composite') {
      findings.push(makeFinding('fill_dedupe_key_fallback', accountId,
        { venueOrderId: first.venueOrderId, instrumentId: first.instrumentId, ...(first.clientOrderId ? { clientOrderId: first.clientOrderId } : {}) },
        `订单 ${first.venueOrderId} 的成交缺场所成交号，本键（${key}）覆盖 ${group.fills.length} 条成交；${acceptedHere ? '已按回退键接受其中 1 条' : '按配置不接受，交给人'}`,
        [ev('venue.fills', key, 'key', group.key.risk ?? '')], { severity: acceptedHere ? 'warn' : 'blocker' }))
    }
    if (group.key.kind === 'cumulative_quantity') {
      findings.push(makeFinding('fill_dedupe_key_cumulative', accountId,
        { venueOrderId: first.venueOrderId, instrumentId: first.instrumentId, venueFillId: first.venueFillId, ...(first.clientOrderId ? { clientOrderId: first.clientOrderId } : {}) },
        `订单 ${first.venueOrderId} 的成交号由累计成交量合成（${first.venueFillId}）：${group.key.risk ?? ''}`,
        [ev('venue.fills', first.venueFillId, 'key', 'order_id:cum_qty')]))
    }
  }

  // 账本自身的重复成交（同一成交号已多次入账）
  const ledgerGroups = new Map<string, LocalFillView[]>()
  for (const fill of input.local.fills) {
    if (fill.venueFillId === '') continue
    const bucket = ledgerGroups.get(fill.venueFillId)
    if (bucket) bucket.push(fill)
    else ledgerGroups.set(fill.venueFillId, [fill])
  }
  for (const [venueFillId, group] of ledgerGroups) {
    if (group.length < 2) continue
    const [first] = group
    if (!first) continue
    const identicalLedger = group.every((f) => sameFillLocal(first, f, opts.sizeTolerance))
    findings.push(makeFinding('ledger_fill_duplicate', accountId,
      { venueFillId, orderId: first.orderId ?? undefined, instrumentId: first.instrumentId },
      `账本里成交号 ${venueFillId} 已入账 ${group.length} 次（合计 ${normalizeDecimal(sumDecimal(group.map((f) => f.size)))}），${identicalLedger ? '内容完全一致' : '且内容不一致'}`,
      [
        ev('local.fills', venueFillId, 'count', String(group.length)),
        ev('local.fills', venueFillId, 'size', normalizeDecimal(sumDecimal(group.map((f) => f.size)))),
      ], { severity: identicalLedger ? 'warn' : 'blocker' }))
  }

  return { dedupe: { accepted, duplicates, conflicts, keys }, findings }
}

function sameFillLocal(a: LocalFillView, b: LocalFillView, tolerance: string): boolean {
  return a.ts === b.ts && a.side === b.side && sizeEqual(a.size, b.size, tolerance) && equalDecimal(a.price, b.price)
}

/** 时间异常的成交：落在未来（超出时钟偏差）或早于回补窗口。 */
export function fillTimeFindings(input: ReconcileInput, accepted: readonly VenueFillView[], opts: ResolvedOptions): Finding[] {
  const findings: Finding[] = []
  const accountId = input.local.accountId
  for (const fill of accepted) {
    if (isBeyondClockSkew(fill.ts, opts)) {
      findings.push(makeFinding('fill_time_anomaly', accountId,
        { venueFillId: fill.venueFillId, venueOrderId: fill.venueOrderId, instrumentId: fill.instrumentId },
        `成交时间 ${fill.ts} 比本地现在 ${opts.now} 晚 ${fill.ts - opts.now} ms，超出允许的时钟偏差 ${opts.clockSkewMs} ms`,
        [ev('venue.fills', fill.venueFillId, 'ts', String(fill.ts))], { tags: ['future'] }))
    } else if (isBeforeLookback(fill.ts, opts)) {
      findings.push(makeFinding('fill_time_anomaly', accountId,
        { venueFillId: fill.venueFillId, venueOrderId: fill.venueOrderId, instrumentId: fill.instrumentId },
        `成交时间 ${fill.ts} 早于回补窗口（${opts.fillLookbackMs} ms），可能属于更早的会话`,
        [ev('venue.fills', fill.venueFillId, 'ts', String(fill.ts))], { severity: 'info', tags: ['outside_lookback'] }))
    }
  }
  return findings
}

function findVenueOrder(input: ReconcileInput, ids: readonly string[], clientOrderId: string): VenueOrderView | undefined {
  const all = [...input.venue.openOrders, ...(input.venue.historyOrders ?? [])]
  return all.find((v) => ids.includes(v.venueOrderId))
    ?? all.find((v) => typeof v.clientOrderId === 'string' && v.clientOrderId !== '' && v.clientOrderId === clientOrderId)
}

/**
 * 成交缺口：场所累计成交量 > 账本已记合计时，给出一条「推断成交」。
 * 定价只认两种来源：
 *   1. 场所订单报告的成交均价（avgFillPrice）—— 首选；
 *   2. 账本该单最后一笔成交价 —— 次选，basis 里写明这是替代价。
 * 两者都没有 → 不猜价格，出「需要人工」。
 */
export function inferredFillsForOrder(
  input: ReconcileInput,
  order: LocalOrderView,
  index: LinkIndex,
  opts: ResolvedOptions,
): InferredFill | null {
  const ids = venueIdsOf(index, order)
  const venueOrder = findVenueOrder(input, ids.length > 0 ? ids : [order.venueOrderId ?? ''], order.clientOrderId)
  const venueFilled = venueOrder?.filledSize
  if (venueOrder === undefined || venueFilled === undefined) return null
  const localSum = sumDecimal(input.local.fills.filter((f) => f.orderId === order.orderId).map((f) => f.size))
  const gap = subtractDecimal(venueFilled, localSum)
  if (signDecimal(gap) <= 0) return null
  if (sizeEqual(gap, '0', opts.sizeTolerance)) return null
  const avg = venueOrder.avgFillPrice
  const localLast = [...input.local.fills].filter((f) => f.orderId === order.orderId).sort((a, b) => a.ts - b.ts).at(-1)
  const basis: string[] = [
    `场所订单 ${venueOrder.venueOrderId}（${venueOrder.source === 'open' ? '挂单报告' : '历史订单报告'}）累计成交量 ${normalizeDecimal(venueFilled)}`,
    `账本该单已记成交合计 ${normalizeDecimal(localSum)}，缺口 ${normalizeDecimal(gap)}`,
  ]
  let price: string
  let priceSource: InferredFill['priceSource']
  if (typeof avg === 'string' && avg !== '') {
    price = avg
    priceSource = 'venue_avg_fill_price'
    basis.push(`价格取场所订单的成交均价 ${normalizeDecimal(avg)}（字段 avgFillPrice）`)
  } else if (localLast !== undefined) {
    price = localLast.price
    priceSource = 'local_last_fill_price'
    basis.push(`场所没给成交均价，价格借账本该单最后一笔成交价 ${normalizeDecimal(localLast.price)}（成交号 ${localLast.venueFillId || '缺失'}），仅供人对账参考`)
  } else {
    return null
  }
  const ts = venueOrder.updatedAt ?? input.venue.asOf
  basis.push(`时间取场所订单最后更新时刻 ${ts}${venueOrder.updatedAt === undefined ? '（缺 updatedAt，退回场所视图生成时刻）' : ''}`)
  // 确定性 id：同一缺口（同场所单号 + 同样的账本合计 → 场所累计量）重复对账得到同一个 id
  const id = `inferred:${venueOrder.venueOrderId}:${normalizeDecimal(localSum)}->${normalizeDecimal(venueFilled)}`
  return {
    id,
    venueOrderId: venueOrder.venueOrderId,
    clientOrderId: order.clientOrderId,
    instrumentId: order.instrumentId,
    side: order.side,
    size: gap,
    price,
    ts,
    inferred: true,
    basis,
    priceSource,
    evidence: [
      { report: venueOrder.source === 'open' ? 'venue.openOrders' : 'venue.historyOrders', id: venueOrder.venueOrderId, field: 'filledSize', value: normalizeDecimal(venueFilled) },
      { report: 'local.fills', id: order.orderId, field: 'sum(size)', value: normalizeDecimal(localSum) },
      { report: 'local.orders', id: order.orderId, field: 'filledSize', value: normalizeDecimal(order.filledSize) },
    ],
  }
}

/** 成交层主入口：去重 + 时间异常 + 订单指向 + 缺口推断 + 账本多记。 */
export function classifyFills(
  input: ReconcileInput,
  index: LinkIndex,
  opts: ResolvedOptions,
  coverage: FillCoverage,
): FillClassificationResult {
  const accountId = input.local.accountId
  const { dedupe, findings } = dedupeFills(input, opts)
  findings.push(...fillTimeFindings(input, dedupe.accepted, opts))

  // 成交指向未知订单
  const knownIds = new Set<string>()
  for (const order of input.local.orders) for (const id of venueIdsOf(index, order)) knownIds.add(id)
  const orphanByOrder = new Map<string, VenueFillView[]>()
  for (const fill of dedupe.accepted) {
    if (knownIds.has(fill.venueOrderId)) continue
    const bucket = orphanByOrder.get(fill.venueOrderId)
    if (bucket) bucket.push(fill)
    else orphanByOrder.set(fill.venueOrderId, [fill])
  }
  for (const [venueOrderId, fills] of orphanByOrder) {
    findings.push(makeFinding('fill_orphan', accountId,
      { venueOrderId, instrumentId: fills[0]?.instrumentId, venueFillId: fills[0]?.venueFillId },
      `${fills.length} 笔成交指向场所单号 ${venueOrderId}，账本没有任何订单（含改单链）认领这个单号`,
      fills.slice(0, 5).map((f) => ev('venue.fills', f.venueFillId || String(f.ts), 'size', f.size))))
  }

  // 缺口推断 + 账本多记
  const inferredFills: InferredFill[] = []
  for (const order of input.local.orders) {
    const localSum = sumDecimal(input.local.fills.filter((f) => f.orderId === order.orderId).map((f) => f.size))
    const ids = venueIdsOf(index, order)
    const venueOrder = findVenueOrder(input, ids.length > 0 ? ids : [order.venueOrderId ?? ''], order.clientOrderId)
    const base = { orderId: order.orderId, clientOrderId: order.clientOrderId, instrumentId: order.instrumentId }
    if (venueOrder?.filledSize !== undefined) {
      // 场所自己的两份报告互相矛盾：成交明细加起来 > 累计成交量（ExecId 更正被当成新成交、或同一笔推了两次）
      const venueFillsSum = sumDecimal(dedupe.accepted.filter((f) => ids.includes(f.venueOrderId)).map((f) => f.size))
      if (compareDecimal(venueFillsSum, venueOrder.filledSize) > 0 && !sizeEqual(venueFillsSum, venueOrder.filledSize, opts.sizeTolerance)) {
        findings.push(makeFinding('fill_total_exceeds_order', accountId, { ...base, venueOrderId: venueOrder.venueOrderId },
          `场所成交明细合计 ${normalizeDecimal(venueFillsSum)} 多于该单累计成交量 ${normalizeDecimal(venueOrder.filledSize)}（多 ${absDecimal(subtractDecimal(venueFillsSum, venueOrder.filledSize))}）`,
          [
            { report: 'venue.fills', id: venueOrder.venueOrderId, field: 'sum(size)', value: normalizeDecimal(venueFillsSum) },
            { report: venueOrder.source === 'open' ? 'venue.openOrders' : 'venue.historyOrders', id: venueOrder.venueOrderId, field: 'filledSize', value: normalizeDecimal(venueOrder.filledSize) },
          ], { tags: ['venue_reports_disagree'] }))
      }
    }
    if (venueOrder?.filledSize !== undefined) {
      const gap = subtractDecimal(venueOrder.filledSize, localSum)
      if (signDecimal(gap) > 0 && !sizeEqual(gap, '0', opts.sizeTolerance) && !isZeroDecimal(gap)) {
        const inferred = inferredFillsForOrder(input, order, index, opts)
        if (inferred) {
          inferredFills.push(inferred)
          findings.push(makeFinding('fill_missing_inferred', accountId,
            { ...base, venueOrderId: inferred.venueOrderId, venueFillId: inferred.id },
            `场所累计成交 ${normalizeDecimal(venueOrder.filledSize)}、账本已记 ${normalizeDecimal(localSum)}：推出一条 ${inferred.side} ${normalizeDecimal(inferred.size)} @ ${normalizeDecimal(inferred.price)} 的成交`,
            inferred.evidence,
            { inferred: true, basis: inferred.basis, tags: [inferred.priceSource] }))
        } else {
          findings.push(makeFinding('fill_missing_unexplained', accountId, { ...base, venueOrderId: venueOrder.venueOrderId },
            `成交缺口 ${normalizeDecimal(gap)}，但场所没给成交均价、账本也没有可参照的成交价，推不出成交价格`,
            [
              { report: 'venue.openOrders', id: venueOrder.venueOrderId, field: 'filledSize', value: normalizeDecimal(venueOrder.filledSize) },
              { report: 'local.fills', id: order.orderId, field: 'sum(size)', value: normalizeDecimal(localSum) },
            ]))
        }
      } else if (signDecimal(gap) < 0 && !sizeEqual(gap, '0', opts.sizeTolerance)) {
        findings.push(makeFinding('fill_recorded_excess', accountId, { ...base, venueOrderId: venueOrder.venueOrderId },
          `账本已记成交合计 ${normalizeDecimal(localSum)} 多于场所累计成交 ${normalizeDecimal(venueOrder.filledSize)}（多 ${absDecimal(gap)}）`,
          [
            { report: 'local.fills', id: order.orderId, field: 'sum(size)', value: normalizeDecimal(localSum) },
            { report: venueOrder.source === 'open' ? 'venue.openOrders' : 'venue.historyOrders', id: venueOrder.venueOrderId, field: 'filledSize', value: normalizeDecimal(venueOrder.filledSize) },
          ]))
      }
    } else if (localSum !== '0' && venueOrder !== undefined) {
      const klass = classifyVenueStatus(venueOrder.status)
      if (isVenueStatusLive(klass) && signDecimal(localSum) > 0 && !sizeEqual(localSum, '0', opts.sizeTolerance)) {
        findings.push(makeFinding('order_filled_size_drift', accountId, { ...base, venueOrderId: venueOrder.venueOrderId },
          `账本记该单已成交 ${normalizeDecimal(localSum)}，场所报告不给累计成交量（${venueOrder.status}）；改单场景下成交通常记在旧单号上`,
          [
            { report: 'local.fills', id: order.orderId, field: 'sum(size)', value: normalizeDecimal(localSum) },
            { report: venueOrder.source === 'open' ? 'venue.openOrders' : 'venue.historyOrders', id: venueOrder.venueOrderId, field: 'status', value: venueOrder.status },
          ], { tags: ['venue_field_missing'] }))
      }
    }
    if (!coverage.fillsAvailable && signDecimal(order.filledSize) > 0) {
      findings.push(makeFinding('venue_report_unavailable', accountId, { ...base },
        `该场所本次给不出成交报告，订单 ${order.orderId} 的已成交量无法用成交明细核对`,
        [{ report: 'options', id: 'venue.unavailable', field: 'fills', value: 'true' }]))
    }
  }

  return { dedupe, findings, inferredFills, ledgerDuplicateOrderIds: ledgerDuplicateOrderIds(findings) }
}

function ledgerDuplicateOrderIds(findings: readonly Finding[]): string[] {
  return findings.filter((f) => f.code === 'ledger_fill_duplicate').map((f) => f.subject.orderId ?? '').filter((x) => x !== '')
}

/** 该订单的场所累计成交量（没有报告时返回 undefined）。 */
export function venueFilledSizeOf(input: ReconcileInput, order: LocalOrderView, index: LinkIndex): string | undefined {
  const ids = venueIdsOf(index, order)
  return findVenueOrder(input, ids.length > 0 ? ids : [order.venueOrderId ?? ''], order.clientOrderId)?.filledSize
}

/** 账本某订单已记成交合计。 */
export function localFilledSum(input: ReconcileInput, orderId: string): string {
  return sumDecimal(input.local.fills.filter((f) => f.orderId === orderId).map((f) => f.size))
}

/** 供持仓层使用：某标的的推断成交量（正负按方向）。 */
export function inferredSizeByInstrument(inferred: readonly InferredFill[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const fill of inferred) {
    const signed = fill.side === 'buy' ? fill.size : `-${absDecimal(fill.size)}`
    const current = out.get(fill.instrumentId) ?? '0'
    out.set(fill.instrumentId, addDecimal(current, signed))
  }
  return out
}

/** 差值的可读描述（供 detail 用）。 */
export function describeGap(a: string, b: string): string {
  const diff = subtractDecimal(a, b)
  const cmp = compareDecimal(a, b)
  if (cmp === 0) return '一致'
  return cmp > 0 ? `多 ${normalizeDecimal(diff)}` : `少 ${normalizeDecimal(absDecimal(diff))}`
}
