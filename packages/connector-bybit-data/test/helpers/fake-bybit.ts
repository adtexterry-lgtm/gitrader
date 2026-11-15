// SPDX-License-Identifier: CPAL-1.0
// 离线假 Bybit v5 公共 REST：进程内按路径回答 { retCode, retMsg, result, time } 信封，不开端口、不联网、不读夹具文件。
// 合约 / ticker / 盘口 / 短 K 线取自真网截短响应（2026-10-20 UTC，api.bybit.com）；长区间翻页用同字段形状的生成器。
export const FX_NOW = 1_792_510_147_359
export const STEP_MS = 60_000

/** K 线行：[startTime(ms), open, high, low, close, volume, turnover]（真网字段顺序）。 */
export function candleRow(ts: number, price = 100): unknown[] {
  return [String(ts), String(price), String(price + 1), String(price - 1), String(price + 0.5), '5773.416', '476745733.8298']
}

/** 从 from 起、按 step 递增的 count 根 K 线，升序。 */
export function candleRows(from: number, count: number, step = STEP_MS): unknown[][] {
  const out: unknown[][] = []
  for (let i = 0; i < count; i++) out.push(candleRow(from + i * step, 100 + i))
  return out
}

/** 一条线性永续合约（真网字段，未列出的字段本连接器不读）。 */
export function perpEntry(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    symbol: 'BTCUSDT',
    contractType: 'LinearPerpetual',
    status: 'Trading',
    baseCoin: 'BTC',
    quoteCoin: 'USDT',
    settleCoin: 'USDT',
    fundingInterval: 480,
    priceFilter: { tickSize: '0.10' },
    lotSizeFilter: { qtyStep: '0.001', minOrderQty: '0.001', minNotionalValue: '5' },
    ...over,
  }
}

export interface RawCall { path: string; url: string; params: URLSearchParams }

export class FakeBybit {
  calls: RawCall[] = []
  /** 合约清单分页；缺省一页、nextPageCursor 为空。 */
  instrumentPages: Array<{ list: unknown[]; nextPageCursor: string }> = [
    {
      list: [
        // 真网 2026-10-20：BTCUSDT / ETHUSDT（8h 资金）、0GUSDT（4h 资金）
        perpEntry(),
        perpEntry({
          symbol: 'ETHUSDT', baseCoin: 'ETH', quoteCoin: 'USDT', fundingInterval: 480,
          priceFilter: { tickSize: '0.01' }, lotSizeFilter: { qtyStep: '0.01', minOrderQty: '0.01', minNotionalValue: '5' },
        }),
        perpEntry({
          symbol: '0GUSDT', baseCoin: '0G', quoteCoin: 'USDT', fundingInterval: 240,
          priceFilter: { tickSize: '0.0001' }, lotSizeFilter: { qtyStep: '0.1', minOrderQty: '0.1', minNotionalValue: '5' },
        }),
        // 非 Trading / 非 LinearPerpetual：应在解析阶段被丢弃（字段形状同真网）
        perpEntry({ symbol: 'HALTUSDT', baseCoin: 'HALT', status: 'PreLaunch' }),
        perpEntry({ symbol: 'BTCUSDT-27MAR26', baseCoin: 'BTC', contractType: 'LinearFutures', deliveryTime: '1790323200000' }),
        perpEntry({ symbol: 'BTCUSD', baseCoin: 'BTC', quoteCoin: 'USD', contractType: 'InversePerpetual' }),
      ],
      nextPageCursor: '',
    },
  ]
  /** 按 symbol 回 ticker 行；缺省回 BTCUSDT 的真网快照。 */
  tickers: Record<string, unknown> = {
    BTCUSDT: {
      symbol: 'BTCUSDT', lastPrice: '82429.10', indexPrice: '82478.82', markPrice: '82440.94',
      openInterest: '58828.846', fundingRate: '0.00004899', nextFundingTime: '1792512000000',
      ask1Price: '82428.60', bid1Price: '82428.50', ask1Size: '4.978', bid1Size: '3.552',
    },
    ETHUSDT: {
      symbol: 'ETHUSDT', lastPrice: '2429.28', indexPrice: '2430.63', markPrice: '2429.29',
      openInterest: '763730.47', fundingRate: '0.00003041', nextFundingTime: '1792512000000',
      ask1Price: '2429.29', bid1Price: '2429.28', ask1Size: '46.35', bid1Size: '16.19',
    },
  }
  /** 盘口（真网 limit=3 的快照）。 */
  books: Record<string, unknown> = {
    BTCUSDT: {
      s: 'BTCUSDT',
      a: [['82428.60', '4.978'], ['82428.70', '0.002'], ['82430.30', '0.001']],
      b: [['82428.50', '3.688'], ['82428.40', '0.001'], ['82428.30', '0.001']],
      ts: 1_792_510_147_359,
      u: 3178309,
      seq: 829439740215,
    },
  }
  /** K 线生成区间：默认覆盖最近 2500 根 1m。 */
  candleFrom = FX_NOW - 2500 * STEP_MS
  candleCount = 2500
  /** pathname → 强制响应（Response 原样返回，其它对象按信封包成 200）。 */
  override = new Map<string, (params: URLSearchParams) => unknown>()

