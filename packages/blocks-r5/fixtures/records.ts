// SPDX-License-Identifier: CPAL-1.0
// 记录页夹具：与视觉稿同一份数据（15 笔成交 / 12 笔委托 / 122 条资金费）+ 一份 1200 笔成交的翻页数据。
// 全是合成数据，无真账户、无真密钥。parametric 的 records.query 处理器按内核语义（过滤 / 游标 / 倒序）回包，
// stage-entry 的 queries 只收静态值，所以测试与舞台在启动后调 installRecordsHandlers(kernel, set) 覆盖。
type Rec = Record<string, unknown>

export const ACCT_LIVE = 'acct_hl_main'
export const ACCT_PAPER = 'acct_paper_1'
export const accounts = [
  { accountId: ACCT_LIVE, alias: 'hl-main', venue: 'hyperliquid', environment: 'testnet', mode: 'live' },
  { accountId: ACCT_PAPER, alias: 'paper-1', venue: 'kernel-sim', environment: 'testnet', mode: 'paper' },
]
export const agentKeys = { keys: [{ keyId: 'key_claude', name: 'Claude Code', host: 'mcp', status: 'active', mandateId: 'mdt_1' }] }
export const proposals = [{ proposalId: 'prop_0006', ticket: 'T-0006' }, { proposalId: 'prop_0005', ticket: 'T-0005' }, { proposalId: 'prop_0003', ticket: 'T-0003' }, { proposalId: 'prop_0002', ticket: 'T-0002' }]

const O = {
  human: { actor: 'user:usr_local', actorType: 'human', tool: 'ui:order', requestId: 'req_h', via: 'ui' },
  agent: { actor: 'agent:key_claude', actorType: 'llm-agent', tool: 'order', requestId: 'req_a', via: 'mcp' },
  system: { actor: 'system:protector', actorType: 'system', tool: 'protector:stoploss_guard', requestId: 'req_s', via: 'internal' },
  live: { actor: 'strategy:ema-trend', actorType: 'engine', tool: 'strategy:ema-trend', requestId: 'req_e', via: 'gep' },
  paper: { actor: 'strategy:grid-paper', actorType: 'engine', tool: 'strategy:grid-paper', requestId: 'req_g', via: 'gep' },
} as const
type ActorKey = keyof typeof O

const DAY = 86_400_000
/** 稿里「现在」= 10-22 21:30（本地时间）；夹具整天平移到今天附近，保证落在默认 7 天窗口内、显示的月日随之平移。 */
const anchor = new Date(2026, 9, 22, 21, 30, 0).getTime()
// 最新一条夹具在稿里 21:10:31（距 anchor 19 分 29 秒）：平移时把这段提前量算进去，保证「1 天」窗口任何时刻都至少含最新一条
// （只按 anchor 取整天时，每天本地 21:10:31–21:30 最新一条也已超过 24 小时，选「1 天」后整段为空）。最新一条始终落在 (现在−24h, 现在]。
const LEAD = 1_169_000
const shiftFor = (now: number): number => Math.floor((now - anchor + LEAD) / DAY) * DAY
const at = (md: string | number, shift: number): number => {
  if (typeof md === 'number') return md
  const m = /^(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)$/.exec(md)
  if (!m) throw new Error('bad time ' + md)
  return new Date(2026, Number(m[1]) - 1, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])).getTime() + shift
}

export interface RecordsSet { fills: Rec[]; orders: Rec[]; funding: Rec[]; ledger: Rec[] }

const venueOf = (accountId: string): string => (accountId === ACCT_PAPER ? 'kernel-sim' : 'hyperliquid')

