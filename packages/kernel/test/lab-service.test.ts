// SPDX-License-Identifier: CPAL-1.0
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeAgent, makeHarness, TEST_PIN } from './helpers/harness'
import type { Harness } from './helpers/harness'
import { sha256Digest } from '../src/util/hash'
import { digestOf } from '../src/util/hash'
import { LabService } from '../src/lab'
import { BTC, ETH } from './helpers/fake-connector'
import { D } from '../src/util/dec'
import { newClientOrderId, newId } from '../src/util/ids'
import { candlesDigest, validateBacktestSpec } from '../src/proto'
import * as protocol from '../src/proto'
import type { BacktestSpec, BacktestResult, Instrument } from '../src/proto'
import { loadExperimentCases } from '../../protocol/conformance/experiment/load'
import type { ActorCtx } from '../src/trading'

const harnesses: Harness[] = []
afterEach(async () => { await Promise.all(harnesses.splice(0).map((h) => h.cleanup())) })

async function setup() {
  const h = await makeHarness()
  harnesses.push(h)
  return h
}

async function create(h: Harness, actor = h.human(), extra: Record<string, unknown> = {}, engineId?: string) {
  return h.k.lab.handle('create', { patch: { title: 'Baseline', hypothesis: 'Observed input changes the measured outcome', ...extra }, ...(engineId ? { engineId } : {}) }, actor) as Promise<any> // eslint-disable-line @typescript-eslint/no-explicit-any
}

async function backtestFixture(h: Harness, actor = h.human('experiment'), source: 'host' | 'engine' | 'files' = 'engine', tamper?: (a: any) => any, instrumentMeta?: Instrument[]) {
  const engineId = 'lab-fixture'
  const strategyHash = `sha256:${'a'.repeat(64)}` as const
  const assumptions = { fees: 'venue' as const, slippageBps: 3, fillModel: 'next-bar-open' as const, funding: false, liquidation: false }
  const spec: BacktestSpec = {
    subject: { strategy: { id: 'strategy-fixture', version: '1', params: {} } }, instruments: [BTC],
    interval: '1h', from: 0, to: 10, data: { source },
    account: { initialBalance: '10000' as never, ccy: 'USD', leverage: 1 }, assumptions, seed: 1,
  }
  // Helper to mimic real engine behavior: augment assumptions like engine-core/src/runtime/backtest-jobs.ts:208-220
  const effectiveOf = (a: any) => {
    const base = {
      ...a,
      fees: a.fees === 'venue' ? { maker: '0.00015', taker: '0.00045' } : a.fees,
      funding: false,
      liquidation: false,
      latencyMs: 0,
      liquidationPenaltyRatio: 0,
      'x-intraBar': 'not modelled: signal at bar close, fill at next bar open',
      'x-feesApplied': 'taker fee on every fill (all simulated orders are market orders)',
      'x-maintenanceMarginRatio': 0.5,
    }
    return tamper ? tamper(base) : base
  }
  const jobs = new Map<string, BacktestSpec>()
  let sequence = 0
  let artifacts: NonNullable<BacktestResult['pack']>['artifacts'] = []
  const raw = async (_engine: string, method: string, params: any): Promise<any> => { // eslint-disable-line @typescript-eslint/no-explicit-any
    if (method === 'strategy.list') return { strategies: [{ id: 'strategy-fixture', version: '1', sha256: strategyHash }] }
    if (method === 'strategy.status') return { instances: [{ instanceId: 'inst_fixture', strategyId: 'strategy-fixture', accountId: h.paper.accountId }] }
    if (method === 'backtest.run') {
      const jobId = `fixture-job-${++sequence}`
      jobs.set(jobId, structuredClone(params.spec))
      return { jobId }
    }
    if (method === 'replay.start') return { replayId: `fixture-replay-${++sequence}` }
    if (method === 'backtest.status') return { state: 'done' }
    if (method !== 'backtest.result') throw new Error('Unexpected fixture method')
    const runSpec = jobs.get(params.jobId)!
    const specDigest = digestOf(runSpec)
    const digest = source === 'host'
      ? await candlesDigest(await h.k.marketStore.read(BTC, runSpec.interval, { from: runSpec.from, to: runSpec.to }))
      : `sha256:${'b'.repeat(64)}`
    const stats = { totalReturnRatio: 0.01, annualizedRatio: 0.02, maxDrawdownRatio: 0, sharpe: 1, sortino: 0, winRatio: 0.5, profitFactor: 1, trades: 10, fills: 10, avgHoldBars: 1, spanDays: 30, finalEquity: 10100 }
    const biasChecks = { lookahead: 'pass', recursive: 'pass', trialCount: 1 }
    const effective = effectiveOf(runSpec.assumptions)
    return {
      jobId: params.jobId, specDigest, assumptions: effective, stats,
      equity: [{ t: runSpec.from, v: 10000 }, { t: runSpec.to, v: 10100 }],
      trades: [{ t: runSpec.from, side: 'buy', price: 100, size: 1, pnl: 0, fee: 0, reason: 'fixture' }],
      openPosition: null, artifacts: artifacts.map(({ artifactId, kind }) => ({ artifactId, kind })),
      warnings: ['Funding was not simulated'], engine: { id: engineId, version: 'fixture' }, dataDigest: digest,
      strategySha256: strategyHash, biasChecks,
      pack: {
        schema: 'gitrader-experiment/1', kind: 'backtest',
        tier: 'hypothetical', spec: runSpec, specDigest, window: { from: runSpec.from, to: runSpec.to },
        seed: runSpec.seed, subjectKey: strategyHash, assumptions: effective,
        data: { source, pointInTime: true, candlesDigests: [{ instrumentId: BTC, digest }], candlesDigestMethod: 'gitrader-candles/1', timezone: 'UTC', alignment: 'open-time' },
        instrumentMeta: instrumentMeta ?? h.sim.listInstruments().filter((item) => item.instrumentId === BTC), stats, biasChecks, artifacts,
        llm: { involved: false, derivedFrom: 'declared', models: [], contaminated: 'no', leakFreeFrom: null },
      },
    }
  }
  const lab = new LabService(h.k, raw)
  Object.defineProperty(h.k, 'lab', { configurable: true, value: lab })
  vi.spyOn(h.k.gep, 'status').mockReturnValue([{ engineId, state: 'ready', sessionId: 'fixture-session', bound: false, accounts: [], lost: false, placeCalls: 0, proposalCalls: 0 }])
  vi.spyOn(h.k.gep, 'callEngine').mockImplementation((id, method, params) => raw(id, method, params))
  const exp = await create(h, actor, { subject: { strategy: { kind: 'strategy', id: 'strategy-fixture', version: '1' }, params: {} }, assumptions }, engineId)
  const root = join(h.home, 'lab', 'artifacts', engineId)
  mkdirSync(root, { recursive: true })
  artifacts = (['trades', 'equity'] as const).map((kind) => {
    const bytes = Buffer.from(`contract-${kind}`)
    writeFileSync(join(root, `${kind}.bin`), bytes)
    const stored = lab.artifacts.put(engineId, { path: `${kind}.bin`, sha256: sha256Digest(bytes), sizeBytes: bytes.length, mediaType: 'application/octet-stream', kind })
    return { ...stored, sha256: sha256Digest(bytes), sizeBytes: bytes.length, mediaType: 'application/octet-stream', kind }
  })
  const run = async (patch: Partial<BacktestSpec> = {}, method = 'backtest.run') => {
    const started = await lab.forward(engineId, method, { experimentId: exp.experimentId, spec: { ...spec, ...patch } }, actor) as { runId: string; jobId: string }
    if (method === 'backtest.run') await lab.forward(engineId, 'backtest.result', { jobId: started.jobId }, actor)
    return started
  }
  const pack = (runId: string, window = { from: 10, to: 20 }) => lab.runTable.pack(exp.experimentId, { runId }, window, actor)
  return { h, lab, raw, actor, exp, engineId, spec, run, pack }
}

