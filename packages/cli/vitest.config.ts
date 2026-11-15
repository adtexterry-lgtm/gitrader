// SPDX-License-Identifier: CPAL-1.0
// CLI 测试的环境钉定：已有断言都按中文输出写的，固定 GITRADER_LANG=zh（与工作台测试固定中文界面同类）；英文输出由 test/lang-en.test.ts 显式覆盖。
import { defineConfig, mergeConfig } from 'vitest/config'
import base from '../../vitest.config'

export default mergeConfig(base, defineConfig({ test: { env: { GITRADER_LANG: 'zh' } } }))
