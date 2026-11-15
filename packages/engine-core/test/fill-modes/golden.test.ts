// SPDX-License-Identifier: CPAL-1.0
// 金标夹具：10 个教学示例策略在 `fillMode` 缺省（= 'bar'）下的完整回测输出。
// 目的是锁住「新增成交模式不得改动既有撮合」——夹具是逐字节比对的，任何一个数字变化都会红。
// 重新生成（只在确认行为变化是有意的时候做）：UPDATE_FILL_MODE_GOLDEN=1 npx vitest run test/fill-modes/golden.test.ts
// 金标比对脚本：node test/fill-modes/check-golden.mjs（退出码 0 = 逐字节一致）
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { runBacktest, type BacktestRun } from '../../src/strategy/backtest'
import { loadStrategyFile } from '../../src/strategy/loader'
import type { Candle } from '../../src/types'

const HERE = dirname(fileURLToPath(import.meta.url))
const EXAMPLES = join(HERE, '..', '..', 'examples', 'strategies')
const CANDLES_FILE = join(HERE, '..', 'fixtures', 'btc-1m-300.json')
const GOLDEN_FILE = join(HERE, '..', 'fixtures', 'fill-mode-golden.bar.json')

/** 金标里只放与撮合相关的输出，浮点数原样序列化（不做四舍五入）。 */
function shape(file: string, run: BacktestRun): Record<string, unknown> {
  return {
    file,
    params: run.params,
    stats: run.stats,
    trades: run.trades,
    funding: run.funding,
    equity: run.equity,
    openPosition: run.openPosition,
    warmup: run.series.warmup,
    target: run.series.target,
    reasons: run.series.reasons,
  }
}

/** 夹具里的 K 线（300 根 1m BTC，仓库内只读副本）。 */
export function goldenCandles(): { candles: Candle[]; sha256: string } {
  const raw = readFileSync(CANDLES_FILE, 'utf8')
  const parsed = JSON.parse(raw) as { candles: Candle[] }
  return { candles: parsed.candles, sha256: createHash('sha256').update(raw).digest('hex') }
}

export async function buildGolden(): Promise<string> {
  const { candles, sha256 } = goldenCandles()
  const files = readdirSync(EXAMPLES)
    .filter((f) => f.endsWith('.ts'))
    .sort()
  const cases: Record<string, unknown>[] = []
  for (const file of files) {
    const loaded = await loadStrategyFile(join(EXAMPLES, file))
    if (loaded.def === undefined) throw new Error(`${file} 加载失败：${JSON.stringify(loaded.errors)}`)
    // 只给 intervalMs：其余全部走 resolveSimOptions 的缺省值，等于「用户什么都不填」的情形
    const run = runBacktest(loaded.def, candles, undefined, { intervalMs: 60_000 })
    cases.push(shape(file, run))
  }
  return JSON.stringify(
    { note: 'fillMode 缺省（bar）金标；逐字节比对，勿手改', candles: 'test/fixtures/btc-1m-300.json', candlesSha256: sha256, mode: 'bar', cases },
    null,
    2,
  ) + '\n'
}

/** 报出第一处不同（字节位置与两侧上下文），便于判断是哪一栏变了。 */
function firstDiff(a: string, b: string): string {
  const n = Math.min(a.length, b.length)
  let i = 0
  while (i < n && a[i] === b[i]) i += 1
  const from = Math.max(0, i - 120)
  return `首个差异在字节 ${i}（金标 ${a.length} 字节 / 实际 ${b.length} 字节）\n金标: ${JSON.stringify(a.slice(from, i + 120))}\n实际: ${JSON.stringify(b.slice(from, i + 120))}`
}

describe('fillMode 缺省 = bar 的金标', () => {
  it(`10 个示例策略的输出与金标夹具逐字节一致（${GOLDEN_FILE}）`, async () => {
    const actual = await buildGolden()
    if (process.env.UPDATE_FILL_MODE_GOLDEN === '1') writeFileSync(GOLDEN_FILE, actual)
    const expected = readFileSync(GOLDEN_FILE, 'utf8')
    if (actual !== expected) throw new Error(firstDiff(expected, actual))
    expect(actual).toBe(expected)
    expect(JSON.parse(actual).cases).toHaveLength(10)
  }, 60_000)
})
