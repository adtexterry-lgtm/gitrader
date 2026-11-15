// SPDX-License-Identifier: Apache-2.0
import { isDecimal, type Decimal, type Ms } from '../model/decimal'
import type { AccountId, Sha256Digest } from '../model/ids'
import type { ForwardFillSlice, ForwardRunInput, ForwardSnapshot, ForwardStats, ForwardStatsInput } from '../model/experiment'
import { canonicalize } from '../ledger/canonicalize'

interface ExactDecimal { units: bigint; scale: number }
interface EquityPoint { at: Ms; equity: ExactDecimal; unrealizedPnl: ExactDecimal; seqs: number[] }
const DAY_MS = 86_400_000
const LEDGER_ATTESTATIONS = new Set(['kernel-observed', 'venue-confirmed', 'engine-reported', 'user-asserted'])
const ACCEPTED_FILL_ATTESTATIONS = new Set(['kernel-observed', 'venue-confirmed'])

function typeError(path: string): never { throw new TypeError(path) }
function rangeError(path: string): never { throw new RangeError(path) }
function plainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}
function requireRecord(value: unknown, path: string): asserts value is Record<string, unknown> {
  if (!plainRecord(value)) typeError(path)
}
function requireArray(value: unknown, path: string): asserts value is unknown[] {
  if (!Array.isArray(value)) typeError(path)
}
function requireString(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) typeError(path)
}
function requireBoolean(value: unknown, path: string): asserts value is boolean {
  if (typeof value !== 'boolean') typeError(path)
}
function requireInteger(value: unknown, path: string): asserts value is number {
  if (typeof value !== 'number') typeError(path)
  if (!Number.isSafeInteger(value) || value < 0) rangeError(path)
}
function requireFinite(value: unknown, path: string): asserts value is number {
  if (typeof value !== 'number') typeError(path)
  if (!Number.isFinite(value)) rangeError(path)
}
function requireDecimal(value: unknown, path: string): asserts value is Decimal {
  if (typeof value !== 'string') typeError(path)
  if (!isDecimal(value)) typeError(path)
}
function parseDecimal(value: Decimal, path: string): ExactDecimal {
  if (!isDecimal(value)) typeError(path)
  const negative = value.startsWith('-')
  const [integer, fraction = ''] = (negative ? value.slice(1) : value).split('.')
  const digits = `${integer}${fraction}`
  return { units: BigInt(`${negative ? '-' : ''}${digits}`), scale: fraction.length }
}
function align(value: ExactDecimal, scale: number): bigint {
  return value.units * 10n ** BigInt(scale - value.scale)
}
function sumDecimals(values: readonly ExactDecimal[]): ExactDecimal {
  const scale = values.reduce((max, value) => Math.max(max, value.scale), 0)
  return { units: values.reduce((total, value) => total + align(value, scale), 0n), scale }
}
function addDecimals(a: ExactDecimal, b: ExactDecimal): ExactDecimal { return sumDecimals([a, b]) }
function subtractDecimals(a: ExactDecimal, b: ExactDecimal): ExactDecimal { return sumDecimals([a, { units: -b.units, scale: b.scale }]) }
function compareDecimals(a: ExactDecimal, b: ExactDecimal): number {
  const scale = Math.max(a.scale, b.scale)
  const left = align(a, scale)
  const right = align(b, scale)
  return left < right ? -1 : left > right ? 1 : 0
}
function equalDecimals(a: ExactDecimal, b: ExactDecimal): boolean { return compareDecimals(a, b) === 0 }
function decimalString(value: ExactDecimal, path: string): Decimal {
  if (value.units === 0n) return '0' as Decimal
  const negative = value.units < 0n
  let digits = (negative ? -value.units : value.units).toString()
  if (value.scale > 0) {
    digits = digits.padStart(value.scale + 1, '0')
    const cut = digits.length - value.scale
    const fraction = digits.slice(cut).replace(/0+$/, '')
    digits = fraction ? `${digits.slice(0, cut)}.${fraction}` : digits.slice(0, cut)
  }
  const result = `${negative ? '-' : ''}${digits}`
  if (!isDecimal(result)) rangeError(path)
  return result
}
function bigintScientific(value: bigint): { mantissa: number; exponent: number; sign: number } {
  const sign = value < 0n ? -1 : 1
  const digits = (value < 0n ? -value : value).toString()
  const count = Math.min(16, digits.length)
  return { mantissa: Number(digits.slice(0, count)) / 10 ** (count - 1), exponent: digits.length - 1, sign }
}
function ratio(a: ExactDecimal, b: ExactDecimal, path: string): number {
  if (b.units === 0n) rangeError(path)
  if (a.units === 0n) return 0
  const left = bigintScientific(a.units)
  const right = bigintScientific(b.units)
  const exponent = left.exponent - right.exponent + b.scale - a.scale
  const value = left.sign * right.sign * (left.mantissa / right.mantissa) * 10 ** exponent
  if (!Number.isFinite(value)) rangeError(path)
  return value
}
function validateWindow(value: unknown, path: string): asserts value is { from: Ms; to: Ms } {
  requireRecord(value, path)
  requireInteger(value.from, `${path}.from`)
  requireInteger(value.to, `${path}.to`)
  if ((value.to as number) < (value.from as number)) rangeError(`${path}.to`)
}
function validateExecutor(value: unknown, path: string): asserts value is ForwardRunInput['executor'] {
  requireRecord(value, path)
  if (value.kind === 'agent') requireString(value.mandateId, `${path}.mandateId`)
  else if (value.kind === 'engine') {
    requireString(value.engineId, `${path}.engineId`)
    requireString(value.instanceId, `${path}.instanceId`)
    if (value.codeDigest !== null && (typeof value.codeDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value.codeDigest))) typeError(`${path}.codeDigest`)
  } else typeError(`${path}.kind`)
}
function originMatches(slice: ForwardFillSlice, run: ForwardRunInput): boolean {
  const causation = slice.origin?.causation
  if (!causation) return false
  if (run.executor.kind === 'agent') return slice.origin.actorType === 'llm-agent' && causation.mandateId === run.executor.mandateId
  return slice.origin.actorType === 'engine' && causation.engineId === run.executor.engineId && causation.instanceId === run.executor.instanceId
}
function validateFill(fill: unknown, index: number): asserts fill is ForwardFillSlice {
  const path = `fills[${index}]`
  requireRecord(fill, path)
  for (const key of ['sliceId', 'fillId', 'orderId', 'runId', 'accountId', 'instrumentId', 'positionKey', 'valuationCcy'] as const) requireString(fill[key], `${path}.${key}`)
  requireInteger(fill.seq, `${path}.seq`)
  requireInteger(fill.ts, `${path}.ts`)
  requireInteger(fill.recordedAt, `${path}.recordedAt`)
  requireString(fill.attestation, `${path}.attestation`)
  if (!LEDGER_ATTESTATIONS.has(fill.attestation)) typeError(`${path}.attestation`)
  requireRecord(fill.origin, `${path}.origin`)
  for (const key of ['actor', 'actorType', 'tool', 'requestId', 'via'] as const) requireString(fill.origin[key], `${path}.origin.${key}`)
  if (fill.origin.causation !== undefined) requireRecord(fill.origin.causation, `${path}.origin.causation`)
  requireDecimal(fill.positionBefore, `${path}.positionBefore`)
  requireDecimal(fill.positionAfter, `${path}.positionAfter`)
  requireDecimal(fill.realizedPnl, `${path}.realizedPnl`)
  requireDecimal(fill.fee, `${path}.fee`)
  const before = parseDecimal(fill.positionBefore, `${path}.positionBefore`)
  const after = parseDecimal(fill.positionAfter, `${path}.positionAfter`)
  if (before.units !== 0n && after.units !== 0n && (before.units < 0n) !== (after.units < 0n)) rangeError(`${path}.positionBefore`)
}
function validateSnapshot(snapshot: unknown, index: number): asserts snapshot is ForwardSnapshot {
  const path = `snapshots[${index}]`
  requireRecord(snapshot, path)
  requireInteger(snapshot.seq, `${path}.seq`)
  requireString(snapshot.accountId, `${path}.accountId`)
  requireInteger(snapshot.at, `${path}.at`)
  requireInteger(snapshot.recordedAt, `${path}.recordedAt`)
  if (snapshot.kind !== 'daily' && snapshot.kind !== 'stage') typeError(`${path}.kind`)
  requireString(snapshot.attestation, `${path}.attestation`)
  if (!LEDGER_ATTESTATIONS.has(snapshot.attestation)) typeError(`${path}.attestation`)
  requireString(snapshot.valuationCcy, `${path}.valuationCcy`)
  requireDecimal(snapshot.equity, `${path}.equity`)
  requireDecimal(snapshot.unrealizedPnl, `${path}.unrealizedPnl`)
}
function validateRun(run: unknown, index: number): asserts run is ForwardRunInput {
  const path = `runs[${index}]`
  requireRecord(run, path)
  requireString(run.runId, `${path}.runId`)
  requireString(run.accountId, `${path}.accountId`)
  validateExecutor(run.executor, `${path}.executor`)
  requireInteger(run.attachedAt, `${path}.attachedAt`)
  if (run.to !== null) requireInteger(run.to, `${path}.to`)
}
function closeSet(values: readonly string[]): Set<string> { return new Set(values) }
function sortedUnique<T extends string>(values: readonly T[]): T[] { return [...new Set(values)].sort() }
function utcDay(at: number): number { return Math.floor(at / DAY_MS) }
function finiteAnalysis(value: number, path: string): number {
  if (!Number.isFinite(value)) rangeError(path)
  return value
}

