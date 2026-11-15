// SPDX-License-Identifier: CPAL-1.0
// 离线假 Bitget v2 mix 服务：进程内按「方法 + 路径」回答，不开端口、不联网、不读夹具文件。
// 形状照 packages/connector-binance-trade/test/helpers/fake-binance-trade.ts（CPAL-1.0）改成 Bitget v2 口径：
//   · **复算签名**：base64(HMAC-SHA256(secret, ts + METHOD + path(+query) + body))，与实现同一个串（QD bitget.py:198-241）；
//   · **校验方法**：已知路径用错方法回 405，防止「DELETE 写成 POST」这类错在测试里被放过（工单教训 2）；
//   · **校验必填参数**：缺参回信封 code '40001'（HTTP 400，Bitget 的真实形态）；
//   · 信封 `{code:'00000', msg:'success', data}`；业务错误回 HTTP 400 + 信封（也测 200 信封）。
import { signatureOf } from '../../src/rest'

export const API_KEY = 'test-bitget-key'
export const API_SECRET = 'test-bitget-secret-not-real'
export const PASSPHRASE = 'test-bitget-passphrase'
export const BASE_URL = 'http://bitget.example.test'
export const NOW = 1_791_483_435_048

export const json = (o: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json', ...headers } })

export interface Call {
  method: string
  path: string
  /** 签名用的 query（GET）或空串。 */
  query: string
  body: string
  headers: Record<string, string>
  params: URLSearchParams
  url: string
}

/** 一条合约（永续、可交易）：pricePlace=1 / priceEndStep=1 → tick 0.1；volumePlace=3 → step 0.001。 */
export function contractRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    symbol: 'BTCUSDT',
    baseCoin: 'BTC',
    quoteCoin: 'USDT',
    symbolType: 'perpetual',
    symbolStatus: 'normal',
    pricePlace: '1',
    priceEndStep: '1',
    volumePlace: '3',
    minTradeNum: '0.001',
    minTradeUSDT: '5',
    maxLever: '125',
    fundInterval: '8',
    contractSize: '1',
    ...over,
  }
}

/** 已知路径 → 允许的方法（假服务器的方法校验表）。 */
const METHODS: Record<string, string> = {
  '/api/v2/mix/market/contracts': 'GET',
  '/api/v2/mix/market/ticker': 'GET',
  '/api/v2/mix/market/merge-depth': 'GET',
  '/api/v2/mix/market/candles': 'GET',
  '/api/v2/mix/market/current-fund-rate': 'GET',
  '/api/v2/mix/account/accounts': 'GET',
  '/api/v2/mix/account/account': 'GET',
  '/api/v2/mix/position/all-position': 'GET',
  '/api/v2/mix/order/orders-pending': 'GET',
  '/api/v2/mix/order/orders-plan-pending': 'GET',
  '/api/v2/mix/order/fills': 'GET',
  '/api/v2/mix/order/detail': 'GET',
  '/api/v2/common/trade-rate': 'GET',
  '/api/v2/mix/order/place-order': 'POST',
  '/api/v2/mix/order/place-plan-order': 'POST',
  '/api/v2/mix/order/place-tpsl-order': 'POST',
  '/api/v2/mix/order/cancel-order': 'POST',
  '/api/v2/mix/order/cancel-plan-order': 'POST',
  '/api/v2/mix/order/cancel-all-orders': 'POST',
  '/api/v2/mix/order/modify-order': 'POST',
  '/api/v2/mix/account/set-leverage': 'POST',
}

/** 这个路径是否需要签名（行情是公共端点）。 */
const PUBLIC_PATHS = new Set([
  '/api/v2/mix/market/contracts', '/api/v2/mix/market/ticker', '/api/v2/mix/market/merge-depth',
  '/api/v2/mix/market/candles', '/api/v2/mix/market/current-fund-rate',
])

const MISSING = (name: string): Response => json({ code: '40001', msg: `Parameter does not exist: ${name}`, data: null }, 400)