async function attachAgent(h: Harness) {
  const agent = await makeAgent(h, 'paper')
  const actor = agent.ctx('experiment')
  const exp = await create(h, actor)
  const attached = await h.k.lab.handle('attach', { experimentId: exp.experimentId, attach: { run: { executor: { kind: 'agent', mandateId: agent.mandate.mandateId }, accountId: h.paper.accountId } } }, actor) as typeof exp
  return { agent, actor, exp: attached }
}

function recordFill(h: Harness, actor: ActorCtx, at: number, recordedAt: number, attestation: 'kernel-observed' | 'user-asserted' = 'kernel-observed') {
  h.clock.set(recordedAt)
  const orderId = newId('ord', at)
  const precheckId = newId('pck', at)
  const clientOrderId = newClientOrderId()
  const mandateId = actor.principal.kind === 'agent' ? actor.principal.mandateId : undefined
  h.k.orders.upsert({ orderId, clientOrderId, accountId: h.paper.accountId, instrumentId: BTC, side: 'buy', type: 'market', tif: 'ioc', size: '1', filledSize: '1', status: 'filled', fee: '0', origin: actor.origin, createdAt: at, updatedAt: at, mandateId } as never, '100', true)
  h.k.ledger.append({ type: 'order.intent', origin: actor.origin, ts: at, subject: { orgId: 'org_local', accountId: h.paper.accountId, instrumentId: BTC, orderId, precheckId, ...(mandateId ? { mandateId: mandateId as never } : {}) }, payload: { intent: { clientOrderId } }, precheck: { precheckId, verdict: 'allow', policyVersion: h.k.risk.current()!.version, estimates: {} }, attestation: 'kernel-observed' })
  h.k.ledger.append({ type: 'fill', origin: actor.origin, ts: at, subject: { orgId: 'org_local', accountId: h.paper.accountId, instrumentId: BTC, orderId, fillId: newId('fill', at) }, payload: { venueTs: at, size: '1', side: 'buy', fee: '0', feeCcy: h.paper.paper!.ccy, realizedPnl: '7' }, attestation })
}