export async function computeForwardStats(input: ForwardStatsInput): Promise<ForwardStats> {
  requireRecord(input, 'input')
  if (input.tier !== 'forward_paper') typeError('tier')
  validateWindow(input.window, 'window')
  requireInteger(input.stageEnteredAt, 'stageEnteredAt')
  requireInteger(input.computedAt, 'computedAt')
  if (input.computedAt < input.window.to) rangeError('computedAt')
  requireArray(input.runs, 'runs')
  requireArray(input.initialEquity, 'initialEquity')
  requireArray(input.fills, 'fills')
  requireArray(input.snapshots, 'snapshots')
  requireString(input.valuationCcy, 'valuationCcy')
  requireFinite(input.periodsPerYear, 'periodsPerYear')
  if (input.periodsPerYear <= 0) rangeError('periodsPerYear')
  requireBoolean(input.finalized, 'finalized')
  if (input.baseline !== undefined) {
    requireRecord(input.baseline, 'baseline')
    requireString(input.baseline.baselineId, 'baseline.baselineId')
    validateWindow(input.baseline.window, 'baseline.window')
    requireFinite(input.baseline.returnRatio, 'baseline.returnRatio')
    if (input.baseline.window.from !== input.window.from || input.baseline.window.to !== input.window.to) rangeError('baseline.window')
  }
  if (input.runs.length === 0) rangeError('runs')

  const runIds = new Set<string>()
  const accountIds = new Set<AccountId>()
  for (let index = 0; index < input.runs.length; index++) {
    const run = input.runs[index]
    validateRun(run, index)
    if (runIds.has(run.runId)) rangeError('runs.runId')
    runIds.add(run.runId)
    accountIds.add(run.accountId)
    if (run.to !== null && run.to < input.window.to) rangeError('runs.to')
  }
  const latestStart = Math.max(input.stageEnteredAt, ...input.runs.map((run) => run.attachedAt))
  if (input.window.from !== latestStart) rangeError('window.from')

  requireArray(input.initialEquity, 'initialEquity')
  const initialByAccount = new Map<AccountId, { equity: ExactDecimal; unrealizedPnl: ExactDecimal }>()
  for (let index = 0; index < input.initialEquity.length; index++) {
    const entry = input.initialEquity[index]
    const path = `initialEquity[${index}]`
    requireRecord(entry, path)
    requireString(entry.accountId, `${path}.accountId`)
    requireInteger(entry.at, `${path}.at`)
    requireDecimal(entry.equity, `${path}.equity`)
    requireDecimal(entry.unrealizedPnl, `${path}.unrealizedPnl`)
    const equity = parseDecimal(entry.equity, `${path}.equity`)
    if (equity.units <= 0n) rangeError(`${path}.equity`)
    if (entry.at !== input.window.from) rangeError(`${path}.at`)
    if (initialByAccount.has(entry.accountId)) rangeError(`${path}.accountId`)
    initialByAccount.set(entry.accountId, { equity, unrealizedPnl: parseDecimal(entry.unrealizedPnl, `${path}.unrealizedPnl`) })
  }
  if (initialByAccount.size !== accountIds.size || [...accountIds].some((id) => !initialByAccount.has(id))) rangeError('initialEquity')
  const initialEquity = sumDecimals([...initialByAccount.values()].map((entry) => entry.equity))
  const initialUnrealized = sumDecimals([...initialByAccount.values()].map((entry) => entry.unrealizedPnl))

  const runById = new Map(input.runs.map((run) => [run.runId, run]))
  const effectiveFills: ForwardFillSlice[] = []
  const usedSliceIds = new Set<string>()
  for (let index = 0; index < input.fills.length; index++) {
    const fill = input.fills[index]
    validateFill(fill, index)
    const run = runById.get(fill.runId)
    const matches = ACCEPTED_FILL_ATTESTATIONS.has(fill.attestation) && run !== undefined && run.accountId === fill.accountId &&
      fill.ts >= input.window.from && fill.ts <= input.window.to && fill.recordedAt >= input.window.from &&
      fill.recordedAt <= input.window.to && fill.recordedAt >= run.attachedAt && originMatches(fill, run)
    if (!matches) continue
    if (fill.valuationCcy !== input.valuationCcy) rangeError('fills.valuationCcy')
    if (usedSliceIds.has(fill.sliceId)) rangeError('fills.sliceId')
    usedSliceIds.add(fill.sliceId)
    effectiveFills.push(fill)
  }
  const orderedFills = [...input.fills].sort((a, b) => a.ts - b.ts || a.seq - b.seq || (a.sliceId < b.sliceId ? -1 : a.sliceId > b.sliceId ? 1 : 0))
  const acceptedFills = new Set(effectiveFills)

  const previousPosition = new Map<string, ExactDecimal>()
  const cycleOpen = new Map<string, boolean>()
  const cycleNet = new Map<string, ExactDecimal>()
  let roundTrips = 0
  let wins = 0
  for (const fill of orderedFills) {
    const group = `${fill.accountId}\u0000${fill.instrumentId}\u0000${fill.positionKey}`
    if (!acceptedFills.has(fill)) {
      // A filtered slice breaks attribution of this cycle, even if its net position is unchanged.
      previousPosition.delete(group)
      cycleOpen.delete(group)
      cycleNet.delete(group)
      continue
    }
    const before = parseDecimal(fill.positionBefore, 'fills.positionBefore')
    const after = parseDecimal(fill.positionAfter, 'fills.positionAfter')
    const previous = previousPosition.get(group)
    if (previous && !equalDecimals(previous, before)) rangeError('fills.positionContinuity')
    const started = before.units === 0n && after.units !== 0n
    if (started) {
      cycleOpen.set(group, true)
      cycleNet.set(group, { units: 0n, scale: 0 })
    }
    if (cycleOpen.get(group)) {
      const pnl = subtractDecimals(parseDecimal(fill.realizedPnl, 'fills.realizedPnl'), parseDecimal(fill.fee, 'fills.fee'))
      cycleNet.set(group, addDecimals(cycleNet.get(group) ?? { units: 0n, scale: 0 }, pnl))
      if (after.units === 0n && before.units !== 0n) {
        roundTrips++
        if ((cycleNet.get(group)?.units ?? 0n) > 0n) wins++
        cycleOpen.set(group, false)
        cycleNet.delete(group)
      }
    }
    previousPosition.set(group, after)
  }

  const selectedSnapshots: ForwardSnapshot[] = []
  const knownAccounts = closeSet([...accountIds])
  for (let index = 0; index < input.snapshots.length; index++) {
    const snapshot = input.snapshots[index]
    validateSnapshot(snapshot, index)
    parseDecimal(snapshot.equity, `snapshots[${index}].equity`)
    parseDecimal(snapshot.unrealizedPnl, `snapshots[${index}].unrealizedPnl`)
    const timeAllowed = snapshot.at > input.window.from && snapshot.at <= input.window.to
    const kindAllowed = snapshot.kind === 'daily' ? snapshot.at % DAY_MS === 0 : snapshot.at === input.window.to
    if (snapshot.attestation === 'kernel-observed' && knownAccounts.has(snapshot.accountId) && snapshot.valuationCcy === input.valuationCcy &&
        timeAllowed && snapshot.recordedAt <= input.computedAt && kindAllowed) {
      const equity = parseDecimal(snapshot.equity, 'snapshots.equity')
      if (equity.units < 0n) rangeError('snapshots.equity')
      selectedSnapshots.push(snapshot)
    }
  }
  const seenSnapshotKeys = new Set<string>()
  for (const snapshot of selectedSnapshots) {
    const key = `${snapshot.accountId}\u0000${snapshot.at}`
    if (seenSnapshotKeys.has(key)) rangeError('snapshots.accountId.at')
    seenSnapshotKeys.add(key)
  }
  const byTime = new Map<Ms, ForwardSnapshot[]>()
  for (const snapshot of selectedSnapshots) byTime.set(snapshot.at, [...(byTime.get(snapshot.at) ?? []), snapshot])
  const completePoints: EquityPoint[] = []
  for (const [at, rows] of byTime) {
    const rowByAccount = new Map(rows.map((row) => [row.accountId, row]))
    if ([...accountIds].some((id) => !rowByAccount.has(id))) continue
    const complete = [...accountIds].map((id) => rowByAccount.get(id) as ForwardSnapshot)
    completePoints.push({
      at,
      equity: sumDecimals(complete.map((row) => parseDecimal(row.equity, 'snapshots.equity'))),
      unrealizedPnl: sumDecimals(complete.map((row) => parseDecimal(row.unrealizedPnl, 'snapshots.unrealizedPnl'))),
      seqs: complete.map((row) => row.seq),
    })
  }
  completePoints.sort((a, b) => a.at - b.at)
  if (input.finalized && input.window.to > input.window.from && !completePoints.some((point) => point.at === input.window.to)) rangeError('forward.endpoint')

  const curve: EquityPoint[] = [{ at: input.window.from, equity: initialEquity, unrealizedPnl: initialUnrealized, seqs: [] }, ...completePoints]
  let peak = initialEquity
  let maxDrawdown = 0
  let growth = 1
  for (let index = 1; index < curve.length; index++) {
    const previousPoint = curve[index - 1]
    const currentPoint = curve[index]
    if (previousPoint === undefined || currentPoint === undefined) rangeError('forward.curve')
    const previous = previousPoint.equity
    const current = currentPoint.equity
    if (current.units < 0n) rangeError('snapshots.equity')
    if (previous.units === 0n) rangeError('snapshots.equity')
    growth = finiteAnalysis(growth * ratio(current, previous, 'forward.returnRatio'), 'forward.returnRatio')
    if (compareDecimals(current, peak) > 0) peak = current
    const drawdown = ratio(subtractDecimals(peak, current), peak, 'forward.maxDrawdownRatio')
    maxDrawdown = Math.max(maxDrawdown, drawdown)
  }
  if (curve.length === 1 && input.finalized && input.window.to === input.window.from) {
    // A finalized zero-length window is represented by its validated starting equity.
  }
  const returnRatio = finiteAnalysis(growth - 1, 'forward.returnRatio')

  const dailyReturns: number[] = []
  let previousDaily = initialEquity
  let snapshotDays = 0
  for (const point of completePoints) {
    if (point.at % DAY_MS !== 0) continue
    snapshotDays++
    dailyReturns.push(finiteAnalysis(ratio(point.equity, previousDaily, 'forward.returnRatio') - 1, 'forward.returnRatio'))
    previousDaily = point.equity
  }
  let sharpe: number | null = null
  let sortino: number | null = null
  if (snapshotDays >= 10) {
    const mean = dailyReturns.reduce((total, value) => total + value, 0) / dailyReturns.length
    const variance = dailyReturns.reduce((total, value) => total + (value - mean) ** 2, 0) / (dailyReturns.length - 1)
    const standardDeviation = Math.sqrt(variance)
    if (standardDeviation > 0) sharpe = finiteAnalysis((mean / standardDeviation) * Math.sqrt(input.periodsPerYear), 'forward.sharpe')
    const downside = Math.sqrt(dailyReturns.reduce((total, value) => total + Math.min(value, 0) ** 2, 0) / dailyReturns.length)
    if (downside > 0) sortino = finiteAnalysis((mean / downside) * Math.sqrt(input.periodsPerYear), 'forward.sortino')
  }

  const realizedPnl = sumDecimals(effectiveFills.map((fill) => parseDecimal(fill.realizedPnl, 'fills.realizedPnl')))
  const fees = sumDecimals(effectiveFills.map((fill) => parseDecimal(fill.fee, 'fills.fee')))
  const endPoint = curve.at(-1)
  if (endPoint === undefined) rangeError('forward.curve')
  const endUnrealized = endPoint.unrealizedPnl
  const seqs = [...effectiveFills.map((fill) => fill.seq), ...completePoints.flatMap((point) => point.seqs)]
  const output: ForwardStats = {
    tier: 'forward_paper',
    runIds: sortedUnique(input.runs.map((run) => run.runId)),
    accountIds: sortedUnique([...accountIds]),
    window: { from: input.window.from, to: input.window.to },
    ledgerRange: seqs.length ? { fromSeq: seqs.reduce((min, seq) => Math.min(min, seq), Number.MAX_SAFE_INTEGER), toSeq: seqs.reduce((max, seq) => Math.max(max, seq), 0) } : { fromSeq: 0, toSeq: 0 },
    sample: {
      trades: new Set(effectiveFills.map((fill) => fill.orderId)).size,
      fills: new Set(effectiveFills.map((fill) => fill.fillId)).size,
      roundTrips,
      spanDays: (input.window.to - input.window.from) / DAY_MS,
      activeDays: new Set(effectiveFills.map((fill) => utcDay(fill.ts))).size,
      snapshotDays,
    },
    valuationCcy: input.valuationCcy,
    realizedPnl: decimalString(realizedPnl, 'realizedPnl'),
    unrealizedPnlEnd: decimalString(endUnrealized, 'unrealizedPnlEnd'),
    fees: decimalString(fees, 'fees'),
    funding: '0' as Decimal,
    returnRatio,
    maxDrawdownRatio: finiteAnalysis(maxDrawdown, 'forward.maxDrawdownRatio'),
    sharpe,
    sortino,
    winRatio: roundTrips === 0 ? null : wins / roundTrips,
    periodsPerYear: input.periodsPerYear,
    includesUnrealized: true,
    ...(input.baseline ? { vsBaseline: { baselineId: input.baseline.baselineId, excessReturnRatio: finiteAnalysis(returnRatio - input.baseline.returnRatio, 'vsBaseline.excessReturnRatio') } } : {}),
    provisional: !input.finalized,
    computedAt: input.computedAt,
    computedBy: 'kernel',
    digest: 'sha256:' as Sha256Digest,
  }
  const digestInput = { ...output } as Partial<ForwardStats>
  delete digestInput.digest
  const cryptoApi = globalThis.crypto?.subtle
  if (!cryptoApi) throw new Error('forward.digest')
  let hash: ArrayBuffer
  try {
    hash = await cryptoApi.digest('SHA-256', new TextEncoder().encode(canonicalize(digestInput)))
  } catch {
    throw new Error('forward.digest')
  }
  output.digest = `sha256:${[...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}` as Sha256Digest
  return output
}
