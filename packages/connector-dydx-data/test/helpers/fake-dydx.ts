// SPDX-License-Identifier: CPAL-1.0
// 离线假 dYdX v4 Indexer：进程内按路径回答公共 JSON，不开端口、不联网、不读夹具文件。
// 夹具取自真网 https://indexer.dydx.trade（2026-10-20 15:29 UTC 抓取），按字段截短到 3 档 / 4 根 / 1 笔。
export const FX_NOW = Date.parse('2026-10-20T15:29:00.000Z')
export const STEP_MS = 60_000

/** /v4/perpetualMarkets：markets 是以 ticker 为键的对象（截短到 4 个市场）。 */
export const MARKETS_FIXTURE = {
  markets: {
    'BTC-USD': {
      clobPairId: '0', ticker: 'BTC-USD', status: 'ACTIVE', oraclePrice: '82385.52', priceChange24H: '18.12',
      volume24H: '5334251.9020', trades24H: 1955, nextFundingRate: '0.00000027678571428571',
      initialMarginFraction: '0.02', maintenanceMarginFraction: '0.012', openInterest: '204.5404',
      atomicResolution: -10, quantumConversionExponent: -9, tickSize: '1', stepSize: '0.0001',
      stepBaseQuantums: 1_000_000, subticksPerTick: 100_000, marketType: 'CROSS',
    },
    'ETH-USD': {
      clobPairId: '1', ticker: 'ETH-USD', status: 'ACTIVE', oraclePrice: '2429.98', priceChange24H: '-3.41',
      volume24H: '1882940.5531', trades24H: 812, nextFundingRate: '-0.00000163362068965517',
      initialMarginFraction: '0.05', maintenanceMarginFraction: '0.03', openInterest: '6400.056',
      atomicResolution: -9, quantumConversionExponent: -9, tickSize: '0.1', stepSize: '0.001',
      stepBaseQuantums: 1_000_000, subticksPerTick: 1_000_000, marketType: 'CROSS',
    },
    'SOL-USD': {
      clobPairId: '2', ticker: 'SOL-USD', status: 'ACTIVE', oraclePrice: '105.14', priceChange24H: '1.02',
      volume24H: '702144.2019', trades24H: 2331, nextFundingRate: '0.00000050431034482759',
      initialMarginFraction: '0.1', maintenanceMarginFraction: '0.05', openInterest: '42454.5',
      atomicResolution: -7, quantumConversionExponent: -9, tickSize: '0.01', stepSize: '0.1',
      stepBaseQuantums: 10_000_000, subticksPerTick: 10_000_000, marketType: 'CROSS',
    },
    'OLD-USD': {
      clobPairId: '999', ticker: 'OLD-USD', status: 'FINAL_SETTLEMENT', oraclePrice: '0',
      nextFundingRate: '0', openInterest: '0', atomicResolution: -6, tickSize: '0.001', stepSize: '1',
      marketType: 'CROSS',
    },
  },
}

/** /v4/orderbooks/perpetualMarket/{ticker}：整本盘口，bids 降序 / asks 升序（各截 3 档）。 */
export const ORDERBOOK_FIXTURE = {
  bids: [
    { price: '82379', size: '0.0606' },
    { price: '82372', size: '0.183' },
    { price: '82360', size: '0.4214' },
  ],
  asks: [
    { price: '82400', size: '0.0606' },
    { price: '82419', size: '0.1213' },
    { price: '82428', size: '0.1213' },
  ],
}

/** /v4/trades/perpetualMarket/{ticker}?limit=1：最近一笔成交。 */
export const TRADES_FIXTURE = {
  trades: [
    {
      id: '0692d9ce0000000200000002', side: 'SELL', size: '0.1', price: '82350', type: 'LIMIT',
      createdAt: '2026-10-20T15:27:22.705Z', createdAtHeight: '110287310',
    },
  ],
}

/** K 线原始行：startedAt 是 ISO 字符串，OHLCV 全是字符串。 */
export function candleRow(startedAt: string, price: number, volume = '0'): Record<string, unknown> {
  return {
    startedAt,
    ticker: 'BTC-USD',
    resolution: '1MIN',
    low: String(price),
    high: String(price),
    open: String(price),
    close: String(price),
    baseTokenVolume: volume,
    usdVolume: '0',
    trades: 0,
    startingOpenInterest: '204.5404',
  }
}

