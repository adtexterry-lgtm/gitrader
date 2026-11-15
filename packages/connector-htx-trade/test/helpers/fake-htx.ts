// SPDX-License-Identifier: CPAL-1.0
// 假 HTX 服务器（**独立实现**：只按 HTX 官方文档的签名规则自己算，不 import 本包任何客户端代码）。
// 独立性（G1 / G4 教训）：
//   · 待签串与 HMAC 只用 node:crypto 在这里重写一遍：`METHOD\nHost\nPath\n排序&编码后的参数`（除 Signature 外的全部参数），
//     Base64(HMAC-SHA256(待签串, secret))；不调用 src/rest.ts 的 signatureOf / prehashOf / encodeParams；
//   · 路由与响应形状按官方文档写（不按客户端写法）：v1 私有接口全部 POST、业务参数在 JSON body；
//     v5 下单 type 只有 market/limit/post_only、IOC/FOK 在 time_in_force、volume 是 String；
//     v1 成交行是 trade_volume / trade_price / trade_fee / create_date / id，v5 成交行是 trade_id / created_time；
//   · 每个端点**校验必填参数**（缺参回官方形状的错误信封），不复刻客户端的「缺什么就自己补」。
// 危险端点：官方 `POST /v5/trade/position` 与 `POST /v5/trade/position_all` 是**市价平仓**，不是持仓查询。
//   本假服务器把它们实现成“真的平掉持仓”并计数（closeAllCalls），任何只读测试都不许看到这个计数 > 0。
import { createHmac } from 'node:crypto'

export const API_KEY = 'htx-test-key'
export const API_SECRET = 'htx-test-secret'
export const BASE_URL = 'http://htx.example.test'
export const HOST = 'htx.example.test'
export const NOW = 1_760_000_000_000

/** 一张 BTC-USDT 的面值 0.001 BTC；ETH-USDT 0.01 ETH（与假服务器行情、持仓、订单同尺度）。 */
export const CONTRACTS: Record<string, { size: string; tick: string }> = {
  'BTC-USDT': { size: '0.001', tick: '0.1' },
  'ETH-USDT': { size: '0.01', tick: '0.01' },
}

export interface FakeOrder {
  /** 查询号（v5 挂单数组的 id；也是分页游标）。 */
  id: number
  order_id: number
  client_order_id: string
  contract_code: string
  direction: 'buy' | 'sell'
  offset: 'open' | 'close' | 'both'
  volume: number
  trade_volume: number
  price: string
  order_price_type: string
  status: number
  created_at: number
  lever_rate: number
  reduce_only?: number
  position_side?: string
  /** 覆盖 v5 的 state 字符串（原样透传测试用）。 */
  state?: string
}

export interface FakeTrade {
  venue: 'v1' | 'v5'
  contract_code: string
  id: string
  created_at: number
  [field: string]: unknown
}

export interface FakeRequest {
  method: string
  path: string
  query: Record<string, string>
  body: Record<string, unknown>
  rawBody: string
}

type Handler = (req: FakeRequest) => { status?: number; body: unknown }

interface V5Envelope {
  code: number
  message: string
  data: unknown
  ts?: number
}

