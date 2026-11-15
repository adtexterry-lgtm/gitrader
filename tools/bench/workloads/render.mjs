// SPDX-License-Identifier: CPAL-1.0
// 报告渲染耗时：@gitrader/report 的 Markdown / HTML / 两者一起，量单次渲染墙钟时间与输出字节。
// 不含读盘与写盘（纯函数），输入是确定性合成结果（lib/dataset.mjs 的 syntheticResult）。
//
// 口径说明：既有 docs/perf-baseline.md 没有这一项，属于本脚本新增口径。

import { summarizeMs } from '../lib/stats.mjs'

/** @param {object} o */
export async function benchRender(o) {
  const { report, result } = o
  const rounds = Math.max(1, Math.floor(o.rounds ?? 5))
  const cases = [
    { name: 'markdown', run: () => report.renderMarkdown({ result }) },
    { name: 'html', run: () => report.renderHtml({ result }) },
    { name: 'both', run: () => report.renderBoth({ result }) },
  ]
  const items = []
  for (const c of cases) {
    const times = []
    let bytes = 0
    for (let i = 0; i < rounds; i++) {
      const began = performance.now()
      const text = c.run()
      times.push(performance.now() - began)
      bytes = typeof text === 'string' ? Buffer.byteLength(text, 'utf8') : Buffer.byteLength(JSON.stringify(text), 'utf8')
    }
    const firstMs = times[0]
    const rest = times.slice(1)
    const warm = summarizeMs(rest.length > 0 ? rest : times)
    items.push({ name: c.name, firstMs, warm, p50Ms: warm.p50Ms, p95Ms: warm.p95Ms, bytes })
  }
  const digest = typeof report.reportDigest === 'function' ? report.reportDigest(result) : null
  return {
    kind: 'render',
    rounds,
    points: Array.isArray(result.equity) ? result.equity.length : 0,
    trades: Array.isArray(result.trades) ? result.trades.length : 0,
    items,
    digest: typeof digest === 'string' ? digest.slice(0, 16) : null,
  }
}
