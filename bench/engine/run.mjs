// SPDX-License-Identifier: CPAL-1.0
// 引擎基准：回测吞吐（根 / 秒）、决策延迟 p50 / p95、52 万根（1 分钟线一年）回测。输出 JSON 到 bench/engine/results/。
//
// 用法：node bench/engine/run.mjs [--bars 525600] [--runs 3] [--decisions 3000] [--out <文件>]
//
// 口径说明（如实写，别当营销数字用）：
//  · 回测吞吐 = K 线根数 / 墙钟秒，含「策略信号计算 + 撮合记账 + 统计」，不含数据加载；合成数据，固定种子。
//  · 决策延迟 = 宿主推一根新 K 线 → 引擎发出 host.order.place 的时间差，进程内内存传输，假宿主应答 0 延迟；
//    它量的是引擎自己的开销（收事件、求信号、取快照、拼意图、序列化），不含网络与真实场所。
//  · 端到端 backtest.run = 经 GEP 任务（宿主分页给 K 线 → 引擎算 → 结果落盘 artifact），含 JSON 编解码。
import { build } from 'esbuild'
import { copyFileSync, mkdirSync, writeFileSync, mkdtempSync, readFileSync } from 'node:fs'
import { cpus, platform, release, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const argv = process.argv.slice(2)
const arg = (name, dflt) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : dflt }
const BARS = Number(arg('bars', 525_600))
const RUNS = Number(arg('runs', 3))
const DECISIONS = Number(arg('decisions', 3000))

// 把引擎库打成一个临时 ESM 文件再 import（和产品一样走 esbuild，不依赖 TS 运行时）
const outDir = mkdtempSync(join(tmpdir(), 'engine-bench-'))
const lib = join(outDir, 'engine-core-lib.mjs')
await build({
  entryPoints: [join(root, 'packages', 'engine-core', 'src', 'index.ts')], bundle: true, platform: 'node', format: 'esm', target: 'node22', outfile: lib,
  external: ['bufferutil', 'utf-8-validate'], banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" }, logLevel: 'warning',
})
const E = await import(pathToFileURL(lib).href)

// 引擎不带策略：基准用的策略文件走和产品一样的加载器（校验 + 工作线程）。测试夹具里的最小均线 + examples/ 里的四个教学示例。
const pkg = join(root, 'packages', 'engine-core')
const STRATEGY_FILES = [join(pkg, 'test', 'fixtures', 'strategies', 'ema-cross.ts'), ...['mean-reversion', 'breakout', 'grid', 'dca'].map((n) => join(pkg, 'examples', 'strategies', `${n}.ts`))]
const DEFS = []
for (const f of STRATEGY_FILES) { const r = await E.loadStrategyFile(f); if (!r.def) throw new Error(`${f}: ${JSON.stringify(r.errors)}`); DEFS.push(r.def) }
const strategiesDir = mkdtempSync(join(tmpdir(), 'engine-bench-strategies-'))
copyFileSync(STRATEGY_FILES[0], join(strategiesDir, 'ema-cross.ts'))

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] }
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))] }
const r2 = (x) => Math.round(x * 100) / 100
const r3 = (x) => Math.round(x * 1000) / 1000
const mem = () => Math.round(process.memoryUsage().rss / 1048576)

const report = {
  suite: 'gitrader-engine-bench', generatedAt: new Date().toISOString(), engine: { id: E.ENGINE_ID, version: E.ENGINE_VERSION },
  env: { node: process.version, platform: `${platform()} ${release()}`, cpu: cpus()[0]?.model ?? 'unknown', cores: cpus().length },
  params: { bars: BARS, runs: RUNS, decisions: DECISIONS, interval: '1m', data: 'synthetic seeded random walk (packages/engine-core/src/util/synth.ts), seed 1' },
}

// ───────── 1. 回测吞吐（同步核心）─────────
console.error(`generating ${BARS} synthetic 1m bars…`)
const t0 = performance.now()
const candles = E.synthCandles({ n: BARS, seed: 1, intervalMs: 60_000 })
report.dataGenMs = Math.round(performance.now() - t0)

report.backtestThroughput = {}
for (const def of DEFS) {
  const id = def.id
  const times = []
  let last
  for (let i = 0; i < RUNS; i++) {
    const s = performance.now()
    last = E.runBacktest(def, candles, def.anchor ? def.anchor(candles.slice(0, 1), def.defaults) : def.defaults, { feeRate: 0.00045, slippageBps: 2 })
    times.push(performance.now() - s)
  }
  const ms = median(times)
  report.backtestThroughput[id] = { barsPerSec: Math.round(BARS / (ms / 1000)), medianMs: Math.round(ms), minMs: Math.round(Math.min(...times)), maxMs: Math.round(Math.max(...times)), fills: last.stats.fills, roundTrips: last.stats.trades }
}
{
  const times = []
  for (let i = 0; i < Math.max(1, RUNS - 1); i++) {
    const s = performance.now()
    await E.backtestWorkflow(JSON.parse(readFileSync(join(pkg, 'examples', 'workflows', 'mean-reversion.json'), 'utf8')), candles, { feeRate: 0.00045, slippageBps: 2 })
    times.push(performance.now() - s)
  }
  const ms = median(times)
  report.backtestThroughput['workflow:mean-reversion'] = { barsPerSec: Math.round(BARS / (ms / 1000)), medianMs: Math.round(ms) }
}
{
  const def = DEFS[0]
  const s = performance.now()
  const r = await E.lookaheadCheck((cs) => def.evaluate(cs, def.defaults), candles)
  report.lookaheadCheck = { result: r.result, checkedBars: r.checkedBars, ms: Math.round(performance.now() - s) }
}
report.memoryRssMb = { afterBacktests: mem() }

