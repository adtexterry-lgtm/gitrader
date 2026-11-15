// SPDX-License-Identifier: CPAL-1.0
// R3-01：研究作业的引擎请求必须走 GepHost.callEngine 的方法白名单（CALLABLE）：research.* 能调通，白名单外的方法 METHOD_NOT_FOUND。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RESEARCH_CAPABILITY } from '../src/proto'
import { makeHarness } from './helpers/harness'
import type { Harness } from './helpers/harness'

let h: Harness
beforeEach(async () => { h = await makeHarness() })
afterEach(async () => { await h.cleanup() })

function fakeEngine(): { method: string; params: unknown }[] {
  const calls: { method: string; params: unknown }[] = []
  const conns = (h.k.gep as unknown as { conns: Map<string, unknown> }).conns
  conns.set('fake-engine', { engineId: 'fake-engine', state: 'ready', describe: { capabilities: { [RESEARCH_CAPABILITY]: true } }, rpc: { call: async (method: string, params: unknown) => { calls.push({ method, params }); return { ok: true } } } })
  return calls
}

describe('GepHost.callEngine 白名单与研究方法', () => {
  it('x-gitrader.research.* 经 callEngine 调通；readyEngineIds 按能力位挑引擎', async () => {
    const calls = fakeEngine()
    expect(h.k.gep.readyEngineIds(RESEARCH_CAPABILITY)).toEqual(['fake-engine'])
    expect(h.k.gep.readyEngineIds('no.such.capability')).toEqual([])
    for (const m of ['run', 'status', 'result', 'cancel']) await expect(h.k.gep.callEngine('fake-engine', `x-gitrader.research.${m}`, { jobId: 'j' })).resolves.toEqual({ ok: true })
    expect(calls.map((c) => c.method)).toEqual(['x-gitrader.research.run', 'x-gitrader.research.status', 'x-gitrader.research.result', 'x-gitrader.research.cancel'])
  })
  it('不在白名单里的方法一律 METHOD_NOT_FOUND，且没打到引擎', async () => {
    const calls = fakeEngine()
    for (const m of ['x-gitrader.research.drop', 'x-gitrader.other.run', 'host.order.place', 'order.place']) {
      await expect(h.k.gep.callEngine('fake-engine', m, {})).rejects.toMatchObject({ problem: { name: 'METHOD_NOT_FOUND' } })
    }
    expect(calls).toHaveLength(0)
  })
})
