// SPDX-License-Identifier: CPAL-1.0
// 报告导出的入口（由 journey.mjs 用 esbuild 打成临时 ESM 后运行）：
// packages/report 的 src 是 TS + 无扩展名导入，Node 不能直接跑；打包后就是它的 run(argv)。
import { run } from '@gitrader/report'

process.exitCode = await run(process.argv.slice(2))
