// SPDX-License-Identifier: CPAL-1.0
// Alpha158 因子数值测试：每个用例的期望值都由公式手算后写成字面量（算式写在注释里）。
// 口径必须与 packages/engine-core/src/strategy/{alpha158,factors-alpha}.ts 一致。
import assert from 'node:assert/strict'
import test from 'node:test'
import { ALPHA158_WINDOWS, ALPHA_FACTORS, alpha158Catalog, alphaFactorById, computeAlpha158 } from '../../packages/cli/src/research/alpha158.mjs'
import { bar, barsFromCloses, near } from './helpers.mjs'

const compute = (id, candles, params) => alphaFactorById(id).compute(candles, params)

test('目录：KBAR 9 + 价格 3 + 29 族 × 5 窗口 = 157 条，名字与窗口对齐', () => {
  const catalog = alpha158Catalog()
  assert.equal(catalog.length, 157)
  assert.equal(ALPHA_FACTORS.length, 41)
  assert.deepEqual(
    catalog.slice(0, 12).map((e) => e.name),
    ['KMID', 'KLEN', 'KMID2', 'KUP', 'KUP2', 'KLOW', 'KLOW2', 'KSFT', 'KSFT2', 'OPEN0', 'HIGH0', 'LOW0'],
  )
  assert.deepEqual(
    catalog.slice(0, 9).map((e) => e.period),
    [1, 1, 1, 1, 1, 1, 1, 1, 1],
  )
  assert.deepEqual(ALPHA158_WINDOWS, [5, 10, 20, 30, 60])
  assert.equal(catalog[catalog.length - 1].name, 'VSUMD60')
  assert.equal(catalog[catalog.length - 1].period, 60)
  const roc = catalog.filter((e) => e.factorId === 'roc_n')
  assert.deepEqual(
    roc.map((e) => e.name),
    ['ROC5', 'ROC10', 'ROC20', 'ROC30', 'ROC60'],
  )
  assert.deepEqual(
    roc.map((e) => e.period),
    [5, 10, 20, 30, 60],
  )
  assert.equal(new Set(catalog.map((e) => e.name)).size, 157)
})

test('KBAR 单根精确值：o=10 h=12 l=9 c=11', () => {
  const candles = [bar(0, 10, 12, 9, 11, 100)]
  // KMID = (11-10)/10
  assert.equal(compute('kmid', candles)[0], 0.1)
  // KLEN = (12-9)/10
  assert.equal(compute('klen', candles)[0], 0.3)
  // KMID2 = (11-10)/(12-9)
  near(compute('kmid2', candles)[0], 1 / 3)
  // KUP = (12-max(10,11))/10 = 1/10
  assert.equal(compute('kup', candles)[0], 0.1)
  // KLOW = (min(10,11)-9)/10 = 1/10
  assert.equal(compute('klow', candles)[0], 0.1)
  // KSFT = (2*11-12-9)/10 = 1/10
  assert.equal(compute('ksft', candles)[0], 0.1)
  // 三条「占振幅」版本分母加 1e-12：1/(3+1e-12)
  near(compute('kup2', candles)[0], 1 / 3, 1e-12)
  near(compute('klow2', candles)[0], 1 / 3, 1e-12)
  near(compute('ksft2', candles)[0], 1 / 3, 1e-12)
  // 价格 3 条：o/c、h/c、l/c
  near(compute('open0', candles)[0], 10 / 11, 1e-15)
  near(compute('high0', candles)[0], 12 / 11, 1e-15)
  near(compute('low0', candles)[0], 9 / 11, 1e-15)
})

test('窗口因子：收盘 [1,2,3] 窗口 3 的 MA/STD/BETA/RSQR/RESI/RANK/QTLU/QTLD', () => {
  const candles = barsFromCloses([1, 2, 3])
  const p = { period: 3 }
  // 窗口 = [1,2,3]，均值 2，末值 3
  assert.equal(compute('ma_n', candles, p)[2], 2 / 3)
  // 样本标准差 ddof 1：ss = 1+0+1 = 2，2/(3-1) = 1，sd = 1 -> 1/3
  near(compute('std_n', candles, p)[2], 1 / 3)
  // 回归斜率（x=0,1,2）= 1 -> 1/3
  near(compute('beta_n', candles, p)[2], 1 / 3)
  // 完全共线 -> R² = 1
  near(compute('rsqr_n', candles, p)[2], 1)
  // 末点残差 0 -> 0/3 = 0
  assert.equal(compute('resi_n', candles, p)[2], 0)
  // 末值是窗口最大值：below=2, equal=1 -> (2 + (1+1)/2)/3 = 1
  assert.equal(compute('rank_n', candles, p)[2], 1)
  // 80% 分位（线性插值）：h=(3-1)*0.8=1.6 -> 2 + 0.6*(3-2) = 2.6 -> 2.6/3
  near(compute('qtlu_n', candles, p)[2], 2.6 / 3)
  // 20% 分位：h=0.4 -> 1 + 0.4*(2-1) = 1.4 -> 1.4/3
  near(compute('qtld_n', candles, p)[2], 1.4 / 3)
  // 预热期（i < n-1）为 null
  assert.equal(compute('ma_n', candles, p)[0], null)
  assert.equal(compute('ma_n', candles, p)[1], null)
})

test('ROC 的预热期比窗口因子晚一根（delta 口径）：[1,2,3,4] 窗口 3', () => {
  const candles = barsFromCloses([1, 2, 3, 4])
  const out = compute('roc_n', candles, { period: 3 })
  assert.equal(out[0], null)
  assert.equal(out[1], null)
  assert.equal(out[2], null)
  // i=3: c[0]/c[3] = 1/4
  assert.equal(out[3], 0.25)
})

