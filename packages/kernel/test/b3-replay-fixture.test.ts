// SPDX-License-Identifier: CPAL-1.0
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { defaultConfig, validateConfig } from '../src/config'
import { loadReplayFixture } from '../src/replay-fixture'
import { ReplayClock } from '../src/util/clock'

const instrument = (instrumentId = 'venue-test:BTC'): Record<string, unknown> => ({
  instrumentId, venue: 'venue-test', symbol: 'BTC', displaySymbol: 'BTC', kind: 'spot', base: 'BTC', quote: 'USD', settle: 'USD',
  settlement: 'linear', contractSize: '1', venueSizeUnit: 'base', assetClass: 'crypto', status: 'trading',
  price: { tick: '0.1' }, size: { step: '0.01', decimals: 2, min: '0.01' }, orderTypes: ['limit'], tif: ['gtc'],
  triggerPriceTypes: ['mark'], updatedAt: 1,
})
const validFixture = (): Record<string, any> => ({
  schema: 'gitrader-paper-replay/1', venue: 'venue-test', instruments: [instrument()], interval: '1m',
  frames: [
    { ts: 60000, marks: { 'venue-test:BTC': '10' }, books: { 'venue-test:BTC': { bids: [['9', '2']], asks: [['11', '2']] } }, candles: [] },
    { ts: 120000, marks: { 'venue-test:BTC': '11' }, books: { 'venue-test:BTC': { bids: [['10', '2']], asks: [['12', '2']] } }, candles: [] },
  ],
})
const setup = () => {
  const home = mkdtempSync(join(tmpdir(), 'gitrader-replay-'))
  const replayDir = join(home, 'lab', 'replay')
  mkdirSync(replayDir, { recursive: true })
  const fixturePath = join(replayDir, 'fixture.json')
  writeFileSync(fixturePath, JSON.stringify(validFixture()))
  const config = { ...defaultConfig(), paperReplay: { fixture: 'fixture.json' } } as any
  config.accounts[0].venue = 'venue-test'
  return { home, replayDir, fixturePath, config, cleanup: () => rmSync(home, { recursive: true, force: true }) }
}
const load = (s: ReturnType<typeof setup>) => loadReplayFixture(s.home, s.config)
const expectInvalid = (action: () => unknown) => expect(action).toThrowError(expect.objectContaining({ problem: expect.objectContaining({ name: 'INVALID_PARAMS', message: 'invalid replay fixture' }) }))
const expectInvalidParams = (action: () => unknown) => expect(action).toThrowError(expect.objectContaining({ problem: expect.objectContaining({ name: 'INVALID_PARAMS' }) }))

