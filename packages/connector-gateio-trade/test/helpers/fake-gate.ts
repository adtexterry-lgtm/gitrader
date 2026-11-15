// SPDX-License-Identifier: CPAL-1.0
// 离线假 Gate.io apiv4 服务：进程内按「方法 + 路径」回答，不开端口、不联网、不读夹具文件。
// 形状照 packages/connector-bitget-trade/test/helpers/fake-bitget.ts（CPAL-1.0）改成 Gate 口径：
//   · **复算签名**：hex(HMAC-SHA512(secret, METHOD \n PATH \n QUERY \n sha512hex(body) \n TIMESTAMP))，
//     与实现同一个串（QD gate.py:78-138）；KEY / Timestamp 对不上也拒；
//   · **校验方法**：已知路径用错方法回 405（撤单写成 POST 这类错必须在这里炸出来，工单教训 2）；
//   · **校验必填参数**：缺参回 Gate 的真实形状 `400 {"label":"INVALID_PARAM_VALUE","message":...}`；
//   · 列表端点（orders / positions / my_trades / price_orders）按 contract 过滤后按 limit / offset 切片；
//   · 触发单（price_orders）的响应原文是大整数 id，验精度；
//   · 未知订单回 404 `ORDER_NOT_FOUND`；
//   · 响应体是**裸对象 / 裸数组**（Gate 没有统一信封）。
import { signatureOf } from '../../src/rest'

export const API_KEY = 'test-gate-key'
export const API_SECRET = 'test-gate-secret-not-real'
export const BASE_URL = 'http://gate.example.test'
export const NOW = 1_791_483_435_048

export const json = (o: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json', ...headers } })

export interface Call {
  method: string
  path: string
  /** 签名用的 query（按键排序后）或空串。 */
  query: string
  body: string
  headers: Record<string, string>
  params: URLSearchParams
  url: string
}

/** 一条 BTC_USDT 合约：tick 0.1，quanto_multiplier 0.0001，order_size_min 1 张（= 0.0001 BTC）。 */
export function contractRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'BTC_USDT',
    type: 'direct',
    order_price_round: '0.1',
    order_size_min: 1,
    quanto_multiplier: '0.0001',
    leverage_max: '100',
    funding_rate: '0.0001',
    funding_interval: 28800,
    mark_price: '100000',
    status: 'trading',
    in_delisting: false,
    ...over,
  }
}

/** 合约对象（GET /contracts/{contract}）。 */
export function contractDetail(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...contractRow(), order_size_min: '1', leverage_min: '1', maintenance_rate: '0.005', ...over }
}

/** 静态路径 → 允许的方法（假服务器的方法校验表；多方法的在 route() 里写明）。 */
const PUBLIC_PATHS = new Set(['/api/v4/futures/usdt/contracts', '/api/v4/futures/usdt/tickers'])
const isPublicPath = (path: string): boolean => PUBLIC_PATHS.has(path) || path.startsWith('/api/v4/futures/usdt/contracts/')

interface Route { kind: string; methods: string[]; param: string }

/** 把路径解析成 {kind, methods, param}；未知路径返回 undefined。 */
function route(path: string): Route | undefined {
  const prefix = '/api/v4/futures/usdt'
  if (!path.startsWith(prefix)) return undefined
  const rest = path.slice(prefix.length)
  if (rest === '/contracts' || rest === '/tickers' || rest === '/accounts' || rest === '/positions'
    || rest === '/my_trades' || rest === '/account_book') {
    return { kind: rest.slice(1), methods: ['GET'], param: '' }
  }
  if (rest === '/orders') return { kind: 'orders', methods: ['GET', 'POST', 'DELETE'], param: '' }
  if (rest === '/price_orders') return { kind: 'price_orders', methods: ['GET', 'POST', 'DELETE'], param: '' }
  const orderOne = /^\/orders\/([^/]+)$/.exec(rest)
  if (orderOne) return { kind: 'order_one', methods: ['GET', 'DELETE'], param: decodeURIComponent(orderOne[1]!) }
  const priceOne = /^\/price_orders\/([^/]+)$/.exec(rest)
  if (priceOne) return { kind: 'price_order_one', methods: ['GET', 'DELETE'], param: decodeURIComponent(priceOne[1]!) }
  const contractOne = /^\/contracts\/([^/]+)$/.exec(rest)
  if (contractOne) return { kind: 'contract_one', methods: ['GET'], param: decodeURIComponent(contractOne[1]!) }
  const leverage = /^\/positions\/([^/]+)\/leverage$/.exec(rest)
  if (leverage) return { kind: 'leverage', methods: ['POST'], param: decodeURIComponent(leverage[1]!) }
  const positionOne = /^\/positions\/([^/]+)$/.exec(rest)
  if (positionOne) return { kind: 'position_one', methods: ['GET'], param: decodeURIComponent(positionOne[1]!) }
  return undefined
}

