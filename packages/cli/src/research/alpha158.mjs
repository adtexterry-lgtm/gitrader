// SPDX-License-Identifier: CPAL-1.0
// Alpha158 因子（Qlib 命名，MIT；表达式为自实现）：KBAR 9 + 价格 3 + 滚动 29 族 × 5 窗口 = 157 条。
// 逐行复制自 packages/engine-core/src/strategy/factors-alpha.ts:1-526 与
// packages/engine-core/src/strategy/alpha158.ts:1-91 的计算口径（本目录是无构建的 .mjs，不能 import TS 源）。
// 约定同原实现：输出与输入等长，预热期与不可算处为 null，第 i 项只用 <= i 的数据。
// 与 TS 版的差别仅为类型标注：JS 里没有 FactorDef 类型，compute 就是 (candles, params) => (number|null)[]。
import { mean, quantile, stdev } from './stats.mjs'

/** Qlib Alpha158 的滚动窗口集合（QD `ALPHA158_WINDOWS`）。 */
export const ALPHA158_WINDOWS = [5, 10, 20, 30, 60]

const DEFAULT_WINDOW = 10

/** 空序列（全 null），长度与输入一致。 */
function emptySeries(length) {
  return new Array(length).fill(null)
}

/** 非有限数转 null。 */
function finiteOrNull(value) {
  return Number.isFinite(value) ? value : null
}

/**
 * 安全除法：分子分母非有限时返回 null；分母为 0 时返回 0（对齐 QD `_ratio` 的 +1e-12 写法）。
 * 与 packages/engine-core/src/strategy/factors-alpha.ts:29-33 相同。
 */
function safeRatio(numerator, denominator) {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) return null
  if (denominator === 0) return 0
  return numerator / denominator
}

/** 解析窗口：period 或 n 覆盖缺省；非整数、小于 2 或数据不足返回 null。 */
function resolveWindow(length, params, fallback) {
  const period = params?.period ?? params?.n ?? fallback
  if (!Number.isInteger(period) || period < 2) return null
  if (length < period) return null
  return period
}

/** 取窗口内某个字段的 n 个值（含当前）。 */
function windowValues(candles, end, n, field) {
  const out = []
  for (let k = end - n + 1; k <= end; k++) out.push(candles[k][field])
  return out
}

/** 逐点计算：warmup = 'window' 时 i >= n-1，'delta' 时 i >= n。 */
function rollingSeries(candles, params, warmup, evaluate) {
  const out = emptySeries(candles.length)
  const n = resolveWindow(candles.length, params, DEFAULT_WINDOW)
  if (n === null) return out
  const start = warmup === 'window' ? n - 1 : n
  for (let i = start; i < candles.length; i++) {
    const value = evaluate(i, n)
    out[i] = value === null ? null : finiteOrNull(value)
  }
  return out
}

/** 无窗口的逐根 K 线因子。 */
function barSeries(evaluate) {
  return (candles) => {
    const out = emptySeries(candles.length)
    for (let i = 0; i < candles.length; i++) {
      const value = evaluate(candles[i])
      out[i] = value === null ? null : finiteOrNull(value)
    }
    return out
  }
}

/** 最小二乘：ys 对 x = 0..n-1 回归。 */
function regress(ys) {
  const n = ys.length
  const xMean = (n - 1) / 2
  const yMean = mean([...ys])
  let sxx = 0
  let sxy = 0
  for (let k = 0; k < n; k++) {
    const dx = k - xMean
    sxx += dx * dx
    sxy += dx * (ys[k] - yMean)
  }
  const slope = sxx === 0 ? 0 : sxy / sxx
  const intercept = yMean - slope * xMean
  let ssTot = 0
  let ssRes = 0
  for (let k = 0; k < n; k++) {
    const d = ys[k] - yMean
    ssTot += d * d
    const r = ys[k] - (intercept + slope * k)
    ssRes += r * r
  }
  const rsqr = ssTot === 0 ? null : 1 - ssRes / ssTot
  const residualLast = ys[n - 1] - (intercept + slope * (n - 1))
  return { slope, intercept, rsqr, residualLast }
}

