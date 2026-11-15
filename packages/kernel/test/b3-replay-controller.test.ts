// SPDX-License-Identifier: CPAL-1.0
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { listSchemaIds, validateBySchemaId } from '@gitrader/protocol'
import type { PaperReplayFixture, PaperReplayStart, PaperReplayStatus } from '../src/proto'
import { asDecimal } from '../src/proto'
import { Kernel } from '../src/kernel'
import { defaultConfig } from '../src/config'
import { metaGet, openDb } from '../src/db'
import { Ledger } from '../src/ledger'
import { recordPaperState } from '../src/paper-integrity'
import { digestOf } from '../src/util/hash'
import { FakeClock } from '../src/util/clock'
import { fileProvider } from '../src/device-key'
import type { VenueConnector } from '../src/connector'
import { systemOrigin } from '../src/util/origin'
import type { EngineHandle } from '../src/engines'

const fixtureValue = (): PaperReplayFixture => ({
  schema: 'gitrader-paper-replay/1', venue: 'venue-test',
  instruments: [{
    instrumentId: 'venue-test:BTC', venue: 'venue-test', symbol: 'BTC', displaySymbol: 'BTC', kind: 'spot', base: 'BTC', quote: 'USD', settle: 'USD',
    settlement: 'linear', contractSize: asDecimal('1'), venueSizeUnit: 'base', assetClass: 'crypto', status: 'trading',
    price: { tick: asDecimal('0.1') }, size: { step: asDecimal('0.01'), decimals: 2, min: asDecimal('0.01') }, orderTypes: ['limit'], tif: ['gtc'], triggerPriceTypes: ['mark'], updatedAt: 1,
  }], interval: '1m', frames: [
    { ts: 60_000, marks: { 'venue-test:BTC': asDecimal('10') }, books: { 'venue-test:BTC': { bids: [[asDecimal('9'), asDecimal('2')]], asks: [[asDecimal('11'), asDecimal('2')]] } }, candles: [] },
    { ts: 120_000, marks: { 'venue-test:BTC': asDecimal('11') }, books: { 'venue-test:BTC': { bids: [[asDecimal('10'), asDecimal('2')]], asks: [[asDecimal('12'), asDecimal('2')]] } }, candles: [] },
  ],
})

function makeReplayHome(options: { alternateAccount?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'gitrader-06b-replay-'))
  const replayRoot = join(home, 'lab', 'replay')
  mkdirSync(replayRoot, { recursive: true })
  const fixture = fixtureValue()
  writeFileSync(join(replayRoot, 'fixture.json'), JSON.stringify(fixture))
  const config = defaultConfig()
  config.venues[0]!.id = 'venue-test'
  config.accounts[0]!.venue = 'venue-test'
  if (options.alternateAccount) config.accounts.push({ ...structuredClone(config.accounts[0]!), alias: 'paper-secondary' })
  config.paperReplay = { fixture: 'fixture.json' }
  writeFileSync(join(home, 'gitrader.json'), JSON.stringify(config, null, 2))
  return { home, fixture, cleanup: () => rmSync(home, { recursive: true, force: true }) }
}

