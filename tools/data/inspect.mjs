// SPDX-License-Identifier: CPAL-1.0
// 入口：node tools/data/inspect.mjs <inspect|normalize|manifest> ... —— 薄封装 @gitrader/data-files 的 run(argv)。
// 不联网、不写除 normalize 目标外的文件；退出码与 run 一致（0 ok，2 用法 / 读文件 / 格式错误）。
import { registerTsShim } from './lib/ts-shim.mjs'

await registerTsShim()
const { run } = await import('@gitrader/data-files')

process.exitCode = await run(process.argv.slice(2))
