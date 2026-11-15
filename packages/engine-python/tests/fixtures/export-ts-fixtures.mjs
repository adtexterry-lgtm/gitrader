// SPDX-License-Identifier: CPAL-1.0
// 一次性夹具导出脚本：用 packages/engine-core 的 TS 指标库跑出数值，写成 ts-indicators.json。
// 用法（仓库根）：node packages/engine-python/tests/fixtures/export-ts-fixtures.mjs
// 离线、不联网：用仓库自带的 esbuild 把 src/strategy/ta/index.ts 打成临时 ESM 再 import，
// 生成确定性的合成输入（bar 序列 / 收盘价序列 / 带缺口的序列），把输入与 TS 输出一起落盘。
// Python 侧 tests/test_indicators.py 读同一份输入、跑同一批函数、逐值比对（容差 1e-9）。
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..', '..', '..')
const engineCore = join(repoRoot, 'packages', 'engine-core')
const taEntry = join(engineCore, 'src', 'strategy', 'ta', 'index.ts')

// ---- 1. 把 TS 指标库打成临时 ESM，再动态 import --------------------------------
const bundled = await build({
  stdin: {
    // index.ts 没把 parkinsonVol / garmanKlassVol / turnoverProxy / volumeZscore
    // 再导出（它们只在 volatility.ts / volume.ts 里 export），这里补一行取到它们。
    contents:
      "export * from './src/strategy/ta/index.ts'\n" +
      "export { parkinsonVol, garmanKlassVol } from './src/strategy/ta/volatility.ts'\n" +
      "export { turnoverProxy, volumeZscore } from './src/strategy/ta/volume.ts'\n",
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
const bundleDir = mkdtempSync(join(tmpdir(), 'gitrader-ta-'))
const bundlePath = join(bundleDir, 'ta.mjs')
writeFileSync(bundlePath, bundled.outputFiles[0].text)
const ta = await import(pathToFileURL(bundlePath).href)

// ---- 2. 确定性合成输入（mulberry32） ------------------------------------------
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

const BARS = 200
const FLAT_BARS = 40
const SERIES = 80

const random = mulberry32(20261021)
let price = 100
const bars = []
for (let i = 0; i < BARS; i++) {
  const open = price
  const close = Math.max(1, open + (random() - 0.5) * 2.4)
  const high = Math.max(open, close) + random() * 0.9
  const low = Math.min(open, close) - random() * 0.9
  const volume = Math.round(800 + random() * 5200)
  bars.push({ t: i, o: open, h: high, l: low, c: close, v: volume })
  price = close
}

// 全平盘（h == l、量 0）：压测「窗口区间为 0」的分支
const barsFlat = []
for (let i = 0; i < FLAT_BARS; i++) {
  barsFlat.push({ t: i, o: 50, h: 50, l: 50, c: 50, v: 0 })
}

const closes = bars.map((bar) => bar.c)

// 带缺口的序列：缺口集中在一段，保证窗口 10 内既有可算也有不可算的位置
const gapSeries = []
for (let i = 0; i < SERIES; i++) gapSeries.push(50 + (random() - 0.5) * 8)
gapSeries[30] = null
gapSeries[31] = null
gapSeries[32] = null

const bSeries = []
for (let i = 0; i < SERIES; i++) bSeries.push(20 + random() * 4)
bSeries[50] = null
bSeries[51] = null
bSeries[52] = null

// ---- 3. 逐个指标跑出 TS 数值 ---------------------------------------------------
const cases = {}
function put(name, args, value) {
  cases[name] = { args, value }
}

put('sma', { period: 5 }, ta.sma(closes, 5))
put('ema', { period: 12 }, ta.ema(closes, 12))
put('wma', { period: 9 }, ta.wma(closes, 9))
put('macd', { fast: 12, slow: 26, signal: 9 }, ta.macd(closes, 12, 26, 9))
put('cross', { fast: 5, slow: 20 }, ta.cross(ta.ema(closes, 5), ta.ema(closes, 20)))
put('rsi', { period: 14 }, ta.rsi(closes, 14))
put('stochastic', { kPeriod: 14, dPeriod: 3 }, ta.stochastic(bars, 14, 3))
put('roc', { period: 10 }, ta.roc(closes, 10))
put('momentum', { period: 10 }, ta.momentum(closes, 10))
put('williamsR', { period: 14 }, ta.williamsR(bars, 14))
put('cci', { period: 20 }, ta.cci(bars, 20))
put('trueRange', {}, ta.trueRange(bars))
put('atr', { period: 14 }, ta.atr(bars, 14))
put('rollingStd', { period: 20, ddof: 0 }, ta.rollingStd(closes, 20, 0))
put('rollingStdDdof1', { period: 20, ddof: 1 }, ta.rollingStd(closes, 20, 1))
put('bollinger', { period: 20, k: 2 }, ta.bollinger(closes, 20, 2))
put('keltner', { emaPeriod: 20, atrPeriod: 10, k: 2 }, ta.keltner(bars, 20, 10, 2))
put('donchian', { period: 20 }, ta.donchian(bars, 20))
put('logReturns', {}, ta.logReturns(closes))
put('parkinsonVol', { period: 20, periodsPerYear: 365 }, ta.parkinsonVol(bars, 20, 365))
put('garmanKlassVol', { period: 20, periodsPerYear: 365 }, ta.garmanKlassVol(bars, 20, 365))
put('annualizedVol', { period: 20, periodsPerYear: 365 }, ta.annualizedVol(closes, 20, 365))
put('obv', {}, ta.obv(bars))
put('vwap', {}, ta.vwap(bars))
put('vwapWindow', { period: 20 }, ta.vwap(bars, 20))
put('mfi', { period: 14 }, ta.mfi(bars, 14))
put('cmf', { period: 20 }, ta.cmf(bars, 20))
put('adLine', {}, ta.adLine(bars))
put('turnoverProxy', { period: 20 }, ta.turnoverProxy(bars, 20))
put('volumeZscore', { period: 20 }, ta.volumeZscore(bars, 20))
put('dema', { period: 10 }, ta.dema(closes, 10))
put('tema', { period: 10 }, ta.tema(closes, 10))
put('hma', { period: 16 }, ta.hma(closes, 16))
put('kama', { period: 10, fast: 2, slow: 30 }, ta.kama(closes, 10, 2, 30))
put('vwma', { period: 20 }, ta.vwma(bars, 20))
put('alma', { period: 9, offset: 0.85, sigma: 6 }, ta.alma(closes, 9, 0.85, 6))
put('zlema', { period: 21 }, ta.zlema(closes, 21))
put('ichimoku', {}, ta.ichimoku(bars))
put('parabolicSar', {}, ta.parabolicSar(bars))
put('supertrend', { period: 10, multiplier: 3 }, ta.supertrend(bars, { period: 10, multiplier: 3 }))
put('pivotPoints', {}, ta.pivotPoints(bars))
put('linearRegression', { period: 20 }, ta.linearRegression(closes, 20))
put('envelope', { period: 20, pct: 0.025 }, ta.envelope(closes, 20, 0.025))
put('trix', { period: 15 }, ta.trix(closes, 15))
put('ultimateOscillator', { short: 7, mid: 14, long: 28 }, ta.ultimateOscillator(bars))
put('awesomeOscillator', { fast: 5, slow: 34 }, ta.awesomeOscillator(bars))
put('ppo', { fast: 12, slow: 26, signal: 9 }, ta.ppo(closes))
put('aroon', { period: 25 }, ta.aroon(bars, 25))
put('dpo', { period: 20 }, ta.dpo(closes, 20))
put('adx', { period: 14 }, ta.adx(bars, 14))
put('stochRsi', {}, ta.stochRsi(closes))
put('chaikinOscillator', { fast: 3, slow: 10 }, ta.chaikinOscillator(bars))
put('forceIndex', { period: 13 }, ta.forceIndex(bars, 13))
put('easeOfMovement', { period: 14 }, ta.easeOfMovement(bars, 14))
put('massIndex', { ema: 9, sum: 25 }, ta.massIndex(bars))
put('ulcerIndex', { period: 14 }, ta.ulcerIndex(closes, 14))
put('vortex', { period: 14 }, ta.vortex(bars, 14))
put('choppiness', { period: 14 }, ta.choppiness(bars, 14))
put('kdj', { n: 9, k: 3, d: 3 }, ta.kdj(bars))
put('elderRay', { period: 13 }, ta.elderRay(bars, 13))
put('rollingSum', { period: 5 }, ta.rollingSum(gapSeries, 5))
put('rollingCorr', { period: 10 }, ta.rollingCorr(gapSeries, bSeries, 10))
put('rankPct', { period: 10 }, ta.rankPct(gapSeries, 10))
put('idxMax', { period: 10 }, ta.idxMax(gapSeries, 10))
put('idxMin', { period: 10 }, ta.idxMin(gapSeries, 10))
put('linearResidual', { period: 10 }, ta.linearResidual(gapSeries, 10))
// 全平盘分支（区间为 0 / 成交量为 0）
put('stochasticFlat', { kPeriod: 14, dPeriod: 3 }, ta.stochastic(barsFlat, 14, 3))
put('kdjFlat', { n: 9, k: 3, d: 3 }, ta.kdj(barsFlat))
put('williamsRFlat', { period: 14 }, ta.williamsR(barsFlat, 14))
put('cciFlat', { period: 20 }, ta.cci(barsFlat, 20))
put('choppinessFlat', { period: 14 }, ta.choppiness(barsFlat, 14))
put('cmfFlat', { period: 20 }, ta.cmf(barsFlat, 20))
put('vwapFlat', {}, ta.vwap(barsFlat))
put('volumeZscoreFlat', { period: 20 }, ta.volumeZscore(barsFlat, 20))
put('mfiFlat', { period: 14 }, ta.mfi(barsFlat, 14))

// ---- 4. 自检：任何 NaN / Infinity 都说明口径不一致，直接失败 -------------------
function checkFinite(value, path) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`非有限数：${path} = ${String(value)}`)
    return
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const item = value[i]
      if (item === null || item === undefined) continue
      checkFinite(item, `${path}[${i}]`)
    }
    return
  }
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) checkFinite(value[key], `${path}.${key}`)
  }
}

for (const key of Object.keys(cases)) checkFinite(cases[key].value, key)

const payload = {
  meta: {
    source: 'packages/engine-core/src/strategy/ta/index.ts',
    script: 'packages/engine-python/tests/fixtures/export-ts-fixtures.mjs',
    tolerance: 1e-9,
    bars: BARS,
    flatBars: FLAT_BARS,
    series: SERIES,
    caseCount: Object.keys(cases).length,
  },
  inputs: { bars, barsFlat, gapSeries, bSeries },
  cases,
}

const outPath = join(here, 'ts-indicators.json')
writeFileSync(outPath, `${JSON.stringify(payload)}\n`)
rmSync(bundleDir, { recursive: true, force: true })

console.log(
  `wrote ${outPath}: ${Object.keys(cases).length} cases, ${BARS} bars, ` +
    `${(JSON.stringify(payload).length / 1024).toFixed(1)} KiB`,
)