// [账户, 时间, 标的, 方向, 价, 量, 手续费, 已实现, 行为人, 票号?]
type F = [string, string | number, string, 'buy' | 'sell', string, string, string, string, ActorKey, string?]
const FILLS: F[] = [
  [ACCT_LIVE, '10-22 21:10:31', 'BTC', 'sell', '64930', '0.05', '1.62', '36.00', 'agent', 'T-0006'],
  [ACCT_LIVE, '10-22 20:44:18', 'BTC', 'sell', '64700', '0.01', '0.32', '4.90', 'system'],
  [ACCT_LIVE, '10-22 19:03:10', 'SOL', 'buy', '151.2', '30', '2.27', '0', 'human'],
  [ACCT_LIVE, '10-22 03:20:44', 'BTC', 'buy', '64330', '0.08', '2.57', '0', 'human'],
  [ACCT_LIVE, '10-21 23:41:12', 'BTC', 'buy', '64050', '0.06', '1.92', '0', 'live'],
  [ACCT_LIVE, '10-21 13:47:09', 'ETH', 'sell', '3240', '1.2', '1.94', '0', 'agent', 'T-0005'],
  [ACCT_LIVE, '10-20 08:31:12', 'SOL', 'sell', '139.8', '20', '1.40', '-96.00', 'agent', 'T-0003'],
  [ACCT_LIVE, '10-19 11:05:30', 'SOL', 'buy', '144.6', '20', '1.45', '0', 'agent', 'T-0002'],
  [ACCT_LIVE, '10-18 16:20:44', 'ETH', 'sell', '3108', '1', '1.55', '88.00', 'human'],
  [ACCT_LIVE, '10-17 09:42:15', 'ETH', 'buy', '3020', '1', '1.51', '0', 'human'],
  [ACCT_PAPER, '10-22 20:12:40', 'BTC', 'buy', '63900', '0.05', '0.64', '0', 'paper'],
  [ACCT_PAPER, '10-22 09:18:22', 'BTC', 'sell', '64400', '0.01', '0.13', '5.00', 'paper'],
  [ACCT_PAPER, '10-22 02:51:07', 'BTC', 'buy', '63900', '0.01', '0.13', '0', 'paper'],
  [ACCT_PAPER, '10-21 16:48:31', 'BTC', 'sell', '64900', '0.01', '0.13', '5.00', 'paper'],
  [ACCT_PAPER, '10-21 10:12:05', 'BTC', 'buy', '64400', '0.01', '0.13', '0', 'paper'],
]

// [账户, 时间, 标的, 方向, 类型, 价, 触发价, 量, 已成, 状态, 行为人, 提案, 只减仓, 拦截原文?]
type OD = [string, string, string, 'buy' | 'sell', string, string | null, string | null, string, string, string, ActorKey, string | null, boolean, string?]
const ORDERS: OD[] = [
  [ACCT_LIVE, '10-22 21:10:29', 'BTC', 'sell', 'market', null, null, '0.05', '0.05', 'filled', 'agent', 'prop_0006', false],
  [ACCT_LIVE, '10-22 20:58:03', 'BTC', 'buy', 'limit', '64210', null, '0.5', '0', 'denied', 'agent', null, false, '单笔上限 8,000，实际 32,105'],
  [ACCT_LIVE, '10-22 20:44:18', 'BTC', 'sell', 'market', null, null, '0.01', '0.01', 'filled', 'system', null, false],
  [ACCT_LIVE, '10-22 19:03:08', 'SOL', 'buy', 'limit', '151.2', null, '30', '30', 'filled', 'human', null, false],
  [ACCT_LIVE, '10-22 17:30:02', 'ETH', 'buy', 'limit', '3150', null, '1.2', '0', 'cancelled', 'human', null, false],
  [ACCT_LIVE, '10-22 03:21:05', 'BTC', 'sell', 'stop_market', null, '63100', '0.08', '0', 'open', 'human', null, true],
  [ACCT_LIVE, '10-22 03:20:44', 'BTC', 'buy', 'market', null, null, '0.08', '0.08', 'filled', 'human', null, false],
  [ACCT_LIVE, '10-21 23:41:10', 'BTC', 'buy', 'limit', '64050', null, '0.06', '0.06', 'filled', 'live', null, false],
  [ACCT_LIVE, '10-21 13:47:08', 'ETH', 'sell', 'market', null, null, '1.2', '1.2', 'filled', 'agent', 'prop_0005', false],
  [ACCT_PAPER, '10-22 20:15:02', 'BTC', 'sell', 'limit', '65200', null, '0.01', '0', 'open', 'paper', null, false],
  [ACCT_PAPER, '10-22 20:15:02', 'BTC', 'buy', 'limit', '64400', null, '0.01', '0', 'open', 'paper', null, false],
  [ACCT_PAPER, '10-22 20:05:11', 'BTC', 'buy', 'limit', '63900', null, '0.05', '0.05', 'filled', 'paper', null, false],
]

