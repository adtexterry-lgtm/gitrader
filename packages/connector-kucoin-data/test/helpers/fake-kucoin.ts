// SPDX-License-Identifier: CPAL-1.0
// 离线假 KuCoin Futures 公共 REST：进程内按路径回答 { code, data } 信封，不开端口、不联网、不读夹具文件。
// 夹具取自真网 2026-10-20（api-futures.kucoin.com，XBTUSDTM），已截短：盘口每边 3 档、K 线 5 根。
export const FX_NOW = 1_792_510_096_738
export const STEP_MS = 60_000
/** 真网标记价的 timePoint（毫秒），比 ticker 的纳秒时间戳晚一点。 */
export const MARK_TS = 1_792_510_112_000

/** 一条 K 线行（真网形状）：[time(毫秒), o, h, l, c, volume(张), turnover]，全部是 number。 */
export function candleRow(ts: number, price = 82_400): unknown[] {
  return [ts, price, price + 1.5, price - 1.5, price + 0.5, 2_000, 165_000.5]
}

export function candleRows(from: number, count: number, step = STEP_MS, price = 82_400): unknown[][] {
  const out: unknown[][] = []
  for (let i = 0; i < count; i++) out.push(candleRow(from + i * step, price + i))
  return out
}

/** 真网 XBTUSDTM（USDT 永续）合约条目，over 覆盖单个字段。 */
export function contract(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    symbol: 'XBTUSDTM',
    displaySymbol: 'XBTUSDTM',
    rootSymbol: 'USDT',
    type: 'FFWCSX',
    firstOpenDate: 1_585_555_200_000,
    baseCurrency: 'XBT',
    quoteCurrency: 'USDT',
    settleCurrency: 'USDT',
    maxOrderQty: 1_000_000,
    lotSize: 1,
    tickSize: 0.1,
    indexPriceTickSize: 0.01,
    multiplier: 0.001,
    makerFeeRate: 0.0002,
    takerFeeRate: 0.0006,
    isDeleverage: true,
    isQuanto: true,
    isInverse: false,
    markMethod: 'FairPrice',
    status: 'Open',
    fundingFeeRate: 6.1e-5,
    fundingRateGranularity: 28_800_000,
    currentFundingRateGranularity: 28_800_000,
    nextFundingRateTime: 1_896_037,
    markPrice: 82_407.3,
    indexPrice: 82_448.48,
    lastTradePrice: 82_427.4,
    maxLeverage: 125,
    marketStage: 'NORMAL',
    ...over,
  }
}

export interface RawCall { path: string; url: string; params: URLSearchParams }

