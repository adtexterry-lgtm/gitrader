// SPDX-License-Identifier: CPAL-1.0
// 工作流 JSON 运行器经 GEP 对外：节点库 / 模板 / 校验 / 回测（backtest.run 的 workflow 主体）/ 实时运行 / 运行时值。
import { afterEach, describe, expect, it } from 'vitest'
import { T0 } from '../../protocol/conformance/host-sim'
import { BLANK_WORKFLOW } from '../src/flow'
import { WORKFLOW_TEMPLATES, templateOf } from './fixtures/workflow-templates'
import { rig, bindPaper, BTC, PAPER_ACCOUNT, MANDATE_ID, type Rig } from './harness'

let r: Rig | null = null
afterEach(() => { r?.close(); r = null })

const EMA_WF = templateOf('ema-trend')!
const RUN = { workflow: EMA_WF, target: 'paper', accountId: PAPER_ACCOUNT, instrumentId: BTC, interval: '1m', params: { fast: 5, slow: 20 }, mandateId: MANDATE_ID }
const spec = (subject: unknown, to = T0 + 2000 * 60_000): Record<string, unknown> => ({
  subject, instruments: [BTC], interval: '1m', from: T0, to, data: { source: 'host' }, account: { initialBalance: '10000', ccy: 'USDC' },
  assumptions: { fees: 'venue', slippageBps: 2, fillModel: 'next-bar-open', funding: false, liquidation: false }, seed: 1,
})
async function done(jobId: string): Promise<any> {
  for (let i = 0; i < 400; i++) {
    const st = await r!.session.call('backtest.status', { jobId })
    if (st.state === 'done') return r!.session.call('backtest.result', { jobId })
    if (st.state === 'failed') throw new Error('failed: ' + JSON.stringify(await r!.session.expectError('backtest.result', { jobId })))
    await new Promise((res) => setTimeout(res, 20))
  }
  throw new Error('timeout')
}

