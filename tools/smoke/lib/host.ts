// SPDX-License-Identifier: CPAL-1.0
// 冒烟宿主：和 `gitrader serve` 同一条 runServe() 路径（真内核、真 HTTP、真服务令牌），
// 只把连接器装配换成"进程内确定性盘口 + PaperVenue"：没有网络、没有浏览器、没有交易所。
// 由 tools/smoke/journey.mjs 用 esbuild 打成临时 ESM 后在子进程里跑（见 README）。
// 用法：node <bundle> <home> <port>
// stdout 只输出一行 JSON：{"ready":true,"port":N,"pid":N}；日志一律走 stderr。
// stdin 收到 {"cmd":"stop"} 或 stop 行时优雅停机。
import { join } from 'node:path'
import { runServe } from '../../../packages/cli/src/index'
import { PaperVenue } from '@gitrader/venue-paper'

const [home, portArg] = process.argv.slice(2)
if (!home) { process.stderr.write('usage: host <home> [port]\n'); process.exit(2) }

const BTC = 'hyperliquid:BTC'
const MARK = 80_000
const now = () => Date.now()

/** 协议里的 Instrument 形状（字段照 packages/venue-paper/test/helpers/test-market.ts）。 */
const instrument = {
  instrumentId: BTC, venue: 'hyperliquid', symbol: 'BTC', displaySymbol: 'BTC-PERP', kind: 'perp',
  base: 'BTC', quote: 'USDC', settle: 'USDC', settlement: 'linear', contractSize: '1', venueSizeUnit: 'base',
  assetClass: 'crypto', marketGroup: null, status: 'trading',
  price: { sigFigs: 5, maxDecimals: 1 }, size: { step: '0.001', decimals: 3, min: '0.001' },
  minNotional: '10', maxLeverage: 40, marginModes: ['cross'],
  orderTypes: ['market', 'limit', 'stop_market', 'stop_limit', 'take_market', 'take_limit'], tif: ['gtc', 'ioc', 'alo'],
  triggerPriceTypes: ['mark'], fundingIntervalMs: 3_600_000,
  fees: { maker: '0.00015', taker: '0.00045', source: 'assumed' }, updatedAt: 0,
}
const caps = {
  venue: 'hyperliquid', environments: ['mainnet'], instrumentKinds: ['perp'],
  orderTypes: { market: 'emulated', limit: 'native' }, tif: ['gtc', 'ioc', 'alo'], triggerPriceTypes: ['mark'],
  deadman: { method: 'schedule_cancel', minDelaySec: 5, maxTriggersPerDay: 10 },
  signers: { type: 'api-wallet', withdrawCapable: false },
}

/** 固定盘口（bid 79999 / ask 80001 / last 80000），时间戳取当前时刻，风控的"新鲜价格"检查因此永远通过。 */
const market = {
  venue: 'hyperliquid',
  environment: 'mainnet',
  describe: () => caps,
  listInstruments: () => [instrument],
  getInstrument: (id) => (id === BTC ? instrument : undefined),
  quote: (id) => (id === BTC ? { instrumentId: id, ts: now(), bid: MARK - 1, ask: MARK + 1, last: MARK, stale: false, ageMs: 0 } : undefined),
  book: async (id) => {
    if (id !== BTC) throw new Error(`no book for ${id}`)
    return {
      instrumentId: id, ts: now(),
      bids: [{ price: MARK - 1, size: 5 }, { price: MARK - 2, size: 5 }],
      asks: [{ price: MARK + 1, size: 5 }, { price: MARK + 2, size: 5 }],
    }
  },
  candles: async () => [],
  context: async (id) => {
    if (id !== BTC) throw new Error(`no context for ${id}`)
    return { instrumentId: id, ts: now(), markPrice: MARK, midPrice: MARK, fundingRate: 0, fundingIntervalMs: 3_600_000 }
  },
  subscribe: () => () => {},
  status: () => ({ venue: 'hyperliquid', environment: 'mainnet', ts: now(), wsState: 'connected', stale: false, source: 'ws', lastMessageTs: now() }),
}

const io = {
  out: (s) => process.stderr.write(s),
  err: (s) => process.stderr.write(s),
  env: { ...process.env },
  readSecret: async () => { throw new Error('smoke host has no terminal') },
  interactive: false,
}

const h = await runServe(home, {
  ...(portArg ? { port: Number(portArg) } : {}),
  io,
  connect: (k) => {
    const paper = new PaperVenue({ market, clock: () => k.clock.now() })
    k.registerConnector(paper)
    paper.start()
    // 与 `gitrader serve` 一样拉起随包引擎（回测在引擎里跑）。起不来不挡内核，journey 会在第 5 步如实报错。
    try { k.engines.start('gitrader-core') } catch (e) { process.stderr.write(`[smoke] engine start failed: ${String(e)}\n`) }
  },
})

process.stdout.write(JSON.stringify({ ready: true, port: h.port, pid: process.pid, home: join(home) }) + '\n')

let stopping = false
async function stop() {
  if (stopping) return
  stopping = true
  try { await h.stop() } catch { /* 停机失败也要退出 */ }
  setTimeout(() => process.exit(0), 20)
}
process.once('SIGTERM', () => { void stop() })
process.once('SIGINT', () => { void stop() })
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => { if (chunk.includes('stop')) void stop() })
