// SPDX-License-Identifier: CPAL-1.0
// 默认块的夹具数据与"假内核场景"：空 / 正常 / 有待批 / 已停止 / 读取失败。全部是自造的演示数据（不含真实地址、密钥、行情），
// 实体形状按 @gitrader/protocol 的类型（vitest 里用协议校验器逐个核对）；查询 / 事件名与载荷见 src/api.ts 与 src/model-*.ts。
// 同一份数据三处用：① 块清单的 fixtures 回放（块不连内核也能渲染）② vitest ③ verify/ 的无头浏览器截图。
import type { LedgerEntry, Mandate, Origin, Position, Proposal, TradingState } from '@gitrader/protocol'

export type ScenarioName = 'empty' | 'normal' | 'pending' | 'halted' | 'error'
type Rec = Record<string, unknown>

export const PIN = '246810'
/** 夹具时间基准：进程启动时刻（倒计时、今日起点都相对它），GITRADER_FIXTURE_NOW 可固定。 */
export const NOW = Number(process.env.GITRADER_FIXTURE_NOW) || Date.now()

const hex = (n: number, len: number) => n.toString(16).padStart(len, '0')
const id = (p: string, n: number) => `${p}_01JB${hex(n, 22).toUpperCase().replace(/[ILOU]/g, '0')}`
export const ACCT_LIVE = id('acct', 1)
export const ACCT_PAPER = id('acct', 2)
export const KEY_CLAUDE = id('ak', 11)
export const KEY_HERMES = id('ak', 12)
export const MDT_CLAUDE = id('mdt', 21)
export const MDT_HERMES = id('mdt', 22)

const origin = (actor: string, tool: string, via: Origin['via'], actorType: Origin['actorType'], n: number): Origin => ({
  actor: actor as Origin['actor'], actorType, tool, requestId: `00000000-0000-4000-8000-${hex(n, 12)}`, via, ...(actorType === 'llm-agent' ? { onBehalfOf: 'user:usr_local' as const } : {}),
})
export const O_CLAUDE = origin(`agent:${KEY_CLAUDE}`, 'propose', 'mcp', 'llm-agent', 1)
export const O_HERMES = origin(`agent:${KEY_HERMES}`, 'order', 'mcp', 'llm-agent', 2)
export const O_ENGINE = origin('strategy:ema-trend', 'strategy:ema-trend', 'gep', 'engine', 3)
export const O_HUMAN = origin('user:usr_local', 'ui:proposal.approve', 'ui', 'human', 4)
export const O_SYSTEM = origin('system:protector', 'protector:stoploss_guard', 'internal', 'system', 5)

const sha = (n: number) => `sha256:${hex(n, 64)}` as const

export function entry(seq: number, type: LedgerEntry['type'], o: Origin, subject: LedgerEntry['subject'], payload: Rec, ts: number, extra: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    schema: 'gitrader-ledger/1', seq, id: id('led', seq) as LedgerEntry['id'], ts, recordedAt: ts + 3, type, origin: o, subject, payload,
    payloadHash: sha(seq), attestation: 'kernel-observed', prevHash: sha(seq - 1), hash: sha(seq), ...extra,
  }
}

const accounts = [
  { accountId: ACCT_LIVE, alias: '测试网主账户', orgId: id('org', 1), groupIds: [], venue: 'hyperliquid', environment: 'testnet', mode: 'live', owner: { address: '0x00000000000000000000000000000000000000a1' }, accountModel: 'unified', signer: { type: 'api-wallet', credentialRef: 'wlt_demo', permissions: { trade: true, withdraw: false } }, status: 'active' },
  { accountId: ACCT_PAPER, alias: '纸面账户', orgId: id('org', 1), groupIds: [], venue: 'kernel-sim', environment: 'testnet', mode: 'paper', owner: {}, accountModel: 'sim', signer: { type: 'none', credentialRef: 'none', permissions: { trade: true, withdraw: false } }, paper: { initialBalance: '10000', ccy: 'USDC' }, status: 'active' },
]

