// SPDX-License-Identifier: CPAL-1.0
// 资金页夹具：与视觉稿 reports/visual-r5/funds 同一组数字（实盘 10,480.20 + 2,000.00 = 12,480.20；今日 +128.40；纸面 9,987.50 / −12.50）。
// 全是自造的演示数据，不含真实地址、密钥、行情。
//   fundsFixtures[state].queries  与别的页面一样，舞台按「常量」注册（只含与账户、记录种类无关的查询）；
//   fundsHandlers(state)          按参数应答的完整处理器（每个账户各答各的）。舞台目前不认它，浏览器用例用 installFundsHandlers 装到夹具内核上。

export const FUND_ACCOUNT = { hl: 'acct_fund_hl', bn: 'acct_fund_bn', paper: 'acct_fund_paper' } as const
export type FundsState = 'normal' | 'empty' | 'loading' | 'error' | 'offline' | 'unwired' | 'unreachable'

type Rec = Record<string, unknown>
type Handler = (params: unknown) => unknown | Promise<unknown>
const HALF_HOUR = 1_800_000
const HOUR = 3_600_000
export const PROBLEM_TEXT = 'The local fixture cannot provide this view.'

const problem = (name: string, code: number, message: string): Error => Object.assign(new Error(message), { code, data: { code, name, message, category: 'PROTOCOL', retryable: false } })

// 视觉稿的 7 天权益锚点：[距起点小时, 权益, 该段有持仓波动]；起点 = 终点 − 165.5 h；采样缺口 = 起点后 72 h – 78.5 h
const ANCHORS: Array<[number, number, number]> = [
  [0, 10439.94, 0], [33.5, 10439.94, 1], [42, 10471.6, 1], [51, 10420.4, 1], [64.5, 10524.21, 0], [83, 10524.21, 1], [92, 10551.0, 1], [99, 10455.0, 1],
  [104.5, 10425.36, 0], [133.5, 10425.36, 1], [140, 10392.0, 1], [144, 10351.8, 1], [150, 10372.0, 1], [157, 10318.5, 1], [161, 10340.0, 1], [163.5, 10352.0, 1],
  [165, 10468.0, 1], [165.5, 10480.2, 1],
]
const SPAN_H = 165.5
const GAP_H: [number, number] = [72, 78.5]

export function equityHistory(now: number): { points: Array<{ t: number; equity: string; available: string }>; gaps: Array<{ from: number; to: number }> } {
  const end = Math.floor(now / HALF_HOUR) * HALF_HOUR
  const start = end - SPAN_H * HOUR
  const gap = { from: start + GAP_H[0] * HOUR, to: start + GAP_H[1] * HOUR }
  const points: Array<{ t: number; equity: string; available: string }> = []
  let seed = 7919 * 7
  let walk = 0
  const rnd = (): number => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 }
  for (let t = start; t <= end; t += HALF_HOUR) {
    const h = (t - start) / HOUR
    if (t >= gap.from && t < gap.to) continue
    let i = 1
    while (i < ANCHORS.length && ANCHORS[i]![0] < h) i += 1
    const p = ANCHORS[Math.max(0, i - 1)]!
    const q = ANCHORS[Math.min(i, ANCHORS.length - 1)]!
    const f = q[0] === p[0] ? 0 : (h - p[0]) / (q[0] - p[0])
    walk = walk * 0.8 + (rnd() - 0.5) * 22
    const v = p[1] + (q[1] - p[1]) * f + (p[2] ? walk * Math.sin(Math.PI * f) : 0)
    points.push({ t, equity: (Math.round(v * 100) / 100).toFixed(2), available: '5792.76' })
  }
  return { points, gaps: [gap] }
}

