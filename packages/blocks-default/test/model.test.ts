// SPDX-License-Identifier: CPAL-1.0
// 纯逻辑：持仓与盈亏 / 事件流与待批 / 风险与状态条。数据来自 fixtures/scenarios.ts（实体形状另有协议校验，见 fixtures.test.ts）。
import { describe, expect, it } from 'vitest'
import { ACCT_LIVE, KEY_CLAUDE, KEY_HERMES, MDT_CLAUDE, NOW, O_CLAUDE, O_ENGINE, O_HUMAN, O_SYSTEM, entry, scenario } from '../fixtures/scenarios'
import {
  actorNames, activityCounts, activityOf, applyProposal, decisionOutcome, entryToActivity, filterActivity, keyTiers, mergeActivity, normalizeProposals, pendingQueue, ruleText, toPending,
} from '../src/model-activity'
import {
  buildPositionChain, buildRows, computeTotals, executorOf, normalizeAccounts, proposalsOfPosition, normalizeFills, normalizeOrders, normalizePositions, normalizeSummary, positionsEvent, positionDelta, applyPositionDelta, summaryEvent,
} from '../src/model-positions'
import { budgetLevel, buildStatus, deriveUsage, leftoverOfEntry, limitRows, normalizeRisk, normalizeVenues, stateOfEvent, takeoverOutcome, toneOf, triggerRows } from '../src/model-risk'
import { formatCountdown, symbolOf, toNum } from '../src/util'

const sc = () => scenario('normal')
const snap = () => {
  const s = sc()
  const accounts = normalizeAccounts(s.accounts)
  const positions = Object.fromEntries(Object.entries(s.positions).map(([k, v]) => [k, normalizePositions(v)]))
  const orders = Object.fromEntries(Object.entries(s.orders).map(([k, v]) => [k, normalizeOrders(v)]))
  const summaries = Object.fromEntries(Object.entries(s.summaries).map(([k, v]) => [k, normalizeSummary(v)]))
  const fills = Object.fromEntries(Object.entries(s.fills).map(([k, v]) => [k, normalizeFills(v)]))
  const rows = buildRows(accounts, positions, orders)
  return { s, accounts, positions, orders, summaries, fills, rows }
}

describe('util', () => {
  it('toNum 只认有限数字与十进制字符串', () => {
    expect(toNum('12.5')).toBe(12.5)
    expect(toNum('')).toBeNull()
    expect(toNum('abc')).toBeNull()
    expect(toNum(null)).toBeNull()
    expect(toNum(Number.NaN)).toBeNull()
  })
  it('symbolOf 按第一个冒号切', () => {
    expect(symbolOf('hyperliquid:BTC')).toBe('BTC')
    expect(symbolOf('hyperliquid:xyz:TSLA')).toBe('xyz:TSLA')
    expect(symbolOf('BTC')).toBe('BTC')
  })
  it('倒计时：mm:ss / h:mm:ss / 已过期', () => {
    expect(formatCountdown(9 * 60_000 + 42_000)).toBe('09:42')
    expect(formatCountdown(3_661_000)).toBe('1:01:01')
    expect(formatCountdown(0)).toBe('已过期')
    expect(formatCountdown(-5)).toBe('已过期')
    expect(formatCountdown(999)).toBe('00:01')
  })
})