const pos = (accountId: string, instrumentId: string, side: 'long' | 'short', size: string, entry: string, mark: string, upnl: string, liq: string | null, lev: number, estimated = false): Position => ({
  accountId: accountId as Position['accountId'], instrumentId, side, size: size as never, entryPrice: entry as never, markPrice: mark as never,
  notional: String(Math.round(Number(size) * Number(mark) * 100) / 100) as never, unrealizedPnl: upnl as never, realizedPnl: '0' as never, leverage: lev, marginMode: 'cross',
  liquidationPrice: liq as never, ...(estimated ? { estimated } : {}), fundingSinceOpen: '-1.24' as never, openedAt: NOW - 3 * 3600_000, updatedAt: NOW - 2000,
})

const positions: Record<string, Position[]> = {
  [ACCT_LIVE]: [
    pos(ACCT_LIVE, 'hyperliquid:BTC', 'long', '0.08', '64210.5', '64880.2', '53.58', '52110', 4),
    pos(ACCT_LIVE, 'hyperliquid:ETH', 'short', '1.2', '3185.2', '3170.8', '17.28', '3890.5', 3),
    pos(ACCT_LIVE, 'hyperliquid:xyz:TSLA', 'long', '5', '241.8', '241.8', '0', '188.2', 2),
  ],
  [ACCT_PAPER]: [pos(ACCT_PAPER, 'hyperliquid:SOL', 'long', '30', '148.3', '146.9', '-42', '121.4', 3, true)],
}

const summaries: Record<string, Rec> = {
  [ACCT_LIVE]: { accountId: ACCT_LIVE, equity: '12480.2', available: '8120.4', dayStartEquity: '12351.8', ts: NOW },
  [ACCT_PAPER]: { accountId: ACCT_PAPER, equity: '9987.5', available: '7210', dayStartEquity: '10000', ts: NOW },
}

const fill = (n: number, accountId: string, instrumentId: string, side: 'buy' | 'sell', price: string, size: string, realized: string, ts: number) => ({
  fillId: id('fill', n), orderId: id('ord', n), clientOrderId: hex(n, 32), venueFillId: `v${n}`, accountId, instrumentId, side, price, size, fee: '0.9', feeCcy: 'USDC', liquidity: 'taker', realizedPnl: realized, ts,
})
const fills: Record<string, Rec[]> = {
  [ACCT_LIVE]: [fill(1, ACCT_LIVE, 'hyperliquid:BTC', 'buy', '64210.5', '0.25', '0', NOW - 3 * 3600_000), fill(2, ACCT_LIVE, 'hyperliquid:ETH', 'sell', '3185.2', '3', '0', NOW - 2 * 3600_000), fill(3, ACCT_LIVE, 'hyperliquid:SOL', 'sell', '150.2', '20', '18.4', NOW - 600_000)],
  [ACCT_PAPER]: [fill(4, ACCT_PAPER, 'hyperliquid:SOL', 'buy', '148.3', '120', '0', NOW - 5 * 3600_000)],
}

const order = (n: number, accountId: string, instrumentId: string, side: 'buy' | 'sell', o: Origin, ts: number): Rec => ({
  orderId: id('ord', n), clientOrderId: hex(n, 32), accountId, instrumentId, side, type: 'limit', tif: 'gtc', size: '1', filledSize: '1', status: 'filled', fee: '0', origin: o, createdAt: ts, updatedAt: ts,
})
const orders: Record<string, Rec[]> = {
  [ACCT_LIVE]: [order(1, ACCT_LIVE, 'hyperliquid:BTC', 'buy', O_CLAUDE, NOW - 3 * 3600_000), order(2, ACCT_LIVE, 'hyperliquid:ETH', 'sell', O_ENGINE, NOW - 2 * 3600_000), order(5, ACCT_LIVE, 'hyperliquid:xyz:TSLA', 'buy', O_HUMAN, NOW - 4 * 3600_000)],
  [ACCT_PAPER]: [order(4, ACCT_PAPER, 'hyperliquid:SOL', 'buy', O_HERMES, NOW - 5 * 3600_000)],
}

const hit = (code: string, ruleId: string, limit: string, actual: string, unit: string, action: 'deny' | 'warn' | 'review' = 'deny') => ({ ruleId, code, limit, actual, unit, action, scope: 'org' })

const intent = (instrumentId: string, side: 'buy' | 'sell', size: string, price: string, reason: string): Rec => ({ accountId: ACCT_LIVE, instrumentId, side, type: 'limit', size, price, tif: 'gtc', reason })

