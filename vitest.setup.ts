// SPDX-License-Identifier: CPAL-1.0
// 已有测试都按中文界面写的：测试进程里固定中文，不看 navigator.language（Node 22 的 navigator.language 是 en-US）。
// 英文界面由 packages/workbench/test/i18n.test.ts 与 reports 里的真窗口脚本覆盖。
import { setLang } from './packages/workbench/src/ui/lib/i18n.js'

setLang('zh')