describe('experiment service', () => {
  it('creates at hypothesis regardless of supplied live stage; rejects readonly roots and preserves versioned append-only notes', async () => {
    const h = await setup()
    const actor = h.human('experiment')
    const exp = await create(h, actor, { stage: 'live' })
    expect(exp.stage).toBe('hypothesis')
    await expect(h.k.lab.handle('update', { experimentId: exp.experimentId, patch: { metrics: { paper: { netPnl: '1' } } } }, actor))
      .rejects.toMatchObject({ problem: { name: 'EXPERIMENT_FIELD_READONLY' } })
    const next = await h.k.lab.handle('update', { experimentId: exp.experimentId, patch: { title: 'Updated', notes: [{ text: 'First observation' }] } }, actor) as typeof exp
    expect(next.version).toBe(2)
    expect(next.notes).toHaveLength(1)
    expect(next.notes?.[0]).toMatchObject({ text: 'First observation', origin: actor.origin })
    const versions = h.k.docs.versions<typeof exp>('experiment', exp.experimentId)
    expect(versions.map((item) => item.version)).toEqual([1, 2])
    await expect(h.k.lab.handle('update', { experimentId: exp.experimentId, patch: { notes: [] } }, actor))
      .rejects.toMatchObject({ problem: { name: 'EXPERIMENT_APPEND_ONLY' } })
  })

  it('requires the authenticated agent mandate on attach and stamps effective time plus a start snapshot', async () => {
    const h = await setup()
    const agent = await makeAgent(h, 'paper')
    const actor = agent.ctx('experiment')
    const exp = await create(h, actor)
    const other = await makeAgent(h, 'paper')
    const attach = { run: { executor: { kind: 'agent', mandateId: agent.mandate.mandateId }, accountId: h.paper.accountId, from: 1, stage: 'live', to: 2 } }
    await expect(h.k.lab.handle('attach', { experimentId: exp.experimentId, attach: { run: { ...attach.run, executor: { kind: 'agent', mandateId: other.mandate.mandateId } } } }, actor))
      .rejects.toMatchObject({ problem: { code: 1016, message: 'Agent executor must match the authenticated key' } })
    const attached = await h.k.lab.handle('attach', { experimentId: exp.experimentId, attach }, actor) as typeof exp
    expect(attached.runs).toHaveLength(1)
    expect(attached.runs?.[0]).toMatchObject({ stage: 'hypothesis', from: h.clock.now(), to: null, attachedAt: h.clock.now(), executor: { kind: 'agent', mandateId: agent.mandate.mandateId } })
    const entries = Array.from(h.k.ledger.iterate())
    expect(entries.some((entry) => entry.type === 'annotation' && entry.payload?.warning === 'Caller-supplied run.from was ignored')).toBe(true)
    expect(h.k.docs.get('lab-start', attached.runs![0]!.runId!)).toMatchObject({ runId: attached.runs![0]!.runId, at: h.clock.now(), equity: '10000' })
  })

  it('rejects invalid transitions and records MCP live promotion requests without granting them', async () => {
    const h = await setup()
    const agent = await makeAgent(h, 'paper')
    const actor = agent.ctx('experiment')
    const exp = await create(h, actor)
    const before = h.k.ledger.head().seq
    await expect(h.k.lab.stage(exp.experimentId, 'live_small', actor)).rejects.toMatchObject({ problem: { name: 'EXPERIMENT_TRANSITION_DENIED' } })
    const entries = Array.from(h.k.ledger.iterate()).filter((entry) => entry.seq > before)
    expect(entries.some((entry) => entry.type === 'annotation' && entry.payload?.kind === 'experiment_promotion_request')).toBe(true)
    expect(entries.some((entry) => entry.type === 'experiment.stage_changed')).toBe(false)
  })

  it('exports and verifies an empty-run experiment, then identifies a changed version path', async () => {
    const h = await setup()
    const exp = await create(h)
    const bundle = await h.k.lab.export(exp.experimentId)
    expect(await h.k.lab.verify(bundle)).toEqual({ status: 'identical', differences: [] })
    const changed = structuredClone(bundle) as { experiment: { version: number } }
    changed.experiment.version += 1
    const result = await h.k.lab.verify(changed)
    expect(result.status).toBe('diff')
    expect(result.differences).toContain('experiment')
  })

  it('routes host.artifact.put through the real handler and checks copied bytes, digest, and source containment', async () => {
    const h = await setup()
    const engineId = 'fake-engine'
    const sourceRoot = join(h.home, 'lab', 'artifacts', engineId)
    mkdirSync(sourceRoot, { recursive: true })
    const source = Buffer.from('generated-artifact-fixture')
    writeFileSync(join(sourceRoot, 'trades.bin'), source)
    writeFileSync(join(sourceRoot, '..', 'outside.bin'), source)
    const callHost = (params: Record<string, unknown>) => (h.k.gep as unknown as {
      hostMethod(conn: { engineId: string }, method: string, input: unknown): Promise<unknown>
    }).hostMethod({ engineId }, 'host.artifact.put', params)
    const stored = await callHost({ path: 'trades.bin', sha256: sha256Digest(source), sizeBytes: source.byteLength, mediaType: 'application/octet-stream', kind: 'trades' }) as { artifactId: string }
    expect(h.k.lab.artifacts.read(stored.artifactId)).toEqual(source)
    await expect(callHost({ path: 'trades.bin', sha256: sha256Digest(Buffer.from('tampered')), sizeBytes: source.byteLength, mediaType: 'application/octet-stream', kind: 'trades' }))
      .rejects.toMatchObject({ problem: { name: 'EXPERIMENT_EVIDENCE_INCOMPLETE' } })
    await expect(callHost({ path: '../outside.bin', sha256: sha256Digest(source), sizeBytes: source.byteLength, mediaType: 'application/octet-stream', kind: 'trades' }))
      .rejects.toMatchObject({ problem: { name: 'INVALID_PARAMS' } })
  })

  it('retains a failed backtest row after the local engine call fails', async () => {
    const h = await setup()
    const lab = new LabService(h.k, async (_engineId, method) => {
      if (method === 'replay.start') return { replayId: 'replay-local' }
      throw new Error('local engine fixture failure')
    })
    Object.defineProperty(h.k, 'lab', { configurable: true, value: lab })
    const actor = h.human('experiment')
    const exp = await create(h, actor)
    const spec = {
      subject: { strategy: { id: 'strategy-fixture', version: '1', params: {} } }, instruments: [BTC], interval: '1h', from: 1, to: 3,
      data: { source: 'engine' }, account: { initialBalance: '10000', ccy: 'USD', leverage: 1 },
      assumptions: { fees: 'venue', slippageBps: 0, fillModel: 'next-bar-open', funding: false, liquidation: false }, seed: 1,
    }
    expect(validateBacktestSpec(spec).ok).toBe(true)
    await expect(lab.forward('fake-engine', 'backtest.run', { experimentId: exp.experimentId, spec }, actor)).rejects.toThrow()
    const rows = lab.runTable.all()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ experimentId: exp.experimentId, kind: 'backtest', status: 'failed' })
    await lab.forward('fake-engine', 'replay.start', { experimentId: exp.experimentId, spec }, actor)
    expect(lab.runTable.all()).toHaveLength(2)
    expect(lab.runTable.all().some((row) => row.kind === 'replay' && row.status === 'running')).toBe(true)
  })

  it('links only the selected completed run while its pack retains all local completed trial statistics', async () => {
    const h = await setup()
    const engineId = 'fake-engine'
    const strategyHash = `sha256:${'a'.repeat(64)}`
    const assumptions = { fees: 'venue', slippageBps: 0, fillModel: 'next-bar-open', funding: false, liquidation: false }
    const effectiveAssumptions = {
      ...assumptions,
      fees: { maker: '0.00015', taker: '0.00045' },
      latencyMs: 0,
      liquidationPenaltyRatio: 0,
      'x-intraBar': 'not modelled: signal at bar close, fill at next bar open',
      'x-feesApplied': 'taker fee on every fill (all simulated orders are market orders)',
      'x-maintenanceMarginRatio': 0.5,
    }
    const specs = new Map<string, any>() // eslint-disable-line @typescript-eslint/no-explicit-any
    let jobN = 0
    let sharpe = 0
    let artifactRefs: Record<string, unknown>[] = []
    const lab = new LabService(h.k, async (_engine, method, params) => {
      if (method === 'strategy.list') return { strategies: [] }
      if (method === 'replay.start') return { replayId: `replay-${jobN}` }
      if (method === 'backtest.run') {
        const jobId = `job-${++jobN}`
        specs.set(jobId, params.spec)
        return { jobId }
      }
      if (method === 'backtest.result') {
        const spec = specs.get(params.jobId)
        const specDigest = digestOf(spec)
        const stats = { totalReturnRatio: 0.01, annualizedRatio: 0.02, maxDrawdownRatio: 0, sharpe: ++sharpe, sortino: 0, winRatio: 0.5, profitFactor: 1, trades: 10, fills: 10, avgHoldBars: 1, spanDays: 30, finalEquity: 10100 }
        const candleDigest = `sha256:${'b'.repeat(64)}`
        const draft = {
          schema: 'gitrader-experiment/1', kind: spec.from === 1_000 && spec.to === 2_000 ? 'holdout' : 'backtest', tier: 'hypothetical', spec, specDigest,
          window: { from: spec.from, to: spec.to }, seed: spec.seed, subjectKey: strategyHash,
          assumptions: effectiveAssumptions, data: { source: 'engine', pointInTime: true, candlesDigests: [{ instrumentId: BTC, digest: candleDigest }], candlesDigest: spec.seed === 99 ? `sha256:${'c'.repeat(64)}` : candleDigest, candlesDigestMethod: 'gitrader-candles/1', timezone: 'UTC', alignment: 'open-time' },
          instrumentMeta: h.sim.listInstruments().filter((item) => item.instrumentId === BTC), stats,
          biasChecks: { lookahead: 'pass', recursive: 'pass' }, artifacts: artifactRefs,
          llm: { involved: false, derivedFrom: 'declared', models: [], contaminated: 'no', leakFreeFrom: null },
        }
        return { jobId: params.jobId, specDigest, assumptions: effectiveAssumptions, stats, equity: [], trades: [], openPosition: null, artifacts: artifactRefs.map((item) => ({ artifactId: item.artifactId, kind: item.kind })), warnings: [], engine: { id: engineId, version: 'fixture' }, dataDigest: candleDigest, pack: draft, strategySha256: strategyHash }
      }
      throw new Error('unexpected local engine fixture call')
    })
    Object.defineProperty(h.k, 'lab', { configurable: true, value: lab })
    const actor = h.human('experiment')
    vi.spyOn(h.k.gep, 'status').mockReturnValue([{ engineId, state: 'ready', sessionId: 'fixture-session', bound: false, accounts: [], lost: false, placeCalls: 0, proposalCalls: 0 }])
    vi.spyOn(h.k.gep, 'callEngine').mockResolvedValue({ strategies: [{ id: 'strategy-fixture', version: '1', sha256: strategyHash }] })
    const exp = await create(h, actor, {
      subject: { strategy: { kind: 'strategy', id: 'strategy-fixture', version: '1' }, params: {} }, assumptions,
    }, engineId)
    expect(exp.subjectKey).toBe(strategyHash)
    await lab.stage(exp.experimentId, 'backtest', actor)
    const sourceRoot = join(h.home, 'lab', 'artifacts', engineId)
    mkdirSync(sourceRoot, { recursive: true })
    artifactRefs = (['trades', 'equity'] as const).map((kind) => {
      const bytes = Buffer.from(`fixture-${kind}`)
      writeFileSync(join(sourceRoot, `${kind}.bin`), bytes)
      const stored = lab.artifacts.put(engineId, { path: `${kind}.bin`, sha256: sha256Digest(bytes), sizeBytes: bytes.length, mediaType: 'application/octet-stream', kind })
      return { artifactId: stored.artifactId, sha256: sha256Digest(bytes), sizeBytes: bytes.length, mediaType: 'application/octet-stream', kind }
    })
    const runs: { runId: string; sharpe: number }[] = []
    for (const seed of [1, 1, 2]) {
      const spec = {
        subject: { strategy: { id: 'strategy-fixture', version: '1', params: {} } }, instruments: [BTC], interval: '1h', from: 0, to: 1_000,
        data: { source: 'engine' }, account: { initialBalance: '10000', ccy: 'USD', leverage: 1 }, assumptions, seed,
      }
      const started = await lab.forward(engineId, 'backtest.run', { experimentId: exp.experimentId, spec }, actor) as { jobId: string; runId: string }
      await lab.forward(engineId, 'backtest.result', { jobId: started.jobId }, actor)
      runs.push({ runId: started.runId, sharpe })
    }
    const replay = await lab.forward(engineId, 'replay.start', { experimentId: exp.experimentId, spec: {
      subject: { strategy: { id: 'strategy-fixture', version: '1', params: {} } }, instruments: [BTC], interval: '1h', from: 0, to: 1_000,
      data: { source: 'engine' }, account: { initialBalance: '10000', ccy: 'USD', leverage: 1 }, assumptions, seed: 1,
    } }, actor) as { runId: string }
    const bestRun = runs.reduce((best, candidate) => candidate.sharpe > best.sharpe ? candidate : best)
    const packed = await lab.runTable.pack(exp.experimentId, { runId: bestRun.runId }, { from: 1_000, to: 2_000 }, actor)
    const linked = lab.runTable.packs(packed).filter((item) => item.kind !== 'forward')
    expect(linked).toHaveLength(1)
    expect(linked[0]).toMatchObject({ runId: bestRun.runId, trialCount: 3 })
    expect(linked[0]?.trialStats).toHaveLength(3)
    expect(new Set(linked[0]?.trialStats.map((item) => item.specDigest)).size).toBe(2)
    expect(linked[0]?.trialStats.some((item) => item.runId === replay.runId)).toBe(false)
    await expect(lab.handle('update', { experimentId: exp.experimentId, patch: { hypothesis: 'Changed after first pack' } }, actor))
      .rejects.toMatchObject({ problem: { name: 'EXPERIMENT_FIELD_FROZEN' } })
    await expect(lab.stage(exp.experimentId, 'holdout', actor)).rejects.toMatchObject({ problem: { code: 1013 } })

    const baseSpec = {
      subject: { strategy: { id: 'strategy-fixture', version: '1', params: {} } }, instruments: [BTC], interval: '1h', from: 0, to: 1_000,
      data: { source: 'engine' }, account: { initialBalance: '10000', ccy: 'USD', leverage: 1 }, assumptions, seed: 1,
    }
    const adjacent = await lab.forward(engineId, 'backtest.run', { spec: { ...baseSpec, from: 2_000, to: 3_000, seed: 3 } }, actor) as { runId: string }
    expect(lab.load(exp.experimentId).holdoutRunId).toBeNull()
    const firstTouch = await lab.forward(engineId, 'backtest.run', { spec: { ...baseSpec, from: 1_000, to: 2_000, seed: 2 } }, actor) as { jobId: string; runId: string }
    expect(lab.load(exp.experimentId).holdoutRunId).toBe(firstTouch.runId)
    await lab.forward(engineId, 'backtest.result', { jobId: firstTouch.jobId }, actor)
    const withHoldout = await lab.runTable.pack(exp.experimentId, { runId: firstTouch.runId }, { from: 1_000, to: 2_000 }, actor)
    expect(lab.runTable.packs(withHoldout).some((item) => item.kind === 'holdout' && item.runId === firstTouch.runId)).toBe(true)
    const exportBundle = await lab.export(exp.experimentId)
    expect(await lab.verify(exportBundle)).toEqual({ status: 'identical', differences: [] })
    const contradictory = await lab.forward(engineId, 'backtest.run', { experimentId: exp.experimentId, spec: { ...baseSpec, seed: 99 } }, actor) as { jobId: string; runId: string }
    await lab.forward(engineId, 'backtest.result', { jobId: contradictory.jobId }, actor)
    await expect(lab.runTable.pack(exp.experimentId, { runId: contradictory.runId }, { from: 3_000, to: 4_000 }, actor))
      .rejects.toMatchObject({ problem: { code: 1013 } })
    const secondTouch = await lab.forward(engineId, 'backtest.run', { spec: { ...baseSpec, from: 1_000, to: 2_000, seed: 2 } }, actor) as { jobId: string; runId: string }
    await lab.forward(engineId, 'backtest.result', { jobId: secondTouch.jobId }, actor)
    await expect(lab.runTable.pack(exp.experimentId, { runId: secondTouch.runId }, { from: 1_000, to: 2_000 }, actor))
      .rejects.toMatchObject({ problem: { code: 1013 } })
    expect(lab.load(exp.experimentId).holdoutRunId).toBe(firstTouch.runId)
    expect(adjacent.runId).not.toBe(firstTouch.runId)
  })

  it('marks Agent-created LLM involvement and rejects caller-supplied model provenance on edits', async () => {
    const h = await setup()
    const agent = await makeAgent(h, 'paper')
    const actor = agent.ctx('experiment')
    const exp = await create(h, actor, { llm: { involved: true, models: [{ id: 'unlisted-model' }] } })
    expect(exp.llm).toMatchObject({ involved: true, models: [{ id: 'unlisted-model', source: 'declared' }] })
    await expect(h.k.lab.handle('update', { experimentId: exp.experimentId, patch: { llm: { involved: true, models: [{ id: 'unlisted-model', source: 'declared' }] } } }, actor))
      .rejects.toMatchObject({ problem: { name: 'EXPERIMENT_FIELD_READONLY' } })
  })

  it('writes at most one UTC daily snapshot per tick day and does not backfill missed days', async () => {
    const h = await setup()
    const day = 86_400_000
    const t0 = Math.ceil(h.clock.now() / day) * day
    h.clock.set(t0)
    const agent = await makeAgent(h, 'paper')
    const actor = agent.ctx('experiment')
    const exp = await create(h, actor)
    await h.k.lab.handle('attach', { experimentId: exp.experimentId, attach: { run: { executor: { kind: 'agent', mandateId: agent.mandate.mandateId }, accountId: h.paper.accountId } } }, actor)
    h.clock.set(t0 + 3 * day)
    await h.k.lab.forwardStats.tick()
    await h.k.lab.forwardStats.tick()
    h.clock.set(t0 + 4 * day + 3_000)
    await h.k.lab.forwardStats.tick()
    h.clock.set(t0 + 5 * day + 61_000)
    await h.k.lab.forwardStats.tick()
    h.clock.set(t0 + 6 * day)
    await h.k.lab.forwardStats.tick()
    const daily = Array.from(h.k.ledger.iterate()).filter((entry) => entry.type === 'position.snapshot' && entry.payload?.kind === 'daily')
    expect(daily.map((entry) => entry.ts)).toEqual([t0 + 3 * day, t0 + 4 * day, t0 + 6 * day])
    expect(daily[1]?.payload?.sampledAt).toBe(t0 + 4 * day + 3_000)
  })

  it('uses thirty days of persisted ledger fills and daily snapshots for human PIN promotion attestation', async () => {
    const h = await setup()
    const day = 86_400_000
    const t0 = Math.ceil(h.clock.now() / day) * day
    h.clock.set(t0)
    const agent = await makeAgent(h, 'paper', { notAfter: t0 + 40 * day })
    h.sim.equity = D('10000')
    const actor = agent.ctx('experiment')
    const exp = await create(h, actor)
    const attached = await h.k.lab.handle('attach', { experimentId: exp.experimentId, attach: { run: { executor: { kind: 'agent', mandateId: agent.mandate.mandateId }, accountId: h.paper.accountId, from: 0, stage: 'live' } } }, actor) as typeof exp
    await h.k.lab.stage(exp.experimentId, 'shadow', h.human('experiment'))
    const accountId = h.paper.accountId
    const ccy = h.paper.paper!.ccy
    for (let j = 0; j < 30; j++) {
      for (const [offset, side] of [[1000, 'buy'], [2000, 'sell']] as const) {
        const ts = t0 + j * day + offset
        h.clock.set(ts)
        const origin = agent.ctx('order').origin
        const orderId = newId('ord', ts)
        const precheckId = newId('pck', ts)
        const clientOrderId = newClientOrderId()
        h.k.orders.upsert({ orderId, clientOrderId, accountId, instrumentId: BTC, side, type: 'market', tif: 'ioc', size: '1' as never, filledSize: '1' as never, status: 'filled', fee: '0' as never, origin, createdAt: ts, updatedAt: ts, mandateId: agent.mandate.mandateId } as never, '100', side === 'buy')
        h.k.ledger.append({ type: 'order.intent', origin, ts, subject: { orgId: 'org_local', accountId, instrumentId: BTC, orderId, precheckId, mandateId: agent.mandate.mandateId }, payload: { intent: { clientOrderId } }, precheck: { precheckId, verdict: 'allow', policyVersion: h.k.risk.current()!.version, estimates: {} }, attestation: 'kernel-observed' })
        h.k.ledger.append({ type: 'fill', origin, ts, subject: { orgId: 'org_local', accountId, instrumentId: BTC, orderId, fillId: newId('fill', ts) }, payload: { venueTs: ts, size: '1', side, fee: '0', feeCcy: ccy, realizedPnl: side === 'buy' ? '0' : '10' }, attestation: 'kernel-observed' })
      }
      const boundary = t0 + (j + 1) * day
      h.clock.set(boundary)
      h.sim.equity = D(String(10000 + 10 * (j + 1)))
      await h.k.lab.forwardStats.tick()
    }
    h.clock.set(t0 + 30 * day)
    const before = h.k.lab.load(exp.experimentId)
    const computed = await h.k.lab.forwardStats.compute(before, h.clock.now(), true)
    expect(computed.stats.sample).toMatchObject({ spanDays: 30, roundTrips: 30, activeDays: 30, snapshotDays: 30 })
    expect(computed.stats.realizedPnl).toBe('300')
    expect(computed.stats.fees).toBe('0')
    const requestAt = h.clock.now()
    const originalSnapshot = h.k.bus.snapshot.bind(h.k.bus)
    vi.spyOn(h.k.bus, 'snapshot').mockImplementation(async (...args) => {
      const observed = await originalSnapshot(...args)
      h.clock.set(h.clock.now() + 1)
      return observed
    })
    const proof = await h.pinProof()
    const promoted = await h.k.lab.stage(exp.experimentId, 'live_small', h.human('experiment'), proof)
    const forwardRef = promoted.packs?.find((pack) => pack.kind === 'forward')
    const forwardPack = h.k.lab.runTable.packs(promoted).find((pack) => pack.kind === 'forward')
    const stageEvent = Array.from(h.k.ledger.iterate()).reverse().find((entry) => entry.type === 'experiment.stage_changed' && entry.subject.experimentId === exp.experimentId)
    const stageSnapshot = Array.from(h.k.ledger.iterate()).reverse().find((entry) => entry.type === 'position.snapshot' && entry.subject.experimentId === exp.experimentId && entry.payload?.kind === 'stage')
    expect(promoted.stage).toBe('live_small')
    expect(promoted.stageEnteredAt).toBeGreaterThan(requestAt)
    expect(stageSnapshot?.recordedAt).toBeGreaterThan(requestAt)
    expect(forwardPack?.window.to).toBe(promoted.stageEnteredAt)
    expect(forwardPack?.forward.computedAt).toBe(promoted.stageEnteredAt)
    expect(forwardRef?.digest).toBe(forwardPack?.attestation.digest)
    expect((stageEvent?.payload?.attestation as { payload: { forwardPackDigest: string } } | undefined)?.payload.forwardPackDigest).toBe(forwardPack?.attestation.digest)
    expect(promoted.runs).toEqual(attached.runs)
    const promotedBundle = await h.k.lab.export(exp.experimentId)
    expect(await h.k.lab.verify(promotedBundle)).toEqual({ status: 'identical', differences: [] })
    const review = await h.k.lab.stage(exp.experimentId, 'review', h.human('experiment'))
    expect(review.reviewFrom).toBe('live_small')
    const returned = await h.k.lab.stage(exp.experimentId, 'shadow', h.human('experiment'))
    expect(returned.stage).toBe('shadow')
    expect(returned.reviewFrom).toBe('live_small')
    const returnedBundle = await h.k.lab.export(exp.experimentId)
    expect(await h.k.lab.verify(returnedBundle)).toEqual({ status: 'identical', differences: [] })
    await expect(h.k.lab.stage(exp.experimentId, 'live_small', h.human('experiment'), await h.pinProof()))
      .rejects.toMatchObject({ problem: { code: 1013, message: expect.stringContaining('forward.spanDays') } })
  })
})

