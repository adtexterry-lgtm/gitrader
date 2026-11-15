// SPDX-License-Identifier: CPAL-1.0
// 五个场所的离线旅程夹具：真连接器（esbuild 打的临时 ESM）+ 各包 test/helpers 的假服务器。
// 假服务器本身是无状态的固定夹具；这里的 fetch 钩子只补「下单 → 查单 → 撤单」这条时间线，
// 让撤单之后查单能看到终态（否则固定夹具永远是 partially_filled，确认撤销这一步永远过不去）。
// 不联网、不开端口、不写仓库内文件；esbuild 的临时目录由 load-connector.mjs 在进程退出时删。
import { loadBundle } from '../../lib/load-connector.mjs'

const ZERO = '0x0000000000000000000000000000000000000000'

export const HARNESS = {
  binance: {
    fakePath: 'packages/connector-binance-trade/test/helpers/fake-binance-trade.ts',
    fakeClass: 'FakeBinanceTrade',
    createPath: '/fapi/v1/order',
    env: (m) => ({ BINANCE_TESTNET_API_KEY: m.API_KEY, BINANCE_TESTNET_API_SECRET: m.API_SECRET }),
    seed: (f) => { f.positionRisk = [] },
    fetch: (f) => async (input, init) => {
      const method = (init?.method ?? 'GET').toUpperCase()
      const url = new URL(String(input))
      if (method === 'POST' && url.pathname === '/fapi/v1/order') {
        f.orderQuery = { symbol: 'BTCUSDT', orderId: 1001, clientOrderId: url.searchParams.get('newClientOrderId'), status: 'NEW', executedQty: '0', avgPrice: '0', type: 'LIMIT' }
      }
      if (method === 'PUT' && url.pathname === '/fapi/v1/order') {
        f.orderQuery = { ...f.orderQuery, price: url.searchParams.get('price') }
      }
      if (method === 'DELETE' && url.pathname === '/fapi/v1/order') {
        f.orderQuery = { ...f.orderQuery, status: 'CANCELED' }
      }
      return f.fetch(input, init)
    },
  },
  okx: {
    fakePath: 'packages/connector-okx-trade/test/helpers/fake-okx-trade.ts',
    fakeClass: 'FakeOkxTrade',
    createPath: '/api/v5/trade/order',
    env: (m) => ({ OKX_DEMO_API_KEY: m.API_KEY, OKX_DEMO_API_SECRET: m.API_SECRET, OKX_DEMO_PASSPHRASE: m.PASSPHRASE }),
    seed: (f) => { f.positions = [] },
    fetch: (f) => async (input, init) => {
      const method = (init?.method ?? 'GET').toUpperCase()
      const url = new URL(String(input))
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {}
      const res = await f.fetch(input, init)
      if (method === 'POST' && url.pathname === '/api/v5/trade/order') {
        f.orderQuery = { instId: body.instId, ordId: '3122698', clOrdId: body.clOrdId, state: 'live', accFillSz: '0', avgPx: '0', sz: body.sz, side: body.side, ordType: body.ordType }
      }
      if (method === 'POST' && url.pathname === '/api/v5/trade/amend-order') {
        f.orderQuery = { ...f.orderQuery, px: body.newPx }
      }
      if (method === 'POST' && url.pathname === '/api/v5/trade/cancel-order') {
        f.orderQuery = { ...f.orderQuery, state: 'canceled' }
      }
      return res
    },
  },
  bybit: {
    fakePath: 'packages/connector-bybit-trade/test/helpers/fake-bybit-trade.ts',
    fakeClass: 'FakeBybitTrade',
    createPath: '/v5/order/create',
    env: (m) => ({ BYBIT_TESTNET_API_KEY: m.API_KEY, BYBIT_TESTNET_API_SECRET: m.API_SECRET }),
    seed: (f) => { f.positions = { category: 'linear', list: [] } },
    fetch: (f) => async (input, init) => {
      const method = (init?.method ?? 'GET').toUpperCase()
      const url = new URL(String(input))
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {}
      const res = await f.fetch(input, init)
      if (method === 'POST' && url.pathname === '/v5/order/create') {
        const payload = await res.clone().json()
        const orderId = String(payload?.result?.orderId ?? '')
        const row = {
          orderId, orderLinkId: body.orderLinkId ?? '', symbol: body.symbol, side: body.side, orderType: body.orderType,
          orderStatus: body.triggerPrice ? 'Untriggered' : 'New', price: body.price ?? '', qty: body.qty,
          cumExecQty: '0', avgPrice: '', triggerPrice: body.triggerPrice ?? '',
          createdTime: String(f.NOW), updatedTime: String(f.NOW),
        }
        f.realtimeOrders = [...f.realtimeOrders.filter((r) => r.orderId !== orderId && r.orderLinkId !== body.orderLinkId), row]
      }
      if (method === 'POST' && url.pathname === '/v5/order/cancel') {
        const id = String(body.orderId ?? '')
        const link = String(body.orderLinkId ?? '')
        const match = (r) => (id !== '' && r.orderId === id) || (link !== '' && r.orderLinkId === link)
        const gone = f.realtimeOrders.filter(match)
        f.realtimeOrders = f.realtimeOrders.filter((r) => !match(r))
        f.historyOrders = gone.map((r) => ({ ...r, orderStatus: 'Cancelled' }))
      }
      return res
    },
  },
  bitget: {
    fakePath: 'packages/connector-bitget-trade/test/helpers/fake-bitget.ts',
    fakeClass: 'FakeBitget',
    createPath: '/api/v2/mix/order/place-order',
    env: (m) => ({ BITGET_DEMO_API_KEY: m.API_KEY, BITGET_DEMO_API_SECRET: m.API_SECRET, BITGET_DEMO_PASSPHRASE: m.PASSPHRASE }),
    seed: (f) => { f.positions = [] },
    fetch: (f) => async (input, init) => {
      const method = (init?.method ?? 'GET').toUpperCase()
      const url = new URL(String(input))
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {}
      const res = await f.fetch(input, init)
      if (method === 'POST' && url.pathname === '/api/v2/mix/order/place-order') {
        f.orderDetail = { orderId: '9001', clientOid: body.clientOid, symbol: body.symbol, state: 'live', priceAvg: '0', baseVolume: '0', cTime: String(f.NOW) }
      }
      if (method === 'POST' && url.pathname === '/api/v2/mix/order/place-plan-order') {
        const list = f.planEntrusted.entrustedList
        f.planEntrusted = {
          entrustedList: [...list, {
            orderId: '9101', clientOid: body.clientOid, symbol: body.symbol, side: body.side,
            planType: body.planType ?? 'normal_plan', orderType: body.orderType ?? 'market',
            triggerPrice: body.triggerPrice ?? '', size: body.size, baseVolume: '0',
            status: 'live', planStatus: 'live', cTime: String(f.NOW),
          }],
          endId: '',
        }
      }
      if (method === 'POST' && url.pathname === '/api/v2/mix/order/cancel-order') {
        f.orderDetail = { ...f.orderDetail, state: 'canceled' }
      }
      if (method === 'POST' && url.pathname === '/api/v2/mix/order/cancel-plan-order') {
        const ids = (body.orderIdList ?? []).map((row) => String(row.orderId ?? row.clientOid ?? ''))
        f.planEntrusted = { entrustedList: f.planEntrusted.entrustedList.filter((row) => !ids.includes(String(row.orderId))), endId: '' }
      }
      return res
    },
  },
  gateio: {
    fakePath: 'packages/connector-gateio-trade/test/helpers/fake-gate.ts',
    fakeClass: 'FakeGate',
    createPath: '/api/v4/futures/usdt/orders',
    env: (m) => ({ GATE_TESTNET_API_KEY: m.API_KEY, GATE_TESTNET_API_SECRET: m.API_SECRET }),
    seed: (f) => { f.positions = [] },
    fetch: (f) => async (input, init) => {
      const method = (init?.method ?? 'GET').toUpperCase()
      const url = new URL(String(input))
      if (method === 'POST' && url.pathname.endsWith('/orders')) {
        const original = f.orderResponse
        f.orderResponse = (body) => {
          const row = original(body)
          f.openOrders = [...f.openOrders.filter((o) => String(o.id) !== String(row.id)), row]
          return row
        }
        const res = await f.fetch(input, init)
        f.orderResponse = original
        return res
      }
      if (method === 'DELETE' && /\/orders\/[^/]+$/.test(url.pathname)) {
        const id = url.pathname.split('/').pop()
        const row = f.openOrders.find((o) => String(o.id) === id)
        const res = await f.fetch(input, init)
        // 假服务器只记 deleted、不把单从挂单表里摘掉；这里补上终态，让「确认撤销」查得到 finished/cancelled。
        if (row) {
          f.openOrders = f.openOrders.filter((o) => String(o.id) !== id)
          f.finishedOrders.push({ ...row, status: 'finished', finish_as: 'cancelled' })
        }
        return res
      }
      return f.fetch(input, init)
    },
  },
}

