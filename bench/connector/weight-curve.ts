// SPDX-License-Identifier: CPAL-1.0
// 权重占用曲线：1 个实盘账户 + 打开工作台 + 每分钟 10 笔下单，10 分钟（虚拟时间）。
// 对比两种账户读取方式：
//   stream  = WS 用户流增量维护本地快照（现行默认）
//   legacy  = 每次查询都打 REST（H 验收时发现的旧行为）
// 全部离线：假场所（fixtures/hl）+ 假 WebSocket + 虚拟时钟。测的是「向场所发了多少权重」，不含网络时延。
import { createWeightBudget } from '../../packages/connector-hyperliquid/src/budget'
import { HyperliquidConnector } from '../../packages/connector-hyperliquid/src/connector'
import { FakeHl, FakeWS, FakeWebSocket } from '../../packages/connector-hyperliquid/test/helpers/fake-hl'
import { makeTestSigner } from '../../packages/connector-hyperliquid/test/helpers/test-signer'

const MAIN = '0x2222222222222222222222222222222222222222' as const
const START = 1_791_483_435_048

const state = (positions: unknown[]) => ({
  marginSummary: { accountValue: '10000', totalNtlPos: '800', totalMarginUsed: '80' }, crossMaintenanceMarginUsed: '20', withdrawable: '9900', assetPositions: positions, time: START,
})
const zero = () => state([])
const btcPos = (szi: string) => ({ type: 'oneWay', position: { coin: 'BTC', szi, leverage: { type: 'cross', value: 10 }, entryPx: '80000.0', positionValue: '800.0', unrealizedPnl: '1.0', liquidationPx: '72000.0', marginUsed: '80.0', cumFunding: { allTime: '0', sinceOpen: '0', sinceChange: '0' } } })

export interface CurveSample { tSec: number; used: number; ratio: number; trade: number; query: number; background: number }
export interface CurveResult {
  mode: 'stream' | 'legacy'
  durationSec: number
  ordersPlanned: number
  ordersSent: number
  /** 发给场所的 REST 请求总数（info + exchange）。 */
  restCalls: number
  /** 窗口权重 / 1200 的最大值与平均值（采样点上的滚动 60 s 窗口）。 */
  maxRatio: number
  avgRatio: number
  samples: CurveSample[]
}

