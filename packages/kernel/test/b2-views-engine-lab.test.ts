// SPDX-License-Identifier: CPAL-1.0
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeHarness, makeAgent } from './helpers/harness'
import type { Harness } from './helpers/harness'
import type { BacktestResult, Experiment, Fill, ForwardSnapshot, LabRun, Order, Problem } from '../src/proto'
import { mkOrigin } from '../src/util/origin'

let h: Harness | undefined
let fixtureDir: string | undefined
const now = (): number => h!.clock.now()
const problem: Problem = { code: 4017, name: 'FIXTURE_ENGINE_FAILURE', category: 'ENGINE', message: 'strategy fixture failed', retryable: false }

const rpcFixture = `
import { readFileSync } from 'node:fs'
import readline from 'node:readline'
const state = () => JSON.parse(readFileSync(process.env.B2_STATE_FILE, 'utf8'))
const respond = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n')
const fail = (id, code, message, data) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message, data } }) + '\\n')
for await (const line of readline.createInterface({ input: process.stdin })) {
  let req
  try { req = JSON.parse(line) } catch { continue }
  if (req.id === undefined) continue
  const s = state()
  switch (req.method) {
    case 'gep.hello': respond(req.id, { version: '0.1.0', sessionId: 'b2_04b_fixture' }); break
    case 'engine.describe': respond(req.id, { engine: { id: s.engineId, name: 'B2 fixture', version: '1', vendor: { id: 'test', name: 'test', kind: 'community', verified: false }, license: 'Apache-2.0', runtime: 'node' }, protocol: { version: '0.1.0', transports: ['stdio'] }, capabilities: { strategy: true }, venues: [] }); break
    case 'events.subscribe': respond(req.id, { subscriptions: [] }); break
    case 'strategy.list':
      if (s.listMode === 'method-missing') fail(req.id, -32601, 'method unavailable', s.rpcProblem)
      else if (s.listMode === 'ok-false') respond(req.id, { ok: false, ...(s.problem === undefined ? {} : { problem: s.problem }) })
      else if (s.listMode === 'malformed') respond(req.id, { strategies: 'invalid' })
      else respond(req.id, { strategies: s.strategies ?? [] })
      break
    case 'strategy.status':
      if (s.statusMode === 'method-missing') fail(req.id, -32601, 'method unavailable', s.rpcProblem)
      else if (s.statusMode === 'ok-false') respond(req.id, { ok: false, ...(s.problem === undefined ? {} : { problem: s.problem }) })
      else if (s.statusMode === 'malformed') respond(req.id, { instances: 'invalid' })
      else respond(req.id, { instances: s.instances ?? [] })
      break
    case 'strategy.params':
      if (s.params && s.params[req.params.strategyId]) respond(req.id, s.params[req.params.strategyId])
      else fail(req.id, -32602, 'unknown strategyId')
      break
    default: respond(req.id, {})
  }
}
`

type EngineState = { engineId: string; start?: boolean; listMode?: string; statusMode?: string; problem?: Problem; rpcProblem?: Problem; strategies?: unknown[]; instances?: unknown[]; params?: Record<string, unknown> }
const stateFiles = new Map<string, string>()

async function bootEngines(states: EngineState[]): Promise<void> {
  fixtureDir = mkdtempSync(join(tmpdir(), 'gitrader-b2-04b-'))
  const fixturePath = join(fixtureDir, 'rpc-fixture.mjs')
  writeFileSync(fixturePath, rpcFixture, 'utf8')
  for (const s of states) {
    const statePath = join(fixtureDir, `${s.engineId}.json`)
    stateFiles.set(s.engineId, statePath)
    writeFileSync(statePath, JSON.stringify(s), 'utf8')
  }
  h = await makeHarness({ configure: (cfg) => {
    for (const s of states) cfg.engines.push({ id: s.engineId, enabled: true, launch: { command: process.execPath, args: [fixturePath], env: { B2_STATE_FILE: stateFiles.get(s.engineId)! } } })
  } })
  for (const s of states) if (s.start !== false) h.k.engines.start(s.engineId)
  const started = states.filter((s) => s.start !== false)
  for (let attempt = 0; attempt < 300; attempt++) {
    if (started.every((s) => h!.k.gep.isReady(s.engineId))) break
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  expect(started.every((s) => h!.k.gep.isReady(s.engineId))).toBe(true)
}

function updateEngine(id: string, patch: Partial<EngineState>): void {
  const file = stateFiles.get(id)
  if (!file) throw new Error('fixture engine state missing')
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), ...patch }), 'utf8')
}