/** Pearson 相关系数；任一序列方差为 0 时为 null。 */
function correlation(xs, ys) {
  const n = xs.length
  if (n === 0) return null
  const mx = mean([...xs])
  const my = mean([...ys])
  let sxx = 0
  let syy = 0
  let sxy = 0
  for (let k = 0; k < n; k++) {
    const dx = xs[k] - mx
    const dy = ys[k] - my
    sxx += dx * dx
    syy += dy * dy
    sxy += dx * dy
  }
  if (sxx === 0 || syy === 0) return null
  return sxy / Math.sqrt(sxx * syy)
}

/** 窗口内极值距当前的根数；并列极值取最早出现（同 np.nanargmax / nanargmin）。 */
function extremeDistance(candles, end, n, field, mode) {
  const start = end - n + 1
  let best = mode === 'max' ? -Infinity : Infinity
  for (let k = start; k <= end; k++) {
    const value = candles[k][field]
    if (mode === 'max' ? value > best : value < best) best = value
  }
  for (let k = start; k <= end; k++) {
    if (candles[k][field] === best) return end - k
  }
  return 0
}

/** 窗口内 size 个字段变动（需 size + 1 根 K 线）的涨跌分解。 */
function changeSums(candles, end, size, field) {
  let gain = 0
  let loss = 0
  let path = 0
  let up = 0
  let down = 0
  for (let k = end - size + 1; k <= end; k++) {
    const delta = candles[k][field] - candles[k - 1][field]
    if (delta > 0) {
      gain += delta
      up++
    } else if (delta < 0) {
      loss += -delta
      down++
    }
    path += Math.abs(delta)
  }
  return { gain, loss, path, up, down }
}

/** 价格分位秩：(below + (equal + 1) / 2) / period，与 ta/alpha-ops.ts:76-92 相同。 */
function rankPctLast(values, period) {
  const last = values[values.length - 1]
  let below = 0
  let equal = 0
  for (const value of values) {
    if (value < last) below++
    else if (value === last) equal++
  }
  return (below + (equal + 1) / 2) / period
}

/** 1 实体位置：(c - o) / o。 */
const kmid = barSeries((bar) => safeRatio(bar.c - bar.o, bar.o))
/** 2 K 线长度：(h - l) / o。 */
const klen = barSeries((bar) => safeRatio(bar.h - bar.l, bar.o))
/** 3 实体占振幅：(c - o) / (h - l)。 */
const kmid2 = barSeries((bar) => safeRatio(bar.c - bar.o, bar.h - bar.l))
/** 4 上影线：(h - max(o, c)) / o。 */
const kup = barSeries((bar) => safeRatio(bar.h - Math.max(bar.o, bar.c), bar.o))
/** 5 下影线：(min(o, c) - l) / o。 */
const klow = barSeries((bar) => safeRatio(Math.min(bar.o, bar.c) - bar.l, bar.o))
/** 6 收盘偏移：(2c - h - l) / o。 */
const ksft = barSeries((bar) => safeRatio(2 * bar.c - bar.h - bar.l, bar.o))
// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/factors/qlib_adapter.py:219-227; adapted.
/** 6b 上影线占振幅：(h - max(o, c)) / (h - l + 1e-12)。 */
const kup2 = barSeries((bar) => safeRatio(bar.h - Math.max(bar.o, bar.c), bar.h - bar.l + 1e-12))
/** 6c 下影线占振幅：(min(o, c) - l) / (h - l + 1e-12)。 */
const klow2 = barSeries((bar) => safeRatio(Math.min(bar.o, bar.c) - bar.l, bar.h - bar.l + 1e-12))
/** 6d 收盘偏移占振幅：(2c - h - l) / (h - l + 1e-12)。 */
const ksft2 = barSeries((bar) => safeRatio(2 * bar.c - bar.h - bar.l, bar.h - bar.l + 1e-12))

/** 7 滞后收盘比：c[i-n] / c[i]。 */
function rocFactor(candles, params) {
  return rollingSeries(candles, params, 'delta', (i, n) => safeRatio(candles[i - n].c, candles[i].c))
}