// ───────── 2. 假宿主（进程内内存传输）─────────
const BTC = 'hyperliquid:BTC'
const PAPER = 'acct_01JABAPAPER000000000000001'
const MANDATE = 'mdt_01JABAENG01'
const TOKEN = 'bench-token'
const instrument = {
  instrumentId: BTC, venue: 'hyperliquid', symbol: 'BTC', displaySymbol: 'BTC', kind: 'perp', base: 'BTC', quote: 'USDC', settle: 'USDC', settlement: 'linear', contractSize: '1', venueSizeUnit: 'base',
  assetClass: 'crypto', status: 'trading', price: { sigFigs: 5, maxDecimals: 1 }, size: { step: '0.00001', decimals: 5, min: '0.00001' }, minNotional: '10', maxLeverage: 20,
  orderTypes: ['market', 'limit'], tif: ['gtc', 'ioc', 'alo'], triggerPriceTypes: ['mark'], fundingIntervalMs: 3_600_000, fees: { maker: '0.00015', taker: '0.00045', source: 'assumed' }, updatedAt: 0,
}

class MiniHost {
  constructor(core, history) {
    this.history = history
    this.pending = new Map()
    this.nextId = 1
    this.placeTimes = []
    this.onPlace = null
    this.conn = core.connect({ kind: 'memory', maxFrameBytes: 4 * 1024 * 1024, send: (t) => setImmediate(() => this.onFrame(t)), closeTransport: () => {} })
  }
  send(obj) { const text = JSON.stringify(obj); setImmediate(() => void this.conn.peer.receive(text)) }
  sendNow(obj) { void this.conn.peer.receive(JSON.stringify(obj)) }
  request(method, params) {
    const id = this.nextId++
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.send({ jsonrpc: '2.0', id, method, params }) })
  }
  onFrame(text) {
    const m = JSON.parse(text)
    for (const f of Array.isArray(m) ? m : [m]) {
      if (f.method === undefined) { const p = this.pending.get(f.id); if (p) { this.pending.delete(f.id); f.error ? p.reject(new Error(JSON.stringify(f.error))) : p.resolve(f.result) } continue }
      if (f.id === undefined) continue // 通知（events.push / gep.heartbeat …）
      this.answer(f)
    }
  }
  answer(f) {
    const ok = (result) => this.sendNow({ jsonrpc: '2.0', id: f.id, result })
    switch (f.method) {
      case 'host.describe': return ok({ host: { name: 'bench-host', version: '0' }, venues: [], accounts: [{ accountId: PAPER, alias: 'paper', venue: 'hyperliquid', environment: 'mainnet', mode: 'paper' }] })
      case 'host.instruments': return ok({ instruments: [instrument] })
      case 'host.market.history': {
        const { from, to, limit = 300 } = f.params
        const h = this.history
        let lo = 0
        if (from !== undefined) { lo = 0; let a = 0, b = h.length; while (a < b) { const mid = (a + b) >>> 1; if (h[mid].t < from) a = mid + 1; else b = mid } lo = a }
        else if (to === undefined) lo = Math.max(0, h.length - limit)
        const page = []
        for (let i = lo; i < h.length && page.length < limit && (to === undefined || h[i].t <= to); i++) page.push(h[i])
        return ok({ candles: page, source: 'bench', complete: page.length < limit })
      }
      case 'host.account.snapshot': return ok({ balances: [], margin: { accountId: PAPER, model: 'standard', valuationCcy: 'USDC', equity: '10000', initialMargin: '0', maintenanceMargin: '0', available: '10000', marginRatio: '0', leverage: 1, ts: 0 }, positions: [], openOrders: [], ts: 0, attestation: 'kernel-observed' })
      case 'host.order.place': {
        this.placeTimes.push(performance.now())
        this.onPlace?.(f.params)
        return ok({ orderId: `ord_bench${String(this.placeTimes.length).padStart(10, '0')}`, clientOrderId: f.params.clientOrderId, status: 'filled' })
      }
      case 'host.artifact.put': return ok({ artifactId: `art_${f.params.kind}` })
      default: return ok({ subscriptionId: 'sub_bench', ok: true })
    }
  }
  async hello() {
    await this.request('gep.hello', { protocol: 'gep', versions: ['0.1'], host: { name: 'bench-host', version: '0' }, auth: { token: TOKEN } })
    await this.request('engine.bind', { bindingId: 'bind_01JABBENCH', accounts: [{ accountId: PAPER, mode: 'A', mandateId: MANDATE }], data: { source: 'host', instruments: [BTC] }, policies: [], heartbeatMs: 5000 })
  }
}

