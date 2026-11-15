// SPDX-License-Identifier: CPAL-1.0
// 因子评估数值测试：前向收益、Spearman IC、滚动 IC 汇总、分位组收益、IC 衰减。
// 期望值走「分母取 2 的幂 / 0.125 的倍数」这类二进制可精确表示的数，才能写等号断言。
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  evaluateFactor,
  forwardReturns,
  icDecay,
  icSummary,
  pairedValid,
  quantileMonotonicity,
  quantileReturns,
  rankIc,
  rollingIc,
} from '../../packages/cli/src/research/factor-eval.mjs'
import { barsFromCloses, near } from './helpers.mjs'

test('forwardReturns：h=1 与 h=2 的精确值，尾部为 null', () => {
  const candles = barsFromCloses([1, 2, 4, 8])
  assert.deepEqual(forwardReturns(candles, 1), [1, 1, 1, null])
  assert.deepEqual(forwardReturns(candles, 2), [3, 3, null, null])
  // 非整数 / 0 / 负数 horizon -> 全 null
  assert.deepEqual(forwardReturns(candles, 0), [null, null, null, null])
  assert.deepEqual(forwardReturns(candles, 1.5), [null, null, null, null])
})

test('rankIc：完全正序 +1、完全逆序 -1、常数与样本不足为 null', () => {
  const fwd = [10, 20, 30, 40, 50]
  near(rankIc([1, 2, 3, 4, 5], fwd), 1)
  near(rankIc([5, 4, 3, 2, 1], fwd), -1)
  // 常数因子 -> 零方差 -> null
  assert.equal(rankIc([7, 7, 7, 7, 7], fwd), null)
  // 常数前向收益 -> null
  assert.equal(rankIc([1, 2, 3, 4, 5], [3, 3, 3, 3, 3]), null)
  // 有效点 < 3 -> null
  assert.equal(rankIc([1, null, 3], [1, 2, 3]), null)
  // 并列取平均名次：因子 [1,2,2,3] 与前向 [10,20,20,30] 同构 -> 1
  near(rankIc([1, 2, 2, 3], [10, 20, 20, 30]), 1)
  // pairedValid 剔除 null / NaN
  const paired = pairedValid([1, null, Number.NaN, 4], [1, 2, 3, 4])
  assert.deepEqual(paired, { xs: [1, 4], ys: [1, 4] })
})

test('rollingIc + icSummary：均值 0.5、样本标准差 0.25、IR 2、t = 2√3', () => {
  // 手算：values [0.5, 0.25, 0.75]，均值 0.5，偏差 0/-0.25/+0.25，ss = 0.125，/(3-1) = 0.0625，sd = 0.25
  const summary = icSummary([0.5, 0.25, 0.75])
  assert.equal(summary.n, 3)
  assert.equal(summary.mean, 0.5)
  assert.equal(summary.std, 0.25)
  assert.equal(summary.ir, 2)
  assert.equal(summary.tStat, 2 * Math.sqrt(3))
  // 三个 IC 全为正 -> 正占比 1；换一个负值核对 2/3
  assert.equal(summary.positiveShare, 1)
  assert.equal(icSummary([0.5, -0.25, 0.75]).positiveShare, 2 / 3)

  // 只有 1 个点：IR / t 为 null，标准差 0
  assert.deepEqual(icSummary([0.5]), { n: 1, mean: 0.5, std: 0, ir: null, tStat: null, positiveShare: 1 })
  // 空序列
  assert.deepEqual(icSummary([null, null]), { n: 0, mean: 0, std: 0, ir: null, tStat: null, positiveShare: 0 })

  // 滚动窗口：6 个点、窗口 3 -> 前两个为 null，其余 4 个可算
  const factor = [1, 2, 3, 4, 5, 6]
  const fwd = [1, 2, 3, 4, 5, 99]
  const rolling = rollingIc(factor, fwd, 3)
  assert.equal(rolling.length, 6)
  assert.equal(rolling[0], null)
  assert.equal(rolling[1], null)
  for (let i = 2; i <= 4; i++) near(rolling[i], 1)
  near(rolling[5], 1)
})

