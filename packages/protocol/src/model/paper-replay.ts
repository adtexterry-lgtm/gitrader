// SPDX-License-Identifier: Apache-2.0
import type { StrategySizing } from '../gep/methods'
import type { CandleInterval, Instrument } from './instrument'
import type { Decimal, Ms } from './decimal'
import type { AccountId, InstrumentId, VenueId } from './ids'
import type { Problem } from './problem'
import type { Sha256Digest } from './ids'

export interface PaperReplayProvenance {
  source: 'replay'
  fixtureDigest: Sha256Digest
  runId?: string
}

export interface PaperReplayConfig {
  fixture: string
}

export interface PaperReplayFixture {
  schema: 'gitrader-paper-replay/1'
  venue: VenueId
  instruments: Instrument[]
  interval: CandleInterval
  frames: PaperReplayFrame[]
}

export interface PaperReplayFrame {
  ts: Ms
  marks: Record<InstrumentId, Decimal>
  books: Record<InstrumentId, { bids: [Decimal, Decimal][]; asks: [Decimal, Decimal][] }>
  funding?: Record<InstrumentId, Decimal>
  candles: PaperReplayCandle[]
}

export interface PaperReplayCandle {
  instrumentId: InstrumentId
  interval: CandleInterval
  t: Ms
  closedAt: Ms
  o: Decimal
  h: Decimal
  l: Decimal
  c: Decimal
  v: Decimal
}

export interface PaperReplayStart {
  engineId: string
  accountId: AccountId
  strategyId: string
  instrumentId: InstrumentId
  interval: CandleInterval
  params?: Record<string, number | boolean | string>
  sizing?: Partial<StrategySizing>
}

export interface PaperReplayStatus {
  state: 'idle' | 'running' | 'stopping' | 'completed' | 'cancelled' | 'failed'
  runId?: string
  accountId?: AccountId
  frameIndex: number
  totalFrames: number
  clock: Ms
  startedAt?: Ms
  finishedAt?: Ms
  artifact?: string
  problem?: Problem
  provenance?: PaperReplayProvenance
}