export function proposal(n: number, ticket: string, status: string, expiresIn: number, o: Origin, legs: Rec[], reason: string, hits: Rec[] = [], est: Rec = { notional: '32105', marginRequired: '6421', liquidationPrice: '52110', slippageBps: 6 }): Proposal {
  return {
    proposalId: id('prop', n), ticket, kind: 'order', status, accountId: ACCT_LIVE, intents: legs, intentsDigest: sha(900 + n), reason,
    precheck: { precheckId: id('pck', n), verdict: 'review', policyVersion: 3, ruleHits: hits, estimates: est, expiresAt: NOW + expiresIn },
    priceBounds: { referencePrice: '64210', maxDriftBps: 30 }, mandateId: MDT_CLAUDE, expiresAt: NOW + expiresIn, decision: null, execution: null, origin: o,
  } as unknown as Proposal
}

const mandate = (mandateId: string, keyId: string, level: Mandate['level']): Mandate => ({
  mandateId, version: 2, subject: { type: 'agentKey', id: keyId }, level, accounts: [ACCT_LIVE, ACCT_PAPER] as never, venueAllowlist: ['hyperliquid', 'kernel-sim'], instrumentAllowlist: ['hyperliquid:BTC', 'hyperliquid:ETH', 'hyperliquid:SOL'],
  limits: { maxOrderNotional: '5000' as never, maxDailyNotional: '20000' as never }, notBefore: NOW - 86400_000, notAfter: NOW + 29 * 86400_000, status: 'active', issuedBy: 'user:usr_local',
  attestation: { method: 'pin', by: 'usr_local', at: NOW - 86400_000, digest: sha(77), sig: 'c2ln' },
} as unknown as Mandate)

const executed: Proposal = {
  ...proposal(6, 'T-20261010-0006', 'executed', -38 * 60_000, O_CLAUDE, [intent('hyperliquid:BTC', 'buy', '0.03', '64300', '上一单被拦后改走提案：同一标的小仓位，止损已设')], '上一单被拦后改走提案：同一标的小仓位，止损已设', [hit('NEEDS_APPROVAL', 'mdt_01JB#autoMaxOrderNotional', '2000', '9600', 'USDC', 'review')]),
  decision: { by: 'user:usr_local', at: NOW - 38 * 60_000 }, execution: { orderIds: [id('ord', 6)], at: NOW - 38 * 60_000 + 900, result: 'filled' },
} as unknown as Proposal

const keys = [
  { keyId: KEY_CLAUDE, name: 'Claude Code', host: 'claude-code', mandateId: MDT_CLAUDE, status: 'active', createdAt: NOW - 5 * 86400_000, expiresAt: NOW + 85 * 86400_000, lastSeenAt: NOW - 20_000, createdBy: 'user:usr_local' },
  { keyId: KEY_HERMES, name: 'Hermes', host: 'hermes', mandateId: MDT_HERMES, status: 'active', createdAt: NOW - 2 * 86400_000, expiresAt: NOW + 88 * 86400_000, lastSeenAt: NOW - 3_600_000, createdBy: 'user:usr_local' },
]

