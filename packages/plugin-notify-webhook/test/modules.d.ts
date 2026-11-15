// SPDX-License-Identifier: CPAL-1.0
// 插件是纯 .mjs（不经构建），测试只做运行时断言；这里给被 import 的 .mjs 一个通配声明。
declare module '*.mjs'
