// SPDX-License-Identifier: CPAL-1.0
// R3-15：因子报告的 t 值改用对重叠窗口稳健的 Newey–West（HAC）口径，并把口径写进报告。
// 独立复算：下面的 refNeweyWest 是按定义写的朴素版本（不 import lib），与库里的实现互相对照。
import assert from 'node:assert/strict'
import test from 'node:test'
import { forwardReturns, icSummary, rollingIc } from '../../packages/cli/src/research/factor-eval.mjs'
import { buildFactorReport, renderFactorMarkdown } from '../../packages/cli/src/research/factor-report.mjs'
import { neweyWest } from '../../packages/cli/src/research/stats.mjs'
import { noisyCandles } from './helpers.mjs'

/** 朴素 Newey–West：Bartlett 核，γ_j 除以 n，先去均值。 */
function refNeweyWest(xs, lags) {
  const n = xs.length
  const m = xs.reduce((a, b) => a + b, 0) / n
  const d = xs.map((x) => x - m)
  let lrv = d.reduce((a, x) => a + x * x, 0) / n
  for (let j = 1; j <= Math.min(lags, n - 1); j++) {
    let g = 0
    for (let i = j; i < n; i++) g += d[i] * d[i - j]
    lrv += 2 * (1 - j / (lags + 1)) * (g / n)
  }
  return m / Math.sqrt(lrv / n)
}

test('neweyWest：与朴素实现一致；lags=0 退化为 n·均值/标准差（总体口径）', () => {
  const xs = [0.1, 0.12, 0.09, 0.2, 0.18, 0.15, 0.22, 0.05, 0.11, 0.3, 0.28, 0.1]
  for (const lags of [0, 1, 3, 11, 40]) {
    const got = neweyWest(xs, lags)
    assert.ok(Math.abs(got.t - refNeweyWest(xs, lags)) < 1e-12, `lags=${lags}`)
  }
  const m = xs.reduce((a, b) => a + b, 0) / xs.length
  const pop = Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / xs.length)
  assert.ok(Math.abs(neweyWest(xs, 0).t - (m / pop) * Math.sqrt(xs.length)) < 1e-12)
})

test('neweyWest：点数不足、常数序列、非法滞后返回 null', () => {
  assert.equal(neweyWest([1, 2], 1), null)
  assert.equal(neweyWest([0.5, 0.5, 0.5, 0.5], 2), null)
  assert.equal(neweyWest([1, 2, 3, 4], -1), null)
  assert.equal(neweyWest([1, 2, 3, 4], 1.5), null)
})

test('icSummary：不给 opts 口径不变；给 tLags 改用 NW 并带出 tMethod / tLags / nEff', () => {
  const ics = [0.5, 0.25, 0.75, 0.4, 0.6, 0.55, 0.35, 0.65]
  const old = icSummary(ics)
  assert.deepEqual(Object.keys(old), ['n', 'mean', 'std', 'ir', 'tStat', 'positiveShare'])
  assert.ok(Math.abs(old.tStat - old.ir * Math.sqrt(old.n)) < 1e-12)
  const nw = icSummary(ics, { tLags: 3 })
  assert.equal(nw.tMethod, 'newey-west')
  assert.equal(nw.tLags, 3)
  assert.ok(Math.abs(nw.tStat - refNeweyWest(ics, 3)) < 1e-12)
  assert.ok(nw.nEff > 0)
  assert.equal(nw.ir, old.ir)
  assert.equal(icSummary([0.5], { tLags: 3 }).tStat, null)
})

test('重叠窗口里 NW 的 t 明显小于 IR×√n（滚动 IC 自相关强）', () => {
  const candles = noisyCandles(900, 11)
  const fwd = forwardReturns(candles, 5)
  const values = candles.map((c, i) => (i > 0 ? c.c / candles[i - 1].c - 1 : null)).map((x) => (x === null ? null : -x))
  const roll = rollingIc(values, fwd, 60)
  const naive = icSummary(roll)
  const robust = icSummary(roll, { tLags: 60 + 5 - 2 })
  assert.ok(Math.abs(robust.tStat) < Math.abs(naive.tStat), `NW |t| ${robust.tStat} 应小于旧口径 ${naive.tStat}`)
  assert.ok(robust.nEff < naive.n)
})

test('buildFactorReport：每个因子的 t 是 NW 口径，报告写明方法，旧公式那句已删除', () => {
  const report = buildFactorReport({ candles: noisyCandles(500, 3), horizon: 5, window: 40, quantiles: 5, top: 5 })
  assert.equal(report.tMethod, 'newey-west')
  assert.equal(report.tLags, 40 + 5 - 2)
  assert.ok(report.all.length >= report.factors.length)
  const f = report.factors[0]
  assert.equal(f.rolling.tMethod, 'newey-west')
  assert.equal(f.rolling.tLags, 43)
  const md = renderFactorMarkdown(report)
  assert.match(md, /Newey/)
  assert.doesNotMatch(md, /t 值 = IR × √有效点数/)
  assert.match(md, /t 值（NW）/)
})