test('quantileReturns：10 个点分 5 组，每组 2 个，价差精确为 1', () => {
  const factor = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
  // 前向收益取 0.125 的倍数（二进制精确）
  const fwd = [0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 1, 1.125, 1.25]
  const result = quantileReturns(factor, fwd, 5)
  assert.deepEqual(result.buckets, [
    { q: 1, n: 2, meanFwd: 0.1875 },
    { q: 2, n: 2, meanFwd: 0.4375 },
    { q: 3, n: 2, meanFwd: 0.6875 },
    { q: 4, n: 2, meanFwd: 0.9375 },
    { q: 5, n: 2, meanFwd: 1.1875 },
  ])
  assert.equal(result.spread, 1)
  // 因子逆序 -> 价差为负
  const reversed = quantileReturns([...factor].reverse(), fwd, 5)
  assert.equal(reversed.spread, -1)
})

test('quantileReturns：11 个点分 5 组，末组多 1 个；样本不足返回空', () => {
  const factor = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
  const fwd = factor.map((v) => v / 8)
  const result = quantileReturns(factor, fwd, 5)
  assert.deepEqual(
    result.buckets.map((b) => b.n),
    [2, 2, 2, 2, 3],
  )
  // 第 5 组 = (9/8 + 10/8 + 11/8) / 3 = 10/8
  assert.equal(result.buckets[4].meanFwd, 1.25)
  // 5 个有效点分 10 组 -> 空
  assert.deepEqual(quantileReturns([1, 2, 3, 4, 5], fwd.slice(0, 5), 10), { buckets: [], spread: null })
  // q 非整数 -> 空
  assert.deepEqual(quantileReturns([1, 2, 3, 4, 5], fwd.slice(0, 5), 2.5), { buckets: [], spread: null })
})

test('quantileMonotonicity：严格递增 1、递减 -1、少于 3 组 null', () => {
  near(quantileMonotonicity([{ q: 1, meanFwd: -0.01 }, { q: 2, meanFwd: 0 }, { q: 3, meanFwd: 0.02 }]), 1)
  near(quantileMonotonicity([{ q: 1, meanFwd: 0.02 }, { q: 2, meanFwd: 0 }, { q: 3, meanFwd: -0.01 }]), -1)
  assert.equal(quantileMonotonicity([{ q: 1, meanFwd: 1 }, { q: 2, meanFwd: 2 }]), null)
})

test('icDecay：递增收益序列在 h=1/2/3 的 IC 均为 1', () => {
  // 收盘按 ×2 ×3 ×4 ×5 ×6 放大：h=1 的收益依次为 1,2,3,4,5（严格递增），因子也递增 -> IC 1
  const candles = barsFromCloses([1, 2, 6, 24, 120, 720])
  const factor = candles.map((c) => c.c)
  const decay = icDecay(factor, candles, [1, 2, 3])
  assert.deepEqual(decay, [
    { horizon: 1, ic: 1 },
    { horizon: 2, ic: 1 },
    { horizon: 3, ic: 1 },
  ])
})

test('evaluateFactor：一站式结果字段与口径（因子恒等于收盘价，IC 1）', () => {
  const candles = barsFromCloses([1, 2, 6, 24, 120, 720, 5040, 40320])
  const def = { id: 'close', label: '收盘价', compute: (cs) => cs.map((c) => c.c) }
  const report = evaluateFactor(candles, def, { horizon: 1, window: 3, quantiles: 4 })
  assert.equal(report.id, 'close')
  assert.equal(report.horizon, 1)
  near(report.ic, 1)
  // 8 个点、窗口 3 -> i=2..7 共 6 个滚动值；i=7 的前向收益为 null，掉到 2 个有效点后为 null
  assert.equal(report.rolling.n, 5)
  assert.equal(report.quantiles.buckets.length, 4)
  near(report.monotonicity, 1)
})
