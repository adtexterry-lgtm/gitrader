// SPDX-License-Identifier: CPAL-1.0
// 图表页夹具：与视觉稿同一批数字（BTC-PERP 15m 最新价 64,812.0 +0.42%、持仓 多 0.08 @ 64,210.0、止损 63,100.0、待批 买 0.05 @ 64,600.0、强平约 52,100.0）。
// 全是合成数据（种子随机、非行情），无真账户、无真密钥。
// stage-entry 的 queries 只收静态值；带参数、会失败、会记账的处理器由测试 / 舞台在启动后调 installChartHandlers(kernel, set) 装上。
import { recordsQuery } from './records'
type Rec = Record<string, unknown>

export const ACCT_LIVE = 'acct_hl_main'
export const ACCT_PAPER = 'acct_paper_1'
export const BTC = 'hyperliquid:BTC'
export const ETH = 'hyperliquid:ETH'
export const SOL = 'hyperliquid:SOL'
/** 夹具内核的 PIN（只在本夹具内有效）。 */
export const TICKET_PIN = '246810'

const STEP: Record<string, number> = { '1m': 60_000, '5m': 300_000, '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000 }
/** 标的 → [最新价, 前收]（涨跌幅 = 最新 / 前收 − 1：BTC +0.42%、ETH −1.10%、SOL +2.05%）。 */
const LEVEL: Record<string, [number, number]> = { [BTC]: [64812.0, 64541.0], [ETH]: [3182.0, 3217.4], [SOL]: [148.2, 145.22] }

export const accounts = [
  { accountId: ACCT_LIVE, alias: 'hl-main', venue: 'hyperliquid', environment: 'testnet', mode: 'live' },
  { accountId: ACCT_PAPER, alias: 'paper-1', venue: 'kernel-sim', environment: 'testnet', mode: 'paper' },
]

const O = {
  human: { actor: 'user:usr_local', actorType: 'human', tool: 'ui:order', requestId: 'req_h', via: 'ui' },
  agent: { actor: 'agent:key_claude', actorType: 'llm-agent', tool: 'order', requestId: 'req_a', via: 'mcp' },
  engine: { actor: 'strategy:ema-trend', actorType: 'engine', tool: 'strategy:ema-trend', requestId: 'req_e', via: 'gep' },
  system: { actor: 'system:protector', actorType: 'system', tool: 'protector:stoploss_guard', requestId: 'req_s', via: 'internal' },
} as const
type ActorKey = keyof typeof O
export const agentKeys = { keys: [{ keyId: 'key_claude', name: 'Claude Code', host: 'mcp', status: 'active', mandateId: 'mdt_1' }] }

/** 种子随机（线性同余）：同一标的 + 周期永远得到同一串 K 线。 */
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296 }
}
const hash = (t: string): number => [...t].reduce((a, c) => (Math.imul(a, 31) + c.charCodeAt(0)) >>> 0, 7)
const round = (v: number, places: number): string => v.toFixed(places)

/** BTC 15m 的形：距现在几根之前 → 价格（控制点线性插值；170 根以外取 64,300 附近）。 */
const CURVE: Array<[number, number]> = [[170, 64300], [150, 64550], [120, 64400], [90, 63900], [60, 63450], [40, 63850], [20, 64100], [8, 64300]]
function curve(back: number, last: number): number {
  if (back > 170) return 64300
  if (back <= 0) return last
  if (back <= 8) return 64300 + (last - 64300) * ((8 - back) / 8) ** 2
  for (let k = 0; k < CURVE.length - 1; k += 1) {
    const [b0, p0] = CURVE[k]!
    const [b1, p1] = CURVE[k + 1]!
    if (back <= b0 && back >= b1) return p1 + (p0 - p1) * ((back - b1) / (b0 - b1))
  }
  return 64300
}