describe('B3 paper replay fixture loader', () => {
  it('keeps default configuration compatible and accepts only an isolated all-paper engine setup', () => {
    expect(defaultConfig().paperReplay).toBeUndefined()
    expect(validateConfig(defaultConfig())).toEqual([])
    const valid = setup()
    try { expect(validateConfig(valid.config)).toEqual([]) } finally { valid.cleanup() }
    for (const mutate of [
      (c: any) => { c.accounts[0].mode = 'shadow' },
      (c: any) => { c.accounts[0].mode = 'live' },
      (c: any) => { c.accounts = [] },
      (c: any) => { c.engines[0].enabled = false },
      (c: any) => { c.engines.push({ id: 'other', enabled: true, builtin: true }) },
      (c: any) => { c.engines[0].launch = { command: 'x' } },
      (c: any) => { c.paperReplay.fixture = '   ' },
      (c: any) => { c.paperReplay.fixture = '../outside.json' },
    ]) {
      const c = { ...defaultConfig(), paperReplay: { fixture: 'fixture.json' } } as any
      mutate(c)
      expect(validateConfig(c).length).toBeGreaterThan(0)
    }
  })

  it('loads a relative fixture, keeps decimal strings, and deeply freezes the result', () => {
    const s = setup()
    try {
      const result = load(s)
      expect(result.frames[0]?.marks['venue-test:BTC']).toBe('10')
      expect(Object.isFrozen(result)).toBe(true)
      expect(Object.isFrozen(result.frames)).toBe(true)
      expect(Object.isFrozen(result.frames[0]?.marks)).toBe(true)
      expect(Object.isFrozen(result.frames[0]?.books['venue-test:BTC']?.bids[0])).toBe(true)
      expect(() => { (result.frames[0]!.marks as any)['venue-test:BTC'] = '12' }).toThrow()
    } finally { s.cleanup() }
  })

  it('loads a nested relative fixture beneath the fixed replay root', () => {
    const s = setup()
    try {
      mkdirSync(join(s.replayDir, 'nested'))
      writeFileSync(join(s.replayDir, 'nested', 'fixture.json'), JSON.stringify(validFixture()))
      s.config.paperReplay.fixture = 'nested/fixture.json'
      expect(load(s).frames).toHaveLength(2)
    } finally { s.cleanup() }
  })

  it('rejects lexical traversal, Windows roots, ADS, and a real replay-root junction escape without touching outside data', () => {
    const s = setup()
    const outside = mkdtempSync(join(tmpdir(), 'gitrader-outside-'))
    const sentinel = join(outside, 'sentinel.json')
    writeFileSync(sentinel, 'untouched')
    try {
      for (const fixture of ['../sentinel.json', 'C:\\sentinel.json', 'folder\\..\\sentinel.json', 'fixture.json:stream']) {
        s.config.paperReplay.fixture = fixture
        expectInvalid(() => load(s))
      }
      rmSync(s.replayDir, { recursive: true, force: true })
      symlinkSync(outside, s.replayDir, 'junction')
      s.config.paperReplay.fixture = 'sentinel.json'
      expectInvalid(() => load(s))
      expect(readFileSync(sentinel, 'utf8')).toBe('untouched')
    } finally { s.cleanup(); rmSync(outside, { recursive: true, force: true }) }
  })

  it('rejects malformed schema and semantic history with a fixed error', () => {
    const s = setup()
    try {
      const base = validFixture()
      const tooManyLevels = validFixture()
      tooManyLevels.frames[0].books['venue-test:BTC'].bids = Array.from({ length: 201 }, (_, index) => [String(300 - index), '1'])
      const invalids = [
        { ...base, frames: [] },
        { ...base, instruments: [instrument(), instrument()] },
        { ...base, instruments: [{ ...instrument(), venue: 'other' }] },
        { ...base, instruments: [{ ...instrument(), instrumentId: 'venue-test:OTHER' }] },
        { ...base, frames: [{ ...base.frames[0], ts: -1 }] },
        { ...base, frames: [base.frames[1], base.frames[0]] },
        { ...base, frames: [{ ...base.frames[0], marks: {} }, base.frames[1]] },
        { ...base, frames: [{ ...base.frames[0], books: { 'venue-test:BTC': { bids: [['9', '2']], asks: [['8', '2']] } } }, base.frames[1]] },
        { ...base, frames: [{ ...base.frames[0], marks: { 'venue-test:BTC': '1e3' } }, base.frames[1]] },
        { ...base, frames: [{ ...base.frames[0], funding: { unknown: '1' } }, base.frames[1]] },
        { ...base, frames: [{ ...base.frames[0], books: { 'venue-test:BTC': { bids: [['8', '1'], ['9', '1']], asks: [['10', '1']] } } }, base.frames[1]] },
        { ...base, frames: [{ ...base.frames[0], marks: { 'venue-test:OTHER': '10' } }, base.frames[1]] },
        { ...base, frames: [{ ...base.frames[0], books: { 'venue-test:OTHER': { bids: [['9', '2']], asks: [['11', '2']] } } }, base.frames[1]] },
        { ...base, frames: [{ ...base.frames[0], ts: 0 }, { ...base.frames[1], ts: 365 * 24 * 60 * 60 * 1000 }] },
        { ...base, frames: [{ ...base.frames[0], books: { 'venue-test:BTC': { bids: [['9', '0']], asks: [['11', '2']] } } }, base.frames[1]] },
        tooManyLevels,
        { ...base, frames: [{ ...base.frames[0], candles: [{ instrumentId: 'venue-test:BTC', interval: '1m', t: 0, closedAt: 60001, o: '10', h: '10', l: '10', c: '10', v: '0' }] }, base.frames[1]] },
        { ...base, frames: [{ ...base.frames[0], candles: [{ instrumentId: 'venue-test:BTC', interval: '1m', t: 0, closedAt: 30000, o: '10', h: '9', l: '8', c: '10', v: '0' }] }, base.frames[1]] },
        { ...base, frames: [{ ...base.frames[0], candles: [{ instrumentId: 'venue-test:BTC', interval: '5m', t: 0, closedAt: 30000, o: '10', h: '10', l: '10', c: '10', v: '-1' }] }, base.frames[1]] },
      ]
      for (const invalid of invalids) {
        writeFileSync(s.fixturePath, JSON.stringify(invalid))
        expectInvalid(() => load(s))
      }
      const candle = { instrumentId: 'venue-test:BTC', interval: '1m', t: 0, closedAt: 30000, o: '10', h: '12', l: '9', c: '11', v: '0' }
      const candleValid = validFixture()
      candleValid.frames[0].candles = [candle]
      writeFileSync(s.fixturePath, JSON.stringify(candleValid))
      expect(load(s).frames[0]?.candles).toHaveLength(1)
      candleValid.frames[1].candles = [{ ...candle, closedAt: 40000 }]
      writeFileSync(s.fixturePath, JSON.stringify(candleValid))
      expectInvalid(() => load(s))
      candleValid.frames[1].candles = [{ ...candle, t: 10000, closedAt: 20000 }]
      writeFileSync(s.fixturePath, JSON.stringify(candleValid))
      expectInvalid(() => load(s))
    } finally { s.cleanup() }
  })

  it('rejects absent, oversized, and invalid-account venue fixtures without echoing details', () => {
    const s = setup()
    try {
      s.config.accounts[0].venue = 'other'
      expectInvalid(() => load(s))
      s.config.accounts[0].venue = 'venue-test'
      s.config.paperReplay.fixture = 'missing.json'
      expectInvalid(() => load(s))
      s.config.paperReplay.fixture = 'fixture.json'
      writeFileSync(s.fixturePath, 'x'.repeat(16 * 1024 * 1024 + 1))
      expectInvalid(() => load(s))
      writeFileSync(s.fixturePath, '{malformed')
      expectInvalid(() => load(s))
    } finally { s.cleanup() }
  })
})

describe('ReplayClock', () => {
  it('starts at a safe timestamp and advances monotonically only', () => {
    expectInvalidParams(() => new ReplayClock(-1))
    expectInvalidParams(() => new ReplayClock(Number.MAX_SAFE_INTEGER + 1))
    const clock = new ReplayClock(10)
    expect(clock.now()).toBe(10)
    expect(clock.advanceTo(10)).toBe(10)
    expect(clock.advanceTo(12)).toBe(12)
    for (const value of [-1, 11, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN]) {
      expectInvalidParams(() => clock.advanceTo(value))
    }
    expect(clock.now()).toBe(12)
  })
})



