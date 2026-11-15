// SPDX-License-Identifier: CPAL-1.0
// 离线假 OKX v5 服务：进程内按 方法 + 路径 回答 {code,msg,data} 信封，不开端口、不联网、不读夹具文件。
// 形状照 packages/connector-okx-data/test/helpers/fake-okx.ts（CPAL-1.0）扩出私有端点与请求签名记录。
import { signOkx } from '../../src/rest'
export const API_KEY = 'test-okx-api-key-not-real'
export const API_SECRET = 'test-secret-not-a-real-key'
export const PASSPHRASE = 'test-passphrase-not-real'
export const BASE_URL = 'http://okx.example.test'
export const NOW = 1_791_483_435_048
export const STEP_MS = 60_000

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

export const instruments: unknown[] = [
  swapEntry(),
  swapEntry({ instId: 'ETH-USDT-SWAP', instFamily: 'ETH-USDT', ctVal: '0.1', ctValCcy: 'ETH', tickSz: '0.01', lotSz: '0.01' }),
  swapEntry({ instId: 'BTC-USDC-SWAP', instFamily: 'BTC-USDC', settleCcy: 'USDC', ctVal: '0.0001', ctValCcy: 'BTC' }),
  // 币本位（settleCcy = 标的币）：解析后必须被排除
  swapEntry({ instId: 'BTC-USD-SWAP', instFamily: 'BTC-USD', settleCcy: 'BTC', ctVal: '100', ctValCcy: 'USD' }),
  // 交割合约：instType != SWAP，必须被排除
  swapEntry({ instType: 'FUTURES', instId: 'BTC-USDT-260327' }),
]

export function candleRow(ts: number, price = 100, contracts = 10, ctVal = 0.01): unknown[] {
  const volCcy = Number((contracts * ctVal).toFixed(8))
  return [
    String(ts), String(price), String(price + 1), String(price - 1), String(price + 0.5),
    String(contracts), String(volCcy), String((volCcy * price).toFixed(8)), '1',
  ]
}

export interface Call {
  method: string
  path: string
  url: string
  params: URLSearchParams
  /** 实际发出的请求体原文（GET 为空串）。 */
  body: string
  key: string | null
  sign: string | null
  timestamp: string | null
  /** 是否带 passphrase 头（不记录值本身，避免把密钥写进断言）。 */
  hasPassphrase: boolean
  simulated: string | null
  sentAt: number
}

export const envelope = (data: unknown, code = '0', msg = ''): Response =>
  new Response(JSON.stringify({ code, msg, data }), {
    status: 200, headers: { 'content-type': 'application/json' },
  })

