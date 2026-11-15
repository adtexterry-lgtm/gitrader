// SPDX-License-Identifier: CPAL-1.0
// 一次性夹具导出脚本（批 9 主题二）：用 packages/ta-plus 的 TS 实现跑出数值，写成 ts-taplus.json。
// 用法（仓库根）：node packages/engine-python/tests/fixtures/export-ts-taplus-fixtures.mjs
// 离线、不联网：用仓库自带的 esbuild 把 ta-plus 的 src/index.ts 打成临时 ESM 再 import；
// 输入与 packages/ta-plus/test/fixtures-t1b.ts 同一组死值（10 根 K 线 / 21 根价位夹具），
// 因此 Python 侧的「TS 一致性」与「独立参照值」两套用例可以对着同一份输入跑。
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..', '..', '..')
const taPlus = join(repoRoot, 'packages', 'ta-plus')

// ---- 1. 把 ta-plus 打成临时 ESM，再动态 import --------------------------------
const bundled = await build({
  stdin: {
    contents:
      "export * from './src/index.ts'\n" +
      // adx 只在 engine-core 里（ta-plus 的 adxr 吃任意 ADX 序列），单独取一次
      "export { adx } from '../engine-core/src/strategy/ta/oscillators.ts'\n",
    resolveDir: taPlus,
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  write: false,
  logLevel: 'silent',
})
const bundleDir = mkdtempSync(join(tmpdir(), 'gitrader-taplus-'))
const bundlePath = join(bundleDir, 'taplus.mjs')
writeFileSync(bundlePath, bundled.outputFiles[0].text)
const ta = await import(pathToFileURL(bundlePath).href)

// ---- 2. 确定性输入（与 packages/ta-plus/test/fixtures-t1b.ts 逐字节同一组） ----
const BARS = [
  { o: 100, h: 101, l: 99, c: 100, v: 1000 },
  { o: 101, h: 103, l: 100, c: 102, v: 1200 },
  { o: 102, h: 104, l: 101, c: 103, v: 900 },
  { o: 101, h: 103, l: 100, c: 102, v: 1500 },
  { o: 103, h: 105, l: 102, c: 104, v: 1100 },
  { o: 102, h: 104, l: 101, c: 103, v: 1300 },
  { o: 104, h: 106, l: 103, c: 105, v: 800 },
  { o: 105, h: 107, l: 104, c: 106, v: 1600 },
  { o: 103, h: 105, l: 102, c: 104, v: 1400 },
  { o: 106, h: 108, l: 105, c: 107, v: 1700 },
]
const CLOSES = BARS.map((bar) => bar.c)
const VOLUMES = BARS.map((bar) => bar.v)

const levelBars = []
for (let i = 0; i < 21; i++) {
  const c = 100 + (i % 7)
  levelBars.push({ o: c - 0.5, h: c + 1, l: c - 1, c, v: 1000 })
}

// 单根收益率（ta-plus 的 realizedVolatility / downsideVolatility 吃收益率而不是价格）
const returns = CLOSES.slice(1).map((c, i) => c / CLOSES[i] - 1)

// ---- 3. 逐个指标跑出 TS 数值 ---------------------------------------------------
const cases = {}
const put = (name, value) => {
  cases[name] = value
}

put('simpleReturns', ta.simpleReturns(CLOSES))
put('realizedVolatility', ta.realizedVolatility(returns, 3))
put('realizedVolatilityRaw', ta.realizedVolatility(returns, 3, { annualize: false }))
put('downsideVolatility', ta.downsideVolatility(returns, 3))
put('downsideVolatilityMar', ta.downsideVolatility(returns, 3, { mar: 0.01, annualize: false }))
put('skewness', ta.skewness(CLOSES, 5))
put('skewnessPop', ta.skewness(CLOSES, 5, { sample: false }))
put('kurtosis', ta.kurtosis(CLOSES, 5))
put('kurtosisPop', ta.kurtosis(CLOSES, 5, { sample: false }))
put('maxDrawdown', ta.maxDrawdown(CLOSES, 5))
put('atrPercent', ta.atrPercent(BARS, 3))
put('amihudIlliquidity', ta.amihudIlliquidity(BARS, 3))
put('avgDev', ta.avgDev(CLOSES, 4))
put('variance', ta.variance(CLOSES, 4))
put('varianceDdof1', ta.variance(CLOSES, 4, 1))
put('bop', ta.bop(BARS))
put('adxr', ta.adxr(ta.adx(BARS, 3).adx, 3))
put('cmo', ta.cmo(CLOSES, 3))
put('tsi', ta.tsi(CLOSES, { slow: 3, fast: 2 }))
put('efficiencyRatio', ta.efficiencyRatio(CLOSES, 3))
put('smaDistance', ta.smaDistance(CLOSES, 3))
put('emaDistance', ta.emaDistance(CLOSES, 3))
put('emaSlope', ta.emaSlope(CLOSES, 3, 2))
put('zScore', ta.zScore(CLOSES, 5))
put('zScoreDdof0', ta.zScore(CLOSES, 5, 0))
put('volumeRatio', ta.volumeRatio(VOLUMES, 3))
put('pricePosition', ta.pricePosition(BARS, 4))
put('avgPrice', ta.avgPrice(BARS))
put('medPrice', ta.medPrice(BARS))
put('typPrice', ta.typPrice(BARS))
put('wclPrice', ta.wclPrice(BARS))
put('rollingMax', ta.rollingMax(CLOSES, 4))
put('rollingMin', ta.rollingMin(CLOSES, 4))
put('maxIndex', ta.maxIndex(CLOSES, 4))
put('minIndex', ta.minIndex(CLOSES, 4))
put('midPoint', ta.midPoint(CLOSES, 4))
put('midPrice', ta.midPrice(BARS, 4))
put('trima4', ta.trima(CLOSES, 4))
put('trima5', ta.trima(CLOSES, 5))
put('t3', ta.t3(CLOSES, 2))
put('plusDM', ta.plusDM(BARS, 3))
put('minusDM', ta.minusDM(BARS, 3))
put('plusDI', ta.plusDI(BARS, 3))
put('minusDI', ta.minusDI(BARS, 3))
put('dx', ta.dx(BARS, 3))
put('aroonOsc', ta.aroonOsc(BARS, 3))
put('stochF', ta.stochF(BARS, 3, 2))
put('correl', ta.correl(CLOSES, VOLUMES, 4))
put('beta', ta.beta(CLOSES, VOLUMES, 4))
put('linRegSlope', ta.linRegSlope(CLOSES, 4))
put('linRegIntercept', ta.linRegIntercept(CLOSES, 4))
put('linRegAngle', ta.linRegAngle(CLOSES, 4))
put('tsf', ta.tsf(CLOSES, 4))
put('natr', ta.natr(BARS, 3))
put('adOsc', ta.adOsc(BARS, 2, 4))
put('levels', ta.levels(levelBars))
put('earningsYield', ta.earningsYield(100, 2500))
put('bookToPrice', ta.bookToPrice(500, 2500))
put('returnOnEquity', ta.returnOnEquity(100, 400))
put('debtToEquity', ta.debtToEquity(300, 400))
put('freeCashFlowYield', ta.freeCashFlowYield(60, 2500))
put('revenueGrowth', ta.revenueGrowth(110, 100))

// ---- 4. 自检：任何 NaN / Infinity 都说明口径不一致，直接失败 -------------------
function checkFinite(value, path) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`非有限数：${path} = ${String(value)}`)
    return
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      if (value[i] === null || value[i] === undefined) continue
      checkFinite(value[i], `${path}[${i}]`)
    }
    return
  }
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) checkFinite(value[key], `${path}.${key}`)
  }
}

for (const key of Object.keys(cases)) checkFinite(cases[key], key)

const payload = {
  meta: {
    source: 'packages/ta-plus/src/index.ts',
    script: 'packages/engine-python/tests/fixtures/export-ts-taplus-fixtures.mjs',
    tolerance: 1e-9,
    bars: BARS.length,
    levelBars: levelBars.length,
    caseCount: Object.keys(cases).length,
  },
  inputs: { bars: BARS, closes: CLOSES, volumes: VOLUMES, levelBars, returns },
  cases,
}

const outPath = join(here, 'ts-taplus.json')
writeFileSync(outPath, `${JSON.stringify(payload)}\n`)
rmSync(bundleDir, { recursive: true, force: true })

console.log(
  `wrote ${outPath}: ${Object.keys(cases).length} cases, ${BARS.length} bars, ` +
    `${(JSON.stringify(payload).length / 1024).toFixed(1)} KiB`,
)