async function view(name: string, params: Record<string, unknown>, principal = h!.session): Promise<unknown> {
  return h!.k.ops.call(h!.k, name, { principal, params, transport: 'ws', kind: 'query' })
}

function experiment(id: string, updatedAt: number, patch: Partial<Experiment> = {}): Experiment {
  return {
    experimentId: id as never, title: `Experiment ${id}`, hypothesis: 'A measured input changes the result', stage: 'paper',
    subject: { params: {} }, origin: h!.human('experiment.fixture').origin, createdAt: updatedAt - 100, updatedAt,
    ...patch,
  }
}

function saveExperiment(value: Experiment): void { h!.k.docs.put('experiment', value.experimentId, value) }

function order(id: string, ts: number, engineId: string, instanceId: string): Order {
  const origin = mkOrigin(`engine:${engineId}` as never, 'strategy:fixture', 'gep', { causation: { engineId, instanceId: instanceId as never } })
  return {
    orderId: id as never, clientOrderId: `client-${id}`, accountId: h!.paper.accountId,
    instrumentId: 'hyperliquid:BTC' as never, side: 'buy', type: 'limit', tif: 'gtc', size: '1' as never,
    filledSize: '1' as never, price: '10' as never, status: 'filled', fee: '0' as never,
    origin, createdAt: ts, updatedAt: ts,
  }
}

function fill(id: string, orderId: string, ts: number): Fill {
  return {
    fillId: id as never, orderId: orderId as never, clientOrderId: `client-${orderId}`, venueFillId: `venue-${id}`,
    accountId: h!.paper.accountId, instrumentId: 'hyperliquid:BTC' as never, side: 'buy', price: '10' as never,
    size: '1' as never, fee: '0' as never, feeCcy: 'USD', liquidity: 'maker', realizedPnl: '0' as never, ts,
  }
}

function snapshot(accountId: string, at: number, experimentId?: string): ForwardSnapshot {
  const entry = h!.k.ledger.append({
    type: 'position.snapshot', ts: at, origin: h!.human('snapshot.fixture').origin,
    subject: { orgId: 'org_local', accountId: accountId as never, ...(experimentId ? { experimentId: experimentId as never } : {}) },
    payload: { lab: true, kind: 'daily', at, equity: '1000' as never, unrealizedPnl: '0' as never, valuationCcy: 'USD' },
  })
  return { seq: entry.seq, accountId: accountId as never, at, recordedAt: entry.recordedAt, attestation: entry.attestation, kind: 'daily', equity: '1000' as never, unrealizedPnl: '0' as never, valuationCcy: 'USD' }
}

function savedRun(runId: string, experimentId: string, status: LabRun['status'] = 'done'): LabRun {
  return {
    runId, kind: 'backtest', experimentId: experimentId as never,
    executor: { kind: 'engine', engineId: 'engine-a', instanceId: 'inst_alpha' as never, codeDigest: null },
    subjectKey: null, specDigest: `sha256:${'a'.repeat(64)}` as never, instruments: [], window: { from: 1, to: 10 },
    startedAt: now() - 5, status,
  }
}

const result: BacktestResult = {
  jobId: 'job-offline', specDigest: `sha256:${'a'.repeat(64)}` as never,
  assumptions: { fees: 'venue', slippageBps: 0, fillModel: 'next-bar-open', funding: false, liquidation: false },
  stats: { totalReturnRatio: 0, annualizedRatio: 0, maxDrawdownRatio: 0, sharpe: 0, winRatio: 0, profitFactor: null, trades: 0, fills: 0, avgHoldBars: 0, spanDays: 0, finalEquity: 1000 },
  equity: [{ t: 1, v: 1000 }, { t: 10, v: 1005 }], trades: [], openPosition: null, artifacts: [], warnings: ['offline fixture'],
  engine: { id: 'offline-engine', version: '1' }, dataDigest: `sha256:${'b'.repeat(64)}` as never,
}

afterEach(async () => {
  await h?.cleanup()
  h = undefined
  stateFiles.clear()
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true })
  fixtureDir = undefined
})

