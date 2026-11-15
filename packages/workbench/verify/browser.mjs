// SPDX-License-Identifier: CPAL-1.0
// 验收脚本用的浏览器定位（只在开发机的验收 / 体检脚本里用，不进产品包）：
//   playwright-core：GITRADER_PLAYWRIGHT（目录）> 按模块名解析（npm i -D playwright-core）
//   浏览器：GITRADER_EDGE（可执行文件）> 按环境变量里的 Program Files 目录找 Edge / Chrome
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

export function loadChromium() {
  return createRequire(import.meta.url)(process.env.GITRADER_PLAYWRIGHT ?? 'playwright-core').chromium
}

export function browserPath() {
  if (process.env.GITRADER_EDGE) return process.env.GITRADER_EDGE
  const roots = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean)
  const rel = [['Microsoft', 'Edge', 'Application', 'msedge.exe'], ['Google', 'Chrome', 'Application', 'chrome.exe']]
  for (const r of roots) for (const p of rel) { const f = join(r, ...p); if (existsSync(f)) return f }
  for (const f of ['/usr/bin/microsoft-edge', '/usr/bin/google-chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']) if (existsSync(f)) return f
  throw new Error('找不到 Edge / Chrome：设置 GITRADER_EDGE 指向浏览器可执行文件')
}
