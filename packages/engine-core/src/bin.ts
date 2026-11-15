// SPDX-License-Identifier: CPAL-1.0
// 进程入口：`gitrader-engine-core --ws [端口]` 或 `--stdio`。令牌来自环境变量 GITRADER_GEP_TOKEN（宿主为每次启动生成）。
// 宿主启动的引擎进程不继承宿主环境变量，只拿显式传入的那几个（S3）；这里也只读 GITRADER_GEP_* 变量。
import { isMainThread, workerData } from 'node:worker_threads'
import { GEP_TOKEN_ENV } from './proto'
import { EngineCore } from './runtime/engine'
import { listenWs, serveStdio } from './gep/server'
import { serveBacktestWorker } from './runtime/backtest-worker'

// GQ-03：工作线程重入同一个打包文件
if (!isMainThread && (workerData as { gitraderRole?: string } | null)?.gitraderRole === 'backtest') {
  serveBacktestWorker()
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
    process.stderr.write('usage: engine-core --ws [port] | --stdio\n')
    process.exit(2)
  }
  const artifactDir = process.env.GITRADER_ENGINE_ARTIFACT_DIR
  // 策略文件夹由内核按配置交给引擎：--strategies <dir> 或环境变量 GITRADER_STRATEGIES_DIR；都没给就不加载任何策略
  const sIdx = args.indexOf('--strategies')
  const strategiesDir = sIdx >= 0 ? args[sIdx + 1] : process.env.GITRADER_STRATEGIES_DIR
  // GQ-03：打包产物（.mjs/.js）走工作线程，非打包运行（tsx）退回同线程
  const self = import.meta.url
  const workerUrl = self.endsWith('.mjs') || self.endsWith('.js') ? new URL(self) : undefined
  if (!workerUrl) process.stderr.write('engine-core: not a bundled .mjs/.js, backtest will run in the same thread (expect heartbeat timeouts on long backtests)\n')
  const core = new EngineCore({
    token,
    logSink: (line) => process.stderr.write(line + '\n'),
    onShutdown: () => process.exit(0),
    ...(artifactDir ? { jobs: { artifactDir, ...(workerUrl ? { workerUrl } : {}) } } : workerUrl ? { jobs: { workerUrl } } : {}),
    ...(strategiesDir ? { strategiesDir } : {}),
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