describe('持仓与盈亏', () => {
  it('规整：数组或 {key:数组} 都认，坏条目丢掉', () => {
    expect(normalizePositions({ positions: [{ instrumentId: 'a:X', size: '1' }, { size: '1' }, { instrumentId: 'a:Y' }] })).toHaveLength(1)
    expect(normalizeAccounts([{ accountId: 'acct_1', alias: 'A' }, { alias: 'x' }])).toEqual([{ accountId: 'acct_1', alias: 'A', mode: 'live', venue: '', environment: '' }])
    expect(normalizeSummary(null)).toBeNull()
    expect(normalizeFills({ fills: [{ accountId: 'a', ts: 5, realizedPnl: '2.5' }, { accountId: 'a' }] })).toHaveLength(1)
  })

  it('跨账户持仓表：按名义额降序，纸面账户带别名与近似强平价标记', () => {
    const { rows } = snap()
    expect(rows.map((r) => r.symbol)).toEqual(['BTC', 'SOL', 'ETH', 'xyz:TSLA'])
    const sol = rows.find((r) => r.symbol === 'SOL')!
    expect(sol.accountAlias).toBe('纸面账户')
    expect(sol.estimated).toBe(true)
    expect(rows.find((r) => r.symbol === 'BTC')!.estimated).toBe(false)
    expect(rows.find((r) => r.symbol === 'ETH')!.side).toBe('short')
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length)
  })

  it('执行方：同账户同标的同方向开仓单里最近一笔的来源；平仓单与别的标的不算', () => {
    const { rows, orders } = snap()
    expect(rows.find((r) => r.symbol === 'BTC')!.executor?.actor).toBe(`agent:${KEY_CLAUDE}`)
    expect(rows.find((r) => r.symbol === 'ETH')!.executor?.actor).toBe('strategy:ema-trend')
    expect(rows.find((r) => r.symbol === 'xyz:TSLA')!.executor?.actorType).toBe('human')
    const btc = rows.find((r) => r.symbol === 'BTC')!.position
    const base = orders[ACCT_LIVE]!
    const later = { ...base[0]!, reduceOnly: true, createdAt: base[0]!.createdAt + 10, origin: O_ENGINE }
    expect(executorOf(btc, [...base, later])?.actor).toBe(`agent:${KEY_CLAUDE}`)
    expect(executorOf(btc, [])).toBeNull()
  })

  it('今日盈亏：有当日基线时就是权益差（与日亏上限同口径），账户相加', () => {
    const { accounts, summaries, fills, rows } = snap()
    const t = computeTotals({ accounts, summaries, fills, rows }, NOW)
    expect(t.equity).toBeCloseTo(12480.2 + 9987.5, 6)
    expect(t.todayPnl).toBeCloseTo(128.4 - 12.5, 6)
    expect(t.approx).toBe(false)
    expect(t.todayPct).toBeCloseTo(((128.4 - 12.5) / (12351.8 + 10000)) * 100, 6)
    expect(t.unrealized).toBeCloseTo(53.58 + 17.28 + 0 - 42, 6)
  })

  it('今日盈亏：优先 dayPnl；都没有就退到今日已实现并标 approx（只算 UTC 今天的成交）', () => {
    const acct = [{ accountId: 'acct_x', alias: 'x', mode: 'live', venue: '', environment: '' }]
    const dayStart = Date.UTC(new Date(NOW).getUTCFullYear(), new Date(NOW).getUTCMonth(), new Date(NOW).getUTCDate())
    const a = computeTotals({ accounts: acct, summaries: { acct_x: { equity: 100, available: 1, dayStartEquity: 90, dayPnl: 7 } }, fills: {}, rows: [] }, NOW)
    expect(a.todayPnl).toBe(7)
    const fills = { acct_x: [{ accountId: 'acct_x', instrumentId: 'a:B', ts: dayStart + 1000, realizedPnl: 5, fillId: '1' }, { accountId: 'acct_x', instrumentId: 'a:B', ts: dayStart - 1000, realizedPnl: 99, fillId: '2' }] }
    const b = computeTotals({ accounts: acct, summaries: { acct_x: { equity: 100, available: 1, dayStartEquity: null, dayPnl: null } }, fills, rows: [] }, dayStart + 5000)
    expect(b.todayPnl).toBe(5)
    expect(b.approx).toBe(true)
    expect(b.todayPct).toBeNull()
    const none = computeTotals({ accounts: [], summaries: {}, fills: {}, rows: [] }, NOW)
    expect(none.equity).toBeNull()
    expect(none.todayPnl).toBeNull()
  })

  it('事件：account.positions / account.summary 载荷', () => {
    expect(positionsEvent({ accountId: 'acct_1', positions: [{ instrumentId: 'a:X', size: '2' }] })?.positions).toHaveLength(1)
    expect(positionsEvent({ positions: [] })).toBeNull()
    // 内核推的是单标的增量（集成修补 H）：不能被当成整表把持仓清空
    expect(positionsEvent({ accountId: 'acct_1', instrumentId: 'a:X', position: { instrumentId: 'a:X', size: '2' } })).toBeNull()
    const d = positionDelta({ accountId: 'acct_1', instrumentId: 'a:X', position: { instrumentId: 'a:X', size: '2' } })!
    expect(applyPositionDelta([{ instrumentId: 'a:Y', size: '1' } as never], d).map((p) => p.instrumentId)).toEqual(['a:Y', 'a:X'])
    expect(applyPositionDelta([{ instrumentId: 'a:X', size: '2' } as never], positionDelta({ accountId: 'acct_1', instrumentId: 'a:X', position: null })!)).toEqual([])
    expect(summaryEvent({ accountId: 'acct_1', equity: '5' })?.summary.equity).toBe(5)
  })

  it('事件链：持仓 → 成交 → 提案 → 来源', () => {
    const { rows, s } = snap()
    const btc = rows.find((r) => r.symbol === 'BTC')!
    const entries = s.ledger.filter((e) => e.subject.instrumentId === 'hyperliquid:BTC')
    const steps = buildPositionChain(btc, entries)
    expect(steps[0]!.kind).toBe('position')
    expect(steps[0]!.title).toBe('多 0.08 BTC')
    expect(steps.at(-1)!.kind).toBe('origin')
    expect(steps.at(-1)!.origin?.actor).toBe(`agent:${KEY_CLAUDE}`)
    // 来源只说经哪个入口来的，不露内部 id 与工具名
    expect(steps.at(-1)!.detail).toBe('经 MCP')
    expect(JSON.stringify(steps.map((x) => [x.title, x.detail]))).not.toMatch(/usr_|ak_|propose/)
    expect(steps.filter((x) => x.kind === 'fill').length).toBeGreaterThan(0)
    // 账本里的提案条目不带标的：提案以提案实体的腿为准（同账户、腿里有这个标的、已批准 / 执行中 / 已执行）
    expect(buildPositionChain(btc, entries).some((x) => x.kind === 'proposal')).toBe(false)
    const withProposals = buildPositionChain({ ...btc, accountId: btc.accountId, instrumentId: btc.instrumentId }, entries, s.proposals as unknown as Record<string, unknown>[])
    const prop = withProposals.filter((x) => x.kind === 'proposal')
    expect(prop).toHaveLength(1)
    expect(prop[0]!.title).toBe('提案 T-20261010-0006 已执行')
    expect(prop[0]!.origin?.actor).toBe(`agent:${KEY_CLAUDE}`)
    // 别的标的的提案、还在待批的提案都不算这个持仓的来路
    const eth = rows.find((r) => r.symbol === 'ETH')!
    expect(buildPositionChain(eth, [], s.proposals as unknown as Record<string, unknown>[]).some((x) => x.kind === 'proposal')).toBe(false)
    expect(proposalsOfPosition(btc, scenario('pending').proposals as unknown as Record<string, unknown>[]).map((p) => p.ticket)).toEqual(['T-20261010-0006'])
    // 账本里同一张票的条目也只留最终状态（创建 → 批准 → 执行，留「已执行」；执行前停在批准就是「已批准」）
    const ledgerOnly = (types: string[]) => s.ledger.filter((e) => types.includes(e.type) && e.subject.ticket === 'T-20261010-0006')
    expect(buildPositionChain(btc, ledgerOnly(['proposal.created', 'proposal.decided', 'proposal.executed'])).find((x) => x.kind === 'proposal')!.title).toBe('提案 T-20261010-0006 已执行')
    expect(buildPositionChain(btc, ledgerOnly(['proposal.created', 'proposal.decided'])).find((x) => x.kind === 'proposal')!.title).toBe('提案 T-20261010-0006 已批准')
    // 顺序固定：持仓 < 成交 < 提案 < 来源
    const order = ['position', 'fill', 'proposal', 'origin']
    const idx = withProposals.map((x) => order.indexOf(x.kind))
    expect([...idx].sort()).toEqual(idx)
  })

  it('事件链：成交很多时折叠成「更早 N 笔」', () => {
    const { rows } = snap()
    const many = Array.from({ length: 7 }, (_, i) => entry(200 + i, 'fill', O_CLAUDE, { accountId: ACCT_LIVE as never, instrumentId: 'hyperliquid:BTC' }, { price: '1', size: '1', side: 'buy' }, NOW + i))
    const steps = buildPositionChain(rows[0]!, many)
    expect(steps.filter((x) => x.kind === 'fill')).toHaveLength(5)
    expect(steps.find((x) => x.id === 'fills-more')?.title).toBe('更早 3 笔成交')
  })
})