const hex = (n: number): string => n.toString(16).padStart(32, '0')
const pad5 = (n: number): string => String(n).padStart(5, '0')

/** 资金费：账本条目原样（type=funding，payload.payment 为现金流，负 = 付出）。实盘 108 条合计 −3.85，纸面 14 条合计 −0.17，与稿同数。 */
function fundingRows(shift: number): Rec[] {
  const out: Rec[] = []
  let n = 0
  const base = at('10-22 21:00:00', shift)
  const push = (accountId: string, sym: string, h: number, payment: string, notional: string, rate: string) => {
    n += 1
    const ts = base - h * 3_600_000
    out.push({
      schema: 'gitrader-ledger/1', seq: 5000 + n, id: `led_fund_${n}`, ts, recordedAt: ts, type: 'funding', origin: O.system,
      subject: { accountId, instrumentId: `${venueOf(accountId)}:${sym}` }, payload: { payment, ccy: 'USDC', rate, notional }, attestation: 'venue-confirmed',
    })
  }
  for (let h = 0; h < 36; h += 1) {
    // 同一整点内 seq 后写的排前（内核 ts DESC, seq DESC），所以按 SOL → ETH → BTC 写，读出来是 BTC、ETH、SOL
    push(ACCT_LIVE, 'SOL', h, '-0.06', (4470 + (h % 3) * 3.38).toFixed(2), '0.000013')
    push(ACCT_LIVE, 'ETH', h, '0.04', (3840 + (h % 5) * 2.17).toFixed(2), '0.000011')
    push(ACCT_LIVE, 'BTC', h, h < 11 ? '-0.08' : '-0.09', (9000 + (h % 7) * 17.31).toFixed(2), '0.00001')
  }
  for (let h = 0; h < 7; h += 1) {
    push(ACCT_PAPER, 'ETH', h, h < 4 ? '0.01' : '0.00', '1210.00', '0.000011')
    push(ACCT_PAPER, 'BTC', h, '-0.03', '3195.00', '0.00001')
  }
  return out.sort((a, b) => (b.ts as number) - (a.ts as number) || (b.seq as number) - (a.seq as number))
}

