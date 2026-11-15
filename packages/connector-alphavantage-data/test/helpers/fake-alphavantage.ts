// SPDX-License-Identifier: CPAL-1.0
// 离线假 Alpha Vantage：进程内按 GET /query 的 function 参数回答，不开端口、不联网、不读夹具文件。
// 夹具为手写（本机离线，未取真网响应）：字段名与形状照 Alpha Vantage 官方 API 文档
// （https://www.alphavantage.co/documentation/ ），数值是占位。
// 注意：这里的时间戳是**美东挂钟字符串**（官方响应的真实形态），由本文件的常量手写，
// 不调用客户端的时间换算函数 —— 换算对不对由测试里的独立手算期望值判定。
export const HOST = 'alphavantage.example.test'
export const QUERY_PATH = '/query'
export const API_KEY = 'FAKEALPHAVANTAGEKEY'

/** 固定「现在」：2026-10-21 14:00:00Z = 美东 10:00（EDT，周三）。 */
export const FX_NOW = Date.parse('2026-10-21T14:00:00Z')

/** Meta Data 逐字段照官方响应（5. Time Zone 说明时间戳按美东解释）。 */
export const META = {
  '1. Information': 'Intraday (5min) open, high, low, close prices and volume',
  '2. Symbol': 'AAPL',
  '3. Last Refreshed': '2026-10-21 09:40:00',
  '4. Interval': '5min',
  '5. Output Size': 'Compact',
  '6. Time Zone': 'US/Eastern',
}

/** 一行的官方编号字段（字符串，官方全是字符串）。 */
export function seriesRow(price = 202): Record<string, string> {
  return {
    '1. open': price.toFixed(4),
    '2. high': (price + 1.5).toFixed(4),
    '3. low': (price - 1.5).toFixed(4),
    '4. close': (price + 0.5).toFixed(4),
    '5. volume': '12345',
  }
}

/** 盘中 5min：美东 09:35 起每 5 分钟一根，共 count 根；给了 month（YYYY-MM）就落在该月 10 日。 */
export function intradaySeries(count = 2, month?: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const day = month === undefined ? '2026-10-21' : `${month}-10`
  for (let i = 0; i < count; i++) {
    const minute = 35 + i * 5
    out[`${day} 09:${String(minute).padStart(2, '0')}:00`] = seriesRow(202 + i)
  }
  return out
}

/** 日线：美东日期键（官方 TIME_SERIES_DAILY 的形状）。 */
export function dailySeries(): Record<string, unknown> {
  return {
    '2026-10-20': seriesRow(202),
    '2026-10-19': seriesRow(200),
  }
}

export const WEEKLY_SERIES: Record<string, unknown> = { '2026-10-16': seriesRow(198) }
export const MONTHLY_SERIES: Record<string, unknown> = { '2026-09-30': seriesRow(196) }

export const GLOBAL_QUOTE = {
  'Global Quote': {
    '01. symbol': 'AAPL',
    '02. open': '201.0000',
    '03. high': '203.0000',
    '04. low': '200.5000',
    '05. price': '202.5200',
    '06. volume': '5000000',
    '07. latest trading day': '2026-10-20',
    '08. previous close': '201.0500',
    '09. change': '1.4700',
    '10. change percent': '0.7312%',
  },
}

/** LISTING_STATUS：官方 CSV 表头 + 含逗号与引号的公司名，用来验 CSV 解析。 */
export const LISTING_CSV = [
  'symbol,name,exchange,assetType,ipoDate,delistingDate,status',
  'AAPL,"Apple Inc",NASDAQ,Stock,1980-12-12,,Active',
  'MSFT,"Microsoft Corporation",NASDAQ,Stock,1986-03-13,,Active',
  'BRK.B,"Berkshire Hathaway Inc. Class B",NYSE,Stock,1996-05-09,,Active',
  'ACME,"Acme, Inc. ""Class A""",NYSE,Stock,2001-06-01,,Active',
  'SPY,"SPDR S&P 500 ETF Trust",NYSE ARCA,ETF,1993-01-22,,Active',
  'OLD,"Old Delisted Co",NYSE,Stock,2000-01-03,2024-02-01,Delisted',
].join('\n')

export interface RawCall {
  function: string
  symbol: string
  params: URLSearchParams
  url: string
}

export class FakeAlphaVantage {
  calls: RawCall[] = []
  /** 强制响应：function 名 → 返回对象（包成 200 JSON）、字符串（200 text/csv）或 Response 原样返回。 */
  override = new Map<string, (params: URLSearchParams) => unknown>()

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    const params = url.searchParams
    this.calls.push({
      function: params.get('function') ?? '',
      symbol: params.get('symbol') ?? '',
      params,
      url: url.toString(),
    })
    if (url.hostname !== HOST) return new Response(`unknown host ${url.hostname}`, { status: 404 })
    if (url.pathname !== QUERY_PATH) return new Response(`unhandled ${url.pathname}`, { status: 404 })
    void init
    const fn = params.get('function') ?? ''
    const forced = this.override.get(fn)
    if (forced) {
      const out = forced(params)
      if (out instanceof Response) return out
      // 字符串按 text/csv 原样回（LISTING_STATUS 的真实形态），其余包成 200 JSON
      if (typeof out === 'string') return new Response(out, { status: 200, headers: { 'content-type': 'text/csv' } })
      return respond(out)
    }
    switch (fn) {
      case 'TIME_SERIES_INTRADAY': {
        const interval = params.get('interval') ?? '5min'
        const month = params.get('month')
        return respond({
          'Meta Data': { ...META, '4. Interval': interval },
          [`Time Series (${interval})`]: intradaySeries(2, month === null ? undefined : month),
        })
      }
      case 'TIME_SERIES_DAILY':
        return respond({ 'Meta Data': META, 'Time Series (Daily)': dailySeries() })
      case 'TIME_SERIES_WEEKLY':
        return respond({ 'Meta Data': META, 'Weekly Time Series': WEEKLY_SERIES })
      case 'TIME_SERIES_MONTHLY':
        return respond({ 'Meta Data': META, 'Monthly Time Series': MONTHLY_SERIES })
      case 'GLOBAL_QUOTE':
        return respond(GLOBAL_QUOTE)
      case 'LISTING_STATUS':
        return new Response(LISTING_CSV, { status: 200, headers: { 'content-type': 'text/csv' } })
      default:
        return respond({ 'Error Message': `Invalid API call. Please retry or visit the documentation for ${fn}` })
    }
  }

  callsOf(fn: string): RawCall[] {
    return this.calls.filter((c) => c.function === fn)
  }
}

/** 对象 → 200 JSON。 */
export function respond(body: unknown): Response {
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
