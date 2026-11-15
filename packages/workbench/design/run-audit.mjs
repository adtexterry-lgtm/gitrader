// SPDX-License-Identifier: CPAL-1.0
// 视觉体检（搬自 Demo 的 run-audit.mjs，无头 Edge，无窗口，只读）。用法：
//   node design/run-audit.mjs http://127.0.0.1:<port>/ [out.json] [route ...]       # 默认跑壳的四个页面（1440×900 首屏）
//   node design/run-audit.mjs http://127.0.0.1:<port>/ [out.json] r5                # r5：十一页 × 1280 / 1440 / 1920（?ui=r5）；只按 glow ≤ 1、solidOrange ≤ 1、capsule 0、sizeViolations 0、cjk11 0 判退出码，其余超限只列出
// 退出码：任一页超出 audit-probe.js 的 LIMITS 即非 0（橙色 ≤6、实心橙 ≤1、中文 <12px = 0、中文 500 混排 = 0、嵌套 ≥3 层 = 0 …）。
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const here = dirname(fileURLToPath(import.meta.url))
import { browserPath, loadChromium } from '../verify/browser.mjs'
const chromium = loadChromium()
const EDGE = browserPath()
const probe = readFileSync(resolve(here, 'audit-probe.js'), 'utf8')
const [target, outFile, ...routesArg] = process.argv.slice(2)
if (!target) { console.error('用法：node design/run-audit.mjs http://127.0.0.1:<port>/ [out.json] [route ...]'); process.exit(2) }
// r5 路由清单（追加）：十一页、三个宽度，URL 带 ?ui=r5；审计口径五项（其余 LIMITS 超限只提示）
const R5_ROUTES = ['overview', 'chart', 'records', 'funds', 'strategies', 'lab', 'lab/r1-experiment', 'plugins', 'settings/venues', 'settings/notify', 'settings/personal']
const R5_WIDTHS = [1280, 1440, 1920]
const R5_STRICT = ['glow', 'solidOrange', 'capsule', 'sizeViolations', 'cjk11']
const r5 = routesArg.length === 1 && routesArg[0] === 'r5'
const ROUTES = r5 ? R5_ROUTES : routesArg.length ? routesArg : ['', 'settings/connect', 'settings/keys', 'about']
const widths = r5 ? R5_WIDTHS : [1440]
const urls = ROUTES.map((r) => target.replace(/[?#].*$/, '').replace(/\/?$/, '/') + (r5 ? '?ui=r5' : '?ui=r4') + '#/' + r)
const browser = await chromium.launch({ executablePath: EDGE, headless: true, args: ['--lang=zh-CN'] })
const rows = []
for (const width of widths) for (const url of urls) {
  const page = await browser.newPage({ viewport: { width, height: 900 }, deviceScaleFactor: 1 })
  try {
    await page.goto(url, { waitUntil: 'load', timeout: 20000 })
    await page.waitForTimeout(1500)
    rows.push({ ...(await page.evaluate(probe)), ...(r5 ? { width } : {}) })
  } catch (e) { rows.push({ url, error: String(e).slice(0, 160), ...(r5 ? { width } : {}) }) }
  await page.close()
}
await browser.close()
const cols = ['orange', 'solidOrange', 'glow', 'orb', 'primary', 'sizeViolations', 'cjk11', 'cjk500', 'cjkBoldSmall', 'blackOnOrange', 'coloredZero', 'truncated', 'pageSub', 'gradientCjk', 'nestDepth3']
console.log(['page'.padEnd(18), ...cols.map((c) => c.slice(0, 8).padStart(9))].join(''))
let failed = 0
for (const r of rows) {
  const name = ((r5 ? `${r.width} ` : '') + (r.url || '').replace(/^.*#\//, '#/')).slice(0, 22).padEnd(r5 ? 23 : 18)
  if (r.error) { console.log(name + ' ERROR ' + r.error); failed += 1; continue }
  console.log(name + cols.map((c) => String(r[c]).padStart(9)).join(''))
  const over = Object.entries(r.pass ?? {}).filter(([, ok]) => !ok).map(([k]) => k)
  const bad = r5 ? over.filter((k) => R5_STRICT.includes(k)) : over
  if (r5 && over.length > bad.length) console.log('  其余超限（只提示）：' + over.filter((k) => !bad.includes(k)).join(', '))
  if (bad.length) { failed += 1; console.log('  超限：' + bad.join(', ') + ' ' + JSON.stringify(Object.fromEntries(bad.map((k) => [k, r.samples?.[k] ?? r[k]])))) }
}
if (outFile) { writeFileSync(resolve(outFile), JSON.stringify(rows, null, 2)); console.log('→', outFile) }
process.exit(failed ? 1 : 0)
