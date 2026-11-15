// SPDX-License-Identifier: CPAL-1.0
// Agent 面（api/agent.ts）：17 个工具的内核侧操作。MCP 服务器经 HTTP 调这些操作；这里直接走 OpRegistry（同一条鉴权 / 盖章路径）。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { OrderIntent } from '../src/proto'
import { BTC } from './helpers/fake-connector'
import { enableLive, makeAgent, makeHarness } from './helpers/harness'
import type { Harness, TestAgent } from './helpers/harness'

let h: Harness
beforeEach(async () => { h = await makeHarness() })
afterEach(async () => { await h.cleanup() })

const RID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d'
interface Reply { data: any; session: any } // eslint-disable-line @typescript-eslint/no-explicit-any
const call = async (a: TestAgent, tool: string, params: Record<string, unknown> = {}): Promise<Reply> =>
  (await h.k.ops.call(h.k, `agent.${tool}`, { principal: a.principal, params: { requestId: RID, ...params }, transport: 'http' })) as Reply
const intent = (o: Partial<OrderIntent> = {}): OrderIntent => ({ accountId: h.paper.accountId as never, instrumentId: BTC, side: 'buy', type: 'market', size: '0.003' as never, leverage: 2, reason: 'funding flipped', ...o } as OrderIntent)
const liveIntent = (o: Partial<OrderIntent> = {}): OrderIntent => intent({ accountId: h.liveAcct.accountId as never, ...o })

describe('鉴权与盖章', () => {
  it('只有 Agent 钥匙能调 agent.*；人面会话 / service 令牌调不了', async () => {
    await expect(h.k.ops.call(h.k, 'agent.market', { principal: h.session, params: { action: 'search' }, transport: 'http' })).rejects.toMatchObject({ problem: { name: 'AUTH_FAILED' } })
    await expect(h.k.ops.call(h.k, 'agent.market', { principal: { kind: 'service' }, params: { action: 'search' }, transport: 'http' })).rejects.toMatchObject({ problem: { name: 'AUTH_FAILED' } })
  })

  it('origin 由内核盖章：actorType = llm-agent、tool = 工具名、via = mcp、requestId = MCP 给的 UUID；入参里自报的 actor 被忽略', async () => {
    const a = await makeAgent(h, 'paper')
    const r = await call(a, 'order', { action: 'place', intent: intent(), actor: 'user:usr_local', actorType: 'human', origin: { actor: 'user:usr_local', actorType: 'human' } })
    expect(r.data.order.status).toBe('filled')
    expect(r.data.order.origin).toEqual({ actor: `agent:${a.keyId}`, actorType: 'llm-agent', tool: 'order', requestId: RID, via: 'mcp' })
    const entries = h.k.ledger.query({ orderId: r.data.order.orderId })
    expect(entries.length).toBeGreaterThan(0)
    expect(new Set(entries.filter((e) => e.origin.actor.startsWith('agent:')).map((e) => e.origin.actorType))).toEqual(new Set(['llm-agent']))
    expect(entries.find((e) => e.type === 'order.intent')!.origin).toMatchObject({ actor: `agent:${a.keyId}`, tool: 'order', requestId: RID, via: 'mcp' })
  })

  it('requestId 格式不对就用内核生成的，不会写进账本一个任意字符串', async () => {
    const a = await makeAgent(h, 'paper')
    const r = await call(a, 'order', { action: 'place', intent: intent(), requestId: 'not-a-uuid' })
    expect(r.data.order.origin.requestId).toMatch(/^[0-9a-f-]{36}$/)
    expect(r.data.order.origin.requestId).not.toBe('not-a-uuid')
  })

  it('每次返回都带 session（当前级别与应加载的工具），不需要轮询', async () => {
    const a = await makeAgent(h, 'paper')
    const r = await call(a, 'market', { action: 'search', query: 'BTC' })
    expect(r.session).toMatchObject({ keyId: a.keyId, level: 'L1', tier: 'paper' })
    expect(r.session.tools).toHaveLength(16)
    const s = (await h.k.ops.call(h.k, 'agent.session', { principal: a.principal, params: {}, transport: 'http' })) as { tools: string[] }
    expect(s.tools).toEqual(r.session.tools)
  })
})

