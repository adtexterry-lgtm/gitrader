// SPDX-License-Identifier: CPAL-1.0
// 离线假 Alpaca 服务（Trading API v2 + 数据 API v2 的 snapshot）：进程内按「主机 + 方法 + 路径」回答，
// 不开端口、不联网、不读夹具文件。形状照 packages/connector-bitget-trade/test/helpers/fake-bitget.ts（CPAL-1.0）改成 Alpaca 口径：
//   · **校验鉴权头**：`APCA-API-KEY-ID` / `APCA-API-SECRET-KEY` 必须同时出现且等于配置值（不是 HMAC，不验签名）；
//   · **校验方法**：已知路径用错方法回 405（教训 2：全撤被写成 POST 这类错必须在这里炸出来）；
//   · **校验必填参数**：缺参回 422 + `{code:42210000}`（Alpaca 的真实形态），
//     并复算场所规则：小数股必须 time_in_force=day、扩展时段只收 limit、bracket 要两条腿、oto 只收一条；
//   · 207 多状态（全撤）与 204（撤单）都按官方形状回。
export const API_KEY = 'PKTESTKEY0000000000'
export const API_SECRET = 'test-alpaca-secret-not-real'
export const LIVE_API_KEY = 'AKTESTKEY0000000000'
export const BASE_URL = 'http://alpaca.example.test'
export const DATA_URL = 'http://data.alpaca.example.test'
/** 2026-10-21T14:00:00Z = 10:00 ET（常规时段内）。 */
export const NOW = 1_792_591_200_000

export const json = (o: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json', ...headers } })

export interface Call {
  method: string
  host: string
  path: string
  query: string
  body: string
  headers: Record<string, string>
  params: URLSearchParams
  url: string
}

/** 一条可交易的美股（fractionable / shortable / borrow_status 都可配）；形状照官方现行 asset schema（旧字段 2026-09-22 已移除）。 */
export function assetRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'asset-aapl',
    class: 'us_equity',
    exchange: 'NASDAQ',
    symbol: 'AAPL',
    name: 'Apple Inc. Common Stock',
    status: 'active',
    tradable: true,
    marginable: true,
    shortable: true,
    borrow_status: 'easy_to_borrow',
    fractionable: true,
    margin_requirement_long: '30',
    margin_requirement_short: '30',
    price_increment: '0.01',
    min_trade_increment: '0.0001',
    min_order_size: '0.0001',
    ...over,
  }
}

/** 交易日历：10-19 ~ 10-23（10-22 提前收盘 13:00），10-26 下一个周一。 */
export function calendarRows(): Array<Record<string, string>> {
  return [
    { date: '2026-10-19', open: '09:30', close: '16:00', settlement_date: '2026-10-20' },
    { date: '2026-10-20', open: '09:30', close: '16:00', settlement_date: '2026-10-21' },
    { date: '2026-10-21', open: '09:30', close: '16:00', settlement_date: '2026-10-22' },
    { date: '2026-10-22', open: '09:30', close: '13:00', settlement_date: '2026-10-23' },
    { date: '2026-10-23', open: '09:30', close: '16:00', settlement_date: '2026-10-26' },
    { date: '2026-10-26', open: '09:30', close: '16:00', settlement_date: '2026-10-27' },
  ]
}

export function accountRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'acct-1',
    account_number: 'PA123456',
    status: 'ACTIVE',
    currency: 'USD',
    cash: '10000.00',
    buying_power: '20000.00',
    equity: '10500.50',
    last_equity: '10400.00',
    initial_margin: '0.00',
    maintenance_margin: '0.00',
    multiplier: '2',
    daytrade_count: 3,
    pattern_day_trader: false,
    trading_blocked: false,
    transfers_blocked: false,
    account_blocked: false,
    shorting_enabled: true,
    ...over,
  }
}

