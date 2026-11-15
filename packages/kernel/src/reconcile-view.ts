// SPDX-License-Identifier: CPAL-1.0
import type { StartupSnapshot } from '@gitrader/protocol/connector'
import type {
  Fill, MarginMode, Order, ReconcileAccountView, ReconcileEvidence, ReconcileFindingView,
  ReconcileSuggestion,
} from './proto'
import { asDecimal, isDecimal, makeProblem } from './proto'
import type { AmendLink, ReconcileInput, ReconcileReport, VenueReportKind } from '../../exec-reconcile/src/types'
import { reconcile } from '../../exec-reconcile/src/reconcile'
import { buildReconcileLocal } from './reconcile-local'
import * as d from './util/dec'
import { digestOf } from './util/hash'
import { KernelError } from './util/errors'

export interface ReconcileOrderObservation {
  orderId: Order['orderId']
  observedAt: number
  result: null | {
    status: Order['status']
    venueOrderId?: string
    filledSize?: Fill['size']
    avgFillPrice?: Fill['price']
  }
}

export interface ReconcileViewSource {
  accountId: Order['accountId']
  orders: readonly Order[]
  fills: readonly Fill[]
  orderMarginModes?: ReadonlyMap<string, MarginMode>
  orderAliases?: ReadonlyMap<string, readonly string[]>
  snapshot: StartupSnapshot
  snapshotObservedAt: number
  historyOrderIds: readonly Order['orderId'][]
  observations: readonly ReconcileOrderObservation[]
  unavailable?: readonly VenueReportKind[]
  now: number
}

export interface BuiltReconcileView {
  input: ReconcileInput
  report: ReconcileReport
  view: ReconcileAccountView
}

const VENUE_ORDER_STATUSES: ReadonlySet<Order['status']> = new Set([
  'new', 'submitted', 'open', 'untriggered', 'partially_filled', 'filled', 'cancelled', 'expired', 'rejected', 'denied',
])

function rejectInvalid(message: string): never {
  throw new KernelError(makeProblem('INVALID_PARAMS', message))
}

function validTime(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) rejectInvalid(`${name} must be a nonnegative integer millisecond timestamp`)
}

function validateHistory(source: ReconcileViewSource): Map<string, ReconcileOrderObservation> {
  const orders = new Map<string, Order>()
  for (const order of source.orders) {
    if (order.accountId !== source.accountId) continue
    if (orders.has(order.orderId)) rejectInvalid('source contains duplicate local order identities')
    orders.set(order.orderId, order)
  }
  const historyIds = new Set<string>()
  for (const id of source.historyOrderIds) {
    if (historyIds.has(id) || !orders.has(id)) rejectInvalid('history order identities must be unique and belong to this account')
    historyIds.add(id)
  }
  const observations = new Map<string, ReconcileOrderObservation>()
  for (const observation of source.observations) {
    validTime(observation.observedAt, 'observation.observedAt')
    if (!historyIds.has(observation.orderId) || !orders.has(observation.orderId) || observations.has(observation.orderId)) {
      rejectInvalid('observations must be unique and belong to requested local history orders')
    }
    observations.set(observation.orderId, observation)
  }
  return observations
}

function asVenueFill(fill: StartupSnapshot['fills'][number]) {
  return {
    venueFillId: fill.venueFillId,
    venueOrderId: fill.venueOrderId,
    ...(fill.clientOrderId !== null ? { clientOrderId: fill.clientOrderId } : {}),
    instrumentId: fill.instrumentId,
    side: fill.side,
    price: fill.price,
    size: fill.size,
    fee: fill.fee,
    ts: fill.ts,
    liquidity: fill.liquidity,
  }
}

function buildLinks(source: ReconcileViewSource): NonNullable<ReconcileInput['links']> {
  const links: AmendLink[] = []
  const orders = source.orders.filter((order) => order.accountId === source.accountId)
  const claimed = new Map<string, string>()
  for (const order of orders) {
    const aliases = source.orderAliases?.get(order.orderId) ?? []
    const identities = [...aliases]
    const current = typeof order.venueOrderId === 'string' && order.venueOrderId !== '' ? order.venueOrderId : undefined
    if (current && identities[identities.length - 1] !== current) identities.push(current)
    let previous: string | undefined
    for (const [index, venueOrderId] of identities.entries()) {
      const otherOrderId = claimed.get(venueOrderId)
      if (otherOrderId && otherOrderId !== order.orderId) {
        // Keep the raw claim so exec-reconcile marks the identity as ambiguous.
      } else claimed.set(venueOrderId, order.orderId)
      links.push({
        clientOrderId: order.clientOrderId,
        venueOrderId,
        ...(previous !== undefined ? { previousVenueOrderId: previous } : {}),
        kind: index === 0 ? 'submit' : 'replace',
        ts: 0,
        orderId: order.orderId,
      })
      previous = venueOrderId
    }
  }
  return links
}

