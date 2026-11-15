// SPDX-License-Identifier: CPAL-1.0
// 共享 vitest 配置。各包脚本：vitest run --config ../../vitest.config.ts --root .
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'conformance/**/*.test.ts'],
    environment: 'node',
    setupFiles: [fileURLToPath(new URL('./vitest.setup.ts', import.meta.url))], // 固定中文界面（见该文件）
    passWithNoTests: true,
    testTimeout: 15000,
  },
})
