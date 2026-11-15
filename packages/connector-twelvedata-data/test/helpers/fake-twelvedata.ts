// SPDX-License-Identifier: CPAL-1.0
// 离线假 Twelve Data 公共 REST：进程内按路径回答，不开端口、不联网、不读夹具文件。
// 响应形状照官方字段表手写（/stocks、/time_series、/quote、/market_state，错误用 {code,message,status:"error"}），
// 不 import 客户端代码（假服务器独立于 src）。
export const FX_NOW = 1_791_483_435_000
export const STEP_MS = 60_000
/** 测试用的假密钥：只在本目录出现，不代表任何真实凭据。 */
export const TEST_KEY = 'test-twelvedata-key'

/** 官方 interval → 毫秒（假服务器按它造 K 线）。 */
export const INTERVAL_STEP_MS: Record<string, number> = {
  '1min': 60_000,
  '5min': 300_000,
  '15min': 900_000,
  '30min': 1_800_000,
  '1h': 3_600_000,
  '2h': 7_200_000,
  '4h': 14_400_000,
  '8h': 28_800_000,
  '1day': 86_400_000,
  '1week': 604_800_000,
  '1month': 2_592_000_000,
}

/** 官方 datetime 写法：`YYYY-MM-DD HH:mm:ss`（日线及以上只到日期）。 */
export function vendorDateTime(ms: number, dateOnly = false): string {
  const d = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
  return dateOnly ? date : `${date} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
}

/** 一条与官方 /stocks 同形的股票清单行。 */
export function stockRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { symbol: 'AAPL', name: 'Apple Inc.', currency: 'USD', exchange: 'NASDAQ', mic_code: 'XNGS', type: 'Common Stock', ...over }
}

/** 官方 /time_series 的 values 数组（缺省最新在前，与 order=desc 一致）。 */
export function timeSeriesValues(fromMs: number, count: number, stepMs = STEP_MS, dateOnly = false, price = 188): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  for (let i = 0; i < count; i++) {
    const t = fromMs + i * stepMs
    out.push({
      datetime: vendorDateTime(t, dateOnly),
      open: String(price + i),
      high: String(price + i + 1),
      low: String(price + i - 1),
      close: String(price + i + 0.5),
      volume: String(1000 + i),
    })
  }
  return out.reverse()
}

export interface RawCall {
  path: string
  url: string
  params: URLSearchParams
  headers: Record<string, string>
}

export class FakeTwelveData {
  calls: RawCall[] = []
  stocks: unknown = {
    data: [stockRow(), stockRow({ symbol: 'MSFT', name: 'Microsoft Corporation' })],
    status: 'ok',
  }
  /** /time_series：函数按请求参数生成；固定对象则原样返回。 */
  timeSeries: unknown | ((params: URLSearchParams) => unknown) = (params: URLSearchParams) => {
    const interval = params.get('interval') ?? '1min'
    const step = INTERVAL_STEP_MS[interval] ?? STEP_MS
    const dateOnly = interval === '1day' || interval === '1week' || interval === '1month'
    const order = params.get('order') ?? 'desc'
    const start = tdMs(params.get('start_date'))
    const end = tdMs(params.get('end_date'))
    if (Number.isFinite(start) && Number.isFinite(end)) {
      const count = Math.max(0, Math.floor((end - start) / step) + 1)
      const values = timeSeriesValues(start, count, step, dateOnly).reverse()
      return { meta: { symbol: params.get('symbol'), interval, timezone: 'UTC' }, values: order === 'asc' ? values : [...values].reverse(), status: 'ok' }
    }
    const n = Number(params.get('outputsize') ?? 30)
    const from = FX_NOW - (n - 1) * step
    return { meta: { symbol: params.get('symbol'), interval, timezone: 'UTC' }, values: timeSeriesValues(from, n, step, dateOnly), status: 'ok' }
  }
  quote: unknown = {
    symbol: 'AAPL', name: 'Apple Inc.', exchange: 'NASDAQ', mic_code: 'XNGS', currency: 'USD',
    datetime: vendorDateTime(FX_NOW), timestamp: FX_NOW / 1000,
    open: '187.10', high: '189.20', low: '186.50', close: '188.50', volume: '51234567',
    previous_close: '187.00', change: '1.5000', percent_change: '0.80214', average_volume: '48000000',
    is_market_open: true,
    fifty_two_week: { low: '164.08', high: '199.62', change: '24.42', change_percent: '14.84' },
  }
  marketState: unknown = [
    {
      name: 'NASDAQ', code: 'NASDAQ', country: 'United States',
      is_market_open: true, time_after_open: '01:23:45', time_to_open: '00:00:00', time_to_close: '04:36:15',
    },
    {
      name: 'NYSE', code: 'NYSE', country: 'United States',
      is_market_open: false, time_after_open: '00:00:00', time_to_open: '01:23:45', time_to_close: '00:00:00',
    },
  ]
  /** pathname → 强制响应（Response 原样返回，其它对象转 JSON 200）。 */
  override = new Map<string, (params: URLSearchParams) => unknown>()

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    const params = url.searchParams
    const headers = headerRecord(init?.headers)
    const path = url.pathname
    this.calls.push({ path, url: url.toString(), params, headers })
    const forced = this.override.get(path)
    if (forced) {
      const out = forced(params)
      return out instanceof Response ? out : json(out)
    }
    switch (path) {
      case '/stocks': return json(this.stocks)
      case '/time_series': {
        const rows = this.timeSeries
        return json(typeof rows === 'function' ? rows(params) : rows)
      }
      case '/quote': return json(this.quote)
      case '/market_state': return json(this.marketState)
      default: return new Response(`unhandled ${path}`, { status: 404 })
    }
  }

  callsTo(path: string): RawCall[] {
    return this.calls.filter((c) => c.path === path)
  }
}

/** 官方 `YYYY-MM-DD[ HH:mm:ss]` → 毫秒（按 UTC 解释）。 */
export function tdMs(v: string | null): number {
  if (v === null || v.trim() === '') return NaN
  const text = v.trim()
  return Date.parse(text.length === 10 ? `${text}T00:00:00Z` : `${text.replace(' ', 'T')}Z`)
}

/** 官方错误信封（HTTP 200 也能带它）。 */
export function errorJson(code: number, message: string, status = 200): Response {
  return json({ code, message, status: 'error' }, status)
}

function headerRecord(headers: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (headers === undefined || headers === null) return out
  if (Array.isArray(headers)) {
    for (const pair of headers as Array<[string, string]>) out[pair[0].toLowerCase()] = pair[1]
    return out
  }
  if (typeof (headers as { forEach?: unknown }).forEach === 'function') {
    ;(headers as { forEach: (cb: (v: string, k: string) => void) => void }).forEach((v, k) => { out[k.toLowerCase()] = v })
    return out
  }
  for (const [k, v] of Object.entries(headers as Record<string, string>)) out[k.toLowerCase()] = String(v)
  return out
}

export const json = (o: unknown, status = 200): Response =>
  new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } })

/** 轮询等待（真实定时器，离线；不依赖 vitest 假时钟）。 */
export async function waitFor(check: () => boolean, timeoutMs = 1500): Promise<void> {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timeout')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