const accountList = [
  { accountId: FUND_ACCOUNT.hl, alias: 'hl-main', venue: 'hyperliquid', environment: 'testnet', mode: 'live' },
  { accountId: FUND_ACCOUNT.bn, alias: 'bn-1', venue: 'binance', environment: 'testnet', mode: 'live' },
  { accountId: FUND_ACCOUNT.paper, alias: 'paper-1', venue: 'kernel-sim', environment: 'testnet', mode: 'paper', paper: { initialBalance: '10000', ccy: 'USDC' } },
]
const summaryOf = (accountId: string, equity: string, available: string, dayStartEquity: string, ts: number): Rec => ({ accountId, equity, available, dayStartEquity, ts })
const bal = (accountId: string, total: string, available: string, hold: string, ts: number): Rec => ({ accountId, asset: 'USDC', total, available, hold, ts })
const margin = (accountId: string, equity: string, initialMargin: string, maintenanceMargin: string, available: string, marginRatio: string, leverage: number, ts: number): Rec =>
  ({ accountId, model: 'cross', valuationCcy: 'USDC', equity, initialMargin, maintenanceMargin, available, marginRatio, leverage, ts })

function snapshot(now: number) {
  const summaries: Record<string, Rec> = {
    [FUND_ACCOUNT.hl]: summaryOf(FUND_ACCOUNT.hl, '10480.20', '5792.76', '10351.80', now),
    [FUND_ACCOUNT.bn]: summaryOf(FUND_ACCOUNT.bn, '2000.00', '2000.00', '2000.00', now),
    [FUND_ACCOUNT.paper]: summaryOf(FUND_ACCOUNT.paper, '9987.50', '8367.20', '10000.00', now),
  }
  const assets: Record<string, Rec> = {
    [FUND_ACCOUNT.hl]: { accountId: FUND_ACCOUNT.hl, balances: [bal(FUND_ACCOUNT.hl, '10480.20', '5792.76', '4687.44', now)], margin: margin(FUND_ACCOUNT.hl, '10480.20', '4687.44', '252.33', '5792.76', '0.0241', 1.28, now), ts: now },
    [FUND_ACCOUNT.bn]: { accountId: FUND_ACCOUNT.bn, balances: [bal(FUND_ACCOUNT.bn, '2000.00', '2000.00', '0.00', now)], margin: margin(FUND_ACCOUNT.bn, '2000.00', '0.00', '0.00', '2000.00', '0', 0, now), ts: now },
    [FUND_ACCOUNT.paper]: { accountId: FUND_ACCOUNT.paper, balances: [bal(FUND_ACCOUNT.paper, '9987.50', '8367.20', '1620.30', now)], margin: margin(FUND_ACCOUNT.paper, '9987.50', '1620.30', '61.20', '8367.20', '0.0061', 0.16, now), ts: now },
  }
  const pos = (accountId: string, instrumentId: string, side: string, size: string, upnl: string): Rec => ({ accountId, instrumentId, side, size, entryPrice: '100', markPrice: '101', notional: '1000', unrealizedPnl: upnl, realizedPnl: '0', leverage: 2, marginMode: 'cross', liquidationPrice: null, updatedAt: now })
  const positions: Record<string, Rec[]> = {
    [FUND_ACCOUNT.hl]: [pos(FUND_ACCOUNT.hl, 'hyperliquid:BTC', 'long', '0.08', '14.50'), pos(FUND_ACCOUNT.hl, 'hyperliquid:ETH', 'short', '1.2', '9.40'), pos(FUND_ACCOUNT.hl, 'hyperliquid:SOL', 'long', '5', '3.86')],
    [FUND_ACCOUNT.bn]: [],
    [FUND_ACCOUNT.paper]: [pos(FUND_ACCOUNT.paper, 'hyperliquid:SOL', 'long', '30', '-12.50')],
  }
  const orders: Record<string, Rec[]> = { [FUND_ACCOUNT.hl]: [], [FUND_ACCOUNT.bn]: [], [FUND_ACCOUNT.paper]: [] }
  const realized = ['0', '0', '8.20', '0', '5.60', '0', '0', '11.40', '0', '7.70']
  const fills = realized.map((r, i) => ({ fillId: `fill_fund_${i}`, accountId: FUND_ACCOUNT.hl, instrumentId: 'hyperliquid:BTC', side: i % 2 ? 'sell' : 'buy', price: '66200', size: '0.05', fee: '1.655', feeCcy: 'USDC', liquidity: 'taker', realizedPnl: r, ts: now - (i + 1) * 5 * HOUR }))
  const funding = [['BTC', '-1.77'], ['ETH', '0.35'], ['SOL', '-2.43']].map(([s, a], i) => ({ type: 'funding', ts: now - (i + 1) * 9 * HOUR, subject: { accountId: FUND_ACCOUNT.hl, instrumentId: `hyperliquid:${s}` }, payload: { amount: a, asset: 'USDC' } }))
  const venues = [
    { venue: 'hyperliquid', environment: 'testnet', ts: now, wsState: 'connected', latencyMs: { p50: 42, p95: 80 } },
    { venue: 'binance', environment: 'testnet', ts: now, wsState: 'connected', unverified: true },
    { venue: 'kernel-sim', environment: 'testnet', ts: now, wsState: 'connected' },
  ]
  return { summaries, assets, positions, orders, fills, funding, venues }
}

