// SPDX-License-Identifier: CPAL-1.0
// 聚合入口：本机 Node 22.23.2 的测试运行器只吃 glob、不展开目录参数，`node --test tools/release/test/`
// 会把目录当模块解析，同级 package.json 的 main 指到这里。按顺序 import 三个测试文件，
// 让「目录」这一个参数等价于跑全部用例。
//
// 单独跑某一组仍然可以：node --test tools/release/test/deps-audit.test.mjs
await import('./audit-headers.test.mjs')
await import('./pack-dry-run.test.mjs')
await import('./deps-audit.test.mjs')
await import('./plugin-audit.test.mjs')
await import('./bundled-hashes-required.test.mjs')
