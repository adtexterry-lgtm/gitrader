// SPDX-License-Identifier: CPAL-1.0
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { makeProblem } from './proto'
import type { PaperReplayFixture, PaperReplayStart, PaperReplayStatus } from './proto'
import type { Kernel } from './kernel'
import type { ReplayClock } from './util/clock'
import { writeFileAtomic } from './util/fsperm'
import { newId } from './util/ids'
import { digestOf } from './util/hash'
import { KernelError } from './util/errors'
import { resolveConfinedPath } from './util/confined-path'
import { tx } from './db'

const RUN_COLLECTION = 'paper-replay-run'
const CURRENT_RUN_ID = 'current'

export interface ReplayDriver {
  prepare(input: PaperReplayStart, runId: string): Promise<{ instanceId: string }>
  advance(index: number): Promise<void>
  evaluate(instanceId: string): Promise<void>
  tickPaper(): Promise<void>
  exportState(): string
  stop(instanceId: string): Promise<void>
  close(): Promise<void>
}

export class ReplayController {
  private driver?: ReplayDriver
  private driverClosed = false
  private current: PaperReplayStatus
  private active?: { runId: string; instanceId?: string; task: Promise<void>; stopRequested: boolean }
  private starting = false
  private terminalRun = false
  private closing = false
  private readonly closingSignal: Promise<void>
  private resolveClosing!: () => void
  private shutdownTask?: Promise<void>
  private readonly provenance

  constructor(private readonly kernel: Kernel, private readonly fixture: PaperReplayFixture, private readonly clock: ReplayClock) {
    this.provenance = { source: 'replay' as const, fixtureDigest: digestOf(fixture) }
    this.closingSignal = new Promise<void>((resolve) => { this.resolveClosing = resolve })
    const saved = kernel.docs.get<PaperReplayStatus>(RUN_COLLECTION, CURRENT_RUN_ID)
    if (saved) {
      this.terminalRun = true
      this.current = ['running', 'stopping'].includes(saved.state)
        ? { ...saved, state: 'failed', finishedAt: kernel.auth.now(), problem: makeProblem('INTERNAL', 'historical replay was interrupted') }
        : saved
    } else this.current = { state: 'idle', frameIndex: -1, totalFrames: fixture.frames.length, clock: clock.now(), provenance: this.provenance }
  }

  attachDriver(driver: ReplayDriver): void {
    if (this.closing) throw new KernelError(makeProblem('INVALID_PARAMS', 'cannot attach a replay driver after shutdown begins'))
    if (!this.kernel.config.paperReplay || this.driver) throw new KernelError(makeProblem('INVALID_PARAMS', 'replay driver can be attached exactly once in replay mode'))
    this.driver = driver
    this.driverClosed = false
  }

  status(): PaperReplayStatus { return structuredClone(this.current) }

  async start(input: PaperReplayStart): Promise<PaperReplayStatus> {
    this.assertNotClosing()
    if (this.active || this.starting || this.terminalRun) throw new KernelError(makeProblem('BUSY', 'this home has already started its single replay run'))
    if (!this.driver) throw new KernelError(makeProblem('CAPABILITY_UNSUPPORTED', 'paper replay driver is not attached'))
    this.starting = true
    const validation = this.validateStart(input)
    try {
      await Promise.race([validation, this.closingSignal.then(() => { throw new KernelError(makeProblem('BUSY', 'paper replay controller is closing')) })])
    } catch (error) { this.starting = false; throw error }
    const runId = newId('job')
    const running: PaperReplayStatus = { state: 'running', runId, accountId: input.accountId, frameIndex: -1, totalFrames: this.fixture.frames.length, clock: this.clock.now(), startedAt: this.kernel.auth.now(), provenance: { ...this.provenance, runId } }
    try {
      this.assertNotClosing()
      if (!this.kernel.securityStateHealth().ok) this.kernel.throwStateCorrupt()
      tx(this.kernel.db, () => {
        if (this.kernel.docs.get(RUN_COLLECTION, CURRENT_RUN_ID)) throw new KernelError(makeProblem('BUSY', 'this home already has a historical replay run'))
        this.kernel.docs.put(RUN_COLLECTION, CURRENT_RUN_ID, running)
      })
    } catch (error) { this.starting = false; throw error }
    const active = { runId, task: Promise.resolve(), stopRequested: false }
    this.active = active
    this.starting = false
    this.terminalRun = true
    this.current = running
    active.task = this.run(active, input)
    return this.status()
  }