/** 必填参数校验：缺参 → 上游参数错误（信封 40001）。 */
function missingParam(method: string, path: string, p: Record<string, unknown>, q: URLSearchParams): string | undefined {
  const has = (name: string): boolean => {
    if (method === 'GET') return q.has(name) && q.get(name) !== ''
    const v = p[name]
    return v !== undefined && v !== null && String(v) !== ''
  }
  const first = (...names: string[]): string | undefined => names.find((n) => !has(n))
  switch (`${method} ${path}`) {
    case 'GET /api/v2/mix/account/accounts':
    case 'GET /api/v2/mix/position/all-position':
    case 'GET /api/v2/mix/order/orders-pending':
    case 'GET /api/v2/mix/order/orders-plan-pending':
    case 'GET /api/v2/mix/order/fills':
      return first('productType')
    case 'GET /api/v2/mix/account/account':
      return first('symbol', 'productType', 'marginCoin')
    case 'GET /api/v2/mix/order/detail':
      return has('orderId') || has('clientOid') ? first('productType') : 'orderId'
    case 'POST /api/v2/mix/order/place-order':
      return has('side') || has('tradeSide') ? first('symbol', 'productType', 'marginCoin', 'size') : 'side'
    case 'POST /api/v2/mix/order/place-plan-order':
      return first('symbol', 'productType', 'marginCoin', 'size', 'planType', 'triggerPrice', 'triggerType')
    case 'POST /api/v2/mix/order/place-tpsl-order':
      return first('symbol', 'productType', 'marginCoin', 'size', 'planType', 'triggerPrice', 'holdSide')
    case 'POST /api/v2/mix/order/cancel-order':
      return has('orderId') || has('clientOid') ? first('symbol', 'productType', 'marginCoin') : 'orderId'
    case 'POST /api/v2/mix/order/cancel-all-orders':
      return first('productType', 'marginCoin')
    case 'POST /api/v2/mix/order/modify-order':
      if (!has('orderId') && !has('clientOid')) return 'orderId'
      if (!has('newSize') && !has('newPrice')) return 'newSize'
      return first('symbol', 'productType', 'marginCoin', 'newClientOid')
    case 'POST /api/v2/mix/account/set-leverage':
      return first('symbol', 'productType', 'marginCoin', 'marginMode', 'leverage')
    default:
      return undefined
  }
}

