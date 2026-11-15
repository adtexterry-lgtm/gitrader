// SPDX-License-Identifier: CPAL-1.0
// 统计口径小工具：分位数 / 中位数 / 汇总。口径照 docs/perf-baseline.md（除注明外报 p50 / p95），
// 实现与 bench/engine/run.mjs 的 median / pct 同一算法（升序最近秩），不引入第三方统计库。

/** 升序排列的副本（不改入参）。 */
function ascending(values) {
  return [...values].sort((a, b) => a - b)
}

/** 最近秩分位数：与 bench/engine/run.mjs 的 pct 一致；空数组返回 NaN。 */
export function percentile(values, p) {
  if (!Array.isArray(values) || values.length === 0) return Number.NaN
  if (!(p >= 0 && p <= 1)) throw new RangeError(`percentile: p 必须在 [0,1]，收到 ${p}`)
  const s = ascending(values)
  return s[Math.min(s.length - 1, Math.floor(s.length * p))]
}

/** 中位数：奇数取正中，偶数取中间两个的均值；bench/engine 的 median 取上中位数，两处算法在偶数样本上略有差异。 */
export function median(values) {
  if (!Array.isArray(values) || values.length === 0) return Number.NaN
  const s = ascending(values)
  const mid = s.length >> 1
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/** 毫秒样本 → { samples, minMs, p50Ms, p95Ms, maxMs }（机器可读，不四舍五入）。 */
export function summarizeMs(values) {
  if (!Array.isArray(values) || values.length === 0) {
    return { samples: 0, minMs: Number.NaN, p50Ms: Number.NaN, p95Ms: Number.NaN, maxMs: Number.NaN }
  }
  return {
    samples: values.length,
    minMs: Math.min(...values),
    p50Ms: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    maxMs: Math.max(...values),
  }
}

/** 吞吐：count 个单位在 ms 毫秒内完成 → 单位 / 秒；ms <= 0 返回 NaN。 */
export function perSec(count, ms) {
  if (!(ms > 0) || !Number.isFinite(count)) return Number.NaN
  return count / (ms / 1000)
}

/** 保留 digits 位小数（只用于展示层，JSON 里保留原值）。 */
export function roundTo(x, digits = 2) {
  if (!Number.isFinite(x)) return null
  const f = 10 ** digits
  return Math.round(x * f) / f
}

/** 大数字的可读写法：12500000 → "1250 万"，用于 Markdown。 */
export function humanizeCount(x) {
  if (!Number.isFinite(x)) return '—'
  if (Math.abs(x) >= 1e8) return `${roundTo(x / 1e8, 2)} 亿`
  if (Math.abs(x) >= 1e4) return `${roundTo(x / 1e4, 2)} 万`
  return `${roundTo(x, 0)}`
}
