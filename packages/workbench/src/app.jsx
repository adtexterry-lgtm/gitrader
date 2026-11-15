// SPDX-License-Identifier: CPAL-1.0
// 工作台壳入口：Preact 打成单文件 app.js + app.css，无 CDN。
import 'virtual:tw'
import './ui/index.js'
import './shell/shell.css'
import { render } from 'preact'
import { createRuntime } from './shell/boot.js'
import { Shell } from './shell/Shell.jsx'
import { installFlow } from './ui/motion.js'

const runtime = createRuntime()
render(<Shell runtime={runtime} />, document.getElementById('app'))
installFlow()
// 内核握手结果放到 window 上供冒烟脚本读取（不含任何令牌）
runtime.ready.then((r) => { window.__GR_READY__ = { online: r.online, at: Math.round(performance.now()), ...(r.error ? { error: String(r.error.message || r.error) } : {}) } })
performance.mark('gr-first-render')
