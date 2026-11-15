// SPDX-License-Identifier: CPAL-1.0
// 连接器基准：行情消息解析吞吐、WS 消息从进来到变成 quote 事件的全路径、模拟场所撮合吞吐与单次下单本地开销。
// 全部离线（夹具 + 假 WebSocket），测的是本地 CPU 开销，不含网络。由 bench/connector/run.mjs 用 esbuild 打包后运行。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { HyperliquidConnector } from '../../packages/connector-hyperliquid/src/connector'
import { parseBook, parseCandles, parseMids } from '../../packages/connector-hyperliquid/src/parse'
import { PaperVenue } from '../../packages/venue-paper/src/venue'
import { runWeightCurve } from './weight-curve'
import { runPaperBurst } from './paper-burst'
import { setFixturesDir } from '../../packages/connector-hyperliquid/test/helpers/fake-hl'
import { TestMarket, ctx, intent, BTC } from '../../packages/venue-paper/test/helpers/test-market'

let fxDir = ''
const load = (n: string) => JSON.parse(readFileSync(join(fxDir, n), 'utf8'))

interface Stat { n: number; opsPerSec: number; p50Us: number; p95Us: number; p99Us: number }

/** 跑 n 次，按批取样延迟（每批 batch 次，取批均值），输出吞吐与 p50 / p95 / p99（微秒 / 次）。 */
function measure(n: number, batch: number, fn: () => void): Stat {
  for (let i = 0; i < Math.min(n, 2000); i++) fn() // 预热
  const samples: number[] = []
  const t0 = performance.now()
  for (let done = 0; done < n; done += batch) {
    const s = performance.now()
    for (let i = 0; i < batch; i++) fn()
    samples.push(((performance.now() - s) * 1000) / batch)
  }
  const total = performance.now() - t0
  samples.sort((a, b) => a - b)
  const q = (p: number) => Number(samples[Math.min(samples.length - 1, Math.floor(samples.length * p))]!.toFixed(3))
  return { n, opsPerSec: Math.round((n / total) * 1000), p50Us: q(0.5), p95Us: q(0.95), p99Us: q(0.99) }
}

async function measureAsync(n: number, fn: () => Promise<unknown>): Promise<Stat> {
  for (let i = 0; i < Math.min(n, 500); i++) await fn()
  const samples: number[] = []
  const t0 = performance.now()
  for (let i = 0; i < n; i++) {
    const s = performance.now()
    await fn()
    samples.push((performance.now() - s) * 1000)
  }
  const total = performance.now() - t0
  samples.sort((a, b) => a - b)
  const q = (p: number) => Number(samples[Math.min(samples.length - 1, Math.floor(samples.length * p))]!.toFixed(3))
  return { n, opsPerSec: Math.round((n / total) * 1000), p50Us: q(0.5), p95Us: q(0.95), p99Us: q(0.99) }
}

// 最小假 WebSocket：只为把消息送进连接器的真实消息路径
class BenchWS {
  static last: BenchWS
  readyState = 1
  private h = new Map<string, Array<(e: unknown) => void>>()
  constructor(readonly url: string) { BenchWS.last = this }
  addEventListener(t: string, f: (e: unknown) => void) { this.h.set(t, [...(this.h.get(t) ?? []), f]) }
  send() {}
  close() {}
  open() { for (const f of this.h.get('open') ?? []) f({}) }
  push(text: string) { for (const f of this.h.get('message') ?? []) f({ data: text }) }
}

