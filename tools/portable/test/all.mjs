// SPDX-License-Identifier: CPAL-1.0
// 目录入口：`node --test tools/portable/test/` 会经由 test/package.json 的 main 落到这里，
// 由它把四个测试文件在同一个进程里全部 import 进来（Node 22 起 --test 不接受裸目录，会当成模块去 require）。
// 单独跑某个文件仍然是 `node --test tools/portable/test/args.test.mjs`。
import './args.test.mjs'
import './shasums.test.mjs'
import './assemble.test.mjs'
import './runtime-version.test.mjs'
import './pack.test.mjs'
import './ux011.test.mjs'