describe('事件流', () => {
  const byType = (t: string) => sc().ledger.find((e) => e.type === t)!
  it('每条带：谁 · 做了什么 · 为什么 · 结果；LLM 来源的 actorType 保留', () => {
    const it = entryToActivity(byType('order.intent'))!
    expect(it.what).toContain('提交订单')
    expect(it.what).toContain('买入')
    expect(it.why).toBe('突破前高后回踩确认，按计划加仓')
    expect(it.result).toEqual({ label: '通过预检', tone: 'ok' })
    expect(it.origin.actorType).toBe('llm-agent')
  })

  it('撞了哪条规则：结构化字段拼文案（规则名 · 上限 · 实际），上游原文另放', () => {
    const denied = sc().ledger.find((e) => e.type === 'risk.denied')!
    const it = entryToActivity(denied)!
    expect(it.result?.tone).toBe('err')
    expect(it.rules[0]).toBe('大模型实盘开仓保护 · 上限 0 · 实际 1')
    expect(it.upstream).toBe('live entries originating from an LLM agent are denied by policy')
    const multi = sc().ledger.find((e) => e.seq === 110)!
    expect(entryToActivity(multi)!.rules).toEqual(['单笔上限 · 上限 5,000 USDC · 实际 128,600 USDC', '杠杆 · 上限 5 × · 实际 12 ×'])
  })

  it('场所拒绝：原文原样带出，不改写', () => {
    const e = entry(300, 'order.rejected', O_ENGINE, { accountId: ACCT_LIVE as never }, { problem: { code: 3001, name: 'VENUE_REJECTED', category: 'VENUE', message: 'x', retryable: false, venue: { id: 'hyperliquid', message: 'Order has invalid price.' } } }, NOW)
    expect(entryToActivity(e)!.upstream).toBe('Order has invalid price.')
  })

  it('提案生命周期各类型都有文案与结果', () => {
    const l = (type: Parameters<typeof entry>[1], payload = {}) => entryToActivity(entry(1, type, O_HUMAN, { ticket: 'T-1' as never }, payload, NOW))!
    expect(l('proposal.created').result?.label).toBe('待批')
    expect(l('proposal.decided', { decision: 'approved' }).what).toBe('批准提案 T-1')
    expect(l('proposal.decided', { decision: 'rejected' }).what).toBe('拒绝提案 T-1')
    expect(l('proposal.executed').result?.tone).toBe('ok')
    expect(l('proposal.failed').result?.tone).toBe('err')
    expect(l('proposal.expired').result?.label).toBe('已过期')
    expect(l('proposal.withdrawn').what).toBe('撤回提案 T-1')
    expect(l('takeover.requested', { level: 'flatten_all', reason: 'r' }).what).toBe('接管：全部平仓')
    expect(l('trading_state.changed', { to: 'HALTED', reason: 'x' }).result).toEqual({ label: '已停止', tone: 'err' })
  })

  it('接管：请求只是「已发出」，完成是「已完成」，没完成是「失败」（IXD F3-2）', () => {
    const l = (type: Parameters<typeof entry>[1], payload = {}) => entryToActivity(entry(1, type, O_HUMAN, { orgId: 'org_local' as never }, payload, NOW))!
    expect(l('takeover.requested', { level: 'flatten_all', reason: 'r' }).result).toEqual({ label: '已发出', tone: 'warn' })
    expect(l('takeover.completed', { level: 'flatten_all' })).toMatchObject({ what: '接管完成：全部平仓', result: { label: '已完成', tone: 'ok' } })
    expect(l('takeover.failed', { level: 'flatten_all' }).result).toEqual({ label: '失败', tone: 'err' })
  })

  it('过滤片计数：全部 + 四类，四类加起来等于全部', () => {
    const list = activityOf(sc().ledger)
    const n = activityCounts(list)
    expect(n.all).toBe(list.length)
    expect(n.human + n.engine + n['llm-agent'] + n.system).toBe(list.length)
    expect(n['llm-agent']).toBe(filterActivity(list, 'llm-agent').length)
    expect(activityCounts([])).toEqual({ all: 0, human: 0, engine: 0, 'llm-agent': 0, system: 0 })
  })

  it('annotation: kernel.started 显示「内核已重启」，strategy.stopped_unmanaged 显示持仓警告（GQ-06）', () => {
    const started = entryToActivity(entry(1, 'annotation', O_SYSTEM, { orgId: 'org_local' as never }, { kind: 'kernel.started' }, NOW))!
    expect(started.what).toBe('内核已重启')
    expect(started.result).toEqual({ label: '已启动', tone: 'flat' })
    const unmanaged = entryToActivity(entry(2, 'annotation', O_SYSTEM, { accountId: ACCT_LIVE as never, engineId: 'core' }, { kind: 'strategy.stopped_unmanaged', instanceId: 'inst_x', positions: [{ instrumentId: 'hyperliquid:BTC', side: 'long', size: '0.5' }, { instrumentId: 'hyperliquid:ETH', side: 'short', size: '2' }] }, NOW))!
    expect(unmanaged.what).toBe('策略已停，hyperliquid:BTC 0.5、hyperliquid:ETH 2 的持仓仍在、已无策略管理')
    expect(unmanaged.result).toEqual({ label: '需要处理', tone: 'warn' })
    // 未知 kind 返回 null
    expect(entryToActivity(entry(3, 'annotation', O_SYSTEM, { orgId: 'org_local' as never }, { kind: 'unknown' }, NOW))).toBeNull()
  })

  it('不相关的类型（快照、会话、对账）不进事件流', () => {
    expect(entryToActivity(entry(1, 'position.snapshot', O_SYSTEM, { orgId: 'org_local' as never }, {}, NOW))).toBeNull()
    expect(entryToActivity(entry(1, 'session.unlocked', O_SYSTEM, { orgId: 'org_local' as never }, {}, NOW))).toBeNull()
  })

  it('按 seq 降序、去重、限长；新事件合并进来', () => {
    const list = activityOf([...sc().ledger, ...sc().ledger], 5)
    expect(list).toHaveLength(5)
    expect(list.map((x) => x.seq)).toEqual([...list.map((x) => x.seq)].sort((a, b) => b - a))
    const fresh = entryToActivity(entry(999, 'note', O_CLAUDE, { orgId: 'org_local' as never }, { text: '新的' }, NOW))!
    const merged = mergeActivity(list, fresh, 5)
    expect(merged[0]!.id).toBe(fresh.id)
    expect(merged).toHaveLength(5)
    expect(mergeActivity(merged, fresh, 5)).toBe(merged)
  })

  it('来源筛选：人 / 引擎 / LLM Agent / 系统，按内核盖章的 actorType', () => {
    const list = activityOf(sc().ledger)
    const kinds = (f: Parameters<typeof filterActivity>[1]) => new Set(filterActivity(list, f).map((x) => x.origin.actorType))
    expect(filterActivity(list, 'all')).toHaveLength(list.length)
    expect(kinds('llm-agent')).toEqual(new Set(['llm-agent']))
    expect(kinds('engine')).toEqual(new Set(['engine']))
    expect(kinds('human')).toEqual(new Set(['human']))
    expect(kinds('system')).toEqual(new Set(['system']))
    // 四类加起来正好是全部（没有漏、没有重）
    const n = (['human', 'engine', 'llm-agent', 'system'] as const).reduce((x, f) => x + filterActivity(list, f).length, 0)
    expect(n).toBe(list.length)
    // 同一个 LLM 钥匙的两种动作都在 LLM 档里
    expect(filterActivity(list, 'llm-agent').some((x) => x.origin.actor === `agent:${KEY_HERMES}`)).toBe(true)
  })

  it('没有 actorType 的旧数据按 actor 前缀推断', () => {
    const legacy = entryToActivity({ ...entry(5, 'note', O_CLAUDE, { orgId: 'org_local' as never }, {}, NOW), origin: { actor: 'agent:ak_1', tool: 't', requestId: 'r', via: 'mcp' } as never })!
    expect(filterActivity([legacy], 'llm-agent')).toHaveLength(1)
  })

  it('ruleText 兜底：未知规则码显示原码，上限与实际保留原精度', () => {
    expect(ruleText({ ruleId: 'x', code: 'NOPE' as never, limit: '0.123456' as never, actual: '2' as never, unit: '', action: 'deny', scope: 'org' })).toBe('NOPE · 上限 0.123456 · 实际 2')
  })
})

