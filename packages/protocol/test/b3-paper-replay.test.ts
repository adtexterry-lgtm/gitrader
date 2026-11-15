// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest'
import { GEP_METHODS, listSchemaIds, validateBySchemaId } from '../src'
import type { HostMethods, PaperReplayConfig, PaperReplayFixture, PaperReplayStart, PaperReplayStatus } from '../src/types'
import { contract } from './helpers'

const modelRef = (name: string): string => `urn:gitrader:schema:model:0.1:${name}`
const methodRef = (method: string, part: 'params' | 'result'): string =>
  `urn:gitrader:schema:gep:0.1:Methods#/$defs/${method}:${part}`

const instrument = contract('instrument-xyz-tsla') as { instrumentId: string; venue: string }
const account = { accountId: 'acct_12345' }

const candle = () => ({ instrumentId: instrument.instrumentId, interval: '1m', t: 0, closedAt: 60_000, o: '1', h: '2', l: '1', c: '2', v: '3' })
const frame = () => ({
  ts: 60_000,
  marks: { [instrument.instrumentId]: '2' },
  books: { [instrument.instrumentId]: { bids: [['1', '2']], asks: [['2', '3']] } },
  funding: { [instrument.instrumentId]: '0.001' },
  candles: [candle()],
})
const fixture = () => ({ schema: 'gitrader-paper-replay/1', venue: instrument.venue, instruments: [instrument], interval: '1m', frames: [frame()] })
const start = () => ({
  engineId: 'engine-paper', accountId: account.accountId, strategyId: 'strategy-paper',
  instrumentId: instrument.instrumentId, interval: '1m', params: { periods: 4, enabled: true, mode: 'paper' }, sizing: { leverage: 2 },
})
const status = () => ({ state: 'running', runId: 'run-paper', accountId: account.accountId, frameIndex: -1, totalFrames: 1, clock: 0 })

describe('B3 additive paper replay protocol', () => {
  it('exports replay types from the type-only entry point', () => {
    type PublicTypes = [PaperReplayConfig, PaperReplayFixture, PaperReplayStart, PaperReplayStatus, HostMethods['paper.replay.start']]
    const typeCheck: PublicTypes | undefined = undefined
    expect(typeCheck).toBeUndefined()
  })

  it('registers three optional host methods and the replay model schemas', () => {
    const methods = GEP_METHODS as Record<string, unknown>
    expect(methods['paper.replay.start']).toEqual({ side: 'host', requirement: 'optional' })
    expect(methods['paper.replay.status']).toEqual({ side: 'host', requirement: 'optional' })
    expect(methods['paper.replay.stop']).toEqual({ side: 'host', requirement: 'optional' })
    for (const name of ['PaperReplayConfig', 'PaperReplayFixture', 'PaperReplayFrame', 'PaperReplayCandle', 'PaperReplayStart', 'PaperReplayStatus']) {
      expect(listSchemaIds()).toContain(modelRef(name))
    }
  })

  it('accepts fixture, start, status, and all method request/result shapes', () => {
    expect(validateBySchemaId(modelRef('PaperReplayConfig'), { fixture: 'fixture.json' }).ok).toBe(true)
    expect(validateBySchemaId(modelRef('PaperReplayFixture'), fixture()).ok).toBe(true)
    expect(validateBySchemaId(modelRef('PaperReplayStart'), start()).ok).toBe(true)
    expect(validateBySchemaId(modelRef('PaperReplayStatus'), status()).ok).toBe(true)
    expect(validateBySchemaId(methodRef('paper.replay.start', 'params'), start()).ok).toBe(true)
    expect(validateBySchemaId(methodRef('paper.replay.start', 'result'), { runId: 'run-paper' }).ok).toBe(true)
    expect(validateBySchemaId(methodRef('paper.replay.status', 'params'), {}).ok).toBe(true)
    expect(validateBySchemaId(methodRef('paper.replay.status', 'result'), status()).ok).toBe(true)
    expect(validateBySchemaId(methodRef('paper.replay.stop', 'params'), { runId: 'run-paper' }).ok).toBe(true)
    expect(validateBySchemaId(methodRef('paper.replay.stop', 'result'), { ...status(), state: 'cancelled' }).ok).toBe(true)
  })

  it('rejects accounting numbers, noninteger times, malformed book tuples, bad status, and nested params', () => {
    const numericPrice = fixture()
    numericPrice.frames[0]!.marks[instrument.instrumentId] = 2 as never
    expect(validateBySchemaId(modelRef('PaperReplayFixture'), numericPrice).ok).toBe(false)

    const fractionalTime = fixture()
    fractionalTime.frames[0]!.candles[0]!.closedAt = 60_000.5
    expect(validateBySchemaId(modelRef('PaperReplayFixture'), fractionalTime).ok).toBe(false)

    const malformedTuple = fixture()
    malformedTuple.frames[0]!.books[instrument.instrumentId]!.bids = [['1']] as never
    expect(validateBySchemaId(modelRef('PaperReplayFixture'), malformedTuple).ok).toBe(false)

    expect(validateBySchemaId(modelRef('PaperReplayStatus'), { ...status(), state: 'paused' }).ok).toBe(false)
    expect(validateBySchemaId(modelRef('PaperReplayStatus'), { ...status(), frameIndex: 0.5 }).ok).toBe(false)
    expect(validateBySchemaId(modelRef('PaperReplayStatus'), { ...status(), clock: -1 }).ok).toBe(false)
    expect(validateBySchemaId(modelRef('PaperReplayStatus'), { ...status(), artifact: '../outside.json' }).ok).toBe(false)
    expect(validateBySchemaId(modelRef('PaperReplayStart'), { ...start(), params: { nested: { value: 1 } } }).ok).toBe(false)
    expect(validateBySchemaId(modelRef('PaperReplayStart'), { ...start(), params: { infinite: Number.POSITIVE_INFINITY } }).ok).toBe(false)
  })

  it('rejects client authority fields and other undeclared start keys while leaving scalar params open', () => {
    const invalid = [
      { ...start(), mandateId: 'mdt_client' },
      { ...start(), actor: 'user:client' },
      { ...start(), authorization: { mandateId: 'mdt_client' } },
      { ...start(), unexpected: true },
    ]
    for (const input of invalid) {
      expect(validateBySchemaId(modelRef('PaperReplayStart'), input).ok).toBe(false)
      expect(validateBySchemaId(methodRef('paper.replay.start', 'params'), input).ok).toBe(false)
    }
    const dynamicParams = { ...start(), params: { vendorFlag: 'x', count: 3, enabled: false } }
    expect(validateBySchemaId(modelRef('PaperReplayStart'), dynamicParams).ok).toBe(true)
    expect(validateBySchemaId(methodRef('paper.replay.start', 'params'), dynamicParams).ok).toBe(true)
  })
})
