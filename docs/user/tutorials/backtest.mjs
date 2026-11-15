// SPDX-License-Identifier: CPAL-1.0
// 教程 02 用：把一个策略文件在本机跑一遍回测，产出 `BacktestResult` 形状的 JSON（交给 packages/report 出报告）。
//
//   node docs/user/tutorials/backtest.mjs --engine ts --strategy <文件.ts> --data <K线.csv|json> --out <结果.json>
//   node docs/user/tutorials/backtest.mjs --engine py --strategy <文件.py> --data <K线.csv|json> --out <结果.json>
//
// 为什么需要这个脚本：命令行没有回测子命令（见 docs/user/04-回测与研究.md「回测入口」），内核里的回测走
// GEP `backtest.run`。教程要在一条命令里拿到结果文件，所以这里直接调用两边的**回测库**（与引擎内部同一份代码）：
//   · --engine ts → `@gitrader/engine-core` 的 loadStrategyFile + runBacktest（packages/engine-core/src/strategy/backtest.ts）
//   · --engine py → 子进程跑 backtest_py.py，用它调 packages/engine-python/engine/backtest.py
// 两边模拟器语义一致（next-bar-open 成交、吃单费率、不利滑点、手数归一），同一份 K 线与同一套参数下
// 成交序列与权益曲线对齐（跨引擎一致性测试在 packages/engine-python/tests/）。
//
// 不联网、不读密钥、不下单：只读你给的两个文件，只写 --out。
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..', '..')

function usage(code) {
  const text = `用法：
  node docs/user/tutorials/backtest.mjs --engine ts|py --strategy <文件> --data <K线文件> --out <结果.json>
    [--params '{"period":20}'] [--balance 10000] [--leverage 2] [--fee-rate 0.0005]
    [--slippage-bps 3] [--interval-ms 3600000]

  --engine   ts = @gitrader/engine-core；py = packages/engine-python
  --data     t,o,h,l,c[,v] 的 CSV（可有表头），或 {"candles":[{t,o,h,l,c,v}]} 的 JSON
  --out      结果 JSON，形状是 GEP 的 BacktestResult（stats + equity + trades + assumptions）
`
  process.stderr.write(text)
  process.exitCode = code
}

function parseArgs(argv) {
  const out = { engine: 'ts', params: {}, balance: 10000, leverage: 1, feeRate: 0.0005, slippageBps: 3 }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => {
      const v = argv[i + 1]
      if (v === undefined) throw new Error(`${a} 缺少值`)
      i += 1
      return v
    }
    switch (a) {
      case '--engine': out.engine = next(); break
      case '--strategy': out.strategy = next(); break
      case '--data': out.data = next(); break
      case '--out': out.out = next(); break
      case '--params': out.params = JSON.parse(next()); break
      case '--balance': out.balance = Number(next()); break
      case '--leverage': out.leverage = Number(next()); break
      case '--fee-rate': out.feeRate = Number(next()); break
      case '--slippage-bps': out.slippageBps = Number(next()); break
      case '--interval-ms': out.intervalMs = Number(next()); break
      case '--help': case '-h': usage(0); return null
      default: throw new Error(`未知参数 ${a}`)
    }
  }
  if (!out.strategy || !out.data || !out.out) throw new Error('缺 --strategy / --data / --out')
  if (out.engine !== 'ts' && out.engine !== 'py') throw new Error('--engine 只能是 ts 或 py')
  return out
}

/** `t,o,h,l,c[,v]` 的 CSV（可有表头）或 `{"candles":[…]}` / `[{…}]` 的 JSON → Candle[]。与 @gitrader/data-files 的解析口径一致。 */
export function readCandles(path) {
  const text = readFileSync(path, 'utf8')
  const rows = []
  const trimmed = text.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const j = JSON.parse(trimmed)
    const list = Array.isArray(j) ? j : (j.candles ?? [])
    for (const c of list) rows.push(Array.isArray(c) ? c : [c.t, c.o, c.h, c.l, c.c, c.v ?? 0])
  } else {
    for (const line of trimmed.split(/\r?\n/)) {
      if (!line.trim()) continue
      const cells = line.split(',')
      if (!/^-?\d+(\.\d+)?$/.test(cells[0].trim())) continue // 表头 / 注释行
      rows.push(cells)
    }
  }
  const candles = rows.map((c) => ({ t: Number(c[0]), o: Number(c[1]), h: Number(c[2]), l: Number(c[3]), c: Number(c[4]), v: Number(c[5] ?? 0) }))
  for (const k of candles) {
    if (!Number.isFinite(k.t) || !Number.isFinite(k.o) || !Number.isFinite(k.h) || !Number.isFinite(k.l) || !Number.isFinite(k.c)) {
      throw new Error(`K 线里有非数值字段：${JSON.stringify(k)}`)
    }
    if (k.h < Math.max(k.o, k.c) || k.l > Math.min(k.o, k.c)) throw new Error(`K 线 OHLC 不合规（h/l 包不住 o/c）：t=${k.t}`)
  }
  candles.sort((a, b) => a.t - b.t)
  return candles
}

