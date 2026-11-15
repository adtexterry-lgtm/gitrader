// SPDX-License-Identifier: CPAL-1.0
// 总览页夹具：与视觉稿 reports/visual-r5/overview 同一组数字（实盘 12,480.20 · 今日 +128.40 · 纸面 9,987.50 / −12.50 · hl-main 三个持仓 + paper-1 一个 · 两张待批）。
// 全是自造的演示数据，不含真实地址、密钥、行情。数据形状 = blocks-default 的假内核场景（Scenario），所以 blocks-default 的 installScenario 的全部命令
// （position.close / order.place / order.cancel / proposal.approve / takeover.* …）原样可用，调用记录在 stage.calls，与 r4 同一份代码。
// 用法：const stage = installScenario(kernel); stage.sc = overviewScenario('normal')。
import type { LedgerEntry, Mandate, Origin, Position, Proposal } from '@gitrader/protocol'
import { ACCT_LIVE, ACCT_PAPER, KEY_CLAUDE, KEY_HERMES, MDT_CLAUDE, MDT_HERMES, O_CLAUDE, O_HUMAN, O_SYSTEM, entry, proposal, scenario, type Scenario } from '../../blocks-default/fixtures/scenarios'

export type OverviewState = 'normal' | 'empty' | 'loading' | 'error' | 'offline' | 'unwired'
type Rec = Record<string, unknown>
const MIN = 60_000
export const OV_PROBLEM = '内核暂时读不到这份数据（演示用的读取失败场景）'

const hex = (n: number, len: number) => n.toString(16).padStart(len, '0')
const origin = (actor: string, tool: string, via: Origin['via'], actorType: Origin['actorType'], n: number): Origin => ({
  actor: actor as Origin['actor'], actorType, tool, requestId: `00000000-0000-4000-8000-${hex(n, 12)}`, via, ...(actorType === 'llm-agent' ? { onBehalfOf: 'user:usr_local' as const } : {}),
})
export const O_CODEX = origin(`agent:${KEY_HERMES}`, 'read', 'mcp', 'llm-agent', 12)
export const O_EMA = origin('strategy:ema-trend', 'strategy:ema-trend', 'gep', 'engine', 13)
export const O_GRID = origin('strategy:grid-paper', 'strategy:grid-paper', 'gep', 'engine', 14)

const pos = (accountId: string, instrumentId: string, side: 'long' | 'short', size: string, entryPx: string, mark: string, upnl: string, liq: string, lev: number, now: number, estimated = false): Position => ({
  accountId: accountId as Position['accountId'], instrumentId, side, size: size as never, entryPrice: entryPx as never, markPrice: mark as never,
  notional: String(Math.round(Number(size) * Number(mark) * 100) / 100) as never, unrealizedPnl: upnl as never, realizedPnl: '0' as never, leverage: lev, marginMode: 'cross',
  liquidationPrice: liq as never, ...(estimated ? { estimated } : {}), fundingSinceOpen: '-1.24' as never, openedAt: now - 3 * 3_600_000, updatedAt: now - 2000,
})

const ord = (n: number, accountId: string, instrumentId: string, side: 'buy' | 'sell', o: Origin, ts: number, extra: Rec = {}): Rec => ({
  orderId: `ord_ov_${n}`, clientOrderId: hex(n, 32), accountId, instrumentId, side, type: 'limit', tif: 'gtc', size: '1', filledSize: '1', status: 'filled', fee: '0', reduceOnly: false, origin: o, createdAt: ts, updatedAt: ts, ...extra,
})
const intent = (instrumentId: string, side: 'buy' | 'sell', size: string, price: string, reason: string): Rec => ({ accountId: ACCT_LIVE, instrumentId, side, type: 'limit', size, price, tif: 'gtc', reason })
const hit = (code: string, ruleId: string, limit: string, actual: string, unit: string, action: 'deny' | 'warn' | 'review' = 'deny') => ({ ruleId, code, limit, actual, unit, action, scope: 'org' })

/** 提案：时间相对 now（scenarios.proposal 用模块加载时刻，这里改成调用时刻，倒计时才准）。 */
function pending(n: number, ticket: string, ms: number, now: number, o: Origin, legs: Rec[], reason: string, hits: Rec[], est: Rec): Proposal {
  const p = proposal(n, ticket, 'pending', ms, o, legs, reason, hits, est) as unknown as Rec & { precheck: Rec }
  // 视觉稿的待批浮层没有「参考价」一行：夹具里这两张提案不带价格边界（带的话浮层多一行，由真内核数据决定）
  const { priceBounds: _bounds, ...rest } = p as Rec
  return { ...rest, expiresAt: now + ms, precheck: { ...p.precheck, expiresAt: now + ms } } as unknown as Proposal
}

