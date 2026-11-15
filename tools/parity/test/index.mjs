// SPDX-License-Identifier: CPAL-1.0
// 聚合入口：本机 Node 22.23.2 的测试运行器只接受 glob、不展开目录参数，`node --test tools/parity/test/`
// 会把目录当模块解析，同级 package.json 的 main 指到这里。按顺序 import 全部测试文件。
// 单独跑某一组：node --test tools/parity/test/diff.test.mjs

await import('./artifact.test.mjs')
await import('./diff.test.mjs')
await import('./report.test.mjs')
await import('./preflight.test.mjs')
await import('./gep-stdio.test.mjs')
await import('./backtest.test.mjs')
