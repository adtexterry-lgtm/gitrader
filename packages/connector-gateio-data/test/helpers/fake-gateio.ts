// SPDX-License-Identifier: CPAL-1.0
// 离线假 Gate.io v4 USDT 永续公共 REST：进程内按路径回答原始 JSON，不开端口、不联网、不读夹具文件。
// 夹具来源：2026-10-20 真网截短（见 REAL_* 常量：contracts / tickers / order_book / candlesticks 的原始字段与取值）；
// 唯一合成条目是 DELISTING_CONTRACT（真网当时无 in_delisting 合约，为验证过滤逻辑手写，字段照 BTC_USDT 抄）。
import { CANDLE_PAGE } from '../../src/parse'
import type { RawBook, RawContract, RawTicker } from '../../src/parse'

/** 固定时钟：2026-10-20 15:29 UTC 附近的整分钟，便于与真网 K 线秒数对齐。 */
export const FX_NOW = 1_792_511_040_000
export const STEP_MS = 60_000

/** 真网 /contracts 截短（BTC / ETH / DOGE 三条，只留本连接器用到的字段）。 */
export const REAL_CONTRACTS: RawContract[] = [
  {
    name: 'BTC_USDT', in_delisting: false, order_price_round: '0.1', order_size_min: 1, quanto_multiplier: '0.0001',
    funding_rate: '0.000019', funding_interval: 28800, funding_next_apply: 1792512000, mark_price: '82446.1',
    leverage_max: '200', status: 'trading', type: 'direct',
  },
  {
    name: 'DOGE_USDT', in_delisting: false, order_price_round: '0.00001', order_size_min: 1, quanto_multiplier: '10',
    funding_rate: '0.000025', funding_interval: 28800, funding_next_apply: 1792512000, mark_price: '0.08034',
    leverage_max: '75', status: 'trading', type: 'direct',
  },
  {
    name: 'ETH_USDT', in_delisting: false, order_price_round: '0.01', order_size_min: 0, quanto_multiplier: '0.01',
    funding_rate: '0.000014', funding_interval: 28800, funding_next_apply: 1792512000, mark_price: '2431.48',
    leverage_max: '200', status: 'trading', type: 'direct',
  },
]

/** 合成条目：真网 2026-10-20 没有 in_delisting 合约，这一条为验证「只取 in_delisting === false」手写。 */
export const DELISTING_CONTRACT: RawContract = {
  ...REAL_CONTRACTS[0]!, name: 'OLD_USDT', in_delisting: true, mark_price: '1.0023', status: 'delisting',
}

/** 真网 GET /tickers?contract=BTC_USDT 截短（2026-10-20，字符串字段保持原样）。 */
export const REAL_TICKER: RawTicker = {
  last: '82436.7', mark_price: '82439.89', funding_rate: '0.000019', contract: 'BTC_USDT',
  total_size: '529157000', highest_bid: '82436.7', lowest_ask: '82436.8', quanto_multiplier: '0.0001',
}

/** 真网 GET /order_book?contract=BTC_USDT&limit=3（2026-10-20；`s` 为张数、数字类型）。 */
export const REAL_BOOK: RawBook = {
  current: 1792510162.502,
  update: 1792510162.501,
  asks: [{ s: 2443, p: '82440.4' }, { s: 7, p: '82442.9' }, { s: 2185, p: '82443' }],
  bids: [{ s: 37812, p: '82440.3' }, { s: 1250, p: '82437.4' }, { s: 13233, p: '82437.2' }],
}

/** 真网 GET /candlesticks?contract=BTC_USDT&interval=1m&limit=3（2026-10-20，`t` 为秒、`v` 为张数）。 */
export const REAL_CANDLES: unknown[] = [
  { o: '82403.4', v: 1007717, t: 1792510020, c: '82412.2', l: '82346.9', h: '82418.5', sum: '8301565.40329' },
  { o: '82409.9', v: 778495, t: 1792510080, c: '82446.6', l: '82390.1', h: '82447.1', sum: '6416341.7651' },
  { o: '82446.6', v: 205911, t: 1792510140, c: '82437.2', l: '82427.3', h: '82454.5', sum: '1697527.20977' },
]

/** 造一行 K 线（`t` 用秒，和上游一致）。 */
export function candleRow(tsSeconds: number, price = 100): Record<string, unknown> {
  return {
    t: tsSeconds, o: String(price), h: String(price + 1), l: String(price - 1), c: String(price + 0.5), v: 10, sum: '1000',
  }
}

/** 从 `fromMs` 起造 count 行 1m K 线（秒对齐，升序）。 */
export function candleRows(fromMs: number, count: number, stepMs = STEP_MS): unknown[] {
  const out: unknown[] = []
  for (let i = 0; i < count; i++) out.push(candleRow(Math.floor((fromMs + i * stepMs) / 1000), 100 + i))
  return out
}

/**
 * 忠实模拟 /candlesticks 的 from/to 语义：不认 limit（Gate.io 400 拒绝 limit 与 from/to 同时出现），
 * 返回 t 落在 [from - 一个周期, to] 的升序行（上游会把 `from` 向下对齐到所在 K 线，故可能多给一根），
 * 单页上限 2000 根。
 */
export function venuePage(rows: number[][], params: URLSearchParams, stepSec = 60): unknown[] {
  const from = params.get('from')
  const to = params.get('to')
  const fromSec = from === null ? Number.NEGATIVE_INFINITY : Number(from) - stepSec
  const toSec = to === null ? Number.POSITIVE_INFINITY : Number(to)
  return rows
    .filter((r) => (r[0] as number) > fromSec && (r[0] as number) <= toSec)
    .slice(0, CANDLE_PAGE)
    .map(([sec, price]) => candleRow(sec as number, price as number))
}

export interface RawCall { path: string; url: string; params: URLSearchParams }

export class FakeGateio {
  calls: RawCall[] = []
  contracts: unknown = [...REAL_CONTRACTS, DELISTING_CONTRACT]
  /** 最近 K 线（limit 模式）；固定数组或按参数生成。 */
  candleRows: unknown[] | ((params: URLSearchParams) => unknown) = REAL_CANDLES
  /** 区间 K 线（from/to 模式）：秒对齐的 [t, price] 行，按 venuePage 语义切页。 */
  candleSeries: number[][] = []
  ticker: unknown | ((params: URLSearchParams) => unknown) = [REAL_TICKER]
  book: unknown | ((params: URLSearchParams) => unknown) = REAL_BOOK
  /** pathname → 强制响应（Response 原样返回，其它对象按 JSON 200 包出去）。 */
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
    switch (url.pathname) {
      case '/api/v4/futures/usdt/contracts': return json(this.contracts)
      case '/api/v4/futures/usdt/tickers': return json(pick(this.ticker))
      case '/api/v4/futures/usdt/order_book': return json(pick(this.book))
      case '/api/v4/futures/usdt/candlesticks':
        if (params.get('from') !== null) return json(venuePage(this.candleSeries, params))
        return json(pick(this.candleRows))
      default: return new Response(`unhandled ${url.pathname}`, { status: 404 })
    }
  }

  callsTo(path: string): RawCall[] {
    return this.calls.filter((c) => c.path === path)
  }
}

const json = (data: unknown): Response =>
  new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } })

/** 轮询等待（真实定时器，离线；不依赖 vitest 假时钟）。 */
export async function waitFor(check: () => boolean, timeoutMs = 1500): Promise<void> {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timeout')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