async function attachEngine(h: Harness, experimentId: string, engineId: string) {
  const mandate = h.k.agents.issueMandate({ subject: { type: 'engine', id: engineId }, level: 'L1', accounts: [h.paper.accountId] }, await h.pinProof(), h.human().origin)
  h.k.docs.put('enginebind', engineId, { accounts: [{ accountId: h.paper.accountId, mandateId: mandate.mandateId }] })
  return h.k.lab.handle('attach', { experimentId, attach: { run: { executor: { kind: 'engine', engineId, instanceId: 'inst_fixture', codeDigest: null }, accountId: h.paper.accountId } } }, h.human())
}

const kernelCases = loadExperimentCases().filter((fixture) => fixture.kind === 'kernel-contract')
describe('kernel contract fixture driver', () => {
  it('covers the five specified kernel contracts', () => {
    expect(kernelCases.map(({ id }) => id)).toEqual(['21-frozen-fields', '22-trial-count', '23-holdout-window-overlap', '24-llm-attribution', '33-lifecycle-export'])
  })
  for (const fixture of kernelCases) {
    describe(fixture.id, () => {
      for (const step of fixture.steps) {
        it(step.operation, async () => {
          const h = await setup()
          const given = step.given as Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
          const expected = step.expect
          switch (fixture.rule) {
            case 'frozen': {
              const f = await backtestFixture(h)
              await f.pack((await f.run()).runId)
              await expect(f.lab.handle('update', { experimentId: f.exp.experimentId, patch: given.patch }, f.actor))
                .rejects.toMatchObject({ problem: { code: expected.code } })
              break
            }
            case 'trial-count': {
              const f = await backtestFixture(h)
              if (step.operation === 'executor minimum') {
                for (let i = 0; i < given.completedBacktestsInWindow; i++) await f.run()
                expect(f.lab.runTable.trials(f.lab.load(f.exp.experimentId)).trialCount).toBe(expected.minimumTrials)
                expect(given.windowDays).toBe(expected.windowDays)
              } else {
                for (let seed = 1; seed <= given.priorCount; seed++) await f.run({ seed })
                h.clock.set(h.clock.now() + 31 * 86_400_000)
                const next = await f.run({ seed: step.operation === 'new spec' ? 3 : 1 }, given.replay ? 'replay.start' : 'backtest.run')
                expect(f.lab.runTable.trials(f.lab.load(f.exp.experimentId)).trialCount).toBe(expected.trialCount)
                if (expected.recorded) expect(f.lab.runTable.all().find((row) => row.runId === next.runId)?.kind).toBe('replay')
              }
              break
            }
            case 'holdout': {
              const f = await backtestFixture(h)
              if (given.previous) {
                const run = await f.run(given.previous)
                const result = f.pack(run.runId, given.next)
                if (expected.allowed) await expect(result).resolves.toMatchObject({ frozen: { holdout: true }, holdoutWindow: given.next })
                else await expect(result).rejects.toMatchObject({ problem: { code: 1013 } })
              } else {
                await f.pack((await f.run()).runId)
                const first = await f.run({ from: 10, to: 20 })
                const selected = given.priorRun ? await f.run({ from: 10, to: 20 }) : first
                const result = f.pack(selected.runId)
                if (expected.allowed) await expect(result).resolves.toMatchObject({ holdoutRunId: first.runId })
                else await expect(result).rejects.toMatchObject({ problem: { code: 1013 } })
              }
              break
            }
            case 'llm-attribution': {
              if (step.operation === 'derived llm edit') {
                const { actor, exp } = await attachAgent(h)
                await expect(h.k.lab.handle('update', { experimentId: exp.experimentId, patch: { llm: { involved: given.involved } } }, actor))
                  .rejects.toMatchObject({ problem: { code: 1011 } })
                expect(h.k.lab.load(exp.experimentId).llm?.involved).toBe(expected.involved)
              } else if (step.operation === 'unknown cutoff') {
                const agent = await makeAgent(h, 'paper')
                const f = await backtestFixture(h, agent.ctx('experiment'))
                const packed = await f.pack((await f.run()).runId)
                const pack = f.lab.runTable.packs(packed)[0]
                expect(pack?.kind === 'backtest' && pack.llm.contaminated).toBe(expected.state)
              } else if (step.operation === 'unfamiliar mandate') {
                const { actor, exp } = await attachAgent(h)
                const other = await makeAgent(h, 'paper')
                await expect(h.k.lab.handle('attach', { experimentId: exp.experimentId, attach: { run: { accountId: h.paper.accountId, executor: { kind: 'agent', mandateId: other.mandate.mandateId } } } }, actor))
                  .rejects.toMatchObject({ problem: { code: expected.code, message: 'Agent executor must match the authenticated key' } })
              } else if (step.operation === 'caller from ignored') {
                const agent = await makeAgent(h, 'paper')
                const actor = agent.ctx('experiment')
                const exp = await create(h, actor)
                const base = h.clock.now()
                h.clock.set(base + given.attachedAt)
                const result = await h.k.lab.handle('attach', { experimentId: exp.experimentId, attach: { run: { from: base + given.from, accountId: h.paper.accountId, executor: { kind: 'agent', mandateId: agent.mandate.mandateId } } } }, actor) as typeof exp
                expect(result.runs[0].from - base).toBe(expected.effectiveFrom)
              } else if (step.operation === 'different origin fill') {
                const f = await backtestFixture(h)
                await attachEngine(h, f.exp.experimentId, f.engineId)
                const other = await makeAgent(h, 'paper')
                const at = h.clock.now() + 1
                recordFill(h, other.ctx('order'), at, at)
                h.clock.set(at + 1)
                const computed = await f.lab.forwardStats.compute(f.lab.load(f.exp.experimentId), h.clock.now(), false)
                expect(computed.stats.sample.fills > 0).toBe(expected.counted)
                expect(computed.stats.realizedPnl).toBe('0')
              } else if (step.operation === 'parallel disclosure') {
                const parent = await create(h)
                const exp = await create(h, h.human(), { lineage: { parentExperimentId: parent.experimentId } })
                const parallel = h.k.lab.stages.parallel(exp)
                expect(parallel).toHaveLength(given.parallelExperiments)
                expect([parent.experimentId, exp.experimentId].every((id) => parallel.some((item) => item.experimentId === id))).toBe(expected.allDisclosed)
              } else throw new Error(`Unmapped fixture step: ${step.operation}`)
              break
            }
            case 'lifecycle': {
              if (step.operation === 'create ignores live stage') {
                expect((await create(h, h.human(), given.patch)).stage).toBe(expected.stage)
              } else if (step.operation === 'foreign owner update') {
                const exp = await create(h)
                const agent = await makeAgent(h, 'paper')
                const actor: ActorCtx = { principal: { kind: 'engine', engineId: 'foreign-engine', mandateId: agent.mandate.mandateId }, origin: { ...h.human().origin, actor: 'engine:foreign-engine', actorType: 'engine', via: 'gep' } }
                await expect(h.k.lab.handle('update', { experimentId: exp.experimentId, patch: { title: 'changed' } }, actor))
                  .rejects.toMatchObject({ problem: { code: expected.code } })
              } else if (step.operation === 'late recorded fill') {
                const { actor, exp } = await attachAgent(h)
                const attachedAt = exp.runs[0].attachedAt
                recordFill(h, actor, attachedAt + 1, attachedAt + given.recordedAt - given.attachedAt)
                h.clock.set(attachedAt + 2)
                const computed = await h.k.lab.forwardStats.compute(exp, h.clock.now(), false)
                expect(computed.stats.realizedPnl).toBe(expected.pnl)
                expect(computed.stats.sample).toMatchObject({ activeDays: expected.activeDays, fills: expected.fills })
              } else if (step.operation === 'export verify') {
                const f = await backtestFixture(h)
                await f.pack((await f.run()).runId)
                const bundle = await f.lab.export(f.exp.experimentId)
                expect((await f.lab.verify(bundle)).status).toBe(expected.verify)
              } else throw new Error(`Unmapped fixture step: ${step.operation}`)
              break
            }
            default: throw new Error(`Unmapped fixture rule: ${fixture.rule}`)
          }
        })
      }
    })
  }
})