/** 事件链所需的账本条目（ledger.trace 按 orderId 取）：意图 → 预检 →（Agent 单）待批 → 批准 → 提交 → 成交。 */
function ledgerFor(orders: Rec[], fills: Rec[]): Rec[] {
  const out: Rec[] = []
  let seq = 1000
  const entry = (type: string, ts: number, origin: Rec, subject: Rec, extra: Rec = {}): void => {
    seq += 1
    out.push({ schema: 'gitrader-ledger/1', seq, id: `led_${seq}`, ts, recordedAt: ts, type, origin, subject, payload: {}, attestation: 'kernel-observed', ...extra })
  }
  const chain = (o: { orderId: unknown; accountId: unknown; instrumentId: unknown; proposalId?: unknown; origin: Rec; ts: number }) => {
    const subject = { accountId: o.accountId, instrumentId: o.instrumentId, orderId: o.orderId, ...(o.proposalId ? { proposalId: o.proposalId } : {}) }
    const ticket = proposals.find((p) => p.proposalId === o.proposalId)?.ticket
    entry('order.intent', o.ts - 31_000, o.origin, subject)
    entry('risk.precheck', o.ts - 30_000, O.system, subject, { precheck: { precheckId: `pck_${seq}`, verdict: ticket ? 'review' : 'allow', policyVersion: 3, estimates: {} } })
    if (ticket) {
      entry('proposal.created', o.ts - 29_000, o.origin, { ...subject, ticket })
      entry('proposal.decided', o.ts - 7_000, O.human, { ...subject, ticket }, { payload: { decision: 'approved' } })
    }
    entry('order.submitted', o.ts - 2_000, O.system, subject)
  }
  const known = new Set(orders.map((o) => o.orderId))
  for (const o of orders) chain({ orderId: o.orderId, accountId: o.accountId, instrumentId: o.instrumentId, proposalId: o.proposalId, origin: o.origin as Rec, ts: o.createdAt as number })
  for (const f of fills) if (!known.has(f.orderId)) chain({ orderId: f.orderId, accountId: f.accountId, instrumentId: f.instrumentId, origin: f.origin as Rec, ts: f.ts as number })
  for (const f of fills) entry('fill', f.ts as number, f.origin as Rec, { accountId: f.accountId, instrumentId: f.instrumentId, orderId: f.orderId, fillId: f.fillId })
  return out
}

function build(fillRows: F[], orderRows: OD[], now: number): RecordsSet {
  const shift = shiftFor(now)
  const fills = fillRows.map((r, i): Rec => ({
    fillId: `fill_${pad5(i + 1)}`, orderId: i === 0 ? `ord_${pad5(1)}` : `ord_f${pad5(i + 1)}`, clientOrderId: hex(i + 1), venueFillId: `v${i + 1}`,
    accountId: r[0], instrumentId: `${venueOf(r[0])}:${r[2]}`, side: r[3], price: r[4], size: r[5], fee: r[6], feeCcy: 'USDC',
    liquidity: r[0] === ACCT_PAPER ? 'maker' : 'taker', realizedPnl: r[7], ts: at(r[1], shift), origin: O[r[8]], ...(r[9] ? { ticket: r[9] } : {}),
  }))
  const orders = orderRows.map((r, i): Rec => ({
    orderId: `ord_${pad5(i + 1)}`, clientOrderId: hex(100 + i), accountId: r[0], instrumentId: `${venueOf(r[0])}:${r[2]}`, side: r[3], type: r[4], tif: 'gtc',
    size: r[7], filledSize: r[8], ...(r[5] ? { price: r[5] } : {}), ...(r[6] ? { triggerPrice: r[6] } : {}), status: r[9], fee: '0', origin: O[r[10]],
    ...(r[11] ? { proposalId: r[11] } : {}), ...(r[12] ? { reduceOnly: true } : {}),
    ...(r[13] ? { problem: { code: 2001, name: 'RULE_DENIED', message: r[13] } } : {}), createdAt: at(r[1], shift), updatedAt: at(r[1], shift),
  }))
  return { fills, orders, funding: fundingRows(shift), ledger: ledgerFor(orders, fills) }
}

/** 与稿同一份：15 / 12 / 122。 */
export const designSet = (now = Date.now()): RecordsSet => build(FILLS, ORDERS, now)

/** 1200 笔成交（实盘 960 + 纸面 240，4 分钟一笔往回排）+ 稿里的委托 / 资金费，验游标续读到底。 */
export function bigSet(now = Date.now()): RecordsSet {
  const fills: F[] = []
  for (let i = 0; i < 1200; i += 1) {
    const live = i % 5 !== 4
    fills.push([live ? ACCT_LIVE : ACCT_PAPER, now - 180_000 - i * 240_000, ['BTC', 'ETH', 'SOL'][i % 3] as string, i % 2 ? 'buy' : 'sell', String(60000 + (i % 97) * 11), '0.01', '0.12', i % 7 === 0 ? '1.50' : '0', live ? (['human', 'agent', 'live', 'system'] as const)[i % 4] as ActorKey : 'paper'])
  }
  return build(fills, ORDERS, now)
}