export function positionRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    asset_id: 'asset-aapl',
    symbol: 'AAPL',
    exchange: 'NASDAQ',
    asset_class: 'us_equity',
    qty: '10',
    qty_available: '10',
    side: 'long',
    avg_entry_price: '180.00',
    current_price: '190.00',
    market_value: '1900.00',
    cost_basis: '1800.00',
    unrealized_pl: '100.00',
    created_at: '2026-10-01T13:30:00Z',
    ...over,
  }
}

export function orderRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'ord-open-1',
    client_order_id: 'client-open-1',
    symbol: 'AAPL',
    side: 'buy',
    type: 'limit',
    time_in_force: 'gtc',
    qty: '1',
    filled_qty: '0',
    filled_avg_price: null,
    status: 'new',
    order_class: 'simple',
    limit_price: '189.50',
    stop_price: null,
    extended_hours: false,
    submitted_at: '2026-10-21T13:31:00Z',
    created_at: '2026-10-21T13:31:00Z',
    updated_at: '2026-10-21T13:31:00Z',
    ...over,
  }
}

export function activityRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'act-1',
    activity_type: 'FILL',
    transaction_time: '2026-10-21T13:35:00Z',
    type: 'fill',
    price: '190.01',
    qty: '5',
    side: 'buy',
    symbol: 'AAPL',
    order_id: 'ord-fill-1',
    cum_qty: '5',
    leaves_qty: '0',
    order_status: 'filled',
    ...over,
  }
}

/** 已知路径 → 允许的方法（假服务器的方法校验表）。 */
const ROUTES: Array<{ re: RegExp; methods: string[] }> = [
  { re: /^\/v2\/account$/, methods: ['GET'] },
  { re: /^\/v2\/account\/activities$/, methods: ['GET'] },
  { re: /^\/v2\/positions$/, methods: ['GET'] },
  { re: /^\/v2\/assets$/, methods: ['GET'] },
  { re: /^\/v2\/assets\/[^/]+$/, methods: ['GET'] },
  { re: /^\/v2\/calendar$/, methods: ['GET'] },
  { re: /^\/v2\/clock$/, methods: ['GET'] },
  { re: /^\/v2\/orders:by_client_order_id$/, methods: ['GET'] },
  { re: /^\/v2\/orders$/, methods: ['GET', 'POST', 'DELETE'] },
  { re: /^\/v2\/orders\/[^/]+$/, methods: ['GET', 'PATCH', 'DELETE'] },
]

const MISSING = (name: string, status = 422): Response =>
  json({ code: 42210000, message: `invalid request: "${name}" is required` }, status)

export class FakeAlpaca {
  calls: Call[] = []
  assets = new Map<string, Record<string, unknown>>([
    ['AAPL', assetRow()],
    ['MSFT', assetRow({ id: 'asset-msft', symbol: 'MSFT', name: 'Microsoft Corp', price_increment: '0.01' })],
    ['HARD', assetRow({ id: 'asset-hard', symbol: 'HARD', borrow_status: 'hard_to_borrow' })],
    ['NOSHORT', assetRow({ id: 'asset-noshort', symbol: 'NOSHORT', shortable: false })],
    ['WHOLE', assetRow({ id: 'asset-whole', symbol: 'WHOLE', fractionable: false, min_order_size: '1' })],
    ['HALT', assetRow({ id: 'asset-halt', symbol: 'HALT', tradable: false })],
    ['OLD', assetRow({ id: 'asset-old', symbol: 'OLD', status: 'inactive', tradable: false })],
    ['CRYPT', assetRow({ id: 'asset-crypt', symbol: 'BTCUSD', class: 'crypto' })],
  ])
  account = accountRow()
  positions: unknown[] = [positionRow()]
  openOrders: unknown[] = [orderRow()]
  /** 本假服务器创建的订单（POST / PATCH 会写进来；GET /v2/orders/{id} 从这两处找）。 */
  created: Record<string, unknown>[] = []
  activities: unknown[] = [activityRow()]
  calendar: unknown[] = calendarRows()
  clockRow: Record<string, unknown> = {
    timestamp: new Date(NOW).toISOString(),
    is_open: true,
    next_open: '2026-10-22T13:30:00Z',
    next_close: '2026-10-21T20:00:00Z',
  }
  snapshot: Record<string, unknown> = {
    latestQuote: { t: new Date(NOW - 500).toISOString(), ap: 190.02, bp: 190.0, as: 3, bs: 4 },
    latestTrade: { t: new Date(NOW - 400).toISOString(), p: 190.01, s: 100 },
  }
  /** `${METHOD} ${path}` / path → 强制响应（一次性 / 长期）。回调可以抛错模拟断网。 */
  failWith = new Map<string, () => Response | Promise<Response>>()
  failOnce = new Map<string, () => Response | Promise<Response>>()
  dataFailWith = new Map<string, () => Response | Promise<Response>>()
  /** 数据主机是否整体失败（模拟无行情权限）。 */
  dataForbidden = false
  /** 签名 / 头错误的 HTTP 状态（官方是 401）。 */
  authErrorStatus = 401
  private seq = 0