export interface Candle { t: number; o: string; h: string; l: string; c: string; v: string }
/** 一串 K 线（升序，最后一根开盘 = 现在所在周期的起点；收盘价 = 标的最新价；1d 倒数第二根收盘 = 前收）。 */
export function candlesFor(instrumentId: string, interval: string, limit: number, now: number): Candle[] {
  const step = STEP[interval] ?? STEP['15m']!
  const [lastPx, prev] = LEVEL[instrumentId] ?? [100, 99]
  const places = lastPx >= 1000 ? 1 : 2
  const n = Math.max(1, Math.min(limit, 1000))
  const rand = rng(hash(`${instrumentId}|${interval}`))
  const t0 = Math.floor(now / step) * step - (n - 1) * step
  // 均值回归的随机游走（不会漂出视野）；BTC 15m 再叠一条与视觉稿同形的走势：先升后跌、探到 63,4xx、末段拉升到最新价
  const raw: number[] = []
  let dev = 0
  for (let i = 0; i < n; i += 1) {
    dev += -dev * 0.2 + (rand() - 0.5) * lastPx * 0.0012
    const back = n - 1 - i
    raw.push((instrumentId === BTC && interval === '15m' ? curve(back, lastPx) : lastPx * 0.995) + dev)
  }
  const shift = lastPx - raw[n - 1]!
  const closes = raw.map((c, i) => (interval === '1d' && i === n - 2 ? prev : c + shift))
  return closes.map((close, i) => {
    const open = i === 0 ? close - (rand() - 0.5) * lastPx * 0.001 : closes[i - 1]!
    const hi = Math.max(open, close) + rand() * lastPx * 0.0007
    const lo = Math.min(open, close) - rand() * lastPx * 0.0007
    return { t: t0 + i * step, o: round(open, places), h: round(hi, places), l: round(lo, places), c: round(close, places), v: String(Math.round(200 + rand() * 1000)) }
  })
}

export interface ChartSet {
  now: number
  positions: Record<string, Rec[]>
  orders: Record<string, Rec[]>
  proposals: Rec[]
  fills: Rec[]
  venues: Rec[]
  /** 失败注入：值是内核原文；'unsupported' 回 CAPABILITY_UNSUPPORTED，'missing' 回 METHOD_NOT_FOUND。candles 只管 1d 以外的 K 线（涨跌幅用的 1d 不受影响）。 */
  fail: { candles?: string; records?: string; positions?: string }
  /** 空 K 线（所选周期没数据）。 */
  emptyCandles?: boolean
  /** K 线查询（1d 以外）先等这么久，用来看加载态。 */
  delayMs?: number
  /** 品种表是空的（没有缺省标的可选）。 */
  noInstruments?: boolean
  /** 下单 / 平仓 / 撤单一律被拒（原文）。 */
  reject?: string
  /** 实盘账户的命令是否要在场证明。 */
  pinForLive: boolean
}

// [账户, 几根之前, 标的, 方向, 量, 手续费, 行为人]
type F = [string, number, string, 'buy' | 'sell', string, string, ActorKey]
/** 12 笔成交：买 / 卖 × 你 / 引擎 / Agent / 系统，散在最近 ~38 小时的 15m K 线上（价格 = 那根的收盘价，保证落在 K 线内）。 */
const FILLS: F[] = [
  [ACCT_LIVE, 150, BTC, 'buy', '0.08', '2.30', 'human'], [ACCT_LIVE, 126, BTC, 'sell', '0.05', '1.44', 'agent'], [ACCT_LIVE, 102, BTC, 'buy', '0.06', '1.74', 'engine'],
  [ACCT_LIVE, 80, BTC, 'sell', '0.04', '1.17', 'human'], [ACCT_LIVE, 62, BTC, 'buy', '0.08', '2.32', 'agent'], [ACCT_LIVE, 48, BTC, 'sell', '0.05', '1.45', 'engine'],
  [ACCT_LIVE, 36, BTC, 'buy', '0.06', '1.74', 'human'], [ACCT_LIVE, 28, BTC, 'sell', '0.04', '1.16', 'agent'], [ACCT_LIVE, 22, BTC, 'buy', '0.08', '2.30', 'system'],
  [ACCT_LIVE, 14, BTC, 'sell', '0.05', '1.43', 'engine'], [ACCT_LIVE, 8, BTC, 'buy', '0.06', '1.72', 'engine'], [ACCT_LIVE, 3, BTC, 'sell', '0.04', '1.16', 'human'],
]