// ───────── 3. 端到端 backtest.run（52 万根，经 GEP 任务）─────────
{
  const artifactDir = join(outDir, 'artifacts')
  const core = new E.EngineCore({ token: TOKEN, tickMs: 5000, strategiesDir, jobs: { artifactDir, maxBars: 1_000_000 } })
  await core.ready
  const host = new MiniHost(core, candles)
  await host.hello()
  const spec = {
    subject: { strategy: { id: 'ema-trend', version: '0.1.0', params: {} } }, instruments: [BTC], interval: '1m', from: candles[0].t, to: candles[candles.length - 1].t + 60_000,
    data: { source: 'host' }, account: { initialBalance: '10000', ccy: 'USDC', leverage: 1 }, assumptions: { fees: 'venue', slippageBps: 2, fillModel: 'next-bar-open', funding: false, liquidation: false }, seed: 1,
  }
  const rss0 = mem()
  const s = performance.now()
  const { jobId } = await host.request('backtest.run', { spec })
  let st
  do { await new Promise((r) => setTimeout(r, 20)); st = await host.request('backtest.status', { jobId }) } while (st.state !== 'done' && st.state !== 'failed')
  const wall = performance.now() - s
  const result = await host.request('backtest.result', { jobId })
  report.endToEndBacktest = {
    state: st.state, bars: BARS, wallMs: Math.round(wall), barsPerSec: Math.round(BARS / (wall / 1000)), resultInlineEquityPoints: result.equity.length, artifacts: result.artifacts.map((a) => a.kind),
    stats: { fills: result.stats.fills, totalReturnRatio: result.stats.totalReturnRatio, maxDrawdownRatio: result.stats.maxDrawdownRatio }, lookahead: result.biasChecks?.lookahead,
    warnings: result.warnings, rssGrowthMb: mem() - rss0,
  }
  core.close()
}

// ───────── 4. 决策延迟（事件 → 订单意图）─────────
{
  const core = new E.EngineCore({ token: TOKEN, tickMs: 5000, strategiesDir })
  await core.ready
  const warm = candles.slice(0, 400)
  const host = new MiniHost(core, warm)
  await host.hello()
  // 目标仓位每根都变（交替上下），保证每根 K 线都会出一张单：ema 快慢周期取最小，价格走锯齿
  const zig = []
  let px = 80_000
  for (let i = 0; i < DECISIONS + 200; i++) { px += (i % 40 < 20 ? 1 : -1) * 60; zig.push({ t: 1_790_000_000_000 + i * 60_000, o: px - 10, h: px + 30, l: px - 40, c: px, v: 10 }) }
  await host.request('strategy.start', { strategyId: 'ema-trend', accountId: PAPER, instruments: [BTC], interval: '1m', params: { fast: 2, slow: 5, allowShort: true }, mandateId: MANDATE })
  await new Promise((r) => setTimeout(r, 100))
  const push = (i) => host.sendNow({ jsonrpc: '2.0', method: 'events.push', params: { sessionId: 'ses_bench', events: [{ seq: i + 1, eventId: `evt_bench${String(i).padStart(10, '0')}`, stream: 'market', type: 'market.candle', ts: 1, instrumentId: BTC, data: { instrumentId: BTC, interval: '1m', candle: zig[i] } }] } })
  // 预热 200 根（不计）
  for (let i = 0; i < 200; i++) { const before = host.placeTimes.length; push(i); const dl = performance.now() + 40; while (host.placeTimes.length === before && performance.now() < dl) await new Promise((r) => setImmediate(r)) }
  const lat = []
  let missed = 0
  for (let i = 200; i < DECISIONS + 200; i++) {
    const before = host.placeTimes.length
    const t = performance.now()
    push(i)
    const dl = t + 40
    while (host.placeTimes.length === before && performance.now() < dl) await new Promise((r) => setImmediate(r))
    if (host.placeTimes.length > before) lat.push(host.placeTimes[before] - t); else missed += 1
  }
  report.decisionLatencyMs = { samples: lat.length, noOrderForBar: missed, p50: r3(pct(lat, 0.5)), p95: r3(pct(lat, 0.95)), p99: r3(pct(lat, 0.99)), max: r3(Math.max(...lat)), note: 'market event in -> host.order.place out, in-process memory transport, zero-latency fake host' }
  core.close()
}

report.memoryRssMb.final = mem()
mkdirSync(join(here, 'results'), { recursive: true })
const out = arg('out', join(here, 'results', 'engine-bench.json'))
writeFileSync(out, JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report, null, 2))
console.error(`wrote ${out}`)
process.exit(0)