describe('待批队列', () => {
  const pending = () => scenario('pending').proposals as unknown as Record<string, unknown>[]
  it('只留待审，最急（最先到期）的在最前', () => {
    const q = pendingQueue(new Map(pending().map((p) => [String(p.proposalId), p])))
    expect(q.map((c) => c.ticket)).toEqual(['T-20261010-0008', 'T-20261010-0007'])
  })
  it('卡片：票号、到期、理由、预检（强平价 / 滑点 / 保证金）、规则、来源', () => {
    const c = toPending(pending()[0]!)!
    expect(c.ticket).toBe('T-20261010-0007')
    expect(c.liquidationPrice).toBe(52110)
    expect(c.slippageBps).toBe(6)
    expect(c.marginRequired).toBe(6421)
    expect(c.notional).toBe(32105)
    expect(c.legs[0]!.text).toBe('买入 0.5 BTC @ 64,210')
    expect(c.rules[0]).toBe('需人批准 · 上限 2,000 USDC · 实际 32,105 USDC')
    expect(c.reason).toContain('突破前高')
    expect(c.origin?.actorType).toBe('llm-agent')
    expect(c.verdict).toBe('review')
  })
  it('事件：状态离开 pending 就移出队列；新的待审加进来', () => {
    let m: ReadonlyMap<string, Record<string, unknown>> = new Map()
    for (const p of pending()) m = applyProposal(m, p)
    expect(pendingQueue(m)).toHaveLength(2)
    m = applyProposal(m, { ...pending()[0], status: 'approved' })
    expect(pendingQueue(m).map((c) => c.ticket)).toEqual(['T-20261010-0008'])
    m = applyProposal(m, { ...pending()[0], proposalId: 'prop_new', ticket: 'T-9', status: 'pending', expiresAt: NOW + 1 })
    expect(pendingQueue(m)).toHaveLength(2)
    expect(applyProposal(m, 'junk')).not.toBe(m)
    expect(pendingQueue(applyProposal(m, 'junk'))).toHaveLength(2)
  })
  it('卡片带账户（写「账户 · 实盘 / 纸面」用，IXD F1-3）', () => {
    expect(toPending(pending()[0]!)!.accountId).toBe(ACCT_LIVE)
    expect(toPending({ ...pending()[0]!, accountId: undefined })!.accountId).toBeNull()
  })

  it('批准结果三分（IXD F1-1）：已执行 / 已批准但执行失败（读 status=failed 与原文）/ 已批准；拒绝就是已拒绝', () => {
    const p = pending()[0]!
    expect(decisionOutcome('approve', { ...p, status: 'executed' })).toEqual({ kind: 'executed' })
    expect(decisionOutcome('approve', { ...p, status: 'failed', execution: { orderIds: [], at: NOW, result: 'rejected', problem: { message: 'price moved beyond bounds' } } })).toEqual({ kind: 'failed', message: 'price moved beyond bounds' })
    expect(decisionOutcome('approve', { ...p, status: 'failed', execution: { orderIds: [], at: NOW, result: 'rejected', problem: { message: '', venue: { message: 'Order has invalid price.' } } } })).toEqual({ kind: 'failed', message: 'Order has invalid price.' })
    expect(decisionOutcome('approve', { ...p, status: 'failed', execution: { orderIds: [], at: NOW, result: 'denied' } })).toEqual({ kind: 'failed', message: 'denied' })
    expect(decisionOutcome('approve', { ...p, status: 'approved' })).toEqual({ kind: 'approved' })
    expect(decisionOutcome('approve', null)).toEqual({ kind: 'approved' })
    expect(decisionOutcome('reject', { ...p, status: 'rejected' })).toEqual({ kind: 'rejected' })
  })

  it('control 类提案显示动作名而不是订单腿；非待审返回 null', () => {
    const base = pending()[0]!
    const c = toPending({ ...base, kind: 'control', intents: { controlKind: 'start_strategy', params: {} } })!
    expect(c.control).toBe('启动策略')
    expect(c.legs).toHaveLength(0)
    expect(toPending({ ...base, status: 'executed' })).toBeNull()
    expect(toPending({ ...base, expiresAt: undefined })).toBeNull()
    expect(normalizeProposals({ proposals: [base, 5] })).toHaveLength(1)
  })
})