/** 8 开盘比价：o / c。 */
const open0 = barSeries((bar) => safeRatio(bar.o, bar.c))
/** 9 最高比价：h / c。 */
const high0 = barSeries((bar) => safeRatio(bar.h, bar.c))
/** 10 最低比价：l / c。 */
const low0 = barSeries((bar) => safeRatio(bar.l, bar.c))

/** 11 均值比：mean(c 窗口) / c。 */
function maFactor(candles, params) {
  return rollingSeries(candles, params, 'window', (i, n) =>
    safeRatio(mean(windowValues(candles, i, n, 'c')), candles[i].c),
  )
}

/** 12 标准差比：stdev(c 窗口, ddof 1) / c。 */
function stdFactor(candles, params) {
  return rollingSeries(candles, params, 'window', (i, n) =>
    safeRatio(stdev(windowValues(candles, i, n, 'c'), 1), candles[i].c),
  )
}

/** 13 回归斜率：c 对 0..n-1 的最小二乘斜率 / c。 */
function betaFactor(candles, params) {
  return rollingSeries(candles, params, 'window', (i, n) =>
    safeRatio(regress(windowValues(candles, i, n, 'c')).slope, candles[i].c),
  )
}

/** 14 回归 R²；窗口收盘方差为 0 时为 null。 */
function rsqrFactor(candles, params) {
  return rollingSeries(candles, params, 'window', (i, n) => regress(windowValues(candles, i, n, 'c')).rsqr)
}

/** 15 回归末点残差 / c。 */
function resiFactor(candles, params) {
  return rollingSeries(candles, params, 'window', (i, n) =>
    safeRatio(regress(windowValues(candles, i, n, 'c')).residualLast, candles[i].c),
  )
}

/** 16 窗口最高价 / c。 */
function maxFactor(candles, params) {
  return rollingSeries(candles, params, 'window', (i, n) =>
    safeRatio(Math.max(...windowValues(candles, i, n, 'h')), candles[i].c),
  )
}

/** 17 窗口最低价 / c。 */
function minFactor(candles, params) {
  return rollingSeries(candles, params, 'window', (i, n) =>
    safeRatio(Math.min(...windowValues(candles, i, n, 'l')), candles[i].c),
  )
}

/** 18 上分位（80%）/ c。 */
function qtluFactor(candles, params) {
  return rollingSeries(candles, params, 'window', (i, n) =>
    safeRatio(quantile(windowValues(candles, i, n, 'c').sort((a, b) => a - b), 0.8), candles[i].c),
  )
}

/** 19 下分位（20%）/ c。 */
function qtldFactor(candles, params) {
  return rollingSeries(candles, params, 'window', (i, n) =>
    safeRatio(quantile(windowValues(candles, i, n, 'c').sort((a, b) => a - b), 0.2), candles[i].c),
  )
}

/** 20 收盘分位秩：末值在窗口内的百分位。 */
function rankFactor(candles, params) {
  return rollingSeries(candles, params, 'window', (i, n) =>
    rankPctLast(windowValues(candles, i, n, 'c'), n),
  )
}

/** 21 RSV：(c - min(l 窗口)) / (max(h 窗口) - min(l 窗口))。 */
function rsvFactor(candles, params) {
  return rollingSeries(candles, params, 'window', (i, n) => {
    const lows = windowValues(candles, i, n, 'l')
    const highs = windowValues(candles, i, n, 'h')
    return safeRatio(candles[i].c - Math.min(...lows), Math.max(...highs) - Math.min(...lows))
  })
}

/** 22 窗口最高价距今根数 / n。 */
function imaxFactor(candles, params) {
  return rollingSeries(candles, params, 'window', (i, n) =>
    safeRatio(extremeDistance(candles, i, n, 'h', 'max'), n),
  )
}

/** 23 窗口最低价距今根数 / n。 */
function iminFactor(candles, params) {
  return rollingSeries(candles, params, 'window', (i, n) =>
    safeRatio(extremeDistance(candles, i, n, 'l', 'min'), n),
  )
}

