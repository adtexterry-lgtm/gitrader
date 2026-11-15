// SPDX-License-Identifier: CPAL-1.0
// 总览页单测（不开浏览器）：复用 r4 模型的同源性、资金卡今日 = 权益 − 日初、待批三态状态机、批后风控占用、挂单规整、块清单。
import { describe, expect, it } from 'vitest'
import { buildRows, computeTotals, groupRows, normalizeAccounts, normalizePositions, normalizeSummary, type PositionRow } from '../../blocks-default/src/model-positions'
import { toPending, type PendingCard } from '../../blocks-default/src/model-activity'
import { totalsByMode, toneOf } from '../../blocks-default/src/model-risk'
import { ACCT_LIVE, ACCT_PAPER } from '../../blocks-default/fixtures/scenarios'
import { overviewScenario } from '../fixtures/overview'
import { overviewBlocks } from '../src/pages/overview'
import { INITIAL_PEND, AUTO_OPEN_MS, afterOf, nextPend, occupancy, setPend, togglePend, type PendMachine } from '../src/views/pending'
import { openOrders, orderTypeText } from '../src/views/positions'

const NOW = 1_800_000_000_000
const sc = overviewScenario('normal', NOW)
const cards = (...ms: number[]): PendingCard[] => ms.map((m, i) => ({ proposalId: `p${i}`, expiresAt: NOW + m } as PendingCard))
const accounts = normalizeAccounts(sc.accounts)
const positions = Object.fromEntries(Object.entries(sc.positions).map(([k, v]) => [k, normalizePositions(v)]))
const summaries = Object.fromEntries(Object.entries(sc.summaries).map(([k, v]) => [k, normalizeSummary(v)]))

describe('overview · 复用 r4 模型：buildRows / computeTotals 输出与 r4 视图同源', () => {
  const rows = buildRows(accounts, positions, {})
  it('四个持仓：实盘 3 + 纸面 1，按账户分组、实盘在前；小计只组内加', () => {
    expect(rows).toHaveLength(4)
    const groups = groupRows(rows)
    expect(groups.map((g) => [g.alias, g.mode, g.rows.length, Math.round(g.subtotal * 100) / 100])).toEqual([['hl-main', 'live', 3, 27.76], ['paper-1', 'paper', 1, 45.6]])
  })
  it('开仓方：同账户同标的方向一致的开仓单里最近一笔的来源；现有止损取 reduceOnly 的 stop_market', () => {
    const orders = Object.fromEntries(Object.entries(sc.orders).map(([k, v]) => [k, v.map((o) => ({
      accountId: String(o.accountId), instrumentId: String(o.instrumentId), side: String(o.side), reduceOnly: o.reduceOnly === true, createdAt: Number(o.createdAt),
      origin: o.origin as never, orderId: String(o.orderId), type: String(o.type), status: String(o.status), triggerPrice: o.triggerPrice == null ? null : Number(o.triggerPrice),
    }))]))
    const withOrders = buildRows(accounts, positions, orders)
    const by = (sym: string, acct: string) => withOrders.find((r) => r.symbol === sym && r.accountId === acct)!
    expect(by('BTC', ACCT_LIVE).executor?.actor).toBe('strategy:ema-trend')
    expect(by('ETH', ACCT_LIVE).executor?.actorType).toBe('llm-agent')
    expect(by('SOL', ACCT_LIVE).executor?.actorType).toBe('human')
    expect(by('BTC', ACCT_PAPER).executor?.actor).toBe('strategy:grid-paper')
    expect(by('BTC', ACCT_LIVE).stop?.triggerPrice).toBe(63100)
  })
  it('computeTotals 全账户相加与 totalsByMode 分开：实盘与纸面不相加', () => {
    const t = totalsByMode(accounts, summaries)
    expect(t.main).toBe('live')
    expect(t.live?.equity).toBeCloseTo(12480.2, 2)
    expect(t.paper?.equity).toBeCloseTo(9987.5, 2)
    const all = computeTotals({ accounts, summaries, fills: {}, rows }, NOW)
    expect(all.equity).toBeCloseTo(12480.2 + 9987.5, 2)
  })
})