const invalidParam = (name: string): Response =>
  json({ label: 'INVALID_PARAM_VALUE', message: `invalid argument: ${name}` }, 400)
const notFoundOrder = (id: string): Response =>
  json({ label: 'ORDER_NOT_FOUND', message: `order ${id} not found` }, 404)

const hasBodyValue = (obj: Record<string, unknown>, name: string): boolean =>
  obj[name] !== undefined && obj[name] !== null && String(obj[name]) !== ''

/** 按 contract 过滤（给了才过滤）+ limit / offset 切片（缺省 0 / 100）。 */
function paged(rows: unknown[], q: URLSearchParams, contractOf: (row: Record<string, unknown>) => string): unknown[] {
  const contract = q.get('contract')
  const matched = contract === null || contract === ''
    ? rows
    : rows.filter((row) => row !== null && typeof row === 'object' && contractOf(row as Record<string, unknown>) === contract)
  const limitRaw = Number(q.get('limit') ?? 100)
  const offsetRaw = Number(q.get('offset') ?? 0)
  const limit = Number.isFinite(limitRaw) && limitRaw >= 0 ? Math.floor(limitRaw) : 100
  const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? Math.floor(offsetRaw) : 0
  return matched.slice(offset, offset + limit)
}

/** 必填参数校验：缺参回 Gate 的真实错误（400 INVALID_PARAM_VALUE）。 */
function missingParam(kind: string, method: string, p: Record<string, unknown>, q: URLSearchParams): string | undefined {
  const has = (name: string): boolean => {
    if (q.has(name) && q.get(name) !== '') return true
    const v = p[name]
    return v !== undefined && v !== null && String(v) !== ''
  }
  const first = (...names: string[]): string | undefined => names.find((n) => !has(n))
  switch (kind) {
    case 'orders':
      if (method === 'POST') {
        if (!has('contract')) return 'contract'
        if (!has('size')) return 'size'
        if (!has('price')) return 'price'
        if (!has('tif')) return 'tif'
        return undefined
      }
      return method === 'DELETE' ? first('contract') : first('status')
    case 'price_orders': {
      if (method === 'POST') {
        const initial = (p['initial'] !== null && typeof p['initial'] === 'object' ? p['initial'] : {}) as Record<string, unknown>
        const trigger = (p['trigger'] !== null && typeof p['trigger'] === 'object' ? p['trigger'] : {}) as Record<string, unknown>
        if (!hasBodyValue(initial, 'contract')) return 'initial.contract'
        if (!hasBodyValue(initial, 'size') && !hasBodyValue(initial, 'amount')) return 'initial.size'
        if (!hasBodyValue(initial, 'price')) return 'initial.price'
        if (!hasBodyValue(trigger, 'price')) return 'trigger.price'
        if (!hasBodyValue(trigger, 'rule')) return 'trigger.rule'
        return undefined
      }
      return method === 'DELETE' ? first('contract') : first('status')
    }
    case 'account_book':
      return first('type')
    case 'leverage':
      if (!has('leverage')) return 'leverage'
      // 全仓（leverage=0）必须带 cross_leverage_limit。
      if (q.get('leverage') === '0' && !has('cross_leverage_limit')) return 'cross_leverage_limit'
      return undefined
    default:
      return undefined
  }
}