describe('Agent 权限（钥匙 + 授权书）', () => {
  it('档位由授权书级别映射：L2 → 需确认，L1 → 纸面；L4 也算限额自动；已吊销的钥匙不出现', () => {
    const s = sc()
    const t = keyTiers(s.keys, s.mandates)
    expect(t.map((k) => [k.name, k.tier])).toEqual([['Claude Code', 'confirm'], ['Hermes', 'paper']])
    expect(t[0]!.mandate?.mandateId).toBe(MDT_CLAUDE)
    const l4 = keyTiers(s.keys, [{ ...s.mandates[0]!, level: 'L4' }])
    expect(l4[0]!.tier).toBe('auto_limited')
    expect(keyTiers([{ ...s.keys[0]!, status: 'revoked' }], s.mandates)).toHaveLength(0)
    // 找不到授权书的钥匙按最保守（只读）显示
    expect(keyTiers(s.keys, [])[0]!.tier).toBe('read_only')
  })
  it('有效档位（IXD F4-3）：授权书到期 / 撤销 / 暂停按只读并标注；降级照级别并标「已降级」；带到期日', () => {
    const s = sc()
    const m = s.mandates[0]!
    const one = (patch: Record<string, unknown>, now = NOW) => keyTiers([s.keys[0]!], [{ ...m, ...patch }], now)[0]!
    expect(one({})).toMatchObject({ tier: 'confirm', notAfter: m.notAfter })
    expect(one({}).note).toBeUndefined()
    expect(one({ status: 'expired' })).toMatchObject({ tier: 'read_only', note: '已到期' })
    expect(one({}, Number(m.notAfter) + 1)).toMatchObject({ tier: 'read_only', note: '已到期' })
    expect(one({ status: 'suspended' })).toMatchObject({ tier: 'read_only', note: '已暂停' })
    expect(one({ status: 'revoked' })).toMatchObject({ tier: 'read_only', note: '已撤销' })
    expect(one({ status: 'downgraded', level: 'L1' })).toMatchObject({ tier: 'paper', note: '已降级' })
    expect(keyTiers(s.keys, [])[0]).toMatchObject({ tier: 'read_only', notAfter: null })
  })

  it('actor → 钥匙名', () => {
    const s = sc()
    expect(actorNames(keyTiers(s.keys, s.mandates))).toEqual({ [`agent:${KEY_CLAUDE}`]: 'Claude Code', [`agent:${KEY_HERMES}`]: 'Hermes' })
  })
})

