// SPDX-License-Identifier: CPAL-1.0
import type { Account, Decimal, GateAccountView, GateAction, GateAdjustment, GateDecision, GateInput, GateSnapshot, GateTarget, Instrument, Mandate, PrecheckStats, ReservedView, RiskPolicy, StateReason } from '@gitrader/protocol'
import { digestOf } from '../util/hash'
import type { AccountSnapshot, MarkPrice, NormalizedIntent } from '../connector'
import { normalizeRiskTarget } from '../normalize'
import type { Origin } from '@gitrader/protocol'
import * as d from '../util/dec'

/** Clone JSON-like gate values while dropping undefined object fields. */
export function cleanGateValue<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (item === undefined) throw new TypeError('undefined is not allowed in gate arrays')
      return cleanGateValue(item)
    }) as T
  }
  if (value !== null && typeof value === 'object') {
    const cleaned: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) cleaned[key] = cleanGateValue(item)
    }
    return cleaned as T
  }
  return value
}

function compareText(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0 }
function compareTuple(a: readonly (string | number)[], b: readonly (string | number)[]): number {
  for (let i = 0; i < a.length; i++) {
    const left = a[i] as string | number, right = b[i] as string | number
    const result = typeof left === 'number' && typeof right === 'number' ? left - right : compareText(String(left), String(right))
    if (result !== 0) return result
  }
  return 0
}

export function canonicalGateTarget(target: GateTarget): GateTarget {
  const clean = cleanGateValue(target)
  if (clean.kind === 'cancel') clean.targets.sort((a, b) => compareText(a.orderId, b.orderId))
  return clean
}

export function gateTargetDigest(target: GateTarget): GateDecision['targetDigest'] {
  return digestOf(canonicalGateTarget(target))
}

/** Compute the venue size-step adjustment without changing the audited target. */
export function sizePrecisionAdjustment(target: GateTarget, instrument?: Instrument): GateAdjustment[] {
  if (target.kind !== 'order' || !instrument || target.intent.instrumentId !== instrument.instrumentId) return []
  const size = d.D(target.intent.size)
  const rounded = instrument.size.step
    ? d.mul(d.div(size, d.D(instrument.size.step), 0), d.D(instrument.size.step))
    : d.truncTo(size, instrument.size.decimals)
  if (d.eq(size, rounded)) return []
  return [{
    ruleId: `${instrument.instrumentId}#sizePrecision`, code: 'SIZE_PRECISION', field: 'size',
    from: d.str(size), to: d.str(rounded), unit: instrument.base,
  }]
}

export function canonicalGateInput(input: GateInput): GateInput {
  const clean = cleanGateValue(input)
  clean.target = canonicalGateTarget(clean.target)
  clean.snapshot.positions.sort((a, b) => compareText(a.instrumentId, b.instrumentId))
  clean.snapshot.openOrders.sort((a, b) => compareTuple([a.instrumentId, a.side], [b.instrumentId, b.side]))
  clean.snapshot.stopLossOrderIds.sort(compareText)
  clean.account.groupIds.sort(compareText)
  clean.states.sort((a, b) => compareTuple(
    [a.scope.type, a.scope.id, a.state, a.protector ?? '', a.until ?? 0, a.reason],
    [b.scope.type, b.scope.id, b.state, b.protector ?? '', b.until ?? 0, b.reason],
  ))
  clean.protectorResults.sort((a, b) => compareTuple([a.pluginId, a.order], [b.pluginId, b.order]))
  return clean
}

export function policyRefOf(policy: RiskPolicy | null): GateDecision['policyRef'] {
  return policy === null ? null : { policyId: policy.policyId, version: policy.version, digest: policy.attestation.digest }
}

export function gateSnapshotOf(input: GateInput): GateSnapshot {
  const clean = canonicalGateInput(input)
  const { target: _target, policy: _policy, ...snapshot } = clean
  return { ...snapshot, policy: policyRefOf(clean.policy) } as GateSnapshot
}

export function gateSnapshotDigest(input: GateInput): GateDecision['snapshotDigest'] {
  return digestOf(gateSnapshotOf(input))
}

export interface AssembleGateInputArgs {
  intent?: NormalizedIntent
  target?: GateTarget
  action?: GateAction
  account: Account
  inst?: Instrument
  snapshot: AccountSnapshot & { confirmedAt?: number; stale?: boolean; gateOpenOrders?: GateAccountView['openOrders']; asOf?: number; availableDeductsOpenOrders?: boolean; stopLossOrderIds?: string[] }
  openOrderValuations?: Record<string, { contractSize: Decimal; mark?: Decimal }>
  cancelPriceChecks?: GateInput['cancelPriceChecks']
  reservedReductionSize?: Decimal
  originalTargetDigest?: GateInput['originalTargetDigest']
  mark?: MarkPrice & { source?: 'venue_mark' | 'last' | 'mid' }
  mandate?: Mandate | null
  policy: RiskPolicy | null
  policyIntegrity: { ok: boolean; problems: string[] }
  mandateIntegrity: { ok: boolean; problems: string[] }
  states: StateReason[]
  stats: PrecheckStats
  rate?: { used: number; limit: number }
  reserved?: ReservedView
  path: GateInput['path']
  actorType: Origin['actorType']
  now: number
  precheckId: string
  dryRun: boolean
  killSwitch?: GateInput['killSwitch']
  venueRules?: GateInput['venueRules']
}

