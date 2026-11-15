// SPDX-License-Identifier: CPAL-1.0
// 离线假 Coinbase Advanced Trade 公共 REST：进程内按路径回答真实形状（ticker / pricebook / candles），
// 不开端口、不联网、不读夹具文件。产品与行情字段取自 2026-10-20 真网响应（截短），另补一条 delisted 条目用于过滤测试。
export const FX_NOW = 1_792_510_100_000
/** 真网 ticker 里最近一笔成交的时间（带 6 位小数秒，解析时截到毫秒）。 */
export const FX_TRADE_TIME = '2026-10-20T15:28:16.705799Z'
export const FX_BOOK_TIME = '2026-10-20T15:28:17.137305Z'
export const STEP_SEC = 60
export const STEP_MS = 60_000

/** 一条 SPOT 产品（BTC-USD 真网字段），over 覆盖单个字段。 */
export function productEntry(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    product_id: 'BTC-USD',
    price: '82382.97',
    base_increment: '0.00000001',
    quote_increment: '0.01',
    quote_min_size: '1',
    base_min_size: '0.00000001',
    status: 'online',
    product_type: 'SPOT',
    base_currency_id: 'BTC',
    quote_currency_id: 'USD',
    ...over,
  }
}

/** 一根 K 线（Coinbase 原样字段名；start 是秒字符串）。 */
export function candleRow(startSec: number, price = 100): Record<string, string> {
  return {
    start: String(startSec),
    low: String(price - 1),
    high: String(price + 1),
    open: String(price),
    close: String(price + 0.5),
    volume: '1.5',
  }
}

/** 升序生成 count 根（假实现负责按上游习惯倒序返回）。 */
export function candleSeries(fromSec: number, count: number, stepSec = STEP_SEC): Record<string, string>[] {
  const out: Record<string, string>[] = []
  for (let i = 0; i < count; i++) out.push(candleRow(fromSec + i * stepSec, 100 + i))
  return out
}

export interface RawCall { path: string; url: string; params: URLSearchParams }

export class FakeCoinbase {
  calls: RawCall[] = []
  products: unknown[] = [
    productEntry(),
    productEntry({
      product_id: 'ETH-USD', price: '2428.2', base_increment: '0.00000001', quote_increment: '0.01', quote_min_size: '1',
      base_min_size: '0.00000001', base_currency_id: 'ETH',
    }),
    productEntry({ product_id: 'OLD-USD', status: 'delisted', base_currency_id: 'OLD' }),
  ]
  /** 最近 K 线（/candles）；可以是固定数组或按参数生成。缺省 3 根真网截短的 1m 线（倒序）。 */
  candles: unknown | ((params: URLSearchParams) => unknown) = [
    { start: '1792510080', low: '82340.15', high: '82385.52', open: '82362.98', close: '82385.52', volume: '1.81192987' },
    { start: '1792510020', low: '82295.14', high: '82376.64', open: '82344.43', close: '82373.88', volume: '12.72133689' },
    { start: '1792509960', low: '82325.18', high: '82444.85', open: '82436.3', close: '82344.43', volume: '10.81785432' },
  ]
  ticker: unknown = {
    best_bid: '82363.57',
    best_ask: '82363.58',
    trades: [
      { trade_id: '1108445896', product_id: 'BTC-USD', price: '82363.33', size: '0.00000014', time: FX_TRADE_TIME, side: 'BUY' },
    ],
  }
  book: unknown = {
    pricebook: {
      product_id: 'BTC-USD',
      bids: [
        { price: '82367.97', size: '0.01273918' },
        { price: '82366.32', size: '0.02428176' },
        { price: '82365.06', size: '0.09712944' },
      ],
      asks: [
        { price: '82367.98', size: '0.0045385' },
        { price: '82368.6', size: '0.04' },
        { price: '82369.63', size: '0.0242808' },
      ],
      time: FX_BOOK_TIME,
    },
    last: '82367.975',
    mid_market: '82367.975',
  }
  /** pathname → 强制响应（Response 原样返回，其它对象包成 200 JSON）。 */
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
    const pick = (v: unknown): unknown => (typeof v === 'function' ? (v as (p: URLSearchParams) => unknown)(params) : v)
    const path = url.pathname
    if (path === '/api/v3/brokerage/market/products') return json({ products: this.products })
    if (path.endsWith('/candles')) return json({ candles: pick(this.candles) })
    if (path.endsWith('/ticker')) return json(pick(this.ticker))
    if (path === '/api/v3/brokerage/market/product_book') return json(this.book)
    return new Response(`unhandled ${path}`, { status: 404 })
  }

  callsTo(path: string): RawCall[] {
    return this.calls.filter((c) => c.path === path)
  }
}

/** Coinbase 公共端点没有信封，成功就是 200 + 裸对象。 */
export const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

/** 轮询等待（真实定时器，离线；不依赖 vitest 假时钟）。 */
export async function waitFor(check: () => boolean, timeoutMs = 1500): Promise<void> {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timeout')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
