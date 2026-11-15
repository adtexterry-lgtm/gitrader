// SPDX-License-Identifier: CPAL-1.0
// 目录入口：`node --test tools/smoke/test/` 会经由 test/package.json 的 main 落到这里，
// 由它把测试文件在同一个进程里全 import 进来（Node 22 起 --test 把裸目录当模块解析）。
// 单独跑某个文件仍然是 `node --test tools/smoke/test/journey.test.mjs`。
import './journey.test.mjs'
