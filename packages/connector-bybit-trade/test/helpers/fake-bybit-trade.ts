// SPDX-License-Identifier: CPAL-1.0
// 离线假 Bybit v5 服务：进程内按 路径 + 方法 回答 { retCode, retMsg, result, time } 信封，不开端口、不联网、不读夹具文件。
// 形状照 packages/connector-bybit-data/test/helpers/fake-bybit.ts（CPAL-1.0）扩出私有签名端点。
// 三条硬要求（工单教训 2 / 8）：
//   1) **复算签名**：prehash = timestamp + apiKey + recvWindow + (GET 排序后的 query | POST body 原文)，
//      HMAC-SHA256 hex 与 X-BAPI-SIGN 不一致 → retCode 10004（error sign）；缺 api key → 10003。
//   2) **校验 HTTP 方法**：撤单 / 全撤 / 改单只认 POST；用 DELETE 打过来 → HTTP 404（真实场所也是 404）。
//   3) **校验必填参数**：缺参回 Bybit 的真实码 10001（params error），订单不存在回 110001。
import { createHmac } from 'node:crypto'

export const API_KEY = 'test-api-key-not-real'
export const API_SECRET = 'test-secret-not-a-real-key'
export const BASE_URL = 'http://bybit.example.test'
export const NOW = 1_792_510_147_359
export const RECV_WINDOW = 5_000
export const STEP_MS = 60_000

/** 一条线性永续（真网字段，未列出的字段本连接器不读）。 */
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
    leverageFilter: { maxLeverage: '100' },
    ...over,
  }
}

