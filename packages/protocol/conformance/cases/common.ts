// SPDX-License-Identifier: Apache-2.0
// 用例的共用辅助：连接、引导（hello → describe → bind → 订阅 → 策略）、喂行情、结果记录。
import { createHash } from 'node:crypto'
import { expect } from 'vitest'
import { canonicalize, validateBinding, validateEngineDescribe, validateRiskPolicy, type Candle, type EngineDescribe, type GepEvent } from '../../src'
import { BTC, MANDATE_ID, PAPER_ACCOUNT, genCandles, T0 } from '../host-sim'
import { GepSession, sleep } from '../session'
import type { Target } from '../target'

export type SkipFn = (reason: string) => never

/** 一个用例。requires：需要引擎在 describe 里声明的能力位（全部为 true 才运行，否则跳过）。 */
export interface Case {
  id: string
  title: string
  requires?: readonly string[]
  /** 仅 stdio 目标或仅在非 stdio 目标运行等的附加条件由用例内部用 skip() 处理。 */
  run(t: Target, skip: SkipFn): Promise<void>
}

export const BINDING_ID = 'bind_01JABCCONF01'

export async function connect(t: Target, opts: { hello?: boolean; heartbeats?: boolean; token?: string } = {}): Promise<GepSession> {
  const s = await t.open()
  if (opts.hello ?? true) {
    const o = await s.hello({ token: opts.token ?? t.token })
    if (!o.ok) throw new Error(`gep.hello failed: ${o.error.code} ${o.error.message}`)
  }
  if (opts.heartbeats ?? true) s.startHeartbeats(1000)
  return s
}

export async function describe(s: GepSession): Promise<EngineDescribe> {
  const d = await s.call<EngineDescribe>('engine.describe', {})
  const v = validateEngineDescribe(d)
  expect(v.ok, v.ok ? '' : `engine.describe is not valid: ${JSON.stringify(v.issues)}`).toBe(true)
  return d
}

export async function fetchDescribe(t: Target): Promise<EngineDescribe> {
  const s = await connect(t, { heartbeats: false })
  try { return await describe(s) } finally { s.close() }
}

export function binding(accountId = PAPER_ACCOUNT, instruments: string[] = [BTC]) {
  return {
    bindingId: BINDING_ID,
    accounts: [{ accountId, mode: 'A' as const, mandateId: MANDATE_ID }],
    data: { source: 'host' as const, instruments },
    policies: [] as { policyId: string; version: number; digest: string }[],
    builder: { attachedBy: 'host' as const },
    heartbeatMs: 5000,
  }
}

export interface Boot { s: GepSession; d: EngineDescribe; instanceId: string; strategyId: string }

/** 模式 A 引导：hello → describe → bind → 订阅 → 启动第一个策略。引擎不支持策略则返回 instanceId = ''。 */
export async function boot(t: Target, opts: { startStrategy?: boolean; heartbeats?: boolean } = {}): Promise<Boot> {
  const s = await connect(t, { heartbeats: opts.heartbeats ?? true })
  const d = await describe(s)
  const b = binding()
  expect(validateBinding(b).ok).toBe(true)
  const bound = await s.call('engine.bind', b)
  expect((bound as { bindingId: string }).bindingId).toBe(BINDING_ID)
  await s.call('events.subscribe', { streams: ['signal', 'strategy', 'decision', 'log', 'health', 'backtest'], accountIds: [PAPER_ACCOUNT] })
  let instanceId = ''
  let strategyId = ''
  if ((opts.startStrategy ?? true) && d.capabilities['strategy'] === true) {
    const list = await s.call<{ strategies: { id: string }[] }>('strategy.list', {})
    strategyId = list.strategies[0]?.id ?? ''
    if (strategyId) {
      const started = await s.call<{ instanceId: string }>('strategy.start', { strategyId, accountId: PAPER_ACCOUNT, instruments: [BTC], interval: '1m', params: {}, mandateId: MANDATE_ID })
      instanceId = started.instanceId
    }
  }
  return { s, d, instanceId, strategyId }
}

export function candleEvents(candles: readonly Candle[], instrumentId = BTC) {
  return candles.map((c) => ({ stream: 'market' as const, type: 'market.candle', instrumentId, data: { interval: '1m', candle: c, closed: true } }))
}

let seedCounter = 100
/** 喂行情（宿主 → 引擎的 market 流）。返回喂入的 K 线。 */
export async function feed(t: Target, s: GepSession, count: number, opts: { batch?: number; seed?: number; start?: number; settle?: boolean; eventIds?: string[] } = {}): Promise<{ candles: Candle[]; eventIds: string[] }> {
  const candles = genCandles(opts.seed ?? seedCounter++, count, 60_000, opts.start ?? T0)
  const evs = candleEvents(candles).map((e, i) => (opts.eventIds?.[i] ? { ...e, eventId: opts.eventIds[i]! } : e))
  const ids: string[] = []
  const batch = opts.batch ?? 100
  for (let i = 0; i < evs.length; i += batch) {
    ids.push(...s.pushHostEvents(evs.slice(i, i + batch)))
    if (evs.length > batch) await sleep(5)
  }
  if (opts.settle ?? true) await sleep(t.timing.settleMs)
  return { candles, eventIds: ids }
}

export function placeCalls(t: Target) {
  return t.host.calls.filter((c) => c.method === 'host.order.place')
}

export function intentOf(call: { params: any }): any {
  return call.params?.intent ?? {}
}

/** 在健康状态下喂行情，看引擎是否会下单。不会下单则后续依赖下单行为的用例跳过（不是失败）。 */
export async function provokesOrders(t: Target, s: GepSession): Promise<boolean> {
  const before = placeCalls(t).length
  await feed(t, s, 60, { seed: 1 })
  await s.waitFor(() => placeCalls(t).length > before, 2000)
  return placeCalls(t).length > before
}

export const hex32 = (s: string): string => createHash('md5').update(s).digest('hex')

export const POLICY_ID = 'pol_01JABCCONF0000000000000001'

export function riskPolicy(version: number, maxOrderNotional: string) {
  const p = {
    policyId: POLICY_ID, version, scope: { type: 'account', id: PAPER_ACCOUNT },
    limits: { maxOrderNotional, maxSlippageBps: 50 },
    failClosed: { stalePriceMs: 5000, onMissingPrice: 'deny' },
    dailyResetAt: '00:00Z', valuationCcy: 'USDC',
    attestation: { method: 'system', by: 'gep-conformance-host', at: T0, digest: `sha256:${createHash('sha256').update('policy').digest('hex')}`, sig: 'c2ln' },
  }
  expect(validateRiskPolicy(p).ok, 'conformance policy fixture must itself be valid').toBe(true)
  return p
}

export function halt(level: 'halt_new' | 'cancel_all' | 'flatten_all', takeoverId = 'tko_01JABCCONF1') {
  return { takeoverId, level, scope: { accountIds: [PAPER_ACCOUNT] }, reason: 'conformance takeover', deadlineMs: 200 }
}

export function allEventsJson(s: GepSession): string {
  return JSON.stringify(s.events)
}

export { canonicalize, GepSession, sleep }
export type { GepEvent }