/** 24 最高与最低点距离差（均已除 n）。 */
function imxdFactor(candles, params) {
  return rollingSeries(candles, params, 'window', (i, n) => {
    const hi = extremeDistance(candles, i, n, 'h', 'max')
    const lo = extremeDistance(candles, i, n, 'l', 'min')
    return safeRatio(hi - lo, n)
  })
}

/** 25 窗口内上涨根数比例：c[k] > c[k-1]。 */
function cntpFactor(candles, params) {
  return rollingSeries(candles, params, 'delta', (i, n) => changeSums(candles, i, n, 'c').up / n)
}

/** 26 窗口内下跌根数比例：c[k] < c[k-1]。 */
function cntnFactor(candles, params) {
  return rollingSeries(candles, params, 'delta', (i, n) => changeSums(candles, i, n, 'c').down / n)
}

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/factors/qlib_adapter.py:298-328; adapted.
/** 26b 涨跌根数差：(up - down) / n。 */
function cntdFactor(candles, params) {
  return rollingSeries(candles, params, 'delta', (i, n) => {
    const sums = changeSums(candles, i, n, 'c')
    return (sums.up - sums.down) / n
  })
}

/** 27 上涨幅度占比：Σgain / Σ|Δc|。 */
function sumpFactor(candles, params) {
  return rollingSeries(candles, params, 'delta', (i, n) => {
    const sums = changeSums(candles, i, n, 'c')
    return safeRatio(sums.gain, sums.path)
  })
}

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/factors/qlib_adapter.py:298-330; adapted.
/** 27b 下跌幅度占比：Σloss / Σ|Δc|。 */
function sumnFactor(candles, params) {
  return rollingSeries(candles, params, 'delta', (i, n) => {
    const sums = changeSums(candles, i, n, 'c')
    return safeRatio(sums.loss, sums.path)
  })
}

/** 27c 净涨跌幅占比：(Σgain - Σloss) / Σ|Δc|。 */
function sumdFactor(candles, params) {
  return rollingSeries(candles, params, 'delta', (i, n) => {
    const sums = changeSums(candles, i, n, 'c')
    return safeRatio(sums.gain - sums.loss, sums.path)
  })
}

/** 28 成交量均值比：mean(v 窗口) / (v + 1e-12)。 */
function vmaFactor(candles, params) {
  return rollingSeries(candles, params, 'window', (i, n) =>
    safeRatio(mean(windowValues(candles, i, n, 'v')), candles[i].v + 1e-12),
  )
}

/** 29 成交量标准差比：stdev(v 窗口, ddof 1) / (v + 1e-12)。 */
function vstdFactor(candles, params) {
  return rollingSeries(candles, params, 'window', (i, n) =>
    safeRatio(stdev(windowValues(candles, i, n, 'v'), 1), candles[i].v + 1e-12),
  )
}

/** 30 量价相关：corr(c, log(v + 1))。 */
function corrFactor(candles, params) {
  return rollingSeries(candles, params, 'window', (i, n) => {
    const closes = windowValues(candles, i, n, 'c')
    const volumes = windowValues(candles, i, n, 'v').map((value) => Math.log(value + 1))
    return correlation(closes, volumes)
  })
}

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/factors/qlib_adapter.py:256-258, 298-330; adapted.
/** 30b 变动量价相关：corr(c/c[-1], ln(v/v[-1] + 1))。 */
function cordFactor(candles, params) {
  return rollingSeries(candles, params, 'delta', (i, n) => {
    const priceRatios = []
    const volumeRatios = []
    for (let k = i - n + 1; k <= i; k++) {
      const prevClose = candles[k - 1].c
      const prevVolume = candles[k - 1].v
      if (prevClose === 0 || prevVolume === 0) return null
      priceRatios.push(candles[k].c / prevClose)
      volumeRatios.push(Math.log(candles[k].v / prevVolume + 1))
    }
    return correlation(priceRatios, volumeRatios)
  })
}

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/factors/qlib_adapter.py:298-330; adapted.
/** 30c 加权波动：std(|ret| * v, ddof 1) / mean(|ret| * v)。 */
function wvmaFactor(candles, params) {
  return rollingSeries(candles, params, 'delta', (i, n) => {
    const weighted = []
    for (let k = i - n + 1; k <= i; k++) {
      const prevClose = candles[k - 1].c
      if (prevClose === 0) return null
      weighted.push(Math.abs(candles[k].c / prevClose - 1) * candles[k].v)
    }
    return safeRatio(stdev(weighted, 1), mean([...weighted]))
  })
}

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/factors/qlib_adapter.py:298-330; adapted.
/** 30d 成交量上涨占比：Σmax(Δv, 0) / Σ|Δv|。 */
function vsumpFactor(candles, params) {
  return rollingSeries(candles, params, 'delta', (i, n) => {
    const sums = changeSums(candles, i, n, 'v')
    return safeRatio(sums.gain, sums.path)
  })
}