export class FakeGate {
  calls: Call[] = []
  contracts: unknown[] = [
    contractRow(),
    contractRow({ name: 'ETH_USDT', order_price_round: '0.01', order_size_min: '0.1', quanto_multiplier: '0.01', leverage_max: '75' }),
    contractRow({ name: 'OLD_USDT', status: 'delisted' }),
  ]
  ticker: unknown[] = [{ contract: 'BTC_USDT', last: '100.15', highest_bid: '100.1', lowest_ask: '100.2', mark_price: '100.1', funding_rate: '0.0001', total_size: '1000' }]
  account: Record<string, unknown> = {
    currency: 'USDT',
    total: '1020.5',
    unrealised_pnl: '20.5',
    position_margin: '99',
    order_margin: '5.5',
    available: '900.25',
    point: '0',
    in_dual_mode: false,
    position_mode: 'single',
    enable_credit: false,
  }
  positions: unknown[] = [
    {
      contract: 'BTC_USDT', size: '100', leverage: '10', mode: 'single', entry_price: '99000', mark_price: '100000',
      value: '1000', margin: '99', unrealised_pnl: '10', realised_pnl: '2', liq_price: '90000',
      create_time: 1_791_483_400, update_time: 1_791_483_430,
    },
    {
      contract: 'ETH_USDT', size: '-250', leverage: '20', mode: 'single', entry_price: '3100', mark_price: '3000',
      value: '7500', margin: '375', unrealised_pnl: '250', realised_pnl: '0', liq_price: '3900',
      create_time: 1_791_483_300, update_time: 1_791_483_420,
    },
    {
      contract: 'SOL_USDT', size: '0', leverage: '5', mode: 'single', entry_price: '0', mark_price: '150',
      value: '0', margin: '0', unrealised_pnl: '0', realised_pnl: '0', liq_price: '0',
      create_time: 1_791_483_200, update_time: 1_791_483_410,
    },
  ]
  openOrders: unknown[] = [
    {
      id: 7001, text: 't-open-1', contract: 'BTC_USDT', size: '100', left: '40', price: '99000', fill_price: '0',
      status: 'open', finish_as: '', create_time: 1_791_483_410, reduce_only: false,
    },
  ]
  finishedOrders: unknown[] = [
    {
      id: 7101, text: 't-done-1', contract: 'BTC_USDT', size: '-50', left: '0', price: '101000', fill_price: '100900',
      status: 'finished', finish_as: 'filled', create_time: 1_791_483_300, reduce_only: true,
    },
  ]
  myTrades: unknown[] = [
    {
      id: 90001, create_time: 1_791_483_420.5, contract: 'BTC_USDT', order_id: '7001', size: '60',
      price: '100100', role: 'taker', text: 't-open-1', fee: '0.006', point_fee: '0',
    },
    {
      id: 90002, create_time: 1_791_483_425.25, contract: 'BTC_USDT', order_id: '7001', size: '0',
      price: '100100', role: 'maker', text: 't-open-1', fee: '0', point_fee: '0', close_size: '0',
    },
  ]
  accountBook: unknown[] = [
    { id: 'f-1', time: 1_791_480_000, contract: 'BTC_USDT', change: '0.1234', type: 'fund' },
    { id: 'f-2', time: 1_791_451_200, contract: 'BTC_USDT', change: '-0.05', type: 'fund' },
  ]
  /** 未触发的触发单（price_orders）。 */
  priceOrders: unknown[] = []
  /** 已终结的触发单（撤掉 / 触发过的）。 */
  finishedPriceOrders: unknown[] = []
  /** 新建触发单返回的 id（大整数，验精度）。 */
  priceOrderId = '2111713079019438081'
  /** 撤掉的触发单 id 记录。 */
  deletedTriggers: string[] = []
  /** 按合约全撤的调用记录（`${path}?contract=${c}`）。 */
  cancelAllCalls: string[] = []
  /** 下单响应构造器（可覆盖）。 */
  orderResponse: (body: Record<string, unknown>) => Record<string, unknown> = (body) => ({
    id: 8001,
    text: String(body['text'] ?? ''),
    contract: String(body['contract'] ?? ''),
    size: String(body['size'] ?? ''),
    left: String(body['size'] ?? ''),
    price: String(body['price'] ?? ''),
    fill_price: '0',
    status: 'open',
    finish_as: '',
    create_time: 1_791_483_430,
    reduce_only: body['reduce_only'] === true,
  })
  leverageResponse: (param: string, q: URLSearchParams) => unknown = (param, q) => ({
    contract: param,
    leverage: q.get('leverage') === '0' ? '0' : q.get('leverage'),
    cross_leverage_limit: q.get('cross_leverage_limit') ?? '0',
  })
  /** `${METHOD} ${path}` / path → 强制响应（长期 / 一次性）。 */
  failWith = new Map<string, () => Response>()
  failOnce = new Map<string, () => Response>()
  /** 是否校验签名（少数测试要单独关掉）。 */
  verifySignature = true
  signErrorStatus = 401
  /** 删除成功的订单 id 记录（断言 DELETE 打到了对的 id）。 */
  deleted: string[] = []