/** 从 fromMs 起按 step 生成 count 根（升序），返回原始行。 */
export function candleRows(fromMs: number, count: number, step = STEP_MS, priceOf = (i: number) => 82350 + i): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  for (let i = 0; i < count; i++) out.push(candleRow(new Date(fromMs + i * step).toISOString(), priceOf(i)))
  return out
}

/** 真网 1MIN 四根（15:29 / 15:28 / 15:27 / 15:26 UTC，Indexer 倒序）。 */
export const CANDLES_FIXTURE = {
  candles: [
    candleRow('2026-10-20T15:29:00.000Z', 82350),
    candleRow('2026-10-20T15:28:00.000Z', 82350),
    candleRow('2026-10-20T15:27:00.000Z', 82350, '0.1'),
    candleRow('2026-10-20T15:26:00.000Z', 82346),
  ],
}

/**
 * 模拟 Indexer 的 fromISO / toISO 语义：fromISO 闭、toISO 开，按时间倒序取最近 limit 根。
 * asc 是升序原始行（candleRows 的输出）。
 */
export function pagedCandles(asc: Record<string, unknown>[]) {
  return (params: URLSearchParams): unknown => {
    const fromIso = params.get('fromISO')
    const toIso = params.get('toISO')
    const limit = Number(params.get('limit') ?? 1000)
    const from = fromIso === null ? Number.NEGATIVE_INFINITY : Date.parse(fromIso)
    const to = toIso === null ? Number.POSITIVE_INFINITY : Date.parse(toIso)
    const hit = asc.filter((row) => {
      const t = Date.parse(String(row['startedAt']))
      return t >= from && t < to
    })
    return { candles: hit.slice(-limit).reverse() }
  }
}

export interface RawCall { path: string; url: string; params: URLSearchParams }

export class FakeDydx {
  calls: RawCall[] = []
  markets: unknown = MARKETS_FIXTURE
  orderbook: unknown = ORDERBOOK_FIXTURE
  trades: unknown = TRADES_FIXTURE
  /** 无 from 的 K 线请求用它；需要分页行为时换成 pagedCandles(...)。 */
  candles: unknown | ((params: URLSearchParams) => unknown) = CANDLES_FIXTURE
  /** 按 pathname 种类（markets / orderbook / trades / candles）强制响应。 */
  override = new Map<string, (params: URLSearchParams) => unknown>()

  readonly fetch: typeof fetch = async (input) => {
    const url = new URL(String(input))
    const params = url.searchParams
    this.calls.push({ path: url.pathname, url: url.toString(), params })
    const kind = kindOf(url.pathname)
    const forced = this.override.get(kind)
    if (forced) {
      const out = forced(params)
      return out instanceof Response ? out : json(out)
    }
    switch (kind) {
      case 'markets': return json(this.markets)
      case 'orderbook': return json(this.orderbook)
      case 'trades': return json(this.trades)
      case 'candles': return json(typeof this.candles === 'function' ? this.candles(params) : this.candles)
      default: return new Response(`unhandled ${url.pathname}`, { status: 404 })
    }
  }

  callsTo(path: string): RawCall[] {
    return this.calls.filter((c) => c.path === path)
  }

  callsOfKind(kind: string): RawCall[] {
    return this.calls.filter((c) => kindOf(c.path) === kind)
  }
}

export function kindOf(pathname: string): string {
  if (pathname === '/v4/perpetualMarkets') return 'markets'
  if (pathname.startsWith('/v4/orderbooks/perpetualMarket/')) return 'orderbook'
  if (pathname.startsWith('/v4/trades/perpetualMarket/')) return 'trades'
  if (pathname.startsWith('/v4/candles/perpetualMarkets/')) return 'candles'
  return 'unknown'
}

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

/** Indexer 的错误体。 */
export const errorBody = (msg: string): Response =>
  new Response(JSON.stringify({ errors: [{ msg }] }), { status: 400, headers: { 'content-type': 'application/json' } })

/** 轮询等待（真实定时器，离线；不依赖 vitest 假时钟）。 */
export async function waitFor(check: () => boolean, timeoutMs = 1500): Promise<void> {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timeout')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