function mandate(mandateId: string, keyId: string, level: Mandate['level'], now: number, limits: Rec, instruments: string[]): Mandate {
  return {
    mandateId, version: 2, subject: { type: 'agentKey', id: keyId }, level, accounts: [ACCT_LIVE] as never, venueAllowlist: ['hyperliquid'], instrumentAllowlist: instruments,
    limits, notBefore: now - 86_400_000, notAfter: now + 29 * 86_400_000, status: 'active', issuedBy: 'user:usr_local',
  } as unknown as Mandate
}

const risk = (): Rec => ({
  tradingState: 'ACTIVE', reasons: [],
  policy: {
    version: 3, denyLlmLiveEntries: true, dailyResetAt: '00:00Z', valuationCcy: 'USDC',
    protectors: [
      { kind: 'cooldown', afterOpenSec: 5 }, { kind: 'stoploss_guard', windowMin: 60, maxStoplosses: 2, pauseMin: 30, scope: 'account' }, { kind: 'drawdown_pause', windowHours: 24, maxDrawdownRatio: '0.04', pauseMin: 120 },
      { kind: 'low_profit_lock', windowHours: 12, minProfitRatio: '0.001', lockMin: 60 }, { kind: 'max_consecutive_failures', count: 3, pauseMin: 30 }, { kind: 'plugin', pluginId: '价格偏离 1.5% 拒单' },
    ],
  },
  limits: { maxLeverage: 5, maxOrderNotional: '8000', maxTotalNotionalRatio: '3', maxDailyLossRatio: '0.032', maxSlippageBps: 30, maxOrdersPerMinute: 30, maxOrdersPerDay: 20 },
  integrity: { ok: true }, denyLlmLiveEntries: true,
  usage: { orderNotional: 3246.5, ordersToday: 17, dailyLossRatio: 0.0069, totalNotionalRatio: 1.08 },
})