describe('工作流 JSON 作为一等接口', () => {
  it('能力位 x-gitrader.workflow 已声明；节点库不含已删除的 LLM 节点', async () => {
    r = await rig()
    const d = await r.session.call('engine.describe', {})
    expect(d.capabilities['x-gitrader.workflow']).toBe(true)
    const n = await r.session.call('x-gitrader.workflow.nodes', {})
    expect(n.nodes.some((x: { kind: string }) => x.kind === 'model.research')).toBe(false)
    expect(n.nodes.some((x: { kind: string }) => x.kind === 'model.decision')).toBe(true)
    expect(Object.keys(n.portTypes)).toEqual(['series', 'number', 'bool', 'signal', 'order', 'any'])
    // 引擎不带工作流库，只给一个空白骨架
    const t = await r.session.call('x-gitrader.workflow.blank', {})
    expect(t.workflow).toEqual(BLANK_WORKFLOW)
    const v = await r.session.call('x-gitrader.workflow.validate', { workflow: t.workflow })
    expect(v.valid).toBe(true)
    expect(v.backtestable).toBe(true)
    expect((await r.session.call('x-gitrader.workflow.nodes', {})).nodes.length).toBeGreaterThan(20)
  })

  it('validate：好的通过；坏的给出可读的错误（缺必填输入 / 类型不匹配 / 成环 / 实时节点不能回测）', async () => {
    r = await rig()
    const tpl = WORKFLOW_TEMPLATES[0]!
    const ok = await r.session.call('x-gitrader.workflow.validate', { workflow: tpl })
    expect(ok.valid).toBe(true)
    expect(ok.backtestable).toBe(true)
    expect(ok.primarySignal).toEqual({ node: 'sig', port: 'signal' })
    const bad = JSON.parse(JSON.stringify(tpl))
    bad.edges = bad.edges.filter((e: { to: { node: string; port: string } }) => !(e.to.node === 'f_gt_s' && e.to.port === 'b'))
    const v = await r.session.call('x-gitrader.workflow.validate', { workflow: bad })
    expect(v.valid).toBe(false)
    expect(v.errors.map((e: { message: string }) => e.message).join('|')).toMatch(/必填输入 b/)
    const live = JSON.parse(JSON.stringify(tpl))
    live.nodes.push({ id: 'pos', type: 'data.position', params: {} })
    const l = await r.session.call('x-gitrader.workflow.validate', { workflow: live })
    expect(l.valid).toBe(true)
    expect(l.backtestable).toBe(false)
    expect(l.backtestBlockers.join('|')).toMatch(/实时节点/)
    const schemaBad = await r.session.call('x-gitrader.workflow.validate', { workflow: { schema: 'gitrader-workflow/1' } })
    expect(schemaBad.valid).toBe(false)
  })

  it('backtest.run 的 workflow 主体：模板回测与同名策略回测逐笔一致；含实时节点的图被拒（-32602）', async () => {
    r = await rig()
    const a = await done((await r.session.call('backtest.run', { spec: spec({ strategy: { id: 'ema-trend', version: '0.1.0', params: {} } }) })).jobId)
    const b = await done((await r.session.call('backtest.run', { spec: spec({ workflow: { id: 'tpl.ema-trend', version: 1, json: EMA_WF } }) })).jobId)
    expect(a.trades.length).toBeGreaterThan(0)
    // 理由文案两条路径各写各的，其余（时间 / 方向 / 价 / 量 / 费 / 盈亏）逐笔一致
    const core = (t: Record<string, unknown>[]): unknown[] => t.map(({ reason: _r, ...rest }) => rest)
    expect(core(b.trades)).toEqual(core(a.trades))
    expect(b.stats).toEqual(a.stats)
    expect(b.biasChecks.lookahead).toBe('pass')
    const noJson = await r.session.expectError('backtest.run', { spec: spec({ workflow: { id: 'tpl.ema-trend', version: 1 } }) })
    expect(noJson.code).toBe(-32602)
    const live = JSON.parse(JSON.stringify(WORKFLOW_TEMPLATES[0]))
    live.nodes.push({ id: 'pos', type: 'data.position', params: {} })
    const e = await r.session.expectError('backtest.run', { spec: spec({ workflow: { id: live.id, version: 1, json: live } }) })
    expect(e.code).toBe(-32602)
    expect(e.message).toMatch(/cannot be backtested/)
  })

  it('实时运行：意图走 host.order.place，来源带节点类型 / 工作流 / 节点 id；运行时值可读；停止不平仓', async () => {
    r = await rig()
    await bindPaper(r)
    const { instanceId, status } = await r.session.call('x-gitrader.workflow.run', RUN)
    expect(status).toBe('running')
    expect(await r.session.waitFor(() => r!.host.placed.length >= 1, 3000)).toBe(true)
    const p = r.host.placed[0]!.params
    expect(p.origin.tool).toBe('node:act.order')
    expect(p.origin.causation).toMatchObject({ workflowId: 'tpl.ema-trend', nodeId: 'place', instanceId })
    expect(p.instanceId).toBe(instanceId)
    expect(p.intent.type).toBe('market')
    expect('builder' in p.intent).toBe(false)
    const pre = r.host.calls.filter((c) => c.method === 'host.risk.precheck')
    expect(pre.length).toBeGreaterThan(0) // 模板里「风控预检」节点真的问了宿主
    const v = await r.session.call('x-gitrader.workflow.values', { instanceId })
    expect(v.workflowId).toBe('tpl.ema-trend')
    expect(v.barIndex).toBeGreaterThan(0)
    expect(v.errors).toEqual([])
    expect(v.values.sig.signal.target).toBeTypeOf('number')
    expect(v.values.size.order.side).toMatch(/buy|sell/)
    const st = await r.session.call('strategy.status', { instanceId })
    expect(st.instances[0].strategyId).toBe('workflow:tpl.ema-trend')
    expect(st.instances[0]['x-kind']).toBe('workflow')
    const stopped = await r.session.call('strategy.stop', { instanceId })
    expect(stopped.status).toBe('stopped')
  })

  it('model.decision 没有决策提供方：节点报错，本轮不动作（失败即停），错误在运行时值里可见', async () => {
    r = await rig()
    await bindPaper(r)
    const wf = {
      schema: 'gitrader-workflow/2', id: 'wf-decide', name: '决策模型', version: 1, params: {}, meta: { source: { author: 'test', license: 'Apache-2.0' } },
      nodes: [{ id: 'm', type: 'model.decision', params: {} }, { id: 'o', type: 'act.signal', params: {} }, { id: 'size', type: 'risk.size', params: {} }, { id: 'place', type: 'act.order', params: {} }],
      edges: [{ from: { node: 'm', port: 'signal' }, to: { node: 'o', port: 'signal' } }, { from: { node: 'm', port: 'signal' }, to: { node: 'size', port: 'signal' } }, { from: { node: 'size', port: 'order' }, to: { node: 'place', port: 'order' } }],
    }
    const { instanceId } = await r.session.call('x-gitrader.workflow.run', { ...RUN, workflow: wf })
    await new Promise((res) => setTimeout(res, 400))
    const v = await r.session.call('x-gitrader.workflow.values', { instanceId })
    expect(v.errors.map((e: { message: string }) => e.message).join('|')).toMatch(/no decision provider/)
    expect(r.host.placed.length).toBe(0)
  })

  it('run 的输入校验：未绑定账户 1005、缺 JSON / 坏 JSON / 版本不符 -32602', async () => {
    r = await rig()
    expect((await r.session.expectError('x-gitrader.workflow.run', RUN)).code).toBe(1005)
    await bindPaper(r)
    expect((await r.session.expectError('x-gitrader.workflow.run', { ...RUN, workflow: undefined })).code).toBe(-32602)
    expect((await r.session.expectError('x-gitrader.workflow.run', { ...RUN, workflow: { schema: 'x' } })).code).toBe(-32602)
    expect((await r.session.expectError('x-gitrader.workflow.run', { ...RUN, version: 9 })).code).toBe(-32602)
    expect((await r.session.expectError('x-gitrader.workflow.run', { ...RUN, target: 'moon' })).code).toBe(-32602)
  })
})