  readonly fetch: typeof fetch = async (input, init) => {
    const raw = String(input)
    const url = new URL(raw)
    const method = (init?.method ?? 'GET').toUpperCase()
    const headers = normalizeHeaders(init?.headers)
    const body = typeof init?.body === 'string' ? init.body : ''
    const query = url.searchParams.toString()
    const params = new URLSearchParams(url.searchParams)
    this.calls.push({ method, path: url.pathname, query, body, headers, params, url: raw })

    const forced = this.failWith.get(`${method} ${url.pathname}`) ?? this.failWith.get(url.pathname)
    if (forced) return forced()
    const once = this.failOnce.get(`${method} ${url.pathname}`) ?? this.failOnce.get(url.pathname)
    if (once) {
      this.failOnce.delete(`${method} ${url.pathname}`)
      this.failOnce.delete(url.pathname)
      return once()
    }

    const matched = route(url.pathname)
    if (matched === undefined) return json({ label: 'NOT_FOUND', message: `unknown path ${url.pathname}` }, 404)
    // 方法校验（工单教训 2）：已知路径用错方法回 405。
    if (!matched.methods.includes(method)) {
      return json({ label: 'METHOD_NOT_ALLOWED', message: `method ${method} not allowed for ${url.pathname}` }, 405)
    }

    if (this.verifySignature && !isPublicPath(url.pathname)) {
      const key = headers['key'] ?? ''
      const ts = headers['timestamp'] ?? ''
      const sign = headers['sign'] ?? ''
      if (key === '' || ts === '' || sign === '') {
        return json({ label: 'INVALID_SIGNATURE', message: 'missing KEY / Timestamp / SIGN header' }, this.signErrorStatus)
      }
      if (key !== API_KEY) return json({ label: 'INVALID_KEY', message: 'invalid api key' }, this.signErrorStatus)
      if (!/^\d{10}$/.test(ts)) return json({ label: 'REQUEST_EXPIRED', message: 'timestamp must be unix seconds' }, this.signErrorStatus)
      const expectedSign = signatureOf(API_SECRET, ts, method, url.pathname, query, body)
      if (expectedSign !== sign) {
        return json({ label: 'INVALID_SIGNATURE', message: 'signature mismatch' }, this.signErrorStatus)
      }
    }

    let parsedBody: Record<string, unknown> = {}
    if (body !== '') {
      try {
        parsedBody = JSON.parse(body) as Record<string, unknown>
      } catch {
        return json({ label: 'INVALID_REQUEST_BODY', message: 'body is not JSON' }, 400)
      }
    }
    const missing = missingParam(matched.kind, method, parsedBody, params)
    if (missing !== undefined) return invalidParam(missing)

    switch (matched.kind) {
      case 'contracts':
        return json(this.contracts)
      case 'contract_one': {
        const found = (this.contracts as Array<Record<string, unknown>>).find((c) => c['name'] === matched.param)
        return found === undefined
          ? json({ label: 'CONTRACT_NOT_FOUND', message: `contract ${matched.param} not found` }, 400)
          : json({ ...found, order_size_min: String(found['order_size_min'] ?? '1') })
      }
      case 'tickers':
        return json(this.ticker)
      case 'accounts':
        return json(this.account)
      case 'positions': {
        const rows = params.get('holding') === 'true'
          ? (this.positions as Array<Record<string, unknown>>).filter((row) => String(row['size'] ?? '0') !== '0')
          : this.positions
        return json(paged(rows as unknown[], params, (row) => String(row['contract'] ?? '')))
      }
      case 'position_one': {
        const found = (this.positions as Array<Record<string, unknown>>).find((row) => row['contract'] === matched.param)
        return found === undefined
          ? json({ label: 'POSITION_NOT_FOUND', message: `position ${matched.param} not found` }, 404)
          : json(found)
      }
      case 'orders': {
        if (method === 'POST') return json(this.orderResponse(parsedBody))
        if (method === 'DELETE') {
          const contract = params.get('contract') ?? ''
          this.cancelAllCalls.push(`${url.pathname}?contract=${contract}`)
          const removed: unknown[] = []
          this.openOrders = this.openOrders.filter((row) => {
            if (String((row as Record<string, unknown>)['contract'] ?? '') === contract) { removed.push(row); return false }
            return true
          })
          return json(removed)
        }
        const status = params.get('status') ?? 'open'
        const rows = status === 'finished' ? this.finishedOrders : this.openOrders
        return json(paged(rows as unknown[], params, (row) => String(row['contract'] ?? '')))
      }
      case 'price_orders': {
        if (method === 'POST') {
          this.priceOrders.push({
            id_string: this.priceOrderId,
            status: 'open',
            initial: parsedBody['initial'] ?? {},
            trigger: parsedBody['trigger'] ?? {},
            order_type: parsedBody['order_type'] ?? '',
            create_time: NOW / 1000,
          })
          // 不带引号的大整数：验 parseJsonExact 的精度。
          return new Response(`{"id":${this.priceOrderId}}`, { status: 201, headers: { 'content-type': 'application/json' } })
        }
        if (method === 'DELETE') {
          const contract = params.get('contract') ?? ''
          this.cancelAllCalls.push(`${url.pathname}?contract=${contract}`)
          const removed: unknown[] = []
          this.priceOrders = this.priceOrders.filter((row) => {
            const c = (row as { initial?: { contract?: unknown } }).initial?.contract
            if (String(c ?? '') === contract) { removed.push(row); return false }
            return true
          })
          return json(removed)
        }
        return json(paged(this.priceOrders, params, (row) => String((row['initial'] as { contract?: unknown } | undefined)?.contract ?? '')))
      }
      case 'price_order_one': {
        const idOf = (row: unknown): string => {
          const r = row as { id_string?: unknown; id?: unknown }
          return String(r.id_string ?? r.id ?? '')
        }
        if (method === 'DELETE') {
          const index = this.priceOrders.findIndex((row) => idOf(row) === matched.param)
          if (index < 0) return notFoundOrder(matched.param)
          const [row] = this.priceOrders.splice(index, 1)
          this.finishedPriceOrders.push({ ...(row as Record<string, unknown>), status: 'finished', finish_as: 'cancelled' })
          this.deletedTriggers.push(matched.param)
          return json(row)
        }
        const all = [...this.priceOrders, ...this.finishedPriceOrders]
        const found = all.find((row) => idOf(row) === matched.param)
        return found === undefined ? notFoundOrder(matched.param) : json(found)
      }
      case 'order_one': {
        if (method === 'DELETE') {
          const known = (this.openOrders as Array<Record<string, unknown>>).some((o) => String(o['id']) === matched.param)
          if (!known) return notFoundOrder(matched.param)
          this.deleted.push(matched.param)
          return json({ id: matched.param, status: 'cancelled' })
        }
        const all = [...(this.openOrders as Array<Record<string, unknown>>), ...(this.finishedOrders as Array<Record<string, unknown>>)]
        const row = all.find((o) => String(o['id']) === matched.param)
        return row === undefined ? notFoundOrder(matched.param) : json(row)
      }
      case 'my_trades':
        return json(paged(this.myTrades, params, (row) => String(row['contract'] ?? '')))
      case 'account_book':
        return json(this.accountBook)
      case 'leverage':
        return json(this.leverageResponse(matched.param, params))
      default:
        return json({ label: 'NOT_FOUND', message: `unhandled ${matched.kind}` }, 404)
    }
  }