const ledger = (): LedgerEntry[] => [
  entry(101, 'order.intent', O_CLAUDE, { accountId: ACCT_LIVE as never, instrumentId: 'hyperliquid:BTC' }, { intent: intent('hyperliquid:BTC', 'buy', '0.25', '64210', '突破前高后回踩确认，按计划加仓') }, NOW - 3 * 3600_000, { precheck: { precheckId: id('pck', 1) as never, verdict: 'allow', policyVersion: 3, estimates: {} } }),
  entry(102, 'fill', { ...O_CLAUDE, actor: 'agent:' + KEY_CLAUDE as never }, { accountId: ACCT_LIVE as never, instrumentId: 'hyperliquid:BTC' }, { price: '64210.5', size: '0.25', side: 'buy', fee: '0.9', realizedPnl: '0' }, NOW - 3 * 3600_000 + 800),
  entry(103, 'order.intent', O_ENGINE, { accountId: ACCT_LIVE as never, instrumentId: 'hyperliquid:ETH' }, { intent: intent('hyperliquid:ETH', 'sell', '3', '3185', '快线下穿慢线') }, NOW - 2 * 3600_000, { precheck: { precheckId: id('pck', 2) as never, verdict: 'allow', policyVersion: 3, estimates: {} } }),
  entry(104, 'fill', O_ENGINE, { accountId: ACCT_LIVE as never, instrumentId: 'hyperliquid:ETH' }, { price: '3185.2', size: '3', side: 'sell', fee: '1.1', realizedPnl: '0' }, NOW - 2 * 3600_000 + 600),
  entry(105, 'order.intent', O_HERMES, { accountId: ACCT_LIVE as never, instrumentId: 'hyperliquid:SOL' }, { intent: intent('hyperliquid:SOL', 'buy', '40', '150', '情绪面转多，试探性建仓') }, NOW - 50 * 60_000, {
    precheck: { precheckId: id('pck', 3) as never, verdict: 'deny', policyVersion: 3, estimates: {} }, ruleHits: [hit('LLM_LIVE_ENTRY', 'pol_01JB#denyLlmLiveEntries', '0', '1', 'entries') as never],
  }),
  entry(106, 'risk.denied', O_HERMES, { accountId: ACCT_LIVE as never, precheckId: id('pck', 3) as never }, { problem: { code: 2001, name: 'RULE_DENIED', message: 'live entries originating from an LLM agent are denied by policy' } }, NOW - 50 * 60_000 + 5, {
    precheck: { precheckId: id('pck', 3) as never, verdict: 'deny', policyVersion: 3, estimates: {} }, ruleHits: [hit('LLM_LIVE_ENTRY', 'pol_01JB#denyLlmLiveEntries', '0', '1', 'entries') as never],
  }),
  entry(107, 'proposal.created', O_CLAUDE, { proposalId: id('prop', 6) as never, ticket: 'T-20261010-0006', accountId: ACCT_LIVE as never }, { status: 'pending', reason: '上一单被拦后改走提案：同一标的小仓位，止损已设' }, NOW - 40 * 60_000, { precheck: { precheckId: id('pck', 7) as never, verdict: 'review', policyVersion: 3, estimates: {} }, ruleHits: [hit('NEEDS_APPROVAL', 'mdt_01JB#autoMaxOrderNotional', '2000', '9600', 'USDC', 'review') as never] }),
  entry(108, 'proposal.decided', O_HUMAN, { proposalId: id('prop', 6) as never, ticket: 'T-20261010-0006' }, { decision: 'approved' }, NOW - 38 * 60_000),
  entry(109, 'proposal.executed', O_SYSTEM, { proposalId: id('prop', 6) as never, ticket: 'T-20261010-0006' }, {}, NOW - 38 * 60_000 + 900),
  entry(110, 'order.intent', O_ENGINE, { accountId: ACCT_LIVE as never, instrumentId: 'hyperliquid:BTC' }, { intent: { ...intent('hyperliquid:BTC', 'buy', '2', '64300', '杠杆过高的试单') } }, NOW - 25 * 60_000, {
    precheck: { precheckId: id('pck', 10) as never, verdict: 'deny', policyVersion: 3, estimates: {} }, ruleHits: [hit('ORDER_NOTIONAL', 'pol_01JB#maxOrderNotional', '5000', '128600', 'USDC') as never, hit('LEVERAGE', 'pol_01JB#maxLeverage', '5', '12', '×') as never],
  }),
  entry(111, 'protector.triggered', O_SYSTEM, { accountId: ACCT_LIVE as never }, { protector: 'stoploss_guard', scope: { type: 'account', id: ACCT_LIVE }, pauseMin: 30 }, NOW - 20 * 60_000, { ruleHits: [hit('PROTECTOR', 'prot_stoploss', '2', '2', '次') as never] }),
  entry(112, 'fill', O_SYSTEM, { accountId: ACCT_LIVE as never, instrumentId: 'hyperliquid:SOL' }, { price: '150.2', size: '20', side: 'sell', fee: '0.4', realizedPnl: '18.4' }, NOW - 10 * 60_000),
  entry(113, 'note', O_CLAUDE, { accountId: ACCT_LIVE as never }, { text: '今天先观察，不再开新仓，等资金费率回落' }, NOW - 5 * 60_000),
]

