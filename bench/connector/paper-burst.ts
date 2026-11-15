// SPDX-License-Identifier: CPAL-1.0
// 连发 500 笔纸面单：耗时与权重占用。
//   snapshot = 模拟场所读连接器用 WS l2Book 订阅维护的本地快照（现行）
//   legacy   = 每笔订单 await 一次 REST 盘口（H 复验时发现的旧行为：约 290 笔后被限速卡住）
// 全部离线：假场所 + 假 WebSocket + 虚拟时钟。预算等待用虚拟时间累计（blockedMs），不真睡；realMs 是本机真实 CPU 耗时。
import { createWeightBudget } from '../../packages/connector-hyperliquid/src/budget'
import { HyperliquidConnector } from '../../packages/connector-hyperliquid/src/connector'
import { FakeHl, FakeWS, FakeWebSocket, loadFixture } from '../../packages/connector-hyperliquid/test/helpers/fake-hl'
import { PaperVenue } from '../../packages/venue-paper/src/venue'
import type { PaperMarket } from '../../packages/venue-paper/src/types'

const START = 1_791_483_435_048
const A = 'acct_burst'

export interface BurstResult {
  mode: 'snapshot' | 'legacy' | 'snapshot-concurrent'
  orders: number
  filled: number
  rejected: number
  /** 本机真实耗时（毫秒）。 */
  realMs: number
  /** 因预算不够而等待的虚拟总时长（毫秒）——旧行为下用户看到的「卡住」。 */
  blockedMs: number
  /** 发给场所的 REST 请求数 / 累计权重 / 其中盘口请求数。 */
  restCalls: number
  weightTotal: number
  l2BookRequests: number
  /** 虚拟时间里最高的滚动 60 s 窗口权重 / 1200。 */
  peakWindowRatio: number
}

async function run(mode: BurstResult['mode'], n: number): Promise<BurstResult> {
  FakeWebSocket.reset()
  const hl = new FakeHl()
  const t = { now: START }
  let blocked = 0
  let peak = 0
  const book = loadFixture('l2Book-BTC.json')
  let ws!: FakeWebSocket
  const budget = createWeightBudget({
    clock: () => t.now,
    sleep: async (ms) => {
      blocked += ms
      t.now += ms
      ws.push({ channel: 'allMids', data: { mids: { BTC: '80957.5' } } }) // 等待期间行情仍在流动（报价保持新鲜）
    },
  })
  const c = new HyperliquidConnector({ environment: 'mainnet', fetchImpl: hl.fetch, WebSocketImpl: FakeWS, useWs: true, discoveryIntervalMs: 0, clock: () => t.now, budget })
  FakeWebSocket.autoReply = (sub) => (sub.type === 'l2Book' ? [{ channel: 'l2Book', data: book }] : undefined)
  await c.market.start()
  ws = FakeWebSocket.last
  ws.open()
  ws.push({ channel: 'bbo', data: { coin: 'BTC', time: t.now, bbo: [{ px: '80957.0', sz: '4.7', n: 19 }, { px: '80958.0', sz: '1', n: 1 }] } })
  const market: PaperMarket = mode === 'legacy'
    ? new Proxy(c, { get: (target, p) => (p === 'bookSnapshot' || p === 'refreshBook' ? undefined : typeof (target as never)[p] === 'function' ? ((target as never)[p] as (...a: unknown[]) => unknown).bind(target) : (target as never)[p]) }) as unknown as PaperMarket
    : c
  const v = new PaperVenue({ market, clock: () => t.now })
  v.createAccount({ accountId: A, initialBalance: '1000000000' })
  const ctx = { account: { accountId: A, address: '0x2222222222222222222222222222222222222222' }, signer: {} } as never
  const intent = (i: number) => ({ accountId: A, instrumentId: 'hyperliquid:BTC', side: i % 2 ? 'sell' : 'buy', type: 'market', size: '0.001', maxSlippageBps: 50, leverage: 10 }) as never
  hl.calls.length = 0
  const w0 = c.http.weightSpent
  const stamps: Array<{ ts: number; w: number }> = []
  let filled = 0
  let rejected = 0
  const count = (r: { acks: Array<{ status: string }> }) => { for (const a of r.acks) a.status === 'filled' ? filled++ : rejected++ }
  const t0 = performance.now()
  if (mode === 'snapshot-concurrent') {
    for (const r of await Promise.all(Array.from({ length: n }, (_, i) => v.submit(ctx, [intent(i)])))) count(r)
  } else {
    for (let i = 0; i < n; i++) {
      count(await v.submit(ctx, [intent(i)]))
      t.now += 50 // 连发：每笔间隔 50 ms
      if (mode !== 'legacy' && i % 10 === 9) ws.push({ channel: 'l2Book', data: book }) // 场所约每 0.5 s 推一次盘口
      if (i % 10 === 9) ws.push({ channel: 'bbo', data: { coin: 'BTC', time: t.now, bbo: [{ px: '80957.0', sz: '4.7', n: 19 }, { px: '80958.0', sz: '1', n: 1 }] } })
      if (i % 20 === 0) { stamps.push({ ts: t.now, w: c.http.weightSpent }); peak = Math.max(peak, windowRatio(stamps)) }
    }
  }
  const realMs = performance.now() - t0
  const l2 = hl.infoCalls('l2Book').length
  await v.close()
  await c.close()
  return {
    mode, orders: n, filled, rejected, realMs: Math.round(realMs), blockedMs: blocked, restCalls: hl.calls.length, weightTotal: c.http.weightSpent - w0,
    l2BookRequests: l2, peakWindowRatio: Number(Math.max(peak, windowRatio(stamps)).toFixed(4)),
  }
}

/** 取样点上的「最近 60 s 累计权重 / 1200」最大值。 */
function windowRatio(stamps: Array<{ ts: number; w: number }>): number {
  let best = 0
  for (let i = 0; i < stamps.length; i++) {
    const end = stamps[i]!
    let j = i
    while (j > 0 && stamps[j - 1]!.ts > end.ts - 60_000) j--
    best = Math.max(best, (end.w - stamps[j]!.w) / 1200)
  }
  return best
}

export async function runPaperBurst(): Promise<{ scenario: string; snapshot: BurstResult; snapshotConcurrent: BurstResult; legacy: BurstResult }> {
  return {
    scenario: '500 paper market orders in a row against the HL connector (offline fixtures, virtual clock)',
    snapshot: await run('snapshot', 500),
    snapshotConcurrent: await run('snapshot-concurrent', 500),
    legacy: await run('legacy', 500),
  }
}