/** 30e 成交量下跌占比：Σmax(-Δv, 0) / Σ|Δv|。 */
function vsumnFactor(candles, params) {
  return rollingSeries(candles, params, 'delta', (i, n) => {
    const sums = changeSums(candles, i, n, 'v')
    return safeRatio(sums.loss, sums.path)
  })
}

/** 30f 成交量净变化占比：(Σgain - Σloss) / Σ|Δv|。 */
function vsumdFactor(candles, params) {
  return rollingSeries(candles, params, 'delta', (i, n) => {
    const sums = changeSums(candles, i, n, 'v')
    return safeRatio(sums.gain - sums.loss, sums.path)
  })
}

/** Alpha158 风格因子清单（单标的、逐 K 线；窗口缺省 10，params.period 覆盖）。 */
export const ALPHA_FACTORS = [
  { id: 'kmid', label: '实体位置', compute: kmid },
  { id: 'klen', label: 'K 线长度', compute: klen },
  { id: 'kmid2', label: '实体占振幅', compute: kmid2 },
  { id: 'kup', label: '上影线', compute: kup },
  { id: 'klow', label: '下影线', compute: klow },
  { id: 'ksft', label: '收盘偏移', compute: ksft },
  { id: 'kup2', label: '上影线占振幅', compute: kup2 },
  { id: 'klow2', label: '下影线占振幅', compute: klow2 },
  { id: 'ksft2', label: '收盘偏移占振幅', compute: ksft2 },
  { id: 'roc_n', label: '滞后收盘比', compute: rocFactor },
  { id: 'open0', label: '开盘比价', compute: open0 },
  { id: 'high0', label: '最高比价', compute: high0 },
  { id: 'low0', label: '最低比价', compute: low0 },
  { id: 'ma_n', label: '均值比', compute: maFactor },
  { id: 'std_n', label: '标准差比', compute: stdFactor },
  { id: 'beta_n', label: '回归斜率', compute: betaFactor },
  { id: 'rsqr_n', label: '回归决定系数', compute: rsqrFactor },
  { id: 'resi_n', label: '回归末点残差', compute: resiFactor },
  { id: 'max_n', label: '最高价比', compute: maxFactor },
  { id: 'min_n', label: '最低价比', compute: minFactor },
  { id: 'qtlu_n', label: '上分位比', compute: qtluFactor },
  { id: 'qtld_n', label: '下分位比', compute: qtldFactor },
  { id: 'rank_n', label: '收盘分位秩', compute: rankFactor },
  { id: 'rsv_n', label: '随机指标 RSV', compute: rsvFactor },
  { id: 'imax_n', label: '高点距今根数', compute: imaxFactor },
  { id: 'imin_n', label: '低点距今根数', compute: iminFactor },
  { id: 'imxd_n', label: '高低点距离差', compute: imxdFactor },
  { id: 'cntp_n', label: '上涨根数占比', compute: cntpFactor },
  { id: 'cntn_n', label: '下跌根数占比', compute: cntnFactor },
  { id: 'cntd_n', label: '涨跌根数差', compute: cntdFactor },
  { id: 'sump_n', label: '上涨幅度占比', compute: sumpFactor },
  { id: 'sumn_n', label: '下跌幅度占比', compute: sumnFactor },
  { id: 'sumd_n', label: '净涨跌幅占比', compute: sumdFactor },
  { id: 'vma_n', label: '成交量均值比', compute: vmaFactor },
  { id: 'vstd_n', label: '成交量波动比', compute: vstdFactor },
  { id: 'corr_n', label: '量价相关性', compute: corrFactor },
  { id: 'cord_n', label: '变动量价相关性', compute: cordFactor },
  { id: 'wvma_n', label: '加权波动', compute: wvmaFactor },
  { id: 'vsump_n', label: '成交量上涨占比', compute: vsumpFactor },
  { id: 'vsumn_n', label: '成交量下跌占比', compute: vsumnFactor },
  { id: 'vsumd_n', label: '成交量净变化占比', compute: vsumdFactor },
]