/** portfolio.analysis（GQ-65）：实盘两场所、三条策略（含未归属）、七个标的（前 5 + 其余 2）；纸面一场所。金额与份额都是十进制字符串。 */
export const PORTFOLIO = {
  live: {
    scope: 'live', scopes: ['live', 'paper'], valuationCcy: 'USDC', accounts: 2, gross: '40000.00',
    byVenue: [{ key: 'hyperliquid', exposure: '30000.00', weight: '0.75' }, { key: 'binance', exposure: '10000.00', weight: '0.25' }],
    byStrategy: [
      { key: 'unassigned', realized: '-20.00', unrealized: '7.90', funding: '0', total: '-12.10' },
      { key: 'ema-trend', realized: '96.40', unrealized: '32.00', funding: '0', total: '128.40' },
      { key: 'funding-carry', realized: '-8.25', unrealized: '0', funding: '3.10', total: '-5.15' },
    ],
    byInstrument: [
      { key: 'hyperliquid:BTC', exposure: '20000.00', weight: '0.5' }, { key: 'hyperliquid:ETH', exposure: '8000.00', weight: '0.2' },
      { key: 'binance:SOLUSDT', exposure: '4000.00', weight: '0.1' }, { key: 'binance:BNBUSDT', exposure: '3200.00', weight: '0.08' },
      { key: 'hyperliquid:HYPE', exposure: '2000.00', weight: '0.05' }, { key: 'binance:DOGEUSDT', exposure: '1600.00', weight: '0.04' },
      { key: 'binance:XRPUSDT', exposure: '1200.00', weight: '0.03' },
    ],
    missing: [],
  },
  paper: {
    scope: 'paper', scopes: ['live', 'paper'], valuationCcy: 'USDC', accounts: 1, gross: '1500.00',
    byVenue: [{ key: 'kernel-sim', exposure: '1500.00', weight: '1' }],
    byStrategy: [{ key: 'unassigned', realized: '0', unrealized: '4.20', funding: '0', total: '4.20' }],
    byInstrument: [{ key: 'hyperliquid:BTC', exposure: '1500.00', weight: '1' }],
    missing: [],
  },
  unavailable: { unavailable: true, details: ['missing_fx: EUR->USDC', 'unknown_instrument: hyperliquid:NOPE'] },
  empty: { scope: 'live', scopes: ['live'], valuationCcy: 'USD', accounts: 0, gross: '0', byVenue: [], byStrategy: [], byInstrument: [], missing: [] },
} as const

const accountOf = (p: unknown): string => String((p as Rec | undefined)?.accountId ?? '')