  readonly fetch: typeof fetch = async (input, init) => {
    const raw = String(input)
    const url = new URL(raw)
    const method = (init?.method ?? 'GET').toUpperCase()
    const headers = normalizeHeaders(init?.headers)
    const body = typeof init?.body === 'string' ? init.body : ''
    const query = url.searchParams.toString()
    const call: Call = {
      method, host: url.host, path: url.pathname, query, body, headers,
      params: new URLSearchParams(url.searchParams), url: raw,
    }
    this.calls.push(call)

    if (url.host.startsWith('data.')) return this.data(url.pathname, call)

    const key = `${method} ${url.pathname}`
    const forced = this.failWith.get(key) ?? this.failWith.get(url.pathname)
    if (forced) return forced()
    const once = this.failOnce.get(key) ?? this.failOnce.get(url.pathname)
    if (once) {
      this.failOnce.delete(key)
      this.failOnce.delete(url.pathname)
      return once()
    }

    const route = ROUTES.find((r) => r.re.test(url.pathname))
    if (route === undefined) return json({ code: 40410000, message: `unknown endpoint ${url.pathname}` }, 404)
    if (!route.methods.includes(method)) {
      return json({ code: 40510000, message: `method ${method} not allowed on ${url.pathname}` }, 405)
    }

    // 鉴权头校验（不是 HMAC：Alpaca 只认这两个头）。
    const keyId = headers['apca-api-key-id'] ?? ''
    const secret = headers['apca-api-secret-key'] ?? ''
    if (keyId === '' || secret === '') {
      return json({ code: 40110000, message: 'access key verification failed: missing APCA-API-* header' }, this.authErrorStatus)
    }
    if (keyId !== API_KEY && keyId !== LIVE_API_KEY) {
      return json({ code: 40110000, message: 'access key verification failed: unknown key' }, this.authErrorStatus)
    }
    if (secret !== API_SECRET) {
      return json({ code: 40110000, message: 'access key verification failed: bad secret' }, this.authErrorStatus)
    }

    let parsedBody: Record<string, unknown> = {}
    if (body !== '') {
      try {
        parsedBody = JSON.parse(body) as Record<string, unknown>
      } catch {
        return json({ code: 42210000, message: 'invalid request: body is not JSON' }, 422)
      }
    }

    return this.route(method, url.pathname, call, parsedBody)
  }

  private data(path: string, call: Call): Response | Promise<Response> {
    const forced = this.dataFailWith.get(path)
    if (forced) return forced()
    if (this.dataForbidden) return json({ code: 40310000, message: 'subscription does not permit querying recent SIP data' }, 403)
    const keyId = call.headers['apca-api-key-id'] ?? ''
    if (keyId === '') return json({ code: 40110000, message: 'access key verification failed' }, 401)
    const m = /^\/v2\/stocks\/([^/]+)\/snapshot$/.exec(path)
    if (m === null) return json({ code: 40410000, message: `unknown data endpoint ${path}` }, 404)
    const symbol = decodeURIComponent(m[1] ?? '').toUpperCase()
    const row = this.assets.get(symbol)
    if (row === undefined) return json({ code: 40410000, message: 'not found' }, 404)
    return json({ symbol, ...(this.snapshot as Record<string, unknown>) })
  }