/** 按 id 取因子定义；不存在返回 undefined。 */
export function alphaFactorById(id) {
  return ALPHA_FACTORS.find((def) => def.id === id)
}

/** KBAR 9 条：[Qlib 名, 因子 id]；无窗口，period 记 1。 */
const KBAR_SPECS = [
  ['KMID', 'kmid'],
  ['KLEN', 'klen'],
  ['KMID2', 'kmid2'],
  ['KUP', 'kup'],
  ['KUP2', 'kup2'],
  ['KLOW', 'klow'],
  ['KLOW2', 'klow2'],
  ['KSFT', 'ksft'],
  ['KSFT2', 'ksft2'],
]

/** 价格 3 条：不生成 VWAP0（Candle 没有 vwap 字段，故 158 - 1 = 157）。 */
const PRICE_SPECS = [
  ['OPEN0', 'open0'],
  ['HIGH0', 'high0'],
  ['LOW0', 'low0'],
]

/** 滚动 29 族：[Qlib 名前缀, 因子 id]。 */
const ROLLING_SPECS = [
  ['ROC', 'roc_n'],
  ['MA', 'ma_n'],
  ['STD', 'std_n'],
  ['BETA', 'beta_n'],
  ['RSQR', 'rsqr_n'],
  ['RESI', 'resi_n'],
  ['MAX', 'max_n'],
  ['MIN', 'min_n'],
  ['QTLU', 'qtlu_n'],
  ['QTLD', 'qtld_n'],
  ['RANK', 'rank_n'],
  ['RSV', 'rsv_n'],
  ['IMAX', 'imax_n'],
  ['IMIN', 'imin_n'],
  ['IMXD', 'imxd_n'],
  ['CORR', 'corr_n'],
  ['CORD', 'cord_n'],
  ['CNTP', 'cntp_n'],
  ['CNTN', 'cntn_n'],
  ['CNTD', 'cntd_n'],
  ['SUMP', 'sump_n'],
  ['SUMN', 'sumn_n'],
  ['SUMD', 'sumd_n'],
  ['VMA', 'vma_n'],
  ['VSTD', 'vstd_n'],
  ['WVMA', 'wvma_n'],
  ['VSUMP', 'vsump_n'],
  ['VSUMN', 'vsumn_n'],
  ['VSUMD', 'vsumd_n'],
]

/** 生成 Alpha158 目录：name 为 Qlib 风格名（如 ROC5、VSUMD60）。 */
export function alpha158Catalog() {
  const out = []
  for (const [name, factorId] of KBAR_SPECS) out.push({ name, factorId, period: 1 })
  for (const [name, factorId] of PRICE_SPECS) out.push({ name, factorId, period: 1 })
  for (const window of ALPHA158_WINDOWS) {
    for (const [prefix, factorId] of ROLLING_SPECS) {
      out.push({ name: `${prefix}${window}`, factorId, period: window })
    }
  }
  return out
}

/** 按目录逐条计算，返回 `{ Qlib 名: 序列 }`；每列长度与 candles 一致。 */
export function computeAlpha158(candles) {
  const out = {}
  for (const entry of alpha158Catalog()) {
    const def = alphaFactorById(entry.factorId)
    if (def === undefined) continue
    out[entry.name] = def.compute(candles, { period: entry.period })
  }
  return out
}