export function overviewScenario(state: OverviewState = 'normal', now = Date.now()): Scenario {
  const base = scenario('normal')
  const accounts = [
    { ...base.accounts[0]!, alias: 'hl-main', environment: 'testnet' },
    { ...base.accounts[1]!, alias: 'paper-1' },
  ]
  const positions: Record<string, Position[]> = {
    [ACCT_LIVE]: [
      pos(ACCT_LIVE, 'hyperliquid:BTC', 'long', '0.08', '64210', '64812', '48.16', '52100', 4, now),
      pos(ACCT_LIVE, 'hyperliquid:ETH', 'short', '1.2', '3240', '3182', '69.60', '4610', 2, now),
      pos(ACCT_LIVE, 'hyperliquid:SOL', 'long', '30', '151.2', '148.2', '-90.00', '118.4', 3, now),
    ],
    [ACCT_PAPER]: [pos(ACCT_PAPER, 'hyperliquid:BTC', 'long', '0.05', '63900', '64812', '45.60', '33100', 2, now, true)],
  }
  const orders: Record<string, Rec[]> = {
    [ACCT_LIVE]: [
      ord(1, ACCT_LIVE, 'hyperliquid:BTC', 'buy', O_EMA, now - 3 * 3_600_000),
      ord(2, ACCT_LIVE, 'hyperliquid:ETH', 'sell', O_CLAUDE, now - 2 * 3_600_000),
      ord(3, ACCT_LIVE, 'hyperliquid:SOL', 'buy', O_HUMAN, now - 4 * 3_600_000),
      ord(4, ACCT_LIVE, 'hyperliquid:BTC', 'sell', O_HUMAN, now - 30 * MIN, { type: 'stop_market', size: '0.08', filledSize: '0', status: 'untriggered', reduceOnly: true, triggerPrice: '63100' }),
    ],
    [ACCT_PAPER]: [
      ord(5, ACCT_PAPER, 'hyperliquid:BTC', 'buy', O_GRID, now - 5 * 3_600_000),
      ord(6, ACCT_PAPER, 'hyperliquid:BTC', 'buy', O_GRID, now - 20 * MIN, { size: '0.01', filledSize: '0', status: 'open', price: '64400' }),
      ord(7, ACCT_PAPER, 'hyperliquid:BTC', 'sell', O_GRID, now - 19 * MIN, { size: '0.01', filledSize: '0', status: 'open', price: '65200' }),
    ],
  }
  const summaries: Record<string, Rec> = {
    [ACCT_LIVE]: { accountId: ACCT_LIVE, equity: '12480.20', available: '8120.4', dayStartEquity: '12351.80', ts: now },
    [ACCT_PAPER]: { accountId: ACCT_PAPER, equity: '9987.50', available: '8367.2', dayStartEquity: '10000', ts: now },
  }
  const fill = (n: number, accountId: string, instrumentId: string, side: 'buy' | 'sell', price: string, size: string, realized: string, ts: number): Rec =>
    ({ fillId: `fill_ov_${n}`, orderId: `ord_ov_${n}`, clientOrderId: hex(n, 32), venueFillId: `v${n}`, accountId, instrumentId, side, price, size, fee: '0.9', feeCcy: 'USDC', liquidity: 'taker', realizedPnl: realized, ts })
  const fills: Record<string, Rec[]> = {
    [ACCT_LIVE]: [fill(1, ACCT_LIVE, 'hyperliquid:BTC', 'buy', '64210', '0.08', '0', now - 3 * 3_600_000)],
    [ACCT_PAPER]: [fill(5, ACCT_PAPER, 'hyperliquid:BTC', 'buy', '63900', '0.05', '0', now - 5 * 3_600_000)],
  }
  const ledger: LedgerEntry[] = [
    entry(113, 'proposal.created', O_CLAUDE, { proposalId: 'prop_ov_8' as never, ticket: 'T-0008' as never, accountId: ACCT_LIVE as never }, { status: 'pending', reason: '突破后回踩确认，计划分两笔建仓' }, now - 11_000),
    entry(112, 'proposal.created', O_CLAUDE, { proposalId: 'prop_ov_7' as never, ticket: 'T-0007' as never, accountId: ACCT_LIVE as never }, { status: 'pending', reason: '资金费连续 3 期为正，加空' }, now - 115_000),
    entry(111, 'fill', O_CLAUDE, { accountId: ACCT_LIVE as never, instrumentId: 'hyperliquid:BTC' }, { price: '64930', size: '0.05', side: 'sell', fee: '0.9', realizedPnl: '12.4' }, now - 11 * MIN),
    entry(110, 'proposal.decided', O_HUMAN, { proposalId: 'prop_ov_6' as never, ticket: 'T-0006' as never }, { decision: 'approved' }, now - 11 * MIN - 9_000),
    entry(109, 'order.intent', O_CLAUDE, { accountId: ACCT_LIVE as never, instrumentId: 'hyperliquid:BTC' }, { intent: intent('hyperliquid:BTC', 'buy', '0.5', '64210', '突破前高，按计划加仓') }, now - 23 * MIN, {
      precheck: { precheckId: 'pck_ov_9' as never, verdict: 'deny', policyVersion: 3, estimates: {} }, ruleHits: [hit('ORDER_NOTIONAL', 'pol#maxOrderNotional', '8000', '32105', 'USDC') as never],
    }),
    entry(108, 'fill', O_SYSTEM, { accountId: ACCT_LIVE as never, instrumentId: 'hyperliquid:BTC' }, { price: '64700', size: '0.01', side: 'sell', fee: '0.1', realizedPnl: '1.2' }, now - 38 * MIN),
    entry(107, 'note', O_CODEX, { accountId: ACCT_LIVE as never }, { text: '读取 账户快照' }, now - 51 * MIN),
    entry(106, 'fill', O_GRID, { accountId: ACCT_PAPER as never, instrumentId: 'hyperliquid:BTC' }, { price: '63900', size: '0.05', side: 'buy', fee: '0', realizedPnl: '0' }, now - 70 * MIN),
    entry(105, 'note', O_EMA, { accountId: ACCT_LIVE as never }, { text: '信号 BTC 多头延续，维持仓位' }, now - 95 * MIN),
    entry(104, 'note', O_SYSTEM, { accountId: ACCT_LIVE as never }, { text: '资金费结算 BTC −0.42' }, now - 112 * MIN),
    entry(103, 'proposal.created', O_CLAUDE, { proposalId: 'prop_ov_5' as never, ticket: 'T-0005' as never, accountId: ACCT_LIVE as never }, { status: 'expired', reason: '回踩确认' }, now - 130 * MIN),
    entry(102, 'fill', O_EMA, { accountId: ACCT_LIVE as never, instrumentId: 'hyperliquid:BTC' }, { price: '64210', size: '0.08', side: 'buy', fee: '0.9', realizedPnl: '0' }, now - 150 * MIN),
    entry(101, 'protector.triggered', O_SYSTEM, { accountId: ACCT_LIVE as never }, { protector: 'stoploss_guard', scope: { type: 'account', id: ACCT_LIVE }, pauseMin: 30 }, now - 170 * MIN, { ruleHits: [hit('PROTECTOR', 'prot_stoploss', '2', '2', '次') as never] }),
  ]
  const executed = { ...proposal(6, 'T-0006', 'executed', -11 * MIN, O_CLAUDE, [intent('hyperliquid:BTC', 'sell', '0.05', '64930', '止盈')], '止盈', []), expiresAt: now - 11 * MIN } as unknown as Proposal
  const proposals: Proposal[] = [
    pending(7, 'T-0007', 185_000, now, O_CLAUDE, [intent('hyperliquid:ETH', 'sell', '2', '3190', '资金费连续 3 期为正，加空')], '资金费连续 3 期为正，加空', [], { notional: '6380', marginRequired: '3190', liquidationPrice: '4580', slippageBps: 3 }),
    pending(8, 'T-0008', 289_000, now, O_CLAUDE, [intent('hyperliquid:BTC', 'buy', '0.05', '64600', '突破后回踩确认，计划分两笔建仓')], '突破后回踩确认，计划分两笔建仓', [], { notional: '3230', marginRequired: '1615', liquidationPrice: '52100', slippageBps: 4 }),
    executed,
  ]
  const keys = [
    { keyId: KEY_CLAUDE, name: 'Claude Code', host: 'claude-code', mandateId: MDT_CLAUDE, status: 'active', createdAt: now - 5 * 86_400_000, expiresAt: now + 85 * 86_400_000, lastSeenAt: now - 11_000, createdBy: 'user:usr_local' },
    { keyId: KEY_HERMES, name: 'Codex CLI', host: 'codex', mandateId: MDT_HERMES, status: 'active', createdAt: now - 2 * 86_400_000, expiresAt: now + 88 * 86_400_000, lastSeenAt: now - 51 * MIN, createdBy: 'user:usr_local' },
  ]
  const mandates = [
    mandate(MDT_CLAUDE, KEY_CLAUDE, 'L2', now, { maxOrderNotional: '8000', maxDailyNotional: '30000' }, ['hyperliquid:BTC', 'hyperliquid:ETH', 'hyperliquid:SOL']),
    mandate(MDT_HERMES, KEY_HERMES, 'L0', now, {}, []),
  ]
  const venues = [
    { id: 'hyperliquid', venue: 'hyperliquid', environment: 'testnet', ts: now, wsState: 'connected', latencyMs: { p50: 42, p95: 88 }, rateBudget: { used: 312, limit: 1200, windowMs: 60000, ratio: 0.26 } },
    { id: 'kernel-sim', venue: 'kernel-sim', environment: 'testnet', ts: now, wsState: 'connected', latencyMs: { p50: 1, p95: 2 } },
  ]
  const normal: Scenario = { ...base, name: 'normal', accounts, positions, summaries, fills, orders, ledger, proposals, keys, mandates, risk: risk(), venues, failing: false }
  if (state === 'empty') {
    return {
      ...normal, accounts: [accounts[1]!], positions: { [ACCT_PAPER]: [] }, summaries: { [ACCT_PAPER]: { accountId: ACCT_PAPER, equity: '10000', available: '10000', dayStartEquity: '10000', ts: now } },
      fills: { [ACCT_PAPER]: [] }, orders: { [ACCT_PAPER]: [] }, ledger: [], proposals: [], keys: [], mandates: [], venues: [venues[1]!],
    }
  }
  if (state === 'error') return { ...normal, failing: true }
  return normal
}

/** 舞台按「常量」注册的部分：总览不靠常量（数据全部来自 overviewScenario），这里只登记每个状态的视图名。 */
export const overviewFixtures = {
  normal: { view: 'all' },
  empty: { view: 'all' },
  loading: { view: 'all' },
  error: { view: 'all' },
  offline: { view: 'all' },
  unwired: { view: 'all' },
}
