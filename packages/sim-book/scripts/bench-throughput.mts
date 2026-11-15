// SPDX-License-Identifier: CPAL-1.0
// 吞吐基准：合成 100 万条盘口事件（增量 + 逐笔成交），测每秒能处理多少条。
// 两个场景：空簿（只跑盘口状态机）、有一张常驻挂单（队列位置判定每一笔成交都要跑）。
//
// 运行（仓库根，本地 esbuild + node，不联网）：
//   npx esbuild packages/sim-book/scripts/bench-throughput.mts --bundle --platform=node --format=esm \
//     --outfile="$TMPDIR/bench-sim-book.mjs" && node "$TMPDIR/bench-sim-book.mjs"
import { SimBook } from '../src/index'
import type { MarketRecord } from '../src/index'

const EVENTS = 1_000_000
const CYCLES = EVENTS / 4

function buildStream(): MarketRecord[] {
  const out: MarketRecord[] = []
  let ts = 1_700_000_000_000
  for (let i = 0; i < CYCLES; i += 1) {
    const bidSize = (10 + (i % 7) * 0.5).toFixed(2)
    const askSize = (10 + (i % 5) * 0.5).toFixed(2)
    ts += 1
    out.push({ type: 'book_delta', ts, instrument: 'BTCUSDT', side: 'bid', action: 'update', price: '100', size: bidSize })
    ts += 1
    out.push({ type: 'book_delta', ts, instrument: 'BTCUSDT', side: 'ask', action: 'update', price: '101', size: askSize })
    ts += 1
    out.push({ type: 'trade', ts, instrument: 'BTCUSDT', price: '100', size: '0.05', aggressor: 'sell' })
    ts += 1
    out.push({ type: 'trade', ts, instrument: 'BTCUSDT', price: '101', size: '0.05', aggressor: 'buy' })
  }
  return out
}

function seed(book: SimBook): void {
  book.apply({
    type: 'book_snapshot',
    ts: 1,
    instrument: 'BTCUSDT',
    bids: [['100', '10'], ['99.5', '10']],
    asks: [['101', '10'], ['101.5', '10']],
  })
}

function bench(stream: MarketRecord[], withOrder: boolean): { scenario: string; events: number; ms: number; perSec: number; openOrders: number } {
  const book = new SimBook({ instrument: 'BTCUSDT', fillModel: withOrder ? 'queue' : 'optimistic' })
  seed(book)
  if (withOrder) {
    // 常驻挂单：远离盘口，永不被成交，但每笔成交都要走一次队列判定
    book.submit({ id: 'resting', side: 'buy', type: 'limit', qty: '1000000', price: '90' }, 2)
  }
  const started = performance.now()
  for (const record of stream) book.apply(record)
  const ms = performance.now() - started
  return {
    scenario: withOrder ? '常驻挂单（队列位置判定）' : '空簿（纯盘口状态机）',
    events: stream.length,
    ms: Number(ms.toFixed(1)),
    perSec: Math.round(stream.length / (ms / 1000)),
    openOrders: book.openOrders().length,
  }
}

const stream = buildStream()
for (const withOrder of [false, true]) {
  const result = bench(stream, withOrder)
  console.log(
    `${result.scenario}：${result.events.toLocaleString('en-US')} 条 / ${result.ms} ms → ${result.perSec.toLocaleString('en-US')} 条每秒（挂单 ${result.openOrders}）`,
  )
  console.log(JSON.stringify(result))
}
