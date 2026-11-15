// SPDX-License-Identifier: CPAL-1.0
// 教程 02 用：跑 @gitrader/report 的报告渲染。
//
//   node docs/user/tutorials/report.mjs <结果.json> --md <报告.md> --html <报告.html> [--title 标题]
//
// 为什么要这一层：`packages/report/src/cli.ts` 只导出 `run(argv, io)`，模块本身不执行任何东西（仓库里没有
// 自执行的 bin）。所以从源码树渲染报告时用这个小包装：先注册解析钩子（见 ts-register.mjs），再把参数交给 run()。
// 必须先注册钩子再 import（钩子只影响之后发生的解析），所以下面用动态 import 而不是顶层静态 import。
import './ts-register.mjs'

const { run } = await import('../../../packages/report/src/cli.ts')

const code = await run(process.argv.slice(2), {
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
})
process.exitCode = code
