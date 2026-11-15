// SPDX-License-Identifier: CPAL-1.0
// 一次性夹具导出脚本（跨引擎一致性）：用 packages/engine-core 的 TS 模拟器跑同一份合成 K 线 + 同一策略，
// 把输入（K 线 / 资金费点 / 参数 / 假设）与输出（成交序列 / 逐根权益 / 统计 / 资金费明细）一起写成
// ts-backtest.json。Python 侧 tests/test_backtest.py 读同一份输入、跑同一批策略、逐笔逐点比对（容差 1e-9）。
//
// 用法（仓库根，离线，不联网）：
//   node packages/engine-python/tests/fixtures/export-ts-backtest.mjs
//
// 实现说明：用仓库自带的 esbuild 把 engine-core 的回测入口 + 三个示例策略打成临时 ESM 再 import，
// 不做任何 npm 安装。前三个用例走公开路径 runBacktest()；后三个用例需要 protection / lotStep /
// minLot，而 TS 的 resolveSimOptions（backtest.ts:29-48）不透传这三项，所以这里按 simulateSeries 的
// 逐根门控自己驱动 Simulator（与 simulateSeries 完全同序，仅补上那三个选项）。
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..', '..', '..')
const engineCore = join(repoRoot, 'packages', 'engine-core')

