// SPDX-License-Identifier: CPAL-1.0
// 第三方块 iframe 的启动脚本（经典脚本，同源于壳，在入口模块之前执行）：把宿主放在 iframe name 里的块标识写成 window.__GITRADER_BLOCK__。
// 单独成文件是因为壳页面的 CSP 不允许内联脚本。
try {
  var m = /^gr-block:(.*)$/.exec(window.name)
  if (m) window.__GITRADER_BLOCK__ = JSON.parse(m[1])
} catch (e) { /* 没有标识就让块自己报「缺少 blockId」 */ }