function makePaperConnector(imported: (state: string) => void, exported: () => string, onFills?: () => void): VenueConnector {
  return {
    venue: 'kernel-sim', describe: () => ({ venue: 'kernel-sim' } as never), status: () => ({ state: 'connected' } as never), close: async () => {},
    createAccount: () => {}, hasAccount: () => true, importState: imported, exportState: exported,
    accountState: async () => ({ balances: [], margin: {}, positions: [], ts: 60_000 } as never), openOrders: async () => [], fills: async () => { onFills?.(); return [] },
  } as unknown as VenueConnector
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function makeEnginePeer(engineId = 'gitrader-core'): EngineHandle {
  const listeners = new Set<(line: string) => void>()
  return {
    kind: 'stdio', send(line) {
      const request = JSON.parse(line) as { id?: number; method?: string }
      if (request.id === undefined) return true
      const result = request.method === 'gep.hello' ? { version: '1.0.0', sessionId: 'replay-session' }
        : request.method === 'engine.describe' ? { engine: { id: engineId, version: '1.0.0', name: 'test engine' }, strategies: [], capabilities: [] }
          : { bindingId: 'binding-local', warnings: [] }
      queueMicrotask(() => { for (const listener of listeners) listener(JSON.stringify({ jsonrpc: '2.0', id: request.id, result })) })
      return true
    }, onLine(cb) { listeners.add(cb); return () => { listeners.delete(cb) } },
  }
}

async function bindReplayEngine(kernel: Kernel, engineId = 'gitrader-core'): Promise<{ accountId: string; input: PaperReplayStart }> {
  const accountId = kernel.accounts.list()[0]!.accountId
  const mandateId = await addReplayMandate(kernel, engineId, accountId)
  kernel.docs.put('enginebind', engineId, { accounts: [{ accountId, mandateId }], instruments: ['venue-test:BTC'] })
  kernel.engines.adoptLocal(engineId, makeEnginePeer(engineId), `test-token-${engineId}`, () => {})
  for (let i = 0; i < 50 && !kernel.gep.bindingOf(engineId); i++) await new Promise((resolve) => setImmediate(resolve))
  expect(kernel.gep.bindingOf(engineId)?.accounts[0]?.accountId).toBe(accountId)
  const input: PaperReplayStart = { engineId, accountId: accountId as never, strategyId: 'strategy-test', instrumentId: 'venue-test:BTC' as never, interval: '1m' }
  return { accountId, input }
}

type HttpOpReply = { result?: { state: PaperReplayStatus['state'] }; error?: { name: string } }
const replayStates = new Set<string>(['idle', 'running', 'stopping', 'completed', 'cancelled', 'failed'])
function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
function isHttpOpReply(value: unknown): value is HttpOpReply {
  if (!isRecord(value)) return false
  if (value.error !== undefined) return isRecord(value.error) && typeof value.error.name === 'string'
  return value.result === undefined || (isRecord(value.result) && typeof value.result.state === 'string' && replayStates.has(value.result.state))
}
async function readHttpOpReply(response: Response): Promise<HttpOpReply> {
  const value: unknown = await response.json()
  if (!isHttpOpReply(value)) throw new Error('HTTP operation returned an invalid response shape')
  return value
}

async function addReplayMandate(kernel: Kernel, engineId: string, accountId: string): Promise<string> {
  const mandateId = `mdt_replay_${engineId.replace(/[^a-z0-9]/gi, '_')}_${accountId}`
  kernel.docs.put('mandate', mandateId, {
    mandateId, version: 1, subject: { type: 'engine', id: engineId }, level: 'L3', accounts: [accountId],
    instrumentAllowlist: ['venue-test:BTC'], limits: { maxOrderNotional: '1000', maxDailyNotional: '1000', maxDailyLoss: '1000', autoMaxOrderNotional: '1000' },
    notBefore: 60_000, notAfter: 120_000, status: 'active', issuedBy: 'user:usr_local', attestation: { method: 'system', by: 'kernel', at: 1, digest: `sha256:${'a'.repeat(64)}`, sig: 'sig' },
  } as never)
  return mandateId
}

type ReplaySurface = {
  replayFixture?: PaperReplayFixture
  replayClock?: { now(): number; advanceTo(timestamp: number): number }
}

describe('B3 historical replay kernel', () => {
  it('loads and freezes the configured fixture before exposing its first-frame clock', async () => {
    const s = makeReplayHome()
    let kernel: Kernel | undefined
    try {
      kernel = await Kernel.create({ home: s.home, timers: false, deviceKeyProvider: fileProvider })
      const replay = kernel as unknown as ReplaySurface
      expect(replay.replayFixture).toEqual(s.fixture)
      expect(replay.replayClock?.now()).toBe(s.fixture.frames[0]?.ts)
      expect(Object.isFrozen(replay.replayFixture?.frames)).toBe(true)
      expect(kernel.startedAt).not.toBe(s.fixture.frames[0]?.ts)
      replay.replayClock?.advanceTo(s.fixture.frames[1]!.ts)
      expect(kernel.healthSnapshot().uptimeMs).toBeLessThan(60_000)
      expect(kernel.status().uptimeMs as number).toBeLessThan(60_000)
      await kernel.start({ port: 0 })
      const service = JSON.parse(readFileSync(kernel.paths.service, 'utf8')) as { startedAt: number }
      expect(service.startedAt).not.toBe(s.fixture.frames[0]?.ts)
      const boot = kernel.auth.mintBootToken()
      const session = kernel.auth.exchangeBoot(boot)
      const principal = kernel.auth.authenticateToken(session.sessionToken)!
      replay.replayClock?.advanceTo(Number.MAX_SAFE_INTEGER - 1000)
      expect(kernel.auth.isSessionActive(principal)).toBe(true)
    } finally { await kernel?.stop(); s.cleanup() }
  })

  it('persists the fixture identity and stamps every historical ledger entry', async () => {
    const s = makeReplayHome()
    let kernel: Kernel | undefined
    try {
      kernel = await Kernel.create({ home: s.home, timers: false, deviceKeyProvider: fileProvider })
      const fixtureDigest = digestOf(s.fixture)
      expect(metaGet(kernel.db, 'paper_replay_fixture_digest')).toBe(fixtureDigest)
      expect(kernel.ledger.get(0)?.payload).toMatchObject({ source: 'replay', fixtureDigest })
      const entry = kernel.ledger.append({
        type: 'annotation', origin: { actor: 'user:usr_local', actorType: 'human', tool: 'test', requestId: 'request-replay-ledger', via: 'ui' },
        subject: { orgId: 'org_local' }, payload: { note: 'fixture identity test' },
      })
      expect(entry.payload).toMatchObject({ source: 'replay' })
    } finally { await kernel?.stop(); s.cleanup() }
  })

  it('rejects direct normal Ledger construction on a marked home before writes or events', async () => {
    const s = makeReplayHome()
    let kernel: Kernel | undefined
    try {
      kernel = await Kernel.create({ home: s.home, timers: false, deviceKeyProvider: fileProvider })
      const headBefore = kernel.ledger.head()
      const metaBefore = JSON.stringify([...kernel.db.prepare('SELECT key,value FROM meta ORDER BY key').iterate()])
      let ledgerEvents = 0
      const unsubscribe = kernel.events.subscribe('ledger.entry', () => { ledgerEvents++ })
      expect(() => new Ledger(kernel!.db, kernel!.clock, kernel!.events, kernel!.installKey)).toThrow()
      unsubscribe()
      expect(kernel.ledger.head()).toEqual(headBefore)
      expect(JSON.stringify([...kernel.db.prepare('SELECT key,value FROM meta ORDER BY key').iterate()])).toBe(metaBefore)
      expect(ledgerEvents).toBe(0)
    } finally { await kernel?.stop(); s.cleanup() }
  })

  it('publishes a strict schema for fixture provenance carried by replay status', () => {
    const schemaId = 'urn:gitrader:schema:model:0.1:PaperReplayProvenance'
    expect(listSchemaIds()).toContain(schemaId)
    const provenance = { source: 'replay' as const, fixtureDigest: `sha256:${'a'.repeat(64)}` as `sha256:${string}` }
    const status: PaperReplayStatus & { provenance: typeof provenance } = {
      state: 'idle', frameIndex: -1, totalFrames: 2, clock: 60_000,
      provenance,
    }
    expect(validateBySchemaId(schemaId, provenance).ok).toBe(true)
    expect(validateBySchemaId(schemaId, { ...provenance, source: 'forward' }).ok).toBe(false)
    expect(validateBySchemaId('urn:gitrader:schema:model:0.1:PaperReplayStatus', status).ok).toBe(true)
  })

  it('rejects an injected clock when replay mode owns simulation time', async () => {
    const s = makeReplayHome()
    let kernel: Kernel | undefined
    let error: unknown
    try {
      try { kernel = await Kernel.create({ home: s.home, clock: new FakeClock(), timers: false, deviceKeyProvider: fileProvider }) }
      catch (caught) { error = caught }
      expect(error).toMatchObject({ problem: { name: 'INVALID_PARAMS' } })
    } finally { await kernel?.stop(); s.cleanup() }
  })

  it('refuses a replay start before driver preparation when no driver is attached', async () => {
    const s = makeReplayHome()
    let kernel: Kernel | undefined
    try {
      kernel = await Kernel.create({ home: s.home, timers: false, deviceKeyProvider: fileProvider })
      await expect(kernel.replayStart({ engineId: 'gitrader-core', accountId: 'acct_local' as never, strategyId: 'strategy-test', instrumentId: 'venue-test:BTC' as never, interval: '1m' })).rejects.toMatchObject({ problem: { name: 'CAPABILITY_UNSUPPORTED' } })
      expect(kernel.replayStatus().state).toBe('idle')
    } finally { await kernel?.stop(); s.cleanup() }
  })

  it('rejects new starts and driver attachment after shutdown has closed the controller', async () => {
    const s = makeReplayHome()
    let kernel: Kernel | undefined
    try {
      const created = await Kernel.create({ home: s.home, timers: false, deviceKeyProvider: fileProvider })
      kernel = created
      await created.stop()
      const input: PaperReplayStart = { engineId: 'gitrader-core', accountId: created.accounts.list()[0]!.accountId, strategyId: 'strategy-test', instrumentId: 'venue-test:BTC' as never, interval: '1m' }
      await expect(created.replayStart(input)).rejects.toMatchObject({ problem: { name: 'BUSY' } })
      expect(() => created.attachReplayDriver({ async prepare() { throw new Error('closed controller must reject attach') }, async advance() {}, async evaluate() {}, async tickPaper() {}, exportState() { return '{}' }, async stop() {}, async close() {} })).toThrow()
    } finally { await kernel?.stop().catch(() => undefined); s.cleanup() }
  })

  it('recovers an interrupted run as failed in memory without rewriting its claim or allowing a restart', async () => {
    const s = makeReplayHome()
    let kernel: Kernel | undefined
    try {
      kernel = await Kernel.create({ home: s.home, timers: false, deviceKeyProvider: fileProvider })
      const interrupted = { state: 'running', runId: 'job_interrupted_replay', accountId: kernel.accounts.list()[0]!.accountId, frameIndex: 0, totalFrames: 2, clock: 60_000, startedAt: kernel.auth.now() } as PaperReplayStatus
      kernel.docs.put('paper-replay-run', 'current', interrupted)
      await kernel.stop(); kernel = undefined
      kernel = await Kernel.create({ home: s.home, timers: false, deviceKeyProvider: fileProvider })
      expect(kernel.replayStatus()).toMatchObject({ state: 'failed', runId: interrupted.runId, problem: { message: 'historical replay was interrupted' } })
      expect(kernel.docs.get('paper-replay-run', 'current')).toMatchObject({ state: 'running', runId: interrupted.runId })
      kernel.attachReplayDriver({ async prepare() { throw new Error('must not prepare') }, async advance() {}, async evaluate() {}, async tickPaper() {}, exportState() { throw new Error('must not export') }, async stop() {}, async close() {} })
      await expect(kernel.replayStart({ engineId: 'gitrader-core', accountId: interrupted.accountId as never, strategyId: 'strategy-test', instrumentId: 'venue-test:BTC' as never, interval: '1m' })).rejects.toMatchObject({ problem: { name: 'BUSY' } })
    } finally { await kernel?.stop(); s.cleanup() }
  })

  it('rejects historical paper state at the direct normal Kernel connector boundary before import', async () => {
    const s = makeReplayHome()
    let kernel: Kernel | undefined
    let imported = false
    try {
      const config = defaultConfig()
      writeFileSync(join(s.home, 'gitrader.json'), JSON.stringify(config, null, 2))
      // fix-r2 S2：账本库不在而纸面状态在 = 拒绝启动；先建好账本再放这份历史状态，测的仍是连接器边界上的来源拦截
      await (await Kernel.create({ home: s.home, timers: false, deviceKeyProvider: fileProvider })).stop()
      writeFileSync(join(s.home, 'paper-state.json'), JSON.stringify({ schema: 'kernel-sim/1', gitraderProvenance: { source: 'replay', fixtureDigest: digestOf(s.fixture) } }))
      kernel = await Kernel.create({ home: s.home, timers: false, deviceKeyProvider: fileProvider })
      expect(() => kernel!.registerConnector(makePaperConnector(() => { imported = true }, () => '{}'))).toThrow()
      expect(imported).toBe(false)
    } finally { await kernel?.stop(); s.cleanup() }
  })

  it('reattaches permanent provenance after every native paper save', async () => {
    const s = makeReplayHome()
    let kernel: Kernel | undefined
    let imported = false
    try {
      kernel = await Kernel.create({ home: s.home, timers: false, deviceKeyProvider: fileProvider })
      kernel.registerConnector(makePaperConnector(() => {}, () => JSON.stringify({ schema: 'kernel-sim/1', accounts: [] })))
      await kernel.stop()
      kernel = undefined
      const statePath = join(s.home, 'paper-state.json')
      const saved = JSON.parse(readFileSync(statePath, 'utf8'))
      expect(saved.gitraderProvenance).toEqual({ source: 'replay', fixtureDigest: digestOf(s.fixture) })
      saved.gitraderProvenance.runId = 'job_previous_replay'
      writeFileSync(statePath, JSON.stringify(saved))
      // fix-r2 S1：手改过的状态文件摘要对不上会被拒；这里模拟「上一次回放的内核自己保存的」状态，按内核规则登记摘要
      { const db = openDb(join(s.home, 'data', 'gitrader.sqlite')); recordPaperState(db, JSON.stringify(saved), 0, 0); db.close() }
      kernel = await Kernel.create({ home: s.home, timers: false, deviceKeyProvider: fileProvider })
      kernel.registerConnector(makePaperConnector((state) => { imported = JSON.parse(state).gitraderProvenance.runId === 'job_previous_replay' }, () => JSON.stringify({ schema: 'kernel-sim/1', accounts: [] })))
      expect(imported).toBe(true)
      await kernel.stop()
      kernel = undefined
      expect(JSON.parse(readFileSync(statePath, 'utf8')).gitraderProvenance.fixtureDigest).toBe(digestOf(s.fixture))
    } finally { await kernel?.stop(); s.cleanup() }
  })

  it('keeps forward evidence APIs inert and rejects direct historical stage transitions', async () => {
    const s = makeReplayHome()
    let kernel: Kernel | undefined
    try {
      kernel = await Kernel.create({ home: s.home, timers: false, deviceKeyProvider: fileProvider })
      const ledgerBefore = kernel.ledger.count()
      const docsBefore = (kernel.db.prepare("SELECT COUNT(*) c FROM docs WHERE coll LIKE 'lab-forward-%'").get() as { c: number }).c
      await kernel.lab.forwardStats.tick()
      await expect(kernel.lab.forwardStats.start({} as never, 60_000)).rejects.toMatchObject({ problem: { name: 'INVALID_PARAMS' } })
      await expect(kernel.lab.forwardStats.snapshot({} as never, 'stage', 60_000)).rejects.toMatchObject({ problem: { name: 'INVALID_PARAMS' } })
      await expect(kernel.lab.forwardStats.compute({} as never, 60_000, false)).rejects.toMatchObject({ problem: { name: 'INVALID_PARAMS' } })
      await expect(kernel.lab.stage('exp_missing', 'forward', undefined as never)).rejects.toMatchObject({ problem: { name: 'INVALID_PARAMS' } })
      expect(kernel.ledger.count()).toBe(ledgerBefore)
      expect((kernel.db.prepare("SELECT COUNT(*) c FROM docs WHERE coll LIKE 'lab-forward-%'").get() as { c: number }).c).toBe(docsBefore)
    } finally { await kernel?.stop(); s.cleanup() }
  })

  it('marks historical replay in full and partial ledger exports', async () => {
    const s = makeReplayHome()
    let kernel: Kernel | undefined
    try {
      kernel = await Kernel.create({ home: s.home, timers: false, deviceKeyProvider: fileProvider })
      const dir = join(s.home, 'exports', 'manual')
      const manifest = kernel.ledger.export({ dir, markdown: true, fromSeq: 0, toSeq: 0, exportedBy: systemOrigin('test:export') })
      expect(manifest.paperReplay).toEqual({ source: 'replay', fixtureDigest: digestOf(s.fixture) })
      expect(readFileSync(join(dir, 'trade-log.md'), 'utf8')).toContain('historical paper replay')
      expect(readFileSync(join(dir, 'trade-log.md'), 'utf8')).toContain(digestOf(s.fixture))
    } finally { await kernel?.stop(); s.cleanup() }
  })

  it('runs each fixture frame in the awaited driver order and persists completion before status', async () => {
    const s = makeReplayHome()
    let kernel: Kernel | undefined
    const sequence: string[] = []
    try {
      kernel = await Kernel.create({ home: s.home, timers: false, deviceKeyProvider: fileProvider })
      const accountId = kernel.accounts.list()[0]!.accountId
      kernel.registerConnector(makePaperConnector(() => {}, () => JSON.stringify({ schema: 'kernel-sim/1', accounts: [] })))
      const mandateId = 'mdt_replay_test'
      kernel.docs.put('mandate', mandateId, {
        mandateId, version: 1, subject: { type: 'engine', id: 'gitrader-core' }, level: 'L3', accounts: [accountId],
        instrumentAllowlist: ['venue-test:BTC'], limits: { maxOrderNotional: '1000', maxDailyNotional: '1000', maxDailyLoss: '1000', autoMaxOrderNotional: '1000' },
        notBefore: 60_000, notAfter: 120_000, status: 'active', issuedBy: 'user:usr_local', attestation: { method: 'system', by: 'kernel', at: 1, digest: `sha256:${'a'.repeat(64)}`, sig: 'sig' },
      } as never)
      kernel.docs.put('enginebind', 'gitrader-core', { accounts: [{ accountId, mandateId }], instruments: ['venue-test:BTC'] })
      kernel.engines.adoptLocal('gitrader-core', makeEnginePeer(), 'test-engine-token', () => {})
      for (let i = 0; i < 50 && !kernel.gep.bindingOf('gitrader-core'); i++) await new Promise((resolve) => setImmediate(resolve))
      expect(kernel.gep.bindingOf('gitrader-core')?.accounts[0]?.accountId).toBe(accountId)
      const originalTick = kernel.tickOnce.bind(kernel)
      kernel.tickOnce = async () => { sequence.push('kernel'); await originalTick() }
      kernel.attachReplayDriver({
        async prepare() { sequence.push('prepare'); return { instanceId: 'inst_replay_test' } },
        async advance(index) { sequence.push(`advance:${index}`) },
        async evaluate() { sequence.push('evaluate') },
        async tickPaper() { sequence.push('paper') },
        exportState() { return JSON.stringify({ schema: 'kernel-sim/1', accounts: [] }) },
        async stop() { sequence.push('stop') }, async close() { sequence.push('close') },
      })
      expect(kernel.ops.spec('paper.replay.start')?.auth).toBe('session')
      expect(kernel.ops.spec('paper.replay.status')?.auth).toBe('human')
      const replayInput: PaperReplayStart = { engineId: 'gitrader-core', accountId, strategyId: 'strategy-test', instrumentId: 'venue-test:BTC' as never, interval: '1m' }
      const started = await kernel.gep.callEngine('gitrader-core', 'paper.replay.start', replayInput) as PaperReplayStatus
      expect(started.state).toBe('running')
      const gepStatus = await kernel.gep.callEngine('gitrader-core', 'paper.replay.status', {}) as PaperReplayStatus
      expect(gepStatus.provenance?.source).toBe('replay')
      for (let i = 0; i < 200 && kernel.replayStatus().state === 'running'; i++) await new Promise((resolve) => setImmediate(resolve))
      expect(sequence).toEqual(['prepare', 'advance:0', 'evaluate', 'paper', 'kernel', 'advance:1', 'evaluate', 'paper', 'kernel', 'stop', 'close'])
      expect(kernel.replayStatus()).toMatchObject({ state: 'completed', frameIndex: 1, artifact: expect.stringMatching(/^exports\/replay\//) })
      const artifact = JSON.parse(readFileSync(join(s.home, kernel.replayStatus().artifact!), 'utf8'))
      expect(artifact.status.state).toBe('completed')
      expect(JSON.parse(readFileSync(join(s.home, 'paper-state.json'), 'utf8')).gitraderProvenance.source).toBe('replay')
      await expect(kernel.replayStart(replayInput)).rejects.toMatchObject({ problem: { name: 'BUSY' } })
      await kernel.stop(); kernel = undefined
      kernel = await Kernel.create({ home: s.home, timers: false, deviceKeyProvider: fileProvider })
      expect(kernel.replayStatus().state).toBe('completed')
      await expect(kernel.replayStart(replayInput)).rejects.toMatchObject({ problem: { name: 'BUSY' } })
    } finally { await kernel?.stop(); s.cleanup() }
  })

  it('waits for the in-flight frame, persists partial cancellation, and enforces HTTP/GEP caller boundaries', async () => {
    const s = makeReplayHome({ alternateAccount: true })
    let kernel: Kernel | undefined
    let prepareCalls = 0
    let releaseFrame!: () => void
    let frameEntered!: () => void
    const frameGate = new Promise<void>((resolve) => { releaseFrame = resolve })
    const entered = new Promise<void>((resolve) => { frameEntered = resolve })
    try {
      kernel = await Kernel.create({ home: s.home, timers: false, deviceKeyProvider: fileProvider })
      kernel.registerConnector(makePaperConnector(() => {}, () => JSON.stringify({ schema: 'kernel-sim/1', accounts: [] })))
      const { input } = await bindReplayEngine(kernel)
      const otherAccountId = kernel.accounts.list()[1]!.accountId
      kernel.attachReplayDriver({
        async prepare() { prepareCalls++; return { instanceId: 'inst_cancel_test' } },
        async advance() {}, async evaluate() { frameEntered(); await frameGate }, async tickPaper() {}, exportState() { return JSON.stringify({ schema: 'kernel-sim/1', accounts: [] }) },
        async stop() {}, async close() {},
      })
      await kernel.start({ port: 0 })
      const addr = kernel.http!.server.address()
      if (!addr || typeof addr === 'string') throw new Error('owned HTTP listener has no socket address')
      const host = addr.address.includes(':') ? `[${addr.address}]` : addr.address
      const opUrl = (name: string): string => `http://${host}:${addr.port}/api/op/${name}`
      const callHttp = async (name: string, params: unknown, token?: string) => fetch(opUrl(name), {
        method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ params }),
      })
      const unauth = await callHttp('paper.replay.start', input)
      expect(unauth.status).toBe(401)
      const serviceToken = kernel.auth.rotateServiceToken()
      const service = await callHttp('paper.replay.start', input, serviceToken)
      expect(service.status).toBe(401)
      expect((await readHttpOpReply(service)).error?.name).toBe('AUTH_FAILED')
      const boot = kernel.auth.mintBootToken()
      const session = kernel.auth.exchangeBoot(boot)
      await expect(kernel.gep.callEngine('gitrader-core', 'paper.replay.start', { ...input, accountId: otherAccountId })).rejects.toMatchObject({ problem: { name: 'ACCOUNT_NOT_BOUND' } })
      expect(prepareCalls).toBe(0)
      const startResponse = await callHttp('paper.replay.start', input, session.sessionToken)
      expect(startResponse.status).toBe(200)
      expect((await readHttpOpReply(startResponse)).result?.state).toBe('running')
      await entered
      expect((await kernel.gep.callEngine('gitrader-core', 'paper.replay.status', {}) as PaperReplayStatus).state).toBe('running')
      await expect(kernel.gep.callEngine('gitrader-core', 'paper.replay.status', { runId: 'job_other_run' })).rejects.toMatchObject({ problem: { name: 'INVALID_PARAMS' } })
      await expect(kernel.gep.callEngine('gitrader-core', 'paper.replay.stop', { runId: 'job_other_run' })).rejects.toMatchObject({ problem: { name: 'INVALID_PARAMS' } })
      expect(kernel.replayStatus().state).toBe('running')
      const otherMandateId = await addReplayMandate(kernel, 'gitrader-core', otherAccountId)
      await kernel.engines.stop('gitrader-core')
      kernel.docs.put('enginebind', 'gitrader-core', { accounts: [{ accountId: otherAccountId, mandateId: otherMandateId }], instruments: ['venue-test:BTC'] })
      kernel.engines.adoptLocal('gitrader-core', makeEnginePeer(), 'test-token-rebound', () => {})
      for (let i = 0; i < 50 && kernel.gep.bindingOf('gitrader-core')?.accounts[0]?.accountId !== otherAccountId; i++) await new Promise((resolve) => setImmediate(resolve))
      expect(kernel.gep.bindingOf('gitrader-core')?.accounts[0]?.accountId).toBe(otherAccountId)
      await expect(kernel.gep.callEngine('gitrader-core', 'paper.replay.status', {})).rejects.toMatchObject({ problem: { name: 'ACCOUNT_NOT_BOUND' } })
      await expect(kernel.gep.callEngine('gitrader-core', 'paper.replay.stop', { runId: kernel.replayStatus().runId })).rejects.toMatchObject({ problem: { name: 'ACCOUNT_NOT_BOUND' } })
      const stopRequest = callHttp('paper.replay.stop', { runId: kernel.replayStatus().runId }, session.sessionToken)
      const stopDeadline = Date.now() + 2000
      while (Date.now() < stopDeadline && kernel.replayStatus().state !== 'stopping') await new Promise((resolve) => setTimeout(resolve, 10))
      expect(kernel.replayStatus().state).toBe('stopping')
      releaseFrame()
      const stopResponse = await stopRequest
      expect(stopResponse.status).toBe(200)
      expect((await readHttpOpReply(stopResponse)).result?.state).toBe('cancelled')
      expect(kernel.replayStatus().frameIndex).toBe(0)
      const artifactPath = join(s.home, kernel.replayStatus().artifact!)
      expect(JSON.parse(readFileSync(artifactPath, 'utf8')).status).toMatchObject({ state: 'cancelled', frameIndex: 0 })
      expect(JSON.parse(readFileSync(join(s.home, 'paper-state.json'), 'utf8')).gitraderProvenance.source).toBe('replay')
      const humanStatus = await callHttp('paper.replay.status', {}, session.sessionToken)
      expect(humanStatus.status).toBe(200)
      expect((await readHttpOpReply(humanStatus)).result?.state).toBe('cancelled')
      const secondStart = await callHttp('paper.replay.start', input, session.sessionToken)
      expect((await readHttpOpReply(secondStart)).error?.name).toBe('BUSY')
      expect(prepareCalls).toBe(1)
    } finally { releaseFrame(); await kernel?.stop(); s.cleanup() }
  })

  it('cancels an awaited preflight before shutdown and never claims or prepares after the snapshot settles', async () => {
    const s = makeReplayHome()
    let kernel: Kernel | undefined
    let stopTask: Promise<void> | undefined
    const snapshotEntered = deferred(), snapshotGate = deferred(), closeEntered = deferred(), closeGate = deferred()
    let snapshotCalls = 0, fillsCalls = 0, prepareCalls = 0
    try {
      kernel = await Kernel.create({ home: s.home, timers: false, deviceKeyProvider: fileProvider })
      kernel.registerConnector(makePaperConnector(() => {}, () => JSON.stringify({ schema: 'kernel-sim/1', accounts: [] }), () => { fillsCalls++ }))
      const { input } = await bindReplayEngine(kernel)
      const originalSnapshot = kernel.bus.snapshot.bind(kernel.bus)
      kernel.bus.snapshot = async (account, options) => {
        snapshotCalls++
        const nativeSnapshot = originalSnapshot(account, options)
        snapshotEntered.resolve()
        await snapshotGate.promise
        return nativeSnapshot
      }
      kernel.attachReplayDriver({
        async prepare() { prepareCalls++; return { instanceId: 'inst_preflight_cancel' } },
        async advance() {}, async evaluate() {}, async tickPaper() {}, exportState() { return JSON.stringify({ schema: 'kernel-sim/1', accounts: [] }) },
        async stop() {}, async close() { closeEntered.resolve(); await closeGate.promise },
      })
      const startTask = kernel.replayStart(input).then(() => true, () => false)
      await snapshotEntered.promise
      stopTask = kernel.stop()
      await closeEntered.promise
      const startOutcome = await Promise.race([startTask.then((accepted) => accepted ? 'accepted' : 'rejected'), new Promise<string>((resolve) => setTimeout(() => resolve('pending'), 1000))])
      expect(startOutcome).toBe('rejected')
      snapshotGate.resolve()
      closeGate.resolve()
      await stopTask
      expect(snapshotCalls).toBe(1)
      expect(fillsCalls).toBe(0)
      expect(prepareCalls).toBe(0)
      const afterDb = openDb(join(s.home, 'data', 'gitrader.sqlite'))
      try { expect((afterDb.prepare("SELECT COUNT(*) c FROM docs WHERE coll='paper-replay-run'").get() as { c: number }).c).toBe(0) }
      finally { afterDb.close() }
    } finally {
      snapshotGate.resolve(); closeGate.resolve()
      await stopTask?.catch(() => undefined)
      if (!stopTask) await kernel?.stop().catch(() => undefined)
      s.cleanup()
    }
  })

  it('settles shutdown with a never-returning snapshot and safely absorbs its later rejection', async () => {
    const s = makeReplayHome()
    let kernel: Kernel | undefined
    let stopTask: Promise<void> | undefined
    let startTask: Promise<'accepted' | 'rejected'> | undefined
    const snapshotEntered = deferred(), snapshotGate = deferred()
    let fillsCalls = 0, prepareCalls = 0, unhandled = 0
    const onUnhandled = () => { unhandled++ }
    process.on('unhandledRejection', onUnhandled)
    try {
      kernel = await Kernel.create({ home: s.home, timers: false, deviceKeyProvider: fileProvider })
      kernel.registerConnector(makePaperConnector(() => {}, () => JSON.stringify({ schema: 'kernel-sim/1', accounts: [] }), () => { fillsCalls++ }))
      const { input } = await bindReplayEngine(kernel)
      kernel.bus.snapshot = async () => { snapshotEntered.resolve(); await snapshotGate.promise; return { positions: [], openOrders: [] } as never }
      kernel.attachReplayDriver({
        async prepare() { prepareCalls++; return { instanceId: 'inst_never_snapshot' } },
        async advance() {}, async evaluate() {}, async tickPaper() {}, exportState() { return JSON.stringify({ schema: 'kernel-sim/1', accounts: [] }) },
        async stop() {}, async close() {},
      })
      startTask = kernel.replayStart(input).then(() => 'accepted' as const, () => 'rejected' as const)
      await snapshotEntered.promise
      stopTask = kernel.stop()
      await stopTask
      const promptResult = await Promise.race([startTask, new Promise<string>((resolve) => setTimeout(() => resolve('pending'), 1000))])
      expect(promptResult).toBe('rejected')
      snapshotGate.reject(new Error('late snapshot rejection'))
      await new Promise((resolve) => setImmediate(resolve))
      expect(await startTask).toBe('rejected')
      expect(prepareCalls).toBe(0)
      expect(fillsCalls).toBe(0)
      expect(unhandled).toBe(0)
      const afterDb = openDb(join(s.home, 'data', 'gitrader.sqlite'))
      try { expect((afterDb.prepare("SELECT COUNT(*) c FROM docs WHERE coll='paper-replay-run'").get() as { c: number }).c).toBe(0) }
      finally { afterDb.close() }
    } finally {
      snapshotGate.reject(new Error('test cleanup release'))
      await startTask?.catch(() => 'rejected')
      await stopTask?.catch(() => undefined)
      if (!stopTask) await kernel?.stop().catch(() => undefined)
      process.off('unhandledRejection', onUnhandled)
      s.cleanup()
    }
  })

  it('closes the driver on prepare/evaluate/export failure and never leaves a completed artifact after close fails', async () => {
    for (const failAt of ['prepare', 'evaluate', 'export', 'malformed', 'close'] as const) {
      const s = makeReplayHome()
      let kernel: Kernel | undefined
      let closeCalls = 0
      try {
        kernel = await Kernel.create({ home: s.home, timers: false, deviceKeyProvider: fileProvider })
        kernel.registerConnector(makePaperConnector(() => {}, () => JSON.stringify({ schema: 'kernel-sim/1', accounts: [] })))
        const { input } = await bindReplayEngine(kernel)
        const statePath = join(s.home, 'paper-state.json')
        const paperStateBefore = existsSync(statePath) ? readFileSync(statePath) : undefined
        kernel.attachReplayDriver({
          async prepare() { if (failAt === 'prepare') throw new Error('injected prepare failure'); return { instanceId: 'inst_failure_test' } },
          async advance() {}, async evaluate() { if (failAt === 'evaluate') throw new Error('injected evaluate failure') }, async tickPaper() {},
          exportState() { if (failAt === 'export') throw new Error('injected export failure'); if (failAt === 'malformed') return '{invalid'; return JSON.stringify({ schema: 'kernel-sim/1', accounts: [] }) },
          async stop() {}, async close() { closeCalls++; if (failAt === 'close') throw new Error('injected close failure') },
        })
        await kernel.replayStart(input)
        for (let i = 0; i < 100 && kernel.replayStatus().state === 'running'; i++) await new Promise((resolve) => setImmediate(resolve))
        expect(kernel.replayStatus().state, failAt).toBe('failed')
        expect(closeCalls, failAt).toBe(1)
        const artifact = JSON.parse(readFileSync(join(s.home, kernel.replayStatus().artifact!), 'utf8'))
        expect(artifact.status.state, failAt).toBe('failed')
        if (failAt === 'export' || failAt === 'malformed') {
          expect(existsSync(statePath)).toBe(paperStateBefore !== undefined)
          if (paperStateBefore) expect(readFileSync(statePath)).toEqual(paperStateBefore)
        }
      } finally { await kernel?.stop(); s.cleanup() }
    }
  })

  it('rejects historical activation on a home with pre-existing experiment documents', async () => {
    const s = makeReplayHome()
    let kernel: Kernel | undefined
    try {
      const normal = defaultConfig()
      normal.venues[0]!.id = 'venue-test'; normal.accounts[0]!.venue = 'venue-test'
      writeFileSync(join(s.home, 'gitrader.json'), JSON.stringify(normal, null, 2))
      kernel = await Kernel.create({ home: s.home, timers: false, deviceKeyProvider: fileProvider })
      kernel.docs.put('experiment', 'exp_preexisting', { experimentId: 'exp_preexisting' })
      await kernel.stop(); kernel = undefined
      normal.paperReplay = { fixture: 'fixture.json' }
      writeFileSync(join(s.home, 'gitrader.json'), JSON.stringify(normal, null, 2))
      await expect(Kernel.create({ home: s.home, timers: false, deviceKeyProvider: fileProvider })).rejects.toMatchObject({ problem: { name: 'INVALID_PARAMS' } })
    } finally { await kernel?.stop(); s.cleanup() }
  })

  it('rejects a changed fixture on a permanently marked home before ledger writes', async () => {
    const s = makeReplayHome()
    let kernel: Kernel | undefined
    let db: ReturnType<typeof openDb> | undefined
    try {
      kernel = await Kernel.create({ home: s.home, timers: false, deviceKeyProvider: fileProvider })
      const originalDigest = metaGet(kernel.db, 'paper_replay_fixture_digest')
      const originalCount = kernel.ledger.count()
      await kernel.stop(); kernel = undefined
      const normal = defaultConfig()
      normal.venues[0]!.id = 'venue-test'; normal.accounts[0]!.venue = 'venue-test'
      writeFileSync(join(s.home, 'gitrader.json'), JSON.stringify(normal, null, 2))
      await expect(Kernel.create({ home: s.home, timers: false, deviceKeyProvider: fileProvider })).rejects.toMatchObject({ problem: { name: 'STATE_FILE_CORRUPT' } })
      db = openDb(join(s.home, 'data', 'gitrader.sqlite'))
      expect((db.prepare('SELECT COUNT(*) c FROM ledger').get() as { c: number }).c).toBe(originalCount)
      db.close(); db = undefined
      normal.paperReplay = { fixture: 'fixture.json' }
      writeFileSync(join(s.home, 'gitrader.json'), JSON.stringify(normal, null, 2))
      const changed = fixtureValue()
      changed.frames[0]!.marks['venue-test:BTC'] = asDecimal('10.5')
      writeFileSync(join(s.home, 'lab', 'replay', 'fixture.json'), JSON.stringify(changed))
      await expect(Kernel.create({ home: s.home, timers: false, deviceKeyProvider: fileProvider })).rejects.toMatchObject({ problem: { name: 'STATE_FILE_CORRUPT' } })
      db = openDb(join(s.home, 'data', 'gitrader.sqlite'))
      expect(metaGet(db, 'paper_replay_fixture_digest')).toBe(originalDigest)
      expect((db.prepare('SELECT COUNT(*) c FROM ledger').get() as { c: number }).c).toBe(originalCount)
    } finally { db?.close(); await kernel?.stop(); s.cleanup() }
  })
})