// ---- 被拦（risk.denials 回包 = 账本 risk.denied 条目）-------------------------------------------

const deniedHit = (code: string, ruleId: string, limit: string, actual: string, unit: string) => ({ ruleId, code, limit, actual, unit, action: 'deny', scope: 'org' })
/** 两条被风控拦下的单（Agent 超单笔上限、策略杠杆过高），形状同 blocks-default 总览夹具里的 risk.denied。 */
export function denialsOf(now = Date.now()): Rec[] {
  const mk = (seq: number, ts: number, origin: Rec, accountId: string, instrumentId: string, hits: Rec[], message: string): Rec => ({
    schema: 'gitrader-ledger/1', seq, id: `led_den_${seq}`, ts, recordedAt: ts + 3, type: 'risk.denied', origin, subject: { accountId, instrumentId, precheckId: `pck_den_${seq}` },
    payload: { problem: { code: 2001, name: 'RULE_DENIED', message } }, precheck: { precheckId: `pck_den_${seq}`, verdict: 'deny', policyVersion: 3, estimates: {} }, ruleHits: hits,
    payloadHash: `sha256:${'0'.repeat(64)}`, attestation: 'kernel-observed', prevHash: `sha256:${'0'.repeat(64)}`, hash: `sha256:${'0'.repeat(64)}`,
  })
  return [
    mk(9102, now - 40 * 60_000, O.live, ACCT_LIVE, 'hyperliquid:ETH', [deniedHit('LEVERAGE', 'pol_01#maxLeverage', '5', '12', '×')], 'leverage above policy'),
    mk(9101, now - 3 * 3600_000, O.agent, ACCT_LIVE, 'hyperliquid:BTC', [deniedHit('ORDER_NOTIONAL', 'pol_01#maxOrderNotional', '2000', '2428.92', 'USDC')], 'order notional above policy'),
  ]
}

// ---- 内核语义的 records.query -------------------------------------------------------------

const enc = (ts: number, key: string | number, d: string): string => btoa(JSON.stringify({ ts, key, d })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const dec = (s: string): { ts: number; key: string | number; d: string } => JSON.parse(atob(s.replace(/-/g, '+').replace(/_/g, '/'))) as { ts: number; key: string | number; d: string }
const bad = (message: string): never => { throw Object.assign(new Error(message), { code: -32602, data: { name: 'INVALID_PARAMS', message } }) }
const tsOf = (kind: string, r: Rec): number => (kind === 'order' ? (r.createdAt as number) : (r.ts as number))
const idOf = (kind: string, r: Rec): string | number => (kind === 'fill' ? (r.fillId as string) : kind === 'order' ? (r.orderId as string) : (r.seq as number))
const acctOf = (kind: string, r: Rec): unknown => (kind === 'funding' ? (r.subject as Rec).accountId : r.accountId)
const instOf = (kind: string, r: Rec): unknown => (kind === 'funding' ? (r.subject as Rec).instrumentId : r.instrumentId)

/** 按内核 queryRecords 的语义过滤、倒序、游标分页（ts 倒序，同刻按键倒序）。 */
export function recordsQuery(set: RecordsSet, p: Rec): { items: Rec[]; next?: string } {
  const kind = String(p.kind)
  const all = kind === 'fill' ? set.fills : kind === 'order' ? set.orders : set.funding
  const limit = typeof p.limit === 'number' ? p.limit : 100
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) bad('limit must be an integer in 1..500')
  // 与内核同：游标绑定筛选条件，换了条件（含时间界）再带旧游标就是错
  const digest = JSON.stringify([kind, p.accountId ?? null, p.instrumentId ?? null, p.actorType ?? null, p.sinceTs ?? null, p.untilTs ?? null])
  const rows = all
    .filter((r) => (p.accountId === undefined || acctOf(kind, r) === p.accountId) && (p.instrumentId === undefined || instOf(kind, r) === p.instrumentId)
      && (p.sinceTs === undefined || tsOf(kind, r) >= (p.sinceTs as number)) && (p.untilTs === undefined || tsOf(kind, r) < (p.untilTs as number))
      && (p.actorType === undefined || kind === 'funding' || ((r.origin as Rec | undefined)?.actorType === p.actorType)))
    .sort((a, b) => tsOf(kind, b) - tsOf(kind, a) || (idOf(kind, b) < idOf(kind, a) ? -1 : idOf(kind, b) > idOf(kind, a) ? 1 : 0))
  const cur = typeof p.cursor === 'string' ? dec(p.cursor) : null
  if (cur && cur.d !== digest) bad('cursor does not match this query')
  const rest = cur ? rows.filter((r) => tsOf(kind, r) < cur.ts || (tsOf(kind, r) === cur.ts && idOf(kind, r) < cur.key)) : rows
  const items = rest.slice(0, limit)
  const last = items.at(-1)
  return { items, ...(rest.length > limit && last ? { next: enc(tsOf(kind, last), idOf(kind, last), digest) } : {}) }
}