export function buildReconcileInput(source: ReconcileViewSource): ReconcileInput {
  validTime(source.snapshotObservedAt, 'snapshotObservedAt')
  validTime(source.now, 'now')
  const observations = validateHistory(source)
  const accountOrders = source.orders.filter((order) => order.accountId === source.accountId)
  const local = buildReconcileLocal(source.accountId, accountOrders, source.fills, source.now, source.orderMarginModes)
  const unavailable = new Set<VenueReportKind>(source.unavailable ?? [])
  const openOrders: ReconcileInput['venue']['openOrders'][number][] = []
  for (const order of source.snapshot.openOrders) {
    const base = {
      venueOrderId: order.venueOrderId,
      ...(order.clientOrderId !== null ? { clientOrderId: order.clientOrderId } : {}),
      instrumentId: order.instrumentId,
      side: order.side,
      type: order.type,
      size: order.size,
      origSize: order.origSize,
      ...(order.price !== null ? { price: order.price } : {}),
      ...(order.triggerPrice !== null ? { triggerPrice: order.triggerPrice } : {}),
      status: 'open',
      reduceOnly: order.reduceOnly,
      createdAt: order.createdAt,
      source: 'open' as const,
    }
    if (isDecimal(order.origSize) && isDecimal(order.size) &&
      !d.isNeg(d.D(order.origSize)) && !d.isNeg(d.D(order.size))) {
      const residual = d.sub(d.D(order.origSize), d.D(order.size))
      if (!d.isNeg(residual)) openOrders.push({ ...base, filledSize: asDecimal(d.str(residual)) })
      else { openOrders.push(base); unavailable.add('openOrders') }
    } else { openOrders.push(base); unavailable.add('openOrders') }
  }

  const localById = new Map(accountOrders.map((order) => [order.orderId, order]))
  const historyOrders: NonNullable<ReconcileInput['venue']['historyOrders']>[number][] = []
  for (const id of source.historyOrderIds) {
    const observation = observations.get(id)
    const order = localById.get(id)
    if (!observation || !observation.result || !order) { unavailable.add('historyOrders'); continue }
    const result = observation.result
    if (!VENUE_ORDER_STATUSES.has(result.status)) { unavailable.add('historyOrders'); continue }
    if (result.filledSize === undefined || !isDecimal(result.filledSize) || d.isNeg(d.D(result.filledSize))) {
      unavailable.add('historyOrders')
      continue
    }
    const venueOrderId = result.venueOrderId ?? (typeof order.venueOrderId === 'string' ? order.venueOrderId : undefined)
    if (!venueOrderId) { unavailable.add('historyOrders'); continue }
    historyOrders.push({
      venueOrderId,
      clientOrderId: order.clientOrderId,
      instrumentId: order.instrumentId,
      side: order.side,
      ...(result.filledSize !== undefined ? { filledSize: result.filledSize } : {}),
      ...(result.avgFillPrice !== undefined && isDecimal(result.avgFillPrice) && !d.isNeg(d.D(result.avgFillPrice)) ? { avgFillPrice: result.avgFillPrice } : {}),
      status: result.status,
      source: 'history',
    })
  }
  if (source.snapshot.account.stale === true) unavailable.add('positions')
  if (source.snapshot.truncated === true) unavailable.add('positions')
  const venue: ReconcileInput['venue'] = {
    openOrders,
    ...(source.historyOrderIds.length > 0 || unavailable.has('historyOrders') ? { historyOrders } : {}),
    fills: source.snapshot.fills.map(asVenueFill),
    positions: source.snapshot.account.positions.map((position) => ({
      instrumentId: position.instrumentId,
      side: position.side,
      size: position.size,
      entryPrice: position.entryPrice,
      marginMode: position.marginMode,
    })),
    asOf: source.snapshot.account.confirmedAt ?? source.snapshotObservedAt,
    ...(source.snapshot.truncated ? { truncated: true } : {}),
    ...(unavailable.size > 0 ? { unavailable: [...unavailable] } : {}),
  }
  return { local, venue, links: buildLinks(source) }
}