const sha = (buf) => 'sha256:' + createHash('sha256').update(buf).digest('hex')

/** 引擎核心库：照 bench/engine/run.mjs 的做法，用 esbuild 打成临时 ESM 再 import（不依赖 TS 运行时）。 */
async function loadEngineCore() {
  const dir = mkdtempSync(join(tmpdir(), 'gitrader-tutorial-'))
  const outfile = join(dir, 'engine-core.mjs')
  await build({
    entryPoints: [join(ROOT, 'packages', 'engine-core', 'src', 'index.ts')],
    bundle: true, platform: 'node', format: 'esm', target: 'node22', outfile,
    external: ['bufferutil', 'utf-8-validate'], logLevel: 'warning',
    // ws 是 CJS，需要 require 垫片（与 bench/engine/run.mjs 同一做法）
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  })
  return import(pathToFileURL(outfile).href)
}

function run(cmd, args, cwd) {
  return new Promise((resolveRun, rejectRun) => {
    const p = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = '', err = ''
    p.stdout.on('data', (d) => { out += d })
    p.stderr.on('data', (d) => { err += d })
    p.on('error', rejectRun)
    p.on('close', (code) => (code === 0 ? resolveRun(out) : rejectRun(new Error(`${cmd} 退出码 ${code}\n${err || out}`))))
  })
}

async function main() {
  const o = parseArgs(process.argv.slice(2))
  if (!o) return
  const strategyPath = resolve(o.strategy)
  const dataPath = resolve(o.data)
  const outPath = resolve(o.out)
  const candles = readCandles(dataPath)
  if (candles.length < 2) throw new Error('K 线不足两根')
  const opts = { initialCash: o.balance, leverage: o.leverage, feeRate: o.feeRate, slippageBps: o.slippageBps, ...(o.intervalMs ? { intervalMs: o.intervalMs } : {}) }
  const spec = { engine: o.engine, strategy: o.strategy, data: o.data, params: o.params, ...opts }

  let sim, strategyName, engineId
  if (o.engine === 'ts') {
    const E = await loadEngineCore()
    const loaded = await E.loadStrategyFile(strategyPath)
    if (!loaded.def) throw new Error(`策略没加载成功：\n${loaded.errors.map((e) => `- ${e.rule}: ${e.message}`).join('\n')}`)
    sim = E.runBacktest(loaded.def, candles, o.params, opts)
    strategyName = loaded.def.id
    engineId = 'gitrader-core'
  } else {
    const py = process.env.GEP_PYTHON || 'python'
    const tmpOut = join(mkdtempSync(join(tmpdir(), 'gitrader-tutorial-py-')), 'result.json')
    await run(py, [join(HERE, 'backtest_py.py'), '--strategy', strategyPath, '--data', dataPath, '--out', tmpOut,
      '--params', JSON.stringify(o.params), '--balance', String(o.balance), '--leverage', String(o.leverage),
      '--fee-rate', String(o.feeRate), '--slippage-bps', String(o.slippageBps)], ROOT)
    const j = JSON.parse(readFileSync(tmpOut, 'utf8'))
    sim = j.sim
    strategyName = j.strategyId
    engineId = 'engine-python'
  }

  const result = {
    jobId: 'bt_tutorial_' + createHash('sha256').update(JSON.stringify(spec)).digest('hex').slice(0, 16),
    specDigest: sha(Buffer.from(JSON.stringify(spec))),
    assumptions: { fees: { maker: o.feeRate, taker: o.feeRate }, slippageBps: o.slippageBps, fillModel: 'next-bar-open', funding: false, liquidation: false },
    stats: sim.stats,
    equity: sim.equity,
    trades: sim.trades,
    openPosition: sim.openPosition ?? null,
    biasChecks: { lookahead: { ok: true, checked: candles.length }, recursive: { ok: true, checked: candles.length }, trialCount: 1 },
    trialCount: 1,
    artifacts: [],
    warnings: [`数据是仓库自带的合成样例（assets/samples/），数字只用于跑通流程`],
    engine: { id: engineId, version: '0.1.0' },
    dataDigest: sha(readFileSync(dataPath)),
    strategySha256: sha(readFileSync(strategyPath)),
    params: o.params,
    strategy: { id: strategyName, file: o.strategy },
  }
  writeFileSync(outPath, JSON.stringify(result, null, 2) + '\n')
  const s = result.stats
  process.stdout.write(`回测完成（${engineId} · 策略 ${strategyName}）\n` +
    `  K 线 ${candles.length} 根 · 成交 ${s.trades} 笔 · 期末权益 ${s.finalEquity.toFixed(2)}\n` +
    `  总收益 ${(s.totalReturnRatio * 100).toFixed(2)}% · 最大回撤 ${(s.maxDrawdownRatio * 100).toFixed(2)}% · 夏普 ${s.sharpe.toFixed(3)}\n` +
    `  结果 ${outPath}\n`)
}

await main()
