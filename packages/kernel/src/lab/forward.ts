// SPDX-License-Identifier: CPAL-1.0
import type { BaselineRef, Decimal, Experiment, ForwardFillSlice, ForwardRunInput, ForwardSnapshot, ForwardStats, ForwardStatsInput, Origin, Position } from '../proto'
import { computeForwardStats } from '../proto'
import type { LabService } from '../lab'
import type { Account } from '../proto'
import { fail } from '../util/errors'
import * as d from '../util/dec'
import { systemOrigin } from '../util/origin'

const DAY_MS = 86_400_000
const ORG = 'org_local'
export type StartDoc = { at: number; initialEquity: ForwardStatsInput['initialEquity']; positionsByAccount: Record<string, Position[]>; valuationCcy: string }
export type StageSnapshotBatch = { at: number; requestedAt: number; sealSeq: number; sourceSeqs: number[]; start: StartDoc }
type Entry = { seq: number; ts: number; recordedAt: number; type: string; origin: Origin; subject: Record<string, any>; payload?: Record<string, any>; attestation: ForwardSnapshot['attestation'] }

function evidence(message = 'Forward evidence is incomplete'): never { return fail('EXPERIMENT_EVIDENCE_INCOMPLETE', message) }
function clone<T>(value: T): T { try { return JSON.parse(JSON.stringify(value)) as T } catch { return evidence() } }
function key(accountId: string, at: number): string { return `${accountId}:${at}` }
function actorMatches(origin: Origin, executor: ForwardRunInput['executor']): boolean {
  const c = origin.causation
  if (!c) return false
  if (executor.kind === 'agent') return origin.actorType === 'llm-agent' && c.mandateId === executor.mandateId
  return origin.actorType === 'engine' && c.engineId === executor.engineId && c.instanceId === executor.instanceId
}
function signedPosition(position: Position): d.Dec {
  const size = d.D(position.size)
  return position.side === 'long' ? size : d.neg(size)
}

export class LabForward {
  private lastDay: number
  constructor(readonly lab: LabService) {
    this.lastDay = lab.k.docs.get<{ lastDay: number }>('lab-forward-clock', 'daily')?.lastDay ?? Math.floor(lab.k.clock.now() / DAY_MS)
    if (!lab.k.replayFixture) this.saveDay(this.lastDay)
  }

  private saveDay(day: number): void {
    this.lab.k.docs.put('lab-forward-clock', 'daily', { lastDay: day })
    this.lastDay = day
  }

  private accounts(exp: Experiment): Account[] {
    const ids = [...new Set((exp.runs ?? []).filter((run) => run.to === null && run.accountId).map((run) => run.accountId!))]
    return ids.map((id) => {
      const account = this.lab.k.accounts.get(id)
      if (account.mode !== 'paper') return evidence('Only paper accounts can supply forward evidence')
      return account
    })
  }

  private async capture(account: Account): Promise<{ equity: Decimal; unrealizedPnl: Decimal; positions: Position[]; valuationCcy: string }> {
    if (account.mode !== 'paper') return evidence('Only paper account snapshots are eligible')
    const snapshot = await this.lab.k.bus.snapshot(account, { maxAgeMs: 0 })
    if (snapshot.stale || snapshot.truncated || !d.gt(d.D(snapshot.equity), d.ZERO)) return evidence('Fresh positive account snapshot is unavailable')
    const unrealizedPnl = snapshot.positions.reduce((sum, position) => d.add(sum, d.D(position.unrealizedPnl)), d.ZERO)
    return { equity: d.str(d.D(snapshot.equity)), unrealizedPnl: d.str(unrealizedPnl), positions: clone(snapshot.positions), valuationCcy: account.paper?.ccy ?? 'USD' }
  }

