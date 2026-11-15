// SPDX-License-Identifier: CPAL-1.0
// 离线假 Kraken Futures 公共 REST：进程内按路径回答，不开端口、不联网、不读夹具文件。
// 夹具取自真网公共响应（2026-10-20），字段原样截短；时间戳归一到 FX_NOW 以便断言。
export const FX_NOW = 1_792_510_082_175
export const FX_NOW_ISO = '2026-10-20T15:28:02.175Z'
export const STEP_MS = 60_000

/** 一条永续合约（真实字段，截掉 marginLevels / isin / platformsPermitted 等本连接器不读的键）。 */
export function perpEntry(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    symbol: 'PF_XBTUSD',
    type: 'flexible_futures',
    tickSize: 1,
    contractSize: 1,
    tradeable: true,
    contractValueTradePrecision: 4,
    fundingRateCoefficient: 8,
    maxRelativeFundingRate: 0.005,
    suspended: false,
    isExpired: false,
    base: 'BTC',
    quote: 'USD',
    pair: 'BTC:USD',
    ...over,
  }
}

/** 真实合约清单的子集：4 条 PF_ + 2 条非永续 + 1 条不可交易 + 1 条停牌。 */
export const REAL_INSTRUMENTS: unknown[] = [
  perpEntry(),
  perpEntry({ symbol: 'PF_ETHUSD', tickSize: 0.1, contractValueTradePrecision: 3, base: 'ETH', pair: 'ETH:USD' }),
  perpEntry({ symbol: 'PF_SOLUSD', tickSize: 0.01, contractValueTradePrecision: 2, base: 'SOL', pair: 'SOL:USD' }),
  perpEntry({ symbol: 'PF_SUSP', tickSize: 0.1, base: 'SUSP', pair: 'SUSP:USD', suspended: true }),
  perpEntry({ symbol: 'PF_DELISTED', tradeable: false, base: 'GONE', pair: 'GONE:USD', isExpired: true }),
  perpEntry({ symbol: 'FF_SOLUSD_261225', type: 'futures_inverse', contractValueTradePrecision: 1, base: 'SOL', pair: 'SOL:USD' }),
  perpEntry({ symbol: 'PI_XBTUSD', type: 'futures_inverse', contractValueTradePrecision: 0, base: 'BTC', pair: 'BTC:USD' }),
]

/** 两条永续 ticker（真实字段）。 */
export const REAL_TICKERS: unknown[] = [
  {
    symbol: 'PF_XBTUSD',
    last: 82350,
    lastTime: FX_NOW_ISO,
    tag: 'perpetual',
    pair: 'XBT:USD',
    markPrice: 82369.55914941261,
    bid: 82347,
    bidSize: 0.0001,
    ask: 82348,
    askSize: 0.2424,
    vol24h: 4491.2329,
    volumeQuote: 368628738.836,
    openInterest: 2318.1385,
    fundingRate: 0.9490556512570277,
    fundingRatePrediction: 1.5048461014731809,
    relativeFundingRate: 1.1410816666667e-5,
    suspended: false,
    indexPrice: 82363.54,
  },
  {
    symbol: 'PF_ETHUSD',
    last: 2800.9,
    lastTime: FX_NOW_ISO,
    tag: 'perpetual',
    pair: 'ETH:USD',
    markPrice: 2801.2,
    bid: 2800.1,
    ask: 2801.5,
    bidSize: 12.5,
    askSize: 9.75,
    openInterest: 51234.5,
    fundingRate: 0.7087,
    indexPrice: 2800.05,
    suspended: false,
  },
]

/** 真实盘口截短：上游 bids 升序（最低价在前、含远端薄档），asks 升序。 */
export const REAL_ORDER_BOOK: unknown = {
  bids: [
    [1, 142],
    [5, 2.12],
    [13, 1.5384],
    [75, 26.1849],
    [8455, 0.002],
    [82344, 0.0001],
    [82346, 0.0003],
    [82347, 0.0001],
  ],
  asks: [
    [82348, 0.2666],
    [82349, 0.023],
    [82350, 0.056],
    [264324, 0.0002],
    [314324, 0.0002],
    [364324, 0.0002],
  ],
}