export function designSet(now = Date.now()): ChartSet {
  const bars = candlesFor(BTC, '15m', 1000, now)
  const step = STEP['15m']!
  const fills = FILLS.map(([accountId, back, instrumentId, side, size, fee, actor], i) => {
    const bar = bars[bars.length - 1 - back]!
    return {
      fillId: `fill_${String(i + 1).padStart(2, '0')}`, accountId, instrumentId, orderId: `ord_${String(i + 1).padStart(5, '0')}`, ts: bar.t + Math.floor(step / 3),
      side, price: bar.c, size, fee, realizedPnl: '0', liquidity: 'taker', origin: O[actor],
    }
  })
  return {
    now,
    positions: {
      [ACCT_LIVE]: [
        { instrumentId: BTC, side: 'long', size: '0.08', entryPrice: '64210.0', markPrice: '64812.0', unrealizedPnl: '48.16', leverage: 4, liquidationPrice: '52100.0', estimated: true, notional: '5184.96', openedAt: now - 6 * 3_600_000 },
        { instrumentId: ETH, side: 'short', size: '1.2', entryPrice: '3240.0', markPrice: '3182.0', unrealizedPnl: '69.60', leverage: 3, liquidationPrice: '4580.0', estimated: false, notional: '3818.40', openedAt: now - 20 * 3_600_000 },
        { instrumentId: SOL, side: 'long', size: '30', entryPrice: '151.2', markPrice: '148.2', unrealizedPnl: '-90.00', leverage: 3, liquidationPrice: '98.0', estimated: false, notional: '4446.00', openedAt: now - 30 * 3_600_000 },
      ],
      [ACCT_PAPER]: [],
    },
    orders: {
      [ACCT_LIVE]: [
        { orderId: 'ord_stop_btc', accountId: ACCT_LIVE, instrumentId: BTC, side: 'sell', type: 'stop_market', size: '0.08', filledSize: '0', triggerPrice: '63100.0', reduceOnly: true, status: 'untriggered', origin: O.human, createdAt: now - 3_600_000 },
      ],
      [ACCT_PAPER]: [],
    },
    proposals: [
      { proposalId: 'prop_0008', ticket: 'T-0008', status: 'pending', accountId: ACCT_LIVE, origin: O.agent, expiresAt: now + 289_000, intents: [{ accountId: ACCT_LIVE, instrumentId: BTC, side: 'buy', type: 'limit', size: '0.05', price: '64600.0' }] },
      { proposalId: 'prop_0007', ticket: 'T-0007', status: 'pending', accountId: ACCT_LIVE, origin: O.agent, expiresAt: now + 185_000, intents: [{ accountId: ACCT_LIVE, instrumentId: ETH, side: 'sell', type: 'limit', size: '2', price: '3190.0' }] },
    ],
    fills,
    venues: [{ venue: 'hyperliquid', connection: 'connected' }, { venue: 'kernel-sim', connection: 'connected' }],
    fail: {},
    pinForLive: true,
  }
}

const problem = (name: string, code: number, message: string) => Object.assign(new Error(message), { code, data: { code, name, message, category: 'PROTOCOL', retryable: false } })
const markOf = (instrumentId: string): string => { const [px] = LEVEL[instrumentId] ?? [100, 99]; return px >= 1000 ? px.toFixed(1) : px.toFixed(2) }