const emptyReserved = (): ReservedView => ({
  account: { margin: '0' as Decimal, notional: '0' as Decimal, count: 0 }, byInstrument: {},
  today: { notional: '0' as Decimal, count: 0 }, lastMinute: { count: 0 },
})

/** Adapt the legacy precheck view into the frozen gate protocol without reading services or time. */
export function assembleGateInput(args: AssembleGateInputArgs): GateInput {
  const positions: GateAccountView['positions'] = args.snapshot.positions.map((p) => ({
    instrumentId: p.instrumentId, side: p.side === 'long' ? 'long' : 'short', size: p.size, notional: p.notional, leverage: p.leverage,
  }))
  const normalized = args.intent ? normalizeRiskTarget(args.intent, positions, args.reservedReductionSize) : undefined
  const summarized = args.snapshot.gateOpenOrders
  let valuationIncomplete = false
  const openOrders = summarized ?? (() => {
    const byInstrumentSide = new Map<string, GateAccountView['openOrders'][number]>()
    for (const order of args.snapshot.openOrders) {
      if (order.reduceOnly) continue
      const metadata = args.inst && order.instrumentId === args.inst.instrumentId
        ? { contractSize: args.inst.contractSize, mark: args.mark?.price }
        : args.openOrderValuations?.[order.instrumentId]
      const price = order.price ?? metadata?.mark
      if (!metadata || price === undefined) { valuationIncomplete = true; continue }
      const notional = d.str(d.mul(d.mul(d.D(order.size), d.D(price)), d.D(metadata.contractSize)))
      const key = `${order.instrumentId}\u0000${order.side}`
      const prior = byInstrumentSide.get(key)
      byInstrumentSide.set(key, {
        instrumentId: order.instrumentId, side: order.side,
        notional: prior ? d.str(d.add(d.D(prior.notional), d.D(notional))) : notional,
        count: (prior?.count ?? 0) + 1,
      })
    }
    return [...byInstrumentSide.values()]
  })()
  const actorClass = args.actorType === 'human' ? 'human' : args.actorType === 'system' ? 'system' : 'agent'
  const action = normalized?.action ?? args.action
  const target = normalized ? { kind: 'order', intent: normalized.intent } as GateTarget : args.target
  if (!action || !target) throw new TypeError('assembleGateInput requires intent or target/action')
  if ((target.kind === 'order' || target.kind === 'leverage') && !args.inst) throw new TypeError(`${target.kind} target requires instrument metadata`)
  const assemblyAdjustments = sizePrecisionAdjustment(target, args.inst)
  const assembled = cleanGateValue({
    precheckId: args.precheckId as GateInput['precheckId'], dryRun: args.dryRun, action, actorClass, originActorType: args.actorType,
    ...((args.originalTargetDigest ?? normalized?.originalTargetDigest) ? { originalTargetDigest: args.originalTargetDigest ?? normalized?.originalTargetDigest } : {}),
    account: { accountId: args.account.accountId, venue: args.account.venue, mode: args.account.mode === 'live' ? 'live' : 'paper', groupIds: args.account.groupIds },
    snapshot: {
      equity: args.snapshot.equity, available: args.snapshot.available, availableDeductsOpenOrders: args.snapshot.availableDeductsOpenOrders ?? false,
      positions, openOrders, stopLossOrderIds: args.snapshot.stopLossOrderIds ?? [], asOf: args.snapshot.asOf ?? args.snapshot.ts,
      ...(args.snapshot.confirmedAt === undefined ? {} : { confirmedAt: args.snapshot.confirmedAt }),
      stale: (args.snapshot.stale ?? false) || valuationIncomplete,
    },
    ...(args.mark?.source === 'venue_mark' ? { mark: { price: args.mark.price, ts: args.mark.ts, source: 'venue_mark' as const } } : {}),
    ...(args.cancelPriceChecks === undefined ? {} : { cancelPriceChecks: args.cancelPriceChecks }),
    mandate: args.mandate ?? null, mandateIntegrity: args.mandateIntegrity, policy: args.policy, policyIntegrity: args.policyIntegrity,
    path: args.path, now: args.now, stats: args.stats, ...(args.rate ? { rate: args.rate } : {}), reserved: args.reserved ?? emptyReserved(),
    states: args.states, killSwitch: args.killSwitch ?? { tripped: false }, ...(args.venueRules ? { venueRules: args.venueRules } : {}), protectorResults: [],
    ...(assemblyAdjustments.length ? { assemblyAdjustments } : {}),
    target, ...(args.inst ? { instrument: args.inst } : {}),
  }) as GateInput
  return assembled
}