/** 真实 1h K 线前 4 根（charts 端点：time 毫秒、OHLCV 字符串、升序）。 */
export const REAL_CANDLES: unknown[] = [
  { time: 1785312000000, open: '64482', high: '64508', low: '64203', close: '64350', volume: '129.9969' },
  { time: 1785315600000, open: '64350', high: '64672', low: '64310', close: '64622', volume: '280.0446000000003' },
  { time: 1785319200000, open: '64622', high: '64647', low: '64336', close: '64401', volume: '97.9898' },
  { time: 1785322800000, open: '64401', high: '64528', low: '64339', close: '64439', volume: '100.2433' },
]

/** 生成一张规则 K 线（价格随序号抬升，便于断言首尾）。 */
export function candleRow(t: number, price = 100): Record<string, unknown> {
  return {
    time: t,
    open: String(price),
    high: String(price + 1),
    low: String(price - 1),
    close: String(price + 0.5),
    volume: '10',
  }
}

export function candleRows(from: number, count: number, step = STEP_MS): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  for (let i = 0; i < count; i++) out.push(candleRow(from + i * step, 100 + i))
  return out
}

export interface RawCall { path: string; url: string; params: URLSearchParams }
export interface ChartCtx { symbol: string; resolution: string; params: URLSearchParams }
export interface ChartBody { candles: unknown[]; more_candles: boolean }

const CHARTS_PREFIX = '/api/charts/v1/trade/'

export class FakeKraken {
  calls: RawCall[] = []
  instruments: unknown[] = REAL_INSTRUMENTS
  tickers: unknown[] | ((params: URLSearchParams) => unknown) = REAL_TICKERS
  orderBook: unknown = REAL_ORDER_BOOK
  /** charts 响应：数组按 { candles, more_candles: false } 包，函数可自定义分页标志。 */
  chart: unknown[] | ((ctx: ChartCtx) => ChartBody) = REAL_CANDLES
  /** pathname → 强制响应（Response 原样返回，其它对象按成功信封包成 200）。 */
  override = new Map<string, (params: URLSearchParams) => unknown>()

  readonly fetch: typeof fetch = async (input) => {
    const url = new URL(String(input))
    const path = url.pathname
    this.calls.push({ path, url: url.toString(), params: url.searchParams })
    const forced = this.override.get(path)
    if (forced) {
      const out = forced(url.searchParams)
      return out instanceof Response ? out : success(out as Record<string, unknown>)
    }
    if (path === '/derivatives/api/v3/instruments') return success({ instruments: this.instruments })
    if (path === '/derivatives/api/v3/tickers') {
      const rows = typeof this.tickers === 'function' ? this.tickers(url.searchParams) : this.tickers
      return success({ tickers: rows })
    }
    if (path === '/derivatives/api/v3/orderbook') return success({ orderBook: this.orderBook })
    if (path.startsWith(CHARTS_PREFIX)) {
      const rest = path.slice(CHARTS_PREFIX.length).split('/')
      const symbol = decodeURIComponent(rest[0] ?? '')
      const resolution = decodeURIComponent(rest[1] ?? '')
      const out = typeof this.chart === 'function' ? this.chart({ symbol, resolution, params: url.searchParams }) : this.chart
      return Array.isArray(out) ? json({ candles: out, more_candles: false }) : json(out)
    }
    return new Response(`unhandled ${path}`, { status: 404 })
  }

  callsTo(path: string): RawCall[] {
    return this.calls.filter((c) => c.path === path)
  }

  /** 所有 charts 调用（路径里带 symbol / resolution，按前缀取）。 */
  chartCalls(): RawCall[] {
    return this.calls.filter((c) => c.path.startsWith(CHARTS_PREFIX))
  }

  /** 最后一次 charts 调用的 symbol / resolution / 参数。 */
  lastChart(): { symbol: string; resolution: string; params: URLSearchParams } | undefined {
    const call = this.chartCalls().at(-1)
    if (!call) return undefined
    const rest = call.path.slice(CHARTS_PREFIX.length).split('/')
    return { symbol: decodeURIComponent(rest[0] ?? ''), resolution: decodeURIComponent(rest[1] ?? ''), params: call.params }
  }
}

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

/** Kraken 成功信封（derivatives 端点用）。 */
export const success = (extras: Record<string, unknown>): Response =>
  json({ result: 'success', serverTime: FX_NOW_ISO, ...extras })

/** 轮询等待（真实定时器，离线；不依赖 vitest 假时钟）。 */
export async function waitFor(check: () => boolean, timeoutMs = 1500): Promise<void> {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timeout')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
