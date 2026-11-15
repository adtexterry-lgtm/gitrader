// SPDX-License-Identifier: CPAL-1.0
// 回测任务（backtest.run / status / result / cancel）。run 立即返回 jobId，长任务分片执行、让出事件循环，
// 进度单调、cancel 在一个分片内生效。结果按契约 §2.4 统一格式，并如实写出实际采用的假设与偏差自检。
import { rmSync } from 'node:fs'
import { link, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import type { BacktestAssumptions, BacktestResult, BacktestState, EvidencePackDraft, Instrument, PackArtifact, Problem, Sha256Digest } from '../proto'
import { CANDLES_DIGEST_METHOD, makeProblem, PROBLEM_CODES, protocolCandlesDigest } from '../proto'
import { RpcError, rpcErr } from '../gep/peer'
import type { Candle } from '../types'
import { inferIntervalMs } from '../strategy'
import { auditTrades } from '../strategy/ledger-audit'
import { candlesDigest, newId, sha256Digest } from '../util/hash'
import { getStrategySha256, getStrategySource } from '../strategy/loader'
import { decimalOf, roundOut } from '../util/decimal'
import type { EngineContext } from './context'
import { loadCandles, loadFunding } from './data'
import { checkBacktestWindow } from './limits'
import { JobStore } from './job-store'
import { DEFAULT_TAKER, MIN_BARS, resolveSpec, type ResolvedSpec } from './spec'
import { computeBacktest, type ComputeSubject } from './backtest-compute'
import type { WorkerMessage, WorkerRequest } from './backtest-worker'

export interface JobsOptions {
  maxConcurrent?: number
  maxBars?: number
  /** 大结果落盘目录；缺省不落盘（超限时降采样内联）。 */
  artifactDir?: string
  /** 超过此字节数的结果走 host.artifact.put（契约 O8：> 1 MB）。 */
  inlineLimitBytes?: number
  /** 无法走 artifact 时，内联的权益点数 / 成交笔数上限（超出降采样）。 */
  inlineMaxPoints?: number
  /** 每片处理的 K 线数。 */
  chunk?: number
  keep?: number
  /** 工作线程 URL（GQ-03：打包产物才给，非打包运行为 undefined）。 */
  workerUrl?: URL
}

/** 作业阶段名：与外发 `backtest.progress` 的 `data.stage` 一致。 */
export type BacktestStage = 'loading' | 'signals' | 'simulating' | 'auditing' | 'delivering' | 'done'

/**
 * 阶段 → 总进度区间（下界含、上界不含；done 取 1）。
 *
 * Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/backtest/service.py:178; adapted.
 * QD 按「装载数据 → 生成信号 → 逐根撮合 → 汇总」四个阶段推进百分比，撮合占绝大部分时间；
 * 这里沿用同样的四段比例（装载 0–0.1、信号 0.1–0.2、撮合 0.2–0.9），并为本引擎多出的
 * 账目自审（0.9–0.95）与产物交付（0.95–1）各划一段，从撮合段尾部让出。
 */
const STAGE_RANGES: Record<BacktestStage, readonly [number, number]> = {
  loading: [0, 0.1],
  signals: [0.1, 0.2],
  simulating: [0.2, 0.9],
  auditing: [0.9, 0.95],
  delivering: [0.95, 1],
  done: [1, 1],
}

interface Job {
  jobId: string
  state: BacktestState
  progress: number
  stage: BacktestStage
  stageProgress: number
  /** 从磁盘恢复出来的作业都是终态，没有规格（不会进 run()）。 */
  resolved?: ResolvedSpec
  result?: BacktestResult
  error?: Problem
  cancel: boolean
  createdAt: number
  /** GQ-03：工作线程句柄（cancel 时 terminate）。 */
  worker?: Worker
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r))