describe('B2-04B strategy and lab read views', () => {
  it('engine.strategies keeps a successful engine row beside per-engine RPC and ok:false failures', async () => {
    await bootEngines([
      { engineId: 'engine-a', strategies: [{ id: 'strategy-alpha', version: '2.4' }], instances: [{ instanceId: 'inst_alpha', strategyId: 'strategy-alpha', status: 'running', accountId: 'acct_fixture', instruments: [], params: { period: 7 }, mandateId: 'mdt_fixture' }] },
      { engineId: 'engine-b', statusMode: 'ok-false', problem },
      { engineId: 'engine-c', start: false, strategies: [], instances: [] },
    ])
    const account = h!.paper.accountId
    updateEngine('engine-a', { instances: [{ instanceId: 'inst_alpha', strategyId: 'strategy-alpha', status: 'running', accountId: account, instruments: [], params: { period: 7 }, mandateId: 'mdt_fixture' }] })
    const agent = await makeAgent(h!, 'read_only')
    await expect(view('engine.strategies', {}, agent.principal)).rejects.toMatchObject({ problem: { name: 'AUTH_FAILED' } })

    const both = await view('engine.strategies', {}) as Array<Record<string, unknown>>
    expect(both).toHaveLength(2)
    expect(both.find((item) => item.engineId === 'engine-a')).toMatchObject({ engineId: 'engine-a', instanceId: 'inst_alpha', strategyId: 'strategy-alpha', version: '2.4', accountId: account, state: 'running', params: { period: 7 } })
    expect(both.find((item) => item.engineId === 'engine-b')).toEqual({ engineId: 'engine-b', unavailable: true, problem })

    updateEngine('engine-b', { statusMode: 'ok-false', problem: undefined })
    const noProblem = await view('engine.strategies', {}) as Array<Record<string, unknown>>
    expect(noProblem.find((item) => item.engineId === 'engine-a')).toMatchObject({ instanceId: 'inst_alpha' })
    expect(noProblem.find((item) => item.engineId === 'engine-b')).toMatchObject({ unavailable: true, problem: { name: 'DATA_UNAVAILABLE' } })

    updateEngine('engine-b', { statusMode: 'method-missing', rpcProblem: problem })
    const rpcFailure = await view('engine.strategies', {}) as Array<Record<string, unknown>>
    expect(rpcFailure.find((item) => item.engineId === 'engine-a')).toMatchObject({ instanceId: 'inst_alpha' })
    expect(rpcFailure.find((item) => item.engineId === 'engine-b')).toEqual({ engineId: 'engine-b', unavailable: true, problem })

    updateEngine('engine-b', { statusMode: 'malformed' })
    const malformedStatus = await view('engine.strategies', {}) as Array<Record<string, unknown>>
    expect(malformedStatus.find((item) => item.engineId === 'engine-a')).toMatchObject({ instanceId: 'inst_alpha' })
    expect(malformedStatus.find((item) => item.engineId === 'engine-b')).toMatchObject({ unavailable: true, problem: { name: 'DATA_UNAVAILABLE' } })

    updateEngine('engine-b', { statusMode: undefined, listMode: 'malformed' })
    const malformedList = await view('engine.strategies', {}) as Array<Record<string, unknown>>
    expect(malformedList.find((item) => item.engineId === 'engine-a')).toMatchObject({ instanceId: 'inst_alpha' })
    expect(malformedList.find((item) => item.engineId === 'engine-b')).toMatchObject({ unavailable: true, problem: { name: 'DATA_UNAVAILABLE' } })

    updateEngine('engine-a', { strategies: [], instances: [] })
    updateEngine('engine-b', { statusMode: undefined, listMode: undefined, strategies: [], instances: [] })
    await expect(view('engine.strategies', {})).resolves.toEqual([])
    await expect(view('engine.strategies', { engineId: 'engine-missing' })).rejects.toMatchObject({ problem: { name: 'VENUE_UNAVAILABLE' } })
    await expect(view('engine.strategies', { engineId: 'engine-c' })).rejects.toMatchObject({ problem: { name: 'VENUE_UNAVAILABLE' } })
  })

  it('engine.strategies associates max real fill time and only a unique matching Experiment run', async () => {
    await bootEngines([{ engineId: 'engine-a', strategies: [{ id: 'strategy-alpha', version: '2.4' }], instances: [{ instanceId: 'inst_alpha', strategyId: 'strategy-alpha', status: 'running', accountId: 'acct_fixture', instruments: [], params: { period: 7 }, mandateId: 'mdt_fixture' }] }])
    const account = h!.paper.accountId
    updateEngine('engine-a', { instances: [{ instanceId: 'inst_alpha', strategyId: 'strategy-alpha', status: 'running', accountId: account, instruments: [], params: { period: 7 }, mandateId: 'mdt_fixture', error: problem }] })
    const first = order('ord_engine_a', now() - 100, 'engine-a', 'inst_alpha')
    const second = order('ord_engine_b', now() - 50, 'engine-a', 'inst_alpha')
    h!.k.orders.upsert(first, '20', true)
    h!.k.orders.upsert(second, '20', true)
    h!.k.orders.insertFill(fill('fill_engine_a', first.orderId, now() - 75))
    h!.k.orders.insertFill(fill('fill_engine_b', second.orderId, now() - 25))
    saveExperiment(experiment('exp_unique', now(), { runs: [{ runId: 'run_unique', stage: 'paper', accountId: account, from: now() - 500, to: null, attachedAt: now() - 500, executor: { kind: 'engine', engineId: 'engine-a', instanceId: 'inst_alpha' as never, codeDigest: null } }] }))
    let row = (await view('engine.strategies', { engineId: 'engine-a' }) as Array<Record<string, unknown>>)[0]!
    expect(row).toMatchObject({ problem, lastFillTs: now() - 25, experimentId: 'exp_unique', params: { period: 7 } })

    saveExperiment(experiment('exp_ambiguous', now() + 1, { runs: [{ runId: 'run_ambiguous', stage: 'paper', accountId: account, from: now() - 400, to: null, attachedAt: now() - 400, executor: { kind: 'engine', engineId: 'engine-a', instanceId: 'inst_alpha' as never, codeDigest: null } }] }))
    row = (await view('engine.strategies', { engineId: 'engine-a' }) as Array<Record<string, unknown>>)[0]!
    expect(row).not.toHaveProperty('experimentId')
  })

  it('lab.list validates enum filters, filters before stable keyset paging, and binds its cursor', async () => {
    await bootEngines([])
    saveExperiment(experiment('exp_old', now() - 10, { stage: 'paper', owner: { actorType: 'human' } }))
    saveExperiment(experiment('exp_new', now(), { stage: 'paper', owner: { actorType: 'human' } }))
    saveExperiment(experiment('exp_other', now() + 1, { stage: 'closed', owner: { actorType: 'system' } }))
    const first = await view('lab.list', { stage: 'paper', ownerType: 'human', limit: 1 }) as { items: Experiment[]; next?: string }
    expect(first.items.map((item) => item.experimentId)).toEqual(['exp_new'])
    expect(first.next).toEqual(expect.any(String))
    const second = await view('lab.list', { stage: 'paper', ownerType: 'human', limit: 1, cursor: first.next }) as { items: Experiment[]; next?: string }
    expect(second.items.map((item) => item.experimentId)).toEqual(['exp_old'])
    expect(second.next).toBeUndefined()
    await expect(view('lab.list', { stage: 'closed', ownerType: 'human', limit: 1, cursor: first.next })).rejects.toMatchObject({ problem: { name: 'INVALID_PARAMS' } })
    for (const params of [{ stage: 'unknown' }, { ownerType: 'robot' }, { limit: 0 }, { limit: 501 }, { cursor: 'not-base64!' }]) {
      await expect(view('lab.list', params)).rejects.toMatchObject({ problem: { name: 'INVALID_PARAMS' } })
    }
    await expect(view('lab.list', { stage: 'review' })).resolves.toMatchObject({ items: [] })
    const agent = await makeAgent(h!, 'read_only')
    await expect(view('lab.list', {}, agent.principal)).rejects.toMatchObject({ problem: { name: 'AUTH_FAILED' } })
  })

  it('lab.get returns persisted runs and shared account snapshots only inside each run window', async () => {
    await bootEngines([])
    const account = h!.paper.accountId
    const expA = experiment('exp_window_a', now(), { runs: [{ runId: 'run_a', stage: 'paper', accountId: account, from: now() - 4000, to: null, attachedAt: now() - 3000 }] })
    const expB = experiment('exp_window_b', now() + 1, { runs: [{ runId: 'run_b', stage: 'paper', accountId: account, from: now() - 2000, to: null, attachedAt: now() - 1000 }] })
    saveExperiment(expA)
    saveExperiment(expB)
    const summary = savedRun('run_a', expA.experimentId)
    h!.k.docs.put('lab-run', summary.runId, summary)
    const onlyA = snapshot(account, now() - 2000, expA.experimentId)
    const shared = snapshot(account, now() - 500, expA.experimentId)
    snapshot(account, now() - 4000, expA.experimentId)
    snapshot(h!.liveAcct.accountId, now() - 500, expA.experimentId)
    const raw = h!.k.ledger.append({
      type: 'position.snapshot', ts: now() - 100, origin: h!.human('snapshot.fixture').origin,
      subject: { orgId: 'org_local', accountId: account, experimentId: expA.experimentId as never },
      payload: { lab: false, kind: 'daily', at: now() - 100, equity: '9' as never, unrealizedPnl: '0' as never, valuationCcy: 'USD' },
    })
    expect(raw.seq).toBeGreaterThan(shared.seq)
    const endSnapshot = snapshot(account, now(), expA.experimentId)

    const a = await view('lab.get', { experimentId: expA.experimentId }) as Experiment & { runSummaries: LabRun[]; forwardSnapshots: ForwardSnapshot[] }
    const b = await view('lab.get', { experimentId: expB.experimentId }) as Experiment & { runSummaries: LabRun[]; forwardSnapshots: ForwardSnapshot[] }
    expect(a.runSummaries).toEqual([summary])
    expect(a.forwardSnapshots.map((item) => item.seq)).toEqual([onlyA.seq, shared.seq, endSnapshot.seq])
    expect(b.forwardSnapshots).toEqual([shared, endSnapshot])
    expect(a.forwardSnapshots[1]).toEqual(shared)
    await expect(view('lab.get', { experimentId: 'exp_missing' })).rejects.toMatchObject({ problem: { name: 'EXPERIMENT_EVIDENCE_INCOMPLETE' } })
    const agent = await makeAgent(h!, 'read_only')
    await expect(view('lab.get', { experimentId: expA.experimentId }, agent.principal)).rejects.toMatchObject({ problem: { name: 'AUTH_FAILED' } })
  })

  it('lab.run returns only a completed persisted result offline and rejects incomplete or cross-experiment evidence', async () => {
    await bootEngines([])
    const expA = experiment('exp_run_a', now())
    const expB = experiment('exp_run_b', now() + 1)
    saveExperiment(expA)
    saveExperiment(expB)
    const complete = savedRun('run_complete', expA.experimentId, 'done')
    h!.k.docs.put('lab-run', complete.runId, complete)
    h!.k.docs.put('lab-run-detail', complete.runId, { engineId: 'offline-engine', spec: {}, origin: h!.human().origin, executor: complete.executor, jobId: result.jobId, result })
    const queued = savedRun('run_queued', expA.experimentId, 'queued')
    h!.k.docs.put('lab-run', queued.runId, queued)
    h!.k.docs.put('lab-run-detail', queued.runId, { engineId: 'offline-engine', spec: {}, origin: h!.human().origin, executor: queued.executor, jobId: 'job-queued' })
    const other = savedRun('run_other_exp', expB.experimentId, 'done')
    h!.k.docs.put('lab-run', other.runId, other)
    h!.k.docs.put('lab-run-detail', other.runId, { engineId: 'offline-engine', spec: {}, origin: h!.human().origin, executor: other.executor, jobId: result.jobId, result })

    await expect(view('lab.run', { experimentId: expA.experimentId, runId: complete.runId })).resolves.toEqual(result)
    await expect(view('lab.run', { experimentId: expA.experimentId, runId: queued.runId })).rejects.toMatchObject({ problem: { name: 'EXPERIMENT_EVIDENCE_INCOMPLETE' } })
    await expect(view('lab.run', { experimentId: expA.experimentId, runId: other.runId })).rejects.toMatchObject({ problem: { name: 'EXPERIMENT_EVIDENCE_INCOMPLETE' } })
    await expect(view('lab.run', { experimentId: expA.experimentId, runId: 'run_missing' })).rejects.toMatchObject({ problem: { name: 'EXPERIMENT_EVIDENCE_INCOMPLETE' } })
    const agent = await makeAgent(h!, 'read_only')
    await expect(view('lab.run', { experimentId: expA.experimentId, runId: complete.runId }, agent.principal)).rejects.toMatchObject({ problem: { name: 'AUTH_FAILED' } })
  })
})

