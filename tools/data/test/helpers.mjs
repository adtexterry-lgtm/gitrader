// SPDX-License-Identifier: CPAL-1.0
// 测试夹具：假连接器（可设单页上限，模拟场所分页）+ 合成 K 线 + 临时目录。
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 合成升序 K 线：t 从 from 起每 step 一根，落在 (from, to] 内共 n 根。 */
export function series({ from, step, count, base = 100 }) {
  const rows = []
  for (let i = 0; i < count; i++) {
    const t = from + i * step
    const o = base + i
    rows.push({ t, o, h: o + 5, l: o - 5, c: o + 1, v: 10 + i })
  }
  return rows
}

/**
 * 假连接器：每次 candles(from,to) 只返回到 pageSize 根（模拟「一次调用取不完」的场所）。
 * 行为对齐真连接器：按 t >= from && t <= to 过滤、升序返回。
 */
export function fakeConnector({ rows, pageSize = 1000, onCall } = {}) {
  const calls = []
  const connector = {
    calls,
    closed: false,
    describe: () => ({ venue: 'fake', environments: ['mainnet'], history: { pageLimit: pageSize, maxCandles: pageSize } }),
    async candles(instrumentId, interval, opts = {}) {
      calls.push({ instrumentId, interval, ...opts })
      if (onCall) onCall(calls, connector)
      const from = opts.from ?? Number.NEGATIVE_INFINITY
      const to = opts.to ?? Number.POSITIVE_INFINITY
      return rows
        .filter((c) => c.t >= from && c.t <= to)
        .sort((a, b) => a.t - b.t)
        .slice(0, pageSize)
    },
    async close() {
      connector.closed = true
    },
  }
  return connector
}

/** mkdtemp 临时目录，测试结束（含失败）自动删。 */
export function tmpDir(t, prefix = 'gitrader-data-') {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