export class BacktestJobs {
  private readonly jobs = new Map<string, Job>()
  private readonly queue: Job[] = []
  private running = 0
  /** 本实例的暂存前缀：交付用的宿主可读路径在同一实例内保持稳定（同一内容重复跑得到同一 artifactId）。 */
  private readonly stagingTag: string
  private readonly stagingLinks = new Map<string, number>()
  /** 同一标的（策略 / 工作流）做过的「不同规格」个数，用于偏差折价（trialCount）。同一份规格重复跑不算新试验。 */
  private readonly trials = new Map<string, Set<string>>()
  private readonly o: Required<Omit<JobsOptions, 'artifactDir' | 'workerUrl'>> & { artifactDir?: string; workerUrl?: URL }
  /** 作业表落盘（没配 artifactDir 时为 null，行为与落盘前完全一致）。 */
  private readonly store: JobStore | null

  constructor(private readonly ctx: EngineContext, opts: JobsOptions = {}) {
    this.o = { maxConcurrent: opts.maxConcurrent ?? 2, maxBars: opts.maxBars ?? 1_000_000, inlineLimitBytes: opts.inlineLimitBytes ?? 1_000_000, inlineMaxPoints: opts.inlineMaxPoints ?? 5000, chunk: opts.chunk ?? 20_000, keep: opts.keep ?? 50, ...(opts.artifactDir ? { artifactDir: opts.artifactDir } : {}), ...(opts.workerUrl ? { workerUrl: opts.workerUrl } : {}) }
    this.stagingTag = newId('bt', this.ctx.now())
    this.store = opts.artifactDir ? new JobStore(join(opts.artifactDir, '_jobs')) : null
    this.restore()
  }

  /** 落盘一份作业快照；写不进去只丢这一次持久化，不影响作业本身。 */
  private persist(j: Job): void {
    this.store?.save({
      v: 1, jobId: j.jobId, state: j.state, progress: j.progress,
      createdAt: j.createdAt, updatedAt: this.ctx.now(),
      ...(j.error ? { error: j.error } : {}), ...(j.result ? { result: j.result } : {}),
    })
  }

  /**
   * 起动时读回作业表（GQ-12）：终态照原样恢复；`queued` / `running` 说明上一个进程死在半路，
   * 清成 failed 并写 ENGINE_RESTARTED，把「无终态」变成可重试的终态。超出 keep 的旧文件顺手删。
   */
  private restore(): void {
    if (!this.store) return
    const rows = this.store.loadAll().sort((a, b) => b.updatedAt - a.updatedAt).slice(0, this.o.keep)
    for (const s of rows) {
      let cur = s
      if (s.state === 'queued' || s.state === 'running') {
        cur = {
          ...s, state: 'failed', updatedAt: this.ctx.now(),
          error: makeProblem('BACKTEST_FAILED', `ENGINE_RESTARTED: the engine stopped while this job was ${s.state}; submit it again`, { retryable: true }),
        }
        this.store.save(cur)
      }
      this.jobs.set(cur.jobId, {
        jobId: cur.jobId, state: cur.state, progress: cur.progress, stage: 'done', stageProgress: 1, cancel: false, createdAt: cur.createdAt,
        ...(cur.result ? { result: cur.result } : {}), ...(cur.error ? { error: cur.error } : {}),
      })
    }
    // 超出 keep 的旧文件顺手清掉
    for (const s of this.store.loadAll()) if (!this.jobs.has(s.jobId)) this.store.remove(s.jobId)
  }

  get maxBars(): number { return this.o.maxBars }
  counts(): { running: number; queued: number } { return { running: this.running, queued: this.queue.length } }

