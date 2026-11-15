// SPDX-License-Identifier: CPAL-1.0
// 离线假 Bitget v2 公共 REST：进程内按路径回答 { code, msg, requestTime, data } 信封，不开端口、不联网、不读夹具文件。
// 下面的 contracts / ticker / depth / current-fund-rate / candles 取值来自真网（api.bitget.com，2026-10-20 采集并截短），
// 只为测试所用；非 normal 条目与错误信封是手写的，用来覆盖过滤与报错分支。
export const FX_NOW = 1_792_510_096_955
export const STEP_MS = 60_000

/** 真网 BTCUSDT 一条 K 线：[ts(毫秒字符串), open, high, low, close, baseVolume, quoteVolume]。 */
export function candleRow(ts: number, price = 100): unknown[] {
  return [
    String(ts), String(price), String(price + 1), String(price - 1), String(price + 0.5), '10', '1000',
  ]
}

export function candleRows(from: number, count: number, step = STEP_MS): unknown[][] {
  const out: unknown[][] = []
  for (let i = 0; i < count; i++) out.push(candleRow(from + i * step, 100 + i))
  return out
}

/** 真网 /mix/market/candles 的前 5 根 1m K 线（BTCUSDT，截短）。 */
export const REAL_CANDLES: unknown[] = [
  ['1792509840000', '82339.4', '82437.2', '82300', '82429.9', '107.8259', '8881503.25215'],
  ['1792509900000', '82429.9', '82483.3', '82424.1', '82478.1', '50.112', '4131667.35922'],
  ['1792509960000', '82478.1', '82484.6', '82374.6', '82393.1', '20.8749', '1720161.89608'],
  ['1792510020000', '82393.1', '82414.6', '82342.2', '82405.7', '44.643', '3677148.00788'],
  ['1792510080000', '82405.7', '82443.7', '82382.7', '82398.2', '6.9744', '574755.04866'],
]

/** 一条 USDT 永续合约（normal），over 覆盖单个字段；缺省值取自真网 BTCUSDT。 */
export function contractEntry(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    symbol: 'BTCUSDT',
    baseCoin: 'BTC',
    quoteCoin: 'USDT',
    symbolType: 'perpetual',
    symbolStatus: 'normal',
    pricePlace: '1',
    priceEndStep: '1',
    volumePlace: '4',
    minTradeNum: '0.0001',
    minTradeUSDT: '5',
    fundInterval: '8',
    maxLever: '150',
    ...over,
  }
}

export interface RawCall { path: string; url: string; params: URLSearchParams }

export class FakeBitget {
  calls: RawCall[] = []
  contracts: unknown[] = [
    contractEntry(),
    contractEntry({ symbol: 'ETHUSDT', baseCoin: 'ETH', pricePlace: '2', volumePlace: '2', minTradeNum: '0.01', maxLever: '150' }),
    contractEntry({ symbol: 'XRPUSDT', baseCoin: 'XRP', pricePlace: '4', volumePlace: '0', minTradeNum: '1', maxLever: '125' }),
    // 手写：非 normal 条目应在解析层被剔除
    contractEntry({ symbol: 'OLDUSDT', baseCoin: 'OLD', symbolStatus: 'offline' }),
  ]
  /** /candles 的 data；固定数组或按参数生成。 */
  candleRows: unknown[] | ((params: URLSearchParams) => unknown) = REAL_CANDLES
  /** /history-candles 的 data；缺省空页。 */
  historyRows: (params: URLSearchParams) => unknown = () => []
  ticker: unknown | ((params: URLSearchParams) => unknown) = {
    symbol: 'BTCUSDT',
    lastPr: '82396.2',
    askPr: '82396.2',
    bidPr: '82396.1',
    bidSz: '5.4719',
    askSz: '5.2528',
    ts: '1792510096957',
    indexPrice: '82448.5535',
    fundingRate: '0.000073',
    holdingAmount: '33967.4455999999845',
    quoteVolume: '2816260673.22247',
    open24h: '82397.2',
    markPrice: '82405.8',
  }
  depth: unknown = {
    asks: [[82402.8, 2.8471], [82403.2, 0.495], [82405.3, 0.0001], [82405.4, 0.0764], [82405.6, 0.131]],
    bids: [[82402.7, 7.7387], [82401.5, 1.2375], [82401.4, 0.854], [82401.3, 0.1115], [82401.2, 0.19]],
    ts: '1792510097120',
    scale: '0.1',
    precision: 'scale0',
  }
  funding: unknown = {
    symbol: 'BTCUSDT',
    fundingRate: '0.000073',
    fundingRateInterval: '8',
    nextUpdate: '1792512000000',
    minFundingRate: '-0.003',
    maxFundingRate: '0.003',
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
      case '/api/v2/mix/market/contracts': return envelope(this.contracts)
      case '/api/v2/mix/market/candles': return envelope(pick(this.candleRows))
      case '/api/v2/mix/market/history-candles': return envelope(this.historyRows(params))
      case '/api/v2/mix/market/ticker': return envelope([pick(this.ticker)])
      case '/api/v2/mix/market/merge-depth': return envelope(this.depth)
      case '/api/v2/mix/market/current-fund-rate': return envelope([this.funding])
      default: return new Response(`unhandled ${url.pathname}`, { status: 404 })
    }
  }

  callsTo(path: string): RawCall[] {
    return this.calls.filter((c) => c.path === path)
  }
}

/** Bitget 成功信封（code 00000）。 */
export const envelope = (data: unknown): Response =>
  new Response(JSON.stringify({ code: '00000', msg: 'success', requestTime: FX_NOW, data }), {
    status: 200, headers: { 'content-type': 'application/json' },
  })

/** Bitget 业务错误信封（真网示例：symbol 不存在 → code 40034）。 */
export const errorEnvelope = (code: string, msg: string): Response =>
  new Response(JSON.stringify({ code, msg, requestTime: FX_NOW, data: null }), {
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
