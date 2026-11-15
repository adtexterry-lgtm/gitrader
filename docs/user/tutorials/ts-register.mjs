// SPDX-License-Identifier: CPAL-1.0
// 教程用：把"源码树里的 TS 包"接进普通 node 进程。
//
// 仓库的工作区包（@gitrader/engine-core / @gitrader/report / @gitrader/kernel …）按 tsc 口径写源码：
// 相对导入不带扩展名、schemas/*.json 用裸 import，普通 `node` 直接 import 会报 ERR_MODULE_NOT_FOUND。
// 这里复用 tools/data 已经写好并带测试的解析钩子（tools/data/lib/ts-shim.mjs）：只补解析，不做转译，
// 靠 Node 22.18 起默认开启的类型擦除执行 .ts。
//
// 两种用法：
//   1) 命令行：node --import ./docs/user/tutorials/ts-register.mjs <某个 .ts 入口>
//   2) 在 .mjs 里：await import('./ts-register.mjs') 之后再动态 import 目标（见 backtest.mjs）。
import { registerTsShim } from '../../../tools/data/lib/ts-shim.mjs'

await registerTsShim()