export class FakeHtx {
  /** 记录每个请求（测试断言用）。 */
  readonly seen: FakeRequest[] = []
  readonly orders = new Map<number, FakeOrder>()
  /** v1 / v5 成交夹具（各自官方字段）。 */
  readonly trades: FakeTrade[] = []
  /** v1 成交分页的假页大小（默认用请求里的 size）。 */
  matchPageSize: number | null = null
  /** 持仓夹具。 */
  positions: Array<{
    contract_code: string
    direction: 'buy' | 'sell'
    volume: number
    cost_open: string
    last_price: string
    lever_rate: number
    mark_price?: string
    open_avg_price?: string
    position_side?: 'long' | 'short' | 'both'
  }> = []
  /** 账户（v1 / v5 两种形状都用这一份数据）。 */
  balance = { equity: '1000.5', available: '900.25', margin: '100.25', maintenance: '10' }
  /** 每个合约的当前杠杆（缺省 3）。 */
  leverByContract = new Map<string, number>()
  /** 默认杠杆。 */
  lever = 3
  /** 市价平仓端点被调用的次数（任何只读测试都必须是 0）。 */
  closeAllCalls = 0
  /** 下单时因 lever_rate 不同而切换杠杆的次数（测试断言 0）。 */
  leverSwitchedByOrder = 0
  /** GET /v5/trade/position/opens 的失败注入（例如 {code:6001,…}）。 */
  positionsFailure: { code: number; message: string } | null = null
  /** 下一次请求强制失败（注入用）：{ status, body }。 */
  nextFailure: { status?: number; body: unknown } | null = null
  /** 签名校验失败的次数（测试断言「真的验签」）。 */
  signatureFailures = 0
  /** 缺参失败的次数。 */
  paramFailures = 0
  /** 账户持仓模式：'oneway' 时带 position_side=long 的建单被 1500 拒（故意反转，用来测重发）。 */
  accountMode: 'hedge' | 'oneway' = 'oneway'
  /** v1 撤单 / 全撤的逐单错误注入（官方 data.errors 形状）。 */
  cancelErrors: Array<{ order_id?: number; err_code: number; err_msg: string }> = []
  /** v5 全撤里某一行的 code（测试逐单失败）。 */
  cancelAllRowCode: number | null = null
  private nextOrderId = 7_000_000_001
  private nextQueryId = 7_000_000_001
  private nextTradeId = 9_000_001