  submit(rawSpec: unknown): string {
    let snapshot: unknown
    try { snapshot = structuredClone(rawSpec) } catch { throw rpcErr('INVALID_PARAMS', 'spec could not be cloned') }
    const resolved = resolveSpec(snapshot, { maxBars: this.o.maxBars }, this.ctx.strategies)
    const job: Job = { jobId: newId('job', this.ctx.now()), state: 'queued', progress: 0, stage: 'loading', stageProgress: 0, resolved, cancel: false, createdAt: this.ctx.now() }
    this.jobs.set(job.jobId, job)
    const tk = `${resolved.subject.kind}:${resolved.subject.id}`
    const seen = this.trials.get(tk) ?? new Set<string>()
    seen.add(resolved.specDigest)
    this.trials.set(tk, seen)
    this.queue.push(job)
    this.persist(job)
    while (this.jobs.size > this.o.keep) {
      const old = [...this.jobs.values()].find((j) => j.state === 'done' || j.state === 'failed' || j.state === 'cancelled')
      if (!old) break
      this.jobs.delete(old.jobId)
      this.store?.remove(old.jobId)
    }
    this.pump()
    return job.jobId
  }

  private need(jobId: unknown): Job {
    const j = typeof jobId === 'string' ? this.jobs.get(jobId) : undefined
    if (!j) throw rpcErr('INVALID_PARAMS', 'unknown jobId')
    return j
  }

  status(jobId: unknown): { state: BacktestState; progress: number } {
    const j = this.need(jobId)
    return { state: j.state, progress: Number(j.progress.toFixed(4)) }
  }

  result(jobId: unknown): BacktestResult {
    const j = this.need(jobId)
    if (j.state === 'done') return j.result!
    if (j.state === 'failed') throw new RpcError(j.error!)
    if (j.state === 'cancelled') throw rpcErr('BACKTEST_FAILED', 'job was cancelled')
    throw rpcErr('BUSY', `job is ${j.state}; poll backtest.status`, { retryable: true, retryAfterMs: 500 })
  }

  cancel(jobId: unknown): { state: BacktestState } {
    const j = this.need(jobId)
    if (j.state === 'queued') {
      j.state = 'cancelled'
      this.queue.splice(this.queue.indexOf(j), 1)
      this.persist(j)
      this.emitProgress(j)
    } else if (j.state === 'running') {
      j.cancel = true
      j.worker?.terminate()
    }
    return { state: j.cancel && j.state === 'running' ? 'running' : j.state }
  }

  private pump(): void {
    while (this.running < this.o.maxConcurrent && this.queue.length > 0) {
      const j = this.queue.shift()!
      if (j.state !== 'queued') continue
      this.running += 1
      void this.run(j).finally(() => { this.running -= 1; this.pump() })
    }
  }

  private emitProgress(j: Job): void {
    this.ctx.emit({
      stream: 'backtest', type: 'backtest.progress', ts: this.ctx.now(), key: j.jobId,
      data: {
        jobId: j.jobId, state: j.state, progress: Number(j.progress.toFixed(4)),
        stage: j.stage, stageProgress: Number(j.stageProgress.toFixed(4)),
      },
      origin: this.ctx.origin('backtest'),
    })
  }

  /** 切到某阶段并按阶段内比例（0–1）推进总进度；总进度只增不减。 */
  private advance(j: Job, stage: BacktestStage, fraction = 0): void {
    const bounded = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0
    const [lo, hi] = STAGE_RANGES[stage]
    j.stage = stage
    j.stageProgress = stage === 'done' ? 1 : bounded
    j.progress = Math.max(j.progress, stage === 'done' ? 1 : lo + (hi - lo) * bounded)
    this.emitProgress(j)
  }

