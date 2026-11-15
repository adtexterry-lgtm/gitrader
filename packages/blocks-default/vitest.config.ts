// SPDX-License-Identifier: CPAL-1.0
// 本包的 vitest 配置：在共享配置上加 Preact 的 JSX 转换（块是 .tsx，壳的组件库是 .jsx，默认会找 react）。
import { defineConfig, mergeConfig } from 'vitest/config'
import base from '../../vitest.config.ts'

export default mergeConfig(base, defineConfig({
  oxc: { jsx: { runtime: 'automatic', importSource: 'preact' } },
  resolve: { alias: { react: 'preact/compat', 'react-dom': 'preact/compat' } }, // 组件库经 @gitrader/workbench/ui 间接导入 Radix（与 build.mjs 同一份别名）
  test: { testTimeout: 60000, hookTimeout: 120000 },
}))