export function envelope(result: unknown, retCode = 0, retMsg = 'OK'): Response {
  return new Response(JSON.stringify({ retCode, retMsg, result, time: NOW }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

export interface Call {
  method: string
  path: string
  url: string
  /** GET / DELETE 的查询参数（已排序编码后的原文也在 query 里）。 */
  params: URLSearchParams
  /** 原始 query string（签名用的就是它）。 */
  query: string
  /** POST 的 body 原文（签名用的就是它）。 */
  bodyText: string | null
  body: unknown
  apiKey: string | null
  sign: string | null
  timestamp: string | null
  recvWindow: string | null
  signType: string | null
}

/** 签名端点需要一个（且只需要一个）id 的路径：req: real code 110001 when neither is given. */
const SIGNED_PATHS = new Set([
  '/v5/account/wallet-balance', '/v5/position/list', '/v5/execution/list', '/v5/order/realtime',
  '/v5/order/history', '/v5/order/create', '/v5/order/amend', '/v5/order/cancel', '/v5/order/cancel-all',
  '/v5/position/set-leverage', '/v5/account/set-margin-mode', '/v5/position/trading-stop',
])
const PUBLIC_PATHS = new Set(['/v5/market/time', '/v5/market/instruments-info', '/v5/market/tickers', '/v5/market/orderbook'])

/** 每个私有端点允许的方法（教训 2：撤单 / 全撤 / 改单是 POST）。 */
const METHODS: Record<string, string> = {
  '/v5/account/wallet-balance': 'GET',
  '/v5/position/list': 'GET',
  '/v5/execution/list': 'GET',
  '/v5/order/realtime': 'GET',
  '/v5/order/history': 'GET',
  '/v5/order/create': 'POST',
  '/v5/order/amend': 'POST',
  '/v5/order/cancel': 'POST',
  '/v5/order/cancel-all': 'POST',
  '/v5/position/set-leverage': 'POST',
  '/v5/account/set-margin-mode': 'POST',
  '/v5/position/trading-stop': 'POST',
}

/** 必填参数校验（缺参 → 10001 params error，Bybit 的真实码）。 */
function missingParam(path: string, p: Record<string, unknown>): string | undefined {
  const has = (name: string): boolean => p[name] !== undefined && p[name] !== null && String(p[name]) !== ''
  const oneOf = (...names: string[]): boolean => names.some(has)
  switch (path) {
    case '/v5/order/create': {
      for (const name of ['category', 'symbol', 'side', 'orderType', 'qty']) if (!has(name)) return name
      if (String(p.orderType) === 'Limit' && !has('price')) return 'price'
      if (has('triggerPrice') && !has('triggerDirection')) return 'triggerDirection'
      return undefined
    }
    case '/v5/order/amend':
      for (const name of ['category', 'symbol']) if (!has(name)) return name
      if (!oneOf('orderId', 'orderLinkId')) return 'orderId'
      if (!oneOf('qty', 'price', 'triggerPrice')) return 'price'
      return undefined
    case '/v5/order/cancel':
      for (const name of ['category', 'symbol']) if (!has(name)) return name
      return oneOf('orderId', 'orderLinkId') ? undefined : 'orderId'
    case '/v5/order/cancel-all':
      if (!has('category')) return 'category'
      return oneOf('symbol', 'settleCoin') ? undefined : 'symbol'
    case '/v5/order/realtime':
    case '/v5/order/history':
      if (!has('category')) return 'category'
      return oneOf('symbol', 'settleCoin', 'orderId', 'orderLinkId') ? undefined : 'symbol'
    case '/v5/position/list':
      if (!has('category')) return 'category'
      return oneOf('symbol', 'settleCoin') ? undefined : 'symbol'
    case '/v5/execution/list':
      if (!has('category')) return 'category'
      return oneOf('symbol', 'settleCoin') ? undefined : 'symbol'
    case '/v5/position/set-leverage':
      for (const name of ['category', 'symbol', 'buyLeverage', 'sellLeverage']) if (!has(name)) return name
      return undefined
    case '/v5/account/set-margin-mode':
      return has('setMarginMode') ? undefined : 'setMarginMode'
    case '/v5/position/trading-stop':
      for (const name of ['category', 'symbol', 'tpslMode', 'positionIdx']) if (!has(name)) return name
      return oneOf('takeProfit', 'stopLoss', 'trailingStop') ? undefined : 'stopLoss'
    case '/v5/account/wallet-balance':
      return has('accountType') ? undefined : 'accountType'
    default:
      return undefined
  }
}

export class FakeBybitTrade {
  calls: Call[] = []
  /** 合约清单分页；缺省一页。 */
  instrumentPages: Array<{ list: unknown[]; nextPageCursor: string }> = [
    {
      list: [
        perpEntry(),
        perpEntry({
          symbol: 'ETHUSDT', baseCoin: 'ETH', quoteCoin: 'USDT',
          priceFilter: { tickSize: '0.01' }, lotSizeFilter: { qtyStep: '0.01', minOrderQty: '0.01', minNotionalValue: '5' },
        }),
        perpEntry({ symbol: 'HALTUSDT', baseCoin: 'HALT', status: 'PreLaunch' }),
      ],
      nextPageCursor: '',
    },
  ]
  tickers: Record<string, unknown> = {
    BTCUSDT: {
      symbol: 'BTCUSDT', lastPrice: '82429.10', indexPrice: '82478.82', markPrice: '82440.94',
      openInterest: '58828.846', fundingRate: '0.00004899', nextFundingTime: '1792512000000',
      ask1Price: '82428.60', bid1Price: '82428.50', ask1Size: '4.978', bid1Size: '3.552',
    },
    ETHUSDT: {
      symbol: 'ETHUSDT', lastPrice: '2429.28', markPrice: '2429.29', indexPrice: '2430.63',
      ask1Price: '2429.30', bid1Price: '2429.26', ask1Size: '46.35', bid1Size: '16.19',
    },
  }
  books: Record<string, unknown> = {
    BTCUSDT: { s: 'BTCUSDT', a: [['82428.60', '4.978']], b: [['82428.50', '3.688']], ts: NOW, u: 3178309 },
  }
  /** wallet-balance 的 result.list[0]（真网字段形状：统一账户）。 */
  wallet: unknown = {
    accountType: 'UNIFIED',
    totalEquity: '1002.5',
    totalWalletBalance: '1000',
    totalMarginBalance: '1002.5',
    totalInitialMargin: '100',
    totalMaintenanceMargin: '10',
    totalAvailableBalance: '900',
    totalPerpUpl: '2.5',
    coin: [
      { coin: 'USDT', equity: '1002.5', usdValue: '1002.5', walletBalance: '1000', availableToWithdraw: '890', locked: '10' },
      { coin: 'BTC', equity: '0', usdValue: '0', walletBalance: '0', availableToWithdraw: '0' },
    ],
  }
  /** position/list 的 result（真网字段形状；size=0 的槽位也会出现）。 */
  positions: unknown = {
    category: 'linear',
    list: [
      {
        symbol: 'BTCUSDT', side: 'Buy', size: '0.01', avgPrice: '99000', markPrice: '100000', liqPrice: '0',
        leverage: '10', positionValue: '1000', unrealisedPnl: '10', cumRealisedPnl: '-1.2', positionIdx: 0,
        tradeMode: 0, createdTime: String(NOW - 60_000), updatedTime: String(NOW - 2_000),
      },
      {
        symbol: 'ETHUSDT', side: 'Sell', size: '2.5', avgPrice: '3100', markPrice: '3000', liqPrice: '3900',
        leverage: '20', positionValue: '7500', unrealisedPnl: '250', cumRealisedPnl: '0', positionIdx: 2,
        tradeMode: 1, createdTime: String(NOW - 120_000), updatedTime: String(NOW - 3_000),
      },
      {
        symbol: 'SOLUSDT', side: '', size: '0', avgPrice: '0', markPrice: '150', liqPrice: '0',
        leverage: '5', positionValue: '0', unrealisedPnl: '0', cumRealisedPnl: '0', positionIdx: 0,
        tradeMode: 0, createdTime: '0', updatedTime: '0',
      },
    ],
  }
  /** execution/list 第一页（含 Funding 行与平仓行）。 */
  executions: Array<unknown> = [
    {
      execId: 'exec-1', orderId: 'ord-1001', orderLinkId: 'gt-buy-1', symbol: 'BTCUSDT', side: 'Buy',
      execPrice: '100.1', execQty: '0.006', execFee: '0.0002', feeCurrency: 'USDT', execType: 'Trade',
      execPnl: '0', execTime: String(NOW - 500), isMaker: false, closedSize: '0', leavesQty: '0.004',
    },
    {
      execId: 'exec-2', orderId: 'ord-1001', orderLinkId: 'gt-buy-1', symbol: 'BTCUSDT', side: 'Buy',
      execPrice: '100.2', execQty: '0.004', execFee: '0.0001', feeCurrency: 'USDT', execType: 'Trade',
      execPnl: '0', execTime: String(NOW - 400), isMaker: true, closedSize: '0', leavesQty: '0',
    },
    // 平仓行：closedSize = 0.01、leavesQty = 0（仓位归零），必须保留
    {
      execId: 'exec-3', orderId: 'ord-1002', orderLinkId: 'gt-close-1', symbol: 'BTCUSDT', side: 'Sell',
      execPrice: '101', execQty: '0.01', execFee: '0.0003', feeCurrency: 'USDT', execType: 'Trade',
      execPnl: '0.012', execTime: String(NOW - 300), isMaker: false, closedSize: '0.01', leavesQty: '0',
    },
    // 资金费：execType = Funding，不是成交
    {
      execId: 'exec-funding-1', orderId: '', orderLinkId: '', symbol: 'BTCUSDT', side: 'Sell',
      execPrice: '', execQty: '', execFee: '', feeCurrency: 'USDT', execType: 'Funding',
      execPnl: '-0.01', execTime: String(NOW - 200), isMaker: false, closedSize: '', leavesQty: '',
    },
  ]
  /** order/realtime 的 result.list（挂单）。 */
  openOrders: unknown = [
    {
      orderId: 'ord-2001', orderLinkId: 'gt-open-1', symbol: 'BTCUSDT', side: 'Buy', orderType: 'Limit',
      orderStatus: 'New', price: '99000', qty: '0.01', cumExecQty: '0.004', avgPrice: '99000',
      timeInForce: 'GTC', reduceOnly: false, triggerPrice: '', triggerDirection: 0, orderFilter: 'Order',
      positionIdx: 0, createdTime: String(NOW - 10_000), updatedTime: String(NOW - 9_000),
    },
    {
      orderId: 'ord-2002', orderLinkId: 'gt-open-2', symbol: 'ETHUSDT', side: 'Sell', orderType: 'Market',
      orderStatus: 'Untriggered', price: '', qty: '0.5', cumExecQty: '0', avgPrice: '',
      triggerPrice: '2800', triggerDirection: 2, orderFilter: 'StopOrder', reduceOnly: true, closeOnTrigger: true,
      positionIdx: 0, createdTime: String(NOW - 8_000), updatedTime: String(NOW - 7_000),
    },
  ]
  /** order/realtime 单查；history 缺省空（用 historyOrders 单独塞）。 */
  realtimeOrders: unknown[] = [
    {
      orderId: 'ord-1001', orderLinkId: 'gt-query', symbol: 'BTCUSDT', side: 'Buy', orderType: 'Limit',
      orderStatus: 'PartiallyFilled', price: '100', qty: '0.01', cumExecQty: '0.006', avgPrice: '100.15',
      createdTime: String(NOW - 1_000), updatedTime: String(NOW - 900),
    },
  ]
  historyOrders: unknown[] = []
  /** create 响应（bybit 只回 orderId / orderLinkId）。 */
  createResponse = (body: Record<string, unknown>): unknown => ({
    orderId: `ord-${String(body.orderLinkId ?? 'x').slice(-6)}`,
    orderLinkId: body.orderLinkId ?? '',
  })
  amendResponse = (body: Record<string, unknown>): unknown => ({
    orderId: body.orderId ?? 'ord-1001',
    orderLinkId: body.orderLinkId ?? '',
    ...(body.qty !== undefined ? { qty: body.qty } : {}),
    ...(body.price !== undefined ? { price: body.price } : {}),
  })
  /** 每个端点的人为失败：`METHOD path` 或 path → Response。 */
  failWith = new Map<string, (call: Call) => Response>()
  /** 同上，只生效一次（10002 重试这类用例）。 */
  failOnce = new Map<string, (call: Call) => Response>()
  /** retCode 覆盖（按 path）：例如 set-leverage 回 110043。 */
  retCodeOverride = new Map<string, { retCode: number; retMsg: string }>()
  /** 强制 HTTP 状态（例如 429 / 500）。 */
  httpStatusOverride = new Map<string, { status: number; headers?: Record<string, string>; body?: string }>()
  /** execution/list 的第二页（游标翻页用例）。 */
  executionPages: Array<{ list: unknown[]; nextPageCursor: string }> | null = null
  /** 列表端点（挂单 / 持仓）的人为页大小；null = 只按请求的 limit。 */
  pageSize: number | null = null
  /** cancel-all 的 result；null 时回 `{ list: [], success: '1' }`。 */
  cancelAllResult: unknown = null
  /** 是否校验签名（默认 true；只有「故意发坏签名」的用例需要它继续校验）。 */
  verifySignatures = true

  readonly fetch: typeof fetch = async (input, init) => {
    const raw = String(input)
    const url = new URL(raw)
    const method = (init?.method ?? 'GET').toUpperCase()
    const headers = (init?.headers ?? {}) as Record<string, string>
    const query = url.search.slice(1)
    const bodyText = typeof init?.body === 'string' ? init.body : null
    let body: unknown = undefined
    if (bodyText !== null) {
      try {
        body = JSON.parse(bodyText)
      } catch {
        body = undefined
      }
    }
    const call: Call = {
      method,
      path: url.pathname,
      url: raw,
      params: new URLSearchParams(url.search),
      query,
      bodyText,
      body,
      apiKey: headers['X-BAPI-API-KEY'] ?? null,
      sign: headers['X-BAPI-SIGN'] ?? null,
      timestamp: headers['X-BAPI-TIMESTAMP'] ?? null,
      recvWindow: headers['X-BAPI-RECV-WINDOW'] ?? null,
      signType: headers['X-BAPI-SIGN-TYPE'] ?? null,
    }
    this.calls.push(call)

    const key = `${method} ${url.pathname}`
    const forced = this.failWith.get(key) ?? this.failWith.get(url.pathname)
    if (forced) return forced(call)
    const once = this.failOnce.get(key) ?? this.failOnce.get(url.pathname)
    if (once) {
      this.failOnce.delete(key)
      this.failOnce.delete(url.pathname)
      return once(call)
    }
    const status = this.httpStatusOverride.get(url.pathname)
    if (status) {
      return new Response(status.body ?? 'upstream error', { status: status.status, headers: status.headers ?? {} })
    }

    // ---- 公共端点（不带密钥）----
    if (PUBLIC_PATHS.has(url.pathname)) {
      if (call.apiKey !== null) return envelope(null, 10003, 'api key must not be sent to public endpoints')
      switch (url.pathname) {
        case '/v5/market/time':
          return envelope({ timeSecond: String(Math.floor(NOW / 1000)), timeNano: `${NOW}000000` })
        case '/v5/market/instruments-info': {
          const cursor = url.searchParams.get('cursor')
          const index = cursor === null ? 0 : Math.max(0, Number(cursor.replace(/^page-/, '')) - 1)
          const page = this.instrumentPages[index] ?? { list: [], nextPageCursor: '' }
          return envelope({ category: 'linear', list: page.list, nextPageCursor: page.nextPageCursor })
        }
        case '/v5/market/tickers': {
          const symbol = url.searchParams.get('symbol') ?? 'BTCUSDT'
          return envelope({ category: 'linear', list: [this.tickers[symbol] ?? this.tickers.BTCUSDT] })
        }
        case '/v5/market/orderbook':
          return envelope(this.books[url.searchParams.get('symbol') ?? 'BTCUSDT'] ?? this.books.BTCUSDT)
        default:
          return envelope(null, 10001, 'unknown public endpoint')
      }
    }

    if (!SIGNED_PATHS.has(url.pathname)) {
      return new Response(JSON.stringify({ retCode: 10001, retMsg: `unhandled ${key}` }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      })
    }

    // ---- 方法校验（教训 2）----
    const expected = METHODS[url.pathname]
    if (expected !== undefined && method !== expected) {
      return new Response(JSON.stringify({ retCode: 10001, retMsg: `${url.pathname} is ${expected}, got ${method}` }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      })
    }

    // ---- 签名校验（教训 8）----
    if (this.verifySignatures) {
      if (call.apiKey === null || call.apiKey === '') return envelope(null, 10003, 'API key is invalid')
      if (call.apiKey !== API_KEY) return envelope(null, 10003, 'API key is invalid')
      if (call.sign === null || call.timestamp === null || call.recvWindow === null || call.timestamp === '') {
        return envelope(null, 10001, 'missing signature headers')
      }
      const payload = method === 'GET' ? call.query : (bodyText ?? '')
      const prehash = `${call.timestamp}${call.apiKey}${call.recvWindow}${payload}`
      const expectedSign = createHmac('sha256', API_SECRET).update(prehash).digest('hex')
      if (expectedSign !== call.sign) return envelope(null, 10004, 'error sign')
    }

    // ---- 必填参数（缺参 → 10001）----
    const params = method === 'GET' ? Object.fromEntries(url.searchParams.entries()) : ((body ?? {}) as Record<string, unknown>)
    const missing = missingParam(url.pathname, params)
    if (missing !== undefined) return envelope(null, 10001, `params ${missing} is invalid`)

    const override = this.retCodeOverride.get(url.pathname)
    if (override) return envelope(null, override.retCode, override.retMsg)

    switch (url.pathname) {
      case '/v5/account/wallet-balance': return envelope({ category: 'linear', list: [this.wallet] })
      case '/v5/position/list': return envelope(this.filterPositions(url.searchParams.get('symbol'), url.searchParams))
      case '/v5/execution/list': {
        const startTime = url.searchParams.get('startTime')
        const endTime = url.searchParams.get('endTime')
        if (startTime !== null && endTime !== null) {
          const start = Number(startTime)
          const end = Number(endTime)
          if (Number.isFinite(start) && Number.isFinite(end) && end - start > 7 * 86_400_000) {
            return envelope(null, 10001, 'startTime and endTime span more than 7 days')
          }
        }
        return envelope(this.executionPage(url.searchParams))
      }
      case '/v5/order/realtime': {
        const page = this.realtimeFor(url.searchParams)
        return envelope({ category: 'linear', list: page.list, nextPageCursor: page.nextPageCursor })
      }
      case '/v5/order/history': return envelope({ category: 'linear', list: this.historyFor(url.searchParams) })
      case '/v5/order/create': return envelope(this.createResponse((body ?? {}) as Record<string, unknown>))
      case '/v5/order/amend': return envelope(this.amendResponse((body ?? {}) as Record<string, unknown>))
      case '/v5/order/cancel': return envelope({ orderId: String((body as Record<string, unknown>).orderId ?? ''), orderLinkId: String((body as Record<string, unknown>).orderLinkId ?? '') })
      case '/v5/order/cancel-all': return envelope(this.cancelAllResult ?? { list: [], success: '1' })
      case '/v5/position/set-leverage': return envelope({});
      case '/v5/account/set-margin-mode': return envelope({});
      case '/v5/position/trading-stop': return envelope({});
      default: return envelope(null, 10001, `unhandled ${key}`)
    }
  }

  // ---- 选择性回答 ----

  private filterPositions(symbol: string | null, params: URLSearchParams): unknown {
    const page = this.positions as { list?: Array<{ symbol?: string }> }
    const all = page.list ?? []
    const rows = symbol === null ? all : all.filter((row) => row.symbol === symbol)
    return { ...(this.positions as object), ...this.paginate(rows, params) }
  }

  private executionPage(params: URLSearchParams): unknown {
    if (this.executionPages === null) {
      const symbol = params.get('symbol')
      const rows = symbol === null ? this.executions : this.executions.filter((row) => (row as { symbol?: string }).symbol === symbol)
      return { category: 'linear', list: rows.filter((row) => this.inWindow(row, params)), nextPageCursor: '' }
    }
    const cursor = params.get('cursor')
    const index = cursor === null ? 0 : Math.max(0, Number(cursor.replace(/^page-/, '')) - 1)
    const page = this.executionPages[index] ?? { list: [], nextPageCursor: '' }
    return { category: 'linear', list: page.list.filter((row) => this.inWindow(row, params)), nextPageCursor: page.nextPageCursor }
  }

  /** execution/list 只回 execTime 落在 [startTime, endTime] 内的行。 */
  private inWindow(row: unknown, params: URLSearchParams): boolean {
    const startTime = params.get('startTime')
    const endTime = params.get('endTime')
    if (startTime === null || endTime === null) return true
    const start = Number(startTime)
    const end = Number(endTime)
    const ts = Number((row as { execTime?: string | number }).execTime)
    if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(ts)) return true
    return ts >= start && ts <= end
  }

  /** 挂单 / 持仓列表分页：每页 = min(请求 limit（缺省 20）, pageSize)，cursor 是起始下标字符串。 */
  private paginate<T>(rows: T[], params: URLSearchParams): { list: T[]; nextPageCursor: string } {
    const requested = Number(params.get('limit'))
    const limit = Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : 20
    const size = this.pageSize === null ? limit : Math.min(limit, Math.max(1, Math.floor(this.pageSize)))
    const cursor = params.get('cursor')
    const start = cursor === null ? 0 : Math.max(0, Math.floor(Number(cursor) || 0))
    const list = rows.slice(start, start + size)
    const next = start + size < rows.length ? String(start + size) : ''
    return { list, nextPageCursor: next }
  }

  /** 单查（带 orderId / orderLinkId）走 realtimeOrders；不带 id 的「列挂单」走 openOrders（分页）。 */
  private realtimeFor(params: URLSearchParams): { list: unknown[]; nextPageCursor: string } {
    const hasId = params.has('orderId') || params.has('orderLinkId')
    const symbol = params.get('symbol')
    if (!hasId) {
      const rows = this.openOrders as Array<{ symbol?: string }>
      const filtered = symbol === null ? rows : rows.filter((row) => row.symbol === symbol)
      return this.paginate(filtered, params)
    }
    const id = params.get('orderId')
    const link = params.get('orderLinkId')
    const list = this.realtimeOrders.filter((row) => {
      const r = row as { orderId?: string; orderLinkId?: string; symbol?: string }
      if (symbol !== null && r.symbol !== symbol) return false
      return (id !== null && r.orderId === id) || (link !== null && r.orderLinkId === link)
    })
    return { list, nextPageCursor: '' }
  }

  private historyFor(params: URLSearchParams): unknown[] {
    const id = params.get('orderId')
    const link = params.get('orderLinkId')
    const symbol = params.get('symbol')
    if (!params.has('orderId') && !params.has('orderLinkId')) return this.historyOrders
    return this.historyOrders.filter((row) => {
      const r = row as { orderId?: string; orderLinkId?: string; symbol?: string }
      if (symbol !== null && r.symbol !== symbol) return false
      return (id !== null && r.orderId === id) || (link !== null && r.orderLinkId === link)
    })
  }

  callsFor(method: string, path: string): Call[] {
    return this.calls.filter((c) => c.method === method && c.path === path)
  }

  callsTo(path: string): Call[] {
    return this.calls.filter((c) => c.path === path)
  }

  last(): Call | undefined {
    return this.calls[this.calls.length - 1]
  }

  /** 强制某个端点返回上游错误（信封原样，HTTP 200）。 */
  fail(method: string, path: string, retCode: number, retMsg: string): void {
    this.failWith.set(`${method} ${path}`, () => envelope(null, retCode, retMsg))
  }

  /** 只错一次（用于 10002 重试、一次超时这类场景）。 */
  failNext(method: string, path: string, retCode: number, retMsg: string): void {
    this.failOnce.set(`${method} ${path}`, () => envelope(null, retCode, retMsg))
  }

  /** 超时 / 断网：返回一个 rejects 的 fetch。 */
  reset(): void {
    this.calls = []
    this.failWith.clear()
    this.failOnce.clear()
    this.retCodeOverride.clear()
    this.httpStatusOverride.clear()
    this.executionPages = null
    this.pageSize = null
    this.cancelAllResult = null
    this.verifySignatures = true
  }
}

/** 让 fetch 直接抛错（模拟断网 / 超时）。 */
export function throwingFetch(message = 'fetch failed: socket hang up'): typeof fetch {
  return async () => {
    throw new Error(message)
  }
}

/** 构造一个挂在 AbortSignal 上永不返回的 fetch（配合 httpTimeoutMs 测超时）。 */
export function hangingFetch(): typeof fetch {
  return (_input, init) => new Promise<Response>((_resolve, reject) => {
    const signal = (init as { signal?: AbortSignal } | undefined)?.signal
    if (signal) {
      signal.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), { once: true })
    }
  })
}
