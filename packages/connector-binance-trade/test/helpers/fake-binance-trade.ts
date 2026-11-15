// SPDX-License-Identifier: CPAL-1.0
// 离线假 Binance USDⓈ-M 服务：进程内按 路径 + 方法 回答，不开端口、不联网、不读夹具文件。
// 形状照 packages/connector-binance-data/test/helpers/fake-binance.ts（CPAL-1.0）扩出签名端点。
// 会校验签名（用同一个 API_SECRET 复算）与必填参数；缺参回 -1102，签名不符回 -1022。
import { signatureOf } from '../../src/rest'

export const API_KEY = 'test-api-key-not-real'
export const API_SECRET = 'test-secret-not-a-real-key'
export const BASE_URL = 'http://binance.example.test'
export const NOW = 1_791_483_435_048
export const STEP_MS = 60_000

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

export interface Call {
  method: string
  path: string
  url: string
  /** 去掉 signature 之后的查询参数（签名前的原文由 url 保留）。 */
  params: URLSearchParams
  apiKey: string | null
  signature: string | null
}

export const json = (o: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json', ...headers } })

/** 需要 HMAC 签名的端点（listenKey 只要 API key 头，不在表里）。 */
const SIGNED_PATHS = new Set([
  '/fapi/v2/account', '/fapi/v2/positionRisk', '/fapi/v1/userTrades', '/fapi/v1/openOrders',
  '/fapi/v1/order', '/fapi/v1/allOpenOrders', '/fapi/v1/leverage', '/fapi/v1/marginType',
  '/fapi/v1/algoOrder', '/fapi/v1/openAlgoOrders', '/fapi/v1/algoOpenOrders',
])
const API_KEY_ONLY_PATHS = new Set(['/fapi/v1/listenKey'])

/** 必填参数校验（缺参 → -1102）。 */
function missingParam(key: string, p: URLSearchParams): string | undefined {
  const missing = (...names: string[]): string | undefined => names.find((n) => !p.has(n) || p.get(n) === '')
  const oneOf = (...names: string[]): boolean => names.some((n) => p.has(n) && p.get(n) !== '')
  switch (key) {
    case 'POST /fapi/v1/order': {
      const m = missing('symbol', 'side', 'type', 'quantity')
      if (m !== undefined) return m
      const type = p.get('type')
      if ((type === 'LIMIT' || type === 'STOP' || type === 'TAKE_PROFIT') && !p.has('price')) return 'price'
      if ((type === 'LIMIT' || type === 'STOP' || type === 'TAKE_PROFIT') && !p.has('timeInForce')) return 'timeInForce'
      return undefined
    }
    case 'POST /fapi/v1/algoOrder': {
      const m = missing('algoType', 'symbol', 'side', 'type', 'quantity')
      if (m !== undefined) return m
      if (p.get('algoType') !== 'CONDITIONAL') return 'algoType'
      if (p.get('type') === 'TRAILING_STOP_MARKET') {
        if (!p.has('callbackRate')) return 'callbackRate'
      } else if (!p.has('triggerPrice')) return 'triggerPrice'
      if (!p.has('workingType')) return 'workingType'
      return undefined
    }
    case 'DELETE /fapi/v1/order':
      return missing('symbol') ?? (oneOf('orderId', 'origClientOrderId') ? undefined : 'orderId')
    case 'PUT /fapi/v1/order':
      return missing('symbol', 'side', 'quantity', 'price') ?? (oneOf('orderId', 'origClientOrderId') ? undefined : 'orderId')
    case 'GET /fapi/v1/order':
      return missing('symbol') ?? (oneOf('orderId', 'origClientOrderId') ? undefined : 'orderId')
    case 'DELETE /fapi/v1/algoOrder':
    case 'GET /fapi/v1/algoOrder':
      return oneOf('algoId', 'clientAlgoId') ? undefined : 'algoId'
    case 'DELETE /fapi/v1/allOpenOrders':
    case 'DELETE /fapi/v1/algoOpenOrders':
      return missing('symbol')
    case 'GET /fapi/v1/userTrades':
      return missing('symbol')
    case 'POST /fapi/v1/leverage':
      return missing('symbol', 'leverage')
    case 'POST /fapi/v1/marginType':
      return missing('symbol', 'marginType')
    default:
      return undefined
  }
}

export class FakeBinanceTrade {
  calls: Call[] = []
  usedWeightHeader: string | null = '12'
  symbols: unknown[] = [
    symbolEntry(),
    symbolEntry({ symbol: 'ETHUSDT', baseAsset: 'ETH' }),
    symbolEntry({ symbol: 'OLDUSDT', status: 'CLOSE' }),
    symbolEntry({ symbol: 'BTCUSDT_240628', contractType: 'CURRENT_QUARTER' }),
  ]
  bookTicker: unknown = { symbol: 'BTCUSDT', bidPrice: '100.1', askPrice: '100.2', bidQty: '1', askQty: '2', time: NOW }
  depth: unknown = {
    lastUpdateId: 1,
    T: NOW,
    bids: [['100.0', '1.5'], ['99.9', '2.5']],
    asks: [['100.2', '0.5'], ['100.1', '1.5']],
  }
  klineRows: unknown = klines(NOW - 3 * STEP_MS, 3)
  premiumIndex: unknown = {
    symbol: 'BTCUSDT', markPrice: '100.05', indexPrice: '100.00', lastFundingRate: '0.00010000',
    nextFundingTime: NOW + 28_800_000, time: NOW,
  }
  account: unknown = {
    totalWalletBalance: '1000.00000000',
    totalUnrealizedProfit: '2.50000000',
    totalMarginBalance: '1002.50000000',
    totalInitialMargin: '100.00000000',
    totalMaintMargin: '10.00000000',
    availableBalance: '900.00000000',
    assets: [
      { asset: 'USDT', walletBalance: '1000.00000000', availableBalance: '900.00000000', unrealizedProfit: '2.5', marginBalance: '1002.5' },
      { asset: 'BNB', walletBalance: '0.00000000', availableBalance: '0.00000000' },
    ],
  }
  /** /fapi/v2/positionRisk 真实形状（字段名照官方）：一多一空，各自 marginType / notional / uPnL。 */
  positionRisk: unknown = [
    {
      symbol: 'BTCUSDT', positionSide: 'BOTH', positionAmt: '0.010', entryPrice: '99000', markPrice: '100000',
      unRealizedProfit: '10', liquidationPrice: '0', leverage: '10', marginType: 'cross', isolated: false,
      notional: '1000', updateTime: NOW - 2_000,
    },
    {
      symbol: 'ETHUSDT', positionSide: 'BOTH', positionAmt: '-2.500', entryPrice: '3100', markPrice: '3000',
      unRealizedProfit: '250', liquidationPrice: '3900', leverage: '20', marginType: 'isolated', isolated: true,
      notional: '-7500', updateTime: NOW - 3_000,
    },
    {
      symbol: 'BNBUSDT', positionSide: 'BOTH', positionAmt: '0', entryPrice: '0', markPrice: '600',
      unRealizedProfit: '0', leverage: '5', marginType: 'cross', isolated: false, notional: '0', updateTime: NOW - 4_000,
    },
  ]
  userTrades: unknown = [
    { symbol: 'BTCUSDT', id: 11, orderId: 1001, side: 'BUY', price: '100.1', qty: '0.005', quoteQty: '0.5005', realizedPnl: '0', commission: '0.0002', commissionAsset: 'USDT', time: NOW - 500, positionSide: 'BOTH', maker: false },
    { symbol: 'BTCUSDT', id: 12, orderId: 1001, side: 'BUY', price: '100.2', qty: '0.005', quoteQty: '0.501', realizedPnl: '0', commission: '0.0002', commissionAsset: 'USDT', time: NOW - 400, positionSide: 'BOTH', maker: true },
  ]
  openOrders: unknown = [
    { symbol: 'BTCUSDT', orderId: 2001, clientOrderId: 'gt-open-1', side: 'BUY', type: 'LIMIT', status: 'NEW', price: '99000', stopPrice: '0', origQty: '0.010', executedQty: '0.004', reduceOnly: false, time: NOW - 10_000 },
    { symbol: 'ETHUSDT', orderId: 2002, clientOrderId: 'gt-open-2', side: 'SELL', type: 'STOP_MARKET', status: 'NEW', price: '0', stopPrice: '2800', origQty: '0.500', executedQty: '0', reduceOnly: true, time: NOW - 9_000 },
  ]
  /** /fapi/v1/openAlgoOrders 夹具（缺省空，需要时由用例塞入）。 */
  openAlgoOrders: unknown = []
  orderQuery: unknown = { symbol: 'BTCUSDT', orderId: 1001, clientOrderId: 'gt-query', status: 'PARTIALLY_FILLED', executedQty: '0.003', avgPrice: '100.15', type: 'LIMIT', time: NOW - 1_000 }
  algoOrderQuery: unknown = {
    symbol: 'BTCUSDT', algoId: 3001, clientAlgoId: 'gt-algo-1', algoStatus: 'TRIGGERED', orderType: 'STOP_MARKET',
    quantity: '0.010', executedQty: '0', triggerPrice: '90000', price: '0', workingType: 'MARK_PRICE', createTime: NOW - 1_000,
  }
  orderResponse: (params: URLSearchParams) => unknown = (params) => ({
    orderId: 1001,
    clientOrderId: params.get('newClientOrderId') ?? 'gt-server',
    status: 'NEW',
    executedQty: '0',
    avgPrice: '0',
    type: params.get('type') ?? 'LIMIT',
    updateTime: NOW,
  })
  algoOrderResponse: (params: URLSearchParams) => unknown = (params) => ({
    algoId: 3001,
    clientAlgoId: params.get('clientAlgoId') ?? 'gt-algo-server',
    algoType: 'CONDITIONAL',
    orderType: params.get('type') ?? 'STOP_MARKET',
    symbol: params.get('symbol') ?? 'BTCUSDT',
    side: params.get('side') ?? 'BUY',
    positionSide: params.get('positionSide') ?? 'BOTH',
    quantity: params.get('quantity') ?? '0',
    algoStatus: 'NEW',
    triggerPrice: params.get('triggerPrice') ?? '0',
    price: params.get('price') ?? '0',
    workingType: params.get('workingType') ?? 'MARK_PRICE',
    createTime: NOW,
    updateTime: NOW,
  })
  amendResponse: (params: URLSearchParams) => unknown = (params) => ({
    orderId: Number(params.get('orderId') ?? 1001),
    clientOrderId: params.get('origClientOrderId') ?? 'gt-amended',
    price: params.get('price') ?? '0',
    qty: params.get('quantity') ?? '0',
    status: 'NEW',
  })
  listenKey = 'listen-key-for-tests'
  /** `${METHOD} ${path}` 或 `path` → 强制响应。 */
  failWith = new Map<string, () => Response>()
  /** 同上，但只生效一次（-1021 重试这类用例）。 */
  failOnce = new Map<string, () => Response>()

  readonly fetch: typeof fetch = async (input, init) => {
    const raw = String(input)
    const url = new URL(raw)
    const method = (init?.method ?? 'GET').toUpperCase()
    const original = new URLSearchParams(url.searchParams)
    const signature = url.searchParams.get('signature')
    const params = new URLSearchParams(url.searchParams)
    params.delete('signature')
    const headers = (init?.headers ?? {}) as Record<string, string>
    const apiKeyHeader = headers['X-MBX-APIKEY'] ?? null
    this.calls.push({ method, path: url.pathname, url: raw, params, apiKey: apiKeyHeader, signature })

    const key = `${method} ${url.pathname}`
    const forced = this.failWith.get(key) ?? this.failWith.get(url.pathname)
    if (forced) return forced()
    const once = this.failOnce.get(key) ?? this.failOnce.get(url.pathname)
    if (once) {
      this.failOnce.delete(key)
      this.failOnce.delete(url.pathname)
      return once()
    }

    const withWeight = (o: unknown, status = 200): Response => {
      const outHeaders: Record<string, string> = {}
      if (this.usedWeightHeader !== null) outHeaders['x-mbx-used-weight-1m'] = this.usedWeightHeader
      return json(o, status, outHeaders)
    }

    // 签名校验：用同一个 secret 复算 query（参数顺序即发出去的顺序）。
    if (SIGNED_PATHS.has(url.pathname)) {
      if (signature === null) return withWeight({ code: -1102, msg: "Mandatory parameter 'signature' was not sent." }, 400)
      const canonical = new URLSearchParams([...original.entries()].filter(([k]) => k !== 'signature')).toString()
      if (signatureOf(API_SECRET, canonical) !== signature) {
        return withWeight({ code: -1022, msg: 'Signature for this request is not valid.' }, 401)
      }
    }
    if (API_KEY_ONLY_PATHS.has(url.pathname) && apiKeyHeader === null) {
      return withWeight({ code: -1002, msg: 'API key is not provided.' }, 401)
    }
    const missing = missingParam(key, params)
    if (missing !== undefined) {
      return withWeight({ code: -1102, msg: `Mandatory parameter '${missing}' was not sent, was empty/null, or malformed.` }, 400)
    }

    switch (key) {
      case 'GET /fapi/v1/time': return withWeight({ serverTime: NOW })
      case 'GET /fapi/v1/exchangeInfo': return withWeight({ symbols: this.symbols })
      case 'GET /fapi/v1/ticker/bookTicker': return withWeight(params.has('symbol') ? this.bookTicker : [this.bookTicker])
      case 'GET /fapi/v1/depth': return withWeight(this.depth)
      case 'GET /fapi/v1/klines': return withWeight(this.klineRows)
      case 'GET /fapi/v1/premiumIndex': return withWeight(this.premiumIndex)
      case 'GET /fapi/v2/account': return withWeight(this.account)
      case 'GET /fapi/v2/positionRisk': return withWeight(this.positionRisk)
      case 'GET /fapi/v1/userTrades': return withWeight(filterBySymbol(this.userTrades, params))
      case 'GET /fapi/v1/openOrders': return withWeight(filterBySymbol(this.openOrders, params))
      case 'GET /fapi/v1/openAlgoOrders': return withWeight(filterBySymbol(this.openAlgoOrders, params))
      case 'GET /fapi/v1/order': return withWeight(this.orderQuery)
      case 'GET /fapi/v1/algoOrder': return withWeight(this.algoOrderQuery)
      case 'POST /fapi/v1/order': return withWeight(this.orderResponse(params))
      case 'POST /fapi/v1/algoOrder': return withWeight(this.algoOrderResponse(params))
      case 'PUT /fapi/v1/order': return withWeight(this.amendResponse(params))
      case 'DELETE /fapi/v1/order': return withWeight({ orderId: Number(params.get('orderId') ?? 0), status: 'CANCELED', clientOrderId: params.get('origClientOrderId') ?? '' })
      case 'DELETE /fapi/v1/algoOrder': return withWeight({ algoId: Number(params.get('algoId') ?? 0), clientAlgoId: params.get('clientAlgoId') ?? '', algoStatus: 'CANCELED' })
      case 'DELETE /fapi/v1/allOpenOrders': return withWeight({ code: 200, msg: 'The operation of cancel all open order is done.' })
      case 'DELETE /fapi/v1/algoOpenOrders': return withWeight({ code: 200, msg: 'The operation of cancel all algo open order is done.' })
      case 'POST /fapi/v1/leverage': return withWeight({ symbol: params.get('symbol'), leverage: Number(params.get('leverage') ?? 0), maxNotionalValue: '1000000' })
      case 'POST /fapi/v1/marginType': return withWeight({ code: 200, msg: 'success' })
      case 'POST /fapi/v1/listenKey': return withWeight({ listenKey: this.listenKey })
      case 'PUT /fapi/v1/listenKey': return withWeight({})
      case 'DELETE /fapi/v1/listenKey': return withWeight({})
      default: return withWeight({ code: -1102, msg: `unhandled ${key}` }, 404)
    }
  }

  callsTo(path: string): Call[] {
    return this.calls.filter((c) => c.path === path)
  }

  callsFor(method: string, path: string): Call[] {
    return this.calls.filter((c) => c.method === method && c.path === path)
  }

  last(): Call | undefined {
    return this.calls[this.calls.length - 1]
  }

  /** 强制某个端点返回上游错误（body 原样）。 */
  fail(method: string, path: string, body: unknown, status = 400, headers: Record<string, string> = {}): void {
    this.failWith.set(`${method} ${path}`, () => json(body, status, headers))
  }

  /** 只错一次（用于 -1021 重试、一次超时这类场景）。 */
  failNext(method: string, path: string, body: unknown, status = 400, headers: Record<string, string> = {}): void {
    this.failOnce.set(`${method} ${path}`, () => json(body, status, headers))
  }

  reset(): void {
    this.calls = []
    this.failWith.clear()
    this.failOnce.clear()
    this.usedWeightHeader = '12'
  }
}

/** 按 symbol 过滤夹具（没给 symbol 就返回全部）。 */
function filterBySymbol(rows: unknown, params: URLSearchParams): unknown {
  if (!Array.isArray(rows)) return rows
  const symbol = params.get('symbol')
  if (symbol === null) return rows
  return rows.filter((row) => {
    if (!row || typeof row !== 'object') return false
    const s = (row as { symbol?: unknown }).symbol
    return typeof s === 'string' && s === symbol
  })
}