describe('overview · 资金卡今日 = 权益 − 日初权益', () => {
  it('实盘 +128.40（+1.04%）、纸面 −12.50；缺日初时退回 dayPnl', () => {
    const t = totalsByMode(accounts, summaries)
    expect(t.live?.today).toBeCloseTo(128.4, 2)
    expect(t.live?.pct).toBeCloseTo(1.0395, 3)
    expect(t.paper?.today).toBeCloseTo(-12.5, 2)
    const noBase = totalsByMode(accounts, { [ACCT_LIVE]: { equity: 100, available: null, dayStartEquity: null, dayPnl: 7 }, [ACCT_PAPER]: null })
    expect(noBase.live?.today).toBe(7)
  })
})

describe('overview · 待批三态状态机（倒计时 ≤ 60 s 自动展开）', () => {
  const run = (prev: PendMachine, ms: number[], at = NOW) => nextPend(prev, { cards: cards(...ms), now: at })
  it('没有待批 = none；有待批缺省 collapsed', () => {
    expect(run(INITIAL_PEND, [])).toBe(INITIAL_PEND)
    expect(run(INITIAL_PEND, [185_000, 289_000]).state).toBe('collapsed')
    expect(run({ state: 'open', seen: ['p0'] }, []).state).toBe('none')
  })
  it('最急一张剩余 ≤ 60 s → 自动展开，每张只自动一次：人手收起后不再抢开', () => {
    const a = run(INITIAL_PEND, [AUTO_OPEN_MS])
    expect(a.state).toBe('open')
    const closed = togglePend(a)
    expect(closed.state).toBe('collapsed')
    const later = nextPend(closed, { cards: cards(AUTO_OPEN_MS), now: NOW + 5_000 })
    expect(later.state).toBe('collapsed')
    expect(nextPend(later, { cards: cards(AUTO_OPEN_MS), now: NOW + 5_000 })).toBe(later)
  })
  it('61 s 不开；新批次（另一张到了 60 s 以内）再开一次；已过期的张不算', () => {
    expect(run(INITIAL_PEND, [AUTO_OPEN_MS + 1_000]).state).toBe('collapsed')
    const first = run(INITIAL_PEND, [50_000, 289_000])
    expect(first.state).toBe('open')
    const closed = togglePend(first)
    const second = nextPend(closed, { cards: [{ proposalId: 'p9', expiresAt: NOW + 40_000 }, ...cards(50_000, 289_000)], now: NOW })
    expect(second.state).toBe('open')
    expect(nextPend(INITIAL_PEND, { cards: [{ proposalId: 'x', expiresAt: NOW - 1 }], now: NOW })).toBe(INITIAL_PEND)
  })
  it('没有待批时不能手动切；setPend 只在有待批时生效', () => {
    expect(togglePend(INITIAL_PEND)).toBe(INITIAL_PEND)
    expect(setPend(INITIAL_PEND, 'open')).toBe(INITIAL_PEND)
    expect(setPend({ state: 'open', seen: [] }, 'collapsed').state).toBe('collapsed')
  })
})

describe('overview · 批后仓位与风控占用', () => {
  const rows = buildRows(accounts, positions, {})
  const t7 = toPending(sc.proposals.find((p) => p.ticket === 'T-0007') as never)!
  it('批后仓位：ETH 空 1.2 → 空 3.2；名义增量 = 批后名义 − 现名义', () => {
    const a = afterOf(t7, { phase: 'ready', rows })!
    expect(a).toMatchObject({ sym: 'ETH', from: '空 1.2', to: '空 3.2' })
    expect(a.delta).toBeCloseTo(3.2 * 3182 - 1.2 * 3182, 1)
    expect(afterOf(t7, { phase: 'loading', rows })).toBeNull()
  })
  it('占用三行：总敞口（×）· 单笔 · 杠杆；超限只标出事实（tone = down），不替内核拦单', () => {
    const total = rows.reduce((x: number, r: PositionRow) => x + r.notional, 0)
    const ok = occupancy({ card: t7, limits: { maxTotalNotionalRatio: '3', maxOrderNotional: '8000', maxLeverage: 5 }, usage: { leverage: 4 }, totalNotional: total, equity: 22467.7, delta: 6364 })
    expect(ok.map((o) => [o.id, o.tone])).toEqual([['exposure', 'flat'], ['order', 'flat'], ['leverage', 'flat']])
    expect(ok[1]!.used).toBe('6,380.00')
    const over = occupancy({ card: t7, limits: { maxTotalNotionalRatio: '1', maxOrderNotional: '5000', maxLeverage: 5 }, usage: { leverage: 4 }, totalNotional: total, equity: 22467.7, delta: 6364 })
    expect(over.find((o) => o.id === 'exposure')!.tone).toBe('down')
    expect(over.find((o) => o.id === 'order')!.tone).toBe('down')
    expect(toneOf(0.9)).toBe('warn')
    expect(occupancy({ card: t7, limits: {}, usage: {}, totalNotional: total, equity: null, delta: null })).toEqual([])
  })
})