  private async run(j: Job): Promise<void> {
    const r = j.resolved!
    try {
      j.state = 'running'
      this.persist(j)
      this.advance(j, 'loading', 0)
      // 窗口上限：超限在装载之前就判失败（省掉一次注定浪费的 history 拉取）
      const window = checkBacktestWindow(r.interval, r.from, r.to)
      if (!window.ok) throw rpcErr('INVALID_PARAMS', `backtest window rejected: ${window.reason ?? 'invalid window'}`)
      const data = await loadCandles(r, this.ctx.host, this.o.maxBars)
      if (j.cancel) return this.finishCancelled(j)
      // 资金费：spec 声明 funding 时按宿主方法 / files[].kind === "funding" 装载；装不到由 data.ts 给出 warning 并降级
      const funding = await loadFunding(r, this.ctx.host)
      if (j.cancel) return this.finishCancelled(j)
      const candles = data.candles
      if (candles.length < MIN_BARS) throw rpcErr('DATA_UNAVAILABLE', `only ${candles.length} bars in range; at least ${MIN_BARS} are needed`)
      const evidenceCandlesDigest = await this.validCandlesDigest(candles)
      // spec 解析阶段在「引擎还没有这项能力」时写的降级说明：真装到资金费点后那句已不成立，去掉；没装到就留着
      const specWarnings = funding.applied ? r.warnings.filter((w) => !w.startsWith('funding simulation was requested but is not supported')) : r.warnings
      const warnings = [...specWarnings, ...data.warnings, ...funding.warnings]
      let instrumentMeta: Instrument[] = []
      let instrumentLookupFailed = false
      try {
        instrumentMeta = (await this.ctx.host.instruments([r.instrumentId])).filter((instrument) => instrument.instrumentId === r.instrumentId).slice(0, 1)
      } catch {
        instrumentLookupFailed = true
      }
      if (instrumentLookupFailed || instrumentMeta.length === 0) warnings.push('instrument metadata unavailable; the evidence pack contains no instrument metadata')
      // 费率：venue = 取合约表里的吃单费率，取不到用默认并说明
      let feeRate: number
      if (r.feeRate === 'venue') {
        feeRate = DEFAULT_TAKER
        const ins = instrumentMeta[0]
        if (ins?.fees?.taker !== undefined) feeRate = Number(ins.fees.taker)
        else if (instrumentLookupFailed) warnings.push(`fees "venue": host.instruments unavailable; default taker ${DEFAULT_TAKER} used`)
        else warnings.push(`fees "venue": host gave no fee schedule; default taker ${DEFAULT_TAKER} used`)
      } else feeRate = r.feeRate
      const assumptions: BacktestAssumptions = { ...r.assumptions, fees: { maker: r.assumptions.fees === 'venue' ? decimalOf(0.00015) : r.assumptions.fees.maker, taker: decimalOf(feeRate) } }
      // 协议 0.1.13：资金费 / 强平 / 成交量上限 / 强平罚金 / 维持保证金比例，结果里回写实际采用值；
      // BacktestAssumptions 没有维持保证金字段，按既有 x- 扩展约定写成 x-maintenanceMarginRatio
      const mmrIn = r.spec.account.maintenanceMarginRatio
      const maintenanceMarginRatio = typeof mmrIn === 'number' && Number.isFinite(mmrIn) && mmrIn >= 0 ? mmrIn : 0.5 / r.leverage
      const shareIn = r.spec.assumptions.maxVolumeShare
      const maxVolumeShare = typeof shareIn === 'number' && Number.isFinite(shareIn) && shareIn >= 0 && shareIn <= 1 ? shareIn : undefined
      const penaltyIn = r.spec.assumptions.liquidationPenaltyRatio
      const liquidationPenaltyRatio = typeof penaltyIn === 'number' && Number.isFinite(penaltyIn) && penaltyIn >= 0 ? penaltyIn : 0
      assumptions.funding = funding.applied
      assumptions.liquidationPenaltyRatio = liquidationPenaltyRatio
      if (maxVolumeShare !== undefined) assumptions.maxVolumeShare = maxVolumeShare
      assumptions['x-maintenanceMarginRatio'] = maintenanceMarginRatio

      // 计算：信号 + 撮合（GQ-03 抽出以便工作线程）
      const stepMs = r.intervalMs || inferIntervalMs(candles)
      const simOptions = {
        initialCash: r.initialCash, leverage: r.leverage, feeRate, slippageBps: r.slippageBps,
        funding: funding.points,
        liquidation: r.spec.assumptions.liquidation === true,
        maintenanceMarginRatio,
        liquidationPenaltyRatio,
        ...(maxVolumeShare !== undefined ? { maxVolumeShare } : {}),
      }
      const subject: ComputeSubject = r.subject.kind === 'strategy'
        ? { kind: 'strategy', def: r.subject.strategy!.def, params: r.subject.strategy!.params }
        : { kind: 'workflow', workflow: r.subject.workflow!, instrumentId: r.instrumentId, interval: r.interval }
      const out = await this.runCompute(j, r, { subject, candles, sim: simOptions, stepMs })
      if (out === null) return this.finishCancelled(j)
      const { lookahead, stats, equity, trades, funding: fundingRecords, openPosition: op, annualizedUnavailable, cash, pos, entry, shortfalls, statNotes } = out
      // 年化算不出有限值时 stats.annualizedRatio 只是占位 0：显式写进 warnings，措辞与 Python
      // 引擎（engine/gep.py）逐字相同，两端结果可直接对照。
      if (annualizedUnavailable) {
        warnings.push('annualizedRatio is reported as 0: annualising a window shorter than a day does not give a finite number (stats.spanDays is the window actually simulated)')
      }
      // GQ-02：穿仓记录写进 warnings
      for (const s of shortfalls) {
        warnings.push(`liquidation shortfall at t=${s.t}: the loss exceeded the margin by ${Number(s.amount.toPrecision(15))}; the fill is priced at the bankruptcy price and equity is floored at 0`)
      }
      // GQ-18：退化字段说明
      warnings.push(...statNotes)
      const tk = `${r.subject.kind}:${r.subject.id}`
      const result: BacktestResult = {
        jobId: j.jobId, specDigest: r.specDigest, assumptions, stats,
        equity, trades,
        openPosition: null,
        biasChecks: { lookahead: lookahead.result, recursive: 'not_run', trialCount: this.trials.get(tk)?.size ?? 1 },
        trialCount: this.trials.get(tk)?.size ?? 1,
        artifacts: [], warnings, engine: { id: this.ctx.engineId, version: this.ctx.version }, dataDigest: candlesDigest(candles),
      }
      if (fundingRecords.length > 0) result.funding = fundingRecords
      if (op) {
        try { result.openPosition = { side: op.side, size: decimalOf(op.size), entryPrice: decimalOf(op.entryPrice), unrealizedPnl: decimalOf(op.unrealizedPnl) } } catch {
          // 回测里权益复利到超出十进制字符串的表示范围（> 30 位有效数字）：说明数据或策略不正常，如实写出来，不让任务崩
          warnings.push('the open position is too large to represent as a canonical decimal string (equity compounded to an absurd size); check the data and the strategy')
        }
      }
      if (lookahead.result === 'fail') warnings.push(`lookahead self-check FAILED at bar ${lookahead.firstMismatch}: a signal changed when later bars were removed; the result must not be trusted`)
      if (lookahead.result === 'not_run') warnings.push('lookahead self-check not run (too few bars)')
      // 账目自审：撮合与结果组装都结束了，从逐笔成交重算现金并与模拟器末期现金对账；只写 warnings，不进结果字段
      this.advance(j, 'auditing', 0)
      try {
        // 口径对齐：模拟器的 cash 是永续口径（开仓只扣手续费，不扣名义金），审计按现货口径逐笔扣名义金，
        // 所以报告的现金取「末期现金 − 未平仓成本」（等同 finalEquity − 浮盈 − 未平仓成本），两边才能逐分对上。
        const reportedCash = cash - pos * entry
        const audit = auditTrades(trades, {
          initialCash: r.initialCash,
          reportedCash,
          marks: { default: candles[candles.length - 1]!.c },
        })
        const mismatch = audit.cash.mismatch
        const qty = Object.keys(audit.qtyMismatch)
        if ((mismatch !== null && Math.abs(mismatch) > 1e-6 * r.initialCash) || qty.length > 0) {
          warnings.push(`ledger audit mismatch: cash Δ=${mismatch === null ? 'n/a' : mismatch}, qty=${JSON.stringify(audit.qtyMismatch)}`)
        }
      } catch (e) {
        warnings.push(`ledger audit failed: ${e instanceof Error ? e.message : String(e)}`)
      }
      this.advance(j, 'auditing', 1)
      // GQ-15：对外数值取 15 位有效数字（自审已用原始值做完；stats 自带取整）。就地改，避免百万根权益曲线再分配一遍。
      for (const p of result.equity) p.v = roundOut(p.v)
      for (const t of result.trades) { t.price = roundOut(t.price); t.size = roundOut(t.size); t.pnl = roundOut(t.pnl); t.fee = roundOut(t.fee) }
      if (result.funding) for (const f of result.funding) { f.notional = roundOut(f.notional); f.paid = roundOut(f.paid) }
      const strategySha256 = r.subject.strategy ? getStrategySha256(r.subject.strategy.def) : undefined
      this.advance(j, 'delivering', 0)
      const artifacts = await this.deliver(j, result)
      if (artifacts === null || j.cancel) return this.finishCancelled(j)
      result.artifacts = artifacts.map(({ artifactId, kind }) => ({ artifactId, kind }))
      this.advance(j, 'delivering', 1)
      const subjectKey = strategySha256 ?? null
      result.pack = {
        schema: 'gitrader-experiment/1', kind: 'backtest', tier: 'hypothetical', subjectKey,
        window: { from: r.from, to: r.to }, spec: r.spec, specDigest: r.specDigest,
        assumptions: result.assumptions, seed: r.spec.seed, stats: result.stats,
        biasChecks: { lookahead: lookahead.result, recursive: 'not_run' }, artifacts,
        data: {
          source: r.spec.data.source,
          pointInTime: r.spec.data.source === 'host' ? true : 'unknown',
          candlesDigests: [{ instrumentId: r.spec.instruments[0]!, digest: evidenceCandlesDigest }],
          candlesDigestMethod: CANDLES_DIGEST_METHOD, timezone: 'UTC', alignment: 'open-time',
        },
        instrumentMeta,
        llm: { involved: false, derivedFrom: 'declared', models: [], contaminated: 'unknown', leakFreeFrom: null },
      } satisfies EvidencePackDraft
      if (strategySha256) result.strategySha256 = strategySha256
      if (j.cancel) return this.finishCancelled(j)
      j.result = result
      j.state = 'done'
      this.persist(j)
      this.advance(j, 'done', 1)
    } catch (e) {
      if (j.cancel) return this.finishCancelled(j)
      j.state = 'failed'
      j.error = e instanceof RpcError ? e.problem : makeProblem('BACKTEST_FAILED', e instanceof Error ? e.message : 'backtest failed')
      // 参数类问题（如窗口超限）如实回 INVALID_PARAMS；其余 PROTOCOL 类一律归为作业失败
      if (j.error.category === 'PROTOCOL' && j.error.code !== PROBLEM_CODES.INVALID_PARAMS.code) j.error = makeProblem('BACKTEST_FAILED', j.error.message)
      this.persist(j)
      this.ctx.log('warn', 'backtest failed', { jobId: j.jobId, code: j.error.code })
      this.emitProgress(j)
    }
  }

