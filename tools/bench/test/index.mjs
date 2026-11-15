// SPDX-License-Identifier: CPAL-1.0
// 聚合入口：本机 Node 22.23.2 的测试运行器只接受 glob、不展开目录参数，`node --test tools/bench/test/`
// 会把目录当模块解析，同级 package.json 的 main 指到这里。这里按顺序 import 五个测试文件，
// 让「目录」这一个参数等价于跑全部用例。
//
// 单独跑某一组仍然可以：node --test tools/bench/test/report.test.mjs

await import('./stats.test.mjs')
await import('./dataset.test.mjs')
await import('./report.test.mjs')
await import('./workloads.test.mjs')
await import('./cli.test.mjs')
