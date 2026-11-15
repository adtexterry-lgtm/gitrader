// SPDX-License-Identifier: CPAL-1.0
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Kernel, fileProvider } from '@gitrader/kernel'
import { GEP_LIMITS } from '@gitrader/protocol'
import { PaperVenue } from '@gitrader/venue-paper'
import { EngineCore } from '../../engine-core/src/index.js'
import { main, runServe } from '../src/index'
import type { CliIo, ServeHandle } from '../src/index'
import { createReplayMarket } from '../src/replay'
import { assembleReplayPaper } from '../src/connectors'

let home: string
let service: ServeHandle | undefined
let out: string[]
let errors: string[]
let secrets: string[]

const io = (): CliIo => ({
  out: (value) => out.push(value),
  err: (value) => errors.push(value),
  env: { GITRADER_HOME: home },
  interactive: true,
  deviceKey: fileProvider,
  readSecret: async () => {
    const value = secrets.shift()
    if (value === undefined) throw new Error('missing test secret input')
    return value
  },
})
const run = (args: string[]): Promise<number> => main(args, io())

function writeReplayFixture(halfSpreadBps = 1, startTs = 1700000000000, frameStepMs = 60000): void {
  const configPath = join(home, 'gitrader.json')
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
    accounts: Array<{ venue: string; paper?: { initialBalance: string; ccy: string } }>
    paperReplay?: { fixture: string }
  }
  config.accounts[0]!.paper = { initialBalance: '1000', ccy: 'USDC' }
  config.paperReplay = { fixture: 'fixture.json' }
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`)

  const venue = config.accounts[0]!.venue
  const instrumentId = `${venue}:BTC`
  const instruments = [{
    instrumentId, venue, symbol: 'BTC-PERP', displaySymbol: 'BTC-PERP', kind: 'perp', base: 'BTC', quote: 'USDC', settle: 'USDC',
    settlement: 'linear', contractSize: '1', venueSizeUnit: 'base', assetClass: 'crypto', status: 'trading',
    price: { tick: '0.0001' }, size: { step: '0.1', decimals: 1, min: '0.1' }, maxLeverage: 3,
    orderTypes: ['market', 'limit'], tif: ['gtc', 'ioc'], triggerPriceTypes: ['mark'], fundingIntervalMs: 3600000, updatedAt: 1700000000000,
    fees: { maker: '0.00015', taker: '0.00045', source: 'assumed' },
  }]
  const decimal = (value: number): string => value.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')
  const frames = Array.from({ length: 90 }, (_, index) => {
    const close = index < 30 ? '100' : index < 60 ? '100.5' : '100.25'
    const ts = startTs + (index + 1) * frameStepMs
    const mark = Number(close)
    const bid = decimal(mark * (1 - halfSpreadBps / 10000))
    const ask = decimal(mark * (1 + halfSpreadBps / 10000))
    return {
      ts, marks: { [instrumentId]: close },
      books: { [instrumentId]: { bids: [[bid, '100']], asks: [[ask, '100']] } },
      candles: [{ instrumentId, interval: '1m', t: ts - 60000, closedAt: ts, o: close, h: close, l: close, c: close, v: '100' }],
    }
  })
  const replayRoot = join(home, 'lab', 'replay')
  mkdirSync(replayRoot, { recursive: true })
  writeFileSync(join(replayRoot, 'fixture.json'), JSON.stringify({ schema: 'gitrader-paper-replay/1', venue, instruments, interval: '1m', frames }))
}

async function setupReplayHome(halfSpreadBps = 1, bindEngine = true, startTs = 1700000000000, frameStepMs = 60000): Promise<void> {
  home = mkdtempSync(join(tmpdir(), 'gitrader-b3-replay-'))
  out = []; errors = []; secrets = ['246810', '246810']
  expect(await run(['init'])).toBe(0)
  writeReplayFixture(halfSpreadBps, startTs, frameStepMs)
  const strategyDir = join(home, 'engines', 'gitrader-core', 'strategies')
  mkdirSync(strategyDir, { recursive: true })
  const strategySource = fileURLToPath(new URL('../../engine-core/examples/strategies/ema-cross.ts', import.meta.url))
  writeFileSync(join(strategyDir, 'ema-cross.ts'), readFileSync(strategySource))
  service = await runServe(home, { port: 0, io: io(), connectors: false })
  secrets = [service.kernel.auth.mintBootToken()]
  expect(await run(['session', 'login'])).toBe(0)
  const account = service.kernel.accounts.list().find((entry) => entry.mode === 'paper')!
  if (bindEngine) {
    secrets = ['246810']
    expect(await run(['engines', 'bind', 'gitrader-core', '--account', account.accountId]), errors.join('')).toBe(0)
    secrets = ['246810']
    // fix-r4: risk relax 默认改为临时放宽（C1）；本用例要的是永久抬高上限（内核时钟是回放时钟，临时放宽的 24 小时校验会误伤），故显式 --permanent
    expect(await run(['risk', 'relax', JSON.stringify({ limits: { maxPositionNotionalRatio: '1.02', maxTotalNotionalRatio: '1.02' } }), '--permanent']), errors.join('')).toBe(0)
  }
}

async function replayEconomicResult(): Promise<{ orders: unknown[]; fills: unknown[]; positions: unknown[]; equity: string; timestamps: number[] }> {
  const account = service!.kernel.accounts.list().find((entry) => entry.mode === 'paper')!
  const instrumentId = `${account.venue}:BTC`
  out = []; errors = []
  expect(await run([
    'paper', 'replay', 'start', 'ema-cross', '--account', account.accountId, '--instrument', instrumentId, '--interval', '1m',
    '--params', JSON.stringify({ fast: 2, slow: 5, allowShort: true }),
    '--sizing', JSON.stringify({ allocRatio: 1, allocCapNotional: 1000000, leverage: 1, maxSlippageBps: 50, minStepNotional: 0.01 }),
  ]), errors.join('')).toBe(0)
  let status: { state: string; frameIndex: number; totalFrames: number }
  for (let attempt = 0; attempt < 500; attempt++) {
    out = []; errors = []
    expect(await run(['paper', 'replay', 'status']), errors.join('')).toBe(0)
    status = JSON.parse(out.join('')) as typeof status
    if (status.state !== 'running') break
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  expect(status!.state).toBe('completed')
  const orders = service!.kernel.orders.list({ accountId: account.accountId }).map(({ instrumentId: id, side, type, size, filledSize, price, status: state, fee, createdAt, updatedAt }) => ({ instrumentId: id, side, type, size, filledSize, price, status: state, fee, createdAt, updatedAt }))
  const fills = service!.kernel.orders.fills({ accountId: account.accountId }).map(({ instrumentId: id, side, price, size, fee, ts }) => ({ instrumentId: id, side, price, size, fee, ts }))
  const snapshot = await service!.kernel.bus.snapshot(account, { maxAgeMs: 0 })
  const positions = snapshot.positions.map(({ instrumentId: id, side, size, notional, leverage }) => ({ instrumentId: id, side, size, notional, leverage }))
  return { orders, fills, positions, equity: snapshot.equity, timestamps: fills.map((fill) => fill.ts) }
}

function preserveParityInputs(label: 'baseline' | 'spread', halfSpreadBps: number): void {
  const target = join(home, 'evidence')
  mkdirSync(join(target, 'strategies'), { recursive: true })
  const account = service!.kernel.accounts.list().find((entry) => entry.mode === 'paper')!
  const strategySource = fileURLToPath(new URL('../../engine-core/examples/strategies/ema-cross.ts', import.meta.url))
  copyFileSync(join(home, 'lab', 'replay', 'fixture.json'), join(target, `fixture-${label}.json`))
  copyFileSync(join(home, 'paper-state.json'), join(target, `paper-state-${label}.json`))
  copyFileSync(strategySource, join(target, 'strategies', 'ema-cross.ts'))
  writeFileSync(join(target, `scenario-${label}.json`), JSON.stringify({
    strategy: 'ema-cross', strategySha256: createHash('sha256').update(readFileSync(strategySource)).digest('hex'),
    accountId: account.accountId, instrument: `${account.venue}:BTC`, interval: '1m', params: { fast: 2, slow: 5, allowShort: true },
    balance: '1000', ccy: 'USDC', leverage: 1, paritySlippageBps: 1, halfSpreadBps,
  }, null, 2) + '\n')
}

async function heartbeatProbe(pulse: boolean): Promise<{ hostLost: number; ticks: number; instancesRunning: number }> {
  let now = 1700000000000
  let ticks = 0
  const originalSetInterval = globalThis.setInterval.bind(globalThis)
  const timerSpy = vi.spyOn(globalThis, 'setInterval').mockImplementation((handler, timeout, ...args) => {
    if (timeout === 2_147_483_647 && typeof handler === 'function') {
      return originalSetInterval((...callbackArgs) => { ticks++; handler(...callbackArgs) }, 5, ...args)
    }
    return originalSetInterval(handler, timeout, ...args)
  })
  const token = 'local-heartbeat-probe-token'
  const core = new EngineCore({ token, now: () => now, tickMs: 2_147_483_647, heartbeatMs: 1000, instances: { pollMinMs: 2_147_483_647 } })
  const frames: Record<string, unknown>[] = []
  const conn = core.connect({
    kind: 'memory', maxFrameBytes: GEP_LIMITS.maxWsFrameBytes, closeTransport: () => {},
    send: (text) => { frames.push(JSON.parse(text) as Record<string, unknown>) },
  })
  try {
    await conn.peer.receive(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'gep.hello', params: {
      protocol: 'gep', versions: ['0.1'], host: { id: 'heartbeat-test', name: 'test', version: '0.1' }, auth: { token },
    } }))
    now += 3000
    if (pulse) await conn.peer.receive(JSON.stringify({ jsonrpc: '2.0', method: 'gep.heartbeat', params: { ts: now } }))
    const deadline = Date.now() + 500
    while (ticks === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5))
    expect(ticks).toBeGreaterThan(0)
    await conn.peer.receive(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'engine.health', params: {} }))
    const health = frames.find((frame) => frame.id === 2)?.result as { metrics: { hostLost: number; instancesRunning: number } } | undefined
    expect(health).toBeDefined()
    return { hostLost: health!.metrics.hostLost, ticks, instancesRunning: health!.metrics.instancesRunning }
  } finally {
    core.disconnect(conn)
    core.close()
    timerSpy.mockRestore()
  }
}

describe('CLI historical replay entry', () => {
  beforeEach(async () => {
    await setupReplayHome()
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await service?.stop().catch(() => undefined)
    service = undefined
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })

  it('keeps fixture internals private and reveals only closed frames through PaperMarket', async () => {
    const fixture = JSON.parse(readFileSync(join(home, 'lab', 'replay', 'fixture.json'), 'utf8')) as Parameters<typeof createReplayMarket>[0]
    const { market, advance } = createReplayMarket(fixture)
    const instrumentId = fixture.instruments[0]!.instrumentId
    expect('frames' in market).toBe(false)
    expect('seek' in market).toBe(false)
    expect('now' in market).toBe(false)
    expect('advance' in market).toBe(false)
    expect(market.quote(instrumentId)).toBeUndefined()
    expect(await market.candles(instrumentId, '1m')).toEqual([])
    await expect(market.book(instrumentId)).rejects.toThrow(/has not advanced/)
    await expect(market.context(instrumentId)).rejects.toThrow(/has not advanced/)
    advance(0)
    const prefix = await market.candles(instrumentId, '1m')
    expect(prefix).toHaveLength(1)
    expect(prefix[0]?.t).toBe(fixture.frames[0]!.candles[0]!.t)
    expect(typeof prefix[0]?.o).toBe('number')
    expect(typeof prefix[0]?.v).toBe('number')
    fixture.frames[89]!.candles[0]!.c = fixture.frames[0]!.candles[0]!.o
    fixture.frames[89]!.marks[instrumentId] = fixture.frames[0]!.marks[instrumentId]!
    expect(await market.candles(instrumentId, '1m')).toEqual(prefix)
    expect(market.quote(instrumentId)?.last).toBe(Number(fixture.frames[0]!.marks[instrumentId]))
  })

  it('runs a loaded strategy through the real session, binding, risk gate, PaperVenue and status readback', async () => {
    const account = service!.kernel.accounts.list().find((entry) => entry.mode === 'paper')!
    const instrumentId = `${account.venue}:BTC`
    const observedHistory: Awaited<ReturnType<PaperVenue['candles']>>[] = []
    const originalCandles = PaperVenue.prototype.candles
    const historySpy = vi.spyOn(PaperVenue.prototype, 'candles').mockImplementation(async function (
      this: PaperVenue,
      ...args: Parameters<PaperVenue['candles']>
    ) {
      const rows = await originalCandles.apply(this, args)
      observedHistory.push(rows)
      return rows
    })
    const started = await run([
        'paper', 'replay', 'start', 'ema-cross', '--account', account.accountId,
        '--instrument', instrumentId, '--interval', '1m', '--params', JSON.stringify({ fast: 2, slow: 5, allowShort: true }),
        '--sizing', JSON.stringify({ allocRatio: 1, allocCapNotional: 1000000, leverage: 1, maxSlippageBps: 50, minStepNotional: 0.01 }),
      ])
    expect(started, errors.join('')).toBe(0)
    let status: { state: string; frameIndex: number; totalFrames: number }
    for (let attempt = 0; attempt < 500; attempt++) {
      out = []; errors = []
      expect(await run(['paper', 'replay', 'status']), errors.join('')).toBe(0)
      status = JSON.parse(out.join('')) as typeof status
      if (status.state !== 'running') break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(status!.state).toBe('completed')
    expect(status!.frameIndex).toBe(89)
    expect(status!.totalFrames).toBe(90)
    const signalTargets = service!.kernel.ledger.query({ types: ['signal.emitted'], limit: 1000 })
      .map((entry) => (entry.payload as { target?: number }).target)
    const orders = service!.kernel.orders.list({ accountId: account.accountId })
    const fills = service!.kernel.orders.fills({ accountId: account.accountId })
    const snapshot = await service!.kernel.bus.snapshot(account, { maxAgeMs: 0 })
    const ledgerTypeCounts = service!.kernel.ledger.query({ limit: 1000 }).reduce<Record<string, number>>((counts, entry) => {
      counts[entry.type] = (counts[entry.type] ?? 0) + 1
      return counts
    }, {})
    const signalEvidence = JSON.stringify({ signalTargets, ledgerTypeCounts, engineEventsSeen: service!.kernel.gep.stats.engineEventsSeen, orders: orders.length, fills: fills.length, equity: snapshot.equity })
    expect(service!.kernel.gep.stats.marketHistory).toBeGreaterThan(0)
    const finalCandleTime = (JSON.parse(readFileSync(join(home, 'lab', 'replay', 'fixture.json'), 'utf8')) as Parameters<typeof createReplayMarket>[0]).frames[89]!.candles[0]!.t
    expect(observedHistory.some((rows) => rows.at(-1)?.t === finalCandleTime && typeof rows.at(-1)?.o === 'number')).toBe(true)
    historySpy.mockRestore()
    expect(signalTargets, signalEvidence).toContain(1)
    expect(signalTargets, signalEvidence).toContain(-1)
    expect(orders.length).toBeGreaterThan(0)
    expect(fills.length).toBeGreaterThan(0)
    expect(snapshot.positions.length).toBeGreaterThan(0)
    expect(snapshot.equity).not.toBe('1000')
    const paperState = JSON.parse(readFileSync(join(home, 'paper-state.json'), 'utf8')) as { gitraderProvenance?: { source?: string } }
    expect(paperState.gitraderProvenance?.source).toBe('replay')
  })

  it('repeats semantic economics across fresh homes and changes real outcomes with a wider spread', async () => {
    const baselineA = await replayEconomicResult()
    preserveParityInputs('baseline', 1)
    expect(baselineA.orders.length).toBeGreaterThan(0)
    expect(baselineA.fills.length).toBeGreaterThan(0)
    await service!.stop()
    service = undefined
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })

    await setupReplayHome()
    const baselineB = await replayEconomicResult()
    expect(baselineB).toEqual(baselineA)
    await service!.stop()
    service = undefined
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })

    await setupReplayHome(20)
    const widerSpread = await replayEconomicResult()
    preserveParityInputs('spread', 20)
    expect(widerSpread.orders.length).toBeGreaterThan(0)
    expect(widerSpread.fills.length).toBeGreaterThan(0)
    expect(widerSpread.fills).not.toEqual(baselineA.fills)
    expect(widerSpread.equity).not.toBe(baselineA.equity)
  })

  it('stops through the real CLI and leaves a stable partial tagged artifact', async () => {
    const account = service!.kernel.accounts.list().find((entry) => entry.mode === 'paper')!
    const instrumentId = `${account.venue}:BTC`
    out = []; errors = []
    expect(await run([
      'paper', 'replay', 'start', 'ema-cross', '--account', account.accountId, '--instrument', instrumentId, '--interval', '1m',
      '--params', JSON.stringify({ fast: 2, slow: 5, allowShort: true }),
      '--sizing', JSON.stringify({ allocRatio: 1, allocCapNotional: 1000000, leverage: 1, maxSlippageBps: 50, minStepNotional: 0.01 }),
    ]), errors.join('')).toBe(0)
    const started = JSON.parse(out.join('')) as { runId: string }
    expect(started.runId).toMatch(/^job_/)
    let frameIndex = -1
    for (let attempt = 0; attempt < 200; attempt++) {
      out = []; errors = []
      expect(await run(['paper', 'replay', 'status']), errors.join('')).toBe(0)
      frameIndex = (JSON.parse(out.join('')) as { frameIndex: number }).frameIndex
      if (frameIndex >= 2) break
      await new Promise((resolve) => setTimeout(resolve, 2))
    }
    expect(frameIndex).toBeGreaterThanOrEqual(0)
    out = []; errors = []
    expect(await run(['paper', 'replay', 'stop', started.runId]), errors.join('')).toBe(0)
    const stopped = JSON.parse(out.join('')) as { state: string; frameIndex: number; artifact?: string }
    expect(stopped.state).toBe('cancelled')
    expect(stopped.frameIndex).toBeGreaterThanOrEqual(0)
    expect(stopped.artifact).toMatch(/^exports\/replay\/job_/)
    await new Promise((resolve) => setTimeout(resolve, 25))
    out = []; errors = []
    expect(await run(['paper', 'replay', 'status']), errors.join('')).toBe(0)
    expect(JSON.parse(out.join(''))).toMatchObject({ state: 'cancelled', frameIndex: stopped.frameIndex })
    errors = []; out = []
    expect(await run([
      'paper', 'replay', 'start', 'ema-cross', '--account', account.accountId, '--instrument', instrumentId, '--interval', '1m',
    ])).toBe(1)
    expect(errors.join('')).toMatch(/already started its single replay run/)
    expect(service!.kernel.replayStatus()).toMatchObject({ state: 'cancelled', frameIndex: stopped.frameIndex })
    const paperState = JSON.parse(readFileSync(join(home, 'paper-state.json'), 'utf8')) as { gitraderProvenance?: { source?: string; runId?: string } }
    expect(paperState.gitraderProvenance).toMatchObject({ source: 'replay', runId: started.runId })
  })

  it('rejects a replay write after human logout without creating a run or records', async () => {
    const account = service!.kernel.accounts.list().find((entry) => entry.mode === 'paper')!
    expect(await run(['session', 'logout'])).toBe(0)
    out = []; errors = []
    expect(await run([
      'paper', 'replay', 'start', 'ema-cross', '--account', account.accountId, '--instrument', `${account.venue}:BTC`, '--interval', '1m',
    ])).toBe(1)
    expect(errors.join('')).toMatch(/No valid local session|sign in again/)
    expect(service!.kernel.replayStatus()).toMatchObject({ state: 'idle', frameIndex: -1 })
    expect(service!.kernel.orders.list({ accountId: account.accountId })).toHaveLength(0)
    expect(service!.kernel.orders.fills({ accountId: account.accountId })).toHaveLength(0)
  })

  it('rejects a paper account without a ready engine binding before creating a replay run', async () => {
    await service!.stop()
    service = undefined
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
    await setupReplayHome(1, false)
    const account = service!.kernel.accounts.list().find((entry) => entry.mode === 'paper')!
    errors = []; out = []
    expect(await run([
      'paper', 'replay', 'start', 'ema-cross', '--account', account.accountId,
      '--instrument', `${account.venue}:BTC`, '--interval', '1m',
    ])).toBe(1)
    expect(errors.join('')).toMatch(/existing ready engine binding/)
    expect(service!.kernel.replayStatus()).toMatchObject({ state: 'idle', frameIndex: -1 })
    expect(service!.kernel.orders.list({ accountId: account.accountId })).toHaveLength(0)
    expect(service!.kernel.orders.fills({ accountId: account.accountId })).toHaveLength(0)
  })

  it('rejects a valid fixture whose horizon exceeds the normal PIN mandate before creating a run', async () => {
    await service!.stop()
    service = undefined
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
    await setupReplayHome(1, true, Date.now(), 24 * 60 * 60 * 1000)
    const fixture = JSON.parse(readFileSync(join(home, 'lab', 'replay', 'fixture.json'), 'utf8')) as Parameters<typeof createReplayMarket>[0]
    const horizonDays = (fixture.frames.at(-1)!.ts - fixture.frames[0]!.ts) / (24 * 60 * 60 * 1000)
    expect(horizonDays).toBeGreaterThan(30)
    expect(horizonDays).toBeLessThan(365)
    const account = service!.kernel.accounts.list().find((entry) => entry.mode === 'paper')!
    errors = []; out = []
    expect(await run([
      'paper', 'replay', 'start', 'ema-cross', '--account', account.accountId,
      '--instrument', `${account.venue}:BTC`, '--interval', '1m',
    ])).toBe(1)
    expect(errors.join('')).toMatch(/mandate must cover the full replay fixture horizon/)
    expect(service!.kernel.replayStatus()).toMatchObject({ state: 'idle', frameIndex: -1 })
    expect(service!.kernel.orders.list({ accountId: account.accountId })).toHaveLength(0)
    expect(service!.kernel.orders.fills({ accountId: account.accountId })).toHaveLength(0)
  })

  it('rejects an empty fixture before the local service starts', async () => {
    await service!.stop()
    service = undefined
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
    home = mkdtempSync(join(tmpdir(), 'gitrader-b3-replay-invalid-'))
    out = []; errors = []; secrets = ['246810', '246810']
    expect(await run(['init'])).toBe(0)
    writeReplayFixture()
    const fixturePath = join(home, 'lab', 'replay', 'fixture.json')
    const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as { frames: unknown[] }
    fixture.frames = []
    writeFileSync(fixturePath, `${JSON.stringify(fixture)}\n`)
    await expect(runServe(home, { port: 0, io: io(), connectors: false })).rejects.toThrow(/invalid replay fixture/)
    expect(service).toBeUndefined()
  })

  it('records a missing real strategy as failed without synthesizing orders or fills', async () => {
    const account = service!.kernel.accounts.list().find((entry) => entry.mode === 'paper')!
    out = []; errors = []
    expect(await run([
      'paper', 'replay', 'start', 'strategy-not-present', '--account', account.accountId,
      '--instrument', `${account.venue}:BTC`, '--interval', '1m',
    ]), errors.join('')).toBe(0)
    const started = JSON.parse(out.join('')) as { runId: string }
    let status: { state: string; runId?: string; frameIndex: number }
    for (let attempt = 0; attempt < 200; attempt++) {
      out = []; errors = []
      expect(await run(['paper', 'replay', 'status']), errors.join('')).toBe(0)
      status = JSON.parse(out.join('')) as typeof status
      if (status.state !== 'running') break
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    expect(status!.state).toBe('failed')
    expect(status!.runId).toBe(started.runId)
    expect(status!.frameIndex).toBe(-1)
    expect(service!.kernel.orders.list({ accountId: account.accountId })).toHaveLength(0)
    expect(service!.kernel.orders.fills({ accountId: account.accountId })).toHaveLength(0)
  })

  it('refuses a copied tagged state in a normal runServe home before PaperVenue import', async () => {
    const normalHome = mkdtempSync(join(tmpdir(), 'gitrader-b3-normal-state-'))
    const normalIo: CliIo = { ...io(), env: { GITRADER_HOME: normalHome } }
    const importSpy = vi.spyOn(PaperVenue.prototype, 'importState')
    try {
      expect(await main(['init', '--no-pin'], normalIo)).toBe(0)
      // fix-r2 S2：账本库不在而纸面状态在 = 拒绝启动；先让这个家目录有账本，测的仍是连接器边界上的来源拦截
      await (await Kernel.create({ home: normalHome, timers: false, deviceKeyProvider: fileProvider })).stop()
      writeFileSync(join(normalHome, 'paper-state.json'), readFileSync(join(home, 'paper-state.json')))
      const fixture = JSON.parse(readFileSync(join(home, 'lab', 'replay', 'fixture.json'), 'utf8')) as Parameters<typeof createReplayMarket>[0]
      await expect(runServe(normalHome, {
        io: normalIo, connectors: false,
        connect: (k) => { assembleReplayPaper({ k, market: createReplayMarket(fixture).market, clock: () => Date.now(), io: normalIo }) },
      })).rejects.toThrow(/historical paper state cannot be imported/)
      expect(importSpy).not.toHaveBeenCalled()
    } finally {
      importSpy.mockRestore()
      rmSync(normalHome, { recursive: true, force: true, maxRetries: 5 })
    }
  })
})

describe('EngineCore replay heartbeat probe', () => {
  it('keeps host live after a public heartbeat and detects the withheld-pulse control', async () => {
    const live = await heartbeatProbe(true)
    const lost = await heartbeatProbe(false)
    expect(live.ticks).toBeGreaterThan(0)
    expect(live.hostLost).toBe(0)
    expect(live.instancesRunning).toBe(0)
    expect(lost.ticks).toBeGreaterThan(0)
    expect(lost.hostLost).toBe(1)
    expect(lost.instancesRunning).toBe(0)
  })
})
