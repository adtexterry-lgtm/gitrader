// SPDX-License-Identifier: CPAL-1.0
// 离线假 Polygon：进程内按路径回答（tickers / aggs / snapshot），不开端口、不联网、不读夹具文件。
// 夹具为手写（本机离线，未取真网响应）：字段名与形状照 Polygon 官方文档
// （https://polygon.io/docs/stocks/），数值是占位。快照的时间戳按官方给**纳秒**，由本文件的 nsOf() 手算，
// 不调用客户端的换算函数 —— 换算对不对由测试里的独立手算期望值判定。
export const HOST = 'polygon.example.test'
export const API_KEY = 'FAKEPOLYGONKEY'

/** 固定「现在」：2026-10-21 14:00:00Z（周三）。 */
export const FX_NOW = Date.parse('2026-10-21T14:00:00Z')

/** 官方快照时间戳是纳秒：这里按「毫秒 × 1e6」手算。 */
export const nsOf = (iso: string): number => Date.parse(iso) * 1e6

/** /v3/reference/tickers 的一条（over 覆盖单字段）。 */
export function tickerRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ticker: 'AAPL',
    name: 'Apple Inc.',
    market: 'stocks',
    locale: 'us',
    primary_exchange: 'XNAS',
    type: 'CS',
    active: true,
    currency_name: 'usd',
    cik: '0000320193',
    composite_figi: 'BBG000B9XRY4',
    last_updated_utc: '2026-10-20T00:00:00Z',
    ...over,
  }
}

export const PAGE_ONE: Record<string, unknown> = {
  results: [
    tickerRow(),
    tickerRow({ ticker: 'MSFT', name: 'Microsoft Corporation', primary_exchange: 'XNAS' }),
    tickerRow({ ticker: 'BRK.B', name: 'Berkshire Hathaway Inc. Class B', primary_exchange: 'XNYS', type: 'CS' }),
    tickerRow({ ticker: 'SPY', name: 'SPDR S&P 500 ETF Trust', primary_exchange: 'ARCX', type: 'ETF' }),
    tickerRow({ ticker: 'OLD', name: 'Old Delisted Co', primary_exchange: 'XNYS', active: false }),
    tickerRow({ ticker: 'BTCUSD', name: 'Bitcoin', market: 'crypto', locale: 'global' }),
  ],
  status: 'OK',
  request_id: 'req-1',
  count: 1000,
  next_url: `https://api.polygon.io/v3/reference/tickers?cursor=PAGE2`,
}

export const PAGE_TWO: Record<string, unknown> = {
  results: [tickerRow({ ticker: 'NVDA', name: 'NVIDIA Corporation', primary_exchange: 'XNAS' })],
  status: 'OK',
  request_id: 'req-2',
  count: 1,
}

/** 一根聚合 K 线（官方字段：o/h/l/c/v/vw/t/n，t 是毫秒）。 */
export function aggRow(tIso: string, price = 202): Record<string, unknown> {
  return {
    o: price,
    h: price + 1.5,
    l: price - 1.5,
    c: price + 0.5,
    v: 12_345,
    vw: price + 0.25,
    t: Date.parse(tIso),
    n: 42,
  }
}

/** 从 fromIso 起每 stepMs 一根，共 count 根（升序）。 */
export function aggSeries(fromIso: string, count: number, stepMs = 60_000, price = 202): Record<string, unknown>[] {
  const from = Date.parse(fromIso)
  const out: Record<string, unknown>[] = []
  for (let i = 0; i < count; i++) out.push(aggRow(new Date(from + i * stepMs).toISOString(), price + i))
  return out
}

export const SNAPSHOT: Record<string, unknown> = {
  status: 'OK',
  request_id: 'req-snap',
  ticker: {
    ticker: 'AAPL',
    updated: nsOf('2026-10-21T13:59:59Z'),
    day: { o: 201, h: 203, l: 200.5, c: 202.52, v: 5_000_000, vw: 201.8 },
    prevDay: { o: 199, h: 202, l: 198, c: 201.05, v: 4_800_000, vw: 200.1 },
    min: { o: 202.4, h: 202.6, l: 202.3, c: 202.52, v: 1_000, vw: 202.45 },
    lastTrade: { T: 'AAPL', p: 202.52, s: 100, x: 4, t: nsOf('2026-10-21T13:59:59Z') },
    lastQuote: { P: 202.55, S: 3, p: 202.5, s: 2, t: nsOf('2026-10-21T13:59:58Z') },
  },
}

export interface RawCall {
  path: string
  params: URLSearchParams
  url: string
  headers: Record<string, string>
}

export class FakePolygon {
  calls: RawCall[] = []
  /** 强制响应：'path 前缀' → 返回对象（200 JSON）或 Response 原样返回。 */
  override = new Map<string, (params: URLSearchParams) => unknown>()
  /** tickers 的第二页；置 null 表示只有一页。 */
  pageTwo: unknown = PAGE_TWO

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    const params = url.searchParams
    const headers: Record<string, string> = {}
    const raw = init?.headers
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [k, v] of Object.entries(raw as Record<string, string>)) headers[k.toLowerCase()] = v
    }
    this.calls.push({ path: url.pathname, params, url: url.toString(), headers })
    if (url.hostname !== HOST) return new Response(`unknown host ${url.hostname}`, { status: 404 })

    for (const [prefix, handler] of this.override) {
      if (url.pathname.startsWith(prefix)) {
        const out = handler(params)
        return out instanceof Response ? out : json(out)
      }
    }

    if (url.pathname === '/v3/reference/tickers') {
      const cursor = params.get('cursor')
      if (cursor === null) return json(PAGE_ONE)
      if (this.pageTwo === null) return json({ status: 'OK', request_id: 'req-1b', count: 0 })
      return json(this.pageTwo)
    }
    if (url.pathname.startsWith('/v2/aggs/ticker/')) {
      return json({ ticker: tickerOfAggPath(url.pathname), queryCount: 1, resultsCount: 3, adjusted: true, results: aggSeries('2026-10-21T13:30:00Z', 3), status: 'OK' })
    }
    if (url.pathname.startsWith('/v2/snapshot/locale/us/markets/stocks/tickers/')) {
      return json(this.snapshot === undefined ? SNAPSHOT : this.snapshot)
    }
    return new Response(`unhandled ${url.pathname}`, { status: 404 })
  }

  /** 置 undefined 时用默认快照；置 null 表示快照端点回空 ticker。 */
  snapshot: unknown = undefined

  callsTo(pathPrefix: string): RawCall[] {
    return this.calls.filter((c) => c.path.startsWith(pathPrefix))
  }
}

function tickerOfAggPath(path: string): string {
  const m = /^\/v2\/aggs\/ticker\/([^/]+)\//.exec(path)
  return m ? decodeURIComponent(m[1]!) : ''
}

export function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

/** 轮询等待（真实定时器，离线）。 */
export async function waitFor(check: () => boolean, timeoutMs = 1500): Promise<void> {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timeout')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