  private route(method: string, path: string, call: Call, body: Record<string, unknown>): Response {
    const p = path
    if (method === 'GET' && p === '/v2/account') return json(this.account)
    if (method === 'GET' && p === '/v2/positions') return json(this.positions)
    if (method === 'GET' && p === '/v2/calendar') return json(this.calendar)
    if (method === 'GET' && p === '/v2/clock') return json(this.clockRow)
    if (method === 'GET' && p === '/v2/assets') return json([...this.assets.values()])
    if (method === 'GET' && p.startsWith('/v2/assets/')) {
      const symbol = decodeURIComponent(p.slice('/v2/assets/'.length)).toUpperCase()
      const row = this.assets.get(symbol)
      return row === undefined ? json({ code: 40410000, message: 'asset not found' }, 404) : json(row)
    }
    if (method === 'GET' && p === '/v2/account/activities') return json(this.pageActivities(call.params))
    if (method === 'GET' && p === '/v2/orders:by_client_order_id') {
      const wanted = call.params.get('client_order_id') ?? ''
      if (wanted === '') return MISSING('client_order_id')
      const hit = [...this.created, ...this.openOrders].find((row) => String((row as Record<string, unknown>)['client_order_id'] ?? '') === wanted)
      return hit === undefined ? json({ code: 40410000, message: 'order not found' }, 404) : json(hit)
    }
    if (method === 'GET' && p === '/v2/orders') {
      const symbols = call.params.get('symbols')
      const status = call.params.get('status')
      let rows = [...this.openOrders, ...this.created.filter((row) => String((row as Record<string, unknown>)['status'] ?? '') === 'new')]
      if (symbols !== null && symbols !== '') rows = rows.filter((row) => String((row as Record<string, unknown>)['symbol'] ?? '') === symbols)
      void status
      // 官方：`after` 是时间戳；按订单 id 翻页是 `after_order_id`。
      const afterTimestamp = call.params.get('after')
      const isTimestamp = afterTimestamp !== null && /^\d{4}-\d{2}-\d{2}T/.test(afterTimestamp) && !Number.isNaN(Date.parse(afterTimestamp))
      if (afterTimestamp !== null && afterTimestamp !== '' && !isTimestamp) {
        return json({ code: 42210000, message: 'invalid request: "after" must be a timestamp; use after_order_id to page by order id' }, 422)
      }
      const afterOrderId = call.params.get('after_order_id')
      if (afterOrderId !== null && afterOrderId !== '') {
        const index = rows.findIndex((row) => String((row as Record<string, unknown>)['id'] ?? '') === afterOrderId)
        if (index >= 0) rows = rows.slice(index + 1)
      }
      const limit = Math.max(1, Math.min(Number(call.params.get('limit') ?? 500) || 500, 500))
      return json(rows.slice(0, limit))
    }
    if (method === 'POST' && p === '/v2/orders') return this.createOrder(body)
    if (method === 'DELETE' && p === '/v2/orders') {
      const rows = [...this.openOrders, ...this.created]
      const results = rows.map((row) => ({ id: String((row as Record<string, unknown>)['id'] ?? ''), status: 200 }))
      this.openOrders = []
      return json(results, 207)
    }
    if (p.startsWith('/v2/orders/')) {
      const id = decodeURIComponent(p.slice('/v2/orders/'.length))
      const found = [...this.created, ...this.openOrders].find((row) => String((row as Record<string, unknown>)['id'] ?? '') === id)
      if (found === undefined) return json({ code: 40410000, message: 'order not found' }, 404)
      if (method === 'GET') return json(found)
      if (method === 'DELETE') {
        this.openOrders = this.openOrders.filter((row) => String((row as Record<string, unknown>)['id'] ?? '') !== id)
        this.created = this.created.filter((row) => String((row as Record<string, unknown>)['id'] ?? '') !== id)
        return new Response(null, { status: 204 })
      }
      // PATCH：官方只接受 qty / time_in_force / limit_price / stop_price / trail（下单才用 trail_percent）。
      for (const banned of ['symbol', 'side', 'type', 'order_class']) {
        if (body[banned] !== undefined) return json({ code: 42210000, message: `invalid request: cannot replace "${banned}"` }, 422)
      }
      if (body['trail_percent'] !== undefined) {
        return json({ code: 42210000, message: 'invalid request: "trail_percent" is not a replace field; use "trail"' }, 422)
      }
      if (body['qty'] === undefined && body['limit_price'] === undefined && body['stop_price'] === undefined && body['trail'] === undefined) {
        return MISSING('qty')
      }
      // 官方 replace 返回**新订单**：新 id、新 client_order_id、replaces=旧 id；旧单转 replaced 并带 replaced_by。
      this.seq += 1
      const newId = `ord-${this.seq}`
      const newClientId = `client-r${this.seq}`
      const now = new Date(NOW).toISOString()
      const oldRow = { ...found, status: 'replaced', replaced_by: newId, updated_at: now }
      const newRow = orderRow({
        ...found,
        ...body,
        id: newId,
        client_order_id: newClientId,
        replaces: id,
        status: 'new',
        updated_at: now,
      })
      this.created = this.created.filter((row) => String((row as Record<string, unknown>)['id'] ?? '') !== id)
      this.created.push(oldRow, newRow)
      this.openOrders = this.openOrders.filter((row) => String((row as Record<string, unknown>)['id'] ?? '') !== id)
      this.openOrders.push(newRow)
      return json(newRow)
    }
    return json({ code: 40410000, message: `unhandled ${method} ${p}` }, 404)
  }

