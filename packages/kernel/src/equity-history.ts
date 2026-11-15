// SPDX-License-Identifier: CPAL-1.0
import { isDecimal } from '@gitrader/protocol'
import type { Decimal, EquityHistoryView } from '@gitrader/protocol'
import type { AccountSnapshot } from './connector'
import type { Docs, Db } from './db'

export const EQUITY_SAMPLE_COLLECTION = 'equity-sample'
const MINUTE_MS = 60_000

interface EquitySample {
  accountId: string
  minute: number
  t: number
  sourceTs: number
  asOf: number
  confirmedAt?: number
  equity: Decimal
  available: Decimal
}

const safeMs = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

/** Persist at most the first fresh, complete local observation in each account minute. */
export function sampleEquity(docs: Docs, accountId: string, observedAt: number, snapshot: AccountSnapshot): boolean {
  if (!safeMs(observedAt) || snapshot.stale === true || snapshot.truncated === true) return false
  if (!safeMs(snapshot.ts) || snapshot.ts > observedAt || !safeMs(snapshot.asOf) || snapshot.asOf > observedAt) return false
  if (snapshot.confirmedAt !== undefined && (!safeMs(snapshot.confirmedAt) || snapshot.confirmedAt > observedAt || observedAt - snapshot.confirmedAt > MINUTE_MS)) return false
  if (!isDecimal(snapshot.equity) || !isDecimal(snapshot.available)) return false
  const minute = Math.floor(observedAt / MINUTE_MS)
  const id = JSON.stringify([accountId, minute])
  if (docs.get<EquitySample>(EQUITY_SAMPLE_COLLECTION, id)) return false
  const sample: EquitySample = {
    accountId, minute, t: observedAt, sourceTs: snapshot.ts, asOf: snapshot.asOf,
    ...(snapshot.confirmedAt === undefined ? {} : { confirmedAt: snapshot.confirmedAt }),
    equity: snapshot.equity, available: snapshot.available,
  }
  docs.put(EQUITY_SAMPLE_COLLECTION, id, sample)
  return true
}

export function queryEquityHistory(db: Db, accountId: string, from: number, to: number, step: '1m' | '1h' | '1d'): EquityHistoryView {
  const firstMinute = Math.floor(from / MINUTE_MS)
  const lastMinute = Math.floor((to - 1) / MINUTE_MS)
  const rows = db.prepare(
    `SELECT doc FROM docs
     WHERE coll=? AND json_extract(id, '$[0]')=?
       AND CAST(json_extract(id, '$[1]') AS INTEGER) BETWEEN ? AND ?
     ORDER BY CAST(json_extract(id, '$[1]') AS INTEGER) ASC`,
  ).all(EQUITY_SAMPLE_COLLECTION, accountId, firstMinute, lastMinute) as { doc: string }[]
  const samples = rows.map((row) => JSON.parse(row.doc) as EquitySample)
  const stepMs = step === '1m' ? MINUTE_MS : step === '1h' ? 3_600_000 : 86_400_000
  const inRange = samples.filter((sample) => sample.t >= from && sample.t < to)
  const byStep = new Map<number, EquitySample>()
  for (const sample of inRange) {
    const bucket = Math.floor(sample.t / stepMs)
    const prior = byStep.get(bucket)
    if (!prior || sample.t > prior.t) byStep.set(bucket, sample)
  }
  const bucketed = [...byStep.values()].sort((a, b) => a.t - b.t)
  // 头尾锚点：全区间最早的样本作第一个点、最晚的样本作最后一个点，中间各桶仍取桶内最晚样本。
  const ordered = [...inRange].sort((a, b) => a.t - b.t)
  const earliest = ordered[0]
  const latest = ordered[ordered.length - 1]
  if (earliest && bucketed[0] && bucketed[0].t !== earliest.t) bucketed.unshift(earliest)
  if (latest && bucketed[bucketed.length - 1] && bucketed[bucketed.length - 1]!.t !== latest.t) bucketed.push(latest)
  const points = bucketed.map(({ t, equity, available }) => ({ t, equity, available }))

  const covered = samples.map((sample) => sample.minute).sort((a, b) => a - b)
  const gaps: { from: number; to: number }[] = []
  let nextMissingMinute = firstMinute
  for (const minute of covered) {
    if (minute < nextMissingMinute) continue
    if (minute > nextMissingMinute) {
      const gapFrom = Math.max(from, nextMissingMinute * MINUTE_MS)
      const gapTo = Math.min(to, minute * MINUTE_MS)
      if (gapFrom < gapTo) gaps.push({ from: gapFrom, to: gapTo })
    }
    nextMissingMinute = minute + 1
  }
  if (nextMissingMinute <= lastMinute) {
    const gapFrom = Math.max(from, nextMissingMinute * MINUTE_MS)
    if (gapFrom < to) gaps.push({ from: gapFrom, to })
  }
  return { points, gaps }
}