/** 按参数应答的完整处理器。unwired 状态一个都不给（舞台上这些方法本来就不存在，内核回 -32601）。 */
export function fundsHandlers(state: FundsState, now = Date.now()): Record<string, Handler> {
  if (state === 'unwired') return {}
  const s = snapshot(now)
  const fail = (): never => { throw problem('DATA_UNAVAILABLE', -32000, PROBLEM_TEXT) }
  if (state === 'error') {
    return Object.fromEntries(['account.list', 'account.summary', 'account.assets', 'account.equity_history', 'account.positions', 'account.orders', 'records.query', 'venue.status', 'portfolio.analysis'].map((m) => [m, fail as Handler]))
  }
  if (state === 'empty') {
    return {
      'account.list': () => [], 'venue.status': () => [], 'account.summary': () => null, 'account.positions': () => [], 'account.orders': () => [],
      'account.assets': (p) => ({ accountId: accountOf(p), balances: [], margin: null, ts: now }),
      'account.equity_history': () => ({ points: [], gaps: [] }),
      'records.query': () => ({ items: [] }),
      'portfolio.analysis': () => PORTFOLIO.empty,
    }
  }
  const unreachable = state === 'unreachable'
  const venues = unreachable ? s.venues.map((v) => (v.venue === 'binance' ? { ...v, wsState: 'disconnected' } : v)) : s.venues
  const guard = (id: string): void => { if (unreachable && id === FUND_ACCOUNT.bn) throw problem('VENUE_UNAVAILABLE', -32000, 'Venue binance is unavailable.') }
  return {
    'account.list': () => accountList,
    'venue.status': () => venues,
    'account.summary': (p) => { guard(accountOf(p)); return s.summaries[accountOf(p)] ?? null },
    'account.assets': (p) => { guard(accountOf(p)); return s.assets[accountOf(p)] ?? { accountId: accountOf(p), balances: [], margin: null, ts: now } },
    'account.positions': (p) => s.positions[accountOf(p)] ?? [],
    'account.orders': (p) => s.orders[accountOf(p)] ?? [],
    'account.equity_history': () => equityHistory(now),
    'portfolio.analysis': (p) => ((p as Rec | undefined)?.scope === 'paper' ? PORTFOLIO.paper : PORTFOLIO.live),
    'records.query': (p) => {
      const kind = (p as Rec | undefined)?.kind
      return { items: accountOf(p) === FUND_ACCOUNT.hl ? (kind === 'funding' ? s.funding : kind === 'fill' ? s.fills : []) : [] }
    },
  }
}

// 舞台按常量注册：只放与账户、记录种类无关的查询（权益曲线、资产与保证金按默认账户 hl-main 应答）
function constants(state: FundsState): Record<string, unknown> {
  const h = fundsHandlers(state)
  const out: Record<string, unknown> = {}
  for (const m of ['account.list', 'venue.status', 'portfolio.analysis']) if (h[m]) out[m] = (h[m] as Handler)({})
  for (const m of ['account.assets', 'account.equity_history']) if (h[m]) out[m] = (h[m] as Handler)({ accountId: FUND_ACCOUNT.hl })
  return out
}

export const fundsFixtures = {
  normal: { view: 'accounts', queries: constants('normal') },
  empty: { view: 'accounts', queries: constants('empty') },
  loading: { view: 'accounts', queries: constants('normal') },
  // 错误：内核把读取失败当成功返回时的形状（{ok:false, error}），其余两项由舞台的 ok-false 场景给
  error: { view: 'accounts', queries: { 'account.list': { ok: false, error: { code: -32000, message: PROBLEM_TEXT } } } },
  offline: { view: 'accounts', queries: constants('normal') },
  unwired: { view: 'accounts' },
}

/** 把完整处理器装到夹具内核上（舞台注册之后调用，同名后注册者胜）。delayMs 看加载态；onQuery 记录每次查询的方法与参数。 */
export function installFundsHandlers(kernel: { onQuery(method: string, fn: Handler): void }, state: FundsState, opts: { delayMs?: number; now?: number; onQuery?: (method: string, params: unknown) => void } = {}): void {
  for (const [method, fn] of Object.entries(fundsHandlers(state, opts.now))) {
    kernel.onQuery(method, async (p) => {
      opts.onQuery?.(method, p)
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs))
      return fn(p)
    })
  }
}