  private pageActivities(params: URLSearchParams): unknown[] {
    const types = (params.get('activity_types') ?? '').toUpperCase()
    let rows = this.activities
    if (types !== '') {
      const wanted = types.split(',').map((t) => t.trim())
      rows = rows.filter((row) => wanted.includes(String((row as Record<string, unknown>)['activity_type'] ?? '').toUpperCase()))
    }
    const pageSize = Math.max(1, Math.min(Number(params.get('page_size') ?? 100) || 100, 100))
    const token = params.get('page_token') ?? ''
    let start = 0
    if (token !== '') {
      const index = rows.findIndex((row) => String((row as Record<string, unknown>)['id'] ?? '') === token)
      start = index < 0 ? 0 : index + 1
    }
    return rows.slice(start, start + pageSize)
  }

  private createOrder(body: Record<string, unknown>): Response {
    for (const name of ['symbol', 'qty', 'side', 'type', 'time_in_force']) {
      if (body[name] === undefined || String(body[name]) === '') return MISSING(name)
    }
    const symbol = String(body['symbol']).toUpperCase()
    const asset = this.assets.get(symbol)
    if (asset === undefined) return json({ code: 40410000, message: `asset ${symbol} not found` }, 404)
    if (asset['tradable'] !== true) return json({ code: 40310000, message: `asset ${symbol} is not tradable` }, 403)
    const type = String(body['type'])
    const klass = String(body['order_class'] ?? 'simple')
    // 官方 OCO：type=limit 但价格都在两条腿里，没有顶层 limit_price。
    if (type === 'limit' && body['limit_price'] === undefined && klass !== 'oco') return MISSING('limit_price')
    if (type === 'stop' && body['stop_price'] === undefined) return MISSING('stop_price')
    if (type === 'stop_limit' && (body['stop_price'] === undefined || body['limit_price'] === undefined)) return MISSING('stop_price')
    if (type === 'trailing_stop' && body['trail_percent'] === undefined && body['trail_price'] === undefined) return MISSING('trail_percent')
    if (klass === 'bracket' && (body['take_profit'] === undefined || body['stop_loss'] === undefined)) return MISSING('take_profit')
    if (klass === 'oto' && (body['take_profit'] === undefined && body['stop_loss'] === undefined)) return MISSING('take_profit')
    if (klass === 'oco' && (body['take_profit'] === undefined || body['stop_loss'] === undefined)) return MISSING('stop_loss')
    const qty = String(body['qty'])
    const fractional = qty.includes('.')
    // 上游规则（官方）：小数股必须 day；扩展时段只收 limit + day。
    if (fractional && String(body['time_in_force']) !== 'day') {
      return json({ code: 42210000, message: 'fractional orders must use time_in_force=day' }, 422)
    }
    if (body['extended_hours'] === true && type !== 'limit') {
      return json({ code: 42210000, message: 'extended hours orders must be limit orders' }, 422)
    }
    if (body['extended_hours'] === true && String(body['time_in_force']) !== 'day') {
      return json({ code: 42210000, message: 'extended hours orders must use time_in_force=day' }, 422)
    }
    if (fractional && klass !== 'simple') {
      return json({ code: 42210000, message: 'fractional orders cannot be bracket / oco / oto' }, 422)
    }
    this.seq += 1
    const id = `ord-${this.seq}`
    const row = orderRow({
      id,
      client_order_id: String(body['client_order_id'] ?? `client-${this.seq}`),
      symbol,
      side: String(body['side']),
      type,
      time_in_force: String(body['time_in_force']),
      qty,
      order_class: klass,
      limit_price: body['limit_price'] ?? null,
      stop_price: body['stop_price'] ?? null,
      extended_hours: body['extended_hours'] === true,
      status: klass === 'simple' ? 'accepted' : 'accepted',
      take_profit: body['take_profit'] ?? null,
      stop_loss: body['stop_loss'] ?? null,
    })
    this.created.push(row)
    return json(row)
  }