/** 从 stdout 行里取出 `--json` 打印的那段 JSON。 */
export function parseJsonOutput(lines) {
  // 只认「整行以 { 开头」的那一行：人读模式里的 `Problem: {...}` 是行内 JSON，不能当回执表解析。
  const line = lines.find((candidate) => candidate.trimStart().startsWith('{'))
  if (line === undefined) return undefined
  return JSON.parse(line)
}

/**
 * 跑一遍某场所的旅程。
 * @param {string} venue
 * @param {{ argv?: string[], env?: object, fetchWrap?: (fetchImpl: typeof fetch) => typeof fetch }} [options]
 */
export async function runJourneyFor(venue, options = {}) {
  const harness = HARNESS[venue]
  if (!harness) throw new Error(`no harness for ${venue}`)
  const { fake: mod } = await loadBundle({ fake: harness.fakePath })
  const fake = new mod[harness.fakeClass]()
  harness.seed(fake)
  const journey = await import(`../../journey-${venue}.mjs`)
  const baseFetch = harness.fetch(fake)
  const fetchImpl = options.fetchWrap ? options.fetchWrap(baseFetch) : baseFetch
  const lines = []
  const argv = options.argv ?? ['--json']
  const env = options.env ?? harness.env(mod)
  const code = await journey.main(argv, {
    env,
    stdout: (line) => lines.push(line),
    stderr: (line) => lines.push(line),
    fetchImpl,
    clock: () => Date.now(),
  })
  const steps = parseJsonOutput(lines)
  return { code, lines, fake, mod, env, steps, json: steps }
}

/** 期望的 13 步（顺序即旅程顺序）。 */
export const STEP_NAMES = [
  'connect', 'account', 'precondition-flat', 'instrument', 'reference-price', 'place-limit',
  'query-order', 'amend', 'cancel', 'confirm-cancel', 'place-trigger', 'cancel-trigger', 'positions-flat',
]