export class FakeBitget {
  calls: Call[] = []
  contracts: unknown[] = [contractRow(), contractRow({ symbol: 'ETHUSDT', baseCoin: 'ETH' }), contractRow({ symbol: 'OLDUSDT', symbolStatus: 'offline' })]
  ticker: unknown = { symbol: 'BTCUSDT', lastPr: '100.15', bidPr: '100.1', askPr: '100.2', high24h: '101', low24h: '99', ts: String(NOW) }
  depth: unknown = { bids: [['100.1', '1.5']], asks: [['100.2', '2.5']], ts: String(NOW) }
  candles: unknown[] = [[String(NOW - 60_000), '100', '101', '99', '100.5', '10', '1000']]
  funding: unknown = { symbol: 'BTCUSDT', fundingRate: '0.0001', nextFundingTime: String(NOW + 28_800_000) }
  accounts: unknown[] = [
    { marginCoin: 'USDT', accountEquity: '1020.5', available: '900.25', locked: '120.25', crossedMaxAvailable: '880', unrealizedPL: '20.5' },
    { marginCoin: 'BGB', accountEquity: '3', available: '3', locked: '0' },
  ]
  positions: unknown[] = [
    {
      symbol: 'BTCUSDT', marginCoin: 'USDT', holdSide: 'long', total: '0.010', available: '0.010', avgPx: '99000',
      markPrice: '100000', marketPrice: '100000', unrealizedPL: '10', achievedProfits: '2', leverage: '10',
      marginSize: '99', keepMarginRate: '0.004', liquidationPrice: '90000', marginMode: 'crossed',
      cTime: String(NOW - 60_000), uTime: String(NOW - 1_000),
    },
    {
      symbol: 'ETHUSDT', marginCoin: 'USDT', holdSide: 'short', total: '2.500', available: '2.500', avgPx: '3100',
      markPrice: '3000', unrealizedPL: '250', achievedProfits: '0', leverage: '20', marginSize: '375',
      keepMarginRate: '0.005', liquidationPrice: '3900', marginMode: 'isolated',
      cTime: String(NOW - 120_000), uTime: String(NOW - 2_000),
    },
    {
      symbol: 'BNBUSDT', marginCoin: 'USDT', holdSide: 'long', total: '5', avgPx: '600', markPrice: '610',
      unrealizedPL: '50', leverage: '5', marginSize: '610', keepMarginRate: '0.004', liquidationPrice: '0',
      marginMode: 'crossed', cTime: String(NOW - 30_000), uTime: String(NOW - 500),
    },
    {
      symbol: 'XRPUSDT', marginCoin: 'USDT', holdSide: 'long', total: '0', avgPx: '0', markPrice: '0.5',
      unrealizedPL: '0', leverage: '5', marginSize: '0', keepMarginRate: '0.004', liquidationPrice: '0',
      marginMode: 'crossed', cTime: String(NOW - 10_000), uTime: String(NOW - 10_000),
    },
  ]
  entrusted: unknown = {
    entrustedList: [
      {
        orderId: '7001', clientOid: 'gt-open-1', symbol: 'BTCUSDT', side: 'buy', orderType: 'limit', price: '99000',
        size: '0.010', baseVolume: '0.004', status: 'live', reduceOnly: 'NO', cTime: String(NOW - 10_000),
      },
    ],
    endId: '',
  }
  planEntrusted: unknown = {
    entrustedList: [
      {
        orderId: '7101', clientOid: 'gt-plan-1', symbol: 'BTCUSDT', side: 'sell', planType: 'normal_plan',
        orderType: 'market', triggerPrice: '88000', size: '0.010', baseVolume: '0', status: 'live', planStatus: 'live',
        cTime: String(NOW - 9_000),
      },
    ],
    endId: '',
  }
  /** profit_loss 族（tpsl 计划行）：官方 / QD 形状（止损是减仓）。 */
  planTpsl: unknown = {
    entrustedList: [
      {
        orderId: '7201', planType: 'loss_plan', symbol: 'BTCUSDT', side: 'sell', holdSide: 'long',
        triggerPrice: '85000', size: '0.010', planStatus: 'live',
      },
    ],
    endId: '',
  }
  /** cancel-plan-order 的响应钩子（测试注入 failureList / 空表）。orderIds 来自 orderIdList。 */
  cancelPlanResponse: ((orderIds: string[]) => { successList?: unknown[]; failureList?: unknown[] }) | undefined = undefined
  fills: unknown = {
    fillList: [
      {
        tradeId: 't-1', orderId: '9001', clientOid: 'gt-fill-1', symbol: 'BTCUSDT', side: 'buy', baseVolume: '0.005',
        fillPrice: '100.1', fillTime: String(NOW - 500), profit: '0', tradeScope: 'taker',
        feeDetail: [{ feeCoin: 'USDT', totalFee: '-0.0002' }],
      },
      {
        tradeId: 't-2', orderId: '9001', clientOid: 'gt-fill-1', symbol: 'BTCUSDT', side: 'buy', baseVolume: '0.005',
        fillPrice: '100.2', fillTime: String(NOW - 400), profit: '0.5', tradeScope: 'maker',
        feeDetail: { newFees: { d: '-0.0000001', r: '-0.0001' } },
      },
    ],
    endId: '',
  }
  orderDetail: unknown = {
    orderId: '9001', clientOid: 'gt-fill-1', symbol: 'BTCUSDT', state: 'partially_filled', priceAvg: '100.15',
    baseVolume: '0.003', cTime: String(NOW - 1_000),
  }
  posMode = 'one_way_mode'
  leverageResponse: (body: Record<string, unknown>) => unknown = (body) => ({
    symbol: body['symbol'], longLeverage: String(body['leverage']), shortLeverage: String(body['leverage']),
  })
  orderResponse: (body: Record<string, unknown>) => unknown = (body) => ({ orderId: '9001', clientOid: String(body['clientOid'] ?? '') })
  planResponse: (body: Record<string, unknown>) => unknown = (body) => ({ orderId: '9101', clientOid: String(body['clientOid'] ?? ''), planType: String(body['planType'] ?? '') })
  /** `${METHOD} ${path}` / path → 强制响应（一次性或长期）。 */
  failWith = new Map<string, () => Response>()
  failOnce = new Map<string, () => Response>()
  /** 缺省 200 信封；签名错误的 HTTP 状态可换。 */
  signErrorStatus = 400

