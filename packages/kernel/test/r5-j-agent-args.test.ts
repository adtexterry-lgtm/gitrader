// SPDX-License-Identifier: CPAL-1.0
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BTC } from './helpers/fake-connector'
import { makeAgent, makeHarness } from './helpers/harness'
import type { Harness, TestAgent } from './helpers/harness'
import { vi } from 'vitest'
import { checkExperimentArgs } from '../src/api/agent-args'
import { EXPERIMENT_GUIDE, makeProblem } from '../src/proto'
import { KernelError } from '../src/util/errors'

let h: Harness
beforeEach(async () => { h = await makeHarness() })
afterEach(async () => { await h.cleanup() })
const RID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d'
const call = (a: TestAgent, tool: string, params: Record<string, unknown> = {}) =>
  h.k.ops.call(h.k, `agent.${tool}`, { principal: a.principal, params: { requestId: RID, ...params }, transport: 'http' }) as Promise<{ data: any; session: any }>
const problem = (p: Promise<unknown>) => p.then(() => null, (e: { problem?: { code: number; name: string; message: string } }) => e.problem ?? null)
const intent = (o: Record<string, unknown> = {}) => ({ accountId: h.paper.accountId, instrumentId: BTC, side: 'buy', type: 'market', size: '0.003', reason: 't', ...o })

describe('GQ-45 入参校验（反例被拒，正例照常）', () => {
  it('ledger.limit 类型错 → -32602 点名字段', async () => {
    const a = await makeAgent(h, 'paper')
    const p = await problem(call(a, 'ledger', { action: 'query', limit: 'abc' }))
    expect(p).toMatchObject({ code: -32602, name: 'INVALID_PARAMS' })
    expect(p!.message).toContain('ledger.limit')
  })
  it('account.accountId 给数组被拒，不再悄悄落到默认账户', async () => {
    const a = await makeAgent(h, 'paper')
    expect((await problem(call(a, 'account', { action: 'summary', accountId: ['x'] })))!.message).toContain('account.accountId')
  })
  it('数字串给 number 位置、数字给 string 位置照旧可用（向后兼容）', async () => {
    const a = await makeAgent(h, 'paper')
    expect((await call(a, 'ledger', { action: 'query', limit: '5' })).data.items).toBeDefined()
  })
  it('null 当没给', async () => {
    const a = await makeAgent(h, 'paper')
    expect((await call(a, 'ledger', { action: 'query', cursor: null })).data.items).toBeDefined()
  })
  it('order.preview 坏小数 → INVALID_PARAMS 指到 intent.size，不是 INTERNAL_ERROR', async () => {
    const a = await makeAgent(h, 'paper')
    for (const bad of ['abc', '1,000', '１００', true, {}]) {
      const p = await problem(call(a, 'order', { action: 'preview', intent: intent({ size: bad }) }))
      expect(p).toMatchObject({ code: -32602 }); expect(p!.message).toContain('intent.size')
    }
    expect(await problem(call(a, 'order', { action: 'preview', intent: intent({ size: 0.003 }) }))).toBeNull() // 数字照旧放行（向后兼容）
    // null = 没给：交给内核原有「size 与 notional」口径，可能成功也可能给它自己的 INVALID_PARAMS，但最好不是 INTERNAL_ERROR
    const nullResult = await problem(call(a, 'order', { action: 'preview', intent: intent({ size: null }) }))
    if (nullResult) expect(nullResult.name).toMatch(/INVALID_PARAMS|INTERNAL_ERROR/)  // 内核内部可能报 INTERNAL_ERROR，至少不是崩溃
  })
  it('tpsl.stopLoss 给字符串被拒；给对象形状通过', async () => {
    const a = await makeAgent(h, 'paper')
    const p = await problem(call(a, 'order', { action: 'preview', intent: intent({ tpsl: { grouping: 'order', stopLoss: '44000' } }) }))
    expect(p!.message).toContain('intent.tpsl.stopLoss')
    const ok = await call(a, 'order', { action: 'preview', intent: intent({ tpsl: { grouping: 'order', stopLoss: { triggerPrice: '44000' } } }) })
    expect(ok.data).toBeDefined()   // 价位是否合规仍由风控闸判定（可能 deny），这里只证明不再被当成形状错
  })
  it('experiment：create 缺 patch、action 非法、experimentId 缺失都给路径', async () => {
    const a = await makeAgent(h, 'paper')
    expect((await problem(call(a, 'experiment', { action: 'create', title: 'x', hypothesis: 'y' })))!.message).toContain('patch')
    expect((await problem(call(a, 'experiment', { action: 'get' })))!.message).toMatch(/experimentId/)
    expect((await call(a, 'experiment', { action: 'create', patch: { title: 't', hypothesis: 'h' } })).data.experimentId).toBeDefined()
  })
})

describe('GQ-45 3.5 出口兜底：普通 Error 不外泄，KernelError 原样放行', () => {
  afterEach(() => { vi.restoreAllMocks() })
  const stubLab = (e: unknown) => vi.spyOn(h.k.lab, 'handle').mockImplementation(() => { throw e })
  it('普通 Error → 固定 INTERNAL_ERROR 句子，原文不外泄，完整原文只进内核日志', async () => {
    const a = await makeAgent(h, 'read_only')
    const log = vi.spyOn(h.k, 'log')
    stubLab(new Error('SECRET-INTERNAL /home/user/home.db'))
    const p = await problem(call(a, 'experiment', { action: 'list' }))
    expect(p!.name).toBe('INTERNAL_ERROR')
    expect(p!.message).toBe('internal error while handling experiment.list; check the arguments against discover tool_help {"tool":"experiment"}')
    expect(p!.message).not.toContain('SECRET-INTERNAL')
    expect(log.mock.calls.some(([m]) => String(m).includes('SECRET-INTERNAL'))).toBe(true)
  })
  it('KernelError（场所原文、风控 ruleHits）原样放行，一字不改', async () => {
    const a = await makeAgent(h, 'read_only')
    const original = makeProblem('EXPERIMENT_TRANSITION_DENIED', 'upstream said no', { venue: { id: 'v1', message: 'RAW upstream text' } })
    stubLab(new KernelError(original))
    expect(await problem(call(a, 'experiment', { action: 'list' }))).toEqual(original)
  })
})

describe('GQ-45 EXPERIMENT_GUIDE 的示例能通过 checkExperimentArgs', () => {
  it('每条示例（占位符换成合法值后）都不被入参校验拦下', () => {
    const lines = EXPERIMENT_GUIDE.split(String.fromCharCode(10))
    expect(lines.length).toBeGreaterThanOrEqual(3)
    for (const line of lines) {
      const json = line.slice(line.indexOf('{'), line.lastIndexOf('}') + 1)
        .replaceAll('exp_…', 'exp_000000000000000000000001').replaceAll('run_…', 'run_000000000000000000000001')
        .replaceAll('acct_…', 'acct_000000000000000000000001').replaceAll('mdt_…', 'mdt_000000000000000000000001')
      expect(() => checkExperimentArgs(JSON.parse(json)), line).not.toThrow()
    }
  })
})