describe('按级别加载与服务端放行', () => {
  it('L0：13 个工具；propose / proposals / order 没加载，调用被内核拒绝（2003）', async () => {
    const a = await makeAgent(h, 'read_only')
    const s = (await h.k.ops.call(h.k, 'agent.session', { principal: a.principal, params: {}, transport: 'http' })) as { tools: string[]; level: string }
    expect(s.level).toBe('L0')
    expect(s.tools).toHaveLength(13)
    expect(s.tools).not.toContain('order')
    await expect(call(a, 'order', { action: 'place', intent: intent() })).rejects.toMatchObject({ problem: { code: 2003 } })
    await expect(call(a, 'propose', { action: 'order', accountId: h.paper.accountId, intents: [intent()], reason: 'x' })).rejects.toMatchObject({ problem: { code: 2003 } })
  })

  it('workspace 只在人打开"允许 Agent 调整布局"后才加载', async () => {
    const a = await makeAgent(h, 'paper')
    await expect(call(a, 'workspace', { action: 'list' })).rejects.toMatchObject({ problem: { code: 2003, message: expect.stringMatching(/allow Agent to adjust layout/) } })
    h.k.settings.setAgentLayout(true)
    const r = await call(a, 'workspace', { action: 'list' })
    expect(r.session.tools).toContain('workspace')
    expect(r.session.tools).toHaveLength(17)
  })

  it('未知动作报出有效动作列表；没有 approve / reject（提案的批准只在人面）', async () => {
    const a = await makeAgent(h, 'paper')
    await expect(call(a, 'proposals', { action: 'approve', proposalId: 'x' })).rejects.toMatchObject({ problem: { code: -32602, message: expect.stringMatching(/valid: get, list, withdraw/) } })
    await expect(call(a, 'proposals', { action: 'reject', proposalId: 'x' })).rejects.toMatchObject({ problem: { code: -32602 } })
  })

  it('账户必须在授权书覆盖范围内', async () => {
    const a = await makeAgent(h, 'paper', { accounts: [h.paper.accountId as never] })
    await expect(call(a, 'account', { action: 'summary', accountId: h.liveAcct.accountId })).rejects.toMatchObject({ problem: { name: 'MANDATE_LIMIT' } })
    const ok = await call(a, 'account', { action: 'summary' }) // 只有一个账户时 accountId 可省略
    expect(ok.data.accountId).toBe(h.paper.accountId)
  })
})

