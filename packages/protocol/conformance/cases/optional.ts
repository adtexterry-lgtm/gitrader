// SPDX-License-Identifier: Apache-2.0
// 可选（按能力位）：O1–O8。
import Ajv2020 from 'ajv/dist/2020'
import { expect } from 'vitest'
import { canonicalize, missingBacktestAssumptions, validateBacktestResult, validateBySchemaId, gepId, type BacktestSpec } from '../../src'
import { BTC, T0 } from '../host-sim'
import type { GepSession } from '../session'
import { sleep } from '../session'
import { boot, connect, describe, type Case } from './common'

async function firstStrategy(s: GepSession): Promise<string> {
  const list = await s.call<{ strategies: { id: string; version: string }[] }>('strategy.list', {})
  expect(list.strategies.length, 'strategy.list is not empty').toBeGreaterThan(0)
  return list.strategies[0]!.id
}

export function backtestSpec(strategyId: string, version = '0.1.0', bars = 2000): BacktestSpec {
  return {
    subject: { strategy: { id: strategyId, version, params: {} } },
    instruments: [BTC], interval: '1m', from: T0, to: T0 + bars * 60_000, data: { source: 'host' },
    account: { initialBalance: '10000' as never, ccy: 'USDC' },
    assumptions: { fees: 'venue', slippageBps: 2, fillModel: 'next-bar-open', funding: false, liquidation: false },
    seed: 42,
  }
}

async function runToDone(s: GepSession, spec: BacktestSpec, timeoutMs = 60_000): Promise<{ jobId: string; result: any }> {
  const { jobId } = await s.call<{ jobId: string }>('backtest.run', { spec })
  const end = Date.now() + timeoutMs
  for (;;) {
    const st = await s.call<{ state: string; progress: number }>('backtest.status', { jobId })
    if (st.state === 'done') break
    if (st.state === 'failed' || st.state === 'cancelled') throw new Error(`backtest ended as ${st.state}`)
    if (Date.now() > end) throw new Error('backtest timeout')
    await sleep(50)
  }
  return { jobId, result: await s.call('backtest.result', { jobId }) }
}

