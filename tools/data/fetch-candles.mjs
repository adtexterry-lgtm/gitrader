// SPDX-License-Identifier: CPAL-1.0
// 入口：node tools/data/fetch-candles.mjs --venue binance --instrument BTCUSDT --interval 1h --from 2024-01-01 --out data/btc-1h.json
// 会真实联网（各场所公共 REST，主机见 README）。先注册解析钩子，再动态加载 lib（lib 里静态 import 了 TS 工作区包）。
import { registerTsShim } from './lib/ts-shim.mjs'

await registerTsShim()
const { main } = await import('./lib/cli.mjs')

process.exitCode = await main(process.argv.slice(2))