  readonly fetch: typeof fetch = async (input, init) => {
    const raw = String(input)
    const url = new URL(raw)
    const method = (init?.method ?? 'GET').toUpperCase()
    const headers = normalizeHeaders(init?.headers)
    const body = typeof init?.body === 'string' ? init.body : ''
    const query = url.searchParams.toString()
    const params = new URLSearchParams(url.searchParams)
    this.calls.push({ method, path: url.pathname, query, body, headers, params, url: raw })

    const key = `${method} ${url.pathname}`
    const forced = this.failWith.get(key) ?? this.failWith.get(url.pathname)
    if (forced) return forced()
    const once = this.failOnce.get(key) ?? this.failOnce.get(url.pathname)
    if (once) {
      this.failOnce.delete(key)
      this.failOnce.delete(url.pathname)
      return once()
    }

    const expected = METHODS[url.pathname]
    if (expected === undefined) return json({ code: '40404', msg: 'Request URL not found' }, 404)
    if (expected !== method) {
      // 方法校验（工单教训 2）：撤单 / 全撤被写成 DELETE 这类错必须在这里炸出来。
      return json({ code: '405', msg: `Method ${method} not allowed for ${url.pathname}` }, 405)
    }

    // 签名校验（公共端点不收签名，也不校验）。
    if (!PUBLIC_PATHS.has(url.pathname)) {
      const ts = headers['access-timestamp'] ?? ''
      const sign = headers['access-sign'] ?? ''
      const apiKey = headers['access-key'] ?? ''
      const pass = headers['access-passphrase'] ?? ''
      if (apiKey === '' || pass === '' || ts === '' || sign === '') {
        return json({ code: '40009', msg: 'Sign signature error: missing ACCESS-* header' }, this.signErrorStatus)
      }
      if (apiKey !== API_KEY || pass !== PASSPHRASE) {
        return json({ code: '40009', msg: 'Sign signature error: bad credentials' }, this.signErrorStatus)
      }
      const expectedSign = signatureOf(API_SECRET, ts, method, `${url.pathname}${query === '' ? '' : `?${query}`}`, body)
      if (expectedSign !== sign) return json({ code: '40009', msg: 'Sign signature error: signature mismatch' }, this.signErrorStatus)
      if (!/^\d{11,13}$/.test(ts)) return json({ code: '40006', msg: 'Request timestamp expired' }, this.signErrorStatus)
    }

    let parsedBody: Record<string, unknown> = {}
    if (body !== '') {
      try {
        parsedBody = JSON.parse(body) as Record<string, unknown>
      } catch {
        return json({ code: '40001', msg: 'Parameter does not exist: body is not JSON' })
      }
    }
    const missing = missingParam(method, url.pathname, parsedBody, params)
    if (missing !== undefined) return MISSING(missing)

    switch (key) {
      case 'GET /api/v2/mix/market/contracts': return json({ code: '00000', msg: 'success', data: this.contracts })
      case 'GET /api/v2/mix/market/ticker': return json({ code: '00000', msg: 'success', data: this.ticker })
      case 'GET /api/v2/mix/market/merge-depth': return json({ code: '00000', msg: 'success', data: this.depth })
      case 'GET /api/v2/mix/market/candles': return json({ code: '00000', msg: 'success', data: this.candles })
      case 'GET /api/v2/mix/market/current-fund-rate': return json({ code: '00000', msg: 'success', data: this.funding })
      case 'GET /api/v2/mix/account/accounts': return json({ code: '00000', msg: 'success', data: this.accounts })
      case 'GET /api/v2/mix/account/account': return json({ code: '00000', msg: 'success', data: { symbol: params.get('symbol'), posMode: this.posMode } })
      case 'GET /api/v2/mix/position/all-position': return json({ code: '00000', msg: 'success', data: this.positions })
      case 'GET /api/v2/mix/order/orders-pending': return json({ code: '00000', msg: 'success', data: this.entrusted })
      case 'GET /api/v2/mix/order/orders-plan-pending': {
        // 官方 v2：planType 必填，三族 normal_plan / track_plan / profit_loss。
        const planType = params.get('planType') ?? ''
        if (planType !== 'normal_plan' && planType !== 'track_plan' && planType !== 'profit_loss') return MISSING('planType')
        if (planType === 'track_plan') return json({ code: '00000', msg: 'success', data: { entrustedList: null, endId: null } })
        if (planType === 'profit_loss') return json({ code: '00000', msg: 'success', data: this.planTpsl })
        return json({ code: '00000', msg: 'success', data: this.planEntrusted })
      }
      case 'GET /api/v2/mix/order/fills': return json({ code: '00000', msg: 'success', data: this.fills })
      case 'GET /api/v2/mix/order/detail': return json({ code: '00000', msg: 'success', data: this.orderDetail })
      case 'GET /api/v2/common/trade-rate': return json({ code: '00000', msg: 'success', data: { makerFeeRate: '0.0002', takerFeeRate: '0.0006' } })
      case 'POST /api/v2/mix/order/place-order': {
        // 上游在持仓模式与字段不匹配时回 40774（QD bitget.py:294-310 据此换字段重试）。
        if (parsedBody['tradeSide'] !== undefined && parsedBody['reduceOnly'] !== undefined) {
          return json({ code: '40774', msg: 'The position mode does not match the order fields' })
        }
        return json({ code: '00000', msg: 'success', data: this.orderResponse(parsedBody) })
      }
      case 'POST /api/v2/mix/order/place-plan-order': {
        // 官方 v2 字段：orderType 必填，limit 要 price，track_plan 要 callbackRatio；executePrice / rangeRate 只属于 place-tpsl-order。
        const orderType = String(parsedBody['orderType'] ?? '')
        if (orderType === '') return MISSING('orderType')
        if (orderType === 'limit' && (parsedBody['price'] === undefined || String(parsedBody['price']) === '')) return MISSING('price')
        if (String(parsedBody['planType'] ?? '') === 'track_plan' && (parsedBody['callbackRatio'] === undefined || String(parsedBody['callbackRatio']) === '')) return MISSING('callbackRatio')
        for (const name of ['executePrice', 'rangeRate']) {
          if (parsedBody[name] !== undefined) {
            return json({ code: '40017', msg: `Parameter verification failed: ${name} is not a place-plan-order parameter` }, 400)
          }
        }
        return json({ code: '00000', msg: 'success', data: this.planResponse(parsedBody) })
      }
      case 'POST /api/v2/mix/order/place-tpsl-order':
        return json({ code: '00000', msg: 'success', data: { orderId: '9201', clientOid: String(parsedBody['clientOid'] ?? '') } })
      case 'POST /api/v2/mix/order/cancel-order':
        return json({ code: '00000', msg: 'success', data: { orderId: String(parsedBody['orderId'] ?? ''), clientOid: String(parsedBody['clientOid'] ?? '') } })
      case 'POST /api/v2/mix/order/cancel-plan-order': {
        // 官方 v2：按单撤必须带非空 orderIdList；缺 symbol / productType / planType 也是缺参。
        const list = parsedBody['orderIdList']
        if (!Array.isArray(list) || list.length === 0) return MISSING('orderIdList')
        const orderIds: string[] = []
        for (const item of list) {
          if (!item || typeof item !== 'object') return MISSING('orderId')
          const row = item as Record<string, unknown>
          if (row['orderId'] === undefined && row['clientOid'] === undefined) return MISSING('orderId')
          orderIds.push(String(row['orderId'] ?? row['clientOid']))
        }
        for (const name of ['symbol', 'productType', 'planType']) {
          if (parsedBody[name] === undefined || String(parsedBody[name]) === '') return MISSING(name)
        }
        const data = this.cancelPlanResponse?.(orderIds) ?? {
          successList: orderIds.map((id) => ({ orderId: id, clientOid: '' })),
          failureList: [],
        }
        return json({ code: '00000', msg: 'success', data })
      }
      case 'POST /api/v2/mix/order/cancel-all-orders':
        return json({ code: '00000', msg: 'success', data: { symbol: String(parsedBody['symbol'] ?? '') } })
      case 'POST /api/v2/mix/order/modify-order': {
        const newClientOid = String(parsedBody['newClientOid'] ?? '')
        if (newClientOid === '') return MISSING('newClientOid')
        const anchor = parsedBody['orderId'] !== undefined && String(parsedBody['orderId']) !== ''
          ? String(parsedBody['orderId'])
          : String(parsedBody['clientOid'] ?? '')
        return json({ code: '00000', msg: 'success', data: { orderId: `m${anchor}`, clientOid: newClientOid } })
      }
      case 'POST /api/v2/mix/account/set-leverage':
        return json({ code: '00000', msg: 'success', data: this.leverageResponse(parsedBody) })
      default:
        return json({ code: '40404', msg: `unhandled ${key}` }, 404)
    }
  }

  callsTo(path: string): Call[] { return this.calls.filter((c) => c.path === path) }
  callsFor(method: string, path: string): Call[] { return this.calls.filter((c) => c.method === method && c.path === path) }
  last(): Call | undefined { return this.calls[this.calls.length - 1] }
  bodyOf(index: number): Record<string, unknown> {
    const call = this.calls[index]
    return call === undefined || call.body === '' ? {} : (JSON.parse(call.body) as Record<string, unknown>)
  }
  fail(method: string, path: string, body: unknown, status = 200, headers: Record<string, string> = {}): void {
    this.failWith.set(`${method} ${path}`, () => json(body, status, headers))
  }
  failNext(method: string, path: string, body: unknown, status = 200, headers: Record<string, string> = {}): void {
    this.failOnce.set(`${method} ${path}`, () => json(body, status, headers))
  }
  reset(): void {
    this.calls = []
    this.failWith.clear()
    this.failOnce.clear()
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