function digestHex(value: unknown): string { return digestOf(value).slice('sha256:'.length) }

function publicEvidence(report: ReconcileEvidence['report'], evidence: ReconcileReport['findings'][number]['evidence'][number]): ReconcileEvidence {
  const unknownAliasTime = evidence.report === 'links' && /^link\.(submit|replace)\.ts$/.test(evidence.field) && evidence.value === '0'
  return {
    report,
    id: evidence.id,
    field: evidence.field,
    value: unknownAliasTime ? 'unknown; persisted identity only' : evidence.value,
  }
}

function viewFinding(finding: ReconcileReport['findings'][number]): ReconcileFindingView {
  const stableEvidence = finding.evidence.filter((evidence) => evidence.field !== 'ageMs')
  const id = `rcf_${digestHex({
    code: finding.code,
    severity: finding.severity,
    subject: finding.subject,
    advice: finding.advice,
    evidence: stableEvidence,
  })}`
  return {
    id,
    code: finding.code,
    severity: finding.severity,
    detail: finding.detail,
    advice: { action: finding.advice.action, requiresHuman: finding.advice.requiresHuman, why: finding.advice.why },
    evidence: finding.evidence.map((evidence) => publicEvidence(evidence.report, evidence)),
  }
}

function suggestionsFor(source: ReconcileViewSource, report: ReconcileReport, unavailable: boolean): ReconcileSuggestion[] {
  if (unavailable) return []
  const orders = source.orders.filter((order) => order.accountId === source.accountId)
  return report.inferredFills.flatMap((inferred) => {
    const matches = report.links.filter((link) =>
      !link.broken && !link.ambiguous && link.orderId !== undefined
      && link.clientOrderId === inferred.clientOrderId
      && link.venueOrderIds.includes(inferred.venueOrderId),
    )
    if (matches.length !== 1) return []
    const order = orders.find((candidate) => candidate.orderId === matches[0]?.orderId)
    if (!order || order.clientOrderId !== inferred.clientOrderId) return []
    return [{
      id: inferred.id,
      orderId: order.orderId,
      venueOrderId: inferred.venueOrderId,
      clientOrderId: order.clientOrderId,
      instrumentId: inferred.instrumentId,
      side: inferred.side,
      size: asDecimal(inferred.size),
      price: asDecimal(inferred.price),
      ts: inferred.ts,
      priceSource: inferred.priceSource,
      basis: [...inferred.basis],
      inferred: true as const,
    }]
  })
}

export function buildReconcileView(source: ReconcileViewSource): BuiltReconcileView {
  const input = buildReconcileInput(source)
  const report = reconcile(input, { now: source.now })
  const staleFinding = report.findings.some((finding) => finding.code === 'snapshot_stale')
  const staleOrTruncated = source.snapshot.account.stale === true || source.snapshot.truncated === true || staleFinding
  const unavailable = input.venue.unavailable ?? []
  const findings = report.findings.map(viewFinding)
  const reportId = `rec_${digestHex({
    local: (({ asOf: _localAsOf, ...local }) => local)(input.local),
    venue: (({ asOf: _venueAsOf, ...venue }) => venue)(input.venue),
    links: input.links ?? [],
    stale: staleFinding || source.snapshot.account.stale === true,
    findingIds: findings.map((finding) => finding.id),
  })}`
  const view: ReconcileAccountView = {
    accountId: source.accountId,
    state: staleOrTruncated ? 'unavailable' : 'ready',
    reportId,
    generatedAt: report.generatedAt,
    verdict: report.verdict,
    findings,
    suggestions: suggestionsFor(source, report, staleOrTruncated),
    coverage: {
      asOf: input.venue.asOf,
      truncated: source.snapshot.truncated,
      unavailable: [...unavailable],
      historyChecked: source.observations.length,
      historyTotal: source.historyOrderIds.length,
    },
    ...(staleOrTruncated ? { problem: makeProblem('VENUE_OUTCOME_UNKNOWN', 'The venue snapshot is stale or truncated; reconciliation suggestions are unavailable.') } : {}),
  }
  return { input, report, view }
}