describe('风险状态', () => {
  it('读内核形状：三态、原因、保护器、限额；缺省保护开关 = 开', () => {
    const r = normalizeRisk(scenario('halted').risk)
    expect(r.state).toBe('HALTED')
    expect(r.known).toBe(true)
    expect(r.reasons[0]).toBe('takeover flatten_all: 人在检阅面触发')
    expect(r.protectors.map((p) => p.label)).toEqual(['冷却', '止损保护', '回撤暂停'])
    expect(r.protectors[1]!.text).toBe('60 分钟内止损 2 次，暂停 30 分钟')
    expect(r.protectors[2]!.text).toBe('24 小时回撤达 4%，暂停 120 分钟')
    expect(r.denyLlmLiveEntries).toBe(true)
    const bare = normalizeRisk({})
    expect(bare.known).toBe(false)
    expect(bare.state).toBe('ACTIVE')
    expect(bare.denyLlmLiveEntries).toBe(true)
    expect(normalizeRisk({ tradingState: 'ACTIVE', denyLlmLiveEntries: false }).denyLlmLiveEntries).toBe(false)
    expect(normalizeRisk({ tradingState: 'ACTIVE', policy: { denyLlmLiveEntries: false } }).denyLlmLiveEntries).toBe(false)
  })

  it('事件 risk.state 取出新状态；认不出返回 null', () => {
    expect(stateOfEvent({ scope: { type: 'org' }, from: 'ACTIVE', to: 'HALTED' })).toBe('HALTED')
    expect(stateOfEvent({ state: 'REDUCING' })).toBe('REDUCING')
    expect(stateOfEvent({ kind: 'policy', version: 4 })).toBeNull()
    expect(stateOfEvent(null)).toBeNull()
  })

  it('限额使用率：单笔 / 日亏 / 总敞口 / 杠杆 / 日笔数，比例与语气', () => {
    const r = normalizeRisk(sc().risk)
    const rows = limitRows(r.limits, { orderNotional: 4500, dailyLossRatio: 0.06, totalNotionalRatio: 0.5, leverage: 4, ordersToday: 7 })
    expect(rows.map((x) => x.id)).toEqual(['order', 'dailyLoss', 'exposure', 'leverage', 'orders'])
    const by = Object.fromEntries(rows.map((x) => [x.id, x]))
    expect(by.order!.ratio).toBeCloseTo(0.9)
    // 视觉轮 r4（工单裁决 4，按 VISUAL r4）：≥ 85% warn、≥ 100% down，90% 是临界档（r2 C5 是 > 60% / > 85%）
    expect(by.order!.tone).toBe('warn')
    expect(by.dailyLoss!.ratio).toBeCloseTo(1.2)
    expect(by.dailyLoss!.tone).toBe('down')
    expect(by.dailyLoss!.used).toBe('6%')
    expect(by.dailyLoss!.limit).toBe('5%')
    expect(by.exposure!.tone).toBe('flat')
    expect(by.leverage!.tone).toBe('flat') // 4 / 5 = 80%：r4 阈值下仍是中性（r2 是 warn）
    expect(by.orders!.used).toBe('7')
  })

  it('C5 限额语气与细条同一组阈值（r4 裁决 4）：≥ 85% warn、≥ 100% down（边界本身升档）', () => {
    expect([0.84, 0.85, 0.99, 1, 1.2].map(toneOf)).toEqual(['flat', 'warn', 'warn', 'down', 'down'])
    expect(toneOf(null)).toBe('flat')
    const r = limitRows({ maxLeverage: 10 }, { leverage: 6.4 })[0]!
    expect(r.ratio).toBeCloseTo(0.64)
    expect(r.tone).toBe('flat') // 1440 夹具里「64%」不着色：数字与细条同源（toneOf），都中性
    expect(limitRows({ maxLeverage: 10 }, { leverage: 8.5 })[0]!.tone).toBe('warn')
  })

  it('没有使用量时只显示上限不画条；没设上限的行不出', () => {
    const rows = limitRows({ maxLeverage: 5 }, {})
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: 'leverage', ratio: null, used: '—', limit: '5×', tone: 'flat' })
    expect(limitRows({}, { leverage: 3 })).toHaveLength(0)
  })

  it('内核没给使用量时用账户快照现算', () => {
    const { summaries, rows } = snap()
    const u = deriveUsage({ summaries, rows, ordersToday: 3 })
    expect(u.totalNotionalRatio).toBeCloseTo(rows.reduce((x, r) => x + r.notional, 0) / (12480.2 + 9987.5), 6)
    expect(u.leverage).toBe(4)
    expect(u.dailyLossRatio).toBe(0)
    expect(u.ordersToday).toBe(3)
    const down = deriveUsage({ summaries: { a: { equity: 90, available: 0, dayStartEquity: 100, dayPnl: null } }, rows: [] })
    expect(down.dailyLossRatio).toBeCloseTo(0.1)
    expect(down.leverage).toBeNull()
  })

  it('接管结果（IXD F3-1 · G3）：ok 才出成功提示（带数字）；ok:false 给剩余标的；认不出的形状不替内核编失败', () => {
    expect(takeoverOutcome('halt_new', { ok: true, stateAfter: 'REDUCING' })).toEqual({ ok: true, text: '已停止新开仓' })
    expect(takeoverOutcome('cancel_all', { ok: true, cancelled: 7, stateAfter: 'REDUCING' })).toEqual({ ok: true, text: '已撤销 7 笔挂单 · 保留止盈止损' })
    expect(takeoverOutcome('cancel_all', { ok: true })).toEqual({ ok: true, text: '已撤销挂单' })
    expect(takeoverOutcome('flatten_all', { ok: true, stateAfter: 'HALTED' })).toEqual({ ok: true, text: '已全部平仓 · 交易已停止' })
    const left = takeoverOutcome('flatten_all', { ok: false, stateAfter: 'REDUCING', remaining: [{ accountId: ACCT_LIVE, instrumentId: 'hyperliquid:ETH', size: '1.2' }, { size: '3' }] })
    expect(left).toEqual({ ok: false, remaining: [{ accountId: ACCT_LIVE, instrumentId: 'hyperliquid:ETH', size: '1.2' }] })
    expect(takeoverOutcome('flatten_all', { ok: false })).toEqual({ ok: false, remaining: [] })
    expect(takeoverOutcome('halt_new', undefined)).toEqual({ ok: true, text: '已停止新开仓' })
  })

  it('账本里的接管条目落到「没平完」红条：failed 带剩余 → 显示；全部平仓完成 → 清掉；其他无关', () => {
    expect(leftoverOfEntry({ type: 'takeover.failed', payload: { level: 'flatten_all', remaining: [{ instrumentId: 'hyperliquid:ETH', size: '1.2' }] } })).toEqual([{ instrumentId: 'hyperliquid:ETH', size: '1.2' }])
    expect(leftoverOfEntry({ type: 'takeover.failed', payload: { level: 'cancel_all', error: { message: 'x' } } })).toBeNull()
    expect(leftoverOfEntry({ type: 'takeover.completed', payload: { level: 'flatten_all' } })).toBe('clear')
    expect(leftoverOfEntry({ type: 'takeover.completed', payload: { level: 'halt_new' } })).toBeNull()
    expect(leftoverOfEntry({ type: 'note', payload: {} })).toBeNull()
  })

  it('触发记录：只取 protector.triggered，新的在前，带保护器名与规则文案', () => {
    const t = triggerRows(sc().ledger)
    expect(t).toHaveLength(1)
    expect(t[0]!.label).toBe('止损保护')
    expect(t[0]!.text).toContain('保护器 · 上限 2')
  })
})

