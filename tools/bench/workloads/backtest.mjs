// SPDX-License-Identifier: CPAL-1.0
// 回测吞吐：示例策略 × 合成 K 线（攒够 10 万根），量「策略信号 + 撮合记账 + 统计」的墙钟时间。
// 不含数据加载（数据生成单独计时），不含网络，全部进程内同步核心——与 bench/engine/run.mjs、
// docs/perf-baseline.md 第 26 行同一口径：根 / 秒。

import { summarizeMs, perSec } from '../lib/stats.mjs'

/**
 * @param {object} o
 * @param {any} o.core @gitrader/engine-core 模块（runBacktest 来自它）
 * @param {{id: string, def: any, params?: object}[]} o.strategies 已加载的策略定义
 * @param {any[]} o.candles 合成 K 线
 * @param {number} [o.runs] 每个策略跑几轮（第 1 轮算首次，其余热启）
 * @param {number} [o.feeRate]
 * @param {number} [o.slippageBps]
 */
export async function benchBacktest(o) {
  const { core, strategies, candles } = o
  const runs = Math.max(1, Math.floor(o.runs ?? 3))
  const feeRate = o.feeRate ?? 0.00045
  const slippageBps = o.slippageBps ?? 2
  if (typeof core?.runBacktest !== 'function') throw new TypeError('benchBacktest: core.runBacktest 不可用')
  if (!Array.isArray(strategies) || strategies.length === 0) throw new TypeError('benchBacktest: 至少给一个策略')
  if (!Array.isArray(candles) || candles.length < 2) throw new TypeError('benchBacktest: K 线不足')

  const rows = []
  const warmSamples = []
  let lastStats = null
  for (const s of strategies) {
    const params = s.params ?? s.def?.defaults ?? {}
    const times = []
    let stats = null
    for (let i = 0; i < runs; i++) {
      const began = performance.now()
      const result = core.runBacktest(s.def, candles, params, { feeRate, slippageBps })
      times.push(performance.now() - began)
      stats = result?.stats ?? null
    }
    lastStats = stats
    const firstMs = times[0]
    const rest = times.slice(1)
    const warm = summarizeMs(rest.length > 0 ? rest : times)
    warmSamples.push(...rest)
    const basisMs = rest.length > 0 ? warm.p50Ms : firstMs
    rows.push({
      id: s.id,
      bars: candles.length,
      runs,
      firstMs,
      warm,
      barsPerSec: perSec(candles.length, basisMs),
      fills: stats?.fills ?? null,
      trades: stats?.trades ?? null,
      note: rest.length > 0 ? 'barsPerSec 取热启 p50' : '只跑 1 轮，barsPerSec 取该轮（含预热）',
    })
  }

  return {
    kind: 'backtest',
    bars: candles.length,
    runs,
    feeRate,
    slippageBps,
    intervalMs: candles.length > 1 ? candles[1].t - candles[0].t : null,
    strategies: rows,
    warm: warmSamples.length > 0 ? summarizeMs(warmSamples) : null,
    lastStats,
  }
}