  readonly fetch: typeof fetch = async (input) => {
    const url = new URL(String(input))
    const params = url.searchParams
    this.calls.push({ path: url.pathname, url: url.toString(), params })
    const forced = this.override.get(url.pathname)
    if (forced) {
      const out = forced(params)
      return out instanceof Response ? out : envelope(out)
    }
    switch (url.pathname) {
      case '/v5/market/instruments-info': return this.instrumentsPage(params)
      case '/v5/market/kline': return envelope(this.klineResult(params))
      case '/v5/market/tickers': return envelope({ category: 'linear', list: [this.tickerRow(params)] })
      case '/v5/market/orderbook': return envelope(this.books[params.get('symbol') ?? 'BTCUSDT'] ?? this.books.BTCUSDT)
      default: return new Response(`unhandled ${url.pathname}`, { status: 404 })
    }
  }

  callsTo(path: string): RawCall[] {
    return this.calls.filter((c) => c.path === path)
  }

  private instrumentsPage(params: URLSearchParams): Response {
    const cursor = params.get('cursor')
    const index = cursor === null ? 0 : Math.max(0, Number(cursor.replace(/^page-/, '')) - 1)
    const page = this.instrumentPages[index] ?? { list: [], nextPageCursor: '' }
    return envelope({ category: 'linear', list: page.list, nextPageCursor: page.nextPageCursor })
  }

  private tickerRow(params: URLSearchParams): unknown {
    return this.tickers[params.get('symbol') ?? 'BTCUSDT'] ?? this.tickers.BTCUSDT
  }

  /** Bybit 在 [start, end] 内按时间倒序返回，最多 limit 行；无 start 时取 end 往前 limit 根。 */
  private klineResult(params: URLSearchParams): unknown {
    const limit = Number(params.get('limit') ?? 200)
    const endParam = params.get('end')
    const startParam = params.get('start')
    const end = endParam === null ? FX_NOW : Number(endParam)
    const start = startParam === null ? end - limit * STEP_MS : Number(startParam)
    const all = candleRows(this.candleFrom, this.candleCount)
    const inRange = all.filter((row) => Number(row[0]) >= start && Number(row[0]) <= end)
    return { symbol: params.get('symbol'), category: 'linear', list: inRange.slice(-limit).reverse() }
  }
}

/** Bybit 成功信封。 */
export const envelope = (result: unknown): Response =>
  new Response(JSON.stringify({ retCode: 0, retMsg: 'OK', result, time: FX_NOW }), {
    status: 200, headers: { 'content-type': 'application/json' },
  })

/** 轮询等待（真实定时器，离线；不依赖 vitest 假时钟）。 */
export async function waitFor(check: () => boolean, timeoutMs = 1500): Promise<void> {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timeout')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