export class FakeKucoin {
  calls: RawCall[] = []
  /** 真网 /contracts/active 的截短版：两条 USDT 永续 + 一条反向（应剔除）+ 一条 CancelOnly（应剔除）。 */
  contracts: unknown[] = [
    contract(),
    contract({ symbol: 'ETHUSDTM', displaySymbol: 'ETHUSDTM', baseCurrency: 'ETH', tickSize: 0.01, multiplier: 0.01, markPrice: 2_429.6, maxLeverage: 100 }),
    contract({ symbol: 'SOLUSDTM', displaySymbol: 'SOLUSDTM', baseCurrency: 'SOL', tickSize: 0.001, multiplier: 0.1, markPrice: 105.156, maxLeverage: 75 }),
    contract({ symbol: 'ETHUSDM', displaySymbol: 'ETHUSDM', baseCurrency: 'ETH', quoteCurrency: 'USD', settleCurrency: 'ETH', isInverse: true, multiplier: -1 }),
    contract({ symbol: 'OLDUSDTM', displaySymbol: 'OLDUSDTM', baseCurrency: 'OLD', status: 'CancelOnly' }),
  ]
  /** 真网 /ticker?symbol=XBTUSDTM（ts 是纳秒）。 */
  ticker: unknown | ((params: URLSearchParams) => unknown) = {
    sequence: 1_748_608_657_319,
    symbol: 'XBTUSDTM',
    side: 'buy',
    size: 18,
    tradeId: '1948436580218',
    price: '82401.6',
    bestBidPrice: '82407.2',
    bestBidSize: 762,
    bestAskPrice: '82407.3',
    bestAskSize: 126,
    ts: 1_792_510_096_738_000_000,
  }
  /** 真网 /level2/depth20?symbol=XBTUSDTM（每边 3 档，size 是张）。 */
  depth20: unknown = {
    sequence: 1_748_608_667_407,
    symbol: 'XBTUSDTM',
    bids: [[82_407.2, 900], [82_405.7, 56], [82_405.6, 59]],
    asks: [[82_407.3, 46], [82_410.7, 2], [82_410.8, 2]],
    ts: 1_792_510_112_015_000_000,
  }
  /** depth100 夹具（合成 100 档）：只为验证档数上限与端点切换。 */
  depth100: unknown = {
    sequence: 1_748_608_667_408,
    symbol: 'XBTUSDTM',
    bids: Array.from({ length: 100 }, (_, i) => [82_407.2 - i * 0.1, 100 + i]),
    asks: Array.from({ length: 100 }, (_, i) => [82_407.3 + i * 0.1, 100 + i]),
    ts: 1_792_510_112_015_000_000,
  }
  /** 真网 /mark-price/XBTUSDTM/current。 */
  markPrice: unknown | ((params: URLSearchParams) => unknown) = {
    symbol: 'XBTUSDTM', granularity: 1_000, timePoint: MARK_TS, value: 82_415.75, indexPrice: 82_457.21,
  }
  /** 真网 /funding-rate/XBTUSDTM/current。 */
  fundingRate: unknown | ((params: URLSearchParams) => unknown) = {
    symbol: '.XBTUSDTMFPI8H', granularity: 28_800_000, timePoint: 1_792_483_200_000, value: 6.1e-5,
    dailyInterestRate: 3e-4, fundingRateCap: 0.003, fundingRateFloor: -0.003, period: 1, fundingTime: 1_792_512_000_000,
  }
  /** /kline/query 的回答（按 from / to 过滤），缺省空页。 */
  kline: (params: URLSearchParams) => unknown = () => []
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
    const pick = (v: unknown): unknown => (typeof v === 'function' ? (v as (p: URLSearchParams) => unknown)(params) : v)
    switch (url.pathname) {
      case '/api/v1/contracts/active': return envelope(this.contracts)
      case '/api/v1/ticker': return envelope(pick(this.ticker))
      case '/api/v1/level2/depth20': return envelope(this.depth20)
      case '/api/v1/level2/depth100': return envelope(this.depth100)
      case '/api/v1/kline/query': return envelope(this.kline(params))
      default:
        if (url.pathname.startsWith('/api/v1/mark-price/') && url.pathname.endsWith('/current')) return envelope(pick(this.markPrice))
        if (url.pathname.startsWith('/api/v1/funding-rate/') && url.pathname.endsWith('/current')) return envelope(pick(this.fundingRate))
        return new Response(`unhandled ${url.pathname}`, { status: 404 })
    }
  }

  callsTo(path: string): RawCall[] {
    return this.calls.filter((c) => c.path === path)
  }
}

/** 信封（code 为字符串）。 */
export function envelope(data: unknown, code = '200000', msg = ''): Response {
  return new Response(JSON.stringify({ code, msg, data }), {
    status: 200, headers: { 'content-type': 'application/json' },
  })
}

/** 业务错误信封：KuCoin 的业务错误同样走 HTTP 200。 */
export function errorEnvelope(code: string, msg: string): Response {
  return envelope(undefined, code, msg)
}

/** 轮询等待（真实定时器，离线；不依赖 vitest 假时钟）。 */
export async function waitFor(check: () => boolean, timeoutMs = 1500): Promise<void> {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timeout')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
