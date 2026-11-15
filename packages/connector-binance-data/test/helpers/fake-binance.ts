// SPDX-License-Identifier: CPAL-1.0
// 离线假 Binance USDⓈ-M 公共 REST：进程内按路径回答，不开端口、不联网、不读夹具文件。
export const FX_NOW = 1_791_483_435_048
export const STEP_MS = 60_000

/** 12 列 kline 行（Binance 原生顺序：开盘时间、O、H、L、C、量 + 6 个本连接器不用的列）。 */
export function klineRow(openTime: number, price = 100): unknown[] {
  return [
    openTime, String(price), String(price + 1), String(price - 1), String(price + 0.5), '10',
    openTime + STEP_MS - 1, '1000', 7, '4', '400', '0',
  ]
}

export function klines(from: number, count: number, step = STEP_MS): unknown[][] {
  const out: unknown[][] = []
  for (let i = 0; i < count; i++) out.push(klineRow(from + i * step, 100 + i))
  return out
}

/** 一条 exchangeInfo 标的（永续、可交易），over 覆盖单个字段。 */
export function symbolEntry(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    symbol: 'BTCUSDT',
    pair: 'BTCUSDT',
    contractType: 'PERPETUAL',
    status: 'TRADING',
    baseAsset: 'BTC',
    quoteAsset: 'USDT',
    marginAsset: 'USDT',
    pricePrecision: 2,
    quantityPrecision: 3,
    filters: [
      { filterType: 'PRICE_FILTER', tickSize: '0.10', minPrice: '0.10', maxPrice: '1000000' },
      { filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001', maxQty: '1000' },
      { filterType: 'MIN_NOTIONAL', notional: '5' },
    ],
    ...over,
  }
}

export interface RawCall { path: string; url: string; params: URLSearchParams }

export class FakeBinance {
  calls: RawCall[] = []
  symbols: unknown[] = [
    symbolEntry(),
    symbolEntry({ symbol: 'ETHUSDT', baseAsset: 'ETH' }),
    symbolEntry({ symbol: 'OLDUSDT', status: 'CLOSE' }),
    symbolEntry({ symbol: 'BTCUSDT_240628', contractType: 'CURRENT_QUARTER' }),
  ]
  klineRows: unknown[] | ((params: URLSearchParams) => unknown) = []
  bookTicker: unknown = { symbol: 'BTCUSDT', bidPrice: '100.1', askPrice: '100.2', bidQty: '1', askQty: '2', time: FX_NOW }
  depth: unknown = {
    lastUpdateId: 1,
    T: FX_NOW,
    bids: [['100.0', '1.5'], ['99.9', '2.5'], ['99.8', '3.5']],
    asks: [['100.2', '0.5'], ['100.1', '1.5'], ['100.3', '2.5']],
  }
  premiumIndex: unknown = {
    symbol: 'BTCUSDT', markPrice: '100.05', indexPrice: '100.00', lastFundingRate: '0.00010000',
    nextFundingTime: FX_NOW + 28_800_000, time: FX_NOW,
  }
  /** pathname → 强制响应（Response 原样返回，其它对象转 JSON 200）。 */
  override = new Map<string, (params: URLSearchParams) => unknown>()

  readonly fetch: typeof fetch = async (input) => {
    const url = new URL(String(input))
    const params = url.searchParams
    this.calls.push({ path: url.pathname, url: url.toString(), params })
    const forced = this.override.get(url.pathname)
    if (forced) {
      const out = forced(params)
      return out instanceof Response ? out : json(out)
    }
    switch (url.pathname) {
      case '/fapi/v1/exchangeInfo': return json({ symbols: this.symbols })
      case '/fapi/v1/klines': {
        const rows = this.klineRows
        return json(typeof rows === 'function' ? rows(params) : rows)
      }
      case '/fapi/v1/ticker/bookTicker': return json(this.bookTicker)
      case '/fapi/v1/depth': return json(this.depth)
      case '/fapi/v1/premiumIndex': return json(this.premiumIndex)
      default: return new Response(`unhandled ${url.pathname}`, { status: 404 })
    }
  }

  callsTo(path: string): RawCall[] {
    return this.calls.filter((c) => c.path === path)
  }
}

const json = (o: unknown, status = 200): Response =>
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