  async stop(runId: string): Promise<PaperReplayStatus> {
    const active = this.active
    if (!active || active.runId !== runId) throw new KernelError(makeProblem('INVALID_PARAMS', 'replay run is not active'))
    active.stopRequested = true
    if (this.current.state === 'running') {
      this.current = { ...this.current, state: 'stopping' }
      this.saveStatus(this.current)
    }
    await active.task
    return this.status()
  }

  async cancelForShutdown(): Promise<void> {
    if (this.shutdownTask) return this.shutdownTask
    this.closing = true
    this.resolveClosing()
    this.shutdownTask = (async () => {
      if (this.active && !['completed', 'cancelled', 'failed'].includes(this.current.state)) await this.stop(this.active.runId)
      else await this.closeDriver()
    })()
    return this.shutdownTask
  }

  private assertNotClosing(): void {
    if (this.closing) throw new KernelError(makeProblem('BUSY', 'paper replay controller is closing'))
  }

  private async closeDriver(): Promise<void> {
    if (!this.driver || this.driverClosed) return
    this.driverClosed = true
    await this.driver.close()
  }

  private saveStatus(status: PaperReplayStatus): void {
    tx(this.kernel.db, () => this.kernel.docs.put(RUN_COLLECTION, CURRENT_RUN_ID, status))
  }

  private async validateStart(input: PaperReplayStart): Promise<void> {
    this.assertNotClosing()
    if (!this.kernel.config.paperReplay) throw new KernelError(makeProblem('CAPABILITY_UNSUPPORTED', 'paper replay is not configured'))
    if (input.interval !== this.fixture.interval || !this.fixture.instruments.some((i) => i.instrumentId === input.instrumentId)) throw new KernelError(makeProblem('INVALID_PARAMS', 'replay input does not match the configured fixture'))
    const account = this.kernel.accounts.get(input.accountId)
    if (account.mode === 'live' || !account.paper) throw new KernelError(makeProblem('INVALID_PARAMS', 'paper replay requires a paper account'))
    if (!this.kernel.bus.get('kernel-sim')) throw new KernelError(makeProblem('CAPABILITY_UNSUPPORTED', 'paper replay requires the configured local paper connector'))
    const engine = this.kernel.engines.status().find((entry) => entry.id === input.engineId)
    const binding = this.kernel.gep.bindingOf(input.engineId)
    if (!engine || engine.state !== 'ready' || !binding?.accounts.some((a) => a.accountId === input.accountId)) throw new KernelError(makeProblem('INVALID_PARAMS', 'replay requires an existing ready engine binding for the selected paper account'))
    const bound = binding.accounts.find((a) => a.accountId === input.accountId)!
    const mandate = this.kernel.agents.getMandate(bound.mandateId)
    const firstTs = this.fixture.frames[0]!.ts
    const lastTs = this.fixture.frames[this.fixture.frames.length - 1]!.ts
    if (!mandate || mandate.status !== 'active' || mandate.subject.type !== 'engine' || mandate.subject.id !== input.engineId || !mandate.accounts.includes(input.accountId) || mandate.notBefore > firstTs || mandate.notAfter < lastTs || (mandate.instrumentAllowlist?.length && !mandate.instrumentAllowlist.includes(input.instrumentId))) throw new KernelError(makeProblem('MANDATE_LIMIT', 'active engine mandate must cover the full replay fixture horizon'))
    if (this.kernel.orders.list({ accountId: input.accountId, limit: 1000 }).length || this.kernel.orders.fills({ accountId: input.accountId, limit: 1000 }).length) throw new KernelError(makeProblem('INVALID_PARAMS', 'replay requires a fresh paper account with no orders or fills'))
    const economic = [...this.kernel.ledger.iterate()].some((e) => e.subject.accountId === input.accountId && ['position.snapshot', 'order.intent', 'order.placed', 'fill'].includes(e.type))
    if (economic) throw new KernelError(makeProblem('INVALID_PARAMS', 'replay requires a fresh paper account without economic ledger history'))
    const snapshot = await this.kernel.bus.snapshot(account, { maxAgeMs: 0 })
    this.assertNotClosing()
    if (snapshot.positions.length || snapshot.openOrders.length) throw new KernelError(makeProblem('INVALID_PARAMS', 'replay requires a paper account with no positions or open orders'))
    const venueFills = await this.kernel.bus.routeFor(account).fills(this.kernel.bus.accountRef(account), 0)
    this.assertNotClosing()
    if (venueFills.length) throw new KernelError(makeProblem('INVALID_PARAMS', 'replay requires a paper account with no existing fills'))
  }