describe('overview · 挂单页签规整', () => {
  it('只留未完成的单；类型文案：止损　只减仓 / 限价 / 市价', () => {
    const list = openOrders({ orders: Object.values(sc.orders).flat() })
    expect(list.map((o) => o.orderId).sort()).toEqual(['ord_ov_4', 'ord_ov_6', 'ord_ov_7'])
    expect(orderTypeText({ type: 'stop_market', reduceOnly: true })).toBe('止损　只减仓')
    expect(orderTypeText({ type: 'limit', reduceOnly: false })).toBe('限价')
    expect(orderTypeText({ type: 'market', reduceOnly: false })).toBe('市价')
  })
})

describe('overview · 块清单', () => {
  it('四个块沿用 r4 的 id@0.1.0（覆盖）；权限与动作按块声明；positions 的清单并入 P2 的 symbol / ticket 视图所需', () => {
    const by = Object.fromEntries(overviewBlocks.map((b) => [b.manifest.id, b.manifest]))
    expect(Object.keys(by).sort()).toEqual(['block.gitrader.agent-activity', 'block.gitrader.positions', 'block.gitrader.risk', 'block.gitrader.statusbar'])
    for (const m of Object.values(by)) {
      expect(m.version).toBe('0.1.0')
      expect(m.fixtures).toEqual(['./fixtures/overview.ts'])
      expect(m.permissions!.length).toBeGreaterThan(0)
    }
    expect(by['block.gitrader.positions']!.actions).toEqual(expect.arrayContaining(['position.close', 'order.place', 'order.cancel']))
    expect(by['block.gitrader.positions']!.permissions).toEqual(expect.arrayContaining(['account.read', 'ledger.read', 'market.read']))
    expect(by['block.gitrader.positions']!.inputs!.queries).toEqual(expect.arrayContaining(['market.quote', 'proposal.list']))
    // fix-r4: Agent 卡档位菜单加「撤销此 Agent…」，清单追加 agentkey.revoke（C6）
    expect(by['block.gitrader.agent-activity']!.actions).toEqual(['proposal.approve', 'proposal.reject', 'mandate.update', 'agentkey.create', 'agentkey.revoke']) // fix-r1 E0-6：Agent 卡「接入 Agent」
    // fix-r4: Agent 卡「今日提议 —」根因 = 区块清单没声明 risk.stats，桥直接拒（QUERY_NOT_ALLOWED）
    expect(by['block.gitrader.agent-activity']!.inputs!.queries).toContain('risk.stats')
    // fix-r4: 风险卡放宽默认走 risk.temporaryRelax；停机行用钥匙名（useRisk / useStatus 查 agentkey.list）
    expect(by['block.gitrader.risk']!.actions).toEqual(expect.arrayContaining(['risk.temporaryRelax', 'risk.relax', 'risk.tighten']))
    expect(by['block.gitrader.risk']!.inputs!.queries).toContain('agentkey.list')
    expect(by['block.gitrader.statusbar']!.inputs!.queries).toContain('agentkey.list')
    expect(by['block.gitrader.risk']!.actions).toEqual(expect.arrayContaining(['takeover.halt_new', 'takeover.cancel_all', 'takeover.flatten_all', 'trading_state.resume', 'risk.setLlmLiveEntries', 'risk.relax']))
    expect(by['block.gitrader.statusbar']!.permissions).toContain('takeover.trigger')
  })
})