export const OPTIONAL_CASES: Case[] = [
  {
    id: 'O1', title: '策略往返：list / params（合法 JSON Schema）/ start / stop / status 全通', requires: ['strategy'],
    async run(t) {
      const { s, strategyId, instanceId } = await boot(t)
      const p = await s.call<{ schema: Record<string, unknown>; defaults: Record<string, unknown> }>('strategy.params', { strategyId })
      const ajv = new Ajv2020({ strict: false })
      const validate = ajv.compile(p.schema)
      expect(validate(p.defaults), 'defaults satisfy the strategy parameter schema').toBe(true)
      const st = await s.call<{ instances: { instanceId: string; status: string }[] }>('strategy.status', {})
      expect(st.instances.find((i) => i.instanceId === instanceId)?.status).toBe('running')
      const stopped = await s.call<{ status: string }>('strategy.stop', { instanceId })
      expect(stopped.status).toBe('stopped')
      const st2 = await s.call<{ instances: { instanceId: string; status: string }[] }>('strategy.status', { instanceId })
      expect(st2.instances[0]?.status).toBe('stopped')
      s.close()
    },
  },
  {
    id: 'O2', title: '热改参数：strategy.update 不重启即生效', requires: ['strategy', 'strategy.hotUpdate'],
    async run(t, skip) {
      const { s, instanceId } = await boot(t)
      if (!instanceId) skip('engine has no strategy to drive')
      const before = await s.call<{ instances: { instanceId: string; startedAt?: number; params: Record<string, unknown> }[] }>('strategy.status', { instanceId })
      const r = await s.call<{ status: string; appliedAt: number }>('strategy.update', { instanceId, params: { size: '0.002' } })
      expect(typeof r.appliedAt).toBe('number')
      const after = await s.call<{ instances: { instanceId: string; startedAt?: number; params: Record<string, unknown> }[] }>('strategy.status', { instanceId })
      expect(after.instances[0]?.instanceId).toBe(instanceId)
      expect(after.instances[0]?.params['size']).toBe('0.002')
      expect(after.instances[0]?.startedAt, 'instance was not restarted').toBe(before.instances[0]?.startedAt)
      s.close()
    },
  },
  {
    id: 'O3', title: '回测确定性：合成夹具 2,000 根 + 固定种子，两次结果逐字节一致，假设五项齐全', requires: ['backtest'],
    async run(t) {
      const s = await connect(t)
      const strategyId = (await describe(s)).strategies?.[0]?.id ?? (await firstStrategy(s))
      const spec = backtestSpec(strategyId)
      const a = await runToDone(s, spec)
      const b = await runToDone(s, spec)
      for (const r of [a.result, b.result]) {
        const v = validateBacktestResult(r)
        expect(v.ok, v.ok ? '' : JSON.stringify(v.issues)).toBe(true)
        expect(missingBacktestAssumptions(r.assumptions)).toEqual([])
      }
      const strip = (r: Record<string, unknown>) => { const { jobId: _j, ...rest } = r; return canonicalize(rest) }
      expect(strip(a.result), 'two runs with the same spec and seed are byte-identical').toBe(strip(b.result))
      s.close()
    },
  },
  {
    id: 'O4', title: '回测长任务：run 立即返回 jobId，进度单调，cancel 5 s 内生效', requires: ['backtest'],
    async run(t) {
      const s = await connect(t)
      const strategyId = (await describe(s)).strategies?.[0]?.id ?? (await firstStrategy(s))
      const t0 = Date.now()
      const { jobId } = await s.call<{ jobId: string }>('backtest.run', { spec: backtestSpec(strategyId) })
      expect(Date.now() - t0, 'backtest.run returns immediately').toBeLessThan(1500)
      let last = -1
      for (let i = 0; i < 200; i++) {
        const st = await s.call<{ state: string; progress: number }>('backtest.status', { jobId })
        expect(st.progress).toBeGreaterThanOrEqual(last)
        last = st.progress
        if (st.state === 'done') break
        await sleep(30)
      }
      const second = await s.call<{ jobId: string }>('backtest.run', { spec: backtestSpec(strategyId, '0.1.0', 4000) })
      const c0 = Date.now()
      await s.call('backtest.cancel', { jobId: second.jobId })
      let state = ''
      while (Date.now() - c0 < 5000) {
        state = (await s.call<{ state: string }>('backtest.status', { jobId: second.jobId })).state
        if (state === 'cancelled' || state === 'done') break
        await sleep(50)
      }
      expect(['cancelled', 'done'], 'cancel takes effect within 5 s').toContain(state)
      s.close()
    },
  },
  {
    id: 'O5', title: '回放：1,440 根回放的成交序列与同成交模型回测一致', requires: ['replay'],
    async run(_t, skip) {
      skip('契约没有规定回放的成交序列经哪个流 / 方法交付（见 OPEN-QUESTIONS），无法写出可判定的用例')
    },
  },
  {
    id: 'O6', title: '自带行情：market.* 输出过 schema', requires: ['market.own'],
    async run(t) {
      const s = await connect(t)
      const snap = await s.call('market.snapshot', { type: 'quote', instrumentId: BTC })
      expect(validateBySchemaId(gepId('Methods') + '#/$defs/market.snapshot:result', snap).ok).toBe(true)
      const h = await s.call('market.history', { instrumentId: BTC, interval: '1m', limit: 100 })
      expect(validateBySchemaId(gepId('Methods') + '#/$defs/market.history:result', h).ok).toBe(true)
      s.close()
    },
  },
  {
    id: 'O7', title: '性能冒烟：1,000 次 engine.health 往返（只记录数字，不作准入）',
    async run(t) {
      const s = await connect(t)
      const times: number[] = []
      for (let i = 0; i < 1000; i++) {
        const t0 = performance.now()
        const o = await s.request('engine.health', {})
        times.push(performance.now() - t0)
        expect(o.ok).toBe(true)
      }
      times.sort((a, b) => a - b)
      const p95 = times[Math.floor(times.length * 0.95)]!
      const p50 = times[Math.floor(times.length * 0.5)]!
      PERF.healthRoundTrip = { transport: t.kind, p50Ms: Math.round(p50 * 1000) / 1000, p95Ms: Math.round(p95 * 1000) / 1000, targetP95Ms: t.kind === 'stdio' ? 10 : 5 }
      s.close()
    },
  },
  {
    id: 'O8', title: '大载荷：>1 MB 的结果经 host.artifact.put 交付', requires: ['backtest'],
    async run(_t, skip) {
      skip('触发 >1 MB 结果需要引擎特定的大规格回测，套件无法通用地构造（见 OPEN-QUESTIONS）')
    },
  },
]

/** O7 的数字，写进报告。 */
export const PERF: Record<string, unknown> = {}

