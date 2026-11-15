// SPDX-License-Identifier: CPAL-1.0
// 指标库吞吐：把 engine-core 指标库（packages/engine-core/src/strategy/ta/index.ts）里每个指标
// 在一整段收盘价 / K 线上跑一遍，量「根·指标 / 秒」。单线程、整序列、含预热期 null 输出。
//
// 口径说明：既有 docs/perf-baseline.md 没有这一项，属于本脚本新增口径；跨机只比数量级。

import { summarizeMs, perSec } from '../lib/stats.mjs'

/**
 * 指标清单：每个都用最小参数调用一次全序列。
 * 只用引擎库真实存在的导出（签名见各文件，2026-10-21 读）。
 */
export function indicatorCases() {
  return [
    { name: 'sma(20)', fn: (ta, { closes }) => ta.sma(closes, 20) },
    { name: 'ema(20)', fn: (ta, { closes }) => ta.ema(closes, 20) },
    { name: 'wma(20)', fn: (ta, { closes }) => ta.wma(closes, 20) },
    { name: 'dema(20)', fn: (ta, { closes }) => ta.dema(closes, 20) },
    { name: 'hma(20)', fn: (ta, { closes }) => ta.hma(closes, 20) },
    { name: 'kama(10)', fn: (ta, { closes }) => ta.kama(closes, 10) },
    { name: 'alma(9)', fn: (ta, { closes }) => ta.alma(closes, 9) },
    { name: 'zlema(20)', fn: (ta, { closes }) => ta.zlema(closes, 20) },
    { name: 'macd(12,26,9)', fn: (ta, { closes }) => ta.macd(closes) },
    { name: 'rsi(14)', fn: (ta, { closes }) => ta.rsi(closes, 14) },
    { name: 'stochRsi(14)', fn: (ta, { closes }) => ta.stochRsi(closes) },
    { name: 'ppo(12,26,9)', fn: (ta, { closes }) => ta.ppo(closes) },
    { name: 'roc(10)', fn: (ta, { closes }) => ta.roc(closes, 10) },
    { name: 'momentum(10)', fn: (ta, { closes }) => ta.momentum(closes, 10) },
    { name: 'trix(15)', fn: (ta, { closes }) => ta.trix(closes) },
    { name: 'dpo(20)', fn: (ta, { closes }) => ta.dpo(closes, 20) },
    { name: 'ulcerIndex(14)', fn: (ta, { closes }) => ta.ulcerIndex(closes, 14) },
    { name: 'rollingStd(20)', fn: (ta, { closes }) => ta.rollingStd(closes, 20) },
    { name: 'bollinger(20,2)', fn: (ta, { closes }) => ta.bollinger(closes, 20, 2) },
    { name: 'keltner(20,10,2)', fn: (ta, { bars }) => ta.keltner(bars, 20, 10, 2) },
    { name: 'donchian(20)', fn: (ta, { bars }) => ta.donchian(bars, 20) },
    { name: 'atr(14)', fn: (ta, { bars }) => ta.atr(bars, 14) },
    { name: 'trueRange', fn: (ta, { bars }) => ta.trueRange(bars) },
    { name: 'adx(14)', fn: (ta, { bars }) => ta.adx(bars, 14) },
    { name: 'aroon(25)', fn: (ta, { bars }) => ta.aroon(bars, 25) },
    { name: 'stochastic(14,3)', fn: (ta, { bars }) => ta.stochastic(bars, 14, 3) },
    { name: 'williamsR(14)', fn: (ta, { bars }) => ta.williamsR(bars, 14) },
    { name: 'cci(20)', fn: (ta, { bars }) => ta.cci(bars, 20) },
    { name: 'mfi(14)', fn: (ta, { bars }) => ta.mfi(bars, 14) },
    { name: 'cmf(20)', fn: (ta, { bars }) => ta.cmf(bars, 20) },
    { name: 'obv', fn: (ta, { bars }) => ta.obv(bars) },
    { name: 'vwap(20)', fn: (ta, { bars }) => ta.vwap(bars, 20) },
    { name: 'adLine', fn: (ta, { bars }) => ta.adLine(bars) },
    { name: 'forceIndex(13)', fn: (ta, { bars }) => ta.forceIndex(bars, 13) },
    { name: 'chaikinOscillator', fn: (ta, { bars }) => ta.chaikinOscillator(bars) },
    { name: 'supertrend', fn: (ta, { bars }) => ta.supertrend(bars) },
    { name: 'ichimoku', fn: (ta, { bars }) => ta.ichimoku(bars) },
    { name: 'parabolicSar', fn: (ta, { bars }) => ta.parabolicSar(bars) },
    { name: 'pivotPoints', fn: (ta, { bars }) => ta.pivotPoints(bars) },
    { name: 'linearRegression(20)', fn: (ta, { closes }) => ta.linearRegression(closes, 20) },
    { name: 'envelope(20)', fn: (ta, { closes }) => ta.envelope(closes, 20) },
    { name: 'rollingSum(20)', fn: (ta, { closes }) => ta.rollingSum(closes, 20) },
    { name: 'rankPct(20)', fn: (ta, { closes }) => ta.rankPct(closes, 20) },
    { name: 'idxMax(20)', fn: (ta, { closes }) => ta.idxMax(closes, 20) },
  ]
}

/**
 * @param {object} o
 * @param {any} o.ta engine-core 指标库模块
 * @param {any[]} o.candles K 线（含 o/h/l/c/v）
 * @param {number} [o.rounds] 每个指标跑几轮（第 1 轮算首次，其余热启）
 * @param {{name: string, fn: Function}[]} [o.cases] 自定义清单（测试用）
 */
export async function benchIndicators(o) {
  const { ta, candles } = o
  const rounds = Math.max(1, Math.floor(o.rounds ?? 3))
  const cases = o.cases ?? indicatorCases()
  if (candles.length < 2) throw new TypeError('benchIndicators: K 线不足')
  const closes = candles.map((c) => c.c)
  const ctx = { closes, bars: candles }

  const items = []
  const skipped = []
  const sweepTimes = []
  for (const c of cases) {
    // 先冒烟一次：签名不对 / 实现缺失就记下来，不让整轮基准崩掉
    try {
      c.fn(ta, ctx)
    } catch (err) {
      skipped.push({ name: c.name, reason: err?.message ?? String(err) })
      continue
    }
    const times = []
    const sweepBegan = performance.now()
    for (let i = 0; i < rounds; i++) {
      const began = performance.now()
      c.fn(ta, ctx)
      times.push(performance.now() - began)
    }
    sweepTimes.push(performance.now() - sweepBegan)
    const firstMs = times[0]
    const rest = times.slice(1)
    const warm = summarizeMs(rest.length > 0 ? rest : times)
    const basisMs = rest.length > 0 ? warm.p50Ms : firstMs
    items.push({ name: c.name, firstMs, warm, p50Ms: warm.p50Ms, p95Ms: warm.p95Ms, barsPerSec: perSec(candles.length, basisMs) })
  }

  items.sort((a, b) => b.barsPerSec - a.barsPerSec)
  const sweepMs = summarizeMs(sweepTimes)
  const totalUnits = items.length * candles.length
  const basisSweepMs = sweepTimes.length > 1 ? sweepMs.p50Ms : (sweepMs.p50Ms ?? Number.NaN)

  return {
    kind: 'indicators',
    bars: candles.length,
    rounds,
    count: items.length,
    skipped,
    items,
    sweepMs,
    throughputPerSec: perSec(totalUnits, basisSweepMs),
  }
}
