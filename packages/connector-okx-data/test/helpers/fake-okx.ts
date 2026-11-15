// SPDX-License-Identifier: CPAL-1.0
// 离线假 OKX 公共 REST：进程内按路径回答 { code, msg, data } 信封，不开端口、不联网、不读夹具文件。
export const FX_NOW = 1_791_483_435_048
export const STEP_MS = 60_000

/**
 * OKX K 线行：[ts, o, h, l, c, vol, volCcy, volCcyQuote, confirm]（倒序由上游负责，这里只造行）。
 * vol 是张数、volCcy 是币数量，二者按 ctVal 自洽（vol × ctVal = volCcy），与真实 SWAP 一致。
 */
export function candleRow(ts: number, price = 100, contracts = 10, ctVal = 0.01): unknown[] {
  const volCcy = Number((contracts * ctVal).toFixed(8))
  const volCcyQuote = Number((volCcy * price).toFixed(8))
  return [
    String(ts), String(price), String(price + 1), String(price - 1), String(price + 0.5),
    String(contracts), String(volCcy), String(volCcyQuote), '1',
  ]
}

export function candleRows(from: number, count: number, step = STEP_MS, ctVal = 0.01): unknown[][] {
  const out: unknown[][] = []
  for (let i = 0; i < count; i++) out.push(candleRow(from + i * step, 100 + i, 10, ctVal))
  return out
}

/** 一条 SWAP 合约（可交易），over 覆盖单个字段。 */
export function swapEntry(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    instType: 'SWAP',
    instId: 'BTC-USDT-SWAP',
    instFamily: 'BTC-USDT',
    baseCcy: '',
    quoteCcy: '',
    settleCcy: 'USDT',
    ctVal: '0.01',
    ctValCcy: 'BTC',
    ctMult: '1',
    tickSz: '0.1',
    lotSz: '0.01',
    minSz: '0.01',
    state: 'live',
    listTime: '1611133200000',
    expTime: '',
    ...over,
  }
}

export interface RawCall { path: string; url: string; params: URLSearchParams }

export class FakeOkx {
  calls: RawCall[] = []
  instruments: unknown[] = [
    swapEntry(),
    swapEntry({ instId: 'ETH-USDT-SWAP', instFamily: 'ETH-USDT', ctVal: '0.1', ctValCcy: 'ETH', tickSz: '0.01', lotSz: '0.01' }),
    swapEntry({ instId: 'OLD-USDT-SWAP', instFamily: 'OLD-USDT', state: 'expired' }),
    // 币本位（settleCcy = 标的币）：解析后应被排除
    swapEntry({ instId: 'BTC-USD-SWAP', instFamily: 'BTC-USD', settleCcy: 'BTC', ctVal: '100', ctValCcy: 'USD' }),
    swapEntry({ instType: 'FUTURES', instId: 'BTC-USDT-260327' }),
  ]
  /** 最近 K 线（/market/candles）；可以是固定数组或按参数生成。 */
  candleRows: unknown[] | ((params: URLSearchParams) => unknown) = []
  /** 历史 K 线（/market/history-candles）；缺省空页。 */
  historyRows: (params: URLSearchParams) => unknown = () => []
  ticker: unknown | ((params: URLSearchParams) => unknown) = {
    instId: 'BTC-USDT-SWAP', last: '100.15', lastSz: '1', askPx: '100.2', bidPx: '100.1', ts: String(FX_NOW),
  }
  books: unknown = {
    ts: String(FX_NOW),
    bids: [['100.0', '1.5', '0', '3'], ['99.9', '2.5', '0', '1'], ['99.8', '3.5', '0', '2']],
    asks: [['100.2', '0.5', '0', '1'], ['100.1', '1.5', '0', '2'], ['100.3', '2.5', '0', '1']],
  }
  markPrice: unknown = { instId: 'BTC-USDT-SWAP', markPx: '100.05', ts: String(FX_NOW) }
  fundingRate: unknown = {
    instId: 'BTC-USDT-SWAP', fundingRate: '0.00010000',
    fundingTime: String(FX_NOW), nextFundingTime: String(FX_NOW + 28_800_000),
  }
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
      case '/api/v5/public/instruments': return envelope(this.instruments)
      case '/api/v5/market/candles': return envelope(pick(this.candleRows))
      case '/api/v5/market/history-candles': return envelope(this.historyRows(params))
      case '/api/v5/market/ticker': return envelope([pick(this.ticker)])
      case '/api/v5/market/books': return envelope([this.books])
      case '/api/v5/public/mark-price': return envelope([this.markPrice])
      case '/api/v5/public/funding-rate': return envelope([this.fundingRate])
      default: return new Response(`unhandled ${url.pathname}`, { status: 404 })
    }
  }

  callsTo(path: string): RawCall[] {
    return this.calls.filter((c) => c.path === path)
  }
}

/** OKX 成功信封。 */
export const envelope = (data: unknown): Response =>
  new Response(JSON.stringify({ code: '0', msg: '', data }), {
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