describe('lab repair regressions', () => {
  it.each([['frozen', 1012], ['biasChecks', 1011]] as const)('rejects update %s with its explicit protocol code', async (field, code) => {
    const h = await setup()
    const exp = await create(h)
    await expect(h.k.lab.handle('update', { experimentId: exp.experimentId, patch: { [field]: {} } }, h.human())).rejects.toMatchObject({ problem: { code } })
  })

  it('records malformed specs as failed without touching holdout or invoking the engine', async () => {
    const h = await setup()
    const f = await backtestFixture(h)
    await f.pack((await f.run()).runId)
    const calls: string[] = []
    const lab = new LabService(h.k, async (_engine, method) => { calls.push(method); throw new Error('Malformed specs must not be forwarded') })
    const malformed: Record<string, unknown> = { ...f.spec, from: 10, to: 20 }
    delete malformed.subject
    await expect(lab.forward(f.engineId, 'backtest.run', { experimentId: f.exp.experimentId, spec: malformed }))
      .rejects.toMatchObject({ problem: { code: -32602, name: 'INVALID_PARAMS' } })
    const failed = lab.runTable.all().find((row) => row.status === 'failed')!
    expect(failed).toMatchObject({ experimentId: f.exp.experimentId, status: 'failed' })
    expect(h.k.docs.get('lab-run-detail', failed.runId)).toMatchObject({ error: { code: -32602, digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/) } })
    expect(lab.load(f.exp.experimentId).holdoutRunId).toBeNull()
    expect(calls).toEqual([])
  })

  it('returns the full result twice and observes through the persisted job index after restart', async () => {
    const h = await setup()
    const f = await backtestFixture(h)
    const started = await f.lab.forward(f.engineId, 'backtest.run', { spec: f.spec }, f.actor)
    h.k.docs.delete('lab-job-index', `${f.engineId}:${started.jobId}`)
    const restarted = new LabService(h.k, f.raw)
    vi.spyOn(restarted.runTable, 'all').mockImplementation(() => { throw new Error('Observation must not scan unrelated runs') })
    await expect(restarted.forward(f.engineId, 'backtest.status', { jobId: started.jobId }, f.actor)).resolves.toMatchObject({ state: 'done', runId: started.runId })
    const first = await restarted.forward(f.engineId, 'backtest.result', { jobId: started.jobId }, f.actor)
    expect(h.k.docs.get('lab-job-index', `${f.engineId}:${started.jobId}`)).toEqual({ runId: started.runId })
    const second = await restarted.forward(f.engineId, 'backtest.result', { jobId: started.jobId }, f.actor)
    expect(first).toMatchObject({ runId: started.runId, assumptions: { fees: { maker: '0.00015', taker: '0.00045' }, slippageBps: 3, fillModel: 'next-bar-open', funding: false, liquidation: false, latencyMs: 0, liquidationPenaltyRatio: 0 }, equity: [{ t: 0, v: 10000 }, { t: 10, v: 10100 }], trades: [{ reason: 'fixture' }], warnings: ['Funding was not simulated'], engine: { id: f.engineId }, pack: { kind: 'backtest' } })
    expect(second).toEqual(first)
  })

  it('persists the daily cursor across restarts and logs an elapsed sampling window', async () => {
    const h = await setup()
    const { exp } = await attachAgent(h)
    const day = 86_400_000
    const boundary = (Math.floor(h.clock.now() / day) + 1) * day
    h.clock.set(boundary + 3_000)
    const restarted = new LabService(h.k)
    await restarted.forwardStats.tick()
    await new LabService(h.k).forwardStats.tick()
    const snapshots = Array.from(h.k.ledger.iterate()).filter((entry) => entry.type === 'position.snapshot' && entry.payload?.kind === 'daily')
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]?.payload).toMatchObject({ at: boundary, sampledAt: boundary + 3_000 })
    expect(restarted.load(exp.experimentId).forward?.sample.snapshotDays).toBe(1)
    const log = vi.spyOn(h.k, 'log')
    h.clock.set(boundary + day + 61_000)
    await new LabService(h.k).forwardStats.tick()
    expect(log).toHaveBeenCalledWith('lab daily snapshot skipped: sampling window elapsed')
  })

  it('advances host-backed backtest through holdout to shadow using the recorded backtest entry time', async () => {
    const h = await setup()
    const f = await backtestFixture(h, h.human(), 'host')
    await h.k.marketStore.record(BTC, '1h', [{ t: 0, o: 100, h: 101, l: 99, c: 100, v: 1 }, { t: 10, o: 100, h: 102, l: 99, c: 101, v: 1 }])
    const enteredAt = h.clock.now()
    await f.lab.stage(f.exp.experimentId, 'backtest', f.actor)
    h.clock.set(enteredAt + 1)
    await f.pack((await f.run()).runId)
    h.clock.set(enteredAt + 2)
    await f.pack((await f.run({ from: 10, to: 20 })).runId)
    h.clock.set(enteredAt + 3)
    await f.lab.stage(f.exp.experimentId, 'holdout', f.actor)
    await attachEngine(h, f.exp.experimentId, f.engineId)
    h.clock.set(enteredAt + 4)
    const transition = vi.spyOn(protocol, 'checkTransition')
    const result = await f.lab.stage(f.exp.experimentId, 'shadow', f.actor)
    const history = Array.from(h.k.ledger.iterate()).find((entry) => entry.type === 'experiment.stage_changed' && entry.subject.experimentId === f.exp.experimentId && entry.payload?.to === 'backtest')
    expect(history?.ts).toBe(enteredAt)
    expect(transition.mock.calls.at(-1)?.[2].backtestEnteredAt).toBe(history?.ts)
    expect(result.stage).toBe('shadow')
    expect(f.lab.runTable.packs(result).every((pack) => pack.kind === 'forward' || pack.data.pointInTime === true)).toBe(true)
    expect(result.packs?.every((pack) => pack.at < enteredAt + 3)).toBe(true)
  })

  it('GQ-09c the kernel, not the engine draft, decides holdout kind', async () => {
    const h = await setup()
    const f = await backtestFixture(h, h.human(), 'host')
    await h.k.marketStore.record(BTC, '1h', [{ t: 0, o: 100, h: 101, l: 99, c: 100, v: 1 }, { t: 10, o: 100, h: 102, l: 99, c: 101, v: 1 }])
    await f.lab.stage(f.exp.experimentId, 'backtest', f.actor)
    await f.pack((await f.run()).runId)
    const touchRunId = (await f.run({ from: 10, to: 20 })).runId
    const packed = await f.pack(touchRunId, { from: 10, to: 20 })
    expect(f.lab.runTable.packs(packed).some((p) => p.kind === 'holdout' && p.runId === touchRunId)).toBe(true)
  })

  it('GQ-09c a second holdout-touching run still cannot produce a pack (反例)', async () => {
    const h = await setup()
    const f = await backtestFixture(h, h.human(), 'host')
    await h.k.marketStore.record(BTC, '1h', [{ t: 0, o: 100, h: 101, l: 99, c: 100, v: 1 }, { t: 10, o: 100, h: 102, l: 99, c: 101, v: 1 }])
    await f.lab.stage(f.exp.experimentId, 'backtest', f.actor)
    await f.pack((await f.run()).runId)
    const touchRunId = (await f.run({ from: 10, to: 20 })).runId
    await f.pack(touchRunId, { from: 10, to: 20 })
    const secondTouchRunId = (await f.run({ from: 10, to: 20 })).runId
    await expect(f.pack(secondTouchRunId, { from: 10, to: 20 })).rejects.toMatchObject({ problem: { code: 1013, message: expect.stringContaining('designated holdout pack') } })
  })

  it('GQ-09c an engine draft that claims kind=holdout for a normal run is ignored (反例)', async () => {
    const h = await setup()
    const f = await backtestFixture(h, h.human(), 'host')
    await h.k.marketStore.record(BTC, '1h', [{ t: 0, o: 100, h: 101, l: 99, c: 100, v: 1 }])
    await f.lab.stage(f.exp.experimentId, 'backtest', f.actor)
    await f.pack((await f.run()).runId)
    const normalRunId = (await f.run({ from: 0, to: 5 })).runId
    const packed = await f.pack(normalRunId)
    const pack = f.lab.runTable.packs(packed).find((p) => p.runId === normalRunId)
    expect(pack?.kind).toBe('backtest')
  })

  it('denies promotion when the human PIN proof is missing', async () => {
    const h = await setup()
    const { exp } = await attachAgent(h)
    await h.k.lab.stage(exp.experimentId, 'shadow', h.human())
    await expect(h.k.lab.stage(exp.experimentId, 'live_small', h.human())).rejects.toMatchObject({ problem: { name: 'AUTH_FAILED' } })
    expect(h.k.lab.load(exp.experimentId).stage).toBe('shadow')
  })

  it('denies promotion when the human PIN proof has expired', async () => {
    const h = await setup()
    const { exp } = await attachAgent(h)
    await h.k.lab.stage(exp.experimentId, 'shadow', h.human())
    const proof = await h.pinProof()
    h.clock.set(h.clock.now() + 60_001)
    await expect(h.k.lab.stage(exp.experimentId, 'live_small', h.human(), proof)).rejects.toMatchObject({ problem: { code: 1013 } })
    expect(h.k.lab.load(exp.experimentId).stage).toBe('shadow')
  })

  it('routes lab.stage through the human op PIN gate', async () => {
    const h = await setup()
    const exp = await create(h)
    await h.pinProof()
    const input = { principal: h.session, params: { experimentId: exp.experimentId, to: 'review' }, transport: 'ws' as const }
    await expect(h.k.ops.call(h.k, 'lab.stage', input)).rejects.toMatchObject({ problem: { name: 'ATTESTATION_REQUIRED' } })
    await expect(h.k.ops.call(h.k, 'lab.stage', { ...input, pin: TEST_PIN })).resolves.toMatchObject({ stage: 'review' })
  })

  it('GQ-09a packs a spec written exactly as docs 04 §3 even though the engine augments assumptions', async () => {
    const h = await setup()
    const f = await backtestFixture(h, h.human('experiment'), 'host')
    await h.k.marketStore.record(BTC, '1h', [{ t: 0, o: 100, h: 101, l: 99, c: 100, v: 1 }, { t: 10, o: 100, h: 102, l: 99, c: 101, v: 1 }])
    await f.lab.stage(f.exp.experimentId, 'backtest', f.actor)
    const packed = await f.pack((await f.run()).runId)
    const stored = f.lab.runTable.packs(packed)[0] as any
    expect(stored.assumptions['x-intraBar']).toBeDefined() // 记的是「采用值」
    expect(stored.spec.assumptions).toEqual(f.spec.assumptions) // 请求值仍在 spec 里
  })

  it('GQ-09a rejects when the engine did not honour a cost assumption', async () => {
    const h = await setup()
    const f = await backtestFixture(h, h.human('experiment'), 'host', (a) => ({ ...a, slippageBps: 0 })) // 让夹具把 slippageBps 回写成 0（请求是 3）
    await h.k.marketStore.record(BTC, '1h', [{ t: 0, o: 100, h: 101, l: 99, c: 100, v: 1 }, { t: 10, o: 100, h: 102, l: 99, c: 101, v: 1 }])
    await f.lab.stage(f.exp.experimentId, 'backtest', f.actor)
    const runId = (await f.run()).runId
    await expect(f.pack(runId)).rejects.toMatchObject({ problem: { code: 1013, message: expect.stringContaining('assumptions.slippageBps') } })
  })

  it('GQ-09a allows funding/liquidation downgrade true→false but not false→true', async () => {
    const { assumptionConflict } = await import('../src/lab/runs')
    expect(assumptionConflict({ funding: true }, { funding: false })).toBeNull()
    expect(assumptionConflict({ funding: false }, { funding: true })).toBe('funding')
    expect(assumptionConflict({ liquidation: true }, { liquidation: false })).toBeNull()
    expect(assumptionConflict({ liquidation: false }, { liquidation: true })).toBe('liquidation')
    expect(assumptionConflict({ fees: 'venue' }, { fees: { maker: '0.1', taker: '0.2' } })).toBeNull()
    expect(assumptionConflict({ fees: { maker: '0.1', taker: '0.2' } }, { fees: { maker: '0.1', taker: '0.3' } })).toBe('fees')
  })

  it('GQ-09b packs a run whose engine had no instrument metadata (files source)', async () => {
    const h = await setup()
    const f = await backtestFixture(h, h.human('experiment'), 'files', undefined, [])
    await f.lab.stage(f.exp.experimentId, 'backtest', f.actor)
    const packed = await f.pack((await f.run()).runId)
    const stored = f.lab.runTable.packs(packed)[0] as any
    expect(stored.instrumentMeta).toEqual([]) // 缺的项不报错：包里 instrumentMeta 少于 spec.instruments 即表示「宿主没有这个标的的合约表」
    expect(stored.data.pointInTime).toBe('unknown') // files 源无法证明按时点取得
  })

  it('GQ-09b still rejects metadata for an instrument that is not part of the run', async () => {
    const h = await setup()
    const strayEth = h.sim.listInstruments().find((item) => item.instrumentId === ETH)!
    const f = await backtestFixture(h, h.human('experiment'), 'host', undefined, [strayEth])
    await h.k.marketStore.record(BTC, '1h', [{ t: 0, o: 100, h: 101, l: 99, c: 100, v: 1 }, { t: 10, o: 100, h: 102, l: 99, c: 101, v: 1 }])
    await f.lab.stage(f.exp.experimentId, 'backtest', f.actor)
    const runId = (await f.run()).runId
    await expect(f.pack(runId)).rejects.toMatchObject({ problem: { code: 1013, message: expect.stringContaining('outside the run') } })
  })

  it('GQ-09d pack falls back to the holdoutWindow stored on the experiment', async () => {
    const h = await setup()
    const f = await backtestFixture(h, h.human('experiment'), 'host')
    await h.k.marketStore.record(BTC, '1h', [{ t: 0, o: 100, h: 101, l: 99, c: 100, v: 1 }, { t: 10, o: 100, h: 102, l: 99, c: 101, v: 1 }])
    // Create experiment with holdoutWindow already set
    const expWithWindow = await h.k.lab.handle('update', { experimentId: f.exp.experimentId, patch: { holdoutWindow: { from: 10, to: 20 } } }, f.actor) as typeof f.exp
    await f.lab.stage(expWithWindow.experimentId, 'backtest', f.actor)
    const runId = (await f.run()).runId
    // Call pack WITHOUT passing holdoutWindow (should use experiment's holdoutWindow)
    const packed = await f.lab.runTable.pack(expWithWindow.experimentId, { runId }, undefined, f.actor)
    expect(packed.frozen?.holdout).toBe(true)
    expect(packed.holdoutWindow).toEqual({ from: 10, to: 20 })
  })

  it('GQ-09d pack without any holdout window still fails with an actionable message', async () => {
    const h = await setup()
    const f = await backtestFixture(h, h.human('experiment'), 'host')
    await h.k.marketStore.record(BTC, '1h', [{ t: 0, o: 100, h: 101, l: 99, c: 100, v: 1 }, { t: 10, o: 100, h: 102, l: 99, c: 101, v: 1 }])
    await f.lab.stage(f.exp.experimentId, 'backtest', f.actor)
    const runId = (await f.run()).runId
    // No holdoutWindow on experiment, none passed to pack
    await expect(f.lab.runTable.pack(f.exp.experimentId, { runId }, undefined, f.actor))
      .rejects.toMatchObject({ problem: { message: expect.stringContaining('set it on the experiment') } })
  })

  it('GQ-09d lab.attach / lab.pack are reachable through the session op gate', async () => {
    const h = await setup()
    const f = await backtestFixture(h, h.human('experiment'), 'host')
    await h.k.marketStore.record(BTC, '1h', [{ t: 0, o: 100, h: 101, l: 99, c: 100, v: 1 }, { t: 10, o: 100, h: 102, l: 99, c: 101, v: 1 }])
    const engineId = f.engineId
    const instanceId = 'inst_fixture'
    const strategyHash = `sha256:${'a'.repeat(64)}` as const
    // Bind engine to account
    h.k.docs.put('enginebind', engineId, { accounts: [{ accountId: h.paper.accountId, mandateId: 'mdt_fixture' }] })
    await f.lab.stage(f.exp.experimentId, 'backtest', f.actor)
    const runId = (await f.run()).runId
    
    // Test lab.attach op
    const attachInput = { principal: h.session, params: { experimentId: f.exp.experimentId, attach: { run: { accountId: h.paper.accountId, executor: { kind: 'engine', engineId, instanceId, codeDigest: strategyHash } } } }, transport: 'ws' as const, kind: 'command' as const }
    await expect(h.k.ops.call(h.k, 'lab.attach', attachInput)).resolves.toMatchObject({ runs: [expect.objectContaining({ accountId: h.paper.accountId })] })
    
    // Test lab.pack op
    const packInput = { principal: h.session, params: { experimentId: f.exp.experimentId, runId, holdoutWindow: { from: 10, to: 20 } }, transport: 'ws' as const, kind: 'command' as const }
    await expect(h.k.ops.call(h.k, 'lab.pack', packInput)).resolves.toMatchObject({ frozen: { holdout: true } })
  })

  it('GQ-09d lab.attach with an agent principal is still refused for engine executors', async () => {
    const h = await setup()
    const agent = await makeAgent(h, 'paper')
    const actor = agent.ctx('experiment')
    const exp = await create(h, actor)
    const engineId = 'lab-fixture'
    const instanceId = 'inst_fixture'
    const strategyHash = `sha256:${'a'.repeat(64)}` as const
    vi.spyOn(h.k.gep, 'status').mockReturnValue([{ engineId, state: 'ready', sessionId: 'fixture-session', bound: true, accounts: [h.paper.accountId], lost: false, placeCalls: 0, proposalCalls: 0 }])
    
    await expect(h.k.lab.handle('attach', { experimentId: exp.experimentId, attach: { run: { accountId: h.paper.accountId, executor: { kind: 'engine', engineId, instanceId, codeDigest: strategyHash } } } }, actor))
      .rejects.toMatchObject({ problem: { name: 'EXPERIMENT_FORBIDDEN' } })
  })
})