async function run(mode: 'stream' | 'legacy', durationSec: number, ordersPerMin: number): Promise<CurveResult> {
  FakeWebSocket.reset()
  const hl = new FakeHl()
  const t = { now: START }
  // 测的是『需求』：预算放到不会拦人，曲线 = 这套行为实际会向场所要多少权重（对照 1200 的硬上限与 720 的 60% 目标线）
  const budget = createWeightBudget({ limit: 1_000_000, targetRatio: 1, clock: () => t.now, sleep: async () => { throw new Error('unexpected budget wait') } })
  const open: unknown[] = []
  let positions: unknown[] = []
  hl.info.set('userAbstraction', () => 'default')
  hl.info.set('clearinghouseState', (b) => (b.dex ? zero() : state(positions)))
  hl.info.set('spotClearinghouseState', () => ({ balances: [{ coin: 'USDC', total: '100', hold: '0' }] }))
  hl.info.set('frontendOpenOrders', (b) => (b.dex ? [] : open))
  hl.exchange = (body) => {
    const a = body.action
    if (a.type === 'order') return { status: 'ok', response: { type: 'order', data: { statuses: a.orders.map((_: unknown, i: number) => ({ resting: { oid: 1000 + i } })) } } }
    return { status: 'ok', response: { type: 'default' } }
  }
  const c = new HyperliquidConnector({
    environment: 'mainnet', fetchImpl: hl.fetch, WebSocketImpl: FakeWS, useWs: true, discoveryIntervalMs: 0, clock: () => t.now, budget,
    accounts: { stream: mode === 'stream' },
  })
  const dexes = ['', 'xyz', 'io', 'para', 'mkts']
  FakeWebSocket.autoReply = (sub) => {
    switch (sub.type) {
      case 'allDexsClearinghouseState': return [{ channel: 'allDexsClearinghouseState', data: { user: sub.user, clearinghouseStates: dexes.map((d) => [d, d === '' ? state(positions) : zero()]) } }]
      case 'spotState': return [{ channel: 'spotState', data: { user: sub.user, spotState: { balances: [{ coin: 'USDC', total: '100', hold: '0' }] } } }]
      case 'openOrders': return [{ channel: 'openOrders', data: { dex: sub.dex ?? '', user: sub.user, orders: sub.dex ? [] : open } }]
      case 'userFills': return [{ channel: 'userFills', data: { isSnapshot: true, user: sub.user, fills: [] } }]
      default: return undefined
    }
  }
  await c.market.start()
  const ws = FakeWebSocket.last
  ws.open()
  const signer = makeTestSigner()
  const ref = { accountId: 'acct_bench', address: MAIN, accountModel: 'standard' as const }
  const ctx = { account: ref, signer }
  hl.calls.length = 0

  const samples: CurveSample[] = []
  const perOrderEvery = 60 / ordersPerMin
  let nextOrderAt = 0
  let sent = 0
  let planned = 0
  const end = durationSec
  for (let s = 0; s < end; s++) {
    t.now = Math.max(t.now, START + s * 1000) // 预算等待可能已把虚拟时间推过了整秒：保持单调
    ws.push({ channel: 'allMids', data: { mids: { BTC: '80000.5', ETH: '3500.5' } } }) // 行情在流动，连接保持活着
    // ---- 工作台：每秒读一次账户（状态条 / 持仓 / 挂单 / 成交块），每 2 秒刷一次盘口，每 30 秒刷一次 K 线，上下文自动按 TTL 刷新 ----
    await c.accountView(ref)
    if (s % 2 === 0) await c.book('hyperliquid:BTC', 20)
    if (s % 30 === 0) await c.candles('hyperliquid:BTC', '1m', { n: 300 })
    if (s % 5 === 0) await c.context('hyperliquid:BTC')
    // ---- 交易：每分钟 ordersPerMin 笔限价单（不立即成交），场所随后推来挂单变化 ----
    if (s >= nextOrderAt) {
      nextOrderAt += perOrderEvery
      planned += 1
      const r = await c.submit(ctx, [{ accountId: 'acct_bench', instrumentId: 'hyperliquid:BTC', side: 'buy', type: 'limit', size: '0.001', price: String(70000 + (planned % 50)) } as never])
      if (r.acks[0]!.status === 'open') {
        sent += 1
        open.push({ coin: 'BTC', side: 'B', limitPx: '70000', sz: '0.001', origSz: '0.001', oid: 1000 + planned, timestamp: t.now, orderType: 'Limit' })
        if (open.length > 20) open.shift()
        positions = planned % 7 === 0 ? [btcPos('0.001')] : positions
        ws.push({ channel: 'openOrders', data: { dex: '', user: MAIN, orders: open } })
        ws.push({ channel: 'allDexsClearinghouseState', data: { user: MAIN, clearinghouseStates: dexes.map((d) => [d, d === '' ? state(positions) : zero()]) } })
      }
    }
    if (s % 10 === 0) {
      const u = budget.usage()
      samples.push({ tSec: s, used: u.used, ratio: Number((u.used / 1200).toFixed(4)), trade: u.byKind.trade, query: u.byKind.query, background: u.byKind.background })
    }
  }
  await c.close()
  const ratios = samples.map((x) => x.ratio)
  return {
    mode, durationSec, ordersPlanned: planned, ordersSent: sent,
    restCalls: hl.calls.filter((x) => x.endpoint === 'info').length + hl.calls.filter((x) => x.endpoint === 'exchange').length,
    maxRatio: Math.max(...ratios), avgRatio: Number((ratios.reduce((a, b) => a + b, 0) / ratios.length).toFixed(4)), samples,
  }
}

export async function runWeightCurve(): Promise<{ scenario: string; limitPerMin: number; targetPerMin: number; stream: CurveResult; legacy: CurveResult }> {
  const stream = await run('stream', 600, 10)
  const legacy = await run('legacy', 600, 10)
  return {
    scenario: '1 live account + workbench (account view every 1 s, book every 2 s, candles every 30 s, context every 5 s) + 10 limit orders per minute, 10 virtual minutes',
    limitPerMin: 1200, targetPerMin: 720, stream, legacy,
  }
}
