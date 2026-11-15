// SPDX-License-Identifier: CPAL-1.0
// BacktestSpec（回测与回放共用）的解析与校验。校验失败一律 -32602，消息只含字段名与限制，不回显调用方给的值。
import type { BacktestAssumptions, BacktestSpec, Sha256Digest } from '../proto'
import { rpcErr } from '../gep/peer'
import { INTERVAL_MS } from '../types'
import type { StrategyRegistry } from '../strategy/registry'
import { validateStrictParams } from '../strategy/schema'
import type { Params, StrategyDef } from '../strategy/types'
import { validateWorkflow, type Workflow } from '../flow'
import { sha256Digest, stableStringify } from '../util/hash'

export const FILL_MODELS = ['next-bar-open'] as const
export const MIN_BARS = 30

export interface ResolvedSubject {
  kind: 'strategy' | 'workflow'
  id: string
  version: string
  strategy?: { def: StrategyDef; params: Params }
  workflow?: Workflow
}

export interface ResolvedSpec {
  spec: BacktestSpec
  subject: ResolvedSubject
  instrumentId: string
  interval: string
  intervalMs: number
  from: number
  to: number
  initialCash: number
  leverage: number
  feeRate: number | 'venue'
  slippageBps: number
  warnings: string[]
  specDigest: Sha256Digest
  /** 实际采用的假设（写进结果，必填五项）。 */
  assumptions: BacktestAssumptions
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const bad = (msg: string): never => { throw rpcErr('INVALID_PARAMS', msg) }

export const DEFAULT_TAKER = 0.00045
export const DEFAULT_MAKER = 0.00015

export function resolveSpec(raw: unknown, limits: { maxBars: number }, registry: StrategyRegistry): ResolvedSpec {
  if (!isObj(raw)) return bad('spec must be an object')
  const spec = raw as unknown as BacktestSpec
  const warnings: string[] = []

  // subject：策略或工作流二选一
  if (!isObj(spec.subject)) return bad('spec.subject is required')
  const { strategy, workflow } = spec.subject
  if ((strategy === undefined) === (workflow === undefined)) return bad('spec.subject must have exactly one of strategy / workflow')
  let subject: ResolvedSubject
  if (strategy !== undefined) {
    if (!isObj(strategy) || typeof strategy.id !== 'string') return bad('spec.subject.strategy.id is required')
    const def = registry.get(strategy.id)
    if (!def) return bad(`unknown strategy id (loaded: ${registry.ids().join(', ') || 'none — put a strategy file in the strategies folder'})`)
    // 先调用策略自定义的 validateParams（必填参数检查），再用引擎的 validateStrictParams（类型检查 + 填充默认值）
    if (def.validateParams) {
      try {
        def.validateParams(strategy.params as Params)
      } catch (e) {
        return bad(e instanceof Error ? e.message : String(e))
      }
    }
    const v = validateStrictParams(def.params, strategy.params)
    if (!v.ok) return bad(`invalid strategy params: ${v.errors.join('; ')}`)
    if (strategy.version !== undefined && strategy.version !== def.version) warnings.push(`strategy version ${String(strategy.version)} requested, ${def.version} used`)
    subject = { kind: 'strategy', id: def.id, version: def.version, strategy: { def, params: v.params } }
  } else {
    const w = workflow as { id?: unknown; version?: unknown; json?: unknown }
    if (!isObj(w)) return bad('spec.subject.workflow must be an object')
    const wf = w.json as Workflow | undefined
    if (!wf) return bad('workflow: pass the workflow JSON in subject.workflow.json (the engine ships no workflow library)')
    const v = validateWorkflow(wf)
    if (!v.ok) return bad(`invalid workflow: ${v.errors.map((e) => e.message).join('; ')}`)
    if (!v.backtestable) return bad(`workflow cannot be backtested: ${v.backtestBlockers.join('; ')}`)
    subject = { kind: 'workflow', id: wf.id, version: String(wf.version), workflow: wf }
  }

  // 标的与周期
  if (!Array.isArray(spec.instruments) || spec.instruments.length !== 1 || typeof spec.instruments[0] !== 'string' || !/^[a-z0-9][a-z0-9-]*:.+$/.test(spec.instruments[0])) return bad('spec.instruments must contain exactly one instrumentId (this engine backtests one instrument per job)')
  if (typeof spec.interval !== 'string' || !INTERVAL_MS[spec.interval]) return bad(`spec.interval must be one of ${Object.keys(INTERVAL_MS).join(', ')}`)
  if (!Number.isInteger(spec.from) || !Number.isInteger(spec.to) || spec.from < 0 || spec.to <= spec.from) return bad('spec.from / spec.to must be integer milliseconds with from < to')

  // 数据来源
  if (!isObj(spec.data) || !['host', 'engine', 'files'].includes(spec.data.source)) return bad('spec.data.source must be host, engine or files')
  if (spec.data.source === 'engine') throw rpcErr('CAPABILITY_UNSUPPORTED', 'market.own is not declared; use data.source "host" or "files"')
  if (spec.data.source === 'files') {
    const f = spec.data.files
    const SHAPE = 'spec.data.files must be exactly one candles entry plus at most one { kind: "funding" } entry, each { path, sha256, format, kind? }'
    if (!Array.isArray(f) || f.length < 1 || f.length > 2) return bad(SHAPE)
    let candlesN = 0
    let fundingN = 0
    for (const e of f) {
      if (!isObj(e) || typeof e.path !== 'string' || typeof e.sha256 !== 'string') return bad(SHAPE)
      if (e.format !== 'csv' && (e.format as string) !== 'json') return bad('only csv and json candle files are supported (see the engine README for the minimal formats)')
      const kind = e.kind as string | undefined
      if (kind === 'funding') fundingN += 1
      else if (kind === undefined || kind === 'candles') candlesN += 1
      else return bad('spec.data.files[].kind must be "candles" or "funding"')
    }
    if (candlesN !== 1 || fundingN > 1) return bad(SHAPE)
  }

  // 账户
  if (!isObj(spec.account) || typeof spec.account.initialBalance !== 'string' || !/^\d+(\.\d+)?$/.test(spec.account.initialBalance) || !(Number(spec.account.initialBalance) > 0)) return bad('spec.account.initialBalance must be a positive decimal string')
  if (typeof spec.account.ccy !== 'string' || spec.account.ccy === '') return bad('spec.account.ccy is required')
  const leverage = spec.account.leverage ?? 1
  if (typeof leverage !== 'number' || !(leverage >= 1 && leverage <= 50)) return bad('spec.account.leverage must be in [1, 50]')

  // 假设
  const a = spec.assumptions
  if (!isObj(a)) return bad('spec.assumptions is required')
  if (!(FILL_MODELS as readonly string[]).includes(a.fillModel)) return bad(`spec.assumptions.fillModel must be one of ${FILL_MODELS.join(', ')} (declared in engine.describe)`)
  if (typeof a.slippageBps !== 'number' || !(a.slippageBps >= 0 && a.slippageBps <= 500)) return bad('spec.assumptions.slippageBps must be in [0, 500]')
  if (typeof a.funding !== 'boolean' || typeof a.liquidation !== 'boolean') return bad('spec.assumptions.funding / liquidation must be booleans')
  let feeRate: number | 'venue'
  let makerOut: string
  let takerOut: string
  if (a.fees === 'venue') { feeRate = 'venue'; makerOut = String(DEFAULT_MAKER); takerOut = String(DEFAULT_TAKER) } else {
    const fees = a.fees as { maker?: unknown; taker?: unknown } | undefined
    if (!isObj(fees) || typeof fees.maker !== 'string' || typeof fees.taker !== 'string' || !/^-?\d+(\.\d+)?$/.test(fees.maker) || !/^\d+(\.\d+)?$/.test(fees.taker) || Number(fees.taker) >= 0.05) return bad('spec.assumptions.fees must be "venue" or { maker, taker } decimal-string fractions (taker < 0.05)')
    feeRate = Number(fees.taker); makerOut = fees.maker; takerOut = fees.taker
  }
  if (a.funding) warnings.push('funding simulation was requested but is not supported; the result does not include funding (assumptions.funding = false)')
  if (typeof a.latencyMs === 'number' && a.latencyMs > 0) warnings.push('latencyMs was requested but is not modelled; fills happen at the next bar open')
  if (!Number.isInteger(spec.seed)) return bad('spec.seed must be an integer')
  void limits

  const assumptions: BacktestAssumptions = {
    fees: { maker: makerOut as never, taker: takerOut as never },
    slippageBps: a.slippageBps,
    fillModel: 'next-bar-open',
    funding: false,
    liquidation: a.liquidation,
    latencyMs: 0,
    'x-intraBar': 'not modelled: signal at bar close, fill at next bar open',
    'x-feesApplied': 'taker fee on every fill (all simulated orders are market orders)',
  }
  return {
    spec, subject, instrumentId: spec.instruments[0]!, interval: spec.interval, intervalMs: INTERVAL_MS[spec.interval]!, from: spec.from, to: spec.to,
    initialCash: Number(spec.account.initialBalance), leverage, feeRate, slippageBps: a.slippageBps, warnings, specDigest: sha256Digest(stableStringify(spec)), assumptions,
  }
}