  callsTo(path: string): Call[] { return this.calls.filter((c) => c.path === path) }
  callsFor(method: string, path: string): Call[] { return this.calls.filter((c) => c.method === method && c.path === path) }
  last(): Call | undefined { return this.calls[this.calls.length - 1] }
  bodyOf(index: number): Record<string, unknown> {
    const call = this.calls[index]
    return call === undefined || call.body === '' ? {} : (JSON.parse(call.body) as Record<string, unknown>)
  }
  lastBody(): Record<string, unknown> {
    const call = this.calls[this.calls.length - 1]
    return call === undefined || call.body === '' ? {} : (JSON.parse(call.body) as Record<string, unknown>)
  }
  fail(method: string, path: string, body: unknown, status = 400, headers: Record<string, string> = {}): void {
    this.failWith.set(`${method} ${path}`, () => json(body, status, headers))
  }
  failNext(method: string, path: string, body: unknown, status = 400, headers: Record<string, string> = {}): void {
    this.failOnce.set(`${method} ${path}`, () => json(body, status, headers))
  }
  /** 复位到出厂数据：测试之间不能互相污染（例如某条测试把账户改成双仓）。 */
  reset(): void {
    const fresh = new FakeGate()
    this.calls = []
    this.failWith.clear()
    this.failOnce.clear()
    this.deleted = []
    this.contracts = fresh.contracts
    this.ticker = fresh.ticker
    this.account = fresh.account
    this.positions = fresh.positions
    this.openOrders = fresh.openOrders
    this.finishedOrders = fresh.finishedOrders
    this.myTrades = fresh.myTrades
    this.accountBook = fresh.accountBook
    this.priceOrders = fresh.priceOrders
    this.finishedPriceOrders = fresh.finishedPriceOrders
    this.priceOrderId = fresh.priceOrderId
    this.deletedTriggers = []
    this.cancelAllCalls = []
    this.orderResponse = fresh.orderResponse
    this.leverageResponse = fresh.leverageResponse
    this.verifySignature = true
    this.signErrorStatus = 401
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