  callsTo(path: string): Call[] { return this.calls.filter((c) => c.path === path) }
  callsFor(method: string, path: string): Call[] { return this.calls.filter((c) => c.method === method && c.path === path) }
  last(): Call | undefined { return this.calls[this.calls.length - 1] }
  bodyOf(index: number): Record<string, unknown> {
    const call = this.calls[index]
    return call === undefined || call.body === '' ? {} : (JSON.parse(call.body) as Record<string, unknown>)
  }
  lastBody(): Record<string, unknown> {
    for (let i = this.calls.length - 1; i >= 0; i--) {
      const call = this.calls[i]
      if (call !== undefined && call.body !== '') return JSON.parse(call.body) as Record<string, unknown>
    }
    return {}
  }
  fail(method: string, path: string, body: unknown, status = 200, headers: Record<string, string> = {}): void {
    this.failWith.set(`${method} ${path}`, () => json(body, status, headers))
  }
  failNext(method: string, path: string, body: unknown, status = 200, headers: Record<string, string> = {}): void {
    this.failOnce.set(`${method} ${path}`, () => json(body, status, headers))
  }
  /** 断网 / 超时：直接抛（rest.ts 会把它包成 AlpacaNetworkError）。 */
  networkError(method: string, path: string): void {
    this.failOnce.set(`${method} ${path}`, () => { throw new TypeError('fetch failed: socket hang up') })
  }
  reset(): void {
    this.calls = []
    this.failWith.clear()
    this.failOnce.clear()
    this.dataFailWith.clear()
  }
}

function normalizeHeaders(init: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (init === undefined || init === null) return out
  if (typeof Headers !== 'undefined' && init instanceof Headers) {
    init.forEach((v, k) => { out[k.toLowerCase()] = v })
    return out
  }
  if (Array.isArray(init)) {
    for (const pair of init as Array<[string, string]>) out[String(pair[0]).toLowerCase()] = String(pair[1])
    return out
  }
  for (const [k, v] of Object.entries(init as Record<string, unknown>)) out[k.toLowerCase()] = String(v)
  return out
}