export interface RecordsLog { exports: Rec[] }
interface Hooks {
  onQuery(method: string, fn: (params: unknown) => unknown): void
  onCommand(action: string, fn: (params: unknown) => unknown): void
}
/** 把整套处理器装进假内核：records.query / ledger.trace / ledger.query（导出范围用）/ ledger.export / account.list / agentkey.list / proposal.list。 */
export function installRecordsHandlers(kernel: Hooks, set: RecordsSet): RecordsLog {
  const log: RecordsLog = { exports: [] }
  kernel.onQuery('account.list', () => accounts)
  kernel.onQuery('agentkey.list', () => agentKeys)
  kernel.onQuery('proposal.list', () => proposals)
  kernel.onQuery('records.query', (p) => recordsQuery(set, (p ?? {}) as Rec))
  kernel.onQuery('risk.denials', (p) => { const q = (p ?? {}) as Rec; return denialsOf().filter((e) => q.accountId === undefined || (e.subject as Rec).accountId === q.accountId).slice(0, typeof q.limit === 'number' ? q.limit : 50) })
  kernel.onQuery('ledger.trace', (p) => set.ledger.filter((e) => (e.subject as Rec).orderId === ((p ?? {}) as Rec).orderId))
  kernel.onQuery('ledger.query', (p) => {
    const q = (p ?? {}) as Rec
    const rows = [...set.ledger, ...set.funding]
      .filter((e) => (q.sinceTs === undefined || (e.ts as number) >= (q.sinceTs as number)) && (q.untilTs === undefined || (e.ts as number) <= (q.untilTs as number)))
      .sort((a, b) => (q.order === 'asc' ? (a.seq as number) - (b.seq as number) : (b.seq as number) - (a.seq as number)))
    return rows.slice(0, typeof q.limit === 'number' ? q.limit : 50)
  })
  kernel.onCommand('ledger.export', (p) => {
    const q = (p ?? {}) as Rec
    log.exports.push(q)
    return { schema: 'gitrader-ledger-export/1', fromSeq: q.fromSeq ?? 0, toSeq: q.toSeq ?? 9999, count: 42 }
  })
  return log
}

const base = (): Rec => ({ 'account.list': accounts, 'agentkey.list': agentKeys, 'proposal.list': proposals })
const withFills = (): Rec => ({ ...base(), 'records.query': { items: designSet().fills }, 'risk.denials': denialsOf() })

export const recordsFixtures = {
  normal: { view: 'fills', queries: withFills() },
  empty: { view: 'fills', queries: base() },
  loading: { view: 'fills', queries: withFills() },
  error: { view: 'fills', queries: base() },
  offline: { view: 'fills', queries: withFills() },
  unwired: { view: 'fills', queries: base() },
}
