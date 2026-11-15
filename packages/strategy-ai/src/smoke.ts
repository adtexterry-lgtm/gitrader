// SPDX-License-Identifier: CPAL-1.0
// 冒烟：把候选源码落成临时文件 → 用 engine-core 的加载器校验并拿到可运行策略 → 在给定 K 线上跑一次回测。
// 加载器自己会在合成 K 线上做动态检查（空序列、短序列、极端参数、确定性、截断前视），所以这一步的失败原因
// 与用户在引擎里真正加载同一份文件时看到的完全一致——不是另写一套宽松检查。
//
// 临时文件写在系统临时目录并立刻删掉：策略文件是用户自己的代码，本包不保留副本、不写进仓库。
//
// 规则名两套并存：`validate()` 来自 ai-generation 的静态清单（运行期 import 记 `no-import`），加载器来自
// `loader.ts` 的 FORBIDDEN（同一件事记 `no-io`）。两者都原样透出，不在这里改名——改名后调用方就对不上引擎自己的报错。
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadStrategyFile, runBacktest, synthCandles } from '@gitrader/engine-core'
import type { Candle } from '@gitrader/engine-core'
import type { LoadIssue } from '@gitrader/engine-core'
import type { SmokeSummary, StaticIssue } from './types'

export interface SmokeOptions {
  /** 参数；缺省用策略自己声明的默认值。 */
  params?: Record<string, unknown>
  initialCash?: number
  intervalMs?: number
  /** 加载校验的预算（毫秒），缺省沿用 engine-core 的 15 s。 */
  budgetMs?: number
}

const DEFAULT_BARS = 400

/** 缺省冒烟数据：engine-core 的合成 K 线（固定 seed，逐次相同）。调用方应当传入自己的数据。 */
export function defaultSmokeCandles(bars = DEFAULT_BARS): Candle[] {
  return synthCandles({ n: bars, seed: 11, intervalMs: 3_600_000 })
}

/** LoadIssue → StaticIssue：把 hint 拼进消息（修复轮要把「怎么改」一起喂回模型）。 */
function toIssue(issue: LoadIssue): StaticIssue {
  const message = issue.hint === undefined || issue.hint === '' ? issue.message : `${issue.message} — ${issue.hint}`
  return { rule: issue.rule, message }
}

function emptySummary(bars: number, issues: StaticIssue[], warnings: string[]): SmokeSummary {
  return { ok: false, bars, trades: 0, fills: 0, finalEquity: 0, maxDrawdownRatio: 0, feesPaid: 0, liquidations: 0, unfilledShare: 0, issues, warnings }
}

/** 在给定 K 线上冒烟一次。失败返回 `ok: false` 与可读原因，不抛错（除非临时文件系统不可用）。 */
export async function smoke(code: string, candles: readonly Candle[], opts: SmokeOptions = {}): Promise<SmokeSummary> {
  const bars = candles.length
  if (bars === 0) return emptySummary(0, [{ rule: 'no-candles', message: 'smoke() needs at least one candle: pass the series the strategy should be run on' }], [])

  const dir = await mkdtemp(join(tmpdir(), 'gitrader-strategy-ai-'))
  const file = join(dir, 'strategy.ts')
  try {
    await writeFile(file, code, 'utf8')
    const loaded = await loadStrategyFile(file, opts.budgetMs === undefined ? {} : { budgetMs: opts.budgetMs })
    const warnings = loaded.warnings.map((w) => `[${w.rule}] ${w.message}`)
    if (!loaded.def) return emptySummary(bars, loaded.errors.map(toIssue), warnings)

    let run
    try {
      run = runBacktest(loaded.def, candles, opts.params ?? loaded.def.defaults, {
        ...(opts.initialCash === undefined ? {} : { initialCash: opts.initialCash }),
        ...(opts.intervalMs === undefined ? {} : { intervalMs: opts.intervalMs }),
      })
    } catch (e) {
      return emptySummary(bars, [{ rule: 'backtest-throws', message: `the backtest threw: ${(e as Error).message}` }], warnings)
    }

    const s = run.stats
    return {
      ok: true,
      bars,
      trades: s.trades,
      fills: s.fills,
      finalEquity: s.finalEquity,
      maxDrawdownRatio: s.maxDrawdownRatio,
      feesPaid: s.feesPaid,
      liquidations: s.liquidations,
      unfilledShare: s.unfilledShare,
      issues: [],
      warnings,
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