  async start(exp: Experiment, at: number, prepared?: StartDoc): Promise<void> {
    if (this.lab.k.replayFixture) return fail('INVALID_PARAMS', 'forward experiment evidence is unavailable in a historical replay home')
    const accounts = this.accounts(exp)
    if (!accounts.length) return
    if (prepared) {
      const activeIds = accounts.map((account) => account.accountId).sort()
      const preparedIds = prepared.initialEquity.map((item) => item.accountId).sort()
      if (prepared.at !== at || activeIds.length !== preparedIds.length || activeIds.some((id, index) => id !== preparedIds[index])) return evidence('Prepared forward start does not match active accounts')
      this.lab.k.docs.put('lab-forward-start', key(exp.experimentId, at), clone(prepared))
      return
    }
    const initialEquity: StartDoc['initialEquity'] = []
    const positionsByAccount: Record<string, Position[]> = {}
    let valuationCcy: string | undefined
    for (const account of accounts) {
      const captured = await this.capture(account)
      if (valuationCcy !== undefined && captured.valuationCcy !== valuationCcy) return evidence('Mixed account valuation currencies are not supported')
      valuationCcy = captured.valuationCcy
      initialEquity.push({ accountId: account.accountId, at, equity: captured.equity, unrealizedPnl: captured.unrealizedPnl })
      positionsByAccount[account.accountId] = captured.positions
    }
    this.lab.k.docs.put('lab-forward-start', key(exp.experimentId, at), { at, initialEquity, positionsByAccount, valuationCcy: valuationCcy ?? 'USD' } satisfies StartDoc)
  }

  async snapshot(exp: Experiment, kind: 'daily' | 'stage', at: number): Promise<StageSnapshotBatch | undefined> {
    if (this.lab.k.replayFixture) return fail('INVALID_PARAMS', 'forward experiment evidence is unavailable in a historical replay home')
    if (kind === 'daily' && at % DAY_MS !== 0) return evidence('Daily snapshot must use a UTC boundary')
    const accounts = this.accounts(exp)
    if (kind === 'daily') {
      for (const account of accounts) await this.appendSnapshot(account, exp.experimentId, kind, at)
      return undefined
    }
    if (!accounts.length) return undefined
    const captures: { account: Account; captured: Awaited<ReturnType<LabForward['capture']>> }[] = []
    let valuationCcy: string | undefined
    for (const account of accounts) {
      const captured = await this.capture(account)
      if (valuationCcy !== undefined && captured.valuationCcy !== valuationCcy) return evidence('Mixed account valuation currencies are not supported')
      valuationCcy = captured.valuationCcy
      captures.push({ account, captured })
    }
    const sourceSeqs: number[] = []
    const initialEquity: StartDoc['initialEquity'] = []
    const positionsByAccount: Record<string, Position[]> = {}
    for (const { account, captured } of captures) {
      const entry = this.lab.k.ledger.append({
        type: 'position.snapshot', ts: at, origin: systemOrigin('lab:position.snapshot'),
        subject: { orgId: ORG, accountId: account.accountId as never, experimentId: exp.experimentId as never },
        payload: { lab: true, kind: 'stage', at, equity: captured.equity, unrealizedPnl: captured.unrealizedPnl, valuationCcy: captured.valuationCcy },
        attestation: 'kernel-observed',
      })
      sourceSeqs.push(entry.seq)
      initialEquity.push({ accountId: account.accountId, at: at, equity: captured.equity, unrealizedPnl: captured.unrealizedPnl })
      positionsByAccount[account.accountId] = clone(captured.positions)
    }
    const seal = this.lab.k.ledger.append({
      type: 'annotation', ts: at, origin: systemOrigin('lab:snapshot.batch'),
      subject: { orgId: ORG, experimentId: exp.experimentId as never },
      payload: { kind: 'lab.snapshot.batch', requestedAt: at, sourceSeqs },
      attestation: 'kernel-observed',
    })
    const endpointAt = seal.recordedAt
    const start: StartDoc = {
      at: endpointAt,
      initialEquity: initialEquity.map((item) => ({ ...item, at: endpointAt })),
      positionsByAccount,
      valuationCcy: valuationCcy ?? 'USD',
    }
    return { at: endpointAt, requestedAt: at, sealSeq: seal.seq, sourceSeqs, start }
  }