interface Hooks {
  onQuery(method: string, fn: (params: unknown) => unknown): void
  onCommand(action: string, fn: (params: unknown, ctx: { origin?: unknown; attestation?: unknown }) => unknown): void
  publish(topic: string, data: unknown): number
}
export interface ChartLog { placed: Rec[]; closed: Rec[]; cancelled: Rec[]; pins: number }

/** 把整套处理器装进假内核（形状照真内核：ops.ts 的 q() / c()）。 */
export function installChartHandlers(kernel: Hooks, set: ChartSet): ChartLog {
  const log: ChartLog = { placed: [], closed: [], cancelled: [], pins: 0 }
  let seq = 0
  const failWith = (v: string | undefined, name: string): void => {
    if (v === undefined) return
    if (v === 'missing') throw problem('METHOD_NOT_FOUND', -32601, 'unknown method')
    if (v === 'unsupported') throw problem('CAPABILITY_UNSUPPORTED', 2201, 'no candle source')
    throw problem(name, -32603, v)
  }
  kernel.onQuery('account.list', () => accounts)
  kernel.onQuery('agentkey.list', () => agentKeys)
  kernel.onQuery('venue.status', () => set.venues)
  kernel.onQuery('proposal.list', (p) => set.proposals.filter((x) => !(p as Rec | undefined)?.status || x.status === (p as Rec).status))
  kernel.onQuery('account.positions', (p) => { failWith(set.fail.positions, 'INTERNAL'); return set.positions[String((p as Rec).accountId)] ?? [] })
  kernel.onQuery('account.orders', (p) => (set.orders[String((p as Rec).accountId)] ?? []).filter((o) => !(p as Rec).openOnly || ['open', 'untriggered', 'partially_filled'].includes(String(o.status))))
  kernel.onQuery('account.summary', (p) => ({ accountId: (p as Rec).accountId, ts: set.now, equity: '12480.20', available: '8000', positions: 1, openOrders: 1, dayStartEquity: '12351.80' }))
  kernel.onQuery('market.quote', (p) => ({ price: markOf(String((p as Rec).instrumentId)), ts: set.now, source: 'last' }))
  kernel.onQuery('market.candles', async (p) => {
    const { instrumentId, interval, limit } = p as { instrumentId: string; interval: string; limit?: number }
    if (interval !== '1d') {
      if (set.delayMs) await new Promise((r) => setTimeout(r, set.delayMs))
      failWith(set.fail.candles, 'INTERNAL')
      if (set.emptyCandles) return []
    }
    return candlesFor(instrumentId, interval ?? '15m', Number(limit ?? 500), set.now)
  })
  kernel.onQuery('instruments.search', (p) => {
    const text = String((p as Rec).q ?? '').toLowerCase()
    return { hits: ['BTC', 'ETH', 'SOL', 'DOGE', 'ARB', 'AVAX'].filter((s) => !text || s.toLowerCase().includes(text)).map((s) => ({ id: `hyperliquid:${s}`, name: `${s}-PERP`, venue: 'hyperliquid' })) }
  })
  kernel.onQuery('market.instruments', (p) => {
    if (set.noInstruments) return []
    const text = String((p as Rec | undefined)?.q ?? '').toLowerCase()
    return ['BTC', 'ETH', 'SOL'].filter((s) => !text || s.toLowerCase().includes(text)).map((s) => ({ instrumentId: `hyperliquid:${s}`, venue: 'hyperliquid', symbol: s, displaySymbol: `${s}-PERP`, base: s, quote: 'USDC', fees: { maker: '0.0001', taker: '0.0003', source: 'venue' } }))
  })
  kernel.onQuery('records.query', (p) => { failWith(set.fail.records, 'INTERNAL'); return recordsQuery({ fills: set.fills, orders: [], funding: [], ledger: [] }, (p ?? {}) as Rec) })

  /** 实盘账户的命令先要在场证明：缺证明回 ATTESTATION_REQUIRED（壳弹 PIN 并带证明重发），PIN 不对回 AUTH_FAILED。 */
  const attest = (accountId: unknown, ctx: { attestation?: unknown }): void => {
    const live = accounts.find((a) => a.accountId === accountId)?.mode === 'live'
    if (!live || !set.pinForLive) return
    const att = ctx.attestation as { method?: string; pin?: string } | undefined
    if (!att) throw problem('ATTESTATION_REQUIRED', 1010, 'this command needs a presence proof')
    log.pins += 1
    if (att.method !== 'pin' || att.pin !== TICKET_PIN) throw problem('AUTH_FAILED', 5003, 'PIN 不对')
  }
  const order = (intent: Rec, status: string): Rec => ({
    orderId: `ord_new_${++seq}`, clientOrderId: `c${seq}`, accountId: intent.accountId, instrumentId: intent.instrumentId, side: intent.side, type: intent.type, tif: 'gtc',
    size: intent.size, filledSize: '0', ...(intent.price ? { price: intent.price } : {}), ...(intent.triggerPrice ? { triggerPrice: intent.triggerPrice } : {}),
    reduceOnly: intent.reduceOnly === true, status, fee: '0', origin: O.human, createdAt: set.now + seq, updatedAt: set.now + seq,
  })
  kernel.onCommand('order.place', (p, ctx) => {
    const intent = ((p ?? {}) as Rec).intent as Rec
    attest(intent.accountId, ctx)
    log.placed.push(intent)
    if (set.reject) {
      const pr = { code: 3001, name: 'RULE_DENIED', category: 'RISK', message: set.reject, retryable: false }
      return { order: { ...order(intent, 'denied'), problem: pr }, problem: pr }
    }
    const o = order(intent, intent.type === 'stop_market' ? 'untriggered' : 'open')
    const a = String(intent.accountId)
    set.orders[a] = [...(set.orders[a] ?? []), o]
    kernel.publish('account.orders', o)
    return { order: o }
  })
  kernel.onCommand('order.cancel', (p, ctx) => {
    const { accountId, orderId } = (p ?? {}) as { accountId: string; orderId: string }
    attest(accountId, ctx)
    log.cancelled.push({ accountId, orderId })
    if (set.reject) return { ok: false, problem: { code: 3001, name: 'VENUE_REJECTED', category: 'VENUE', message: set.reject, retryable: false } }
    set.orders[accountId] = (set.orders[accountId] ?? []).filter((o) => o.orderId !== orderId)
    kernel.publish('account.orders', { orderId, accountId, status: 'cancelled' })
    return { ok: true }
  })
  kernel.onCommand('position.close', (p, ctx) => {
    const { accountId, instrumentId } = (p ?? {}) as { accountId: string; instrumentId: string }
    attest(accountId, ctx)
    log.closed.push((p ?? {}) as Rec)
    const pos = (set.positions[accountId] ?? []).find((x) => x.instrumentId === instrumentId)
    if (!pos) throw problem('INVALID_PARAMS', -32602, `no open position in ${instrumentId}`)
    if (set.reject) return { order: { ...order({ accountId, instrumentId, side: 'sell', type: 'market', size: pos.size }, 'cancelled'), problem: { code: 3001, name: 'VENUE_REJECTED', category: 'VENUE', message: set.reject, retryable: false } } }
    set.positions[accountId] = (set.positions[accountId] ?? []).filter((x) => x !== pos)
    kernel.publish('account.positions', { accountId, instrumentId, position: null })
    return { order: { ...order({ accountId, instrumentId, side: pos.side === 'long' ? 'sell' : 'buy', type: 'market', size: pos.size, reduceOnly: true }, 'filled'), filledSize: pos.size } }
  })
  return log
}

const base = (): Rec => ({ 'account.list': accounts, 'agentkey.list': agentKeys, 'proposal.list': designSet().proposals })
export const chartFixtures = {
  normal: { queries: base() },
  empty: { queries: base() },
  loading: { queries: base() },
  error: { queries: base() },
  offline: { queries: base() },
  unwired: { queries: base() },
}
