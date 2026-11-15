// SPDX-License-Identifier: CPAL-1.0
// 回测—纸面一致性测试台 · 主入口。
//
//   node tools/parity/run-parity.mjs --candles klines.json --strategy ema-cross --instrument hyperliquid:BTC
//   node tools/parity/run-parity.mjs ... --paper-state ~/.gitrader/paper-state.json --account acct_xxx
//
// 做什么：① 能力预检（内核纸面模式能不能历史回放）② 经 GEP backtest.run 跑回测一侧 ③ 有纸面状态就比对，
// 没有就只交差异表格式 + 回测一侧产出（停机分支）。全部离线，只读仓库，绝不改内核。

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { diffRuns } from './lib/diff.mjs'
import { renderMarkdown, toJson } from './lib/report.mjs'
import { fromPaperState } from './lib/artifact.mjs'
import { probeRepo } from './lib/preflight.mjs'
import { runBacktestLeg } from './lib/backtest-leg.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '../..')

function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) { out._.push(a); continue }
    const key = a.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) out[key] = true
    else { out[key] = next; i++ }
  }
  return out
}

const parseParams = (text) => {
  if (!text || text === true) return {}
  const out = {}
  for (const part of String(text).split(',')) {
    if (!part.trim()) continue
    const [k, v] = part.split('=')
    if (!k) continue
    const n = Number(v)
    out[k.trim()] = Number.isFinite(n) && v !== '' && v !== undefined ? n : v === 'true' ? true : v === 'false' ? false : v
  }
  return out
}

const USAGE = `用法：
  node tools/parity/run-parity.mjs --candles <K线JSON> --strategy <id> [--instrument hyperliquid:BTC]
       [--interval 1h] [--params k=v,k2=v2] [--balance 10000] [--ccy USDC] [--leverage 1]
       [--slippage-bps 0] [--seed 7] [--paper-state <paper-state.json> [--account <acctId>]]
       [--out tools/parity/out]

退出码：0 = 产出已写盘（含停机分支）；1 = 回测一侧跑失败；2 = 参数错误。`

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || args.h) { process.stdout.write(USAGE + '\n'); return 0 }
  if (!args.candles || !args.strategy) { process.stderr.write(USAGE + '\n'); return 2 }

  const repoRoot = args['repo-root'] ? resolve(String(args['repo-root'])) : REPO_ROOT
  const outDir = resolve(String(args.out ?? join(repoRoot, 'tools/parity/out')))
  mkdirSync(outDir, { recursive: true })

  const preflight = probeRepo(repoRoot)
  writeFileSync(join(outDir, 'preflight.json'), JSON.stringify(preflight, null, 2) + '\n')

  process.stdout.write(`[parity] 能力预检：${preflight.verdict === 'ok' ? '可跑（内核纸面模式支持历史回放）' : '停机（内核纸面模式没有历史回放入口）'}\n`)
  for (const c of preflight.checks) process.stdout.write(`[parity]   ${c.ok ? '✓' : '✗'} ${c.id} — ${c.evidence}\n`)

  let run
  try {
    run = await runBacktestLeg({
      repoRoot,
      candlesFile: String(args.candles),
      strategyId: String(args.strategy),
      instrument: String(args.instrument ?? 'hyperliquid:BTC'),
      interval: String(args.interval ?? '1h'),
      params: parseParams(args.params),
      initialBalance: String(args.balance ?? '10000'),
      ccy: String(args.ccy ?? 'USDC'),
      leverage: args.leverage ? Number(args.leverage) : 1,
      slippageBps: args['slippage-bps'] ? Number(args['slippage-bps']) : 0,
      seed: args.seed ? Number(args.seed) : 7,
      ...(args['engine-bin'] ? { engineBin: String(args['engine-bin']) } : {}),
      ...(args['strategies-dir'] ? { strategiesDir: String(args['strategies-dir']) } : {}),
    })
  } catch (e) {
    process.stderr.write(`[parity] 回测一侧失败：${e instanceof Error ? e.message : String(e)}\n`)
    return 1
  }
  writeFileSync(join(outDir, 'backtest-run.json'), JSON.stringify(run.artifact, null, 2) + '\n')
  process.stdout.write(`[parity] 回测一侧完成：${run.artifact.fills.length} 笔成交，最终权益 ${run.artifact.finalEquity}\n`)

  let paper = null
  if (typeof args['paper-state'] === 'string') {
    try {
      const state = readFileSync(resolve(String(args['paper-state'])), 'utf8')
      paper = fromPaperState(state, {
        accountId: typeof args.account === 'string' ? String(args.account) : undefined,
        instrument: String(args.instrument ?? 'hyperliquid:BTC'),
        interval: String(args.interval ?? '1h'),
        runId: `paper:${String(args.account ?? 'first')}`,
      })
      writeFileSync(join(outDir, 'paper-run.json'), JSON.stringify(paper, null, 2) + '\n')
      process.stdout.write(`[parity] 纸面一侧读入：${paper.orders.length} 张订单 / ${paper.fills.length} 笔成交\n`)
    } catch (e) {
      process.stderr.write(`[parity] 纸面状态读不了，按停机分支处理：${e instanceof Error ? e.message : String(e)}\n`)
      paper = null
    }
  }

  if (!paper) {
    // 停机分支：纸面侧缺席 → 全部记为「无法核对」，差异表格式照出。
    paper = {
      schema: 'gitrader-parity-run/1',
      side: 'paper',
      runId: 'paper:absent',
      instrument: String(args.instrument ?? 'hyperliquid:BTC'),
      interval: String(args.interval ?? '1h'),
      source: { kind: 'absent', reason: preflight.verdict === 'stop' ? '内核纸面模式没有历史回放入口（见 preflight.json）' : '未提供 --paper-state' },
      clock: { mode: 'none', start: null, end: null },
      capabilities: { orders: false, fills: false, equity: false, equityCurve: false },
      orders: [],
      fills: [],
      equity: [],
      finalEquity: null,
      notes: [preflight.verdict === 'stop'
        ? '停机分支：纸面侧无法用同一份历史数据 + 模拟时钟运行，本表只交格式与回测一侧；缺什么见 preflight.missing'
        : '未提供纸面运行记录（--paper-state），本表只交格式与回测一侧'],
    }
  }

  const diff = diffRuns(run.artifact, paper)
  const meta = { generatedAt: new Date().toISOString(), format: 'gitrader-parity-diff/1' }
  const md = renderMarkdown({ diff, backtest: run.artifact, paper, preflight, meta })
  writeFileSync(join(outDir, 'parity-report.md'), md)
  writeFileSync(join(outDir, 'parity-diff.json'), JSON.stringify(toJson({ diff, backtest: run.artifact, paper, preflight, meta }), null, 2) + '\n')

  process.stdout.write(`[parity] 差异表：${diff.summary.total} 行（阻断 ${diff.summary.bySeverity.blocking} / 应修 ${diff.summary.bySeverity.fix} / 备注 ${diff.summary.bySeverity.note}），判定 ${diff.summary.verdict}\n`)
  process.stdout.write(`[parity] 产物：${join(outDir, 'parity-report.md')}、${join(outDir, 'parity-diff.json')}、${join(outDir, 'backtest-run.json')}\n`)
  return 0
}

main().then((code) => process.exit(code), (e) => {
  process.stderr.write(`[parity] 未预期错误：${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`)
  process.exit(1)
})
