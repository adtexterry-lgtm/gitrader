// SPDX-License-Identifier: CPAL-1.0
import { lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isDecimal, validateBySchemaId, validateInstrument } from '@gitrader/protocol'
import type { PaperReplayFixture } from '@gitrader/protocol'
import type { GitraderConfig } from './config'
import { makeProblem } from './proto'
import { KernelError } from './util/errors'
import { resolveConfinedPath } from './util/confined-path'

const MAX_FIXTURE_BYTES = 16 * 1024 * 1024
const MAX_HORIZON_MS = 365 * 24 * 60 * 60 * 1000
const invalid = (): never => { throw new KernelError(makeProblem('INVALID_PARAMS', 'invalid replay fixture')) }
const finiteDecimal = (value: unknown): value is string => isDecimal(value) && Number.isFinite(Number(value))
const positiveDecimal = (value: unknown): value is string => finiteDecimal(value) && Number(value) > 0
const safeTime = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

function freezeDeep<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child)
  }
  return value
}

function validateSemantics(fixture: PaperReplayFixture, config: GitraderConfig): boolean {
  const instrumentIds = new Set<string>()
  for (const instrument of fixture.instruments) {
    if (!validateInstrument(instrument).ok || instrument.venue !== fixture.venue || instrumentIds.has(instrument.instrumentId)) return false
    instrumentIds.add(instrument.instrumentId)
  }
  if (!Array.isArray(config.accounts) || !config.accounts.length
    || config.accounts.some((account) => account.mode !== 'paper' || account.venue !== fixture.venue)) return false

  let previousTs = -1
  const firstTs = fixture.frames[0]?.ts
  const lastTs = fixture.frames[fixture.frames.length - 1]?.ts
  if (!safeTime(firstTs) || !safeTime(lastTs) || lastTs - firstTs >= MAX_HORIZON_MS) return false

  const latestClosedAt = new Map<string, number>()
  const candleHistory = new Set<string>()
  for (const frame of fixture.frames) {
    if (!safeTime(frame.ts) || frame.ts <= previousTs) return false
    previousTs = frame.ts
    const markIds = Object.keys(frame.marks)
    const bookIds = Object.keys(frame.books)
    if (markIds.length !== instrumentIds.size || bookIds.length !== instrumentIds.size
      || markIds.some((id) => !instrumentIds.has(id)) || bookIds.some((id) => !instrumentIds.has(id))) return false

    for (const price of Object.values(frame.marks)) if (!positiveDecimal(price)) return false
    for (const [id, book] of Object.entries(frame.books)) {
      if (!instrumentIds.has(id) || book.bids.length < 1 || book.bids.length > 200 || book.asks.length < 1 || book.asks.length > 200) return false
      let previousBid = Number.POSITIVE_INFINITY
      for (const [price, size] of book.bids) {
        if (!positiveDecimal(price) || !positiveDecimal(size) || Number(price) >= previousBid) return false
        previousBid = Number(price)
      }
      let previousAsk = Number.NEGATIVE_INFINITY
      for (const [price, size] of book.asks) {
        if (!positiveDecimal(price) || !positiveDecimal(size) || Number(price) <= previousAsk) return false
        previousAsk = Number(price)
      }
      if (Number(book.bids[0]![0]) > Number(book.asks[0]![0])) return false
    }
    if (frame.funding) {
      for (const [id, rate] of Object.entries(frame.funding)) if (!instrumentIds.has(id) || !finiteDecimal(rate)) return false
    }

    for (const candle of frame.candles) {
      const { instrumentId, t, closedAt, o, h, l, c, v } = candle
      if (!instrumentIds.has(instrumentId) || candle.interval !== fixture.interval || !safeTime(t) || !safeTime(closedAt)
        || t >= closedAt || closedAt > frame.ts) return false
      const historyKey = `${instrumentId}\u0000${t}`
      if (candleHistory.has(historyKey) || closedAt <= (latestClosedAt.get(instrumentId) ?? -1)) return false
      if (![o, h, l, c].every(positiveDecimal) || !finiteDecimal(v) || Number(v) < 0) return false
      const open = Number(o); const high = Number(h); const low = Number(l); const close = Number(c)
      if (low > open || low > close || open > high || close > high) return false
      candleHistory.add(historyKey)
      latestClosedAt.set(instrumentId, closedAt)
    }
  }
  return true
}

export function loadReplayFixture(home: string, config: GitraderConfig): PaperReplayFixture {
  try {
    const fixtureName = config.paperReplay?.fixture
    if (typeof fixtureName !== 'string' || !fixtureName.trim()) return invalid()
    const replayRoot = join(home, 'lab', 'replay')
    const path = resolveConfinedPath(replayRoot, fixtureName, { anchorRoot: home, mustExist: true })
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FIXTURE_BYTES) return invalid()
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    const checked = validateBySchemaId('urn:gitrader:schema:model:0.1:PaperReplayFixture', parsed)
    if (!checked.ok || !validateSemantics(checked.value as PaperReplayFixture, config)) return invalid()
    return freezeDeep(checked.value as PaperReplayFixture)
  } catch {
    return invalid()
  }
}
