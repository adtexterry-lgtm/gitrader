// SPDX-License-Identifier: CPAL-1.0
// 离线假 Finnhub 公共 REST：进程内按路径回答，不开端口、不联网、不读夹具文件。
// 响应形状照官方文档的字段表手写（/stock/symbol、/stock/candle、/quote、/stock/bidask、
// /stock/market-status、/stock/market-holiday），不 import 客户端代码（假服务器独立于 src）。
export const FX_NOW = 1_791_483_435_000
export const STEP_MS = 60_000
export const STEP_SEC = 60
/** 测试用的假密钥：只在本目录出现，不代表任何真实凭据。 */
export const TEST_KEY = 'test-finnhub-key'

/** 一条 /stock/symbol 行（官方字段：currency / description / displaySymbol / figi / isin / mic / symbol / type）。 */
export function symbolRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    currency: 'USD',
    description: 'APPLE INC',
    displaySymbol: 'AAPL',
    figi: 'BBG000B9XRY4',
    isin: 'US0378331005',
    mic: 'XNAS',
    shareClassFIGI: 'BBG001S5N8V8',
    symbol: 'AAPL',
    symbol2: '',
    type: 'Common Stock',
    ...over,
  }
}

/** /stock/candle 的列式响应（官方：c / h / l / o / s / t / v，t 为秒）。 */
export function candleSeries(fromSec: number, count: number, stepSec = STEP_SEC, price = 100): Record<string, unknown> {
  const c: number[] = []
  const h: number[] = []
  const l: number[] = []
  const o: number[] = []
  const t: number[] = []
  const v: number[] = []
  for (let i = 0; i < count; i++) {
    t.push(fromSec + i * stepSec)
    o.push(price + i)
    h.push(price + i + 1)
    l.push(price + i - 1)
    c.push(price + i + 0.5)
    v.push(10 + i)
  }
  return { c, h, l, o, s: 'ok', t, v }
}

export interface RawCall {
  path: string
  url: string
  params: URLSearchParams
  headers: Record<string, string>
}

export class FakeFinnhub {
  calls: RawCall[] = []
  symbols: unknown = [symbolRow(), symbolRow({ symbol: 'MSFT', displaySymbol: 'MSFT', description: 'MICROSOFT CORP' })]
  /** /stock/candle：函数按 from / to（秒）生成；固定对象则原样返回。 */
  candles: unknown | ((params: URLSearchParams) => unknown) = (params: URLSearchParams) => {
    const from = Number(params.get('from'))
    const to = Number(params.get('to'))
    const count = Math.max(0, Math.floor((to - from) / STEP_SEC) + 1)
    return candleSeries(from, count)
  }
  quote: unknown = { c: 100.5, d: 0.5, dp: 0.5, h: 101.2, l: 99.4, o: 100, pc: 100, t: FX_NOW / 1000 }
  bidAsk: unknown = { a: 100.2, av: 4, b: 100.1, bv: 3, t: FX_NOW / 1000 }
  marketStatus: unknown = {
    exchange: 'US', holiday: null, isOpen: true, session: 'regular', t: FX_NOW / 1000, timezone: 'America/New_York',
  }
  holidays: unknown = {
    data: [
      { atDate: '2026-11-27', eventName: 'Thanksgiving', tradingHour: '09:30-13:00' },
      { atDate: '2026-12-25', eventName: 'Christmas', tradingHour: '' },
    ],
  }
  /** pathname → 强制响应（Response 原样返回，其它对象转 JSON 200）。 */
  override = new Map<string, (params: URLSearchParams) => unknown>()

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    const params = url.searchParams
    const headers = headerRecord(init?.headers)
    // 官方基址是 https://finnhub.io/api/v1，端点路径在 /api/v1 之后；假服务器按去掉前缀后的路径分发
    const path = routePath(url.pathname)
    this.calls.push({ path, url: url.toString(), params, headers })
    const forced = this.override.get(path)
    if (forced) {
      const out = forced(params)
      return out instanceof Response ? out : json(out)
    }
    switch (path) {
      case '/stock/symbol': return json(this.symbols)
      case '/stock/candle': {
        const rows = this.candles
        return json(typeof rows === 'function' ? rows(params) : rows)
      }
      case '/quote': return json(this.quote)
      case '/stock/bidask': return json(this.bidAsk)
      case '/stock/market-status': return json(this.marketStatus)
      case '/stock/market-holiday': return json(this.holidays)
      default: return new Response(`unhandled ${path}`, { status: 404 })
    }
  }

  callsTo(path: string): RawCall[] {
    return this.calls.filter((c) => c.path === path)
  }
}

/** `/api/v1/stock/symbol` → `/stock/symbol`（基址前缀不进分发表）。 */
export const routePath = (pathname: string): string => pathname.replace(/^\/(?:api\/)?v1(?=\/)/, '')

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