// ---- engine.catalog（WP-I I-1a）：引擎已加载的策略 + 表单用参数，只读 ----------------------------------
const GRID_SCHEMA = {
  schema: {
    type: 'object', additionalProperties: false,
    properties: {
      grids: { title: '格数', type: 'integer', default: 8, minimum: 2, maximum: 50, 'x-step': 1 },
      lowerPrice: { title: '下限价', type: 'number', default: 0, minimum: 0, description: '与 upperPrice 同时 > 0 才生效' },
      gridMode: { title: '格子间距', type: 'string', enum: ['arithmetic', 'geometric'], default: 'arithmetic' },
      startTs: { title: '内部', type: 'number', default: 0, 'x-hidden': true },
      size: { title: '单笔数量上限', type: 'string', pattern: '^[0-9.]+$' },
    },
  },
  defaults: { grids: 8, lowerPrice: 0, gridMode: 'arithmetic', startTs: 0 },
}

describe('WP-I engine.catalog read view', () => {
  it('engine.catalog lists loaded strategies with a UI-ready param schema', async () => {
    await bootEngines([{ engineId: 'engine-a', strategies: [{ id: 'grid', name: 'Grid', nameZh: '网格', version: '1.0', desc: 'range grid', tags: ['grid'] }, { id: 'dca', name: 'DCA', version: '1.0' }], instances: [], params: { grid: GRID_SCHEMA } }])
    const agent = await makeAgent(h!, 'read_only')
    await expect(view('engine.catalog', {}, agent.principal)).rejects.toMatchObject({ problem: { name: 'AUTH_FAILED' } })
    const rows = await view('engine.catalog', {}) as Array<{ engineId: string; strategies: Array<Record<string, any>> }>
    expect(rows).toHaveLength(1)
    const grid = rows[0]!.strategies.find((s) => s.id === 'grid')!
    expect(grid).toMatchObject({ name: 'Grid', nameZh: '网格', version: '1.0', desc: 'range grid', tags: ['grid'] })
    expect(grid.params.map((p: any) => p.key)).toEqual(['grids', 'lowerPrice', 'gridMode', 'size'])
    expect(grid.params.find((p: any) => p.key === 'grids')).toEqual({ key: 'grids', label: '格数', type: 'integer', default: 8, min: 2, max: 50, step: 1 })
    expect(grid.params.find((p: any) => p.key === 'gridMode')).toMatchObject({ type: 'select', options: ['arithmetic', 'geometric'], default: 'arithmetic' })
    expect(grid.params.find((p: any) => p.key === 'lowerPrice')).toMatchObject({ type: 'number', min: 0, help: '与 upperPrice 同时 > 0 才生效' })
    // 反例：x-hidden 的不出现；size 是可空文本
    expect(grid.params.some((p: any) => p.key === 'startTs')).toBe(false)
    expect(grid.params.find((p: any) => p.key === 'size')).toMatchObject({ type: 'text', default: null })
    // 参数拿不到的策略照样列出，只是空表
    expect(rows[0]!.strategies.find((s) => s.id === 'dca')).toMatchObject({ id: 'dca', params: [] })
  })

  it('engine.catalog reports an unavailable engine as its own failure row and does not throw (反例)', async () => {
    await bootEngines([
      { engineId: 'engine-a', strategies: [{ id: 'grid', version: '1.0' }], instances: [], params: { grid: GRID_SCHEMA } },
      { engineId: 'engine-b', listMode: 'ok-false', problem },
      { engineId: 'engine-c', listMode: 'malformed' },
    ])
    const rows = await view('engine.catalog', {}) as Array<Record<string, unknown>>
    expect(rows.find((r) => r.engineId === 'engine-a')).toMatchObject({ strategies: [{ id: 'grid' }] })
    expect(rows.find((r) => r.engineId === 'engine-b')).toEqual({ engineId: 'engine-b', unavailable: true, problem })
    expect(rows.find((r) => r.engineId === 'engine-c')).toMatchObject({ unavailable: true, problem: { name: 'DATA_UNAVAILABLE' } })
    updateEngine('engine-b', { listMode: 'method-missing', rpcProblem: problem })
    expect((await view('engine.catalog', {}) as Array<Record<string, unknown>>).find((r) => r.engineId === 'engine-b')).toEqual({ engineId: 'engine-b', unavailable: true, problem })
  })

  it('engine.catalog does not write the ledger', async () => {
    await bootEngines([{ engineId: 'engine-a', strategies: [{ id: 'grid', version: '1.0' }], instances: [], params: { grid: GRID_SCHEMA } }])
    const before = h!.k.ledger.query({ limit: 10_000 }).length
    await view('engine.catalog', {})
    expect(h!.k.ledger.query({ limit: 10_000 }).length).toBe(before)
  })
})