  private async appendSnapshot(account: Account, experimentId: string | undefined, kind: 'daily' | 'stage', at: number): Promise<void> {
    const docKey = key(account.accountId, at)
    if (this.lab.k.docs.get('lab-daily-snapshot', docKey)) return
    const existing = this.entries().some((entry) => entry.type === 'position.snapshot' && entry.subject.accountId === account.accountId && entry.ts === at && entry.payload?.lab === true)
    if (existing) { this.lab.k.docs.put('lab-daily-snapshot', docKey, { accountId: account.accountId, at }); return }
    const captured = await this.capture(account)
    this.lab.k.ledger.append({
      type: 'position.snapshot', ts: at, origin: systemOrigin('lab:position.snapshot'),
      subject: { orgId: ORG, accountId: account.accountId as never, ...(experimentId ? { experimentId: experimentId as never } : {}) },
      payload: { lab: true, kind, at, sampledAt: this.lab.k.clock.now(), equity: captured.equity, unrealizedPnl: captured.unrealizedPnl, valuationCcy: captured.valuationCcy },
      attestation: 'kernel-observed',
    })
    this.lab.k.docs.put('lab-daily-snapshot', docKey, { accountId: account.accountId, at })
  }

  async tick(): Promise<void> {
    if (this.lab.k.replayFixture) return
    const now = this.lab.k.clock.now()
    const day = Math.floor(now / DAY_MS)
    if (day <= this.lastDay) return
    const boundary = day * DAY_MS
    if (now - boundary > 60_000) {
      this.lab.k.log('lab daily snapshot skipped: sampling window elapsed')
      this.saveDay(day)
      return
    }
    if (day > this.lastDay + 1) this.lab.k.log('lab daily snapshot skipped: missed UTC days')
    const active = this.lab.all().filter((exp) => (exp.runs ?? []).some((run) => run.to === null && run.accountId))
    const accounts = new Map<string, { account: Account; experimentId: string }>()
    for (const exp of active) for (const account of this.accounts(exp)) if (!accounts.has(account.accountId)) accounts.set(account.accountId, { account, experimentId: exp.experimentId })
    const failedAccounts = new Set<string>()
    for (const { account, experimentId } of accounts.values()) {
      try { await this.appendSnapshot(account, experimentId, 'daily', boundary) } catch { failedAccounts.add(account.accountId); this.lab.k.log('lab daily snapshot unavailable') }
    }
    if (!failedAccounts.size) this.saveDay(day)
    const origin = systemOrigin('lab:forward.refresh')
    for (const exp of active) {
      try {
        if (this.accounts(exp).some((account) => failedAccounts.has(account.accountId))) continue
        const computedAt = this.lab.k.clock.now()
        const { stats, baseline } = await this.compute(exp, computedAt, false)
        const next = clone(exp)
        next.forward = stats
        next.baseline = baseline
        this.lab.write(exp, next, { kind: 'forward.refresh' }, origin)
      } catch { this.lab.k.log('lab forward evidence incomplete') }
    }
  }