const risk = (state: TradingState, deny: boolean): Rec => ({
  tradingState: state,
  reasons: state === 'ACTIVE' ? [] : [{ scope: { type: 'org' }, state, reason: 'takeover flatten_all: 人在检阅面触发' }],
  policy: {
    version: 3, denyLlmLiveEntries: deny, dailyResetAt: '00:00Z', valuationCcy: 'USDC',
    protectors: [{ kind: 'cooldown', afterOpenSec: 5 }, { kind: 'stoploss_guard', windowMin: 60, maxStoplosses: 2, pauseMin: 30, scope: 'account' }, { kind: 'drawdown_pause', windowHours: 24, maxDrawdownRatio: '0.04', pauseMin: 120 }],
  },
  limits: { maxLeverage: 5, maxOrderNotional: '5000', maxTotalNotionalRatio: '1', maxDailyLossRatio: '0.05', maxSlippageBps: 30, maxOrdersPerMinute: 30, maxOrdersPerDay: 50 },
  integrity: { ok: true }, denyLlmLiveEntries: deny,
  usage: { orderNotional: 3210, ordersToday: 7 },
})

const venues = [
  { id: 'hyperliquid', venue: 'hyperliquid', environment: 'testnet', ts: NOW, wsState: 'connected', latencyMs: { p50: 42, p95: 88 }, rateBudget: { used: 312, limit: 1200, windowMs: 60000, ratio: 0.26 } },
  { id: 'kernel-sim', venue: 'kernel-sim', environment: 'testnet', ts: NOW, wsState: 'connected', latencyMs: { p50: 1, p95: 2 } },
]

export interface Scenario {
  name: ScenarioName
  accounts: Rec[]
  positions: Record<string, Position[]>
  summaries: Record<string, Rec>
  fills: Record<string, Rec[]>
  orders: Record<string, Rec[]>
  ledger: LedgerEntry[]
  proposals: Proposal[]
  keys: Rec[]
  mandates: Mandate[]
  risk: Rec
  venues: Rec[]
  /** 读取失败场景：这些查询一律报错。 */
  failing: boolean
}

export function scenario(name: ScenarioName): Scenario {
  const base: Scenario = {
    name, accounts: structuredClone(accounts), positions: structuredClone(positions), summaries: structuredClone(summaries), fills: structuredClone(fills), orders: structuredClone(orders),
    ledger: ledger(), proposals: [executed], keys: structuredClone(keys), mandates: [mandate(MDT_CLAUDE, KEY_CLAUDE, 'L2'), mandate(MDT_HERMES, KEY_HERMES, 'L1')], risk: risk('ACTIVE', true), venues: structuredClone(venues), failing: false,
  }
  switch (name) {
    case 'empty':
      return { ...base, accounts: [structuredClone(accounts[1] as Rec)], positions: { [ACCT_PAPER]: [] }, summaries: { [ACCT_PAPER]: { accountId: ACCT_PAPER, equity: '10000', available: '10000', dayStartEquity: '10000', ts: NOW } }, fills: { [ACCT_PAPER]: [] }, orders: { [ACCT_PAPER]: [] }, ledger: [], proposals: [], keys: [], mandates: [], venues: [structuredClone(venues[1] as Rec)] }
    case 'pending':
      return {
        ...base, proposals: [
          proposal(7, 'T-20261010-0007', 'pending', 9 * 60_000 + 42_000, O_CLAUDE, [intent('hyperliquid:BTC', 'buy', '0.5', '64210', '突破后回踩确认，计划分两笔建仓')], '突破前高后回踩确认，成交量放大，止损放在前低下方', [hit('NEEDS_APPROVAL', 'mdt_01JB#autoMaxOrderNotional', '2000', '32105', 'USDC', 'review')]),
          proposal(8, 'T-20261010-0008', 'pending', 3 * 60_000 + 5_000, O_CLAUDE, [intent('hyperliquid:ETH', 'sell', '2', '3190', '对冲多头敞口')], '对冲 BTC 多头的相关风险，减小净敞口', [], { notional: '6380', marginRequired: '2127', liquidationPrice: '3890.5', slippageBps: 4 }),
          ...base.proposals,
        ],
      }
    case 'halted': return { ...base, risk: risk('HALTED', true) }
    case 'error': return { ...base, failing: true }
    default: return base
  }
}
