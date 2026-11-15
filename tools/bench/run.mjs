// SPDX-License-Identifier: CPAL-1.0
// 性能基准入口：回测吞吐 + 指标库吞吐 + 报告渲染耗时 → JSON + Markdown。
//
// 用法：
//   node tools/bench/run.mjs                       # 默认 10 万根，三样都跑
//   node tools/bench/run.mjs --bars 525600         # 与 docs/perf-baseline.md 的 52.56 万根并排
//   node tools/bench/run.mjs --only backtest --bars 10000 --runs 2
//   node tools/bench/run.mjs --out tools/bench/results --quiet
//
// 全部离线：不联网、不读密钥；只写 --out 目录（默认 tools/bench/results）。
// 口径：p50 / p95、首次与热启分开、合成数据；收益数字无意义。

import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { environmentInfo, rssMb } from './lib/env.mjs'
import { repoRoot, loadBenchDeps } from './lib/loader.mjs'
import { syntheticResult } from './lib/dataset.mjs'
import { buildReport, renderMarkdownReport, writeReports } from './lib/report.mjs'
import { benchBacktest } from './workloads/backtest.mjs'
import { benchIndicators } from './workloads/indicators.mjs'
import { benchRender } from './workloads/render.mjs'

const here = dirname(fileURLToPath(import.meta.url))

// 与 bench/engine/run.mjs:37 同五个、同顺序（docs/perf-baseline.md 第 26 行的数字出自那份脚本）。
export const DEFAULT_STRATEGIES = Object.freeze(['ema-cross', 'mean-reversion', 'breakout', 'grid', 'dca'])
const SECTIONS = Object.freeze(['backtest', 'indicators', 'render'])

/** 极简参数解析（不引第三方 CLI 库；未知参数直接报错，不静默吞掉）。 */
export function parseArgs(argv) {
  const o = {
    bars: 100_000,
    runs: 3,
    rounds: 3,
    renderRounds: 5,
    strategies: [...DEFAULT_STRATEGIES],
    out: join(here, 'results'),
    only: [...SECTIONS],
    quiet: false,
    help: false,
  }
  const num = (name, raw) => {
    const n = Number(raw)
    if (!Number.isFinite(n) || n <= 0) throw new Error(`--${name} 需要正数，收到 ${JSON.stringify(raw)}`)
    return Math.floor(n)
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => {
      const v = argv[i + 1]
      if (v === undefined) throw new Error(`${a} 缺少值`)
      i += 1
      return v
    }
    switch (a) {
      case '--bars': o.bars = num('bars', next()); break
      case '--runs': o.runs = num('runs', next()); break
      case '--rounds': o.rounds = num('rounds', next()); break
      case '--render-rounds': o.renderRounds = num('render-rounds', next()); break
      case '--strategies': o.strategies = next().split(',').map((s) => s.trim()).filter((s) => s.length > 0); break
      case '--out': o.out = resolve(next()); break
      case '--only': {
        const list = next().split(',').map((s) => s.trim()).filter((s) => s.length > 0)
        const bad = list.filter((s) => !SECTIONS.includes(s))
        if (bad.length > 0) throw new Error(`--only 只认 ${SECTIONS.join(' / ')}，收到 ${bad.join(',')}`)
        o.only = list
        break
      }
      case '--quiet': o.quiet = true; break
      case '--help': case '-h': o.help = true; break
      default: throw new Error(`未知参数 ${a}（--help 看用法）`)
    }
  }
  if (o.strategies.length === 0) throw new Error('--strategies 不能为空')
  return o
}

/** 策略名 → 文件路径：ema-cross 用测试夹具，其余用 engine-core 的教学示例。 */
export function strategyPath(root, name) {
  if (name === 'ema-cross') return join(root, 'packages', 'engine-core', 'test', 'fixtures', 'strategies', 'ema-cross.ts')
  return join(root, 'packages', 'engine-core', 'examples', 'strategies', `${name}.ts`)
}

const USAGE = `node tools/bench/run.mjs [--bars 100000] [--runs 3] [--rounds 3] [--render-rounds 5]
                        [--strategies ema-cross,mean-reversion,breakout,grid,dca]
                        [--only backtest,indicators,render]
                        [--out tools/bench/results] [--quiet]`

export async function main(argv = process.argv.slice(2), io = { stdout: (s) => process.stdout.write(s), stderr: (s) => process.stderr.write(s) }) {
  let opts
  try {
    opts = parseArgs(argv)
  } catch (err) {
    io.stderr(`${err.message}\n${USAGE}\n`)
    return 2
  }
  if (opts.help) {
    io.stdout(`${USAGE}\n`)
    return 0
  }

  const root = repoRoot()
  io.stderr(`bench: 打包工作区 TS（engine-core / ta / report）…\n`)
  const deps = await loadBenchDeps(root)

  io.stderr(`bench: 生成 ${opts.bars} 根合成 1m K 线（seed 1）…\n`)
  const dataBegan = performance.now()
  const candles = deps.core.synthCandles({ n: opts.bars, seed: 1, intervalMs: 60_000 })
  const dataGenMs = performance.now() - dataBegan

  let backtest = null
  if (opts.only.includes('backtest')) {
    const strategies = []
    for (const name of opts.strategies) {
      const file = strategyPath(root, name)
      const loaded = await deps.core.loadStrategyFile(file)
      if (!loaded?.def) throw new Error(`bench: 策略加载失败 ${file}: ${JSON.stringify(loaded?.errors ?? [])}`)
      const def = loaded.def
      // 参数与 bench/engine/run.mjs:68 一致：有 anchor 就先按首根 K 线锚定，否则用 defaults。
      strategies.push({ id: def.id ?? name, def, params: def.anchor ? def.anchor(candles.slice(0, 1), def.defaults) : def.defaults })
    }
    io.stderr(`bench: 回测吞吐 ${strategies.length} 个策略 × ${opts.runs} 轮…\n`)
    backtest = await benchBacktest({ core: deps.core, strategies, candles, runs: opts.runs })
    backtest.dataGenMs = dataGenMs
    backtest.data = 'synthetic geometric random walk（engine-core synthCandles，seed 1，1m）'
  }

  let indicators = null
  if (opts.only.includes('indicators')) {
    io.stderr(`bench: 指标库吞吐（${opts.rounds} 轮）…\n`)
    indicators = await benchIndicators({ ta: deps.ta, candles, rounds: opts.rounds })
  }

  let render = null
  if (opts.only.includes('render')) {
    const result = syntheticResult({ points: 5_000, trades: 200, seed: 7 })
    io.stderr(`bench: 报告渲染（${opts.renderRounds} 轮）…\n`)
    render = await benchRender({ report: deps.report, result, rounds: opts.renderRounds })
  }

  const report = buildReport({
    params: {
      bars: opts.bars,
      runs: opts.runs,
      rounds: opts.rounds,
      renderRounds: opts.renderRounds,
      strategies: opts.strategies,
      intervalMs: 60_000,
      seed: 1,
      only: opts.only,
    },
    env: environmentInfo(),
    backtest,
    indicators,
    render,
    memoryRssMb: rssMb(),
  })
  report.dataGenMs = dataGenMs

  mkdirSync(opts.out, { recursive: true })
  const { jsonPath, mdPath } = writeReports(report, { outDir: opts.out })
  io.stderr(`bench: 写入 ${jsonPath}\nbench: 写入 ${mdPath}\n`)
  if (!opts.quiet) io.stdout(`${renderMarkdownReport(report)}\n`)
  else io.stderr('bench: --quiet，报告已写盘\n')
  return 0
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const code = await main()
  process.exit(code)
}
