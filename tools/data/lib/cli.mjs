// SPDX-License-Identifier: CPAL-1.0
// fetch-candles 的命令行外壳：解析参数 → 跑 runFetch → 打人类可读摘要。返回退出码，不调用 process.exit（便于测试）。
import { runFetch } from './fetch-candles.mjs'
import { USAGE, UsageError, parseFetchArgs } from './options.mjs'

const iso = (ms) => new Date(ms).toISOString()

function messageOf(e) {
  return e instanceof Error ? e.message : String(e)
}

/**
 * argv 是 process.argv.slice(2)。deps 可注入 { createConnector, connectorOptions, now }，
 * 测试用假连接器工厂跑全流程（离线）。
 */
export async function main(argv = [], io = {}, deps = {}) {
  const out = io.stdout ?? ((text) => void process.stdout.write(text))
  const err = io.stderr ?? ((text) => void process.stderr.write(text))

  if (argv.length === 0) {
    err(`${USAGE}\n`)
    return 2
  }
  if (argv.includes('--help') || argv.includes('-h')) {
    out(`${USAGE}\n`)
    return 0
  }

  let options
  try {
    options = parseFetchArgs(argv, deps.now === undefined ? {} : { now: deps.now })
  } catch (e) {
    if (e instanceof UsageError) {
      err(`${e.message}\n${USAGE}\n`)
      return 2
    }
    err(`error: ${messageOf(e)}\n`)
    return 1
  }

  let result
  try {
    result = await runFetch(options, deps)
  } catch (e) {
    err(`error: ${messageOf(e)}\n`)
    return 1
  }

  const { report } = result
  const lines = [
    `venue        ${options.venue}`,
    `instrument   ${options.instrumentId}`,
    `interval     ${options.interval}`,
    `window       ${iso(options.from)} → ${iso(options.to)}`,
    `candles      ${result.count}（${result.pages} 页 / ${result.calls} 次调用）`,
    `csv          ${result.csvPath}`,
    `json         ${result.jsonPath}`,
    `sha256       ${report.sha256}`,
    `manifest     ${result.manifestPath}`,
  ]
  out(`${lines.join('\n')}\n`)
  for (const warning of report.warnings) err(`warn: ${warning}\n`)
  if (result.truncated) err(`warn: stopped after --max-pages ${options.maxPages} continuation calls; the file may not reach --to\n`)
  if (result.count === 0) err('warn: 该区间没有取到任何 K 线（文件已写出，candles 为空）\n')
  return 0
}