  private finishCancelled(j: Job): void {
    j.state = 'cancelled'
    this.persist(j)
    this.emitProgress(j)
  }


  /** GQ-03：回测计算分支——工作线程（有 workerUrl）或同线程（无 workerUrl / 无源码）。 */
  private async runCompute(j: Job, _r: ResolvedSpec, input: Parameters<typeof computeBacktest>[0]): Promise<Awaited<ReturnType<typeof computeBacktest>>> {
    // 先调用策略的参数校验钩子（缺参或越界拒绝），无论同线程还是工作线程
    if (input.subject.kind === 'strategy' && input.subject.def.validateParams) {
      try {
        input.subject.def.validateParams(input.subject.params)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        throw rpcErr('INVALID_PARAMS', msg)
      }
    }
    // 没配 workerUrl 或策略无源码（非 loader 载入）→ 同线程
    if (!this.o.workerUrl || (input.subject.kind === 'strategy' && getStrategySource(input.subject.def) === undefined)) {
      return computeBacktest(input, {
        stage: (s, f) => this.advance(j, s, f),
        cancelled: () => j.cancel,
        yieldLoop: tick,
      })
    }
    // 工作线程分支
    return new Promise<Awaited<ReturnType<typeof computeBacktest>>>((resolve, reject) => {
      const wireSubject: WorkerRequest['subject'] = input.subject.kind === 'workflow'
        ? input.subject
        : {
            kind: 'strategy',
            meta: {
              id: input.subject.def.id,
              name: input.subject.def.name,
              version: input.subject.def.version,
              desc: input.subject.def.desc,
              tags: input.subject.def.tags,
              params: input.subject.def.params,
              defaults: input.subject.def.defaults,
              file: input.subject.def.file,
            },
            source: getStrategySource(input.subject.def)!,
            hasAnchor: 'anchor' in input.subject.def && typeof input.subject.def.anchor === 'function',
            params: input.subject.params,
          }
      const request: WorkerRequest = {
        subject: wireSubject,
        candles: input.candles,
        sim: input.sim,
        stepMs: input.stepMs,
      }
      const w = new Worker(this.o.workerUrl!, { workerData: { gitraderRole: 'backtest', request } })
      j.worker = w
      w.on('message', (m: WorkerMessage) => {
        if (m.t === 'stage') this.advance(j, m.stage, m.fraction)
        else if (m.t === 'done') {
          resolve(m.out)
          void w.terminate()
        } else {
          reject(rpcErr('BACKTEST_FAILED', m.message))
          void w.terminate()
        }
      })
      w.once('error', (e) => reject(rpcErr('BACKTEST_FAILED', `backtest worker crashed: ${e.message}`)))
      w.once('exit', (code) => {
        if (j.cancel) resolve(null)
        else reject(rpcErr('BACKTEST_FAILED', `backtest worker exited (${code}) before finishing`))
      })
    }).finally(() => {
      j.worker = undefined
    })
  }