export async function runBench(fixturesDir: string): Promise<unknown> {
  fxDir = fixturesDir
  setFixturesDir(fixturesDir)
  const mids = load('allMids.json') as Record<string, string>
  const midsXyz = load('allMids-xyz.json') as Record<string, string>
  const book = load('l2Book-BTC.json')
  const candles = load('candleSnapshot-BTC-1m.json')
  const midsText = JSON.stringify({ channel: 'allMids', data: { mids } })
  const bboText = JSON.stringify({ channel: 'bbo', data: { coin: 'BTC', time: 1, bbo: [{ px: '80000.0', sz: '1', n: 1 }, { px: '80001.0', sz: '2', n: 1 }] } })
  const bookText = JSON.stringify({ channel: 'l2Book', data: book })

  const out: Record<string, unknown> = {
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    fixtures: { allMidsKeys: Object.keys(mids).length, xyzMidsKeys: Object.keys(midsXyz).length, bookLevels: book.levels[0].length + book.levels[1].length, candles: candles.length },
  }

  // ---- 1. 纯解析 ----
  out.parse = {
    allMids: measure(20000, 200, () => parseMids(mids)),
    allMidsXyz: measure(20000, 200, () => parseMids(midsXyz)),
    l2Book: measure(50000, 500, () => parseBook(book, 20)),
    candles: measure(20000, 200, () => parseCandles(candles)),
  }

  // ---- 2. WS 消息 -> 事件 全路径（JSON.parse + 解析 + 缓存 + 事件派发）----
  const fetchStub: typeof fetch = async (input, init) => {
    const body = JSON.parse(String(init?.body ?? '{}'))
    const file = body.type === 'perpDexs' ? 'perpDexs.json' : body.type === 'metaAndAssetCtxs' ? (body.dex ? `metaAndAssetCtxs-${body.dex}.json` : 'metaAndAssetCtxs.json') : null
    return new Response(file ? JSON.stringify(load(file)) : 'null', { status: 200 })
  }
  const c = new HyperliquidConnector({ environment: 'mainnet', fetchImpl: fetchStub, WebSocketImpl: BenchWS as unknown as typeof WebSocket, useWs: true, discoveryIntervalMs: 0 })
  await c.market.start()
  BenchWS.last.open()
  let events = 0
  c.subscribe({ channel: 'quote', instrumentId: BTC }, () => { events++ })
  c.subscribe({ channel: 'book', instrumentId: BTC }, () => { events++ })
  const ws = BenchWS.last
  out.wsPath = {
    allMidsMessage: measure(20000, 200, () => ws.push(midsText)),
    bboToQuoteEvent: measure(100000, 1000, () => ws.push(bboText)),
    l2BookToBookEvent: measure(50000, 500, () => ws.push(bookText)),
    eventsDelivered: events,
  }
  await c.close()

  // ---- 3. 模拟场所：撮合吞吐与单次下单本地开销 ----
  const m = new TestMarket()
  m.books[BTC] = { bids: [[80000, 1e9]], asks: [[80001, 1e9]] }
  const v = new PaperVenue({ market: m, clock: () => m.now })
  v.createAccount({ accountId: 'acct_A', initialBalance: '1000000000' })
  let flip = false
  const market = await measureAsync(20000, async () => {
    flip = !flip
    m.now += 1
    return v.submit(ctx('acct_A'), [intent('acct_A', { side: flip ? 'buy' : 'sell', type: 'market', price: undefined, size: '0.01', maxSlippageBps: 50, leverage: 10 })])
  })
  const v2 = new PaperVenue({ market: m, clock: () => m.now })
  v2.createAccount({ accountId: 'acct_A', initialBalance: '1000000000' })
  const rest = await measureAsync(20000, async () => {
    m.now += 1
    return v2.submit(ctx('acct_A'), [intent('acct_A', { price: '79000', size: '0.01', leverage: 10 })])
  })
  out.paperMatch = { marketOrderFill: market, restingLimitOrder: rest }

  // ---- 4. 权重占用曲线：1 个实盘账户 + 工作台 + 每分钟 10 笔下单 ----
  out.weightCurve = await runWeightCurve()

  // ---- 5. 连发 500 笔纸面单：耗时与权重占用 ----
  out.paperBurst = await runPaperBurst()
  return out
}