export const json = (o: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json', ...headers } })

export class FakeOkxTrade {
  calls: Call[] = []
  instruments: unknown[] = [...instruments]
  balance: unknown = {
    totalEq: '1000.5',
    imr: '100',
    mmr: '10',
    mgnRatio: '0.00999',
    uTime: String(NOW),
    details: [
      { ccy: 'USDT', eq: '1000.5', cashBal: '1000.5', availBal: '900.5', frozenBal: '100', upl: '2.5' },
      { ccy: 'USDC', eq: '0', cashBal: '0', availBal: '0', frozenBal: '0', upl: '0' },
    ],
  }
  positions: unknown = [
    {
      instId: 'BTC-USDT-SWAP', posSide: 'net', pos: '2', avgPx: '99000', markPx: '100000', upl: '20',
      lever: '10', liqPx: '90000', imr: '200', mmr: '20', mgnMode: 'cross', cTime: String(NOW - 60_000),
      uTime: String(NOW), notionalUsd: '2000',
    },
    {
      instId: 'ETH-USDT-SWAP', posSide: 'short', pos: '10', avgPx: '3000', markPx: '2900', upl: '100',
      lever: '5', liqPx: '4000', mgnMode: 'isolated', cTime: String(NOW - 120_000), uTime: String(NOW),
    },
    { instId: 'BTC-USDT-SWAP', posSide: 'net', pos: '0', avgPx: '0', markPx: '100000', upl: '0', lever: '10' },
  ]
  fills: unknown = [
    {
      instId: 'BTC-USDT-SWAP', tradeId: '77', ordId: '3122698', clOrdId: 'gtopen1', side: 'buy', posSide: 'net',
      fillSz: '2', fillPx: '100000', fee: '-0.02', feeCcy: 'USDT', fillTime: String(NOW - 1_000), execType: 'T',
    },
    {
      instId: 'BTC-USDT-SWAP', tradeId: '78', ordId: '3122698', clOrdId: 'gtopen1', side: 'buy', posSide: 'net',
      fillSz: '1', fillPx: '100100', fee: '0.01', feeCcy: 'USDT', fillTime: String(NOW - 500), execType: 'M',
    },
  ]
  ordersPending: unknown = [
    {
      instId: 'BTC-USDT-SWAP', ordId: '3122698', clOrdId: 'gtopen1', side: 'buy', posSide: 'net', ordType: 'limit',
      sz: '5', px: '99000', accFillSz: '2', avgPx: '99500', state: 'partially_filled', cTime: String(NOW - 10_000),
      uTime: String(NOW), tdMode: 'cross',
    },
  ]
  algoPending: Record<string, unknown> = {
    conditional: [
      {
        instId: 'BTC-USDT-SWAP', algoId: '5566', algoClOrdId: 'gtsl1', side: 'sell', posSide: 'net', ordType: 'conditional',
        sz: '2', slTriggerPx: '95000', slOrdPx: '-1', state: 'live', cTime: String(NOW - 9_000),
      },
    ],
    oco: [],
    move_order_stop: [
      {
        instId: 'ETH-USDT-SWAP', algoId: '7788', algoClOrdId: 'gttrail1', side: 'sell', posSide: 'short',
        ordType: 'move_order_stop', sz: '10', state: 'live', cTime: String(NOW - 8_000),
      },
    ],
  }
  orderQuery: unknown = {
    instId: 'BTC-USDT-SWAP', ordId: '3122698', clOrdId: 'gtopen1', state: 'partially_filled',
    accFillSz: '2', avgPx: '100000', sz: '5', side: 'buy', ordType: 'limit',
  }
  algoQuery: unknown = {
    instId: 'BTC-USDT-SWAP', algoId: '5566', algoClOrdId: 'gtsl1', ordType: 'conditional', state: 'live', sz: '2',
  }
  orderConfig: unknown = { posMode: 'net_mode', acctLv: '2', uid: '123456' }
  /** `${METHOD} ${path}` 或 path → 强制响应。 */
  failWith = new Map<string, () => Response>()
  /** 下单时 body.clOrdId / algoClOrdId 命中它就回 sCode 逐单错误。 */
  rejectClOrdIds = new Map<string, { sCode: string; sMsg: string }>()
  /** 撤单时按 ordId / clOrdId / algoId 命中：逐单 / 批量都回该行的失败码。 */
  cancelFail = new Map<string, { sCode: string; sMsg: string }>()
  /** 下单响应里的 ordId（可改，测对账）。 */
  nextOrdId = '3122698'

  readonly fetch: typeof fetch = async (input, init) => {
    const raw = String(input)
    const url = new URL(raw)
    const method = (init?.method ?? 'GET').toUpperCase()
    const headers = (init?.headers ?? {}) as Record<string, string>
    const body = typeof init?.body === 'string' ? init.body : ''
    this.calls.push({
      method,
      path: url.pathname,
      url: raw,
      params: new URLSearchParams(url.searchParams),
      body,
      key: headers['OK-ACCESS-KEY'] ?? null,
      sign: headers['OK-ACCESS-SIGN'] ?? null,
      timestamp: headers['OK-ACCESS-TIMESTAMP'] ?? null,
      hasPassphrase: headers['OK-ACCESS-PASSPHRASE'] !== undefined,
      simulated: headers['x-simulated-trading'] ?? null,
      sentAt: NOW,
    })

    const key = headers['OK-ACCESS-KEY']
    if (key !== undefined && key !== '') {
      const expected = signOkx(API_SECRET, headers['OK-ACCESS-TIMESTAMP'] ?? '', method, url.pathname + url.search, body)
      if (headers['OK-ACCESS-SIGN'] !== expected) return json({ code: '50113', msg: 'Invalid Sign', data: [] }, 401)
    }

    const forced = this.failWith.get(`${method} ${url.pathname}`) ?? this.failWith.get(url.pathname)
    if (forced) return forced()

    const parsedBody = (): Record<string, string> => {
      try {
        const parsed: unknown = JSON.parse(body)
        return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, string>) : {}
      } catch {
        return {}
      }
    }
    const missing = (name: string): Response => envelope([], '50014', `Parameter ${name} can not be empty`)

    switch (`${method} ${url.pathname}`) {
      case 'GET /api/v5/public/time': return envelope([{ ts: String(NOW) }])
      case 'GET /api/v5/public/instruments': return envelope(this.instruments)
      case 'GET /api/v5/market/ticker':
        return envelope([{ instId: url.searchParams.get('instId'), last: '100.15', askPx: '100.2', bidPx: '100.1', ts: String(NOW) }])
      case 'GET /api/v5/market/books':
        return envelope([{ ts: String(NOW), bids: [['100.0', '1', '0', '1']], asks: [['100.2', '1', '0', '1']] }])
      case 'GET /api/v5/market/candles': return envelope([candleRow(NOW - STEP_MS, 100)])
      case 'GET /api/v5/public/mark-price': return envelope([{ instId: url.searchParams.get('instId'), markPx: '100.05', ts: String(NOW) }])
      case 'GET /api/v5/public/funding-rate':
        return envelope([{ instId: url.searchParams.get('instId'), fundingRate: '0.0001', fundingTime: String(NOW), nextFundingTime: String(NOW + 28_800_000) }])
      case 'GET /api/v5/account/balance': return envelope([this.balance])
      case 'GET /api/v5/account/positions': return envelope(this.positions)
      case 'GET /api/v5/account/config': return envelope([this.orderConfig])
      case 'GET /api/v5/trade/orders-pending': {
        const all = Array.isArray(this.ordersPending) ? this.ordersPending as Array<Record<string, unknown>> : []
        const limit = Number(url.searchParams.get('limit') ?? '100')
        const after = url.searchParams.get('after')
        let start = 0
        if (after !== null) {
          const index = all.findIndex((row) => String(row.ordId ?? '') === after)
          start = index >= 0 ? index + 1 : 0
        }
        return envelope(all.slice(start, start + limit))
      }
      case 'GET /api/v5/trade/orders-algo-pending': {
        const ordType = url.searchParams.get('ordType') ?? ''
        const fixture = this.algoPending[ordType]
        const all = Array.isArray(fixture) ? fixture as Array<Record<string, unknown>> : []
        const limit = Number(url.searchParams.get('limit') ?? '100')
        const after = url.searchParams.get('after')
        let start = 0
        if (after !== null) {
          const index = all.findIndex((row) => String(row.algoId ?? '') === after)
          start = index >= 0 ? index + 1 : 0
        }
        return envelope(all.slice(start, start + limit))
      }
      case 'GET /api/v5/trade/order':
        if (this.orderQuery === null) return envelope([], '51603', 'Order does not exist')
        return envelope([this.orderQuery])
      case 'GET /api/v5/trade/order-algo':
        if (this.algoQuery === null || this.orderQuery === null) return envelope([], '51603', 'Order does not exist')
        return envelope([this.algoQuery])
      case 'GET /api/v5/trade/fills': return envelope(this.fills)
      case 'POST /api/v5/trade/order':
      case 'POST /api/v5/trade/order-algo': {
        const parsed = parsedBody()
        for (const name of ['instId', 'tdMode', 'side', 'ordType', 'sz']) {
          if (parsed[name] === undefined || parsed[name] === '') return missing(name)
        }
        const isAlgo = url.pathname.endsWith('order-algo')
        const ordType = parsed.ordType ?? ''
        if (!isAlgo && ['limit', 'post_only', 'ioc', 'fok'].includes(ordType) && (parsed.px === undefined || parsed.px === '')) {
          return missing('px')
        }
        if (isAlgo && ordType === 'conditional' && (parsed.slTriggerPx === undefined || parsed.slTriggerPx === '') && (parsed.tpTriggerPx === undefined || parsed.tpTriggerPx === '')) {
          return missing('slTriggerPx')
        }
        if (isAlgo && ordType === 'move_order_stop' && (parsed.callbackRatio === undefined || parsed.callbackRatio === '')) {
          return missing('callbackRatio')
        }
        if (isAlgo) {
          const algoClOrdId = parsed.algoClOrdId ?? ''
          const rejected = this.rejectClOrdIds.get(algoClOrdId)
          if (rejected !== undefined) {
            return envelope([{ algoId: '', algoClOrdId, clOrdId: '', sCode: rejected.sCode, sMsg: rejected.sMsg }], '1', 'Operation failed.')
          }
          return envelope([{ algoId: this.nextOrdId, algoClOrdId, clOrdId: '', sCode: '0', sMsg: '', ts: String(NOW) }])
        }
        const clOrdId = parsed.clOrdId ?? 'gt-server'
        const rejected = this.rejectClOrdIds.get(clOrdId)
        if (rejected !== undefined) {
          return envelope([{ ordId: '', clOrdId, sCode: rejected.sCode, sMsg: rejected.sMsg }], '1', 'Operation failed.')
        }
        return envelope([{ ordId: this.nextOrdId, clOrdId, sCode: '0', sMsg: '', ts: String(NOW) }])
      }
      case 'POST /api/v5/trade/cancel-order': {
        const parsed = parsedBody()
        if (parsed.instId === undefined || parsed.instId === '') return missing('instId')
        if ((parsed.ordId === undefined || parsed.ordId === '') && (parsed.clOrdId === undefined || parsed.clOrdId === '')) return missing('ordId')
        const id = parsed.ordId !== undefined && parsed.ordId !== '' ? parsed.ordId : parsed.clOrdId ?? ''
        const failure = this.cancelFail.get(id)
        const row = {
          ordId: parsed.ordId ?? '', algoId: '', clOrdId: parsed.clOrdId ?? '',
          sCode: failure?.sCode ?? '0', sMsg: failure?.sMsg ?? '',
        }
        return failure === undefined ? envelope([row]) : envelope([row], '1', 'Operation failed.')
      }
      case 'POST /api/v5/trade/cancel-batch-orders':
      case 'POST /api/v5/trade/cancel-algos': {
        const parsed = parsedBody()
        const ids = Array.isArray(parsed) ? parsed : [parsed]
        const rows = ids.map((item) => {
          const row = item as Record<string, string>
          const id = row.ordId ?? row.algoId ?? row.clOrdId ?? ''
          const failure = this.cancelFail.get(id)
          return {
            ordId: row.ordId ?? '', algoId: row.algoId ?? '', clOrdId: row.clOrdId ?? '',
            sCode: failure?.sCode ?? '0', sMsg: failure?.sMsg ?? '',
          }
        })
        const failed = rows.filter((row) => row.sCode !== '0').length
        const code = failed === 0 ? '0' : failed === rows.length ? '1' : '2'
        return envelope(rows, code, failed === 0 ? '' : 'Operation failed.')
      }
      case 'POST /api/v5/trade/amend-order':
        return envelope([{ ordId: parsedBody().ordId ?? '', clOrdId: parsedBody().clOrdId ?? '', sCode: '0', sMsg: '' }])
      case 'POST /api/v5/account/set-leverage': {
        const parsed = parsedBody()
        return envelope([{ instId: parsed.instId ?? '', lever: parsed.lever ?? '', mgnMode: parsed.mgnMode ?? '', posSide: parsed.posSide ?? '' }])
      }
      case 'POST /api/v5/trade/cancel-all-after': {
        const timeOut = parsedBody().timeOut
        if (timeOut === undefined || timeOut === '') return missing('timeOut')
        if (timeOut !== '0') {
          const seconds = Number(timeOut)
          if (!Number.isFinite(seconds) || seconds < 10 || seconds > 120) {
            return envelope([], '51000', 'Parameter timeOut error')
          }
        }
        return envelope([{ triggerTime: String(NOW + Number(timeOut) * 1000), tag: '', ts: String(NOW) }])
      }
      default:
        return json({ code: '404', msg: `unhandled ${method} ${url.pathname}`, data: [] }, 404)
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

  reset(): void {
    this.calls = []
    this.failWith.clear()
    this.rejectClOrdIds.clear()
    this.cancelFail.clear()
    this.nextOrdId = '3122698'
  }
}