  private async run(active: NonNullable<ReplayController['active']>, input: PaperReplayStart): Promise<void> {
    let failure: unknown
    try {
      const prepared = await this.driver!.prepare(input, active.runId)
      active.instanceId = prepared.instanceId
      for (let index = 0; index < this.fixture.frames.length; index++) {
        if (active.stopRequested) break
        const frame = this.fixture.frames[index]!
        this.clock.advanceTo(frame.ts)
        await this.driver!.advance(index)
        await this.driver!.evaluate(prepared.instanceId)
        await this.driver!.tickPaper()
        await this.kernel.tickOnce()
        this.current = { ...this.current, frameIndex: index, clock: this.clock.now() }
        this.saveStatus(this.current)
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
    } catch (error) { failure = error }
    try { if (active.instanceId) await this.driver!.stop(active.instanceId) } catch (stopError) { failure ??= stopError }
    let exportedState: Record<string, unknown> | undefined
    try {
      const parsed: unknown = JSON.parse(this.driver!.exportState())
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('replay driver exported an invalid paper state object')
      exportedState = parsed as Record<string, unknown>
    } catch (exportError) { failure ??= exportError }
    try { await this.closeDriver() } catch (closeError) { failure ??= closeError }
    let state: PaperReplayStatus['state'] = failure ? 'failed' : active.stopRequested ? 'cancelled' : 'completed'
    let artifact: string | undefined
    let terminal: PaperReplayStatus = { ...this.current, state, finishedAt: this.kernel.auth.now(), ...(failure ? { problem: makeProblem('INTERNAL', 'historical replay failed') } : {}) }
    try {
      artifact = await this.persist(active.runId, input, terminal, exportedState)
      terminal = { ...terminal, artifact }
      this.saveStatus(terminal)
    } catch (persistError) {
      failure ??= persistError
      state = 'failed'
      terminal = { ...this.current, state, finishedAt: this.kernel.auth.now(), problem: makeProblem('INTERNAL', 'historical replay failed') }
      try {
        artifact = await this.persist(active.runId, input, terminal, exportedState)
        terminal = { ...terminal, artifact }
        this.saveStatus(terminal)
      } catch { /* keep failure visible in memory; persistence failure must not be reported as completion */ }
    }
    this.current = terminal
    this.active = undefined
  }

  private async persist(runId: string, input: PaperReplayStart, status: PaperReplayStatus, exportedState?: Record<string, unknown>): Promise<string> {
    if (!/^job_[0-9A-Za-z]{3,26}$/.test(runId)) throw new Error('replay run ID is invalid')
    if (exportedState !== undefined) {
      writeFileAtomic(join(this.kernel.home, 'paper-state.json'), JSON.stringify({ ...exportedState, gitraderProvenance: { ...this.provenance, runId } }))
    }
    const artifact = `exports/replay/${runId}.json`
    const target = resolveConfinedPath(this.kernel.home, artifact)
    mkdirSync(join(this.kernel.home, 'exports', 'replay'), { recursive: true })
    const finalStatus = { ...status, artifact, provenance: { ...this.provenance, runId } }
    writeFileAtomic(target, JSON.stringify({ schema: 'gitrader-paper-replay-run/1', input, status: finalStatus, provenance: finalStatus.provenance }, null, 2))
    return artifact
  }
}