// ---- 1. 打包 engine-core 的回测入口与三个示例策略 -------------------------------
const bundled = await build({
  stdin: {
    contents: [
      "export { runBacktest, resolveSimOptions } from './src/strategy/backtest.ts'",
      "export { Simulator, inferIntervalMs } from './src/strategy/simulator.ts'",
      "export { evaluateStrategy } from './src/strategy/runtime.ts'",
      "export { default as breakout } from './examples/strategies/breakout.ts'",
      "export { default as dca } from './examples/strategies/dca.ts'",
      "export { default as emaCross } from './examples/strategies/ema-cross.ts'",
      "export { default as grid } from './examples/strategies/grid.ts'",
      "export { default as martingale } from './examples/strategies/martingale.ts'",
      "export { default as meanReversion } from './examples/strategies/mean-reversion.ts'",
      "export { default as momentumRoc } from './examples/strategies/momentum-roc.ts'",
      "export { default as rsiReversion } from './examples/strategies/rsi-reversion.ts'",
      "export { default as supertrend } from './examples/strategies/supertrend.ts'",
      "export { default as trendAtr } from './examples/strategies/trend-atr.ts'",
      '',
    ].join('\n'),
    resolveDir: engineCore,
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  write: false,
  logLevel: 'silent',
})
const bundleDir = mkdtempSync(join(tmpdir(), 'gitrader-bt-'))
const bundlePath = join(bundleDir, 'bt.mjs')
writeFileSync(bundlePath, bundled.outputFiles[0].text)
const core = await import(pathToFileURL(bundlePath).href)

const STRATEGIES = {
  breakout: core.breakout, dca: core.dca, 'ema-cross': core.emaCross, grid: core.grid,
  martingale: core.martingale, 'mean-reversion': core.meanReversion,
  'momentum-roc': core.momentumRoc, 'rsi-reversion': core.rsiReversion,
  supertrend: core.supertrend, 'trend-atr': core.trendAtr,
}

// ---- 2. 确定性合成 K 线（mulberry32；同一份输入原样落盘给 Python）---------------
function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const BARS = 600
const INTERVAL_MS = 3_600_000
const START_TS = 1_760_000_000_000

const random = mulberry32(20261021)
const candles = []
let prev = 100
for (let i = 0; i < BARS; i++) {
  // AR(1) 均值回复 + 缓慢移动的水平线：价格在 85–115 之间来回，均线会反复交叉、网格会被反复穿越
  const level = 100 + 11 * Math.sin(i / 95) + 4 * Math.sin(i / 31)
  const pull = (level - prev) * 0.08
  const close = Math.max(5, prev + pull + (random() - 0.5) * 1.5)
  const open = prev
  const high = Math.max(open, close) + random() * 0.35
  const low = Math.min(open, close) - random() * 0.35
  const volume = Math.round((20 + random() * 40) * 100) / 100
  candles.push({ t: START_TS + i * INTERVAL_MS, o: open, h: high, l: low, c: close, v: volume })
  prev = close
}

// 资金费点：每 8 根一个，正负交替（rate 为分数，多头 rate > 0 付钱）
const funding = []
for (let i = 8; i < BARS; i += 8) {
  funding.push({ t: START_TS + i * INTERVAL_MS, rate: (i / 8) % 2 === 0 ? 0.0001 : -0.00008 })
}

// 第二份输入：温和上升后连续两根急跌（压测强平 / 破产分支；同样确定性）
const CRASH_BARS = 60
const crashCandles = []
let crashPrev = 100
for (let i = 0; i < CRASH_BARS; i++) {
  const step = i >= 40 && i < 42 ? -0.22 : 0.003
  const close = crashPrev * (1 + step)
  const open = crashPrev
  const high = Math.max(open, close) * (1 + 0.002)
  const low = Math.min(open, close) * (1 - 0.002)
  crashCandles.push({ t: START_TS + i * INTERVAL_MS, o: open, h: high, l: low, c: close, v: 30 })
  crashPrev = close
}

const BASE_SIM = { initialCash: 10_000, leverage: 1, feeRate: 0.00045, slippageBps: 2 }

// ---- 3. 逐根驱动（simulateSeries 的同序版本，额外透传 protection / lotStep / minLot）----
function simulateWithExtras(series, opts, candles) {
  const resolved = core.resolveSimOptions(opts)
  const extra = {}
  for (const key of ['protection', 'lotStep', 'minLot']) if (opts[key] !== undefined) extra[key] = opts[key]
  const sim = new core.Simulator({ ...resolved, ...extra })
  const stepMs = core.inferIntervalMs(candles)
  for (let i = 0; i < candles.length; i++) {
    const hasSignal = i > 0 && i - 1 >= series.warmup
    sim.onBar(i, candles[i], hasSignal ? series.target[i - 1] : null, hasSignal ? series.reasons[i - 1] || '' : '')
  }
  return { stats: sim.stats(candles, stepMs), equity: sim.equity, trades: sim.trades, funding: sim.funding }
}

// ---- 4. 用例 -------------------------------------------------------------------
const CASES = [
  // ---- 十个示例策略的默认参数（Python 侧传 {}，因此这一步也在对账「默认值一致」）----
  { id: 'ema-cross-defaults', strategy: 'ema-cross', params: {}, simOptions: { ...BASE_SIM }, path: 'runBacktest' },
  {
    id: 'grid-centered',
    strategy: 'grid',
    params: { center: 100, rangeRatio: 0.15, grids: 8, maxExposure: 1, boundaryAction: 'pause', gridMode: 'arithmetic' },
    simOptions: { ...BASE_SIM },
    path: 'runBacktest',
  },
  {
    id: 'dca-take-profit',
    strategy: 'dca',
    params: { everyBars: 24, orders: 10, totalBudgetPct: 100, takeProfitRatio: 0.02, startTs: START_TS },
    simOptions: { ...BASE_SIM },
    path: 'runBacktest',
  },
  { id: 'breakout-defaults', strategy: 'breakout', params: {}, simOptions: { ...BASE_SIM }, path: 'runBacktest' },
  { id: 'martingale-defaults', strategy: 'martingale', params: {}, simOptions: { ...BASE_SIM }, path: 'runBacktest' },
  { id: 'mean-reversion-defaults', strategy: 'mean-reversion', params: {}, simOptions: { ...BASE_SIM }, path: 'runBacktest' },
  { id: 'momentum-roc-defaults', strategy: 'momentum-roc', params: {}, simOptions: { ...BASE_SIM }, path: 'runBacktest' },
  { id: 'rsi-reversion-defaults', strategy: 'rsi-reversion', params: {}, simOptions: { ...BASE_SIM }, path: 'runBacktest' },
  { id: 'supertrend-defaults', strategy: 'supertrend', params: {}, simOptions: { ...BASE_SIM }, path: 'runBacktest' },
  { id: 'trend-atr-defaults', strategy: 'trend-atr', params: {}, simOptions: { ...BASE_SIM }, path: 'runBacktest' },

  // ---- 模拟器参数路径：资金费 / 强平 / 罚金 / 维持保证金 / 成交量上限 / 保护 / 手数归一 / 费率 / 滑点 ----
  {
    id: 'ema-cross-leverage-funding-liquidation-lot',
    strategy: 'ema-cross',
    params: { fast: 8, slow: 34, allowShort: true },
    simOptions: {
      ...BASE_SIM,
      leverage: 5,
      funding,
      liquidation: true,
      maintenanceMarginRatio: 0.02,
      liquidationPenaltyRatio: 0.1,
      lotStep: 0.01,
      minLot: 0.01,
    },
    path: 'simulateSeries+extras',
  },
  {
    id: 'grid-volume-cap',
    strategy: 'grid',
    params: { center: 100, rangeRatio: 0.2, grids: 10, maxExposure: 1, boundaryAction: 'hold', gridMode: 'geometric' },
    simOptions: { ...BASE_SIM, leverage: 2, maxVolumeShare: 0.02 },
    path: 'simulateSeries+extras',
  },
  {
    id: 'dca-protection',
    strategy: 'dca',
    params: { everyBars: 12, orders: 20, totalBudgetPct: 100, takeProfitRatio: 0.05, startTs: START_TS },
    simOptions: {
      ...BASE_SIM,
      protection: { stopLossPct: 0.04, maxHoldBars: 60, trailing: { activationPct: 0.02, trailPct: 0.015 } },
    },
    path: 'simulateSeries+extras',
  },
  {
    id: 'emas-crash-liquidation',
    strategy: 'ema-cross',
    params: { fast: 3, slow: 6, allowShort: true },
    simOptions: {
      ...BASE_SIM,
      leverage: 10,
      liquidation: true,
      maintenanceMarginRatio: 0.03,
      liquidationPenaltyRatio: 0.1,
      lotStep: 0.001,
      minLot: 0.001,
    },
    path: 'simulateSeries+extras',
    candles: 'crash',
  },
  {
    id: 'breakout-fees-slippage-leverage',
    strategy: 'breakout',
    params: { entry: 12, exit: 6, allowShort: true },
    simOptions: { ...BASE_SIM, feeRate: 0.0012, slippageBps: 25, leverage: 3 },
    path: 'simulateSeries+extras',
  },
  {
    id: 'mean-reversion-zero-fees-zero-slippage',
    strategy: 'mean-reversion',
    params: { period: 14, k: 2.2, allowShort: true },
    simOptions: { ...BASE_SIM, feeRate: 0, slippageBps: 0 },
    path: 'simulateSeries+extras',
  },
  {
    id: 'momentum-roc-volume-cap-and-funding',
    strategy: 'momentum-roc',
    params: { lookback: 12, threshold: 0.01, allowShort: true },
    simOptions: { ...BASE_SIM, leverage: 4, maxVolumeShare: 0.5, funding },
    path: 'simulateSeries+extras',
  },
  {
    id: 'rsi-reversion-trailing-and-time-limit',
    strategy: 'rsi-reversion',
    params: { period: 10, lower: 35, upper: 65, exitLevel: 50, allowShort: true },
    simOptions: {
      ...BASE_SIM,
      protection: { takeProfitPct: 0.02, maxHoldBars: 24, trailing: { activationPct: 0.01, trailPct: 0.008 } },
    },
    path: 'simulateSeries+extras',
  },
  {
    id: 'supertrend-max-slippage-max-volume',
    strategy: 'supertrend',
    params: { period: 7, multiplier: 2, allowShort: true },
    simOptions: { ...BASE_SIM, slippageBps: 500, maxVolumeShare: 0.35, lotStep: 0.05, minLot: 0.05 },
    path: 'simulateSeries+extras',
  },
  {
    id: 'trend-atr-liquidation-penalty',
    strategy: 'trend-atr',
    params: { emaFast: 10, emaSlow: 30, atrPeriod: 10, atrMultiple: 2, allowShort: true },
    simOptions: {
      ...BASE_SIM,
      leverage: 8,
      liquidation: true,
      maintenanceMarginRatio: 0.01,
      liquidationPenaltyRatio: 0.25,
      funding,
      lotStep: 0.001,
    },
    path: 'simulateSeries+extras',
  },
]

const cases = []
for (const item of CASES) {
  const def = STRATEGIES[item.strategy]
  if (!def) throw new Error(`unknown strategy: ${item.strategy}`)
  const bars = item.candles === 'crash' ? crashCandles : candles
  let out
  if (item.path === 'runBacktest') {
    out = core.runBacktest(def, bars, item.params, item.simOptions)
  } else {
    const { params, series } = core.evaluateStrategy(def, bars, item.params)
    void params
    out = simulateWithExtras(series, item.simOptions, bars)
  }
  if (out.equity.length !== bars.length) throw new Error(`${item.id}: equity length != candles`)
  if (out.trades.length === 0) throw new Error(`${item.id}: no fills — the fixture would not test anything`)
  if (out.stats.fills !== out.trades.length) throw new Error(`${item.id}: stats.fills mismatch`)
  cases.push({
    id: item.id,
    strategy: item.strategy,
    path: item.path,
    candles: item.candles || 'main',
    params: item.params,
    simOptions: item.simOptions,
    trades: out.trades,
    equity: out.equity,
    stats: out.stats,
    funding: out.funding,
  })
  console.log(`  ${item.id}: ${out.trades.length} fills, ${out.stats.trades} trips, final equity ${out.stats.finalEquity}`)
}

const payload = {
  meta: {
    source: [
      'packages/engine-core/src/strategy/simulator.ts',
      'packages/engine-core/src/strategy/backtest.ts',
      'packages/engine-core/examples/strategies/*.ts (all ten)',
    ],
    script: 'packages/engine-python/tests/fixtures/export-ts-backtest.mjs',
    tolerance: 1e-9,
    bars: BARS,
    intervalMs: INTERVAL_MS,
    startTs: START_TS,
    caseCount: cases.length,
    node: process.version,
  },
  candles,
  candlesCrash: crashCandles,
  funding,
  cases,
}

const outPath = join(here, 'ts-backtest.json')
writeFileSync(outPath, `${JSON.stringify(payload)}\n`)
rmSync(bundleDir, { recursive: true, force: true })
console.log(`wrote ${outPath}: ${cases.length} cases, ${BARS} bars, ${(JSON.stringify(payload).length / 1024).toFixed(1)} KiB`)
