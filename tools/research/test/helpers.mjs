// SPDX-License-Identifier: CPAL-1.0
// 测试辅助：合成 K 线与断言工具。全部离线、确定性（固定种子 LCG），不含真实行情。
import assert from 'node:assert/strict'

/** 一根 K 线。 */
export function bar(t, o, h, l, c, v = 0) {
  return { t, o, h, l, c, v }
}

/** 按收盘价序列造 K 线：开 = c - openOffset，高/低 = c ± spread，量按 volumes 或 100 + 10i。 */
export function barsFromCloses(closes, opts = {}) {
  const openOffset = opts.openOffset ?? 0.5
  const spread = opts.spread ?? 1
  const volumes = opts.volumes ?? null
  const start = opts.start ?? 1_700_000_000_000
  const step = opts.step ?? 3_600_000
  return closes.map((c, i) =>
    bar(start + i * step, c - openOffset, c + spread, c - spread, c, volumes === null ? 100 + i * 10 : volumes[i]),
  )
}

/** 线性同余随机数（确定性，测试可复现）。 */
export function lcg(seed = 42) {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x100000000
  }
}

/**
 * 确定性噪声 K 线：收盘做带漂移的随机游走，高低价由噪声撑开，量随游走反向（让量价因子有变化）。
 * 用于因子报告的结构测试：不看具体数值，只看报告构造是否正确。
 */
export function noisyCandles(n, seed = 7) {
  const rand = lcg(seed)
  const out = []
  let close = 100
  for (let i = 0; i < n; i++) {
    const shock = (rand() - 0.5) * 2
    const open = close
    close = open * (1 + shock * 0.01)
    const high = Math.max(open, close) * (1 + Math.abs(shock) * 0.004)
    const low = Math.min(open, close) * (1 - Math.abs(shock) * 0.004)
    const volume = Math.round(1000 * (1 + Math.abs(shock)) + i)
    out.push(bar(1_700_000_000_000 + i * 3_600_000, open, high, low, close, volume))
  }
  return out
}

/** 浮点近似断言（默认容差 1e-12）。 */
export function near(actual, expected, eps = 1e-12) {
  assert.equal(typeof actual, 'number', `期望 number，实际 ${typeof actual}`)
  assert.ok(Math.abs(actual - expected) <= eps, `期望 ${expected} ± ${eps}，实际 ${actual}`)
}

/** 断言某点为空（null）。 */
export function isNull(actual, message = '期望 null') {
  assert.equal(actual, null, message)
}