  /** 注入到客户端构造参数的 fetch。 */
  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input))
    const method = String(init?.method ?? 'GET').toUpperCase()
    const path = url.pathname
    const query: Record<string, string> = {}
    url.searchParams.forEach((v, k) => { query[k] = v })
    const rawBody = typeof init?.body === 'string' ? init.body : ''
    const body = rawBody === '' ? {} : (JSON.parse(rawBody) as Record<string, unknown>)
    const req: FakeRequest = { method, path, query, body, rawBody }
    this.seen.push(req)

    if (this.nextFailure !== null) {
      const failure = this.nextFailure
      this.nextFailure = null
      return this.json(failure.body, failure.status ?? 200)
    }

    const isPublic = path.startsWith('/linear-swap-ex/') || path === '/linear-swap-api/v1/swap_contract_info'
    if (!isPublic) {
      const problem = this.verifySignature(req)
      if (problem !== null) {
        this.signatureFailures += 1
        return this.json(problem, 401)
      }
    }
    const handler = this.routes[`${method} ${path}`]
    if (handler === undefined) return this.json({ status: 'error', err_msg: `unknown endpoint ${method} ${path}` }, 404)
    const out = handler(req)
    return this.json(out.body, out.status ?? 200)
  }

  /** 官方签名规则：除 Signature 外的全部参数按 key 升序、URL 编码后拼接；HMAC 待签串四行。 */
  private verifySignature(req: FakeRequest): { status: 'error'; err_msg: string } | null {
    const given = req.query.Signature
    if (given === undefined || given === '') return { status: 'error', err_msg: 'signature is missing' }
    if (req.query.AccessKeyId !== API_KEY) return { status: 'error', err_msg: 'invalid access key' }
    if (req.query.SignatureMethod !== 'HmacSHA256') return { status: 'error', err_msg: 'signature method must be HmacSHA256' }
    if (req.query.SignatureVersion !== '2') return { status: 'error', err_msg: 'signature version must be 2' }
    const ts = req.query.Timestamp ?? ''
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(ts)) return { status: 'error', err_msg: 'timestamp must be UTC ISO8601 without milliseconds' }
    const pairs: Array<[string, string]> = []
    for (const key of Object.keys(req.query).sort()) {
      if (key === 'Signature') continue
      pairs.push([key, req.query[key]!])
    }
    const encoded = pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')
    const prehash = [req.method, HOST, req.path, encoded].join('\n')
    const expected = createHmac('sha256', API_SECRET).update(prehash).digest('base64')
    if (expected !== given) {
      return { status: 'error', err_msg: `signature does not match (expected over "${req.method}\\n${HOST}\\n${req.path}\\n…")` }
    }
    return null
  }

  /** 缺参的统一回包（官方形状：status=error + err_msg 文案）。 */
  private missing(fields: string[]): { status: 'error'; err_msg: string } {
    this.paramFailures += 1
    return { status: 'error', err_msg: `invalid parameter: ${fields.join(', ')} required` }
  }

  private ok(data: unknown): { body: unknown } {
    return { body: { status: 'ok', data, ts: NOW } }
  }

  private v5(data: unknown): { body: V5Envelope } {
    return { body: { code: 200, message: 'Success', data, ts: NOW } }
  }

  private v5Error(code: number, message: string): { body: V5Envelope } {
    return { body: { code, message, data: null, ts: NOW } }
  }

  private json(body: unknown, status: number): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  }

  private leverOf(code: string): number {
    return this.leverByContract.get(code) ?? this.lever
  }

  private setLever(code: string, lever: number): void {
    this.leverByContract.set(code, lever)
  }

  private hasOpenExposure(code: string): boolean {
    if (this.positions.some((p) => p.contract_code === code && p.volume > 0)) return true
    return [...this.orders.values()].some((o) => o.contract_code === code && (o.status === 3 || o.status === 4))
  }

  private newOrder(req: FakeRequest, fields: Partial<FakeOrder> & { contract_code: string; direction: 'buy' | 'sell'; volume: number; price: string; order_price_type: string }): FakeOrder {
    const orderId = this.nextOrderId++
    const queryId = this.nextQueryId++
    const clientRaw = req.body.client_order_id
    const order: FakeOrder = {
      id: queryId,
      order_id: orderId,
      client_order_id: clientRaw !== undefined ? String(clientRaw) : '',
      offset: 'both',
      trade_volume: 0,
      status: 3,
      created_at: NOW,
      lever_rate: this.leverOf(fields.contract_code),
      ...fields,
    }
    this.orders.set(orderId, order)
    return order
  }

  private stateOf(order: FakeOrder): string {
    if (order.state !== undefined) return order.state
    if (order.status === 6) return 'filled'
    if (order.status === 7) return 'canceled'
    if (order.status === 4) return 'partially_filled'
    return 'new'
  }

  /** v1 挂单行的官方字段。 */
  private v1OrderRow(order: FakeOrder): Record<string, unknown> {
    return {
      contract_code: order.contract_code,
      volume: order.volume,
      price: order.price,
      order_price_type: order.order_price_type,
      direction: order.direction,
      offset: order.offset,
      lever_rate: order.lever_rate,
      order_id: order.order_id,
      order_id_str: String(order.order_id),
      client_order_id: order.client_order_id,
      created_at: order.created_at,
      trade_volume: order.trade_volume,
      status: order.status,
      reduce_only: order.reduce_only ?? 0,
    }
  }

  /** v5 挂单行的官方字段（volume / trade_volume 是字符串，reduce_only 是布尔）。 */
  private v5OrderRow(order: FakeOrder): Record<string, unknown> {
    return {
      id: order.id,
      contract_code: order.contract_code,
      side: order.direction,
      position_side: order.position_side ?? 'both',
      type: order.order_price_type,
      order_id: String(order.order_id),
      client_order_id: order.client_order_id,
      margin_mode: 'cross',
      price: order.price,
      volume: String(order.volume),
      lever_rate: order.lever_rate,
      state: this.stateOf(order),
      reduce_only: order.reduce_only === 1,
      trade_volume: String(order.trade_volume),
      time_in_force: 'gtc',
      created_time: order.created_at,
    }
  }

  private readonly routes: Record<string, Handler> = {
    // ---- 公共（官方形状） ----
    'GET /linear-swap-api/v1/swap_contract_info': () => this.ok(Object.keys(CONTRACTS).map((code) => ({
      contract_code: code,
      contract_size: Number(CONTRACTS[code]!.size),
      price_tick: Number(CONTRACTS[code]!.tick),
      contract_status: 1,
      symbol: code.split('-')[0],
    }))),
    'GET /linear-swap-ex/market/detail/merged': (req) => {
      const code = req.query.contract_code ?? ''
      if (CONTRACTS[code] === undefined) return { body: { status: 'error', err_msg: 'invalid contract_code' } }
      const px = code === 'BTC-USDT' ? 100 : 20
      return { body: { status: 'ok', ts: NOW, tick: { id: NOW / 1000, open: px, high: px, low: px, close: px, bid: [px - 0.1, 12], ask: [px + 0.1, 9], vol: 1000, amount: 100000 } } }
    },
    'GET /linear-swap-ex/market/depth': () => ({ body: { status: 'ok', tick: { bids: [[99.9, 5000], [99.8, 3000]], asks: [[100.1, 4000], [100.2, 2000]] } } }),
    'GET /linear-swap-ex/market/history/kline': () => ({
      body: {
        status: 'ok',
        data: [
          { id: NOW / 1000, open: 99, high: 101, low: 98, close: 100, vol: 10, amount: 1000 },
          { id: NOW / 1000 - 60, open: 98, high: 100, low: 97, close: 99, vol: 8000, amount: 800 },
        ],
      },
    }),
    // ---- v5 私有（GET 查 / POST 改） ----
    'GET /v5/account/balance': () => this.v5({
      state: 'normal',
      equity: this.balance.equity,
      initial_margin: this.balance.margin,
      maintenance_margin: this.balance.maintenance,
      maintenance_margin_rate: '0.01',
      profit_unreal: '0',
      available_margin: this.balance.available,
      details: [{ currency: 'USDT', equity: this.balance.equity, available: this.balance.available, initial_margin: this.balance.margin, maintenance_margin: this.balance.maintenance }],
    }),
    'GET /v5/trade/position/opens': () => {
      if (this.positionsFailure !== null) return this.v5Error(this.positionsFailure.code, this.positionsFailure.message)
      return this.v5(this.positions.map((p) => ({
        contract_code: p.contract_code,
        position_side: p.position_side ?? 'both',
        direction: p.direction,
        margin_mode: 'cross',
        open_avg_price: p.open_avg_price ?? p.cost_open,
        volume: p.volume,
        available: p.volume,
        lever_rate: p.lever_rate,
        liquidation_price: '0',
        profit_unreal: '0',
        mark_price: p.mark_price ?? p.last_price,
        last_price: p.last_price,
        created_time: NOW,
        updated_time: NOW,
      })))
    },
    // 官方：市价平掉全部持仓（无参数）。任何只读路径都不该调用它。
    'POST /v5/trade/position_all': () => {
      this.closeAllCalls += 1
      this.positions = []
      for (const order of this.orders.values()) if (order.status === 3 || order.status === 4) order.status = 7
      return this.v5([])
    },
    // 官方：市价全平某合约（不是持仓查询）。同样计数。
    'POST /v5/trade/position': () => {
      this.closeAllCalls += 1
      return this.v5([])
    },
    'GET /v5/trade/order': (req) => {
      const order = this.findOrder(req)
      if (order === null) return this.v5Error(1061, 'The order does not exist.')
      const row = this.v5OrderRow(order)
      return this.v5({
        ...row,
        trade_volume: String(order.trade_volume),
        trade_avg_price: order.trade_volume > 0 ? order.price : '0',
        updated_time: order.created_at,
      })
    },
    'GET /v5/trade/order/opens': (req) => {
      const code = req.query.contract_code
      const limit = Math.min(Number(req.query.limit ?? 10), 100)
      const from = req.query.from === undefined ? 0 : Number(req.query.from)
      const rows = [...this.orders.values()]
        .filter((o) => (o.status === 3 || o.status === 4) && (code === undefined || o.contract_code === code))
        .sort((a, b) => a.id - b.id)
        .filter((o) => o.id > from)
        .slice(0, limit)
      return this.v5(rows.map((o) => this.v5OrderRow(o)))
    },
    'GET /v5/trade/order/details': (req) => {
      const code = req.query.contract_code
      if (code === undefined || code === '') return { body: this.missing(['contract_code']) }
      const from = req.query.from === undefined ? 0 : Number(req.query.from)
      const limit = Math.min(Number(req.query.limit ?? 100), 100)
      const start = Number(req.query.start_time ?? 0)
      const end = Number(req.query.end_time ?? NOW)
      const rows = this.trades
        .filter((t) => t.venue === 'v5' && t.contract_code === code && t.created_at >= start && t.created_at <= end)
        .filter((t) => (from === 0 ? true : Number(t.id) > from))
        .slice(0, limit)
        .map(({ venue: _venue, created_at: _created, ...row }) => row)
      return this.v5(rows)
    },
    'POST /v5/trade/order': (req) => {
      const missing: string[] = []
      for (const f of ['contract_code', 'margin_mode', 'side', 'type', 'volume']) {
        if (req.body[f] === undefined || req.body[f] === '') missing.push(f)
      }
      if (missing.length > 0) return { body: this.missing(missing) }
      const code = String(req.body.contract_code)
      if (CONTRACTS[code] === undefined) return this.v5Error(1013, "contract symbol doesn't exist")
      const type = String(req.body.type)
      if (type !== 'market' && type !== 'limit' && type !== 'post_only') return this.v5Error(1067, 'Invalid field')
      const tif = req.body.time_in_force
      if (tif !== undefined && tif !== 'gtc' && tif !== 'ioc' && tif !== 'fok') return this.v5Error(1067, 'Invalid field')
      if (typeof req.body.volume !== 'string') return this.v5Error(1067, 'Invalid field')
      if (req.body.margin_mode !== 'cross' && req.body.margin_mode !== 'isolated') return this.v5Error(1067, 'Invalid field')
      if (type !== 'market' && req.body.price === undefined) return { body: this.missing(['price']) }
      const side = String(req.body.side) === 'sell' ? 'sell' : 'buy'
      const positionSide = req.body.position_side === undefined ? 'both' : String(req.body.position_side)
      if (this.accountMode === 'oneway' && positionSide !== 'both') {
        return this.v5Error(1500, 'One-way mode currently, position_side must be both')
      }
      if (this.accountMode === 'hedge' && positionSide === 'both') {
        return this.v5Error(1499, 'Hedge mode currently, position_side long/short is required')
      }
      const order = this.newOrder(req, {
        contract_code: code,
        direction: side,
        volume: Number(req.body.volume),
        price: String(req.body.price ?? '0'),
        order_price_type: type,
        position_side: positionSide,
        offset: positionSide === 'both' ? 'both' : req.body.reduce_only === 1 ? 'close' : 'open',
        ...(req.body.reduce_only !== undefined ? { reduce_only: Number(req.body.reduce_only) } : {}),
      })
      return this.v5({ order_id: String(order.order_id), client_order_id: order.client_order_id })
    },
    'POST /v5/trade/cancel_order': (req) => {
      const order = this.findOrder(req)
      if (order === null) return this.v5Error(1061, 'The order does not exist.')
      if (order.status === 6 || order.status === 7) return this.v5Error(1061, 'The order does not exist.')
      order.status = 7
      return this.v5({ order_id: String(order.order_id), client_order_id: order.client_order_id })
    },
    'POST /v5/trade/cancel_all_orders': (req) => {
      const code = req.body.contract_code === undefined ? undefined : String(req.body.contract_code)
      const rows = [...this.orders.values()].filter((o) => (o.status === 3 || o.status === 4) && (code === undefined || o.contract_code === code))
      const data = rows.map((order) => {
        const codeValue = this.cancelAllRowCode ?? 200
        if (codeValue === 200) order.status = 7
        return {
          code: codeValue,
          message: codeValue === 200 ? 'Success' : this.cancelAllRowCode === 1061 ? 'The order does not exist.' : 'rejected',
          order_id: String(order.order_id),
          client_order_id: order.client_order_id,
        }
      })
      return this.v5(data)
    },
    'POST /v5/position/lever': (req) => {
      if (req.body.contract_code === undefined || req.body.lever_rate === undefined) return { body: this.missing(['contract_code', 'lever_rate']) }
      if (req.body.margin_mode !== 'cross' && req.body.margin_mode !== 'isolated') return this.v5Error(1067, 'Invalid field')
      const code = String(req.body.contract_code)
      this.setLever(code, Number(req.body.lever_rate))
      return this.v5({ contract_code: code, lever_rate: this.leverOf(code) })
    },
    // ---- v1 私有（官方：全部 POST，业务参数在 body） ----
    'POST /linear-swap-api/v1/swap_cross_account_info': () => this.ok([{
      margin_mode: 'cross',
      margin_account: 'USDT',
      margin_asset: 'USDT',
      margin_balance: this.balance.equity,
      margin_static: this.balance.equity,
      margin_position: this.balance.margin,
      margin_frozen: '0',
      profit_real: '0',
      profit_unreal: '0',
      withdraw_available: this.balance.available,
      risk_rate: '10',
      position_mode: 'single_side',
      contract_detail: [],
    }]),
    'POST /linear-swap-api/v1/swap_cross_position_info': () => this.ok(this.positions.map((p) => ({
      symbol: p.contract_code.split('-')[0],
      contract_code: p.contract_code,
      margin_mode: 'cross',
      volume: p.volume,
      available: p.volume,
      frozen: 0,
      cost_open: p.cost_open,
      cost_hold: p.cost_open,
      profit_unreal: '0',
      profit_rate: '0',
      profit: '0',
      margin_asset: 'USDT',
      position_margin: '10',
      lever_rate: p.lever_rate,
      direction: p.direction,
      last_price: p.last_price,
      position_mode: 'single_side',
    }))),
    'POST /linear-swap-api/v1/swap_cross_openorders': (req) => {
      const pageSize = Number(req.body.page_size ?? 50)
      const page = Number(req.body.page_index ?? 1)
      const code = req.body.contract_code
      const rows = [...this.orders.values()]
        .filter((o) => (o.status === 3 || o.status === 4) && (code === undefined || o.contract_code === code))
      const start = (page - 1) * pageSize
      return this.ok({
        orders: rows.slice(start, start + pageSize).map((o) => this.v1OrderRow(o)),
        total_page: Math.max(1, Math.ceil(rows.length / pageSize)),
        current_page: page,
        total_size: rows.length,
      })
    },
    'POST /linear-swap-api/v1/swap_cross_order_info': (req) => {
      const order = this.findOrder(req)
      return this.ok(order === null ? [] : [this.v1OrderRow(order)])
    },
    'POST /linear-swap-api/v1/swap_cross_matchresults_exact': (req) => {
      const missing: string[] = []
      if (req.body.contract_code === undefined) missing.push('contract_code')
      if (req.body.trade_type === undefined) missing.push('trade_type')
      if (missing.length > 0) return { body: this.missing(missing) }
      const code = String(req.body.contract_code)
      const from = Number(req.body.start_time ?? 0)
      const to = Number(req.body.end_time ?? NOW)
      const fromId = Number(req.body.from_id ?? 0)
      const size = Math.min(Number(req.body.size ?? 20), this.matchPageSize ?? 50)
      const all = this.trades
        .filter((t) => t.venue === 'v1' && t.contract_code === code && t.created_at >= from && t.created_at <= to)
        .filter((t) => (fromId === 0 ? true : Number(t.id) > fromId))
      const page = all.slice(0, size)
      const remaining = all.length - page.length
      return this.ok({
        trades: page.map(({ venue: _venue, created_at: _created, ...row }) => row),
        remain_size: remaining,
        next_id: remaining > 0 ? page[page.length - 1]!.id : null,
      })
    },
    'POST /linear-swap-api/v1/swap_cross_order': (req) => {
      const missing: string[] = []
      for (const f of ['contract_code', 'volume', 'direction', 'lever_rate', 'order_price_type']) {
        if (req.body[f] === undefined || req.body[f] === '') missing.push(f)
      }
      if (missing.length > 0) return { body: this.missing(missing) }
      const code = String(req.body.contract_code)
      if (CONTRACTS[code] === undefined) return { body: { status: 'error', err_code: 1013, err_msg: "contract symbol doesn't exist" } }
      const priceType = String(req.body.order_price_type)
      if (priceType !== 'ioc' && priceType !== 'opponent' && req.body.price === undefined) return { body: this.missing(['price']) }
      const lever = Number(req.body.lever_rate)
      if (!Number.isInteger(lever) || lever < 1) return { body: this.missing(['lever_rate']) }
      // 官方：lever_rate 与当前不同会切换该合约杠杆；有持仓 / 挂单时报 1045。
      if (lever !== this.leverOf(code)) {
        if (this.hasOpenExposure(code)) {
          return { body: { status: 'error', err_code: 1045, err_msg: 'Unable to switch leverage due to open orders.' } }
        }
        this.setLever(code, lever)
        this.leverSwitchedByOrder += 1
      }
      const order = this.newOrder(req, {
        contract_code: code,
        direction: String(req.body.direction) === 'sell' ? 'sell' : 'buy',
        offset: String(req.body.offset) === 'close' ? 'close' : String(req.body.offset) === 'open' ? 'open' : 'both',
        volume: Number(req.body.volume),
        price: String(req.body.price ?? '0'),
        order_price_type: priceType,
        lever_rate: lever,
        ...(req.body.reduce_only !== undefined ? { reduce_only: Number(req.body.reduce_only) } : {}),
      })
      return { body: { status: 'ok', data: { order_id: order.order_id, order_id_str: String(order.order_id), client_order_id: order.client_order_id }, ts: NOW } }
    },
    'POST /linear-swap-api/v1/swap_cross_cancel': (req) => {
      if (this.cancelErrors.length > 0) return this.ok({ errors: this.cancelErrors, successes: '' })
      const order = this.findOrder(req)
      if (order === null) {
        return this.ok({ errors: [{ order_id: 0, err_code: 1061, err_msg: "This order doesn't exist." }], successes: '' })
      }
      order.status = 7
      return this.ok({ errors: [], successes: String(order.order_id) })
    },
    'POST /linear-swap-api/v1/swap_cross_cancelall': (req) => {
      if (this.cancelErrors.length > 0) return this.ok({ errors: this.cancelErrors, successes: '' })
      const code = req.body.contract_code === undefined ? undefined : String(req.body.contract_code)
      const cancelled: string[] = []
      for (const order of this.orders.values()) {
        if (order.status !== 3 && order.status !== 4) continue
        if (code !== undefined && order.contract_code !== code) continue
        order.status = 7
        cancelled.push(String(order.order_id))
      }
      return this.ok({ errors: [], successes: cancelled.join(',') })
    },
    'POST /linear-swap-api/v1/swap_cross_switch_lever_rate': (req) => {
      if (req.body.contract_code === undefined || req.body.lever_rate === undefined) return { body: this.missing(['contract_code', 'lever_rate']) }
      if (req.body.margin_mode !== undefined) return { body: this.missing(['margin_mode is not a field of this endpoint']) }
      const code = String(req.body.contract_code)
      this.setLever(code, Number(req.body.lever_rate))
      return this.ok({ contract_code: code, lever_rate: this.leverOf(code) })
    },
    'POST /linear-swap-api/v1/swap_cross_tpsl_order': (req) => {
      const missing: string[] = []
      for (const f of ['contract_code', 'direction', 'volume']) if (req.body[f] === undefined) missing.push(f)
      if (req.body.tp_trigger_price === undefined && req.body.sl_trigger_price === undefined) missing.push('tp_trigger_price|sl_trigger_price')
      if (missing.length > 0) return { body: this.missing(missing) }
      const id = this.nextOrderId++
      return this.ok({ tp_order: { order_id: id, order_id_str: String(id) }, sl_order: { order_id: id + 1, order_id_str: String(id + 1) } })
    },
  }

  private findOrder(req: FakeRequest): FakeOrder | null {
    const orderId = req.query.order_id ?? req.body.order_id
    const clientId = req.query.client_order_id ?? req.body.client_order_id
    if (orderId !== undefined && String(orderId) !== '' && String(orderId) !== '0') {
      return this.orders.get(Number(orderId)) ?? null
    }
    if (clientId !== undefined && String(clientId) !== '') {
      for (const order of this.orders.values()) if (order.client_order_id === String(clientId)) return order
    }
    return null
  }

  /** 造一笔 v1 成交（官方 matchresults_exact 字段）。 */
  addTrade(over: Partial<Record<string, unknown>> = {}): FakeTrade {
    const id = String(this.nextTradeId++)
    const trade: FakeTrade = {
      venue: 'v1',
      id,
      match_id: id,
      query_id: id,
      contract_code: 'BTC-USDT',
      direction: 'buy',
      offset: 'open',
      order_id: 7_000_000_001,
      order_id_str: '7000000001',
      trade_volume: 2,
      trade_price: '100',
      trade_fee: '-0.02',
      create_date: NOW - 1000,
      role: 'Taker',
      fee_asset: 'USDT',
      real_profit: '0',
      margin_mode: 'cross',
      reduce_only: 0,
      created_at: NOW - 1000,
      ...over,
    }
    this.trades.push(trade)
    return trade
  }

  /** 造一笔 v5 成交（官方 order/details 字段）。 */
  addV5Trade(over: Partial<Record<string, unknown>> = {}): FakeTrade {
    const id = String(this.nextTradeId++)
    const trade: FakeTrade = {
      venue: 'v5',
      id,
      trade_id: id,
      contract_code: 'BTC-USDT',
      side: 'buy',
      position_side: 'both',
      order_type: 'limit',
      type: 'limit',
      order_id: '7000000001',
      trade_price: '100',
      trade_volume: '2',
      trade_turnover: '0.2',
      trade_fee: '0.02',
      role: 'TAKER',
      fee_currency: 'USDT',
      profit: '0',
      created_time: NOW - 1000,
      updated_time: NOW - 1000,
      created_at: NOW - 1000,
      ...over,
    }
    this.trades.push(trade)
    return trade
  }

  /** 清掉请求记录（多次断言之间用）。 */
  reset(): void {
    this.seen.length = 0
    this.orders.clear()
    this.trades.length = 0
    this.positions = []
    this.matchPageSize = null
    this.nextFailure = null
    this.signatureFailures = 0
    this.paramFailures = 0
    this.accountMode = 'oneway'
    this.lever = 3
    this.leverByContract.clear()
    this.closeAllCalls = 0
    this.leverSwitchedByOrder = 0
    this.positionsFailure = null
    this.cancelErrors = []
    this.cancelAllRowCode = null
  }
}
