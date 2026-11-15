// SPDX-License-Identifier: CPAL-1.0
import { createHash } from 'node:crypto'
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, relative, sep } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildDescribe } from '../src/runtime/describe'
import { getStrategySha256, loadStrategyFile } from '../src/strategy/loader'
import { StrategyRegistry } from '../src/strategy/registry'
import { makeProblem, PROBLEM_CODES } from '../src/proto'
import { sha256Digest } from '../src/util/hash'
import { validateBacktestResult, validateBySchemaId } from '../../protocol/src/validate'
import { genCandles, INSTRUMENTS, T0 } from '../../protocol/conformance/host-sim'
import { rig, BTC, FIXTURE_STRATEGIES, type Rig } from './harness'

const tempDirs: string[] = []
// GQ-12：作业表落盘在 <artifactDir>/_jobs（回测作业终态/结果表，引擎重启后仍可取）。
// 下面「暂存目录应当已清空」的断言只针对内核自己写出的暂存产物，作业表目录不算暂存残留，按名忽略。
const stagingEntries = (dir: string): string[] => readdirSync(dir).filter((name) => name !== '_jobs')
let activeRig: Rig | null = null
const createTempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'gitrader-experiment-e-'))
  tempDirs.push(dir)
  return dir
}

const waitBacktest = async (r: Rig, jobId: string, expected: 'done' | 'failed' | 'cancelled'): Promise<void> => {
  const deadline = Date.now() + 15_000
  for (;;) {
    const state = (await r.session.call<{ state: string }>('backtest.status', { jobId })).state
    if (state === expected) return
    if (state === 'done' || state === 'failed' || state === 'cancelled') throw new Error(`backtest ${state}, expected ${expected}`)
    if (Date.now() > deadline) throw new Error('backtest timed out')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

afterEach(() => {
  activeRig?.close()
  activeRig = null
  for (const dir of tempDirs.splice(0)) {
    const rel = relative(tmpdir(), dir)
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || basename(dir).startsWith('gitrader-experiment-e-') === false) {
      throw new Error('Refusing to remove a path outside this test’s temporary directory')
    }
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('strategy source digest', () => {
  it('tracks exact source bytes on the loaded def and describe entry', async () => {
    const dir = createTempDir()
    const source = Buffer.from(`export default {
  id: 'digest-fixture', name: 'Digest fixture', version: '1.0.0', desc: 'digest test', tags: [], params: [],
  evaluate(candles) { return { target: candles.map(() => 0), reasons: candles.map(() => ''), overlays: {}, warmup: 0 } },
}
`, 'utf8')
    const firstPath = join(dir, 'first.mjs')
    const secondPath = join(dir, 'renamed.mjs')
    writeFileSync(firstPath, source)
    copyFileSync(firstPath, secondPath)

    const first = await loadStrategyFile(firstPath)
    const second = await loadStrategyFile(secondPath)
    expect(first.errors).toEqual([])
    expect(second.errors).toEqual([])
    expect(first.def).toBeDefined()
    expect(second.def).toBeDefined()
    const expectedSourceDigest = `sha256:${createHash('sha256').update(source).digest('hex')}`
    expect(getStrategySha256(first.def!)).toBe(expectedSourceDigest)
    expect(getStrategySha256(second.def!)).toBe(expectedSourceDigest)

    const altered = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('// source comment\n'), source])
    const alteredPath = join(dir, 'altered.mjs')
    writeFileSync(alteredPath, altered)
    const changed = await loadStrategyFile(alteredPath)
    expect(changed.errors).toEqual([])
    expect(changed.def).toBeDefined()
    const expectedAlteredDigest = `sha256:${createHash('sha256').update(altered).digest('hex')}`
    expect(getStrategySha256(changed.def!)).toBe(expectedAlteredDigest)
    expect(getStrategySha256(changed.def!)).not.toBe(expectedSourceDigest)
    expect(getStrategySha256(first.def!)).toBe(expectedSourceDigest)
    expect(getStrategySha256({ ...first.def! })).toBeUndefined()

    const registry = new StrategyRegistry()
    registry.set(changed.def!)
    const describe = buildDescribe({ maxBars: 800, maxConcurrentBacktests: 2, maxInstances: 20 }, registry)
    expect(describe.strategies?.[0]).toMatchObject({ id: 'digest-fixture', sha256: expectedAlteredDigest })
  })

  it('uploads complete inline equity and trades for each small deterministic backtest', async () => {
    activeRig = await rig()
    const captures: { kind: string; body: Buffer; artifactId: string; sha256: string; sizeBytes: number; mediaType: string }[] = []
    const originalHandle = activeRig.host.handle.bind(activeRig.host)
    activeRig.host.handle = (method, params) => {
      if (method !== 'host.artifact.put') return originalHandle(method, params)
      const body = readFileSync(params.path)
      const receipt = originalHandle(method, params)
      if ('result' in receipt) captures.push({ kind: params.kind, body, artifactId: String((receipt.result as { artifactId: string }).artifactId), sha256: params.sha256, sizeBytes: params.sizeBytes, mediaType: params.mediaType })
      return receipt
    }

    const spec = {
      subject: { strategy: { id: 'ema-trend', version: '0.1.0', params: { fast: 5, slow: 20 } } },
      instruments: [BTC], interval: '1m', from: T0, to: T0 + 120 * 60_000,
      data: { source: 'host' }, account: { initialBalance: '10000', ccy: 'USDC', leverage: 1 },
      assumptions: { fees: { maker: '0.00015', taker: '0.00045' }, slippageBps: 2, fillModel: 'next-bar-open', funding: false, liquidation: false },
      seed: 42,
    }
    const run = async (mutateAfterSubmit = false) => {
      const request = structuredClone(spec)
      const snapshot = structuredClone(request)
      const jobId = activeRig!.core.jobs.submit(request)
      if (mutateAfterSubmit) {
        request.seed = 43
        request.subject.strategy.params.fast = 6
      }
      const deadline = Date.now() + 15_000
      for (;;) {
        const state = activeRig!.core.jobs.status(jobId)
        if (state.state === 'done') return { result: activeRig!.core.jobs.result(jobId), snapshot }
        if (state.state === 'failed' || state.state === 'cancelled') throw new Error(`backtest ${state.state}`)
        if (Date.now() > deadline) throw new Error('backtest timed out')
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
    }

    const { result: first, snapshot } = await run(true)
    const firstCaptures = captures.slice(0, 2)
    expect(firstCaptures.map((capture) => capture.kind)).toEqual(['equity', 'trades'])
    expect(firstCaptures.map((capture) => JSON.parse(capture.body.toString('utf8')))).toEqual([first.equity, first.trades])
    for (const capture of firstCaptures) {
      const artifact = first.artifacts.find((item: { kind: string }) => item.kind === capture.kind)
      expect(artifact?.artifactId).toBe(capture.artifactId)
      expect(capture.sha256).toBe(`sha256:${createHash('sha256').update(capture.body).digest('hex')}`)
      expect(capture.sizeBytes).toBe(capture.body.byteLength)
      expect(capture.artifactId).not.toBe('')
      expect(capture.mediaType).toBe('application/json')
    }
    expect(validateBacktestResult(first).ok).toBe(true)
    expect(validateBySchemaId('urn:gitrader:schema:model:0.1:EvidencePackDraft', first.pack).ok).toBe(true)
    const pack = first.pack!
    expect(pack).toMatchObject({ schema: 'gitrader-experiment/1', kind: 'backtest', tier: 'hypothetical', subjectKey: first.strategySha256 })
    for (const field of ['packId', 'experimentId', 'runId', 'at', 'trialCount', 'trialStats', 'provenance', 'attestation']) expect(pack).not.toHaveProperty(field)
    expect(pack.biasChecks).not.toHaveProperty('trialCount')
    expect(first.strategySha256).toBe(`sha256:${createHash('sha256').update(readFileSync(join(FIXTURE_STRATEGIES, 'ema-cross.ts'))).digest('hex')}`)
    expect(pack.spec).toEqual(snapshot)
    expect(pack.specDigest).toBe(first.specDigest)
    expect(pack.assumptions).toEqual(first.assumptions)
    expect(pack.seed).toBe(42)
    const candleRows = genCandles(7, 120).map((c) => [c.t, c.o, c.h, c.l, c.c, c.v])
    expect(pack.data.candlesDigests).toEqual([{ instrumentId: BTC, digest: `sha256:${createHash('sha256').update(`gitrader-candles/1\n${JSON.stringify(candleRows)}`).digest('hex')}` }])
    expect(pack.data).toMatchObject({ source: 'host', pointInTime: true, candlesDigestMethod: 'gitrader-candles/1', timezone: 'UTC', alignment: 'open-time' })
    expect(pack.instrumentMeta).toEqual(INSTRUMENTS.filter((instrument) => instrument.instrumentId === BTC))
    expect(pack.llm).toEqual({ involved: false, derivedFrom: 'declared', models: [], contaminated: 'unknown', leakFreeFrom: null })
    expect(pack.artifacts).toEqual(firstCaptures.map((capture) => ({ artifactId: capture.artifactId, sha256: capture.sha256, kind: capture.kind, sizeBytes: capture.sizeBytes, mediaType: capture.mediaType })))

    const { result: second } = await run()
    const secondCaptures = captures.slice(2, 4)
    expect(secondCaptures.map((capture) => capture.kind)).toEqual(['equity', 'trades'])
    expect(secondCaptures.map((capture) => capture.body)).toEqual(firstCaptures.map((capture) => capture.body))
    expect(second.artifacts).toEqual(first.artifacts)
    expect(captures).toHaveLength(4)
  })

  it('fails the whole backtest when the second artifact put fails, then allows a fresh retry', async () => {
    const stagingParent = createTempDir()
    activeRig = await rig({ jobs: { artifactDir: stagingParent } })
    const originalHandle = activeRig.host.handle.bind(activeRig.host)
    let puts = 0
    activeRig.host.handle = (method, params) => {
      if (method === 'host.artifact.put' && ++puts === 2) return { error: makeProblem('INTERNAL', 'artifact upload failed') }
      return originalHandle(method, params)
    }
    const spec = {
      subject: { strategy: { id: 'ema-trend', version: '0.1.0', params: { fast: 5, slow: 20 } } },
      instruments: [BTC], interval: '1m', from: T0, to: T0 + 120 * 60_000,
      data: { source: 'host' }, account: { initialBalance: '10000', ccy: 'USDC', leverage: 1 },
      assumptions: { fees: { maker: '0.00015', taker: '0.00045' }, slippageBps: 2, fillModel: 'next-bar-open', funding: false, liquidation: false },
      seed: 42,
    }
    await activeRig.session.call('events.subscribe', { streams: ['backtest'] })
    const { jobId } = await activeRig.session.call('backtest.run', { spec })
    const deadline = Date.now() + 15_000
    for (;;) {
      const state = await activeRig.session.call('backtest.status', { jobId })
      if (state.state === 'failed') break
      if (state.state === 'done' || state.state === 'cancelled') throw new Error(`unexpected backtest ${state.state}`)
      if (Date.now() > deadline) throw new Error('backtest timed out')
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    expect(puts).toBe(2)
    expect(await activeRig.session.waitFor(() => activeRig!.session.events.some((event) => event.type === 'backtest.progress' && event.data.jobId === jobId && event.data.state === 'failed'), 1000)).toBe(true)
    expect(activeRig.session.events.some((event) => event.type === 'backtest.progress' && event.data.jobId === jobId && event.data.state === 'done')).toBe(false)
    expect(() => activeRig!.core.jobs.result(jobId)).toThrow()
    const error = await activeRig.session.expectError('backtest.result', { jobId })
    expect(error.code).toBe(PROBLEM_CODES.BACKTEST_FAILED.code)
    expect(error.data?.name).toBe('BACKTEST_FAILED')
    expect(error.message).toContain(String(PROBLEM_CODES.INTERNAL.code))
    expect(stagingEntries(stagingParent)).toEqual([])

    activeRig.host.handle = originalHandle
    const { jobId: retryId } = await activeRig.session.call('backtest.run', { spec })
    const retryDeadline = Date.now() + 15_000
    for (;;) {
      const state = await activeRig.session.call('backtest.status', { jobId: retryId })
      if (state.state === 'done') break
      if (state.state === 'failed' || state.state === 'cancelled') throw new Error(`retry ${state.state}`)
      if (Date.now() > retryDeadline) throw new Error('retry timed out')
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    const retry = await activeRig.session.call('backtest.result', { jobId: retryId })
    expect(retry.artifacts.map((artifact: { kind: string }) => artifact.kind)).toEqual(['equity', 'trades'])
  })

  it('falls back to inline delivery when the host has no artifact.put', async () => {
    const r = await rig()
    activeRig = r
    const originalHandle = r.host.handle.bind(r.host)
    r.host.handle = (method, params) => {
      if (method === 'host.artifact.put') return { error: makeProblem('CAPABILITY_UNSUPPORTED', 'artifact store unavailable') }
      return originalHandle(method, params)
    }
    const spec = {
      subject: { strategy: { id: 'ema-trend', version: '0.1.0', params: { fast: 5, slow: 20 } } },
      instruments: [BTC], interval: '1m', from: T0, to: T0 + 120 * 60_000,
      data: { source: 'host' }, account: { initialBalance: '10000', ccy: 'USDC', leverage: 1 },
      assumptions: { fees: { maker: '0.00015', taker: '0.00045' }, slippageBps: 2, fillModel: 'next-bar-open', funding: false, liquidation: false },
      seed: 42,
    }
    const { jobId } = await r.session.call('backtest.run', { spec })
    await waitBacktest(r, jobId, 'done')
    const result = await r.session.call('backtest.result', { jobId })
    expect(result.warnings.join('|')).toContain('host.artifact.put unavailable')
    expect(result.artifacts).toEqual([])
    expect(result.equity.length).toBeGreaterThan(0)
  })

  it('cancels during delivery and removes the per-job staging directory', async () => {
    const stagingParent = createTempDir()
    const r = await rig({ jobs: { artifactDir: stagingParent } })
    activeRig = r
    let releasePut: () => void = () => {}
    const gate = new Promise<void>((resolve) => { releasePut = resolve })
    let putStarted = false
    const originalCall = r.core.host.call.bind(r.core.host) as unknown as (method: string, params: unknown, timeoutMs?: number) => Promise<unknown>
    r.core.host.call = (async (method: string, params: unknown, timeoutMs?: number) => {
      if (method === 'host.artifact.put') {
        putStarted = true
        await gate
      }
      return originalCall(method, params, timeoutMs)
    }) as unknown as typeof r.core.host.call
    try {
      const spec = {
        subject: { strategy: { id: 'ema-trend', version: '0.1.0', params: { fast: 5, slow: 20 } } },
        instruments: [BTC], interval: '1m', from: T0, to: T0 + 120 * 60_000,
        data: { source: 'host' }, account: { initialBalance: '10000', ccy: 'USDC', leverage: 1 },
        assumptions: { fees: { maker: '0.00015', taker: '0.00045' }, slippageBps: 2, fillModel: 'next-bar-open', funding: false, liquidation: false },
        seed: 42,
      }
      const { jobId } = await r.session.call('backtest.run', { spec })
      expect(await r.session.waitFor(() => putStarted, 5000)).toBe(true)
      expect(r.core.jobs.cancel(jobId).state).toBe('running')
      releasePut()
      await waitBacktest(r, jobId, 'cancelled')
      expect(stagingEntries(stagingParent)).toEqual([])
    } finally {
      releasePut()
    }
  })

  it('fails fast with DATA_UNAVAILABLE when a candle is invalid', async () => {
    const r = await rig()
    activeRig = r
    const dir = createTempDir()
    const candles = genCandles(13, 60)
    const bad = candles[5]!
    candles[5] = { ...bad, h: bad.l - 1 }
    const text = 't,o,h,l,c,v\n' + candles.map((c) => [c.t, c.o, c.h, c.l, c.c, c.v].join(',')).join('\n')
    const path = join(dir, 'bad.csv')
    writeFileSync(path, text)
    const spec = {
      subject: { strategy: { id: 'ema-trend', version: '0.1.0', params: { fast: 5, slow: 20 } } },
      instruments: [BTC], interval: '1m', from: T0, to: T0 + 120 * 60_000,
      data: { source: 'files', files: [{ path, sha256: sha256Digest(Buffer.from(text, 'utf8')), format: 'csv' }] },
      account: { initialBalance: '10000', ccy: 'USDC', leverage: 1 },
      assumptions: { fees: { maker: '0.00015', taker: '0.00045' }, slippageBps: 2, fillModel: 'next-bar-open', funding: false, liquidation: false },
      seed: 42,
    }
    const { jobId } = await r.session.call('backtest.run', { spec })
    await waitBacktest(r, jobId, 'failed')
    const error = await r.session.expectError('backtest.result', { jobId })
    expect(error.code).toBe(PROBLEM_CODES.DATA_UNAVAILABLE.code)
    expect(error.message).toContain('candles[5]')
  })
})
