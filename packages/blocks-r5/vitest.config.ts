// SPDX-License-Identifier: CPAL-1.0
import { defineConfig, mergeConfig } from 'vitest/config'
import base from '../../vitest.config.ts'
export default mergeConfig(base, defineConfig({
  oxc: { jsx: { runtime: 'automatic', importSource: 'preact' } },
  resolve: { alias: { react: 'preact/compat', 'react-dom': 'preact/compat' } },
  test: { testTimeout: 60000, hookTimeout: 120000 },
}))