  /** 协议 K 线摘要：先做自检（时间严格递增、OHLC 自洽、六个数有限），再算摘要；任何问题都带 candles[i]。 */
  private async validCandlesDigest(candles: Candle[]): Promise<Sha256Digest> {
    for (let i = 0; i < candles.length; i++) {
      const c = candles[i]!
      for (const [key, value] of [['t', c.t], ['o', c.o], ['h', c.h], ['l', c.l], ['c', c.c], ['v', c.v]] as const) {
        if (!Number.isFinite(value)) throw rpcErr('DATA_UNAVAILABLE', `candles[${i}] invalid: ${key} is not finite`)
      }
      if (i > 0 && !(candles[i - 1]!.t < c.t)) throw rpcErr('DATA_UNAVAILABLE', `candles[${i}] invalid: t is not strictly increasing`)
      if (c.h < Math.max(c.o, c.c)) throw rpcErr('DATA_UNAVAILABLE', `candles[${i}] invalid: h is less than max(o, c)`)
      if (c.l > Math.min(c.o, c.c)) throw rpcErr('DATA_UNAVAILABLE', `candles[${i}] invalid: l is greater than min(o, c)`)
    }
    try { return await protocolCandlesDigest(candles) } catch (e) {
      const message = e instanceof Error && e.message ? e.message : 'digest failed'
      throw rpcErr('DATA_UNAVAILABLE', `candles digest failed: ${message}`)
    }
  }