test('涨跌分解：单调上行与单调下行的 CNTP/CNTN/CNTD/SUMP/SUMN/SUMD', () => {
  const up = barsFromCloses([1, 2, 3, 4])
  const p = { period: 3 }
  // 窗口内 3 个 Δ 全是 +1：up=3, down=0, gain=3, loss=0, path=3
  assert.equal(compute('cntp_n', up, p)[3], 1)
  assert.equal(compute('cntn_n', up, p)[3], 0)
  assert.equal(compute('cntd_n', up, p)[3], 1)
  assert.equal(compute('sump_n', up, p)[3], 1)
  assert.equal(compute('sumn_n', up, p)[3], 0)
  assert.equal(compute('sumd_n', up, p)[3], 1)

  const down = barsFromCloses([4, 3, 2, 1])
  assert.equal(compute('cntp_n', down, p)[3], 0)
  assert.equal(compute('cntn_n', down, p)[3], 1)
  assert.equal(compute('cntd_n', down, p)[3], -1)
  assert.equal(compute('sump_n', down, p)[3], 0)
  assert.equal(compute('sumn_n', down, p)[3], 1)
  assert.equal(compute('sumd_n', down, p)[3], -1)
})

test('极值与位置因子：高 [11,25,21]、低 [9,19,8]、收盘 [10,20,30]', () => {
  const candles = [
    bar(0, 10, 11, 9, 10, 100),
    bar(1, 20, 25, 19, 20, 200),
    bar(2, 30, 21, 8, 30, 300),
  ]
  const p = { period: 3 }
  // 窗口最高价 25（下标 1），最低价 8（下标 2）
  near(compute('max_n', candles, p)[2], 25 / 30)
  near(compute('min_n', candles, p)[2], 8 / 30)
  // 距当前根数（从 0 起）：高点 2-1=1，低点 2-2=0，均除以 n=3
  near(compute('imax_n', candles, p)[2], 1 / 3)
  assert.equal(compute('imin_n', candles, p)[2], 0)
  near(compute('imxd_n', candles, p)[2], 1 / 3)
  // RSV = (30 - 8) / (25 - 8)
  near(compute('rsv_n', candles, p)[2], 22 / 17)
})

test('成交量因子：量 [100,200,300] 的 VMA/VSTD，量递增的 VSUMP', () => {
  const candles = barsFromCloses([1, 2, 3], { volumes: [100, 200, 300] })
  const p = { period: 3 }
  // mean(v) = 200，分母 300 + 1e-12
  near(compute('vma_n', candles, p)[2], 200 / (300 + 1e-12), 1e-15)
  // stdev(v, ddof 1) = 100（ss = 20000，/(3-1) = 10000，sqrt = 100）
  near(compute('vstd_n', candles, p)[2], 100 / (300 + 1e-12), 1e-15)
  // 4 根、3 个 Δv 全为正 -> 1
  const four = barsFromCloses([1, 2, 3, 4], { volumes: [100, 200, 300, 400] })
  assert.equal(compute('vsump_n', four, p)[3], 1)
  assert.equal(compute('vsumn_n', four, p)[3], 0)
  assert.equal(compute('vsumd_n', four, p)[3], 1)
})

test('CORR：量随价同步变动相关 1，反向相关 -1，量恒定则 null', () => {
  // v = e^c - 1 => ln(v+1) = c，与收盘完全线性相关
  const closes = [1, 2, 3, 4]
  const aligned = barsFromCloses(closes, { volumes: closes.map((c) => Math.exp(c) - 1) })
  near(compute('corr_n', aligned, { period: 4 })[3], 1, 1e-9)

  const reversed = barsFromCloses(closes, { volumes: closes.map((c) => Math.exp(5 - c) - 1) })
  near(compute('corr_n', reversed, { period: 4 })[3], -1, 1e-9)

  const flatVolume = barsFromCloses(closes, { volumes: [500, 500, 500, 500] })
  assert.equal(compute('corr_n', flatVolume, { period: 4 })[3], null)
})

test('零分母与数据不足：分母 0 返回 0，样本短于窗口返回全 null', () => {
  // o=0 -> (c-o)/o 分母 0 -> 0（不是 null）
  const zeroOpen = [bar(0, 0, 1, 0, 1, 10)]
  assert.equal(compute('kmid', zeroOpen)[0], 0)
  // 高分等于低价（h=l）-> KMID2 分母 0 -> 0
  const flatBar = [bar(0, 5, 5, 5, 5, 10)]
  assert.equal(compute('kmid2', flatBar)[0], 0)
  // 2 根 K 线要算窗口 60 的因子 -> 全 null（不抛错）
  const two = barsFromCloses([1, 2])
  const out = compute('ma_n', two, { period: 60 })
  assert.deepEqual(out, [null, null])
  // 非整数窗口 -> 全 null
  assert.deepEqual(compute('ma_n', barsFromCloses([1, 2, 3]), { period: 2.5 }), [null, null, null])
})

test('computeAlpha158：157 列、与 K 线等长、name 与目录一致', () => {
  const candles = barsFromCloses([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
  const series = computeAlpha158(candles)
  assert.equal(Object.keys(series).length, 157)
  for (const entry of alpha158Catalog()) {
    assert.ok(entry.name in series, `缺因子列 ${entry.name}`)
    assert.equal(series[entry.name].length, candles.length, `${entry.name} 长度不等于 K 线根数`)
  }
  // 抽查：MA10 在 i=9 处 = mean(1..10)/10 = 5.5/10
  near(series.MA10[9], 5.5 / 10)
})
