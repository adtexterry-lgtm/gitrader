// SPDX-License-Identifier: CPAL-1.0
import { randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { EngineCore } from '../../engine-core/src/index.js'
import { GEP_LIMITS } from '@gitrader/protocol'
import type { Instrument, PaperReplayFixture, PaperReplayStart, VenueCapabilities } from '@gitrader/protocol'
import type { MarketStatus, SubscriptionSpec, Unsubscribe, VenueEvent } from '@gitrader/protocol/connector'
import { ReplayMarket } from '@gitrader/venue-paper'
import type { PaperMarket } from '@gitrader/venue-paper'
import type { Kernel, ReplayDriver } from '@gitrader/kernel'
import { assembleReplayPaper } from './connectors'
import type { CliIo } from './index'

const MAX_TIMER_MS = 2_147_483_647
const ENGINE_ID = 'gitrader-core'

type HistoryOptions = NonNullable<Parameters<PaperMarket['candles']>[2]>
type MarketContext = Awaited<ReturnType<PaperMarket['context']>>

export function createReplayMarket(fixture: PaperReplayFixture): { market: PaperMarket; advance(index: number): void } {
  const caps = capabilities(fixture)
  const frames = fixture.frames.map((frame) => ({
    ts: frame.ts,
    marks: Object.fromEntries(Object.entries(frame.marks).map(([id, value]) => [id, Number(value)])),
    books: Object.fromEntries(Object.entries(frame.books).map(([id, book]) => [id, {
      bids: book.bids.map(([price, size]) => [Number(price), Number(size)] as [number, number]),
      asks: book.asks.map(([price, size]) => [Number(price), Number(size)] as [number, number]),
    }])),
    ...(frame.funding ? { funding: Object.fromEntries(Object.entries(frame.funding).map(([id, value]) => [id, Number(value)])) } : {}),
  }))
  const native = new ReplayMarket(fixture.instruments, frames, caps, fixture.venue)
  let revealed = -1
  const instrumentCopies = (): Instrument[] => fixture.instruments.map((instrument) => structuredClone(instrument))
  const market: PaperMarket = {
    venue: fixture.venue,
    environment: 'mainnet',
    describe: () => structuredClone(caps),
    listInstruments: instrumentCopies,
    getInstrument: (id) => {
      const instrument = fixture.instruments.find((entry) => entry.instrumentId === id)
      return instrument ? structuredClone(instrument) : undefined
    },
    quote: (id) => revealed < 0 ? undefined : native.quote(id),
    book: async (id, depth) => {
      if (revealed < 0) throw new Error('replay market has not advanced to a frame')
      return native.book(id, depth)
    },
    candles: async (id, interval, opts: HistoryOptions = {}) => {
      if (interval !== fixture.interval || revealed < 0) return []
      const now = fixture.frames[revealed]!.ts
      const rows = fixture.frames.slice(0, revealed + 1).flatMap((frame) => frame.candles)
        .filter((candle) => candle.instrumentId === id && candle.interval === interval && candle.closedAt <= now
          && (opts.from === undefined || candle.t >= opts.from) && (opts.to === undefined || candle.t <= opts.to))
        .sort((a, b) => a.t - b.t)
      const limited = opts.n === undefined ? rows : opts.n === 0 ? [] : rows.slice(-opts.n)
      return limited.map(({ t, o, h, l, c, v }) => ({ t, o: Number(o), h: Number(h), l: Number(l), c: Number(c), v: Number(v) }))
    },
    context: async (id): Promise<MarketContext> => {
      if (revealed < 0) throw new Error('replay market has not advanced to a frame')
      return native.context(id)
    },
    subscribe: (_spec: SubscriptionSpec, _cb: (event: VenueEvent) => void): Unsubscribe => () => {},
    status: (): MarketStatus => revealed < 0
      ? { venue: fixture.venue, environment: 'mainnet', ts: 0, wsState: 'connecting', stale: true, source: 'none', lastMessageTs: 0 }
      : native.status(),
  }
  return { market, advance: (index) => { native.seek(index); revealed = index } }
}

function capabilities(fixture: PaperReplayFixture): VenueCapabilities {
  return {
    venue: fixture.venue,
    environments: ['mainnet'],
    instrumentKinds: [...new Set(fixture.instruments.map((instrument) => instrument.kind))],
    orderTypes: { market: 'native', limit: 'native' },
    tif: ['gtc', 'ioc'],
    triggerPriceTypes: ['mark'],
    positionMode: ['oneWay'],
    marginModes: ['cross'],
  }
}

export interface ReplayAssembly {
  driver: ReplayDriver
  ready: Promise<void>
}

export function assembleReplay(k: Kernel, io: CliIo): ReplayAssembly {
  const fixture = k.replayFixture
  const clock = k.replayClock
  if (!fixture || !clock) throw new Error('historical replay is not configured')

  const replayMarket = createReplayMarket(fixture)
  const paper = assembleReplayPaper({ k, market: replayMarket.market, clock: () => clock.now(), io })
  const strategiesDir = join(k.home, 'engines', ENGINE_ID, 'strategies')
  mkdirSync(strategiesDir, { recursive: true })
  const token = randomBytes(24).toString('base64url')
  const core = new EngineCore({
    token,
    now: () => clock.now(),
    tickMs: MAX_TIMER_MS,
    instances: { pollMinMs: MAX_TIMER_MS },
    strategiesDir,
  })
  let engineConn: ReturnType<EngineCore['connect']> | undefined
  let closed = false
  let closeTask: Promise<void> | undefined
  const listeners = new Set<(text: string) => void>()

  const cleanup = (): Promise<void> => {
    if (closeTask) return closeTask
    closed = true
    closeTask = (async () => {
      if (engineConn) core.disconnect(engineConn)
      core.close()
    })()
    return closeTask
  }

  engineConn = core.connect({
    kind: 'memory',
    maxFrameBytes: GEP_LIMITS.maxWsFrameBytes,
    closeTransport: () => { closed = true },
    send: (text) => { queueMicrotask(() => { for (const listener of listeners) listener(text) }) },
  })

  const engineHandle = {
    kind: 'ws' as const,
    send: (text: string): boolean => {
      if (closed || !engineConn) return false
      queueMicrotask(() => { void engineConn!.peer.receive(text) })
      return true
    },
    onMessage: (cb: (text: string) => void): (() => void) => {
      listeners.add(cb)
      return () => { listeners.delete(cb) }
    },
  }
  try { k.engines.adoptLocal(ENGINE_ID, engineHandle, token, cleanup) }
  catch (error) { void cleanup(); throw error }

  const heartbeatBarrier = async (): Promise<void> => {
    if (!engineConn) throw new Error('local replay engine connection is closed')
    await engineConn.peer.receive(JSON.stringify({ jsonrpc: '2.0', method: 'gep.heartbeat', params: { ts: clock.now() } }))
    engineConn.peer.notify('gep.heartbeat', { ts: clock.now() })
    await engineConn.peer.call('host.describe', {})
  }

  const ready = (async () => {
    await core.ready
    for (let attempt = 0; attempt < 250; attempt++) {
      if (k.engines.status().find((entry) => entry.id === ENGINE_ID)?.state === 'ready') return
      await new Promise<void>((resolve) => setTimeout(resolve, 20))
    }
    await k.engines.stop(ENGINE_ID)
    throw new Error('local replay engine did not complete the GEP handshake')
  })()

  const driver: ReplayDriver = {
    async prepare(input: PaperReplayStart, _runId: string) {
      await ready
      await heartbeatBarrier()
      const raw = await k.gep.callEngine(ENGINE_ID, 'strategy.start', {
        strategyId: input.strategyId,
        accountId: input.accountId,
        instruments: [input.instrumentId],
        interval: input.interval,
        params: input.params ?? {},
        ...(input.sizing ? { sizing: input.sizing } : {}),
      }) as { instanceId?: unknown }
      if (typeof raw?.instanceId !== 'string' || !raw.instanceId) throw new Error('strategy.start did not return an instance id')
      await core.instances.evaluateNow(raw.instanceId, 'poll')
      return { instanceId: raw.instanceId }
    },
    async advance(index: number) {
      replayMarket.advance(index)
      await heartbeatBarrier()
    },
    async evaluate(instanceId: string) { await core.instances.evaluateNow(instanceId, 'poll') },
    async tickPaper() { await paper.tick() },
    exportState() { return paper.exportState() },
    async stop(instanceId: string) { await k.gep.callEngine(ENGINE_ID, 'strategy.stop', { instanceId }) },
    async close() { await k.engines.stop(ENGINE_ID) },
  }

  return { driver, ready }
}
