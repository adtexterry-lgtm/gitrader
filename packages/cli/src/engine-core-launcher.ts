// SPDX-License-Identifier: CPAL-1.0
// Gitrader Core 引擎启动器：产品层装配（注入四个机器人模板 + 研究作业的计算提供者），然后启动 engine-core。
// 这个脚本在 CLI 包里，可以导入 @gitrader/bots；engine-core 包保持依赖纯净。
import { isMainThread, workerData } from 'node:worker_threads'
import { EngineCore, listenWs, serveStdio, serveBacktestWorker } from '@gitrader/engine-core'
import { GEP_TOKEN_ENV } from '@gitrader/protocol'
import { botToStrategy } from '@gitrader/bots'
import { createResearchProvider } from './research-provider'
import { serveResearchWorker } from './research-compute'

const builtinStrategies = () => [botToStrategy('grid'), botToStrategy('dca'), botToStrategy('martingale'), botToStrategy('trend')]

// 工作线程重入（回测 / 研究：寻优与因子报告）
const role = !isMainThread ? (workerData as { gitraderRole?: string } | null)?.gitraderRole : undefined
if (role === 'backtest') {
  serveBacktestWorker()
} else if (role === 'research') {
  serveResearchWorker({ builtins: builtinStrategies() })
} else {
  void main()
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const token = process.env[GEP_TOKEN_ENV]
  if (!token) {
    process.stderr.write(`${GEP_TOKEN_ENV} is required (the host generates a one-time token per launch)\n`)
    process.exit(2)
  }
  const stdio = args.includes('--stdio')
  const wsIdx = args.indexOf('--ws')
  if (!stdio && wsIdx < 0) {
    process.stderr.write('usage: gitrader-core-launcher --ws [port] | --stdio\n')
    process.exit(2)
  }
  const artifactDir = process.env.GITRADER_ENGINE_ARTIFACT_DIR
  const sIdx = args.indexOf('--strategies')
  const strategiesDir = sIdx >= 0 ? args[sIdx + 1] : process.env.GITRADER_STRATEGIES_DIR
  const self = import.meta.url
  const workerUrl = self.endsWith('.mjs') || self.endsWith('.js') ? new URL(self) : undefined
  if (!workerUrl) process.stderr.write('gitrader-core-launcher: not a bundled .mjs/.js, backtest will run in the same thread\n')

  // 装配：注入四个机器人模板与研究作业的计算提供者（寻优 / 因子报告在工作线程里跑，不堵引擎主线程）
  const core = new EngineCore({
    token,
    logSink: (line) => process.stderr.write(line + '\n'),
    onShutdown: () => process.exit(0),
    ...(artifactDir ? { jobs: { artifactDir, ...(workerUrl ? { workerUrl } : {}) } } : workerUrl ? { jobs: { workerUrl } } : {}),
    ...(strategiesDir ? { strategiesDir } : {}),
    builtinStrategies: builtinStrategies(),
    research: createResearchProvider(workerUrl ? { workerUrl } : {}),
  })

  await core.ready
  if (stdio) {
    serveStdio(core, { stdin: process.stdin, stdout: process.stdout, onEnd: () => process.exit(0) })
    return
  }
  const port = Number(args[wsIdx + 1] && /^\d+$/.test(args[wsIdx + 1]!) ? args[wsIdx + 1] : 0)
  const ws = await listenWs(core, { port })
  process.stdout.write(JSON.stringify({ listening: ws.url, port: ws.port }) + '\n')
  const stop = (): void => { void ws.close().then(() => process.exit(0)) }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
}