  async compute(exp: Experiment, now: number, finalized: boolean, batch?: StageSnapshotBatch): Promise<{ input: ForwardStatsInput; stats: ForwardStats; baseline: BaselineRef }> {
    if (this.lab.k.replayFixture) return fail('INVALID_PARAMS', 'forward experiment evidence is unavailable in a historical replay home')
    if (batch && batch.at !== now) return evidence('Stage snapshot endpoint differs from forward computation time')
    const runs = (exp.runs ?? []).filter((run) => run.accountId && (run.to === null || run.to >= now)).map((run) => {
      const account = this.lab.k.accounts.get(run.accountId!)
      if (account.mode !== 'paper' || !run.executor || !run.runId || run.attachedAt === undefined) return evidence('An active paper run is incomplete')
      return { runId: run.runId, accountId: run.accountId!, executor: clone(run.executor), attachedAt: run.attachedAt, to: run.to } satisfies ForwardRunInput
    })
    if (!runs.length) return evidence('No active paper runs are available')
    const from = Math.max(exp.stageEnteredAt ?? 0, ...runs.map((run) => run.attachedAt))
    if (now < from) return evidence('Forward window is invalid')
    const start = this.lab.k.docs.get<StartDoc>('lab-forward-start', key(exp.experimentId, from))
    if (!start || start.at !== from) return evidence('Exact forward start snapshot is missing')
    const accountIds = new Set(runs.map((run) => run.accountId))
    const initialEquity = start.initialEquity.filter((item) => accountIds.has(item.accountId)).map(clone)
    if (initialEquity.length !== accountIds.size) return evidence('Forward start snapshot does not cover every account')
    const ccySet = new Set(runs.map((run) => this.lab.k.accounts.get(run.accountId).paper?.ccy ?? 'USD'))
    if (ccySet.size !== 1 || start.valuationCcy !== [...ccySet][0]) return evidence('Mixed account valuation currencies are not supported')
    const valuationCcy = [...ccySet][0] as string
    const allEntries = this.entries()
    const intentByClientOrder = new Map<string, Origin>()
    for (const entry of allEntries) {
      if (entry.type === 'order.intent' && typeof entry.payload?.intent?.clientOrderId === 'string') {
        const origin: Origin = {
          ...entry.origin,
          ...(entry.origin.causation ? { causation: { ...entry.origin.causation } } : {}),
        }
        if (origin.actorType === 'llm-agent' && typeof entry.subject.mandateId === 'string') {
          origin.causation = { ...origin.causation, mandateId: entry.subject.mandateId as never }
        }
        intentByClientOrder.set(entry.payload.intent.clientOrderId, origin)
      }
    }
    const orderRows = this.lab.k.db.prepare('SELECT order_id,doc FROM orders').all() as { order_id: string; doc: string }[]
    const orderClient = new Map<string, string>()
    for (const row of orderRows) {
      const order = JSON.parse(row.doc) as { orderId: string; clientOrderId: string }
      orderClient.set(order.orderId, order.clientOrderId)
    }
    const startPositions = start.positionsByAccount
    const current = new Map<string, d.Dec>()
    for (const [accountId, positions] of Object.entries(startPositions)) for (const position of positions) current.set(`${accountId}:${position.instrumentId}`, signedPosition(position))
    const runByAccount = new Map<string, ForwardRunInput[]>()
    for (const run of runs) runByAccount.set(run.accountId, [...(runByAccount.get(run.accountId) ?? []), run])
    const fills: ForwardFillSlice[] = []
    for (const entry of allEntries) {
      if (entry.type !== 'fill' || !entry.subject.accountId || !accountIds.has(entry.subject.accountId)) continue
      if (!Number.isSafeInteger(entry.ts) || !Number.isSafeInteger(entry.recordedAt)) return evidence('Recorded fill timestamps are malformed')
      if (entry.ts < from || entry.ts > now || entry.recordedAt > now) continue
      const payload = entry.payload
      const ts = payload?.venueTs
      if (!Number.isSafeInteger(ts)) return evidence('Recorded fill event time is malformed')
      if (entry.recordedAt < from || ts < from || ts > now) continue
      const account = this.lab.k.accounts.get(entry.subject.accountId)
      const ccy = account.paper?.ccy
      if (!ccy) return evidence('Paper account currency context is missing')
      if (payload?.feeCcy !== undefined && payload.feeCcy !== ccy) return evidence('Fill fee currency differs from account valuation currency')
      if (payload?.feeCcy === undefined && !account.paper?.ccy) return evidence('Fill fee currency is not attributable')
      const instrumentId = entry.subject.instrumentId
      const orderId = entry.subject.orderId
      const fillId = entry.subject.fillId
      const size = payload?.size
      const side = payload?.side
      const fee = payload?.fee
      const realizedPnl = payload?.realizedPnl
      if (typeof instrumentId !== 'string' || typeof orderId !== 'string' || typeof fillId !== 'string' || !Number.isSafeInteger(ts) || typeof size !== 'string' || typeof fee !== 'string' || typeof realizedPnl !== 'string' || (side !== 'buy' && side !== 'sell')) return evidence('Recorded fill fields are incomplete')
      let qty: d.Dec, feeValue: d.Dec, pnl: d.Dec
      try { qty = d.D(size); feeValue = d.D(fee); pnl = d.D(realizedPnl) } catch { return evidence('Recorded fill decimal is malformed') }
      if (!d.gt(qty, d.ZERO)) return evidence('Recorded fill size must be positive')
      const posKey = `${entry.subject.accountId}:${instrumentId}`
      const before = current.get(posKey) ?? d.ZERO
      const delta = side === 'buy' ? qty : d.neg(qty)
      const after = d.add(before, delta)
      const baseOrigin = (() => {
        const clientId = orderClient.get(orderId)
        const intentOrigin = clientId ? intentByClientOrder.get(clientId) : undefined
        if (intentOrigin) return intentOrigin
        return { actor: 'venue:unmatched', actorType: 'system', tool: 'lab:unmatched-fill', requestId: entry.origin.requestId, via: 'internal' } as Origin
      })()
      const accountRuns = runByAccount.get(entry.subject.accountId) ?? []
      const preferred = accountRuns.find((run) => run.attachedAt <= (ts as number) && (run.to === null || run.to >= (ts as number)) && actorMatches(baseOrigin, run.executor))
      const assigned = preferred ?? accountRuns[0]
      if (!assigned) continue
      const common = { fillId: fillId as never, orderId: orderId as never, runId: assigned.runId, accountId: entry.subject.accountId as never, instrumentId: instrumentId as never, positionKey: posKey, seq: entry.seq, ts: ts as number, recordedAt: entry.recordedAt, attestation: entry.attestation, origin: baseOrigin, valuationCcy } as const
      const crosses = !d.isZero(before) && !d.isZero(after) && d.isNeg(before) !== d.isNeg(after)
      if (crosses) {
        const closeQty = d.abs(before)
        const closeFee = d.mul(d.div(closeQty, qty, 18), feeValue)
        const openFee = d.sub(feeValue, closeFee)
        fills.push({ ...common, sliceId: `${fillId}:close`, positionBefore: d.str(before), positionAfter: '0' as never, realizedPnl: d.str(pnl), fee: d.str(closeFee) })
        fills.push({ ...common, sliceId: `${fillId}:open`, positionBefore: '0' as never, positionAfter: d.str(after), realizedPnl: '0' as never, fee: d.str(openFee) })
      } else fills.push({ ...common, sliceId: fillId, positionBefore: d.str(before), positionAfter: d.str(after), realizedPnl: d.str(pnl), fee: d.str(feeValue) })
      current.set(posKey, after)
    }
    const snapshotByAccountTime = new Map<string, ForwardSnapshot>()
    for (const entry of allEntries) {
      if (entry.type !== 'position.snapshot' || entry.payload?.lab !== true || !entry.subject.accountId || !accountIds.has(entry.subject.accountId)) continue
      const payload = entry.payload
      if (typeof payload.at !== 'number' || typeof payload.equity !== 'string' || typeof payload.unrealizedPnl !== 'string' || typeof payload.valuationCcy !== 'string' || (payload.kind !== 'daily' && payload.kind !== 'stage')) continue
      const isBatchEndpoint = !!batch?.sourceSeqs.includes(entry.seq)
      const snapshot: ForwardSnapshot = { seq: entry.seq, accountId: entry.subject.accountId as never, at: isBatchEndpoint ? batch!.at : payload.at, recordedAt: entry.recordedAt, attestation: entry.attestation, kind: payload.kind, equity: payload.equity as never, unrealizedPnl: payload.unrealizedPnl as never, valuationCcy: payload.valuationCcy }
      const snapshotKey = key(snapshot.accountId, snapshot.at)
      const prior = snapshotByAccountTime.get(snapshotKey)
      const priorIsBatchEndpoint = !!batch?.sourceSeqs.includes(prior?.seq ?? -1)
      if (isBatchEndpoint || !prior || snapshot.kind === 'daily' && !priorIsBatchEndpoint) snapshotByAccountTime.set(snapshotKey, snapshot)
    }
    const snapshots = [...snapshotByAccountTime.values()]
    const window = { from, to: now }
    const baseline: BaselineRef = { baselineId: `cash-${exp.experimentId}-${from}`, kind: 'cash', instruments: [], window, prices: [] }
    const input: ForwardStatsInput = {
      tier: 'forward_paper', window, stageEnteredAt: exp.stageEnteredAt ?? from,
      runs: clone(runs), initialEquity, fills, snapshots, valuationCcy, periodsPerYear: 365, finalized, computedAt: now,
      baseline: { baselineId: baseline.baselineId, window, returnRatio: 0 },
    }
    let stats: ForwardStats
    try { stats = await computeForwardStats(input) } catch (error) {
      const reason = error instanceof Error && /^[A-Za-z0-9.[\]_-]+$/.test(error.message) ? error.message : 'forward.evidence'
      return evidence(`Forward evidence is invalid at ${reason}`)
    }
    return { input, stats, baseline }
  }

  private entries(): Entry[] {
    const rows = this.lab.k.db.prepare('SELECT entry FROM ledger ORDER BY seq').all() as { entry: string }[]
    return rows.map((row) => JSON.parse(row.entry) as Entry)
  }
}