  private async deliver(j: Job, res: BacktestResult): Promise<PackArtifact[] | null> {
    const approx = res.equity.length * 38 + res.trades.length * 130
    const payloads = [
      { kind: 'equity' as const, body: Buffer.from(JSON.stringify(res.equity), 'utf8') },
      { kind: 'trades' as const, body: Buffer.from(JSON.stringify(res.trades), 'utf8') },
    ]
    const artifacts: PackArtifact[] = []
    const stablePaths: string[] = []
    let dir: string | undefined
    try {
      if (j.cancel) return null
      const parent = this.o.artifactDir ?? tmpdir()
      if (this.o.artifactDir) await mkdir(parent, { recursive: true })
      if (j.cancel) return null
      dir = await mkdtemp(join(parent, 'gitrader-bt-'))
      for (const { kind, body } of payloads) {
        if (j.cancel) return null
        const sha256 = sha256Digest(body)
        const path = join(dir, `${kind}-${sha256.slice('sha256:'.length)}.json`)
        await writeFile(path, body)
        if (j.cancel) return null
        const hostPath = join(parent, `gitrader-bt-${this.stagingTag}-${kind}-${sha256.slice('sha256:'.length)}.json`)
        await link(path, hostPath).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'EEXIST') throw e })
        this.stagingLinks.set(hostPath, (this.stagingLinks.get(hostPath) ?? 0) + 1)
        stablePaths.push(hostPath)
        if (j.cancel) return null
        let receipt: { artifactId: string }
        try {
          receipt = await this.ctx.host.call('host.artifact.put', { path: hostPath, sha256, kind, sizeBytes: body.byteLength, mediaType: 'application/json' })
        } catch (e) {
          const problem = e instanceof RpcError ? e.problem : undefined
          const code = problem?.code
          if (code === PROBLEM_CODES.METHOD_NOT_FOUND.code || code === PROBLEM_CODES.CAPABILITY_UNSUPPORTED.code) return this.deliverInline(res, approx)
          const message = problem?.message ?? (e instanceof Error ? e.message : String(e))
          throw rpcErr('BACKTEST_FAILED', `host.artifact.put failed (${code ?? 'unknown'}): ${message}`)
        }
        if (j.cancel) return null
        if (typeof receipt.artifactId !== 'string' || receipt.artifactId.length === 0) throw new Error('invalid artifact receipt')
        artifacts.push({ artifactId: receipt.artifactId, sha256, kind, sizeBytes: body.byteLength, mediaType: 'application/json' })
      }
      if (j.cancel) return null
      if (approx > this.o.inlineLimitBytes) {
        if (this.o.artifactDir) {
          res.equity = []
          res.trades = []
          res.warnings.push('equity and trades were delivered as artifacts (host.artifact.put); the inline arrays are empty')
        } else this.downsampleInline(res)
      }
      return artifacts
    } finally {
      let cleanupFailed = false
      for (const hostPath of stablePaths) {
        const left = (this.stagingLinks.get(hostPath) ?? 1) - 1
        if (left > 0) this.stagingLinks.set(hostPath, left)
        else {
          this.stagingLinks.delete(hostPath)
          try { rmSync(hostPath, { force: true }) } catch { cleanupFailed = true }
        }
      }
      if (dir) {
        try { rmSync(dir, { recursive: true, force: true }) } catch { cleanupFailed = true }
      }
      if (cleanupFailed) {
        try { this.ctx.log('warn', 'backtest artifact staging cleanup failed', { jobId: res.jobId }) } catch { /* cleanup logging cannot change the result */ }
      }
    }
  }

  /** 宿主没有 artifact.put：退回内联交付，结果仍成功。 */
  private deliverInline(res: BacktestResult, approx: number): PackArtifact[] {
    if (approx > this.o.inlineLimitBytes) this.downsampleInline(res)
    res.warnings.push('host.artifact.put unavailable; equity and trades delivered inline (downsampled)')
    return []
  }

  private downsampleInline(res: BacktestResult): void {
    const cap = this.o.inlineMaxPoints
    if (res.equity.length > cap) {
      const step = (res.equity.length - 1) / (cap - 1)
      res.equity = Array.from({ length: cap }, (_, i) => res.equity[Math.round(i * step)]!)
      res.warnings.push(`equity curve downsampled to ${cap} points for delivery`)
    }
    if (res.trades.length > cap) {
      res.trades = res.trades.slice(0, cap)
      res.warnings.push(`only the first ${cap} fills are included in trades; stats cover all fills`)
    }
  }
}