describe('状态条', () => {
  it('场所健康：协议 VenueStatus 与内核 venue.status 两种形状都认', () => {
    const v = normalizeVenues(sc().venues)
    expect(v.map((x) => x.name)).toEqual(['Hyperliquid', '模拟场所'])
    expect(v[0]).toMatchObject({ ws: 'ok', wsText: '已连接', p50: 42, p95: 88, used: 312, limit: 1200, environment: 'testnet', isSim: false })
    expect(v[0]!.leftPct).toBeCloseTo(74)
    expect(v[1]!.isSim).toBe(true)
    expect(v[1]!.leftPct).toBeNull()
    expect(normalizeVenues([{ venue: 'x', wsState: 'connecting' }, { venue: 'y', wsState: 'disconnected' }, { id: 'z' }]).map((x) => x.ws)).toEqual(['pending', 'err', 'unknown'])
  })
  it('网络：主网 / 测试网 / 只连模拟场所时叫纸面 / 没有场所叫未连接', () => {
    const v = normalizeVenues(sc().venues)
    expect(buildStatus(v, 'ACTIVE', true)).toMatchObject({ network: '测试网', latency: 42, stateLabel: '正常交易' })
    expect(buildStatus(v.map((x) => ({ ...x, environment: 'mainnet' as const })), 'REDUCING', true).network).toBe('主网')
    expect(buildStatus([v[1]!], 'ACTIVE', true).network).toBe('纸面')
    // r2（IXD F8-1）：内核在、没有场所 = 「场所未连接」；内核断开由状态条另写「内核未连接」
    expect(buildStatus([], null, true)).toMatchObject({ network: '场所未连接', stateLabel: '—', primary: null })
    expect(buildStatus(v, 'ACTIVE', false).networkTone).toBe('err')
  })
  it('预算告警档：< 10% low（红 + 形状），< 25% warn，读不到为 null', () => {
    expect(budgetLevel(8)).toBe('low')
    expect(budgetLevel(9.99)).toBe('low')
    expect(budgetLevel(10)).toBe('warn')
    expect(budgetLevel(24)).toBe('warn')
    expect(budgetLevel(25)).toBeNull()
    expect(budgetLevel(null)).toBeNull()
  })

  it('预算剩余按已用 / 上限折算并夹在 0–100', () => {
    const v = normalizeVenues([{ venue: 'a', wsState: 'connected', rateBudget: { used: 1500, limit: 1200 } }])
    expect(v[0]!.leftPct).toBe(0)
  })
})