describe('纸面闭环与大模型实盘开仓保护', () => {
  it('纸面下单成交，账本 order.* 条目带 llm-agent origin，可按 origin.actorType 过滤', async () => {
    const a = await makeAgent(h, 'paper')
    const r = await call(a, 'order', { action: 'place', intent: intent() })
    expect(r.data.order).toMatchObject({ status: 'filled', accountId: h.paper.accountId })
    const q = await call(a, 'ledger', { action: 'query', filter: { 'origin.actorType': 'llm-agent', accountId: h.paper.accountId }, limit: 50 })
    expect(q.data.items.length).toBeGreaterThan(0)
    expect(q.data.items.every((e: any) => e.origin.actorType === 'llm-agent')).toBe(true) // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(q.data.items.some((e: any) => e.type === 'order.intent' && e.origin.requestId === RID)).toBe(true) // eslint-disable-line @typescript-eslint/no-explicit-any
    const human = await call(a, 'ledger', { action: 'query', filter: { 'origin.actorType': 'human' } })
    expect(human.data.items.every((e: any) => e.origin.actorType === 'human')).toBe(true) // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(human.data.items.some((e: any) => e.origin.actor.startsWith('agent:'))).toBe(false) // eslint-disable-line @typescript-eslint/no-explicit-any
    const trace = await call(a, 'ledger', { action: 'trace', id: r.data.order.orderId })
    expect(trace.data.items.map((e: any) => e.type)).toEqual(expect.arrayContaining(['order.intent', 'order.accepted'])) // eslint-disable-line @typescript-eslint/no-explicit-any
    const stats = await call(a, 'ledger', { action: 'stats' })
    expect(stats.data.byActorType['llm-agent']).toBeGreaterThan(0)
  })

  it('L3 钥匙预览实盘开仓：默认被 denyLlmLiveEntries 拒绝，规则名（LLM_LIVE_ENTRY）原样返回、不发 confirmToken', async () => {
    await enableLive(h)
    const a = await makeAgent(h, 'auto_limited')
    const r = await call(a, 'order', { action: 'preview', intent: liveIntent() })
    expect(r.data.confirmToken).toBeUndefined()
    expect(r.data.precheck.verdict).toBe('deny')
    expect(r.data.precheck.ruleHits).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'LLM_LIVE_ENTRY', ruleId: expect.stringMatching(/#denyLlmLiveEntries$/), action: 'deny' })]))
    expect(h.live.submitted).toHaveLength(0)
    const rs = await call(a, 'risk_status', { action: 'state' })
    expect(rs.data.denyLlmLiveEntries).toBe(true)
  })

  it('L2 钥匙：实盘只能提案；提案进待批，Agent 查得到、撤得回，批准不在工具面', async () => {
    await enableLive(h)
    const a = await makeAgent(h, 'confirm')
    await expect(call(a, 'order', { action: 'preview', intent: liveIntent() })).rejects.toMatchObject({ problem: { code: 2003, message: expect.stringMatching(/propose/) } })
    const p = await call(a, 'propose', { action: 'order', accountId: h.liveAcct.accountId, intents: [{ ...liveIntent(), accountId: undefined }], reason: 'funding flipped negative' })
    expect(p.data.status).toBe('pending')
    expect(p.data.origin).toMatchObject({ actor: `agent:${a.keyId}`, actorType: 'llm-agent', tool: 'propose', via: 'mcp', requestId: RID })
    const got = await call(a, 'proposals', { action: 'get', ticket: p.data.ticket })
    expect(got.data.proposalId).toBe(p.data.proposalId)
    const list = await call(a, 'proposals', { action: 'list', status: 'pending' })
    expect(list.data.items).toHaveLength(1)
    const w = await call(a, 'proposals', { action: 'withdraw', proposalId: p.data.proposalId })
    expect(w.data.status).toBe('withdrawn')
    expect(h.live.submitted).toHaveLength(0)
  })

  it('别的钥匙的提案看不到', async () => {
    await enableLive(h)
    const a = await makeAgent(h, 'confirm')
    const b = await makeAgent(h, 'confirm')
    const p = await call(a, 'propose', { action: 'order', accountId: h.liveAcct.accountId, intents: [liveIntent()], reason: 'x' })
    await expect(call(b, 'proposals', { action: 'get', proposalId: p.data.proposalId })).rejects.toMatchObject({ problem: { code: -32602 } })
    expect((await call(b, 'proposals', { action: 'list' })).data.items).toEqual([])
  })

  it('撤单 / 平仓走内核的下单流水线（同样过风控闸）', async () => {
    const a = await makeAgent(h, 'paper')
    await call(a, 'order', { action: 'place', intent: intent() })
    h.sim.positions.set(h.paper.accountId, [{ accountId: h.paper.accountId as never, instrumentId: BTC, side: 'long', size: '0.003' as never, entryPrice: '80000' as never, markPrice: '80000' as never } as never])
    const c = await call(a, 'order', { action: 'close', accountId: h.paper.accountId, instrumentId: BTC, reason: 'take profit' })
    expect(c.data.order.reduceOnly).toBe(true)
    expect(c.data.order.origin).toMatchObject({ tool: 'order', actorType: 'llm-agent' })
  })
})

describe('自保动作与只读', () => {
  it('takeover：默认作用域 = 自己的授权书；reason 必填；账本记 takeover.* 带 llm-agent', async () => {
    const a = await makeAgent(h, 'paper')
    await expect(call(a, 'takeover', { action: 'halt_new' })).rejects.toMatchObject({ problem: { code: -32602 } })
    const r = await call(a, 'takeover', { action: 'halt_new', reason: 'unexpected funding spike' })
    expect(r.data).toMatchObject({ level: 'halt_new', ok: true })
    expect(h.k.ledger.query({ types: ['takeover.requested'] })[0]!.origin).toMatchObject({ actorType: 'llm-agent', tool: 'takeover' })
    const rs = await call(a, 'risk_status', { action: 'state' })
    expect(rs.data.tradingState).toBeDefined()
    await expect(call(a, 'takeover', { action: 'halt_new', reason: 'x', scope: { type: 'org' } })).rejects.toMatchObject({ problem: { name: 'MANDATE_LIMIT' } })
  })

  it('mandate：status / heartbeat / downgrade（只降不升，降级后仍可用）/ request_promotion（只留记录）', async () => {
    const a = await makeAgent(h, 'confirm')
    const st = await call(a, 'mandate', { action: 'status' })
    expect(st.data).toMatchObject({ level: 'L2', tier: 'confirm', denyLlmLiveEntries: true })
    expect((await call(a, 'mandate', { action: 'heartbeat' })).data.ok).toBe(true)
    await expect(call(a, 'mandate', { action: 'downgrade', level: 'L4' })).rejects.toMatchObject({ problem: { code: -32602 } })
    const d = await call(a, 'mandate', { action: 'downgrade', level: 'L1', reason: 'done for today' })
    expect(d.data.level).toBe('L1')
    expect(d.session.level).toBe('L1') // 降级后授权书仍然有效，不会被当成 L0
    expect(d.session.tools).toHaveLength(16)
    const pr = await call(a, 'mandate', { action: 'request_promotion', reason: 'stable for two weeks' })
    expect(pr.data.recorded).toBe(true)
    expect(h.k.ledger.query({ types: ['annotation'] }).some((e) => (e.payload as { kind?: string })?.kind === 'promotion_request')).toBe(true)
  })

  it('discover：分组、单个工具说明、能力', async () => {
    const a = await makeAgent(h, 'read_only')
    const g = await call(a, 'discover', { action: 'groups' })
    expect(Object.keys(g.data.groups).sort()).toEqual(['E', 'P', 'R', 'S', 'W'])
    expect(g.data.groups.E).toEqual([{ tool: 'order', loaded: false }])
    const t = await call(a, 'discover', { action: 'tool_help', tool: 'order' })
    expect(t.data.description).toMatch(/LLM 实盘开仓默认被策略拒绝/)
    const c = await call(a, 'discover', { action: 'capabilities' })
    expect(c.data.accounts.length).toBe(2)
  })

  it('market / account / risk_status 只读面', async () => {
    const a = await makeAgent(h, 'paper')
    h.live.setMark(BTC, '80123') // 行情来自账户所属场所的连接器（纸面账户也用被模拟场所的行情）
    expect((await call(a, 'market', { action: 'search', query: 'btc' })).data.items[0].instrumentId).toBe(BTC)
    expect((await call(a, 'market', { action: 'quote', instrumentId: BTC })).data.last).toBe(80123)
    expect((await call(a, 'market', { action: 'venue_status' })).data.length).toBeGreaterThan(0)
    expect((await call(a, 'account', { action: 'list' })).data).toHaveLength(2)
    const sum = await call(a, 'account', { action: 'summary', accountId: h.paper.accountId })
    expect(sum.data.equity).toBeDefined()
    expect((await call(a, 'account', { action: 'balances', accountId: h.paper.accountId })).data.balances).toBeDefined()
    expect((await call(a, 'account', { action: 'margin', accountId: h.paper.accountId })).data.margin.equity).toBeDefined()
    expect((await call(a, 'risk_status', { action: 'usage' })).data.accounts).toHaveLength(2)
    expect((await call(a, 'risk_status', { action: 'rules' })).data.limits).toBeDefined()
  })
})

describe('实验 / 笔记 / 插件，以及内核暂未接的 GEP 宿主层', () => {
  it('note 与 experiment 的增删查改；实验过协议 schema 校验', async () => {
    const a = await makeAgent(h, 'read_only')
    await call(a, 'note', { action: 'add', text: 'funding turned negative while price held', tags: ['funding'] })
    const notes = await call(a, 'note', { action: 'list' })
    expect(notes.data.items[0].payload.text).toMatch(/funding turned negative/)
    expect(notes.data.items[0].origin).toMatchObject({ tool: 'note', actorType: 'llm-agent' })
    const e = await call(a, 'experiment', { action: 'create', patch: { title: 'EMA trend', hypothesis: 'trend holds on 4h' } })
    expect(e.data).toMatchObject({ title: 'EMA trend', stage: 'hypothesis' })
    const id = e.data.experimentId
    expect((await call(a, 'experiment', { action: 'get', experimentId: id })).data.title).toBe('EMA trend')
    await expect(call(a, 'experiment', { action: 'update', experimentId: id, patch: { stage: 'holdout' } })).rejects.toMatchObject({ problem: { name: 'EXPERIMENT_FIELD_READONLY' } })
    expect((await call(a, 'experiment', { action: 'list' })).data.items).toHaveLength(1)
    await expect(call(a, 'experiment', { action: 'stage', experimentId: id, to: 'nonsense' })).rejects.toMatchObject({ problem: { name: 'EXPERIMENT_TRANSITION_DENIED' } })
  })

  it('没有连上的引擎时，回测 / 策略控制如实报错（VENUE_UNAVAILABLE），工作流仍是 5002，不装作成功', async () => {
    const a = await makeAgent(h, 'paper')
    await expect(call(a, 'backtest', { action: 'run', spec: {} })).rejects.toMatchObject({ problem: { name: 'VENUE_UNAVAILABLE' } })
    // workflow 已退出 Agent 工具面（fix-r6 R3-05）：不再是 5002，而是未知操作 METHOD_NOT_FOUND
    await expect(call(a, 'workflow', { action: 'list' })).rejects.toMatchObject({ problem: { name: 'METHOD_NOT_FOUND' } })
    await expect(call(a, 'engines', { action: 'start_strategy', strategyId: 'x', accountId: h.paper.accountId })).rejects.toMatchObject({ problem: { name: 'VENUE_UNAVAILABLE' } })
    expect(Array.isArray((await call(a, 'engines', { action: 'list' })).data)).toBe(true)
  })

  it('plugins.list / describe 走插件宿主', async () => {
    const a = await makeAgent(h, 'read_only')
    expect(Array.isArray((await call(a, 'plugins', { action: 'list' })).data)).toBe(true)
    await expect(call(a, 'plugins', { action: 'describe', pluginId: 'nope' })).rejects.toMatchObject({ problem: { code: -32602 } })
  })
})
